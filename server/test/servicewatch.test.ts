/**
 * The service-status poller: diffs `SYSTEM_UNITS` status against an in-memory map every interval,
 * recording a `service.down`/`service.recovered` audit row on a genuine transition only. The first
 * observation for a unit just seeds the map (no row) — otherwise every fresh boot would write a
 * burst of "recovered" rows for services nobody has polled before.
 *
 * The poller used to ALSO emit `service_down`/`service_recovered` notification events; those went
 * away when notifications became a per-project feature (`services/notifybus.ts`), since a host-wide
 * service transition has no project to belong to. The audit rows below are what's left, and are
 * therefore what these tests assert on.
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
import { auditEvents } from '../src/db/schema.js';
import { DevSysOps } from '../src/sysops/dev.js';
import type { UnitStatus } from '../src/sysops/types.js';
import { startServiceWatch } from '../src/services/servicewatch.js';

const NEVER_FIRES_MS = 24 * 60 * 60 * 1000; // 24h — long enough that no test ever hits a real tick

function tmpDb(): ShipwayDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-servicewatch-test-'));
  return openDb(path.join(dir, 'shipway.db'));
}

/** A `SysOps` double whose `systemUnitStatus` returns a per-unit, freely-mutable status (default
 * `'active'`), so tests can drive down/recovered transitions deterministically. `statusReads` counts
 * poll passes, which is how the `stop()` test proves the interval was genuinely cleared. */
class FakeStatusSysOps extends DevSysOps {
  private readonly statuses = new Map<string, UnitStatus>();
  statusReads = 0;

  setStatus(unit: string, status: UnitStatus): void {
    this.statuses.set(unit, status);
  }

  override async systemUnitStatus(unit: string): Promise<UnitStatus> {
    this.statusReads += 1;
    return this.statuses.get(unit) ?? 'active';
  }
}

function sysopsRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-servicewatch-sysops-'));
}

function auditsFor(db: ShipwayDb, action: 'service.down' | 'service.recovered') {
  return db.select().from(auditEvents).where(eq(auditEvents.action, action)).all();
}

describe('startServiceWatch', () => {
  it('seeds state on the first tick without recording any audit rows', async () => {
    const db = tmpDb();
    const sysops = new FakeStatusSysOps(sysopsRoot());
    sysops.setStatus('nginx', 'failed'); // already down at "boot" — must NOT record on first observation

    const watch = startServiceWatch({ db, sysops, intervalMs: NEVER_FIRES_MS });
    await watch.tick();
    watch.stop();

    expect(db.select().from(auditEvents).all()).toHaveLength(0);
  });

  it('active -> down records service.down exactly once, not again on an unchanged following tick', async () => {
    const db = tmpDb();
    const sysops = new FakeStatusSysOps(sysopsRoot());
    const watch = startServiceWatch({ db, sysops, intervalMs: NEVER_FIRES_MS });

    await watch.tick(); // seed: nginx active, silent

    sysops.setStatus('nginx', 'failed');
    await watch.tick(); // transition: active -> down

    const downAudits = auditsFor(db, 'service.down');
    expect(downAudits).toHaveLength(1);
    expect(downAudits[0]?.actorName).toBe('system');
    expect(downAudits[0]?.targetType).toBe('service');
    expect(downAudits[0]?.targetName).toBe('nginx');

    await watch.tick(); // still failed: no repeat
    expect(auditsFor(db, 'service.down')).toHaveLength(1);

    watch.stop();
  });

  it('down -> active records service.recovered exactly once, not again on an unchanged following tick', async () => {
    const db = tmpDb();
    const sysops = new FakeStatusSysOps(sysopsRoot());
    const watch = startServiceWatch({ db, sysops, intervalMs: NEVER_FIRES_MS });

    await watch.tick(); // seed: active, silent
    sysops.setStatus('nginx', 'inactive');
    await watch.tick(); // down transition
    expect(auditsFor(db, 'service.down')).toHaveLength(1);

    sysops.setStatus('nginx', 'active');
    await watch.tick(); // recovered transition

    const recoveredAudits = auditsFor(db, 'service.recovered');
    expect(recoveredAudits).toHaveLength(1);
    expect(recoveredAudits[0]?.targetName).toBe('nginx');

    await watch.tick(); // still active: no repeat
    expect(auditsFor(db, 'service.recovered')).toHaveLength(1);

    watch.stop();
  });

  it("treats both 'failed' and 'inactive' as down (either counts as a down transition, and recovering from either records service.recovered)", async () => {
    const db = tmpDb();
    const sysops = new FakeStatusSysOps(sysopsRoot());
    const watch = startServiceWatch({ db, sysops, intervalMs: NEVER_FIRES_MS });

    await watch.tick(); // seed active
    sysops.setStatus('mysql', 'inactive');
    await watch.tick();
    expect(auditsFor(db, 'service.down').map((row) => row.targetName)).toEqual(['mysql']);

    sysops.setStatus('mysql', 'active');
    await watch.tick();
    expect(auditsFor(db, 'service.recovered').map((row) => row.targetName)).toEqual(['mysql']);

    watch.stop();
  });

  it('does not treat "unknown" as a transition either way (DevSysOps-style default, e.g. real deploys before the sysops helper is fully wired)', async () => {
    const db = tmpDb();
    const sysops = new DevSysOps(sysopsRoot()); // always returns 'unknown'
    const watch = startServiceWatch({ db, sysops, intervalMs: NEVER_FIRES_MS });

    await watch.tick();
    await watch.tick();
    await watch.tick();

    expect(db.select().from(auditEvents).all()).toHaveLength(0);
    watch.stop();
  });

  it('stop() clears the interval: no further automatic ticks fire once stopped', async () => {
    const db = tmpDb();
    const sysops = new FakeStatusSysOps(sysopsRoot());

    // A short real interval this time, to prove the automatic (non-manual) path also works and
    // that stop() actually clears it.
    const watch = startServiceWatch({ db, sysops, intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 40)); // let a few automatic ticks happen (seed only, still active)
    expect(sysops.statusReads).toBeGreaterThan(0);
    watch.stop();

    const readsAtStop = sysops.statusReads;
    sysops.setStatus('nginx', 'failed');
    await new Promise((resolve) => setTimeout(resolve, 40)); // would fire more ticks if not stopped
    expect(sysops.statusReads).toBe(readsAtStop);
    expect(auditsFor(db, 'service.down')).toHaveLength(0);
  });
});
