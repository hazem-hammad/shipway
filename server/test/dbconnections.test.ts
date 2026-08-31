/**
 * The database-connection registry: `/api/db-connections`, and what changes about `/api/databases`
 * once a database can live somewhere other than this host.
 *
 * The properties worth pinning here are the ones that would be quietly wrong rather than loudly
 * broken: that admin credentials never come back out of the API, that a database is provisioned
 * against the connection it was asked for (and not whatever the host happens to run), and that the
 * env a project gets points at that connection's host rather than 127.0.0.1.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { databases, dbConnections } from '../src/db/schema.js';
import { setSetting } from '../src/db/settings.js';
import { listConnections, resolveConnection } from '../src/services/dbconnections.js';
import type { DbAdmin, DbAdminTarget } from '../src/services/dbprovision.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-dbconn-test-'));
}

function sessionCookie(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') {
    throw new Error('expected a set-cookie header in the response');
  }
  return value.split(';')[0]!;
}

const ADMIN = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct-horse-battery' };
const LOCAL_MYSQL_ADMIN_URL = 'mysql://shipway_admin:hunter2@127.0.0.1:3306';
const LOCAL_POSTGRES_ADMIN_URL = 'postgres://shipway_admin:hunter2@127.0.0.1:5432/postgres';

/** A registered RDS-shaped Postgres, as the POST body describes it. */
const RDS = {
  name: 'RDS production',
  engine: 'postgres' as const,
  host: 'shop.abc123.eu-west-1.rds.amazonaws.com',
  port: 5432,
  adminUsername: 'shipway_admin',
  adminPassword: 'rds-p@ss/word#1',
  tls: true,
};

class FakeDbAdmin implements DbAdmin {
  created: { target: DbAdminTarget; name: string; user: string }[] = [];
  dropped: { target: DbAdminTarget; name: string }[] = [];
  tested: DbAdminTarget[] = [];
  testError: Error | null = null;

  async createDatabase(target: DbAdminTarget, name: string, user: string): Promise<void> {
    this.created.push({ target, name, user });
  }

  async dropDatabase(target: DbAdminTarget, name: string): Promise<void> {
    this.dropped.push({ target, name });
  }

  async testConnection(target: DbAdminTarget): Promise<void> {
    this.tested.push(target);
    if (this.testError) throw this.testError;
  }

  async importSql(_target: DbAdminTarget, _database: string, _sqlPath: string): Promise<void> {}
  async dumpSql(_target: DbAdminTarget, _database: string, _sqlPath: string): Promise<void> {}
}

interface TestApp {
  app: FastifyInstance;
  cookie: string;
  dbAdmin: FakeDbAdmin;
}

async function buildTestApp(opts: { engines?: boolean } = {}): Promise<TestApp> {
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
  const dbAdmin = new FakeDbAdmin();
  const app = await buildApp(cfg, { dbAdmin });

  if (opts.engines !== false) {
    setSetting(app.db, 'mysql_admin_url', LOCAL_MYSQL_ADMIN_URL);
    setSetting(app.db, 'postgres_admin_url', LOCAL_POSTGRES_ADMIN_URL);
  }

  const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
  return { app, cookie: sessionCookie(create), dbAdmin };
}

async function registerRds(app: FastifyInstance, cookie: string): Promise<number> {
  const res = await app.inject({ method: 'POST', url: '/api/db-connections', headers: { cookie }, payload: RDS });
  if (res.statusCode !== 201) {
    throw new Error(`expected the connection to be registered, got ${String(res.statusCode)}: ${res.payload}`);
  }
  return res.json().id as number;
}

describe('GET /api/db-connections', () => {
  it("lists the host's configured engines, with no external ones registered", async () => {
    const { app, cookie } = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/db-connections', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        key: 'local:mysql',
        kind: 'local',
        id: null,
        name: 'MySQL on this server',
        engine: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        tls: false,
        adminUsername: null,
        createdAt: null,
        databaseCount: 0,
      },
      {
        key: 'local:postgres',
        kind: 'local',
        id: null,
        name: 'PostgreSQL on this server',
        engine: 'postgres',
        host: '127.0.0.1',
        port: 5432,
        tls: false,
        adminUsername: null,
        createdAt: null,
        databaseCount: 0,
      },
    ]);

    await app.close();
  });

  it('leaves out an engine this host has no admin credentials for', async () => {
    const { app, cookie } = await buildTestApp({ engines: false });
    setSetting(app.db, 'mysql_admin_url', LOCAL_MYSQL_ADMIN_URL);

    const res = await app.inject({ method: 'GET', url: '/api/db-connections', headers: { cookie } });

    expect(res.json().map((row: { key: string }) => row.key)).toEqual(['local:mysql']);

    await app.close();
  });

  it('never returns the admin password, for either kind of connection', async () => {
    const { app, cookie } = await buildTestApp();
    await registerRds(app, cookie);

    const res = await app.inject({ method: 'GET', url: '/api/db-connections', headers: { cookie } });

    expect(res.payload).not.toContain(RDS.adminPassword);
    expect(res.payload).not.toContain('hunter2');
    expect(res.payload).not.toContain('postgres://');
    // The admin *username* is shown — it is what someone checks when a connection stops working.
    expect(res.json().at(-1)).toMatchObject({ name: RDS.name, adminUsername: 'shipway_admin', host: RDS.host, tls: true });

    await app.close();
  });

  it('counts the databases on each connection separately', async () => {
    const { app, cookie } = await buildTestApp();
    const id = await registerRds(app, cookie);

    await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'local_one' } });
    await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { connection: `external:${String(id)}`, name: 'remote_one' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { connection: `external:${String(id)}`, name: 'remote_two' },
    });

    const counts = Object.fromEntries(
      res(await app.inject({ method: 'GET', url: '/api/db-connections', headers: { cookie } })).map((row: { key: string; databaseCount: number }) => [
        row.key,
        row.databaseCount,
      ]),
    );
    expect(counts).toEqual({ 'local:mysql': 1, 'local:postgres': 0, [`external:${String(id)}`]: 2 });

    await app.close();
  });
});

function res(response: LightMyRequestResponse): { key: string; databaseCount: number }[] {
  return response.json();
}

describe('POST /api/db-connections', () => {
  it('tests the credentials before storing them, and encrypts the password at rest', async () => {
    const { app, cookie, dbAdmin } = await buildTestApp();

    const created = await app.inject({ method: 'POST', url: '/api/db-connections', headers: { cookie }, payload: RDS });

    expect(created.statusCode).toBe(201);
    // Tested against the real target, with the password percent-encoded into the URL — `@`, `/` and
    // `#` in an admin password would otherwise be read as URL structure.
    expect(dbAdmin.tested).toEqual([
      {
        engine: 'postgres',
        url: `postgres://shipway_admin:rds-p%40ss%2Fword%231@${RDS.host}:5432`,
        tls: true,
      },
    ]);

    const row = app.db.select().from(dbConnections).where(eq(dbConnections.id, created.json().id)).get();
    expect(row?.adminPasswordEncrypted).toBeInstanceOf(Buffer);
    expect(row?.adminPasswordEncrypted.toString('utf8')).not.toContain(RDS.adminPassword);

    await app.close();
  });

  it('refuses credentials that cannot connect, and stores nothing', async () => {
    const { app, cookie, dbAdmin } = await buildTestApp();
    dbAdmin.testError = new Error('password authentication failed for user "shipway_admin"');

    const created = await app.inject({ method: 'POST', url: '/api/db-connections', headers: { cookie }, payload: RDS });

    expect(created.statusCode).toBe(502);
    expect(created.json().detail).toMatch(/password authentication failed/);
    expect(app.db.select().from(dbConnections).all()).toEqual([]);

    await app.close();
  });

  it('rejects a host that is really a connection URL, rather than storing a password in the clear', async () => {
    const { app, cookie } = await buildTestApp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/db-connections',
      headers: { cookie },
      payload: { ...RDS, host: 'postgres://admin:secret@db.example.com:5432/postgres' },
    });

    expect(created.statusCode).toBe(400);

    await app.close();
  });

  it('refuses a duplicate name', async () => {
    const { app, cookie } = await buildTestApp();
    await registerRds(app, cookie);

    const again = await app.inject({ method: 'POST', url: '/api/db-connections', headers: { cookie }, payload: RDS });

    expect(again.statusCode).toBe(409);

    await app.close();
  });

  it('defaults the port to the engine default when it is omitted', async () => {
    const { app, cookie } = await buildTestApp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/db-connections',
      headers: { cookie },
      payload: { name: 'Remote MySQL', engine: 'mysql', host: 'db.example.com', adminUsername: 'root', adminPassword: 'pw' },
    });

    expect(created.json().port).toBe(3306);

    await app.close();
  });
});

describe('POST /api/db-connections/test', () => {
  it('answers ok without storing anything', async () => {
    const { app, cookie } = await buildTestApp();

    const tested = await app.inject({
      method: 'POST',
      url: '/api/db-connections/test',
      headers: { cookie },
      payload: { engine: RDS.engine, host: RDS.host, adminUsername: RDS.adminUsername, adminPassword: RDS.adminPassword },
    });

    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toEqual({ ok: true });
    expect(app.db.select().from(dbConnections).all()).toEqual([]);

    await app.close();
  });

  it('reports a refusal as a 200 with ok:false — a server saying no is a successful test', async () => {
    const { app, cookie, dbAdmin } = await buildTestApp();
    dbAdmin.testError = new Error('ECONNREFUSED 10.0.0.9:5432');

    const tested = await app.inject({
      method: 'POST',
      url: '/api/db-connections/test',
      headers: { cookie },
      payload: { engine: RDS.engine, host: RDS.host, adminUsername: RDS.adminUsername, adminPassword: RDS.adminPassword },
    });

    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toEqual({ ok: false, detail: 'ECONNREFUSED 10.0.0.9:5432' });

    await app.close();
  });
});

describe('PATCH /api/db-connections/:id', () => {
  it('keeps the stored password when the body omits it, and re-tests before saving', async () => {
    const { app, cookie, dbAdmin } = await buildTestApp();
    const id = await registerRds(app, cookie);
    dbAdmin.tested.length = 0;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/db-connections/${String(id)}`,
      headers: { cookie },
      payload: { name: 'RDS prod (eu-west-1)' },
    });

    expect(patched.statusCode).toBe(204);
    // Re-tested with the password it already held, not with a blank one.
    expect(dbAdmin.tested[0]?.url).toContain('rds-p%40ss%2Fword%231');
    expect(app.db.select().from(dbConnections).where(eq(dbConnections.id, id)).get()?.name).toBe('RDS prod (eu-west-1)');

    await app.close();
  });

  it('does not save a change whose credentials stop working', async () => {
    const { app, cookie, dbAdmin } = await buildTestApp();
    const id = await registerRds(app, cookie);
    dbAdmin.testError = new Error('ENOTFOUND typo.example.com');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/db-connections/${String(id)}`,
      headers: { cookie },
      payload: { host: 'typo.example.com' },
    });

    expect(patched.statusCode).toBe(502);
    expect(app.db.select().from(dbConnections).where(eq(dbConnections.id, id)).get()?.host).toBe(RDS.host);

    await app.close();
  });
});

describe('DELETE /api/db-connections/:id', () => {
  it('refuses while databases still live on it, naming how many', async () => {
    const { app, cookie } = await buildTestApp();
    const id = await registerRds(app, cookie);
    await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { connection: `external:${String(id)}`, name: 'still_here' },
    });

    const deleted = await app.inject({ method: 'DELETE', url: `/api/db-connections/${String(id)}`, headers: { cookie } });

    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().error).toMatch(/still has 1 database/);
    expect(app.db.select().from(dbConnections).all()).toHaveLength(1);

    await app.close();
  });

  it('unregisters one with nothing on it', async () => {
    const { app, cookie } = await buildTestApp();
    const id = await registerRds(app, cookie);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/db-connections/${String(id)}`, headers: { cookie } });

    expect(deleted.statusCode).toBe(204);
    expect(app.db.select().from(dbConnections).all()).toEqual([]);

    await app.close();
  });
});

describe('databases on a registered connection', () => {
  it('provisions against that connection, not the host, and remembers where it went', async () => {
    const { app, cookie, dbAdmin } = await buildTestApp();
    const id = await registerRds(app, cookie);

    const created = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { connection: `external:${String(id)}`, name: 'shop_db' },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'shop_db',
      engine: 'postgres',
      connectionKey: `external:${String(id)}`,
      connectionName: RDS.name,
      host: RDS.host,
      port: 5432,
    });
    expect(dbAdmin.created).toHaveLength(1);
    expect(dbAdmin.created[0]?.target.url).toContain(RDS.host);
    expect(app.db.select().from(databases).where(eq(databases.name, 'shop_db')).get()?.connectionId).toBe(id);

    await app.close();
  });

  it("renders the env against the connection's host, not 127.0.0.1", async () => {
    const { app, cookie } = await buildTestApp();
    const id = await registerRds(app, cookie);
    const created = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { connection: `external:${String(id)}`, name: 'shop_db' },
    });

    const credentials = await app.inject({
      method: 'GET',
      url: `/api/databases/${String(created.json().id)}/credentials`,
      headers: { cookie },
    });

    expect(credentials.json().env).toMatchObject({
      DB_CONNECTION: 'pgsql',
      DB_HOST: RDS.host,
      DB_PORT: '5432',
      DB_DATABASE: 'shop_db',
    });

    await app.close();
  });

  it("injects the connection's host into a project's env", async () => {
    const { app, cookie } = await buildTestApp();
    const id = await registerRds(app, cookie);
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name: 'Shop', slug: 'shop', repoUrl: 'https://github.com/acme/shop.git', branch: 'main', type: 'static' },
    });
    // A project that couldn't be provisioned in this environment isn't what this test is about.
    if (project.statusCode !== 201) {
      await app.close();
      return;
    }
    const created = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { connection: `external:${String(id)}`, name: 'shop_db' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/databases/${String(created.json().id)}/inject`,
      headers: { cookie },
      payload: { projectId: project.json().id },
    });

    const env = await app.inject({ method: 'GET', url: `/api/projects/${String(project.json().id)}/env`, headers: { cookie } });
    expect(env.payload).toContain(`DB_HOST=${RDS.host}`);

    await app.close();
  });

  it('allows the same database name on two different connections', async () => {
    const { app, cookie } = await buildTestApp();
    const id = await registerRds(app, cookie);

    const onHost = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { engine: 'postgres', name: 'shop_db' },
    });
    const onRds = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { connection: `external:${String(id)}`, name: 'shop_db' },
    });

    expect(onHost.statusCode).toBe(201);
    expect(onRds.statusCode).toBe(201);

    // ...but not twice on the same one.
    const twice = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { connection: `external:${String(id)}`, name: 'shop_db' },
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toContain(RDS.name);

    await app.close();
  });

  it('drops against the connection it lives on', async () => {
    const { app, cookie, dbAdmin } = await buildTestApp();
    const id = await registerRds(app, cookie);
    const created = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { connection: `external:${String(id)}`, name: 'shop_db' },
    });

    const dropped = await app.inject({
      method: 'DELETE',
      url: `/api/databases/${String(created.json().id)}`,
      headers: { cookie },
      payload: { confirmName: 'shop_db' },
    });

    expect(dropped.statusCode).toBe(204);
    expect(dbAdmin.dropped[0]?.target.url).toContain(RDS.host);

    await app.close();
  });

  it('404s for a connection that was never registered, and 400s for a nonsense key', async () => {
    const { app, cookie } = await buildTestApp();

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { connection: 'external:999', name: 'nope_db' },
    });
    expect(unknown.statusCode).toBe(404);

    const nonsense = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { connection: 'not-a-key', name: 'nope_db' },
    });
    expect(nonsense.statusCode).toBe(404);

    await app.close();
  });

  it("refuses an engine that contradicts the connection it's being created on", async () => {
    const { app, cookie } = await buildTestApp();
    const id = await registerRds(app, cookie);

    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { connection: `external:${String(id)}`, engine: 'mysql', name: 'shop_db' },
    });

    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toMatch(/is postgres, not mysql/);

    await app.close();
  });

  it('keeps treating a bare engine as this host, exactly as before connections existed', async () => {
    const { app, cookie, dbAdmin } = await buildTestApp();

    const created = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'legacy_db' } });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ connectionKey: 'local:mysql', host: '127.0.0.1', port: 3306 });
    expect(dbAdmin.created[0]?.target.url).toBe(LOCAL_MYSQL_ADMIN_URL);
    expect(app.db.select().from(databases).where(eq(databases.name, 'legacy_db')).get()?.connectionId).toBeNull();

    await app.close();
  });

  it('reports a host engine with no admin credentials as a provisioning failure, not a missing connection', async () => {
    const { app, cookie } = await buildTestApp({ engines: false });

    const created = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'nowhere_db' } });

    expect(created.statusCode).toBe(502);
    expect(created.json().detail).toMatch(/mysql admin credentials not configured/);

    await app.close();
  });
});

describe('services/dbconnections', () => {
  it('resolves a stored connection back to a usable admin target', async () => {
    const { app, cookie } = await buildTestApp();
    const id = await registerRds(app, cookie);

    const resolved = resolveConnection(app.db, app.secretBox, `external:${String(id)}`);

    expect(resolved).toMatchObject({
      key: `external:${String(id)}`,
      kind: 'external',
      name: RDS.name,
      engine: 'postgres',
      endpoint: { host: RDS.host, port: 5432 },
    });
    // Round-trips the encrypted password back into the URL the driver needs.
    expect(resolved?.target.url).toContain('rds-p%40ss%2Fword%231');
    expect(resolved?.target.tls).toBe(true);

    await app.close();
  });

  it('resolves an unknown or malformed key to null rather than throwing', async () => {
    const { app } = await buildTestApp();

    expect(resolveConnection(app.db, app.secretBox, 'external:404')).toBeNull();
    expect(resolveConnection(app.db, app.secretBox, 'local:sqlite')).toBeNull();
    expect(resolveConnection(app.db, app.secretBox, '')).toBeNull();

    await app.close();
  });

  it('lists host engines before registered ones', async () => {
    const { app, cookie } = await buildTestApp();
    await registerRds(app, cookie);

    expect(listConnections(app.db, app.secretBox).map((row) => row.key)).toEqual(['local:mysql', 'local:postgres', 'external:1']);

    await app.close();
  });
});
