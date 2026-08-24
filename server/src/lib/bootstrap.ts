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
}

/** The settings keys `importBootstrap` knows how to populate — one-to-one with `BootstrapFile`'s keys. */
const BOOTSTRAP_KEYS = [
  'mysql_admin_url',
  'postgres_admin_url',
  'redis_info',
  'mailpit_info',
  'base_domain',
  'server_ip',
  'acme_email',
] as const satisfies readonly (keyof BootstrapFile)[];

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

  for (const key of BOOTSTRAP_KEYS) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (getSetting(db, key) !== null) continue; // already configured — never clobber an operator edit
    setSetting(db, key, value);
  }

  fs.rmSync(bootstrapPath);
}
