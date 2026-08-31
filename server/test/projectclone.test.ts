/**
 * `services/projectclone.ts` — cloning a project onto a second subdomain with its own copy of the
 * original's databases.
 *
 * The tests that matter most here are the ones about what the clone's env points at. A clone is only
 * useful if it is genuinely separate from what it was cloned from, so "DB_* names the copy" and
 * "nothing is left behind when the copy fails" are the two properties this file exists to pin down.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { auditEvents, cronJobs, databases, projectNotificationRecipients, projects, workers } from '../src/db/schema.js';
import { setSetting } from '../src/db/settings.js';
import { FakeDnsClient } from '../src/services/cloudflare.js';
import { DevSysOps } from '../src/sysops/dev.js';
import { cloneProject, CloneError, rewriteEnvDomain, rewriteEnvValues, type CloneDeps } from '../src/services/projectclone.js';
import type { DbAdmin, DbAdminTarget } from '../src/services/dbprovision.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-clone-test-'));
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

/** Records what was asked of the engine, and can be made to fail one specific step. */
class FakeDbAdmin implements DbAdmin {
  created: { target: DbAdminTarget; name: string; user: string; password: string }[] = [];
  dropped: { name: string; user: string }[] = [];
  dumps: { target: DbAdminTarget; database: string }[] = [];
  imports: { target: DbAdminTarget; database: string; sql: string }[] = [];
  dumpError: Error | null = null;
  createError: Error | null = null;

  async createDatabase(target: DbAdminTarget, name: string, user: string, password: string): Promise<void> {
    if (this.createError) throw this.createError;
    this.created.push({ target, name, user, password });
  }

  async dropDatabase(_target: DbAdminTarget, name: string, user: string): Promise<void> {
    this.dropped.push({ name, user });
  }

  async testConnection(_target: DbAdminTarget): Promise<void> {}

  async importSql(target: DbAdminTarget, database: string, sqlPath: string): Promise<void> {
    this.imports.push({ target, database, sql: fs.readFileSync(sqlPath, 'utf8') });
  }

  async dumpSql(target: DbAdminTarget, database: string, sqlPath: string): Promise<void> {
    this.dumps.push({ target, database });
    if (this.dumpError) throw this.dumpError;
    fs.writeFileSync(sqlPath, `-- dump of ${database}\n`);
  }
}

interface TestApp {
  app: FastifyInstance;
  cookie: string;
  dbAdmin: FakeDbAdmin;
  deps: CloneDeps;
}

async function buildCloneTestApp(): Promise<TestApp> {
  const dataDir = tmpDataDir();
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir, SHIPWAY_APPS_DIR: path.join(dataDir, 'apps') });
  const dbAdmin = new FakeDbAdmin();
  const dns = new FakeDnsClient();
  const app = await buildApp(cfg, { sysops: new DevSysOps(path.join(dataDir, 'system')), dns: () => dns, dbAdmin });

  const cookie = sessionCookie(await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN }));
  await app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: { cookie },
    payload: { base_domain: 'apps.example.com', server_ip: '203.0.113.10' },
  });
  // Written straight into settings, exactly as install.sh's bootstrap does — it is not a key the
  // settings API accepts, since it carries the engine's admin password.
  setSetting(app.db, 'mysql_admin_url', LOCAL_MYSQL_ADMIN_URL);

  const deps: CloneDeps = { db: app.db, cfg: app.cfg, sysops: app.sysops, dns: app.dns(), dbAdmin: app.dbAdmin as FakeDbAdmin, secretBox: app.secretBox };
  return { app, cookie, dbAdmin, deps };
}

/** Creates a fully provisioned php source project, with a database, an env and a worker/cron seed. */
async function createSourceProject(app: FastifyInstance, cookie: string): Promise<{ id: number; databaseId: number }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie },
    payload: { name: 'Shop', slug: 'shop', repo: 'acme/shop', branch: 'main', type: 'php' },
  });
  if (created.statusCode !== 201) throw new Error(`source project failed: ${created.body}`);
  const id = created.json().id as number;

  const db = await app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: { cookie },
    payload: { engine: 'mysql', name: 'shop_db', projectId: id },
  });
  if (db.statusCode !== 201) throw new Error(`source database failed: ${db.body}`);
  const body = db.json() as { id: number; password: string };

  await app.inject({
    method: 'PUT',
    url: `/api/projects/${String(id)}/env`,
    headers: { cookie },
    payload: {
      content: [
        'APP_NAME=Shop',
        'APP_URL=https://shop.apps.example.com',
        'DB_DATABASE=shop_db',
        'DB_USERNAME=shop_db',
        `DB_PASSWORD=${body.password}`,
        `REPORTING_DB_PASSWORD="${body.password}"`,
        '# a comment survives',
        '',
      ].join('\n'),
    },
  });

  return { id, databaseId: body.id };
}

describe('cloneProject', () => {
  it('copies the project settings, env, workers, cron and notification recipients onto a new slug', async () => {
    const { app, cookie, deps } = await buildCloneTestApp();
    const source = await createSourceProject(app, cookie);
    app.db.insert(projectNotificationRecipients).values({ projectId: source.id, email: 'ops@example.com' }).run();

    const result = await cloneProject(deps, source.id, {
      name: 'Shop Staging',
      slug: 'shop-staging',
      databases: [{ sourceId: source.databaseId, name: 'shop_staging_db' }],
    });

    expect(result.project.slug).toBe('shop-staging');
    expect(result.project.name).toBe('Shop Staging');
    // Build/runtime settings come across verbatim — the clone deploys the same way the source does.
    const original = app.db.select().from(projects).where(eq(projects.id, source.id)).get();
    expect(result.project.repo).toBe(original?.repo);
    expect(result.project.branch).toBe(original?.branch);
    expect(result.project.type).toBe(original?.type);
    expect(result.project.phpVersion).toBe(original?.phpVersion);
    expect(result.project.installCmd).toBe(original?.installCmd);
    expect(result.project.postDeployScript).toBe(original?.postDeployScript);
    expect(result.project.sharedPaths).toEqual(original?.sharedPaths);

    // The Laravel seed gave the source one worker and one cron entry; both are on the clone.
    expect(result.workers).toBe(1);
    expect(result.cronJobs).toBe(1);
    expect(app.db.select().from(workers).where(eq(workers.projectId, result.project.id)).all()).toHaveLength(1);
    expect(app.db.select().from(cronJobs).where(eq(cronJobs.projectId, result.project.id)).all()).toHaveLength(1);
    expect(
      app.db.select().from(projectNotificationRecipients).where(eq(projectNotificationRecipients.projectId, result.project.id)).all(),
    ).toHaveLength(1);

    await app.close();
  });

  it("points the clone's env at the copied database and its own domain, leaving the source's env alone", async () => {
    const { app, cookie, deps } = await buildCloneTestApp();
    const source = await createSourceProject(app, cookie);
    const sourceEnvBefore = app.db.select().from(projects).where(eq(projects.id, source.id)).get()?.envEncrypted;

    const result = await cloneProject(deps, source.id, {
      name: 'Shop Staging',
      slug: 'shop-staging',
      databases: [{ sourceId: source.databaseId, name: 'shop_staging_db' }],
    });

    const cloneEnv = app.secretBox.decrypt(result.project.envEncrypted!);
    expect(cloneEnv).toContain('DB_DATABASE=shop_staging_db');
    expect(cloneEnv).toContain('DB_USERNAME=shop_staging_db');
    expect(cloneEnv).toContain('APP_URL=https://shop-staging.apps.example.com');
    // Nothing anywhere in the clone's env still names the source's database — that is the whole
    // safety property: a clone must never be a second app writing to the original's data.
    expect(cloneEnv).not.toContain('shop_db');
    // Including credentials that were copied under keys of the user's own choosing.
    const clonePassword = /^DB_PASSWORD=(.+)$/m.exec(cloneEnv)?.[1];
    expect(clonePassword).toBeTruthy();
    expect(cloneEnv).toContain(`REPORTING_DB_PASSWORD="${clonePassword!}"`);
    // Everything else survives untouched.
    expect(cloneEnv).toContain('APP_NAME=Shop');
    expect(cloneEnv).toContain('# a comment survives');

    // The source is exactly as it was.
    expect(app.db.select().from(projects).where(eq(projects.id, source.id)).get()?.envEncrypted).toEqual(sourceEnvBefore);

    await app.close();
  });

  it('creates the copy on the same server and moves the data across as the databases own users', async () => {
    const { app, cookie, deps, dbAdmin } = await buildCloneTestApp();
    const source = await createSourceProject(app, cookie);

    const result = await cloneProject(deps, source.id, {
      name: 'Shop Staging',
      slug: 'shop-staging',
      databases: [{ sourceId: source.databaseId, name: 'shop_staging_db' }],
    });

    expect(dbAdmin.created.map((call) => call.name)).toEqual(['shop_db', 'shop_staging_db']);
    // Dumped from the source, restored into the copy — each as the database's OWN user, never as
    // the server admin (a pg_dump replayed by the admin role leaves the app unable to read its
    // own tables).
    expect(dbAdmin.dumps).toHaveLength(1);
    expect(dbAdmin.dumps[0]?.database).toBe('shop_db');
    expect(dbAdmin.dumps[0]?.target.url).toContain('shop_db:');
    expect(dbAdmin.imports).toHaveLength(1);
    expect(dbAdmin.imports[0]?.database).toBe('shop_staging_db');
    expect(dbAdmin.imports[0]?.target.url).toContain('shop_staging_db:');
    expect(dbAdmin.imports[0]?.sql).toBe('-- dump of shop_db\n');

    const row = app.db.select().from(databases).where(eq(databases.name, 'shop_staging_db')).get();
    expect(row?.projectId).toBe(result.project.id);
    expect(row?.connectionId).toBeNull();
    expect(result.databases).toEqual([
      { sourceName: 'shop_db', name: 'shop_staging_db', engine: 'mysql', connectionName: expect.any(String), usedInEnv: true },
    ]);

    await app.close();
  });

  it('leaves nothing behind when the data copy fails', async () => {
    const { app, cookie, deps, dbAdmin } = await buildCloneTestApp();
    const source = await createSourceProject(app, cookie);
    dbAdmin.dumpError = new Error('Access denied for user');

    await expect(
      cloneProject(deps, source.id, { name: 'Shop Staging', slug: 'shop-staging', databases: [{ sourceId: source.databaseId, name: 'shop_staging_db' }] }),
    ).rejects.toThrow(/could not read shop_db/);

    // A clone that exists with the source's DB_* still in its env is the one outcome worth undoing
    // everything to avoid, so the project, its row and its half-made database are all gone.
    expect(app.db.select().from(projects).where(eq(projects.slug, 'shop-staging')).get()).toBeUndefined();
    expect(app.db.select().from(databases).where(eq(databases.name, 'shop_staging_db')).get()).toBeUndefined();
    expect(dbAdmin.dropped.map((call) => call.name)).toContain('shop_staging_db');
    // The source is untouched.
    expect(app.db.select().from(projects).where(eq(projects.id, source.id)).get()).toBeDefined();

    await app.close();
  });

  it('copies the shared directory but never the source .env inside it', async () => {
    const { app, cookie, deps } = await buildCloneTestApp();
    const source = await createSourceProject(app, cookie);
    const sharedDir = path.join(app.cfg.appsDir, 'shop', 'shared');
    fs.mkdirSync(path.join(sharedDir, 'storage'), { recursive: true });
    fs.writeFileSync(path.join(sharedDir, 'storage', 'upload.txt'), 'a user upload');
    fs.writeFileSync(path.join(sharedDir, '.env'), 'DB_PASSWORD=the-source-secret');

    const result = await cloneProject(deps, source.id, {
      name: 'Shop Staging',
      slug: 'shop-staging',
      databases: [{ sourceId: source.databaseId, name: 'shop_staging_db' }],
    });

    expect(result.sharedFilesCopied).toBe(true);
    const cloneShared = path.join(app.cfg.appsDir, 'shop-staging', 'shared');
    expect(fs.readFileSync(path.join(cloneShared, 'storage', 'upload.txt'), 'utf8')).toBe('a user upload');
    expect(fs.existsSync(path.join(cloneShared, '.env'))).toBe(false);

    await app.close();
  });

  it('refuses a taken slug, a foreign database, and a name already used on that server', async () => {
    const { app, cookie, deps } = await buildCloneTestApp();
    const source = await createSourceProject(app, cookie);

    await expect(cloneProject(deps, source.id, { name: 'x', slug: 'shop', databases: [] })).rejects.toThrow(/slug already in use/);

    await expect(
      cloneProject(deps, source.id, { name: 'x', slug: 'shop-staging', databases: [{ sourceId: 9999, name: 'other_db' }] }),
    ).rejects.toThrow(/does not belong to this project/);

    await expect(
      cloneProject(deps, source.id, { name: 'x', slug: 'shop-staging', databases: [{ sourceId: source.databaseId, name: 'shop_db' }] }),
    ).rejects.toThrow(/already exists on/);

    // Every one of those is refused before anything is created.
    expect(app.db.select().from(projects).where(eq(projects.slug, 'shop-staging')).get()).toBeUndefined();

    await app.close();
  });

  it('reports the failing step so the route can pick a status code', async () => {
    const { app, cookie, deps } = await buildCloneTestApp();
    const source = await createSourceProject(app, cookie);

    const err = await cloneProject(deps, source.id, { name: 'x', slug: 'shop', databases: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloneError);
    expect((err as CloneError).step).toBe('slug');

    await app.close();
  });

  it('clones a project with no databases at all', async () => {
    const { app, cookie, deps, dbAdmin } = await buildCloneTestApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name: 'Site', slug: 'site', repo: 'acme/site', branch: 'main', type: 'static' },
    });
    const sourceId = created.json().id as number;

    const result = await cloneProject(deps, sourceId, { name: 'Site Copy', slug: 'site-copy', databases: [] });

    expect(result.databases).toEqual([]);
    expect(dbAdmin.created).toEqual([]);
    expect(result.project.slug).toBe('site-copy');

    await app.close();
  });
});

describe('POST /api/projects/:id/clone', () => {
  it('creates the clone, records the audit event and reports what came across (201)', async () => {
    const { app, cookie } = await buildCloneTestApp();
    const source = await createSourceProject(app, cookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${String(source.id)}/clone`,
      headers: { cookie },
      payload: { name: 'Shop Staging', slug: 'shop-staging', databases: [{ sourceId: source.databaseId, name: 'shop_staging_db' }] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ slug: 'shop-staging', name: 'Shop Staging', type: 'php', workers: 1, cronJobs: 1 });
    expect(body.databases).toEqual([{ sourceName: 'shop_db', name: 'shop_staging_db', engine: 'mysql', connectionName: 'MySQL on this server', usedInEnv: true }]);
    // The encrypted blobs never leave the server, same as every other project response.
    expect(body.envEncrypted).toBeUndefined();
    expect(body.authHash).toBeUndefined();

    const audit = app.db.select().from(auditEvents).all().find((row) => row.action === 'project.clone');
    expect(audit?.targetName).toBe('shop-staging');
    // The audit names where it came from and what was created — the two things someone reading the
    // trail later needs to reconstruct a clone.
    expect(audit?.meta).toContain('"source":"shop"');
    expect(audit?.meta).toContain('shop_staging_db');

    await app.close();
  });

  it('refuses a slug that is taken or reserved (409) and an unknown project (404)', async () => {
    const { app, cookie } = await buildCloneTestApp();
    const source = await createSourceProject(app, cookie);

    const taken = await app.inject({
      method: 'POST',
      url: `/api/projects/${String(source.id)}/clone`,
      headers: { cookie },
      payload: { name: 'x', slug: 'shop', databases: [] },
    });
    expect(taken.statusCode).toBe(409);

    const reserved = await app.inject({
      method: 'POST',
      url: `/api/projects/${String(source.id)}/clone`,
      headers: { cookie },
      payload: { name: 'x', slug: 'mailpit', databases: [] },
    });
    expect(reserved.statusCode).toBe(409);
    expect(reserved.json()).toEqual({ error: 'this name is reserved' });

    const missing = await app.inject({ method: 'POST', url: '/api/projects/9999/clone', headers: { cookie }, payload: { name: 'x', slug: 'nope' } });
    expect(missing.statusCode).toBe(404);

    await app.close();
  });

  it('reports a failed data copy as a 502 naming the step, with no clone left behind', async () => {
    const { app, cookie, dbAdmin } = await buildCloneTestApp();
    const source = await createSourceProject(app, cookie);
    dbAdmin.dumpError = new Error('Access denied for user');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${String(source.id)}/clone`,
      headers: { cookie },
      payload: { name: 'Shop Staging', slug: 'shop-staging', databases: [{ sourceId: source.databaseId, name: 'shop_staging_db' }] },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'clone failed', step: 'copy' });
    expect(app.db.select().from(projects).where(eq(projects.slug, 'shop-staging')).get()).toBeUndefined();

    await app.close();
  });

  it('rejects a body without a valid subdomain (400)', async () => {
    const { app, cookie } = await buildCloneTestApp();
    const source = await createSourceProject(app, cookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${String(source.id)}/clone`,
      headers: { cookie },
      payload: { name: 'Shop Staging', slug: 'Not A Slug' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });
});

describe('rewriteEnvValues', () => {
  it('replaces whole values only, never a value that merely contains one', () => {
    const text = ['DB_DATABASE=app', 'APP_NAME=app store', 'APP_URL=https://app.example.com', 'OTHER=notapp'].join('\n');

    expect(rewriteEnvValues(text, new Map([['app', 'app_copy']]))).toBe(
      ['DB_DATABASE=app_copy', 'APP_NAME=app store', 'APP_URL=https://app.example.com', 'OTHER=notapp'].join('\n'),
    );
  });

  it('keeps the quoting style of the value it rewrites, and leaves comments and blanks alone', () => {
    const text = ['# comment', '', 'DB_PASSWORD="s3cret"', "OTHER='s3cret'"].join('\n');

    expect(rewriteEnvValues(text, new Map([['s3cret', 'new-one']]))).toBe(['# comment', '', 'DB_PASSWORD="new-one"', "OTHER='new-one'"].join('\n'));
  });

  it('never rewrites an empty value into a credential', () => {
    expect(rewriteEnvValues('DB_PASSWORD=', new Map([['', 'oops']]))).toBe('DB_PASSWORD=');
  });
});

describe('rewriteEnvDomain', () => {
  it('moves every mention of the project domain, wherever it appears in a value', () => {
    const text = ['APP_URL=https://shop.apps.example.com', 'SESSION_DOMAIN=.shop.apps.example.com', 'MAIL_FROM=hi@example.com'].join('\n');

    expect(rewriteEnvDomain(text, 'shop.apps.example.com', 'shop-staging.apps.example.com')).toBe(
      ['APP_URL=https://shop-staging.apps.example.com', 'SESSION_DOMAIN=.shop-staging.apps.example.com', 'MAIL_FROM=hi@example.com'].join('\n'),
    );
  });
});
