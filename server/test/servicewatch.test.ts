/**
 * Task 4's service-status poller: diffs `SYSTEM_UNITS` status against an in-memory map every
 * interval, emitting `service_down`/`service_recovered` bus events + audit rows on a genuine
 * transition only. The first observation for a unit just seeds the map (no event) — otherwise every
 * fresh boot would fire a burst of "recovered" events for services nobody has polled before.
 *
 * `intervalMs` is set huge in every test below and `.tick()` is called manually — real timers are
 * never relied on, so this file has no flakiness from timing and no risk of a leaked interval
 * hanging vitest (every test still calls `.stop()`, proven separately in the "real interval" test).
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { auditEvents, notificationChannels, notificationSubscriptions } from '../src/db/schema.js';
import { DevSysOps } from '../src/sysops/dev.js';
import type { UnitStatus } from '../src/sysops/types.js';
import { startServiceWatch } from '../src/services/servicewatch.js';

const NEVER_FIRES_MS = 24 * 60 * 60 * 1000; // 24h — long enough that no test ever hits a real tick

function tmpDb(): ShipwayDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-servicewatch-test-'));
  return openDb(path.join(dir, 'shipway.db'));
}

function insertChannel(db: ShipwayDb, name: string, url: string): number {
  db.insert(notificationChannels).values({ name, url }).run();
  const row = db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.name, name)).get();
  if (!row) throw new Error('failed to insert test channel');
  return row.id;
}

function subscribe(db: ShipwayDb, event: string, channelId: number): void {
  db.insert(notificationSubscriptions).values({ event, channelId }).run();
}

/** A `SysOps` double whose `systemUnitStatus` returns a per-unit, freely-mutable status (default
 * `'active'`), so tests can drive down/recovered transitions deterministically. */
class FakeStatusSysOps extends DevSysOps {
  private readonly statuses = new Map<string, UnitStatus>();

  setStatus(unit: string, status: UnitStatus): void {
    this.statuses.set(unit, status);
  }

  override async systemUnitStatus(unit: string): Promise<UnitStatus> {
    return this.statuses.get(unit) ?? 'active';
  }
}

interface RecordedCall {
  url: string;
  body: string;
}

function fakeFetch(): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: input.toString(), body: (init?.body as string) ?? '' });
    return Promise.resolve({ ok: true, status: 200 } as Response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function sysopsRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-servicewatch-sysops-'));
}

describe('startServiceWatch', () => {
  it('seeds state on the first tick without emitting any events or audit rows', async () => {
    const db = tmpDb();
    const channelId = insertChannel(db, 'ops', 'https://hooks.slack.com/services/aaa');
    subscribe(db, 'service_down', channelId);
    subscribe(db, 'service_recovered', channelId);
    const sysops = new FakeStatusSysOps(sysopsRoot());
    sysops.setStatus('nginx', 'failed'); // already down at "boot" — must NOT fire on first observation
    const { fetchImpl, calls } = fakeFetch();

    const watch = startServiceWatch({ db, sysops, intervalMs: NEVER_FIRES_MS, fetchImpl });
    await watch.tick();
    watch.stop();

    expect(calls).toHaveLength(0);
    expect(db.select().from(auditEvents).all()).toHaveLength(0);
  });

  it('active -> down emits service_down exactly once, not again on an unchanged following tick', async () => {
    const db = tmpDb();
    const channelId = insertChannel(db, 'ops', 'https://hooks.slack.com/services/aaa');
    subscribe(db, 'service_down', channelId);
    const sysops = new FakeStatusSysOps(sysopsRoot());
    const { fetchImpl, calls } = fakeFetch();
    const watch = startServiceWatch({ db, sysops, intervalMs: NEVER_FIRES_MS, fetchImpl });

    await watch.tick(); // seed: nginx active, silent

    sysops.setStatus('nginx', 'failed');
    await watch.tick(); // transition: active -> down

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]?.body ?? '{}') as { text: string };
    expect(body.text).toContain('Service down');
    expect(body.text).toContain('nginx');
    expect(body.text).toContain('failed');

    const downAudits = db.select().from(auditEvents).where(eq(auditEvents.action, 'service.down')).all();
    expect(downAudits).toHaveLength(1);
    expect(downAudits[0]?.actorName).toBe('system');
    expect(downAudits[0]?.targetName).toBe('nginx');

    await watch.tick(); // still failed: no repeat
    expect(calls).toHaveLength(1);
    expect(db.select().from(auditEvents).where(eq(auditEvents.action, 'service.down')).all()).toHaveLength(1);

    watch.stop();
  });

  it('down -> active emits service_recovered exactly once, not again on an unchanged following tick', async () => {
    const db = tmpDb();
    const channelId = insertChannel(db, 'ops', 'https://hooks.slack.com/services/aaa');
    subscribe(db, 'service_down', channelId);
    subscribe(db, 'service_recovered', channelId);
    const sysops = new FakeStatusSysOps(sysopsRoot());
    const { fetchImpl, calls } = fakeFetch();
    const watch = startServiceWatch({ db, sysops, intervalMs: NEVER_FIRES_MS, fetchImpl });

    await watch.tick(); // seed: active, silent
    sysops.setStatus('nginx', 'inactive');
    await watch.tick(); // down transition
    expect(calls).toHaveLength(1);

    sysops.setStatus('nginx', 'active');
    await watch.tick(); // recovered transition

    expect(calls).toHaveLength(2);
    const body = JSON.parse(calls[1]?.body ?? '{}') as { text: string };
    expect(body.text).toContain('Service recovered');

    const recoveredAudits = db.select().from(auditEvents).where(eq(auditEvents.action, 'service.recovered')).all();
    expect(recoveredAudits).toHaveLength(1);

    await watch.tick(); // still active: no repeat
    expect(calls).toHaveLength(2);
    expect(db.select().from(auditEvents).where(eq(auditEvents.action, 'service.recovered')).all()).toHaveLength(1);

    watch.stop();
  });

  it("treats both 'failed' and 'inactive' as down (either counts as a down transition, and recovering from either fires service_recovered)", async () => {
    const db = tmpDb();
    const channelId = insertChannel(db, 'ops', 'https://hooks.slack.com/services/aaa');
    subscribe(db, 'service_down', channelId);
    subscribe(db, 'service_recovered', channelId);
    const sysops = new FakeStatusSysOps(sysopsRoot());
    const { fetchImpl, calls } = fakeFetch();
    const watch = startServiceWatch({ db, sysops, intervalMs: NEVER_FIRES_MS, fetchImpl });

    await watch.tick(); // seed active
    sysops.setStatus('mysql', 'inactive');
    await watch.tick();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? '{}').text as string).toContain('Service down');

    sysops.setStatus('mysql', 'active');
    await watch.tick();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]?.body ?? '{}').text as string).toContain('Service recovered');

    watch.stop();
  });

  it('does not treat "unknown" as a transition either way (DevSysOps-style default, e.g. real deploys before the sysops helper is fully wired)', async () => {
    const db = tmpDb();
    const channelId = insertChannel(db, 'ops', 'https://hooks.slack.com/services/aaa');
    subscribe(db, 'service_down', channelId);
    subscribe(db, 'service_recovered', channelId);
    const sysops = new DevSysOps(sysopsRoot()); // always returns 'unknown'
    const { fetchImpl, calls } = fakeFetch();
    const watch = startServiceWatch({ db, sysops, intervalMs: NEVER_FIRES_MS, fetchImpl });

    await watch.tick();
    await watch.tick();
    await watch.tick();

    expect(calls).toHaveLength(0);
    watch.stop();
  });

  it('stop() clears the interval: no further automatic ticks fire once stopped', async () => {
    const db = tmpDb();
    const channelId = insertChannel(db, 'ops', 'https://hooks.slack.com/services/aaa');
    subscribe(db, 'service_down', channelId);
    const sysops = new FakeStatusSysOps(sysopsRoot());
    const { fetchImpl, calls } = fakeFetch();

    // A short real interval this time, to prove the automatic (non-manual) path also works and
    // that stop() actually clears it.
    const watch = startServiceWatch({ db, sysops, intervalMs: 5, fetchImpl });
    await new Promise((resolve) => setTimeout(resolve, 40)); // let a few automatic ticks happen (seed only, still active)
    watch.stop();

    sysops.setStatus('nginx', 'failed');
    const callsAtStop = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40)); // would fire more ticks if not stopped
    expect(calls.length).toBe(callsAtStop);
  });
});
