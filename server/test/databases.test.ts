import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { auditEvents, databases, projects } from '../src/db/schema.js';
import { setSetting } from '../src/db/settings.js';
import {
  connectionEnv,
  IDENTIFIER_RE,
  makeDbAdmin,
  type DbAdmin,
  type DbAdminDeps,
  type DbAdminTarget,
  type DbEngine,
  type SqlConnection,
} from '../src/services/dbprovision.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-databases-test-'));
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

/** What install.sh writes into settings for the engines running on the host itself. */
const LOCAL_MYSQL_ADMIN_URL = 'mysql://shipway_admin:hunter2@127.0.0.1:3306';
const LOCAL_POSTGRES_ADMIN_URL = 'postgres://shipway_admin:hunter2@127.0.0.1:5432/postgres';

type FakeCall =
  | { op: 'create'; engine: DbEngine; name: string; user: string; password: string }
  | { op: 'drop'; engine: DbEngine; name: string; user: string; keepDatabase: boolean };

/**
 * Records every call so tests can assert on exact arguments; either method can be made to throw.
 * `targets` keeps the admin target each call was routed to, which is how a test tells "provisioned
 * on this host" from "provisioned on the registered RDS connection" — the calls themselves look
 * identical otherwise.
 */
class FakeDbAdmin implements DbAdmin {
  calls: FakeCall[] = [];
  targets: DbAdminTarget[] = [];
  tested: DbAdminTarget[] = [];
  createError: Error | null = null;
  dropError: Error | null = null;
  testError: Error | null = null;
  /** Every `importSql` call, with the SQL the route streamed to disk read back — the file itself is
   * gone by the time the request returns, so this is the only place a test can see what was fed in. */
  imports: { target: DbAdminTarget; database: string; sql: string }[] = [];
  importError: Error | null = null;
  /** Every `dumpSql` call, in order. The dump's contents are this fake's own (see `dumpSql`), so
   * only the target and the database name are worth keeping. */
  dumps: { target: DbAdminTarget; database: string }[] = [];
  dumpError: Error | null = null;

  async createDatabase(target: DbAdminTarget, name: string, user: string, password: string): Promise<void> {
    this.targets.push(target);
    this.calls.push({ op: 'create', engine: target.engine, name, user, password });
    if (this.createError) throw this.createError;
  }

  async dropDatabase(target: DbAdminTarget, name: string, user: string, opts?: { keepDatabase?: boolean }): Promise<void> {
    this.targets.push(target);
    this.calls.push({ op: 'drop', engine: target.engine, name, user, keepDatabase: opts?.keepDatabase === true });
    if (this.dropError) throw this.dropError;
  }

  async testConnection(target: DbAdminTarget): Promise<void> {
    this.tested.push(target);
    if (this.testError) throw this.testError;
  }

  async importSql(target: DbAdminTarget, database: string, sqlPath: string): Promise<void> {
    this.imports.push({ target, database, sql: fs.readFileSync(sqlPath, 'utf8') });
    if (this.importError) throw this.importError;
  }

  async dumpSql(target: DbAdminTarget, database: string, sqlPath: string): Promise<void> {
    this.dumps.push({ target, database });
    if (this.dumpError) throw this.dumpError;
    // Real bytes, so a caller that dumps and then imports (cloning a project) actually moves
    // something a stubbed `importSql` can read back.
    fs.writeFileSync(sqlPath, `-- dump of ${database}\n`);
  }
}

interface TestApp {
  app: FastifyInstance;
  cookie: string;
  dbAdmin: FakeDbAdmin;
}

/**
 * `engines: false` builds a host with no admin URLs in settings — what a box looks like before
 * install.sh's bootstrap, and the only state in which the host's own engines are not offered as
 * connections. Every other test wants the normal case, where both are configured.
 */
async function buildDatabasesTestApp(opts: { engines?: boolean } = {}): Promise<TestApp> {
  const dataDir = tmpDataDir();
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });
  const dbAdmin = new FakeDbAdmin();
  const app = await buildApp(cfg, { dbAdmin });

  if (opts.engines !== false) {
    setSetting(app.db, 'mysql_admin_url', LOCAL_MYSQL_ADMIN_URL);
    setSetting(app.db, 'postgres_admin_url', LOCAL_POSTGRES_ADMIN_URL);
  }

  const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
  const cookie = sessionCookie(create);

  return { app, cookie, dbAdmin };
}

/** Inserts a project row directly (skipping the full provisioning pipeline — irrelevant here). */
function insertProject(app: FastifyInstance, overrides: Partial<{ name: string; slug: string }> = {}): number {
  const slug = overrides.slug ?? 'shop';
  app.db
    .insert(projects)
    .values({
      name: overrides.name ?? 'Shop',
      slug,
      repo: 'acme/shop',
      branch: 'main',
      type: 'php',
    })
    .run();
  const row = app.db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get();
  if (!row) throw new Error('failed to insert test project');
  return row.id;
}

describe('POST /api/databases', () => {
  it('provisions via DbAdmin, stores the row with the password encrypted at rest, and returns creds once (201)', async () => {
    const { app, cookie, dbAdmin } = await buildDatabasesTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { engine: 'mysql', name: 'my_app_db' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ engine: 'mysql', name: 'my_app_db', username: 'my_app_db' });
    expect(typeof body.password).toBe('string');
    expect(body.password).toHaveLength(24);
    expect(typeof body.id).toBe('number');

    // DbAdmin was actually invoked to provision the real database.
    expect(dbAdmin.calls).toEqual([{ op: 'create', engine: 'mysql', name: 'my_app_db', user: 'my_app_db', password: body.password }]);

    // Encrypted at rest: the stored blob is neither the plaintext password nor does it contain it.
    const row = app.db.select().from(databases).where(eq(databases.id, body.id)).get();
    expect(row?.passwordEncrypted).toBeInstanceOf(Buffer);
    expect(row?.passwordEncrypted.toString('utf8')).not.toBe(body.password);
    expect(row?.passwordEncrypted.includes(body.password)).toBe(false);
    expect(row?.username).toBe('my_app_db');
    expect(row?.projectId).toBeNull();

    await app.close();
  });

  it('associates the database with a project when projectId is given', async () => {
    const { app, cookie } = await buildDatabasesTestApp();
    const projectId = insertProject(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { engine: 'postgres', name: 'shop_db', projectId },
    });

    expect(res.statusCode).toBe(201);
    const row = app.db.select().from(databases).where(eq(databases.id, res.json().id)).get();
    expect(row?.projectId).toBe(projectId);

    await app.close();
  });

  it('404s when projectId does not reference an existing project', async () => {
    const { app, cookie } = await buildDatabasesTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { engine: 'mysql', name: 'orphan_db', projectId: 999999 },
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('rejects an invalid name with 400 and never calls DbAdmin', async () => {
    const { app, cookie, dbAdmin } = await buildDatabasesTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { engine: 'mysql', name: 'Not Valid!' },
    });

    expect(res.statusCode).toBe(400);
    expect(dbAdmin.calls).toEqual([]);

    await app.close();
  });

  it('rejects a duplicate name+engine with 409', async () => {
    const { app, cookie } = await buildDatabasesTestApp();

    await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'dup_db' } });
    const res = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'dup_db' } });

    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it('allows the same name across different engines', async () => {
    const { app, cookie } = await buildDatabasesTestApp();

    await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'shared_name' } });
    const res = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'postgres', name: 'shared_name' } });

    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('returns 502 and does not store a row when DbAdmin.createDatabase throws', async () => {
    const { app, cookie, dbAdmin } = await buildDatabasesTestApp();
    dbAdmin.createError = new Error('mysql admin credentials not configured');

    const res = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'failing_db' } });

    expect(res.statusCode).toBe(502);
    const list = await app.inject({ method: 'GET', url: '/api/databases', headers: { cookie } });
    expect(list.json()).toEqual([]);

    await app.close();
  });

  it('unauthenticated requests are 401', async () => {
    const { app } = await buildDatabasesTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/databases', payload: { engine: 'mysql', name: 'x' } });
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('POST /api/databases — reserved names', () => {
  // A name like `mysql` passes IDENTIFIER_RE, so nothing but this check stands between a project
  // database and the engine's own system schema: `CREATE DATABASE IF NOT EXISTS \`mysql\`` is a
  // silent no-op and the GRANT that follows would hand the project full access to MySQL's user and
  // grant tables (this happened on a real install — see services/dbconn.ts's RESERVED_DB_NAMES).
  it('refuses every system database name, on either engine, without touching the server', async () => {
    const { app, cookie, dbAdmin } = await buildDatabasesTestApp();

    for (const name of ['mysql', 'information_schema', 'performance_schema', 'sys', 'postgres', 'template0', 'template1', 'pg_catalog']) {
      for (const engine of ['mysql', 'postgres'] as const) {
        const res = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine, name } });
        expect(res.statusCode, `expected 409 for ${engine} "${name}"`).toBe(409);
        expect(res.json().error).toContain('system database name');
      }
    }

    expect(dbAdmin.calls).toEqual([]);

    await app.close();
  });

  it('still allows a name that merely contains a reserved word', async () => {
    const { app, cookie } = await buildDatabasesTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'mysql_backup' } });

    expect(res.statusCode).toBe(201);

    await app.close();
  });
});

describe('GET /api/databases', () => {
  it('lists rows without passwords, joining projectName when projectId is set', async () => {
    const { app, cookie } = await buildDatabasesTestApp();
    const projectId = insertProject(app);

    await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'with_project', projectId } });
    await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'without_project' } });

    const res = await app.inject({ method: 'GET', url: '/api/databases', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    for (const row of body) {
      expect(row.password).toBeUndefined();
      expect(row.passwordEncrypted).toBeUndefined();
    }

    const withProject = body.find((r: { name: string }) => r.name === 'with_project');
    const withoutProject = body.find((r: { name: string }) => r.name === 'without_project');
    expect(withProject.projectName).toBe('Shop');
    expect(withoutProject.projectName).toBeNull();

    await app.close();
  });
});

describe('GET /api/databases/:id/credentials', () => {
  it('decrypts and returns the username/password/env', async () => {
    const { app, cookie } = await buildDatabasesTestApp();

    const create = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'postgres', name: 'reveal_db' } });
    const { id, password } = create.json();

    const res = await app.inject({ method: 'GET', url: `/api/databases/${id}/credentials`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      // Repeated from the list route so the phpMyAdmin signon shim, which has only an id, can
      // build a whole connection from this one response.
      name: 'reveal_db',
      engine: 'postgres',
      username: 'reveal_db',
      password,
      // Where the app dials — this host, for a database on the host's own engine.
      host: '127.0.0.1',
      port: 5432,
      env: connectionEnv('postgres', { name: 'reveal_db', username: 'reveal_db', password }),
    });

    await app.close();
  });

  it('404s for an unknown id', async () => {
    const { app, cookie } = await buildDatabasesTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/databases/999999/credentials', headers: { cookie } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe('DELETE /api/databases/:id', () => {
  it('requires body {confirmName} to match the name, else 400 (and DbAdmin/row untouched)', async () => {
    const { app, cookie, dbAdmin } = await buildDatabasesTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'protect_me' } });
    const { id } = create.json();
    dbAdmin.calls.length = 0;

    const res = await app.inject({ method: 'DELETE', url: `/api/databases/${id}`, headers: { cookie }, payload: { confirmName: 'wrong' } });

    expect(res.statusCode).toBe(400);
    expect(dbAdmin.calls).toEqual([]);
    expect(app.db.select().from(databases).where(eq(databases.id, id)).get()).toBeDefined();

    await app.close();
  });

  it('calls dropDatabase and removes the row on a matching confirmName (204)', async () => {
    const { app, cookie, dbAdmin } = await buildDatabasesTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'delete_me' } });
    const { id } = create.json();
    dbAdmin.calls.length = 0;

    const res = await app.inject({ method: 'DELETE', url: `/api/databases/${id}`, headers: { cookie }, payload: { confirmName: 'delete_me' } });

    expect(res.statusCode).toBe(204);
    expect(dbAdmin.calls).toEqual([{ op: 'drop', engine: 'mysql', name: 'delete_me', user: 'delete_me', keepDatabase: false }]);
    expect(app.db.select().from(databases).where(eq(databases.id, id)).get()).toBeUndefined();

    await app.close();
  });

  it('404s for an unknown id', async () => {
    const { app, cookie } = await buildDatabasesTestApp();

    const res = await app.inject({ method: 'DELETE', url: '/api/databases/999999', headers: { cookie }, payload: { confirmName: 'x' } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe('DELETE /api/databases/:id — a row whose name is a system database', () => {
  // Such a row can only predate the create-time guard, and it is exactly the row someone will click
  // Drop on to clean up. `DROP DATABASE mysql` would take the server's own schema with it, so the
  // record and its user go and the database stays.
  it('drops the user and the record but never the database itself', async () => {
    const { app, cookie, dbAdmin } = await buildDatabasesTestApp();
    // Inserted directly: the create route (correctly) refuses this name now.
    app.db.insert(databases).values({ engine: 'mysql', name: 'mysql', username: 'mysql', passwordEncrypted: app.secretBox.encrypt('pw') }).run();
    const row = app.db.select({ id: databases.id }).from(databases).where(eq(databases.name, 'mysql')).get();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/databases/${String(row!.id)}`,
      headers: { cookie },
      payload: { confirmName: 'mysql' },
    });

    expect(res.statusCode).toBe(204);
    expect(dbAdmin.calls).toEqual([{ op: 'drop', engine: 'mysql', name: 'mysql', user: 'mysql', keepDatabase: true }]);
    expect(app.db.select().from(databases).all()).toHaveLength(0);

    await app.close();
  });
});

describe('POST /api/databases/:id/inject', () => {
  it('appends DB_ connection lines under a shipway comment, marked and re-encrypted', async () => {
    const { app, cookie } = await buildDatabasesTestApp();
    const projectId = insertProject(app);
    const create = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'inject_db', projectId } });
    const { password } = create.json();
    const dbId = create.json().id;

    await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/env`, headers: { cookie }, payload: { content: 'APP_KEY=base64:xyz\n' } });

    const res = await app.inject({ method: 'POST', url: `/api/databases/${dbId}/inject`, headers: { cookie }, payload: { projectId } });
    // 200 with an apply result, not 204: this writes the project's .env, so it now also applies
    // it to the running release (services/envapply.ts).
    expect(res.statusCode).toBe(200);

    const envRes = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/env`, headers: { cookie } });
    const content = envRes.json().content as string;

    expect(content).toContain('APP_KEY=base64:xyz');
    expect(content).toContain('# added by shipway — database inject_db');
    expect(content).toContain('DB_CONNECTION=mysql');
    expect(content).toContain('DB_HOST=127.0.0.1');
    expect(content).toContain('DB_PORT=3306');
    expect(content).toContain('DB_DATABASE=inject_db');
    expect(content).toContain('DB_USERNAME=inject_db');
    expect(content).toContain(`DB_PASSWORD=${password}`);

    // Stored encrypted, not as plaintext containing the password.
    const row = app.db.select({ envEncrypted: projects.envEncrypted }).from(projects).where(eq(projects.id, projectId)).get();
    expect(row?.envEncrypted?.includes(password)).toBe(false);

    await app.close();
  });

  it('skips keys the project env already defines (line-start KEY= match)', async () => {
    const { app, cookie } = await buildDatabasesTestApp();
    const projectId = insertProject(app);
    const create = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'postgres', name: 'skip_db', projectId } });
    const dbId = create.json().id;

    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/env`,
      headers: { cookie },
      payload: { content: 'DB_CONNECTION=custom-value\nDB_HOST=10.0.0.5\n' },
    });

    const res = await app.inject({ method: 'POST', url: `/api/databases/${dbId}/inject`, headers: { cookie }, payload: { projectId } });
    // 200 with an apply result, not 204: this writes the project's .env, so it now also applies
    // it to the running release (services/envapply.ts).
    expect(res.statusCode).toBe(200);

    const envRes = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/env`, headers: { cookie } });
    const content = envRes.json().content as string;

    // Pre-existing values for already-defined keys survive untouched...
    expect(content).toContain('DB_CONNECTION=custom-value');
    expect(content).toContain('DB_HOST=10.0.0.5');
    // ...and appear exactly once (not overridden/duplicated by the injected block).
    expect(content.match(/DB_CONNECTION=/g)).toHaveLength(1);
    expect(content.match(/DB_HOST=/g)).toHaveLength(1);
    // Keys not already defined still get injected.
    expect(content).toContain('DB_DATABASE=skip_db');
    expect(content).toContain('DB_USERNAME=skip_db');

    await app.close();
  });

  it('404s for an unknown database id', async () => {
    const { app, cookie } = await buildDatabasesTestApp();
    const projectId = insertProject(app);

    const res = await app.inject({ method: 'POST', url: '/api/databases/999999/inject', headers: { cookie }, payload: { projectId } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('404s for an unknown project id', async () => {
    const { app, cookie } = await buildDatabasesTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'no_project_db' } });
    const dbId = create.json().id;

    const res = await app.inject({ method: 'POST', url: `/api/databases/${dbId}/inject`, headers: { cookie }, payload: { projectId: 999999 } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe('POST /api/databases/:id/inject — project association', () => {
  it('attaches a standalone database to the project it was injected into', async () => {
    const { app, cookie } = await buildDatabasesTestApp();
    const projectId = insertProject(app);
    const create = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'loose_db' } });
    const dbId = create.json().id as number;
    expect(app.db.select({ projectId: databases.projectId }).from(databases).where(eq(databases.id, dbId)).get()?.projectId).toBeNull();

    const res = await app.inject({ method: 'POST', url: `/api/databases/${String(dbId)}/inject`, headers: { cookie }, payload: { projectId } });

    // 200 with an apply result, not 204: this writes the project's .env, so it now also applies
    // it to the running release (services/envapply.ts).
    expect(res.statusCode).toBe(200);
    expect(app.db.select({ projectId: databases.projectId }).from(databases).where(eq(databases.id, dbId)).get()?.projectId).toBe(projectId);

    await app.close();
  });

  it('never re-points a database that already belongs to another project', async () => {
    const { app, cookie } = await buildDatabasesTestApp();
    const ownerProjectId = insertProject(app, { slug: 'owner' });
    const otherProjectId = insertProject(app, { slug: 'other' });
    const create = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie },
      payload: { engine: 'mysql', name: 'owned_db', projectId: ownerProjectId },
    });
    const dbId = create.json().id as number;

    const res = await app.inject({ method: 'POST', url: `/api/databases/${String(dbId)}/inject`, headers: { cookie }, payload: { projectId: otherProjectId } });

    // The env injection still happens (that is what was asked for); the ownership does not move.
    // 200 with an apply result, not 204: this writes the project's .env, so it now also applies
    // it to the running release (services/envapply.ts).
    expect(res.statusCode).toBe(200);
    expect(app.db.select({ projectId: databases.projectId }).from(databases).where(eq(databases.id, dbId)).get()?.projectId).toBe(ownerProjectId);

    await app.close();
  });
});

describe('POST /api/databases/:id/import', () => {
  const SQL_HEADERS = (cookie: string) => ({ cookie, 'content-type': 'application/sql' });

  it('streams the dump to DbAdmin as the database own user and audits the byte count', async () => {
    const { app, cookie, dbAdmin } = await buildDatabasesTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'seed_db' } });
    const { id, password } = create.json();

    const dump = 'CREATE TABLE widgets (id INT);\nINSERT INTO widgets VALUES (1);\n';
    const res = await app.inject({ method: 'POST', url: `/api/databases/${String(id)}/import`, headers: SQL_HEADERS(cookie), payload: dump });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bytes: Buffer.byteLength(dump) });
    expect(dbAdmin.imports).toHaveLength(1);
    expect(dbAdmin.imports[0]?.database).toBe('seed_db');
    expect(dbAdmin.imports[0]?.sql).toBe(dump);

    // The credentials handed to the client are the database own user, never shipway_admin: a
    // Postgres restore run as the admin role leaves every table owned by it and unusable by the app.
    expect(dbAdmin.imports[0]?.target.url).toBe(`mysql://seed_db:${encodeURIComponent(password as string)}@127.0.0.1:3306`);

    const audit = await app.inject({ method: 'GET', url: '/api/audit?action=database.import', headers: { cookie } });
    expect(audit.json().events[0]).toMatchObject({ action: 'database.import', targetName: 'seed_db' });

    await app.close();
  });

  it('502s with the client own message when the import fails, and never leaves the dump on disk', async () => {
    const { app, cookie, dbAdmin } = await buildDatabasesTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'postgres', name: 'bad_db' } });
    const id = create.json().id;
    dbAdmin.importError = new Error('psql import failed: ERROR: syntax error at or near "CREAT"');

    const before = fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('shipway-sql-'));
    const res = await app.inject({ method: 'POST', url: `/api/databases/${String(id)}/import`, headers: SQL_HEADERS(cookie), payload: 'CREAT TABLE x;' });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'sql import failed' });
    expect(res.json().detail).toContain('syntax error');
    // The temp file holds someone production data; a failed import is exactly when it would be
    // left behind if the cleanup were on the success path only.
    expect(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('shipway-sql-'))).toEqual(before);

    await app.close();
  });

  it('rejects an empty file without calling DbAdmin', async () => {
    const { app, cookie, dbAdmin } = await buildDatabasesTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'empty_db' } });
    const id = create.json().id;

    const res = await app.inject({ method: 'POST', url: `/api/databases/${String(id)}/import`, headers: SQL_HEADERS(cookie), payload: '' });

    expect(res.statusCode).toBe(400);
    expect(dbAdmin.imports).toEqual([]);

    await app.close();
  });

  it('404s for an unknown database id without calling DbAdmin', async () => {
    const { app, cookie, dbAdmin } = await buildDatabasesTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/databases/999999/import', headers: SQL_HEADERS(cookie), payload: 'SELECT 1;' });

    expect(res.statusCode).toBe(404);
    expect(dbAdmin.imports).toEqual([]);

    await app.close();
  });

  it('requires a session', async () => {
    const { app } = await buildDatabasesTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/databases/1/import', headers: { 'content-type': 'application/sql' }, payload: 'SELECT 1;' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('GET /api/services/info', () => {
  it('returns null redis/mailpit info when unset', async () => {
    const { app, cookie } = await buildDatabasesTestApp({ engines: false });

    const res = await app.inject({ method: 'GET', url: '/api/services/info', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ redis: null, mailpit: null, databaseEngines: { mysql: false, postgres: false } });

    await app.close();
  });

  it('returns stored redis/mailpit info', async () => {
    const { app, cookie } = await buildDatabasesTestApp({ engines: false });
    setSetting(app.db, 'redis_info', { host: '127.0.0.1', port: 6379, password: 'hunter2' });
    setSetting(app.db, 'mailpit_info', { smtpHost: '127.0.0.1', smtpPort: 1025, webUrl: 'http://127.0.0.1:8025' });

    const res = await app.inject({ method: 'GET', url: '/api/services/info', headers: { cookie } });
    expect(res.json()).toEqual({
      redis: { host: '127.0.0.1', port: 6379, password: 'hunter2' },
      mailpit: { smtpHost: '127.0.0.1', smtpPort: 1025, webUrl: 'http://127.0.0.1:8025' },
      databaseEngines: { mysql: false, postgres: false },
    });

    await app.close();
  });

  it('passes through mailpit web UI username/webPassword when present (B6)', async () => {
    const { app, cookie } = await buildDatabasesTestApp();
    setSetting(app.db, 'mailpit_info', {
      smtpHost: '127.0.0.1',
      smtpPort: 1025,
      webUrl: 'https://mail.intcore.dev',
      username: 'intcore',
      webPassword: 'a-random-web-password',
    });

    const res = await app.inject({ method: 'GET', url: '/api/services/info', headers: { cookie } });
    expect(res.json().mailpit).toEqual({
      smtpHost: '127.0.0.1',
      smtpPort: 1025,
      webUrl: 'https://mail.intcore.dev',
      username: 'intcore',
      webPassword: 'a-random-web-password',
    });

    await app.close();
  });

  it('unauthenticated requests are 401', async () => {
    const { app } = await buildDatabasesTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/services/info' });
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('GET /api/services/info — configured database engines', () => {
  it('reports which engines have admin credentials, without ever returning the URLs', async () => {
    const { app, cookie } = await buildDatabasesTestApp({ engines: false });
    setSetting(app.db, 'postgres_admin_url', LOCAL_POSTGRES_ADMIN_URL);

    const res = await app.inject({ method: 'GET', url: '/api/services/info', headers: { cookie } });

    expect(res.json().databaseEngines).toEqual({ mysql: false, postgres: true });
    // The admin password must never leave the server through this route.
    expect(res.payload).not.toContain('hunter2');
    expect(res.payload).not.toContain('postgres://');

    await app.close();
  });
});

describe('connectionEnv', () => {
  const db = { name: 'app_db', username: 'app_user', password: 'sup3r-Secret-Pw' };

  it('renders the mysql (Laravel "mysql") connection env', () => {
    expect(connectionEnv('mysql', db)).toEqual({
      DB_CONNECTION: 'mysql',
      DB_HOST: '127.0.0.1',
      DB_PORT: '3306',
      DB_DATABASE: 'app_db',
      DB_USERNAME: 'app_user',
      DB_PASSWORD: 'sup3r-Secret-Pw',
    });
  });

  it('renders the postgres (Laravel "pgsql") connection env', () => {
    expect(connectionEnv('postgres', db)).toEqual({
      DB_CONNECTION: 'pgsql',
      DB_HOST: '127.0.0.1',
      DB_PORT: '5432',
      DB_DATABASE: 'app_db',
      DB_USERNAME: 'app_user',
      DB_PASSWORD: 'sup3r-Secret-Pw',
    });
  });
});

describe('IDENTIFIER_RE', () => {
  it('matches the documented shape: lowercase letter start, then letters/digits/underscore, max 32 chars', () => {
    expect(IDENTIFIER_RE.test('my_app_db')).toBe(true);
    expect(IDENTIFIER_RE.test('a')).toBe(true);
    expect(IDENTIFIER_RE.test('a'.repeat(32))).toBe(true);
    expect(IDENTIFIER_RE.test('a'.repeat(33))).toBe(false);
    expect(IDENTIFIER_RE.test('1_leading_digit')).toBe(false);
    expect(IDENTIFIER_RE.test('Has-Upper')).toBe(false);
    expect(IDENTIFIER_RE.test('has space')).toBe(false);
    expect(IDENTIFIER_RE.test('has-hyphen')).toBe(false);
  });
});

const MYSQL_TARGET: DbAdminTarget = { engine: 'mysql', url: LOCAL_MYSQL_ADMIN_URL };
const POSTGRES_TARGET: DbAdminTarget = { engine: 'postgres', url: LOCAL_POSTGRES_ADMIN_URL };

/** A target whose connect would throw if it were ever reached — for asserting that validation
 * happens before anything touches the network. */
function unreachableTarget(engine: DbEngine): DbAdminTarget {
  return { engine, url: `${engine === 'mysql' ? 'mysql' : 'postgres'}://never:used@127.0.0.1:1/` };
}

describe('makeDbAdmin (real implementation)', () => {
  it('constructing it never opens a connection', () => {
    let connected = false;
    const dbAdmin = makeDbAdmin({
      connectMysql: () => {
        connected = true;
        return Promise.reject(new Error('should not be reached'));
      },
    });
    expect(dbAdmin).toBeDefined();
    expect(connected).toBe(false);
  });

  it('rejects an invalid database name before ever attempting a connection', async () => {
    const dbAdmin = makeDbAdmin({ connectMysql: () => Promise.reject(new Error('should not connect')) });

    await expect(dbAdmin.createDatabase(unreachableTarget('mysql'), 'Not Valid!', 'validuser', 'pw')).rejects.toThrow(
      /invalid database name/i,
    );
  });

  it('rejects an invalid user before ever attempting a connection', async () => {
    const dbAdmin = makeDbAdmin({ connectPg: () => Promise.reject(new Error('should not connect')) });

    await expect(dbAdmin.createDatabase(unreachableTarget('postgres'), 'valid_name', 'Not Valid!', 'pw')).rejects.toThrow(
      /invalid database user/i,
    );
  });

  it('rejects an invalid name on dropDatabase before ever attempting a connection', async () => {
    const dbAdmin = makeDbAdmin({ connectMysql: () => Promise.reject(new Error('should not connect')) });

    await expect(dbAdmin.dropDatabase(unreachableTarget('mysql'), 'Not Valid!', 'validuser')).rejects.toThrow(/invalid database name/i);
  });

  it('routes each call to the URL of the target it was handed, not to anything ambient', async () => {
    const seen: { url: string; tls: boolean }[] = [];
    const conn = new RecordingConnection();
    const dbAdmin = makeDbAdmin({
      connectMysql: (url, tls) => {
        seen.push({ url, tls });
        return Promise.resolve(conn);
      },
      connectPg: (url, tls) => {
        seen.push({ url, tls });
        return Promise.resolve(conn);
      },
    });

    await dbAdmin.createDatabase({ engine: 'mysql', url: 'mysql://admin:pw@rds.example.com:3306', tls: true }, 'a_db', 'a_db', 'pw');
    await dbAdmin.createDatabase(POSTGRES_TARGET, 'b_db', 'b_db', 'pw');

    expect(seen).toEqual([
      { url: 'mysql://admin:pw@rds.example.com:3306', tls: true },
      { url: LOCAL_POSTGRES_ADMIN_URL, tls: false },
    ]);
  });

  it('testConnection runs SELECT 1 and closes the connection, on either engine', async () => {
    const conn = new RecordingConnection();
    await adminWith(conn).testConnection(MYSQL_TARGET);

    expect(conn.statements).toEqual(['SELECT 1']);
    expect(conn.ended).toBe(true);
  });

  it('testConnection surfaces the driver error, and still closes nothing it never opened', async () => {
    const dbAdmin = makeDbAdmin({ connectPg: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.9:5432')) });

    await expect(dbAdmin.testConnection(POSTGRES_TARGET)).rejects.toThrow(/ECONNREFUSED/);
  });
});

/**
 * Records every statement an engine path issues, and can be told to fail on the first statement
 * matching a pattern — enough to pin down both the happy-path SQL and what gets cleaned up when a
 * statement in the middle fails.
 */
class RecordingConnection implements SqlConnection {
  statements: string[] = [];
  ended = false;

  constructor(private readonly failOn?: RegExp) {}

  query(sql: string): Promise<unknown> {
    this.statements.push(sql);
    if (this.failOn && this.failOn.test(sql)) {
      return Promise.reject(new Error(`boom: ${sql}`));
    }
    return Promise.resolve(undefined);
  }

  end(): Promise<unknown> {
    this.ended = true;
    return Promise.resolve(undefined);
  }
}

function adminWith(conn: RecordingConnection): DbAdmin {
  return makeDbAdmin({ connectMysql: () => Promise.resolve(conn), connectPg: () => Promise.resolve(conn) });
}

/**
 * Records what `importSql` would have spawned instead of spawning it. `execa`'s own type is far
 * wider than the three-argument call this module makes, so the stub is written to that call and
 * cast — the point of the tests below is the command line, which is the entire behaviour here.
 */
function recordingRun(fail?: unknown) {
  const calls: { file: string; args: string[]; opts: { env?: Record<string, string>; stdin?: unknown; timeout?: number } }[] = [];
  const run = ((file: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ file, args, opts });
    return fail === undefined ? Promise.resolve({ exitCode: 0 }) : Promise.reject(fail);
  }) as unknown as NonNullable<DbAdminDeps['run']>;
  return { calls, run };
}

describe('makeDbAdmin — importSql', () => {
  // Not the admin URL: the route hands `importSql` the database's own credentials (see
  // routes/databases.ts), and these tests pin that the CLI flags are built from whatever it got.
  const MYSQL_APP_TARGET: DbAdminTarget = { engine: 'mysql', url: 'mysql://shop_db:s3cret@127.0.0.1:3306' };
  const PG_APP_TARGET: DbAdminTarget = { engine: 'postgres', url: 'postgres://shop_db:s3cret@127.0.0.1:5432' };

  it('feeds the dump to the mysql client over TCP, with the password out of argv', async () => {
    const { calls, run } = recordingRun();

    await makeDbAdmin({ run }).importSql(MYSQL_APP_TARGET, 'shop_db', '/tmp/dump.sql');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('mysql');
    expect(calls[0]?.args).toEqual([
      '--protocol=TCP',
      '--host=127.0.0.1',
      '--port=3306',
      '--user=shop_db',
      '--database=shop_db',
      '--default-character-set=utf8mb4',
    ]);
    // A command line is world-readable in `ps`; the environment is not.
    expect(calls[0]?.opts.env).toEqual({ MYSQL_PWD: 's3cret' });
    expect(calls[0]?.args.join(' ')).not.toContain('s3cret');
    expect(calls[0]?.opts.stdin).toEqual({ file: '/tmp/dump.sql' });
  });

  it('runs psql with ON_ERROR_STOP so a half-restored database is never reported as a success', async () => {
    const { calls, run } = recordingRun();

    await makeDbAdmin({ run }).importSql(PG_APP_TARGET, 'shop_db', '/tmp/dump.sql');

    expect(calls[0]?.file).toBe('psql');
    expect(calls[0]?.args).toEqual([
      '--host=127.0.0.1',
      '--port=5432',
      '--username=shop_db',
      '--dbname=shop_db',
      '--no-password',
      '--quiet',
      '--set=ON_ERROR_STOP=1',
      '--file=/tmp/dump.sql',
    ]);
    expect(calls[0]?.opts.env).toEqual({ PGPASSWORD: 's3cret' });
  });

  it('asks for TLS on a connection that wants it, on either engine', async () => {
    const my = recordingRun();
    await makeDbAdmin({ run: my.run }).importSql({ ...MYSQL_APP_TARGET, tls: true }, 'shop_db', '/tmp/dump.sql');
    expect(my.calls[0]?.args).toContain('--ssl-mode=REQUIRED');

    const pg = recordingRun();
    await makeDbAdmin({ run: pg.run }).importSql({ ...PG_APP_TARGET, tls: true }, 'shop_db', '/tmp/dump.sql');
    expect(pg.calls[0]?.opts.env).toEqual({ PGPASSWORD: 's3cret', PGSSLMODE: 'require' });
  });

  it('decodes percent-encoded credentials back to what the client should send', async () => {
    const { calls, run } = recordingRun();
    const target: DbAdminTarget = { engine: 'postgres', url: 'postgres://shop_db:p%40ss%2Fword%231@db.example.com:5433' };

    await makeDbAdmin({ run }).importSql(target, 'shop_db', '/tmp/dump.sql');

    expect(calls[0]?.args).toContain('--host=db.example.com');
    expect(calls[0]?.args).toContain('--port=5433');
    expect(calls[0]?.opts.env).toEqual({ PGPASSWORD: 'p@ss/word#1' });
  });

  it('reports the client last words, not its whole output', async () => {
    const stderr = ['-- lots', '-- of', '-- preamble', 'psql:dump.sql:41: ERROR:  relation "widgets" already exists'].join('\n');
    const { run } = recordingRun(Object.assign(new Error('Command failed'), { stderr, exitCode: 1 }));

    await expect(makeDbAdmin({ run }).importSql(PG_APP_TARGET, 'shop_db', '/tmp/dump.sql')).rejects.toThrow(
      /relation "widgets" already exists/,
    );
  });

  it('says the client is missing rather than blaming the dump', async () => {
    const { run } = recordingRun(Object.assign(new Error('spawn mysql ENOENT'), { code: 'ENOENT' }));

    await expect(makeDbAdmin({ run }).importSql(MYSQL_APP_TARGET, 'shop_db', '/tmp/dump.sql')).rejects.toThrow(
      /mysql client is not installed/,
    );
  });

  it('rejects an invalid database name before spawning anything', async () => {
    const { calls, run } = recordingRun();

    await expect(makeDbAdmin({ run }).importSql(MYSQL_APP_TARGET, 'not valid!', '/tmp/dump.sql')).rejects.toThrow(/invalid database name/i);
    expect(calls).toEqual([]);
  });
});

describe('makeDbAdmin — the SQL each engine actually issues', () => {
  it('creates a postgres database owned by its own role, granting the admin SET ROLE first', async () => {
    const conn = new RecordingConnection();

    await adminWith(conn).createDatabase(POSTGRES_TARGET, 'shop_db', 'shop_db', "p'wd");

    // The GRANT is not decoration: without it PostgreSQL 16 rejects the CREATE DATABASE below with
    // "must be able to SET ROLE", because a CREATEROLE admin's automatic membership in a role it
    // created carries `set_option = false`. Every Postgres database on a real install failed this
    // way until it was added, so the order is pinned here.
    expect(conn.statements).toEqual([
      `CREATE ROLE "shop_db" LOGIN PASSWORD 'p''wd'`,
      `GRANT "shop_db" TO CURRENT_USER`,
      `CREATE DATABASE "shop_db" OWNER "shop_db"`,
    ]);
    expect(conn.ended).toBe(true);
  });

  it('drops the role it just created when the postgres database cannot be created', async () => {
    const conn = new RecordingConnection(/^CREATE DATABASE/);

    await expect(adminWith(conn).createDatabase(POSTGRES_TARGET, 'shop_db', 'shop_db', 'pw')).rejects.toThrow(/boom: CREATE DATABASE/);

    // A leftover role makes the same name unusable forever: the retry dies at CREATE ROLE instead.
    expect(conn.statements.at(-1)).toBe(`DROP ROLE IF EXISTS "shop_db"`);
    expect(conn.ended).toBe(true);
  });

  it('creates a mysql database with a dedicated user granted only that database', async () => {
    const conn = new RecordingConnection();

    await adminWith(conn).createDatabase(MYSQL_TARGET, 'shop_db', 'shop_db', "p'wd");

    expect(conn.statements).toEqual([
      'CREATE DATABASE IF NOT EXISTS `shop_db`',
      `CREATE USER 'shop_db'@'%' IDENTIFIED BY 'p\\'wd'`,
      'GRANT ALL ON `shop_db`.* TO \'shop_db\'@\'%\'',
      'FLUSH PRIVILEGES',
    ]);
    expect(conn.ended).toBe(true);
  });

  it('drops the database it just created when the mysql user cannot be created', async () => {
    const conn = new RecordingConnection(/^CREATE USER/);

    await expect(adminWith(conn).createDatabase(MYSQL_TARGET, 'shop_db', 'shop_db', 'pw')).rejects.toThrow(/boom: CREATE USER/);

    expect(conn.statements.at(-1)).toBe('DROP DATABASE IF EXISTS `shop_db`');
    expect(conn.ended).toBe(true);
  });

  it('drops both the database and its user on a normal drop', async () => {
    const pg = new RecordingConnection();
    await adminWith(pg).dropDatabase(POSTGRES_TARGET, 'shop_db', 'shop_db');
    expect(pg.statements).toEqual([`DROP DATABASE IF EXISTS "shop_db"`, `DROP ROLE IF EXISTS "shop_db"`]);

    const my = new RecordingConnection();
    await adminWith(my).dropDatabase(MYSQL_TARGET, 'shop_db', 'shop_db');
    expect(my.statements).toEqual(['DROP DATABASE IF EXISTS `shop_db`', "DROP USER IF EXISTS 'shop_db'@'%'"]);
  });

  it('leaves the database itself alone with keepDatabase, on either engine', async () => {
    const pg = new RecordingConnection();
    await adminWith(pg).dropDatabase(POSTGRES_TARGET, 'postgres', 'postgres', { keepDatabase: true });
    expect(pg.statements).toEqual([`DROP ROLE IF EXISTS "postgres"`]);

    const my = new RecordingConnection();
    await adminWith(my).dropDatabase(MYSQL_TARGET, 'mysql', 'mysql', { keepDatabase: true });
    expect(my.statements).toEqual(["DROP USER IF EXISTS 'mysql'@'%'"]);
  });
});

/**
 * Deleting a project must DROP its databases, not just lose the rows to the `databases.project_id`
 * FK cascade. Before this, the row vanished while the real MySQL/Postgres database and its user
 * stayed on the engine forever — invisible to Shipway, and blocking recreation under the same name.
 */
describe('DELETE /api/projects/:id — linked databases', () => {
  async function projectWithDatabases(names: { name: string; engine: 'mysql' | 'postgres' }[]) {
    const harness = await buildDatabasesTestApp();
    const projectId = insertProject(harness.app);
    for (const db of names) {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/databases',
        headers: { cookie: harness.cookie },
        payload: { engine: db.engine, name: db.name, projectId },
      });
      expect(res.statusCode).toBe(201);
    }
    harness.dbAdmin.calls.length = 0;
    return { ...harness, projectId };
  }

  it('drops every linked database on the engine, with its user', async () => {
    const { app, cookie, dbAdmin, projectId } = await projectWithDatabases([
      { name: 'shop_db', engine: 'mysql' },
      { name: 'shop_cache', engine: 'postgres' },
    ]);
    const slug = app.db.select().from(projects).where(eq(projects.id, projectId)).get()!.slug;

    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${String(projectId)}`, headers: { cookie }, payload: { confirmName: slug } });

    expect(res.statusCode).toBe(204);
    expect(dbAdmin.calls.filter((call) => call.op === 'drop').map((call) => call.name).sort()).toEqual(['shop_cache', 'shop_db']);
    expect(app.db.select().from(databases).where(eq(databases.projectId, projectId)).all()).toHaveLength(0);

    await app.close();
  });

  it('records what it dropped in the audit trail', async () => {
    const { app, cookie, projectId } = await projectWithDatabases([{ name: 'shop_db', engine: 'mysql' }]);
    const slug = app.db.select().from(projects).where(eq(projects.id, projectId)).get()!.slug;

    await app.inject({ method: 'DELETE', url: `/api/projects/${String(projectId)}`, headers: { cookie }, payload: { confirmName: slug } });

    const row = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'project.delete')).all()[0];
    expect(JSON.parse(row?.meta ?? '{}')).toMatchObject({ databasesDropped: ['shop_db'] });

    await app.close();
  });

  it('still deletes the project when a drop fails, and names what was left behind', async () => {
    const { app, cookie, dbAdmin, projectId } = await projectWithDatabases([{ name: 'shop_db', engine: 'mysql' }]);
    const slug = app.db.select().from(projects).where(eq(projects.id, projectId)).get()!.slug;
    dbAdmin.dropError = new Error('server unreachable');

    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${String(projectId)}`, headers: { cookie }, payload: { confirmName: slug } });

    // 200, not 204 and not an error: the project IS gone, but something is still on the engine.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ databasesFailed: [{ name: 'shop_db', reason: 'server unreachable' }] });
    expect(app.db.select().from(projects).where(eq(projects.id, projectId)).get()).toBeUndefined();

    await app.close();
  });

  it('deletes a project with no databases exactly as before', async () => {
    const { app, cookie, dbAdmin } = await buildDatabasesTestApp();
    const projectId = insertProject(app);
    const slug = app.db.select().from(projects).where(eq(projects.id, projectId)).get()!.slug;
    dbAdmin.calls.length = 0;

    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${String(projectId)}`, headers: { cookie }, payload: { confirmName: slug } });

    expect(res.statusCode).toBe(204);
    expect(dbAdmin.calls).toHaveLength(0);

    await app.close();
  });
});
