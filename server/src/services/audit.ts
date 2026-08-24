/**
 * Audit trail: every mutating API action records one row via `recordAudit`. Deliberately fire-and-
 * forget from the caller's point of view — a broken/unavailable db must never turn an otherwise-
 * successful request into a 500, so every failure (including reading the `audit_enabled` setting
 * itself) is caught and logged, never rethrown.
 */
import { eq, lt } from 'drizzle-orm';
import type { ShipwayDb } from '../db/index.js';
import { auditEvents, users } from '../db/schema.js';
import { getSetting, setSetting } from '../db/settings.js';

const AUDIT_ENABLED_KEY = 'audit_enabled';
const AUDIT_RETENTION_DAYS_KEY = 'audit_retention_days';

/** Default retention (days) applied when `audit_retention_days` has never been set — matches the
 * spec's 30/90/365 picker default. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;

export interface RecordAuditInput {
  /** `null`/omitted for system-triggered actions with no session user (e.g. a GitHub webhook push). */
  actorId?: number | null;
  actorName: string;
  /** Dot-namespaced, e.g. `'project.create'`, `'deploy.trigger'`, `'auth.login_failed'`. */
  action: string;
  targetType: string;
  targetName: string;
  /** Opaque JSON-serializable metadata. NEVER put secret values here (e.g. `settings.update` records
   * only the changed keys, never their new values). */
  meta?: Record<string, unknown>;
}

/** `true` unless `audit_enabled` has been explicitly set to `false` (default: recording is on). */
export function getAuditEnabled(db: ShipwayDb): boolean {
  return getSetting<boolean>(db, AUDIT_ENABLED_KEY) ?? true;
}

export function setAuditEnabled(db: ShipwayDb, enabled: boolean): void {
  setSetting(db, AUDIT_ENABLED_KEY, enabled);
}

/** Retention window in days, defaulting to `DEFAULT_AUDIT_RETENTION_DAYS` when unset. */
export function getAuditRetentionDays(db: ShipwayDb): number {
  return getSetting<number>(db, AUDIT_RETENTION_DAYS_KEY) ?? DEFAULT_AUDIT_RETENTION_DAYS;
}

export function setAuditRetentionDays(db: ShipwayDb, days: number): void {
  setSetting(db, AUDIT_RETENTION_DAYS_KEY, days);
}

/**
 * Inserts one audit row for a mutating action. No-ops (does not insert) when auditing is disabled
 * via the `audit_enabled` setting. Never throws: any failure (disabled-audit lookup, insert, a
 * closed/broken db) is caught and logged with `console.error` instead, so a broken audit trail can
 * never fail the request that triggered it.
 */
export function recordAudit(db: ShipwayDb, input: RecordAuditInput): void {
  try {
    if (!getAuditEnabled(db)) return;

    db.insert(auditEvents)
      .values({
        actorId: input.actorId ?? null,
        actorName: input.actorName,
        action: input.action,
        targetType: input.targetType,
        targetName: input.targetName,
        meta: input.meta !== undefined ? JSON.stringify(input.meta) : null,
      })
      .run();
  } catch (err) {
    console.error('shipway: recordAudit failed', err);
  }
}

/** Deletes every audit row older than `retentionDays`. */
export function purgeAudit(db: ShipwayDb, retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  db.delete(auditEvents).where(lt(auditEvents.createdAt, cutoff)).run();
}

/**
 * Runs one retention-purge pass right now: a no-op when auditing is disabled (`audit_enabled ===
 * false`), otherwise `purgeAudit` at the currently configured `audit_retention_days` (defaulting to
 * `DEFAULT_AUDIT_RETENTION_DAYS`). This is the single function both the boot-time purge and the
 * hourly timer below call, so "purge on boot" and "purge every hour" always apply the exact same
 * enabled/retention rules.
 */
export function runAuditPurgeOnce(db: ShipwayDb): void {
  if (!getAuditEnabled(db)) return;
  purgeAudit(db, getAuditRetentionDays(db));
}

export interface AuditPurgeHandle {
  /** Stops the interval. Idempotent. */
  stop: () => void;
  /** Runs one purge pass immediately, outside the interval schedule — lets tests drive the timer
   * deterministically (an injectable `intervalMs` set far in the future + manual `.tick()` calls),
   * mirroring `services/servicewatch.ts`'s `ServiceWatchHandle`. */
  tick: () => void;
}

/**
 * Starts the hourly audit-retention purge timer (spec's Audit log row: "automatic purge (hourly
 * timer + boot)"). `app.ts` wires this the same way it wires `startServiceWatch`: injectable
 * `intervalMs` for tests, skipped entirely under `NODE_ENV=test` unless a test opts in, and stopped
 * via an `onClose` hook so a leaked `setInterval` never keeps the process (or vitest) alive.
 */
export function startAuditPurge(db: ShipwayDb, intervalMs: number): AuditPurgeHandle {
  const tick = (): void => runAuditPurgeOnce(db);

  const timer = setInterval(tick, intervalMs);

  return {
    tick,
    stop: () => {
      clearInterval(timer);
    },
  };
}

/**
 * Resolves the acting user for an audit row from a session `userId` (or `undefined` when there's no
 * session, e.g. a login-failure or webhook-triggered action). Route handlers pass
 * `request.session.get('userId')` here once per request. A `userId` that no longer resolves to a row
 * (deleted between session issuance and this call) falls back the same way as no session at all.
 */
export function getActor(db: ShipwayDb, userId: number | undefined): { actorId: number | null; actorName: string } {
  if (userId === undefined) {
    return { actorId: null, actorName: 'unknown' };
  }
  const row = db.select({ name: users.name }).from(users).where(eq(users.id, userId)).get();
  if (!row) {
    return { actorId: null, actorName: 'unknown' };
  }
  return { actorId: userId, actorName: row.name };
}
