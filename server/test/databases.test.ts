import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { databases, projects } from '../src/db/schema.js';
import { setSetting } from '../src/db/settings.js';
import { connectionEnv, IDENTIFIER_RE, makeDbAdmin, type DbAdmin, type DbEngine } from '../src/services/dbprovision.js';

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

type FakeCall =
  | { op: 'create'; engine: DbEngine; name: string; user: string; password: string }
  | { op: 'drop'; engine: DbEngine; name: string; user: string };

/** Records every call so tests can assert on exact arguments; either method can be made to throw. */
class FakeDbAdmin implements DbAdmin {
  calls: FakeCall[] = [];
  createError: Error | null = null;
  dropError: Error | null = null;

  async createDatabase(engine: DbEngine, name: string, user: string, password: string): Promise<void> {
    this.calls.push({ op: 'create', engine, name, user, password });
    if (this.createError) throw this.createError;
  }

  async dropDatabase(engine: DbEngine, name: string, user: string): Promise<void> {
    this.calls.push({ op: 'drop', engine, name, user });
    if (this.dropError) throw this.dropError;
  }
}

interface TestApp {
  app: FastifyInstance;
  cookie: string;
  dbAdmin: FakeDbAdmin;
}

async function buildDatabasesTestApp(): Promise<TestApp> {
  const dataDir = tmpDataDir();
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });
  const dbAdmin = new FakeDbAdmin();
  const app = await buildApp(cfg, { dbAdmin });

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
      username: 'reveal_db',
      password,
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
    expect(dbAdmin.calls).toEqual([{ op: 'drop', engine: 'mysql', name: 'delete_me', user: 'delete_me' }]);
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

describe('POST /api/databases/:id/inject', () => {
  it('appends DB_ connection lines under a shipway comment, marked and re-encrypted', async () => {
    const { app, cookie } = await buildDatabasesTestApp();
    const projectId = insertProject(app);
    const create = await app.inject({ method: 'POST', url: '/api/databases', headers: { cookie }, payload: { engine: 'mysql', name: 'inject_db', projectId } });
    const { password } = create.json();
    const dbId = create.json().id;

    await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/env`, headers: { cookie }, payload: { content: 'APP_KEY=base64:xyz\n' } });

    const res = await app.inject({ method: 'POST', url: `/api/databases/${dbId}/inject`, headers: { cookie }, payload: { projectId } });
    expect(res.statusCode).toBe(204);

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
    expect(res.statusCode).toBe(204);

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

describe('GET /api/services/info', () => {
  it('returns null redis/mailpit info when unset', async () => {
    const { app, cookie } = await buildDatabasesTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/services/info', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ redis: null, mailpit: null });

    await app.close();
  });

  it('returns stored redis/mailpit info', async () => {
    const { app, cookie } = await buildDatabasesTestApp();
    setSetting(app.db, 'redis_info', { host: '127.0.0.1', port: 6379, password: 'hunter2' });
    setSetting(app.db, 'mailpit_info', { smtpHost: '127.0.0.1', smtpPort: 1025, webUrl: 'http://127.0.0.1:8025' });

    const res = await app.inject({ method: 'GET', url: '/api/services/info', headers: { cookie } });
    expect(res.json()).toEqual({
      redis: { host: '127.0.0.1', port: 6379, password: 'hunter2' },
      mailpit: { smtpHost: '127.0.0.1', smtpPort: 1025, webUrl: 'http://127.0.0.1:8025' },
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

describe('makeDbAdmin (real implementation)', () => {
  it('constructing it never opens a connection (getSettings is not even called)', () => {
    let called = false;
    const dbAdmin = makeDbAdmin(() => {
      called = true;
      return {};
    });
    expect(dbAdmin).toBeDefined();
    expect(called).toBe(false);
  });

  it('rejects an invalid database name before ever attempting a connection', async () => {
    const dbAdmin = makeDbAdmin(() => {
      throw new Error('getSettings should not be reached before identifier validation');
    });

    await expect(dbAdmin.createDatabase('mysql', 'Not Valid!', 'validuser', 'pw')).rejects.toThrow(/invalid database name/i);
  });

  it('rejects an invalid user before ever attempting a connection', async () => {
    const dbAdmin = makeDbAdmin(() => {
      throw new Error('getSettings should not be reached before identifier validation');
    });

    await expect(dbAdmin.createDatabase('postgres', 'valid_name', 'Not Valid!', 'pw')).rejects.toThrow(/invalid database user/i);
  });

  it('rejects an invalid name on dropDatabase before ever attempting a connection', async () => {
    const dbAdmin = makeDbAdmin(() => {
      throw new Error('getSettings should not be reached before identifier validation');
    });

    await expect(dbAdmin.dropDatabase('mysql', 'Not Valid!', 'validuser')).rejects.toThrow(/invalid database name/i);
  });

  it('throws a clear error when the engine admin URL setting is missing', async () => {
    const dbAdmin = makeDbAdmin(() => ({}));

    await expect(dbAdmin.createDatabase('mysql', 'valid_name', 'valid_user', 'pw')).rejects.toThrow('mysql admin credentials not configured');
    await expect(dbAdmin.createDatabase('postgres', 'valid_name', 'valid_user', 'pw')).rejects.toThrow('postgres admin credentials not configured');
  });
});
