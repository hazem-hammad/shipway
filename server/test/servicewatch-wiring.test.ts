/**
 * app.ts's wiring of Task 4's service-status poller: disabled entirely under `NODE_ENV=test`
 * (vitest's default) unless a test explicitly injects `deps.serviceWatch`; when injected, it reaches
 * the real db/sysops/notifications-routes end to end, and `app.close()` stops it via an `onClose`
 * hook, leaving no open interval handle behind — otherwise a leaked `setInterval` would keep the
 * process (and vitest) alive after the test finishes. That every test in this whole suite exits
 * cleanly (see the end of a full `vitest run`) is itself the proof; the assertions below additionally
 * pin down the on/off wiring directly.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { auditEvents } from '../src/db/schema.js';
import { DevSysOps } from '../src/sysops/dev.js';
import type { UnitStatus } from '../src/sysops/types.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-servicewatch-wiring-test-'));
}

/** A `SysOps` double whose `systemUnitStatus` returns a freely-mutable per-unit status (default
 * `'active'`), same shape as servicewatch.test.ts's own double — here used to prove app.ts's wiring
 * (real db, real `notificationRoutes`-created subscription) reaches the real `startServiceWatch`. */
class MutableStatusSysOps extends DevSysOps {
  private readonly statuses = new Map<string, UnitStatus>();

  setStatus(unit: string, status: UnitStatus): void {
    this.statuses.set(unit, status);
  }

  override async systemUnitStatus(unit: string): Promise<UnitStatus> {
    return this.statuses.get(unit) ?? 'active';
  }
}

const ADMIN = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct-horse-battery' };

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') {
    throw new Error('expected a set-cookie header in the response');
  }
  return value.split(';')[0]!;
}

describe('app.ts service-watch wiring', () => {
  it('does not start the poller under NODE_ENV=test unless deps.serviceWatch is injected', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { sysops: new DevSysOps(path.join(cfg.dataDir, 'system')) });

    expect(app.serviceWatch).toBeUndefined();

    await app.close();
  });

  it('when injected, reaches the real db/sysops/subscribed channel end to end: seeds silently, then emits on a genuine transition', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const sysops = new MutableStatusSysOps(path.join(cfg.dataDir, 'system'));
    const calls: string[] = [];
    const fetchImpl = ((input: Parameters<typeof fetch>[0]) => {
      calls.push(input.toString());
      return Promise.resolve({ ok: true, status: 200 } as Response);
    }) as typeof fetch;

    const app = await buildApp(cfg, {
      sysops,
      // A real (huge) interval — never fires on its own during the test; `.tick()` drives it instead.
      serviceWatch: { intervalMs: 24 * 60 * 60 * 1000, fetchImpl },
    });
    expect(app.serviceWatch).toBeDefined();

    const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
    const cookie = sessionCookie(create);
    const channelRes = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops', url: 'https://hooks.slack.com/services/aaa' },
    });
    const channelId = (channelRes.json() as { id: number }).id;
    await app.inject({
      method: 'PUT',
      url: '/api/notifications/subscriptions',
      headers: { cookie },
      payload: { event: 'service_down', channelId, enabled: true },
    });

    await app.serviceWatch!.tick(); // seed: nginx active, silent
    expect(calls).toHaveLength(0);

    sysops.setStatus('nginx', 'failed');
    await app.serviceWatch!.tick(); // transition: emits through the real subscribed channel

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('https://hooks.slack.com/services/aaa');
    const downAudits = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'service.down')).all();
    expect(downAudits).toHaveLength(1);

    await app.close();
  });

  it('app.close() stops the injected poller (onClose hook): no further automatic tick fires afterward', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const sysops = new MutableStatusSysOps(path.join(cfg.dataDir, 'system'));
    const calls: string[] = [];
    const fetchImpl = ((input: Parameters<typeof fetch>[0]) => {
      calls.push(input.toString());
      return Promise.resolve({ ok: true, status: 200 } as Response);
    }) as typeof fetch;

    const app = await buildApp(cfg, { sysops, serviceWatch: { intervalMs: 5, fetchImpl } });
    expect(app.serviceWatch).toBeDefined();

    const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
    const cookie = sessionCookie(create);
    const channelRes = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops', url: 'https://hooks.slack.com/services/aaa' },
    });
    const channelId = (channelRes.json() as { id: number }).id;
    await app.inject({
      method: 'PUT',
      url: '/api/notifications/subscriptions',
      headers: { cookie },
      payload: { event: 'service_down', channelId, enabled: true },
    });

    // Let a few automatic (real, short-interval) ticks happen, seeding state (still active, silent).
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(0);

    await app.close();

    // If `onClose` had NOT called `.stop()`, the interval would keep firing: flipping the unit down
    // now and waiting would pick it up on the next automatic tick and produce a call. With the
    // interval genuinely cleared, no more ticks ever run, so this must stay at 0 forever.
    sysops.setStatus('nginx', 'failed');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(0);
  });
});
