/**
 * app.ts's wiring of Task 5's audit-retention purge: a boot-time purge runs unconditionally on
 * every `buildApp()` call (mirrors `migrateLegacyWebhookChannel` — not gated by test mode, since
 * it's a single cheap DELETE), while the recurring hourly timer follows the exact same test-gating
 * pattern as Task 4's `serviceWatch` (see `servicewatch-wiring.test.ts`): disabled entirely under
 * `NODE_ENV=test` unless a test explicitly injects `deps.auditPurge`, and stopped via an `onClose`
 * hook so `app.close()` never leaves an open interval handle behind.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { auditEvents } from '../src/db/schema.js';
import { setAuditRetentionDays } from '../src/services/audit.js';
import { DevSysOps } from '../src/sysops/dev.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-audit-purge-wiring-test-'));
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function seedOldRow(app: Awaited<ReturnType<typeof buildApp>>, targetName: string, ageDays: number): void {
  app.db
    .insert(auditEvents)
    .values({
      actorId: null,
      actorName: 'x',
      action: 'project.create',
      targetType: 'project',
      targetName,
      createdAt: Date.now() - ageDays * ONE_DAY_MS,
    })
    .run();
}

describe('app.ts audit-purge wiring', () => {
  it('does not start the hourly timer under NODE_ENV=test unless deps.auditPurge is injected', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { sysops: new DevSysOps(path.join(cfg.dataDir, 'system')) });

    expect(app.auditPurge).toBeUndefined();

    await app.close();
  });

  it('purges on boot unconditionally, even without the hourly timer injected', async () => {
    const dataDir = tmpDataDir();
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });

    let app = await buildApp(cfg, { sysops: new DevSysOps(path.join(dataDir, 'system')) });
    seedOldRow(app, 'old', 100);
    setAuditRetentionDays(app.db, 30);
    await app.close();

    // Re-open against the SAME db: the boot purge on this second `buildApp()` call must delete the
    // 100-day-old row (30-day retention) even though the hourly timer stays off under NODE_ENV=test.
    app = await buildApp(cfg, { sysops: new DevSysOps(path.join(dataDir, 'system')) });
    expect(app.db.select().from(auditEvents).where(eq(auditEvents.targetName, 'old')).all()).toHaveLength(0);

    await app.close();
  });

  it('when injected, .tick() purges immediately per the configured retention', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, {
      sysops: new DevSysOps(path.join(cfg.dataDir, 'system')),
      auditPurge: { intervalMs: ONE_DAY_MS }, // huge: never fires on its own; .tick() drives it
    });
    expect(app.auditPurge).toBeDefined();

    seedOldRow(app, 'old', 100);
    seedOldRow(app, 'recent', 1);
    setAuditRetentionDays(app.db, 30);

    app.auditPurge!.tick();

    expect(app.db.select().from(auditEvents).where(eq(auditEvents.targetName, 'old')).all()).toHaveLength(0);
    expect(app.db.select().from(auditEvents).where(eq(auditEvents.targetName, 'recent')).all()).toHaveLength(1);

    await app.close();
  });

  it('app.close() stops the injected timer (onClose hook): no further automatic tick fires afterward', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, {
      sysops: new DevSysOps(path.join(cfg.dataDir, 'system')),
      auditPurge: { intervalMs: 5 }, // short real interval: proves it's actually running below
    });
    expect(app.auditPurge).toBeDefined();
    setAuditRetentionDays(app.db, 30);

    // Let a few automatic ticks happen first, proving the interval is genuinely live.
    seedOldRow(app, 'purged-while-running', 100);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(app.db.select().from(auditEvents).where(eq(auditEvents.targetName, 'purged-while-running')).all()).toHaveLength(0);

    await app.close();

    // If `onClose` had NOT called `.stop()`, the interval would keep firing and this row would be
    // purged on the next automatic tick too. With the interval genuinely cleared, it must survive.
    seedOldRow(app, 'old-after-close', 100);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(app.db.select().from(auditEvents).where(eq(auditEvents.targetName, 'old-after-close')).all()).toHaveLength(1);
  });
});
