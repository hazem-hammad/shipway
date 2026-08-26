/**
 * Confirms `recordAudit` is actually wired into route handlers (not just unit-tested in isolation —
 * see `audit.test.ts`): at least one route per mutating "family" from the plan (project, deploy,
 * worker, cron, database, settings, github, user, auth) leaves a row with the right actor/action/
 * target, the webhook-triggered deploy path records `actorName: 'github'`, and `settings.update`'s
 * `meta` carries only the changed KEYS — never the submitted values (secrets like cloudflare_token).
 */
import { createHmac } from 'node:crypto';
import * as path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { auditEvents } from '../src/db/schema.js';
import { setSetting } from '../src/db/settings.js';
import type { DeployQueueDeps } from '../src/deploy/queue.js';
import { FakeDnsClient } from '../src/services/cloudflare.js';
import type { DbAdmin, DbAdminTarget } from '../src/services/dbprovision.js';
import { DevSysOps } from '../src/sysops/dev.js';
import { buildOwnerApp, createAdmin, createMember, tmpDataDir } from './helpers.js';

/** The most recently inserted audit row, or `undefined` if none exist. */
function latestAudit(app: FastifyInstance) {
  return app.db.select().from(auditEvents).orderBy(desc(auditEvents.id)).limit(1).get();
}

function auditRowsFor(app: FastifyInstance, action: string) {
  return app.db.select().from(auditEvents).where(eq(auditEvents.action, action)).all();
}

class FakeRun {
  readonly calls: number[] = [];
  run: DeployQueueDeps['run'] = async (deploymentId) => {
    this.calls.push(deploymentId);
  };
}

class NoopDbAdmin implements DbAdmin {
  async createDatabase(_target: DbAdminTarget, _name: string, _user: string, _password: string): Promise<void> {}
  async dropDatabase(_target: DbAdminTarget, _name: string, _user: string): Promise<void> {}
  async testConnection(_target: DbAdminTarget): Promise<void> {}
}

async function buildProvisioningApp(opts: { dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? tmpDataDir();
  const sysops = new DevSysOps(path.join(dataDir, 'system'));
  const dns = new FakeDnsClient();
  const fakeRun = new FakeRun();
  const dbAdmin = new NoopDbAdmin();
  const { app, cookie: ownerCookie, userId: ownerId } = await buildOwnerApp({ sysops, dns: () => dns, queueRun: fakeRun.run, dbAdmin });

  await app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: { cookie: ownerCookie },
    payload: { base_domain: 'apps.example.com', server_ip: '203.0.113.10' },
  });

  return { app, ownerCookie, ownerId, fakeRun, dataDir };
}

async function createStaticProject(app: FastifyInstance, cookie: string, slug = 'my-app'): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie },
    payload: { name: slug, slug, repo: 'acme/my-app', branch: 'main', type: 'static', autoDeploy: true },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: number }).id;
}

describe('audit wiring — one route per family', () => {
  it('project.create records the creating user as actor and the slug as target', async () => {
    const { app, ownerCookie, ownerId } = await buildProvisioningApp();

    const id = await createStaticProject(app, ownerCookie, 'shop');

    const row = latestAudit(app);
    expect(row).toMatchObject({ actorId: ownerId, action: 'project.create', targetType: 'project', targetName: 'shop' });
    void id;

    await app.close();
  });

  it('project.delete records an audit row (admin-gated route)', async () => {
    const { app, ownerCookie } = await buildProvisioningApp();
    const { cookie: adminCookie, userId: adminId } = await createAdmin(app);
    const id = await createStaticProject(app, ownerCookie, 'to-delete');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}`,
      headers: { cookie: adminCookie },
      payload: { confirmName: 'to-delete' },
    });
    expect(del.statusCode).toBe(204);

    const row = latestAudit(app);
    expect(row).toMatchObject({ actorId: adminId, action: 'project.delete', targetType: 'project', targetName: 'to-delete' });

    await app.close();
  });

  it('deploy.trigger records the calling user as actor when triggered via the API', async () => {
    const { app, ownerCookie, ownerId } = await buildProvisioningApp();
    const id = await createStaticProject(app, ownerCookie, 'deploy-me');

    const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/deploy`, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(202);

    const row = latestAudit(app);
    expect(row).toMatchObject({ actorId: ownerId, action: 'deploy.trigger', targetType: 'project', targetName: 'deploy-me' });

    await app.close();
  });

  it('deploy.trigger via a GitHub webhook push records actorName "github" with no actorId', async () => {
    const WEBHOOK_SECRET = 'top-secret-webhook-key';
    const { app, ownerCookie } = await buildProvisioningApp();
    setSetting(app.db, 'github_app', { appId: 1, privateKey: 'pem', webhookSecret: WEBHOOK_SECRET });
    // createStaticProject always creates repo 'acme/my-app' on branch 'main' with autoDeploy on —
    // matches the push payload below, so it actually triggers a deploy.
    await createStaticProject(app, ownerCookie, 'webhook-app');

    const payload = {
      ref: 'refs/heads/main',
      after: 'a'.repeat(40),
      repository: { full_name: 'acme/my-app' },
      head_commit: { message: 'fix things' },
    };
    const raw = JSON.stringify(payload);
    const header = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')}`;

    const res: LightMyRequestResponse = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': header },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { deployed: number[] }).deployed.length).toBeGreaterThan(0);

    const rows = auditRowsFor(app, 'deploy.trigger').filter((r) => r.actorName === 'github');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.actorId).toBeNull();

    await app.close();
  });

  it('worker.create records an audit row', async () => {
    const { app, ownerCookie, ownerId } = await buildProvisioningApp();
    const id = await createStaticProject(app, ownerCookie, 'worker-app');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/workers`,
      headers: { cookie: ownerCookie },
      payload: { name: 'queue', command: 'php artisan queue:work', processes: 1 },
    });
    expect(res.statusCode).toBe(201);

    const row = latestAudit(app);
    expect(row).toMatchObject({ actorId: ownerId, action: 'worker.create', targetType: 'worker', targetName: 'queue' });

    await app.close();
  });

  it('cron.create records an audit row', async () => {
    const { app, ownerCookie, ownerId } = await buildProvisioningApp();
    const id = await createStaticProject(app, ownerCookie, 'cron-app');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/cron`,
      headers: { cookie: ownerCookie },
      payload: { schedule: '* * * * *', command: 'php artisan schedule:run' },
    });
    expect(res.statusCode).toBe(201);

    const row = latestAudit(app);
    expect(row).toMatchObject({ actorId: ownerId, action: 'cron.create', targetType: 'cron' });

    await app.close();
  });

  it('database.create records an audit row', async () => {
    const { app, ownerCookie, ownerId } = await buildProvisioningApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie: ownerCookie },
      payload: { engine: 'mysql', name: 'shop_db' },
    });
    expect(res.statusCode).toBe(201);

    const row = latestAudit(app);
    expect(row).toMatchObject({ actorId: ownerId, action: 'database.create', targetType: 'database', targetName: 'shop_db' });

    await app.close();
  });

  it('settings.update records only the changed KEYS in meta, never the submitted values', async () => {
    const { app, ownerCookie, ownerId } = await buildProvisioningApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: ownerCookie },
      payload: { cloudflare_token: 'super-secret-cf-token-should-never-leak', acme_email: 'ops@example.com' },
    });
    expect(res.statusCode).toBe(200);

    const row = latestAudit(app);
    expect(row).toMatchObject({ actorId: ownerId, action: 'settings.update', targetType: 'settings' });
    expect(row?.meta).toBeTruthy();
    const meta = JSON.parse(row!.meta!) as { keys: string[] };
    expect(meta.keys.sort()).toEqual(['acme_email', 'cloudflare_token'].sort());
    expect(row!.meta).not.toContain('super-secret-cf-token-should-never-leak');
    expect(row!.meta).not.toContain('ops@example.com');

    await app.close();
  });

  it('github.configure records an audit row for PUT /api/github/app', async () => {
    const { app, ownerCookie, ownerId } = await buildProvisioningApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/github/app',
      headers: { cookie: ownerCookie },
      payload: { appId: 123456, privateKey: 'pem', webhookSecret: 'whsec' },
    });
    expect(res.statusCode).toBe(200);

    const row = latestAudit(app);
    expect(row).toMatchObject({ actorId: ownerId, action: 'github.configure' });

    await app.close();
  });

  it('user.create and user.delete both record audit rows', async () => {
    const { app, ownerCookie, ownerId } = await buildProvisioningApp();

    const create = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: ownerCookie },
      payload: { name: 'Grace Hopper', email: 'grace@example.com', password: 'admiral-password' },
    });
    expect(create.statusCode).toBe(201);
    const createRow = latestAudit(app);
    expect(createRow).toMatchObject({ actorId: ownerId, action: 'user.create', targetType: 'user', targetName: 'grace@example.com' });

    const newId = (create.json() as { id: number }).id;
    const del = await app.inject({ method: 'DELETE', url: `/api/users/${newId}`, headers: { cookie: ownerCookie } });
    expect(del.statusCode).toBe(204);
    const deleteRow = latestAudit(app);
    expect(deleteRow).toMatchObject({ actorId: ownerId, action: 'user.delete', targetType: 'user', targetName: 'grace@example.com' });

    await app.close();
  });

  it('auth.login_failed records the attempted email as actorName, for both a wrong password and an unknown email', async () => {
    const { app, ownerCookie } = await buildProvisioningApp();
    void ownerCookie;

    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ada@example.com', password: 'totally-wrong' },
    });
    const wrongPasswordRow = latestAudit(app);
    expect(wrongPasswordRow).toMatchObject({ action: 'auth.login_failed', actorName: 'ada@example.com' });

    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: 'whatever' },
    });
    const unknownEmailRow = latestAudit(app);
    expect(unknownEmailRow).toMatchObject({ action: 'auth.login_failed', actorName: 'nobody@example.com' });

    await app.close();
  });

  it('a successful login does NOT record auth.login_failed', async () => {
    const { app, ownerCookie } = await buildProvisioningApp();
    void ownerCookie;

    const before = auditRowsFor(app, 'auth.login_failed').length;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ada@example.com', password: 'correct-horse-battery' },
    });
    expect(res.statusCode).toBe(200);

    expect(auditRowsFor(app, 'auth.login_failed').length).toBe(before);

    await app.close();
  });
});

describe('recordAudit respects role gates: a member 403 never leaves an audit row for the gated action', () => {
  it('a member blocked from PUT /api/settings does not produce a settings.update row', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: memberCookie },
      payload: { acme_email: 'blocked@example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(auditRowsFor(app, 'settings.update')).toHaveLength(0);

    await app.close();
  });
});
