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
  /** Reloads php-fpm for `version` (e.g. `'8.3'` -> `php8.3-fpm`). */
  reloadPhpFpm(version: string): Promise<void>;
  /** Runs `systemctl daemon-reload`. */
  daemonReload(): Promise<void>;
  /** Runs `systemctl <action> <unit>` for a Shipway-managed unit. */
  unitAction(action: UnitAction, unit: string): Promise<void>;
  /** Reads the current status of a Shipway-managed unit. Never throws. */
  unitStatus(unit: string): Promise<UnitStatus>;
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
