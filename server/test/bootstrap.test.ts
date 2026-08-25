import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { getSetting, setSetting } from '../src/db/settings.js';
import { importBootstrap } from '../src/lib/bootstrap.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-bootstrap-test-'));
}

function makeCfg(dataDir: string): Config {
  return loadConfig({ SHIPWAY_DATA_DIR: dataDir });
}

function makeDb(): ShipwayDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-bootstrap-db-'));
  return openDb(path.join(dir, 'shipway.db'));
}

const FULL_BOOTSTRAP = {
  mysql_admin_url: 'mysql://shipway_admin:s3cret@127.0.0.1:3306',
  postgres_admin_url: 'postgres://shipway_admin:s3cret@127.0.0.1:5432/postgres',
  redis_info: { host: '127.0.0.1', port: 6379, password: 'redis-pw' },
  mailpit_info: {
    smtpHost: '127.0.0.1',
    smtpPort: 1025,
    webUrl: 'https://mail.intcore.dev',
    username: 'intcore',
    webPassword: 'a-random-web-password',
  },
  base_domain: 'intcore.dev',
  server_ip: '203.0.113.10',
  acme_email: 'ops@intcore.dev',
};

function writeBootstrapFile(dataDir: string, content: unknown): void {
  fs.writeFileSync(path.join(dataDir, 'bootstrap.json'), JSON.stringify(content));
}

describe('importBootstrap', () => {
  it('imports every field from bootstrap.json into settings, then deletes the file', () => {
    const dataDir = tmpDataDir();
    writeBootstrapFile(dataDir, FULL_BOOTSTRAP);
    const cfg = makeCfg(dataDir);
    const db = makeDb();

    importBootstrap(db, cfg);

    expect(getSetting(db, 'mysql_admin_url')).toBe(FULL_BOOTSTRAP.mysql_admin_url);
    expect(getSetting(db, 'postgres_admin_url')).toBe(FULL_BOOTSTRAP.postgres_admin_url);
    expect(getSetting(db, 'redis_info')).toEqual(FULL_BOOTSTRAP.redis_info);
    expect(getSetting(db, 'mailpit_info')).toEqual(FULL_BOOTSTRAP.mailpit_info);
    expect(getSetting(db, 'base_domain')).toBe(FULL_BOOTSTRAP.base_domain);
    expect(getSetting(db, 'server_ip')).toBe(FULL_BOOTSTRAP.server_ip);
    expect(getSetting(db, 'acme_email')).toBe(FULL_BOOTSTRAP.acme_email);

    expect(fs.existsSync(path.join(dataDir, 'bootstrap.json'))).toBe(false);
  });

  it('is a no-op (does not touch the db, does not throw) when bootstrap.json does not exist', () => {
    const dataDir = tmpDataDir();
    const cfg = makeCfg(dataDir);
    const db = makeDb();

    expect(() => importBootstrap(db, cfg)).not.toThrow();

    expect(getSetting(db, 'base_domain')).toBeNull();
  });

  it('a second run after the first is a no-op (file already deleted)', () => {
    const dataDir = tmpDataDir();
    writeBootstrapFile(dataDir, FULL_BOOTSTRAP);
    const cfg = makeCfg(dataDir);
    const db = makeDb();

    importBootstrap(db, cfg);
    // Simulate an operator editing a setting after the first (successful) import.
    setSetting(db, 'base_domain', 'operator-edited.example.com');

    importBootstrap(db, cfg);

    expect(getSetting(db, 'base_domain')).toBe('operator-edited.example.com');
  });

  it('never clobbers a setting that was already present before the import', () => {
    const dataDir = tmpDataDir();
    writeBootstrapFile(dataDir, FULL_BOOTSTRAP);
    const cfg = makeCfg(dataDir);
    const db = makeDb();
    setSetting(db, 'base_domain', 'pre-existing.example.com');

    importBootstrap(db, cfg);

    // The pre-existing setting is untouched...
    expect(getSetting(db, 'base_domain')).toBe('pre-existing.example.com');
    // ...but every other key, which was NOT already set, still gets imported.
    expect(getSetting(db, 'server_ip')).toBe(FULL_BOOTSTRAP.server_ip);
    expect(getSetting(db, 'mysql_admin_url')).toBe(FULL_BOOTSTRAP.mysql_admin_url);
  });

  it('imports only the keys present in a partial bootstrap.json', () => {
    const dataDir = tmpDataDir();
    writeBootstrapFile(dataDir, { base_domain: 'intcore.dev', server_ip: '203.0.113.10' });
    const cfg = makeCfg(dataDir);
    const db = makeDb();

    importBootstrap(db, cfg);

    expect(getSetting(db, 'base_domain')).toBe('intcore.dev');
    expect(getSetting(db, 'server_ip')).toBe('203.0.113.10');
    expect(getSetting(db, 'mysql_admin_url')).toBeNull();
    expect(getSetting(db, 'redis_info')).toBeNull();
  });

  it('force_admin_urls: true overwrites mysql_admin_url and postgres_admin_url even when already set, but leaves every other already-set key alone', () => {
    const dataDir = tmpDataDir();
    writeBootstrapFile(dataDir, { ...FULL_BOOTSTRAP, force_admin_urls: true });
    const cfg = makeCfg(dataDir);
    const db = makeDb();
    setSetting(db, 'mysql_admin_url', 'mysql://shipway_admin:STALE-PASSWORD@127.0.0.1:3306');
    setSetting(db, 'postgres_admin_url', 'postgres://shipway_admin:STALE-PASSWORD@127.0.0.1:5432/postgres');
    setSetting(db, 'base_domain', 'operator-edited.example.com');

    importBootstrap(db, cfg);

    // The two admin URLs are force-overwritten with the rotated credential from bootstrap.json...
    expect(getSetting(db, 'mysql_admin_url')).toBe(FULL_BOOTSTRAP.mysql_admin_url);
    expect(getSetting(db, 'postgres_admin_url')).toBe(FULL_BOOTSTRAP.postgres_admin_url);
    // ...but every other already-set key is untouched, even though force_admin_urls is true.
    expect(getSetting(db, 'base_domain')).toBe('operator-edited.example.com');
  });

  it('without force_admin_urls, an already-set mysql_admin_url/postgres_admin_url is left alone (the default, safe behavior)', () => {
    const dataDir = tmpDataDir();
    writeBootstrapFile(dataDir, FULL_BOOTSTRAP);
    const cfg = makeCfg(dataDir);
    const db = makeDb();
    setSetting(db, 'mysql_admin_url', 'mysql://shipway_admin:REAL-LIVE-PASSWORD@127.0.0.1:3306');
    setSetting(db, 'postgres_admin_url', 'postgres://shipway_admin:REAL-LIVE-PASSWORD@127.0.0.1:5432/postgres');

    importBootstrap(db, cfg);

    expect(getSetting(db, 'mysql_admin_url')).toBe('mysql://shipway_admin:REAL-LIVE-PASSWORD@127.0.0.1:3306');
    expect(getSetting(db, 'postgres_admin_url')).toBe('postgres://shipway_admin:REAL-LIVE-PASSWORD@127.0.0.1:5432/postgres');
  });

  it('force_admin_urls: true still only populates unset keys other than the two admin URLs (no blanket force)', () => {
    const dataDir = tmpDataDir();
    writeBootstrapFile(dataDir, { ...FULL_BOOTSTRAP, force_admin_urls: true });
    const cfg = makeCfg(dataDir);
    const db = makeDb();
    setSetting(db, 'server_ip', 'operator-edited-ip');

    importBootstrap(db, cfg);

    expect(getSetting(db, 'server_ip')).toBe('operator-edited-ip');
    expect(getSetting(db, 'mysql_admin_url')).toBe(FULL_BOOTSTRAP.mysql_admin_url);
  });

  it('logs a warning and leaves the file in place (no throw, db untouched) when bootstrap.json is malformed JSON', () => {
    const dataDir = tmpDataDir();
    const bootstrapPath = path.join(dataDir, 'bootstrap.json');
    fs.writeFileSync(bootstrapPath, '{ this is not valid json');
    const cfg = makeCfg(dataDir);
    const db = makeDb();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => importBootstrap(db, cfg)).not.toThrow();

    expect(getSetting(db, 'base_domain')).toBeNull();
    // The malformed file is NOT deleted — deleting it would silently strand the operator's
    // provisioned credentials with no way to recover or fix them.
    expect(fs.existsSync(bootstrapPath)).toBe(true);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain(bootstrapPath);

    errorSpy.mockRestore();
  });
});
