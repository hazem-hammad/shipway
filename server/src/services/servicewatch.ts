/**
 * Task 4's service-status poller: every `intervalMs`, reads `SYSTEM_UNITS`' status (`stats.ts`'s
 * fixed nginx/php-fpm/mysql/postgresql/redis/mailpit set) via `sysops.systemUnitStatus`, diffs it
 * against an in-memory map, and on a genuine transition emits the matching `notifybus` event
 * (`service_down`/`service_recovered`) plus a `service.down`/`service.recovered` audit row (actor
 * `'system'`). Unchanged status: silent. The very first observation for a unit just seeds the map
 * without emitting anything — otherwise every fresh boot would fire a burst of "recovered" events
 * for services nobody has polled before.
 */
import type { ShipwayDb } from '../db/index.js';
import { recordAudit } from './audit.js';
import { EVENTS, emitEvent } from './notifybus.js';
import { SERVICE_NAMES } from './stats.js';
import { SYSTEM_UNITS, type SysOps, type SystemUnit, type UnitStatus } from '../sysops/types.js';

const DOWN_STATUSES: readonly UnitStatus[] = ['failed', 'inactive'];

/** `true` for a "down" unit status (`'failed'`/`'inactive'`); `'active'` and `'unknown'` are both
 * "not down" — `'unknown'` deliberately counts as up rather than down (dev mode's `DevSysOps`
 * always reports `'unknown'`, and a status Shipway simply couldn't determine shouldn't be flagged
 * as a live outage). Exported so `routes/overview.ts` (Task 5's `GET /api/overview` `servicesDown`)
 * classifies a unit's LIVE status exactly the same way this poller's `service_down`/
 * `service_recovered` transition detection does, instead of a second, potentially drifting copy of
 * this rule. */
export function isDown(status: UnitStatus): boolean {
  return (DOWN_STATUSES as readonly string[]).includes(status);
}

export interface ServiceWatchDeps {
  db: ShipwayDb;
  sysops: SysOps;
  intervalMs: number;
  fetchImpl?: typeof fetch;
}

export interface ServiceWatchHandle {
  /** Stops the interval. Idempotent. */
  stop: () => void;
  /** Runs one poll pass immediately, outside the interval schedule. The interval-driven and manual
   * paths share this exact function, so tests can drive transitions deterministically (an injectable
   * `intervalMs` set far in the future + manual `.tick()` calls) instead of relying on real time. */
  tick: () => Promise<void>;
}

/** Reads every `SYSTEM_UNITS` status, diffs against `state`, and emits/audits any transition. */
async function pollOnce(deps: ServiceWatchDeps, state: Map<SystemUnit, boolean>): Promise<void> {
  for (const unit of SYSTEM_UNITS) {
    const status = await deps.sysops.systemUnitStatus(unit);
    const down = isDown(status);
    const previouslyDown = state.get(unit);

    if (previouslyDown === undefined) {
      state.set(unit, down); // boot seeding: no event on the first observation
      continue;
    }

    if (down === previouslyDown) {
      continue; // unchanged — no repeat emission
    }
    state.set(unit, down);

    const name = SERVICE_NAMES[unit];
    const message = `${name} (${unit}) is ${status}`;
    const event = down ? 'service_down' : 'service_recovered';
    const action = down ? 'service.down' : 'service.recovered';

    await emitEvent(deps.db, event, { title: EVENTS[event].label, message }, deps.fetchImpl);
    recordAudit(deps.db, { actorId: null, actorName: 'system', action, targetType: 'service', targetName: unit });
  }
}

/** Starts the poller: an interval loop that calls `pollOnce` every `deps.intervalMs`. Returns a
 * handle to stop it and/or trigger a poll pass manually. */
export function startServiceWatch(deps: ServiceWatchDeps): ServiceWatchHandle {
  const state = new Map<SystemUnit, boolean>();
  const tick = (): Promise<void> => pollOnce(deps, state);

  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs);

  return {
    tick,
    stop: () => {
      clearInterval(timer);
    },
  };
}
