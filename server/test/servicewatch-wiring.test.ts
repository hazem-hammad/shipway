/**
 * app.ts's wiring of the service-status poller: disabled entirely under `NODE_ENV=test` (vitest's
 * default) unless a test explicitly injects `deps.serviceWatch`; when injected, it reaches the real
 * db/sysops end to end and records audit rows, and `app.close()` stops it via an `onClose` hook,
 * leaving no open interval handle behind — otherwise a leaked `setInterval` would keep the
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
 * (real db, real sysops) reaches the real `startServiceWatch`. */
class MutableStatusSysOps extends DevSysOps {
  private readonly statuses = new Map<string, UnitStatus>();
  /** How many times the poller has asked for a unit's status. With the webhook fan-out gone, this is
   * the probe for "did a tick actually run" in the `onClose` test below — and unlike reading the db,
   * it stays usable after `app.close()`. */
  statusReads = 0;

  setStatus(unit: string, status: UnitStatus): void {
    this.statuses.set(unit, status);
  }

  override async systemUnitStatus(unit: string): Promise<UnitStatus> {
    this.statusReads += 1;
    return this.statuses.get(unit) ?? 'active';
  }
}

const ADMIN = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct-horse-battery' };

describe('app.ts service-watch wiring', () => {
  it('does not start the poller under NODE_ENV=test unless deps.serviceWatch is injected', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { sysops: new DevSysOps(path.join(cfg.dataDir, 'system')) });

    expect(app.serviceWatch).toBeUndefined();

    await app.close();
  });

  it('when injected, reaches the real db/sysops end to end: seeds silently, then records an audit row on a genuine transition', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const sysops = new MutableStatusSysOps(path.join(cfg.dataDir, 'system'));

    const app = await buildApp(cfg, {
      sysops,
      // A real (huge) interval — never fires on its own during the test; `.tick()` drives it instead.
      serviceWatch: { intervalMs: 24 * 60 * 60 * 1000 },
    });
    expect(app.serviceWatch).toBeDefined();

    await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });

    await app.serviceWatch!.tick(); // seed: nginx active, silent
    expect(app.db.select().from(auditEvents).where(eq(auditEvents.action, 'service.down')).all()).toHaveLength(0);

    sysops.setStatus('nginx', 'failed');
    await app.serviceWatch!.tick(); // transition

    const downAudits = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'service.down')).all();
    expect(downAudits).toHaveLength(1);
    expect(downAudits[0]?.targetName).toBe('nginx');

    await app.close();
  });

  it('app.close() stops the injected poller (onClose hook): no further automatic tick fires afterward', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const sysops = new MutableStatusSysOps(path.join(cfg.dataDir, 'system'));

    const app = await buildApp(cfg, { sysops, serviceWatch: { intervalMs: 5 } });
    expect(app.serviceWatch).toBeDefined();

    await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });

    // Let a few automatic (real, short-interval) ticks happen, so the poller is demonstrably running.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sysops.statusReads).toBeGreaterThan(0);

    await app.close();
    const readsAtClose = sysops.statusReads;

    // If `onClose` had NOT called `.stop()`, the interval would keep firing and keep reading unit
    // statuses. With it genuinely cleared, the count can never move again.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sysops.statusReads).toBe(readsAtClose);
  });
});
