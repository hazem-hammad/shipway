import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { setSetting } from '../src/db/settings.js';
import { projects } from '../src/db/schema.js';
import { loadConfig, type Config } from '../src/config.js';
import { DevSysOps } from '../src/sysops/dev.js';
import { FakeDnsClient, type DnsClient } from '../src/services/cloudflare.js';
import {
  ProvisionError,
  deprovisionProject,
  nodeBinDir,
  provisionProject,
  refreshProjectConfig,
  type ProvisionDeps,
} from '../src/services/provisioner.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-provisioner-test-'));
}

function makeCfg(): Config {
  const dataDir = tmpDataDir();
  return loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });
}

function makeDb(cfg: Config): ShipwayDb {
  return openDb(cfg.dbPath);
}

/** The dir DevSysOps sandboxes everything under, in dev mode — matches sysops/index.ts's makeSysOps. */
function sysopsRoot(cfg: Config): string {
  return path.join(cfg.dataDir, 'system');
}

function readSandboxed(cfg: Config, dest: string): string {
  return fs.readFileSync(path.join(sysopsRoot(cfg), dest), 'utf8');
}

function existsSandboxed(cfg: Config, dest: string): boolean {
  return fs.existsSync(path.join(sysopsRoot(cfg), dest));
}

function getProjectRow(db: ShipwayDb, id: number): typeof projects.$inferSelect {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) throw new Error(`project ${String(id)} not found`);
  return row;
}

interface InsertProjectInput {
  slug: string;
  type: 'php' | 'node' | 'nextjs' | 'static';
  phpVersion?: string | null;
  nodeVersion?: string | null;
  publicDir?: string | null;
  port?: number | null;
  startCmd?: string | null;
}

function insertProject(db: ShipwayDb, input: InsertProjectInput): number {
  db.insert(projects)
    .values({
      name: input.slug,
      slug: input.slug,
      repo: 'acme/' + input.slug,
      branch: 'main',
      type: input.type,
      phpVersion: input.phpVersion ?? null,
      nodeVersion: input.nodeVersion ?? null,
      publicDir: input.publicDir ?? null,
      port: input.port ?? null,
      startCmd: input.startCmd ?? null,
      sharedPaths: [],
      autoDeploy: true,
      smtpMode: 'mailpit',
    })
    .run();
  const row = db.select({ id: projects.id }).from(projects).where(eq(projects.slug, input.slug)).get();
  if (!row) throw new Error('failed to insert test project');
  return row.id;
}

function configureSettings(db: ShipwayDb): void {
  setSetting(db, 'base_domain', 'apps.example.com');
  setSetting(db, 'server_ip', '203.0.113.10');
}

/** Strips the "(N bytes)" suffix DevSysOps appends to installFile call records, so tests can assert
 * on call shape/order without pinning exact rendered byte lengths. */
function callNames(sysops: DevSysOps): string[] {
  return sysops.calls.map((c) => c.replace(/ \(\d+ bytes\)$/, ''));
}

class RecordingDnsClient implements DnsClient {
  readonly calls: string[] = [];
  private readonly inner = new FakeDnsClient();

  async verifyToken(): Promise<boolean> {
    return this.inner.verifyToken();
  }

  async createARecord(fqdn: string, ip: string): Promise<string> {
    this.calls.push(`createARecord ${fqdn} ${ip}`);
    return this.inner.createARecord(fqdn, ip);
  }

  async findARecord(fqdn: string): Promise<string | null> {
    this.calls.push(`findARecord ${fqdn}`);
    return this.inner.findARecord(fqdn);
  }

  async deleteARecord(fqdn: string): Promise<void> {
    this.calls.push(`deleteARecord ${fqdn}`);
    return this.inner.deleteARecord(fqdn);
  }

  get records(): Map<string, string> {
    return this.inner.records;
  }
}

class FailingNginxTestSysOps extends DevSysOps {
  async nginxTest(): Promise<{ ok: boolean; output: string }> {
    this.calls.push('nginxTest');
    return { ok: false, output: 'nginx: [emerg] unexpected "}" in shipway-broken.conf' };
  }
}

class ReloadNginxFailsSysOps extends DevSysOps {
  async reloadNginx(): Promise<void> {
    this.calls.push('reloadNginx (attempted)');
    throw new Error('systemctl reload nginx: connection refused');
  }
}

describe('nodeBinDir', () => {
  it('returns /opt/node/<version>/bin outside dev mode', () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '0', SHIPWAY_DATA_DIR: tmpDataDir() });
    expect(nodeBinDir(cfg, '22')).toBe('/opt/node/22/bin');
  });

  it('returns the dirname of process.execPath in dev mode', () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    expect(nodeBinDir(cfg, '22')).toBe(path.dirname(process.execPath));
  });
});

describe('provisionProject — settings validation', () => {
  it('throws a ProvisionError step "settings" when base_domain/server_ip are unset, before touching anything', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'noconfig', type: 'static' });

    const deps: ProvisionDeps = { db, cfg, sysops, dns };

    let caught: unknown;
    try {
      await provisionProject(deps, id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProvisionError);
    expect((caught as ProvisionError).step).toBe('settings');
    expect(sysops.calls).toEqual([]);
    expect(dns.calls).toEqual([]);
  });
});

describe('provisionProject — node/nextjs', () => {
  async function provisionNodeProject(): Promise<{ cfg: Config; db: ShipwayDb; sysops: DevSysOps; dns: RecordingDnsClient; id: number }> {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'api', type: 'node', nodeVersion: '22', port: 3007, startCmd: 'node server.js' });

    await provisionProject({ db, cfg, sysops, dns }, id);

    return { cfg, db, sysops, dns, id };
  }

  it('creates the DNS A record (find-first) pointing at server_ip', async () => {
    const { dns } = await provisionNodeProject();

    expect(dns.calls).toEqual(['findARecord api.apps.example.com', 'createARecord api.apps.example.com 203.0.113.10']);
    expect(dns.records.get('api.apps.example.com')).toBe('203.0.113.10');
  });

  it('skips createARecord when an A record already exists for the domain', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    await dns.createARecord('api.apps.example.com', '203.0.113.10');
    dns.calls.length = 0; // reset the recorder, keep the underlying record
    const id = insertProject(db, { slug: 'api', type: 'node', nodeVersion: '22', port: 3007, startCmd: 'node server.js' });

    await provisionProject({ db, cfg, sysops, dns }, id);

    expect(dns.calls).toEqual(['findARecord api.apps.example.com']);
  });

  it('creates apps/<slug>/releases, apps/<slug>/shared, and logs/<slug>', async () => {
    const { cfg } = await provisionNodeProject();

    expect(fs.existsSync(path.join(cfg.appsDir, 'api', 'releases'))).toBe(true);
    expect(fs.existsSync(path.join(cfg.appsDir, 'api', 'shared'))).toBe(true);
    expect(fs.existsSync(path.join(cfg.logsDir, 'api'))).toBe(true);
  });

  it('writes the vhost to both sites-available and sites-enabled, containing the domain and a proxy_pass directive', async () => {
    const { cfg } = await provisionNodeProject();

    const available = readSandboxed(cfg, '/etc/nginx/sites-available/shipway-api.conf');
    const enabled = readSandboxed(cfg, '/etc/nginx/sites-enabled/shipway-api.conf');

    expect(available).toContain('server_name api.apps.example.com;');
    expect(available).toContain('proxy_pass http://127.0.0.1:3007;');
    expect(enabled).toBe(available);
  });

  it('runs nginxTest, reloadNginx, installs the app unit, daemonReload, then enables it, in order', async () => {
    const { sysops } = await provisionNodeProject();

    expect(callNames(sysops)).toEqual([
      'installFile /etc/nginx/sites-available/shipway-api.conf',
      'installFile /etc/nginx/sites-enabled/shipway-api.conf',
      'nginxTest',
      'reloadNginx',
      'installFile /etc/systemd/system/shipway-app-api.service',
      'daemonReload',
      'unitAction enable shipway-app-api.service',
    ]);
  });

  it('renders the app unit with the node bin dir, port, and startCmd', async () => {
    const { cfg } = await provisionNodeProject();
    const unit = readSandboxed(cfg, '/etc/systemd/system/shipway-app-api.service');

    expect(unit).toContain(`ExecStart=/bin/bash -lc 'export PATH=${nodeBinDir(cfg, '22')}:$PATH && exec node server.js'`);
    expect(unit).toContain('Environment=PORT=3007');
  });
});

describe('provisionProject — php', () => {
  it('writes a php vhost with fastcgi directives and never touches systemd', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3', publicDir: 'public' });

    await provisionProject({ db, cfg, sysops, dns }, id);

    expect(callNames(sysops)).toEqual([
      'installFile /etc/nginx/sites-available/shipway-shop.conf',
      'installFile /etc/nginx/sites-enabled/shipway-shop.conf',
      'nginxTest',
      'reloadNginx',
    ]);
    const vhost = readSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf');
    expect(vhost).toContain('fastcgi_pass unix:/run/php/php8.3-fpm.sock;');
  });
});

describe('provisionProject — static', () => {
  it('writes a static vhost and never touches systemd', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'docs', type: 'static', publicDir: '' });

    await provisionProject({ db, cfg, sysops, dns }, id);

    expect(callNames(sysops)).toEqual([
      'installFile /etc/nginx/sites-available/shipway-docs.conf',
      'installFile /etc/nginx/sites-enabled/shipway-docs.conf',
      'nginxTest',
      'reloadNginx',
    ]);
  });
});

describe('provisionProject — no dns configured', () => {
  it('skips the DNS step entirely when deps.dns is null', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const id = insertProject(db, { slug: 'docs', type: 'static', publicDir: '' });

    await expect(provisionProject({ db, cfg, sysops, dns: null }, id)).resolves.toBeUndefined();
  });
});

describe('provisionProject — nginxTest failure', () => {
  it('removes both vhost files and throws with the nginx output, without reloading nginx', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new FailingNginxTestSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'broken', type: 'static', publicDir: '' });

    let caught: unknown;
    try {
      await provisionProject({ db, cfg, sysops, dns }, id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProvisionError);
    expect((caught as ProvisionError).message).toContain('unexpected "}"');
    expect(callNames(sysops)).toEqual([
      'installFile /etc/nginx/sites-available/shipway-broken.conf',
      'installFile /etc/nginx/sites-enabled/shipway-broken.conf',
      'nginxTest',
      'removeFile /etc/nginx/sites-available/shipway-broken.conf',
      'removeFile /etc/nginx/sites-enabled/shipway-broken.conf',
    ]);
    expect(existsSandboxed(cfg, '/etc/nginx/sites-available/shipway-broken.conf')).toBe(false);
    expect(existsSandboxed(cfg, '/etc/nginx/sites-enabled/shipway-broken.conf')).toBe(false);
  });
});

describe('refreshProjectConfig', () => {
  it('re-renders and reinstalls the vhost, runs nginxTest + reloadNginx, without touching DNS or mkdirs', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3', publicDir: 'public' });
    await provisionProject({ db, cfg, sysops, dns }, id);
    sysops.calls.length = 0;
    dns.calls.length = 0;

    const previous = getProjectRow(db, id);
    db.update(projects).set({ phpVersion: '8.4' }).where(eq(projects.id, id)).run();
    await refreshProjectConfig({ db, cfg, sysops, dns }, id, previous);

    expect(dns.calls).toEqual([]);
    expect(callNames(sysops)).toEqual([
      'installFile /etc/nginx/sites-available/shipway-shop.conf',
      'installFile /etc/nginx/sites-enabled/shipway-shop.conf',
      'nginxTest',
      'reloadNginx',
    ]);
    const vhost = readSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf');
    expect(vhost).toContain('fastcgi_pass unix:/run/php/php8.4-fpm.sock;');
  });

  it('also re-renders and reinstalls the app unit for node/nextjs (daemonReload, no re-enable)', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'api', type: 'node', nodeVersion: '22', port: 3007, startCmd: 'node server.js' });
    await provisionProject({ db, cfg, sysops, dns }, id);
    sysops.calls.length = 0;

    const previous = getProjectRow(db, id);
    db.update(projects).set({ startCmd: 'node dist/server.js' }).where(eq(projects.id, id)).run();
    await refreshProjectConfig({ db, cfg, sysops, dns }, id, previous);

    expect(callNames(sysops)).toEqual([
      'installFile /etc/nginx/sites-available/shipway-api.conf',
      'installFile /etc/nginx/sites-enabled/shipway-api.conf',
      'nginxTest',
      'reloadNginx',
      'installFile /etc/systemd/system/shipway-app-api.service',
      'daemonReload',
    ]);
    const unit = readSandboxed(cfg, '/etc/systemd/system/shipway-app-api.service');
    expect(unit).toContain("exec node dist/server.js'");
  });

  it('on a failed nginxTest, restores the previous vhost content at both paths instead of deleting it (unlike fresh provisioning)', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3', publicDir: 'public' });
    await provisionProject({ db, cfg, sysops, dns }, id);
    const originalAvailable = readSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf');
    const originalEnabled = readSandboxed(cfg, '/etc/nginx/sites-enabled/shipway-shop.conf');

    const previous = getProjectRow(db, id);
    db.update(projects).set({ phpVersion: '8.4' }).where(eq(projects.id, id)).run();
    const failingSysops = new FailingNginxTestSysOps(sysopsRoot(cfg));

    let caught: unknown;
    try {
      await refreshProjectConfig({ db, cfg, sysops: failingSysops, dns }, id, previous);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProvisionError);
    // Restored, not removed: the files still exist and still hold the ORIGINAL (8.3) content — an
    // unrelated `nginx -t` failure during refresh must never take a previously-working site offline.
    expect(existsSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf')).toBe(true);
    expect(existsSandboxed(cfg, '/etc/nginx/sites-enabled/shipway-shop.conf')).toBe(true);
    expect(readSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf')).toBe(originalAvailable);
    expect(readSandboxed(cfg, '/etc/nginx/sites-enabled/shipway-shop.conf')).toBe(originalEnabled);
    expect(readSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf')).toContain('php8.3-fpm.sock');
  });
});

describe('deprovisionProject', () => {
  it('for node/nextjs: stops+disables the unit, removes unit + vhost files, reloads nginx, deletes the DNS record, removes dirs, and deletes the row', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'api', type: 'node', nodeVersion: '22', port: 3007, startCmd: 'node server.js' });
    await provisionProject({ db, cfg, sysops, dns }, id);
    sysops.calls.length = 0;
    dns.calls.length = 0;

    await deprovisionProject({ db, cfg, sysops, dns }, id);

    expect(callNames(sysops)).toEqual([
      'unitAction stop shipway-app-api.service',
      'unitAction disable shipway-app-api.service',
      'removeFile /etc/systemd/system/shipway-app-api.service',
      'removeFile /etc/nginx/sites-available/shipway-api.conf',
      'removeFile /etc/nginx/sites-enabled/shipway-api.conf',
      'reloadNginx',
    ]);
    expect(dns.calls).toEqual(['deleteARecord api.apps.example.com']);
    expect(dns.records.has('api.apps.example.com')).toBe(false);
    expect(fs.existsSync(path.join(cfg.appsDir, 'api'))).toBe(false);
    expect(fs.existsSync(path.join(cfg.logsDir, 'api'))).toBe(false);
    expect(db.select().from(projects).where(eq(projects.id, id)).get()).toBeUndefined();
  });

  it('for php/static: never touches systemd', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3', publicDir: 'public' });
    await provisionProject({ db, cfg, sysops, dns }, id);
    sysops.calls.length = 0;

    await deprovisionProject({ db, cfg, sysops, dns }, id);

    expect(callNames(sysops)).toEqual([
      'removeFile /etc/nginx/sites-available/shipway-shop.conf',
      'removeFile /etc/nginx/sites-enabled/shipway-shop.conf',
      'reloadNginx',
    ]);
  });

  it('is a no-op (does not throw) for an unknown project id', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();

    await expect(deprovisionProject({ db, cfg, sysops, dns }, 999999)).resolves.toBeUndefined();
  });

  it('best-effort: continues past a failing step (e.g. reloadNginx) and still deletes the row, DNS record, and dirs', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const provisionSysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3', publicDir: 'public' });
    await provisionProject({ db, cfg, sysops: provisionSysops, dns }, id);

    const failingSysops = new ReloadNginxFailsSysOps(sysopsRoot(cfg));

    await expect(deprovisionProject({ db, cfg, sysops: failingSysops, dns }, id)).resolves.toBeUndefined();

    expect(dns.records.has('shop.apps.example.com')).toBe(false);
    expect(fs.existsSync(path.join(cfg.appsDir, 'shop'))).toBe(false);
    expect(db.select().from(projects).where(eq(projects.id, id)).get()).toBeUndefined();
  });

  it('validates the stored slug before constructing any path, touching sysops/dns, or deleting the row', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    // Insert directly, bypassing normal slug validation, to simulate a corrupted/tampered row.
    db.insert(projects)
      .values({
        name: 'bad',
        slug: 'UPPER CASE',
        repo: 'acme/bad',
        branch: 'main',
        type: 'static',
        sharedPaths: [],
        autoDeploy: true,
        smtpMode: 'mailpit',
      })
      .run();
    const row = db.select({ id: projects.id }).from(projects).where(eq(projects.slug, 'UPPER CASE')).get();
    if (!row) throw new Error('failed to insert test project');

    await expect(deprovisionProject({ db, cfg, sysops, dns }, row.id)).rejects.toThrow();

    expect(sysops.calls).toEqual([]);
    expect(dns.calls).toEqual([]);
    expect(db.select().from(projects).where(eq(projects.id, row.id)).get()).toBeDefined();
  });
});
