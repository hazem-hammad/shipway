/**
 * Imports the one-time bootstrap file `setup/install.sh` writes to `${dataDir}/bootstrap.json`:
 * the admin credentials and service connection info it provisioned on the host while setting up
 * the server (MySQL/Postgres admin URLs, the shared Redis instance's connection info, the shared
 * Mailpit instance's connection info, plus the base domain/server IP/ACME email the operator
 * entered during install). `server/src/index.ts` calls `importBootstrap` once at boot, before the
 * app starts listening.
 *
 * Idempotent and non-destructive by design:
 * - Only settings keys that are NOT already present get written, so an operator who edited a
 *   setting through the UI (or a re-run of install.sh) is never clobbered by a later import.
 * - The bootstrap file is deleted after a successful import, so the plaintext admin passwords it
 *   carries don't sit on disk on an already-booted server.
 * - If the file doesn't exist (already imported, or a dev-mode checkout that never had one), this
 *   is a no-op — the database is never touched.
 * - If the file exists but is malformed (unreadable or invalid JSON), the read/parse is caught,
 *   a clear warning is logged, and the file is left in place — the server still boots normally.
 *   Deleting a bootstrap file we failed to parse would silently strand the operator's provisioned
 *   credentials; leaving it lets a future fixed/valid file (or manual inspection) still work.
 *
 * One narrow, deliberate exception to "never clobber": when `force_admin_urls` is `true`,
 * `mysql_admin_url` and `postgres_admin_url` — and ONLY those two keys — are written even if
 * already set. `setup/install.sh` sets this flag exclusively when an operator explicitly opted
 * into `SHIPWAY_ROTATE_DB_ADMIN=1` to rotate the live `shipway_admin` MySQL/Postgres credential
 * after `/root/.shipway-install-secrets` was lost on an already-provisioned server (see
 * `provision_mysql_admin`/`provision_postgres_admin` and DEPLOYMENT.md's "Lost
 * /root/.shipway-install-secrets on an already-live server" section). Without this, that rotation
 * would push a new password live via `ALTER USER`/`ALTER ROLE` while Shipway kept using the old,
 * now-wrong one forever (see Finding 1) — every other bootstrap key keeps the plain
 * never-clobber behavior.
 */
import * as fs from 'node:fs';
import type { Config } from '../config.js';
import type { ShipwayDb } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';

interface RedisInfo {
  host: string;
  port: number;
  password?: string;
}

interface MailpitInfo {
  smtpHost: string;
  smtpPort: number;
  webUrl: string;
  /** Basic-auth credentials for the mailpit web UI vhost (`setup/install.sh`'s
   * `configure_mailpit_auth`/`auth_basic`) — optional so a bootstrap file written by an older
   * install.sh (or hand-edited) without them still imports cleanly. */
  username?: string;
  webPassword?: string;
}

/**
 * Shape of `bootstrap.json`, as written by `setup/install.sh`. Every field is optional — only the
 * keys actually present in the file are imported, so a hand-edited or partial bootstrap file still
 * works.
 */
export interface BootstrapFile {
  mysql_admin_url?: string;
  postgres_admin_url?: string;
  redis_info?: RedisInfo;
  mailpit_info?: MailpitInfo;
  base_domain?: string;
  server_ip?: string;
  acme_email?: string;
  /** Control flag, not itself a settings key — see the "narrow, deliberate exception" doc above. */
  force_admin_urls?: boolean;
}

/** The settings keys `importBootstrap` knows how to populate — one-to-one with `BootstrapFile`'s
 * data keys (`force_admin_urls` is a control flag, not a settings key, so it's deliberately absent
 * here). */
const BOOTSTRAP_KEYS = [
  'mysql_admin_url',
  'postgres_admin_url',
  'redis_info',
  'mailpit_info',
  'base_domain',
  'server_ip',
  'acme_email',
] as const satisfies readonly (keyof BootstrapFile)[];

/** The only keys `force_admin_urls: true` is allowed to overwrite even when already set. Kept as
 * its own list (rather than, say, a per-key flag on `BOOTSTRAP_KEYS`) so the "narrowly scoped to
 * exactly these two keys" guarantee is visible and grep-able in one place. */
const FORCE_OVERWRITABLE_KEYS: readonly string[] = ['mysql_admin_url', 'postgres_admin_url'];

/**
 * Reads `${cfg.dataDir}/bootstrap.json` (if present), writes each key it contains into `settings`
 * — skipping any key that's already set — then deletes the file. No-ops if the file doesn't exist.
 */
export function importBootstrap(db: ShipwayDb, cfg: Config): void {
  const bootstrapPath = `${cfg.dataDir}/bootstrap.json`;
  if (!fs.existsSync(bootstrapPath)) {
    return;
  }

  let parsed: BootstrapFile;
  try {
    parsed = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8')) as BootstrapFile;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`bootstrap: failed to read/parse ${bootstrapPath} — skipping import, leaving file in place: ${detail}`);
    return;
  }

  const forceAdminUrls = parsed.force_admin_urls === true;

  for (const key of BOOTSTRAP_KEYS) {
    const value = parsed[key];
    if (value === undefined) continue;
    const alreadySet = getSetting(db, key) !== null;
    const forceThisKey = forceAdminUrls && FORCE_OVERWRITABLE_KEYS.includes(key);
    if (alreadySet && !forceThisKey) continue; // already configured — never clobber an operator edit
    if (alreadySet && forceThisKey) {
      console.warn(`bootstrap: force_admin_urls=true — overwriting already-set setting "${key}" with the value from ${bootstrapPath} (a deliberate SHIPWAY_ROTATE_DB_ADMIN=1 rotation, not an accidental clobber)`);
    }
    setSetting(db, key, value);
  }

  fs.rmSync(bootstrapPath);
}
