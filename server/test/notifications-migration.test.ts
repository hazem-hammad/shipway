/**
 * Task 4's boot migration (app.ts, `migrateLegacyWebhookChannel`): if the legacy global
 * `notify_webhook_url` setting is already set (e.g. a v1 install upgrading) and no notification
 * channel exists yet, a "Default" channel is created on boot, subscribed to `deploy_failed`, with an
 * audit row recorded (actor 'system'). Runs unconditionally on every `buildApp()` call but is
 * naturally idempotent — it only ever fires once per db, since after it runs a channel exists.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { auditEvents, notificationChannels, notificationSubscriptions } from '../src/db/schema.js';
import { DevSysOps } from '../src/sysops/dev.js';

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

    await app2.close();

    // Third boot (same db): a channel already exists — migration must not create a second one.
    const app3 = await buildApp(cfg, { sysops: new DevSysOps(path.join(dataDir, 'system')) });
    expect(app3.db.select().from(notificationChannels).all()).toHaveLength(1);
    await app3.close();
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
