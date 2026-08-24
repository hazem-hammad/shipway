/** The systemctl verbs Shipway is allowed to run against its own units. */
export type UnitAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable';

/** Normalized status of a systemd unit, as reported by `systemctl is-active`. */
export type UnitStatus = 'active' | 'inactive' | 'failed' | 'unknown';

/**
 * All privileged system mutations Shipway performs go through this
 * interface. `RealSysOps` shells out via `sudo` + the whitelisted root
 * helper `shipway-sysops`; `DevSysOps` sandboxes everything under a
 * directory for dev mode and tests.
 */
export interface SysOps {
  /** Installs a system config/unit file at `dest`, with `content` as its body. */
  installFile(dest: string, content: string): Promise<void>;
  /** Removes a previously installed file at `dest`. */
  removeFile(dest: string): Promise<void>;
  /** Runs `nginx -t`. Never throws; failures are reported via `ok`/`output`. */
  nginxTest(): Promise<{ ok: boolean; output: string }>;
  /** Reloads nginx. */
  reloadNginx(): Promise<void>;
  /**
   * Reloads php-fpm for `version` (e.g. `'8.3'` -> `php8.3-fpm`). `signal`, when given (the deploy
   * pipeline's post-activate restart passes its cancel signal; most other callers have none to
   * pass and omit it, unaffected), aborts the underlying command — see `RealSysOps`'s doc comment
   * for how a failure gets attributed to that abort specifically, vs. a genuine reload failure.
   */
  reloadPhpFpm(version: string, signal?: AbortSignal): Promise<void>;
  /** Runs `systemctl daemon-reload`. */
  daemonReload(): Promise<void>;
  /** Runs `systemctl <action> <unit>` for a Shipway-managed unit. See `reloadPhpFpm`'s doc comment
   * for `signal`. */
  unitAction(action: UnitAction, unit: string, signal?: AbortSignal): Promise<void>;
  /** Reads the current status of a Shipway-managed unit. Never throws. */
  unitStatus(unit: string): Promise<UnitStatus>;
  /**
   * Reads the current status of a shared system unit (one of `SYSTEM_UNITS` — nginx, php-fpm,
   * mysql, postgresql, redis, mailpit). These aren't Shipway-managed (no `shipway-` prefix), so they
   * go through this separate method rather than `unitStatus`, which enforces that prefix. Never
   * throws.
   */
  systemUnitStatus(unit: string): Promise<UnitStatus>;
  /** Tails the last `lines` lines of a unit's journal. */
  journalTail(unit: string, lines: number): Promise<string>;
  /** Reads the current user's crontab, or `''` if none is set. */
  readCrontab(): Promise<string>;
  /** Replaces the current user's crontab with `content`. */
  writeCrontab(content: string): Promise<void>;
}

const UNIT_NAME_RE = /^shipway-[a-z0-9@.-]+$/;

/**
 * Validates that `unit` is a Shipway-managed systemd unit name before any
 * privileged operation touches it. This is defense in depth: the root
 * helper and sudoers whitelist enforce the same shape independently.
 */
export function assertUnitName(unit: string): void {
  if (!UNIT_NAME_RE.test(unit)) {
    throw new Error(`Invalid unit name: ${unit}`);
  }
}

const UNIT_PATTERN_RE = /^shipway-[a-z0-9@.*-]+$/;

/**
 * Like {@link assertUnitName}, but also allows `*` — a `journalctl -u`
 * glob, used to tail every instance of a worker's template unit at once
 * (e.g. `shipway-worker-<slug>-<name>@*`). Only `journalTail` accepts a
 * pattern this loose; `unitAction`/`unitStatus` stay on `assertUnitName`.
 */
export function assertUnitPattern(pattern: string): void {
  if (!UNIT_PATTERN_RE.test(pattern)) {
    throw new Error(`Invalid unit pattern: ${pattern}`);
  }
}

/**
 * The shared (non-Shipway-managed) systemd units `GET /api/server/stats` reports status for. Unlike
 * `assertUnitName`'s `shipway-`-prefixed units, these are services Shipway only observes, never
 * installs — so `systemUnitStatus` validates against this fixed allowlist instead.
 */
export const SYSTEM_UNITS = [
  'nginx',
  'php8.1-fpm',
  'php8.2-fpm',
  'php8.3-fpm',
  'php8.4-fpm',
  'mysql',
  'postgresql',
  'redis-server',
  'mailpit',
] as const;

export type SystemUnit = (typeof SYSTEM_UNITS)[number];

/** Throws if `unit` isn't one of `SYSTEM_UNITS`. */
export function assertSystemUnit(unit: string): asserts unit is SystemUnit {
  if (!(SYSTEM_UNITS as readonly string[]).includes(unit)) {
    throw new Error(`Invalid system unit: ${unit}`);
  }
}
