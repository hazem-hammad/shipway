/**
 * Task 4's boot migration (app.ts, `migrateLegacyWebhookChannel`): if the legacy global
 * `notify_webhook_url` setting is already set (e.g. a v1 install upgrading) and no notification
 * channel exists yet, a "Default" channel is created on boot, subscribed to `deploy_failed` (and
 * `deploy_succeeded` too when the legacy `notify_on_success` setting was `true`), with an audit row
 * recorded (actor 'system'). The migration then clears the legacy `notify_webhook_url` setting so
 * `deploynotify.ts`'s global fallback no longer fires alongside the new channel (final-review.md
 * finding I-1 — before this fix an upgraded install posted twice per event to the same URL). Runs
 * unconditionally on every `buildApp()` call but is naturally idempotent — it only ever fires once
 * per db, since after it runs either a channel already exists or the legacy setting is gone.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import type { ShipwayDb } from '../src/db/index.js';
import { auditEvents, deployments, notificationChannels, notificationSubscriptions, projects } from '../src/db/schema.js';
import { getSetting } from '../src/db/settings.js';
import { notifyDeployTerminal } from '../src/services/deploynotify.js';
import { DevSysOps } from '../src/sysops/dev.js';

interface RecordedCall {
  url: string;
}

function fakeFetch(): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: Parameters<typeof fetch>[0]) => {
    calls.push({ url: input.toString() });
    return Promise.resolve({ ok: true, status: 200 } as Response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function insertProject(db: ShipwayDb, slug: string): number {
  db.insert(projects).values({ name: slug, slug, repo: `acme/${slug}`, branch: 'main', type: 'static' }).run();
  const row = db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get();
  if (!row) throw new Error('failed to insert test project');
  return row.id;
}

function insertDeployment(db: ShipwayDb, projectId: number): number {
  db.insert(deployments).values({ projectId, status: 'running', trigger: 'push' }).run();
  const rows = db.select({ id: deployments.id }).from(deployments).where(eq(deployments.projectId, projectId)).all();
  const last = rows[rows.length - 1];
  if (!last) throw new Error('failed to insert test deployment');
  return last.id;
}

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-notify-migration-test-'));
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') {
    throw new Error('expected a set-cookie header in the response');
  }
  return value.split(';')[0]!;
}

const ADMIN = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct-horse-battery' };

describe('boot migration: legacy notify_webhook_url -> "Default" channel', () => {
  it('creates a Default channel subscribed to deploy_failed, with a system audit row, the first time it sees a legacy webhook url', async () => {
    const dataDir = tmpDataDir();
    const cfg: Config = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });

    // First boot: no notify_webhook_url set yet — migration is a no-op.
    const app1 = await buildApp(cfg, { sysops: new DevSysOps(path.join(dataDir, 'system')) });
    const create = await app1.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
    const cookie = sessionCookie(create);
    await app1.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { notify_webhook_url: 'https://hooks.slack.com/services/legacy' },
    });
    expect(app1.db.select().from(notificationChannels).all()).toHaveLength(0);
    await app1.close();

    // Second boot (same db): notify_webhook_url is now set and no channel exists — migration fires.
    const app2 = await buildApp(cfg, { sysops: new DevSysOps(path.join(dataDir, 'system')) });

    const channels = app2.db.select().from(notificationChannels).all();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ name: 'Default', url: 'https://hooks.slack.com/services/legacy' });

    const subs = app2.db.select().from(notificationSubscriptions).where(eq(notificationSubscriptions.channelId, channels[0]!.id)).all();
    expect(subs.map((s) => s.event)).toEqual(['deploy_failed']);

    const auditRows = app2.db.select().from(auditEvents).all();
    const migrationRow = auditRows.find((r) => r.action === 'notification.migrated');
    expect(migrationRow).toBeDefined();
    expect(migrationRow?.actorName).toBe('system');
    expect(migrationRow?.actorId).toBeNull();

    // I-1 fix: the legacy setting must be gone so deploynotify.ts's global fallback no longer fires.
    expect(getSetting(app2.db, 'notify_webhook_url')).toBeNull();

    // A subsequent deploy failure must post exactly ONCE — via the bus channel, not the (now-gone)
    // legacy path — to the same URL that used to receive both a legacy and a bus post.
    const projectId = insertProject(app2.db, 'shop');
    const deploymentId = insertDeployment(app2.db, projectId);
    const { fetchImpl, calls } = fakeFetch();
    await notifyDeployTerminal(app2.db, fetchImpl, { project: 'shop', status: 'failed', deploymentId, message: 'build failed' });
    const postsToLegacyUrl = calls.filter((c) => c.url === 'https://hooks.slack.com/services/legacy');
    expect(postsToLegacyUrl).toHaveLength(1);

    await app2.close();

    // Third boot (same db): a channel already exists — migration must not create a second one, and
    // must not recreate/duplicate the (already-cleared) legacy setting or its subscriptions.
    const app3 = await buildApp(cfg, { sysops: new DevSysOps(path.join(dataDir, 'system')) });
    expect(app3.db.select().from(notificationChannels).all()).toHaveLength(1);
    expect(getSetting(app3.db, 'notify_webhook_url')).toBeNull();
    const subsAfterReboot = app3.db.select().from(notificationSubscriptions).where(eq(notificationSubscriptions.channelId, channels[0]!.id)).all();
    expect(subsAfterReboot.map((s) => s.event)).toEqual(['deploy_failed']);
    await app3.close();
  });

  it('also subscribes Default to deploy_succeeded when the legacy notify_on_success setting was true', async () => {
    const dataDir = tmpDataDir();
    const cfg: Config = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });

    const app1 = await buildApp(cfg, { sysops: new DevSysOps(path.join(dataDir, 'system')) });
    const create = await app1.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
    const cookie = sessionCookie(create);
    await app1.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { notify_webhook_url: 'https://hooks.slack.com/services/legacy-success', notify_on_success: true },
    });
    await app1.close();

    const app2 = await buildApp(cfg, { sysops: new DevSysOps(path.join(dataDir, 'system')) });
    const channels = app2.db.select().from(notificationChannels).all();
    expect(channels).toHaveLength(1);

    const subs = app2.db.select().from(notificationSubscriptions).where(eq(notificationSubscriptions.channelId, channels[0]!.id)).all();
    expect(subs.map((s) => s.event).sort()).toEqual(['deploy_failed', 'deploy_succeeded']);

    expect(getSetting(app2.db, 'notify_webhook_url')).toBeNull();

    await app2.close();
  });

  it('does nothing on a fresh db with no notify_webhook_url configured', async () => {
    const cfg: Config = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { sysops: new DevSysOps(path.join(cfg.dataDir, 'system')) });

    expect(app.db.select().from(notificationChannels).all()).toHaveLength(0);

    await app.close();
  });

  it('does not overwrite/duplicate a channel a user already created by hand, even if notify_webhook_url is also set', async () => {
    const dataDir = tmpDataDir();
    const cfg: Config = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });

    const app1 = await buildApp(cfg, { sysops: new DevSysOps(path.join(dataDir, 'system')) });
    const create = await app1.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
    const cookie = sessionCookie(create);
    await app1.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { notify_webhook_url: 'https://hooks.slack.com/services/legacy' },
    });
    await app1.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'hand-made', url: 'https://hooks.slack.com/services/hand-made' },
    });
    await app1.close();

    const app2 = await buildApp(cfg, { sysops: new DevSysOps(path.join(dataDir, 'system')) });
    const channels = app2.db.select().from(notificationChannels).all();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.name).toBe('hand-made');

    await app2.close();
  });
});
