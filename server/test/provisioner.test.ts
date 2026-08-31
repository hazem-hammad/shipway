import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { setSetting } from '../src/db/settings.js';
import { cronJobs, projects, workers } from '../src/db/schema.js';
import { loadConfig, type Config } from '../src/config.js';
import { DevSysOps } from '../src/sysops/dev.js';
import { FakeDnsClient, type DnsClient } from '../src/services/cloudflare.js';
import { syncCrontab } from '../src/services/cron.js';
import { workerInstances } from '../src/services/workers.js';
import {
  changeProjectSubdomain,
  ensureDefaultVhost,
  ProvisionError,
  deprovisionProject,
  nodeBinDir,
  phpBinDir,
  provisionProject,
  refreshProjectConfig,
  resolveDnsOutcome,
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

/** A `DnsClient` whose `findARecord` always throws — used to exercise `resolveDnsOutcome`'s
 * error-capture branch and `provisionProject`'s unchanged throw-on-DNS-failure behavior. */
class FailingDnsClient implements DnsClient {
  async verifyToken(): Promise<boolean> {
    return false;
  }
  async findARecord(): Promise<string | null> {
    throw new Error('Cloudflare findARecord failed: 503 Service Unavailable');
  }
  async createARecord(): Promise<string> {
    throw new Error('should not be called');
  }
  async deleteARecord(): Promise<void> {
    // unused
  }
}

/** Creates and finds records normally but refuses to DELETE — the one DNS failure
 * `changeProjectSubdomain` reports instead of throwing, since the project is already live on its
 * new domain by the time the old record is cleaned up. */
class UndeletableDnsClient extends RecordingDnsClient {
  override async deleteARecord(fqdn: string): Promise<void> {
    this.calls.push(`deleteARecord ${fqdn} (refused)`);
    throw new Error('Cloudflare deleteARecord failed: 403 Forbidden');
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

describe('phpBinDir', () => {
  it('returns /opt/php/<version>/bin', () => {
    expect(phpBinDir('8.3')).toBe('/opt/php/8.3/bin');
    expect(phpBinDir('8.1')).toBe('/opt/php/8.1/bin');
  });

  it('does not branch on devMode — unlike nodeBinDir, the same path is returned either way (the shim dir simply does not exist in dev, so PATH lookup falls through to the system php)', () => {
    expect(phpBinDir('8.3')).toBe('/opt/php/8.3/bin');
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
      'removeFile /etc/nginx/shipway-auth/shipway-api.htpasswd',
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
      'removeFile /etc/nginx/shipway-auth/shipway-shop.htpasswd',
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
      'removeFile /etc/nginx/shipway-auth/shipway-docs.htpasswd',
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

    await expect(provisionProject({ db, cfg, sysops, dns: null }, id)).resolves.toEqual({
      attempted: false,
      created: false,
      existed: false,
    });
  });
});

describe('resolveDnsOutcome', () => {
  it('reports attempted:false when dns is null (step skipped entirely)', async () => {
    const outcome = await resolveDnsOutcome(null, 'skip.apps.example.com', '203.0.113.10');
    expect(outcome).toEqual({ attempted: false, created: false, existed: false });
  });

  it('reports created:true when no A record exists yet', async () => {
    const dns = new RecordingDnsClient();
    const outcome = await resolveDnsOutcome(dns, 'fresh.apps.example.com', '203.0.113.10');
    expect(outcome).toEqual({ attempted: true, created: true, existed: false });
    expect(dns.records.get('fresh.apps.example.com')).toBe('203.0.113.10');
  });

  it('reports existed:true (and skips createARecord) when an A record already exists', async () => {
    const dns = new RecordingDnsClient();
    await dns.createARecord('taken.apps.example.com', '203.0.113.10');
    dns.calls.length = 0;

    const outcome = await resolveDnsOutcome(dns, 'taken.apps.example.com', '203.0.113.10');

    expect(outcome).toEqual({ attempted: true, created: false, existed: true });
    expect(dns.calls).toEqual(['findARecord taken.apps.example.com']);
  });

  it('captures a thrown DNS client error into `error` instead of throwing', async () => {
    const outcome = await resolveDnsOutcome(new FailingDnsClient(), 'broken.apps.example.com', '203.0.113.10');
    expect(outcome).toEqual({
      attempted: true,
      created: false,
      existed: false,
      error: 'Cloudflare findARecord failed: 503 Service Unavailable',
    });
  });
});

describe('provisionProject — DNS outcome return value', () => {
  it('resolves with the DNS outcome (created) on success', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'docs', type: 'static', publicDir: '' });

    const outcome = await provisionProject({ db, cfg, sysops, dns }, id);

    expect(outcome).toEqual({ attempted: true, created: true, existed: false });
  });

  it('resolves with the DNS outcome (existed) when the record was already there', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    await dns.createARecord('docs.apps.example.com', '203.0.113.10');
    const id = insertProject(db, { slug: 'docs', type: 'static', publicDir: '' });

    const outcome = await provisionProject({ db, cfg, sysops, dns }, id);

    expect(outcome).toEqual({ attempted: true, created: false, existed: true });
  });

  it('resolves with attempted:false when deps.dns is null', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const id = insertProject(db, { slug: 'docs', type: 'static', publicDir: '' });

    const outcome = await provisionProject({ db, cfg, sysops, dns: null }, id);

    expect(outcome).toEqual({ attempted: false, created: false, existed: false });
  });

  it('still throws a ProvisionError (step "dns") on a DNS failure — unchanged failure semantics, error is not swallowed into a 201-shaped return', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new FailingDnsClient();
    const id = insertProject(db, { slug: 'broken', type: 'static', publicDir: '' });

    let caught: unknown;
    try {
      await provisionProject({ db, cfg, sysops, dns }, id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProvisionError);
    expect((caught as ProvisionError).step).toBe('dns');
    expect((caught as ProvisionError).message).toContain('503 Service Unavailable');
    // Nothing past the DNS step ran.
    expect(sysops.calls).toEqual([]);
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
      'removeFile /etc/nginx/shipway-auth/shipway-broken.htpasswd',
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
      'removeFile /etc/nginx/shipway-auth/shipway-shop.htpasswd',
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
      'removeFile /etc/nginx/shipway-auth/shipway-api.htpasswd',
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
      'removeFile /etc/nginx/shipway-auth/shipway-api.htpasswd',
      'reloadNginx',
      'readCrontab',
      'writeCrontab',
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
      'removeFile /etc/nginx/shipway-auth/shipway-shop.htpasswd',
      'reloadNginx',
      'readCrontab',
      'writeCrontab',
    ]);
  });

  it('is a no-op (does not throw) for an unknown project id', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();

    await expect(deprovisionProject({ db, cfg, sysops, dns }, 999999)).resolves.toEqual({ databasesDropped: [], databasesFailed: [] });
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

    await expect(deprovisionProject({ db, cfg, sysops: failingSysops, dns }, id)).resolves.toEqual({ databasesDropped: [], databasesFailed: [] });

    expect(dns.records.has('shop.apps.example.com')).toBe(false);
    expect(fs.existsSync(path.join(cfg.appsDir, 'shop'))).toBe(false);
    expect(db.select().from(projects).where(eq(projects.id, id)).get()).toBeUndefined();
  });

  it('resyncs the crontab after deleting the project row, so orphaned cron entries are removed from the host', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3', publicDir: 'public' });
    await provisionProject({ db, cfg, sysops, dns }, id);

    db.insert(cronJobs).values({ projectId: id, schedule: '* * * * *', command: 'php8.3 artisan schedule:run' }).run();
    await syncCrontab({ db, cfg, sysops });
    const before = await sysops.readCrontab();
    expect(before).toContain('shop/current');
    expect(before).toContain('artisan schedule:run');

    await deprovisionProject({ db, cfg, sysops, dns }, id);

    const after = await sysops.readCrontab();
    expect(after).not.toContain('shop/current');
    expect(after).not.toContain('artisan schedule:run');
  });

  it('stops+disables every worker instance and removes its unit file, for every worker the project has', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3', publicDir: 'public' });
    await provisionProject({ db, cfg, sysops, dns }, id);

    db.insert(workers).values({ projectId: id, name: 'queue', command: 'php8.3 artisan queue:work', processes: 2 }).run();
    db.insert(workers).values({ projectId: id, name: 'scheduler', command: 'php8.3 artisan schedule:work', processes: 1 }).run();
    sysops.calls.length = 0;

    await deprovisionProject({ db, cfg, sysops, dns }, id);

    for (const unit of workerInstances('shop', 'queue', 2)) {
      expect(sysops.calls).toContain(`unitAction stop ${unit}`);
      expect(sysops.calls).toContain(`unitAction disable ${unit}`);
    }
    for (const unit of workerInstances('shop', 'scheduler', 1)) {
      expect(sysops.calls).toContain(`unitAction stop ${unit}`);
      expect(sysops.calls).toContain(`unitAction disable ${unit}`);
    }
    expect(sysops.calls).toContain('removeFile /etc/systemd/system/shipway-worker-shop-queue@.service');
    expect(sysops.calls).toContain('removeFile /etc/systemd/system/shipway-worker-shop-scheduler@.service');
    expect(fs.existsSync(path.join(sysopsRoot(cfg), 'etc/systemd/system/shipway-worker-shop-queue@.service'))).toBe(false);
    expect(fs.existsSync(path.join(sysopsRoot(cfg), 'etc/systemd/system/shipway-worker-shop-scheduler@.service'))).toBe(false);
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

/**
 * The catch-all vhost, installed at boot. Without it nginx has no `default_server` on 443 and serves
 * an unmatched Host from whichever project block sorts first — which is how a deleted project's
 * still-resolving wildcard subdomain ended up showing an unrelated project's site.
 */
describe('ensureDefaultVhost', () => {
  function deps(): { deps: ProvisionDeps; sysops: DevSysOps; db: ShipwayDb; cfg: Config } {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    return { deps: { db, cfg, sysops, dns: null }, sysops, db, cfg };
  }

  it('installs the catch-all to both sites-available and sites-enabled, then reloads nginx', async () => {
    const h = deps();
    setSetting(h.db, 'base_domain', 'intcore.dev');

    const result = await ensureDefaultVhost(h.deps);

    expect(result.ok).toBe(true);
    expect(h.sysops.calls.some((c) => c.startsWith('installFile /etc/nginx/sites-available/shipway-default.conf'))).toBe(true);
    expect(h.sysops.calls.some((c) => c.startsWith('installFile /etc/nginx/sites-enabled/shipway-default.conf'))).toBe(true);
    expect(h.sysops.calls).toContain('reloadNginx');

    const conf = fs.readFileSync(path.join(sysopsRoot(h.cfg), '/etc/nginx/sites-enabled/shipway-default.conf'), 'utf8');
    expect(conf).toContain('listen 443 ssl default_server;');
    expect(conf).toContain('return 404;');
  });

  it('is a no-op on a host that has not been set up yet, rather than throwing at boot', async () => {
    const h = deps(); // no base_domain

    const result = await ensureDefaultVhost(h.deps);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('base_domain');
    expect(h.sysops.calls).toEqual([]);
  });

  it('is idempotent — running it again just rewrites the same config', async () => {
    const h = deps();
    setSetting(h.db, 'base_domain', 'intcore.dev');

    await ensureDefaultVhost(h.deps);
    const first = fs.readFileSync(path.join(sysopsRoot(h.cfg), '/etc/nginx/sites-enabled/shipway-default.conf'), 'utf8');
    const result = await ensureDefaultVhost(h.deps);
    const second = fs.readFileSync(path.join(sysopsRoot(h.cfg), '/etc/nginx/sites-enabled/shipway-default.conf'), 'utf8');

    expect(result.ok).toBe(true);
    expect(second).toBe(first);
  });

  it('backs the files out when nginx rejects the config, rather than leaving nginx unable to reload', async () => {
    const h = deps();
    setSetting(h.db, 'base_domain', 'intcore.dev');
    // Simulates another `default_server` on 443 already existing (a hand-edited config).
    h.sysops.nginxTest = () => Promise.resolve({ ok: false, output: 'duplicate default server' });

    const result = await ensureDefaultVhost(h.deps);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('duplicate default server');
    expect(h.sysops.calls).toContain('removeFile /etc/nginx/sites-available/shipway-default.conf');
    expect(h.sysops.calls).toContain('removeFile /etc/nginx/sites-enabled/shipway-default.conf');
    expect(h.sysops.calls).not.toContain('reloadNginx');
  });
});

describe('changeProjectSubdomain', () => {
  it('points the new domain at this server, re-renders the vhost under it, and removes the old record', async () => {
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
    db.update(projects).set({ subdomain: 'store' }).where(eq(projects.id, id)).run();
    const result = await changeProjectSubdomain({ db, cfg, sysops, dns }, id, previous);

    expect(result).toEqual({
      domain: 'store.apps.example.com',
      previousDomain: 'shop.apps.example.com',
      dnsAttempted: true,
      created: true,
      oldRecordRemoved: true,
    });
    expect(dns.calls).toEqual([
      'findARecord store.apps.example.com',
      'createARecord store.apps.example.com 203.0.113.10',
      'findARecord shop.apps.example.com',
      'deleteARecord shop.apps.example.com',
    ]);
    expect([...dns.records.keys()]).toEqual(['store.apps.example.com']);

    // The vhost answers on the new name — but the FILE, the log paths and the app directory are all
    // still named after the slug, which does not move.
    const vhost = readSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf');
    expect(vhost).toContain('server_name store.apps.example.com;');
    expect(vhost).not.toContain('shop.apps.example.com');
    expect(vhost).toContain('access_log /var/log/nginx/shipway-shop.access.log;');
    expect(callNames(sysops)).toEqual([
      'removeFile /etc/nginx/shipway-auth/shipway-shop.htpasswd',
      'installFile /etc/nginx/sites-available/shipway-shop.conf',
      'installFile /etc/nginx/sites-enabled/shipway-shop.conf',
      'nginxTest',
      'reloadNginx',
    ]);
  });

  it('moves a project back to its slug when `subdomain` is cleared', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'shop', type: 'static' });
    db.update(projects).set({ subdomain: 'store' }).where(eq(projects.id, id)).run();
    await provisionProject({ db, cfg, sysops, dns }, id);
    expect([...dns.records.keys()]).toEqual(['store.apps.example.com']);

    const previous = getProjectRow(db, id);
    db.update(projects).set({ subdomain: null }).where(eq(projects.id, id)).run();
    const result = await changeProjectSubdomain({ db, cfg, sysops, dns }, id, previous);

    expect(result.domain).toBe('shop.apps.example.com');
    expect(result.previousDomain).toBe('store.apps.example.com');
    expect([...dns.records.keys()]).toEqual(['shop.apps.example.com']);
    expect(readSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf')).toContain('server_name shop.apps.example.com;');
  });

  it('reports `existed` without creating a second record when the new domain already has one', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'shop', type: 'static' });
    await provisionProject({ db, cfg, sysops, dns }, id);
    await dns.createARecord('store.apps.example.com', '203.0.113.10');
    dns.calls.length = 0;

    const previous = getProjectRow(db, id);
    db.update(projects).set({ subdomain: 'store' }).where(eq(projects.id, id)).run();
    const result = await changeProjectSubdomain({ db, cfg, sysops, dns }, id, previous);

    expect(result.created).toBe(false);
    expect(dns.calls).not.toContain('createARecord store.apps.example.com 203.0.113.10');
    expect(result.oldRecordRemoved).toBe(true);
  });

  it('throws step "dns" and leaves the vhost alone when the DNS step fails', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const id = insertProject(db, { slug: 'shop', type: 'static' });
    await provisionProject({ db, cfg, sysops, dns: new RecordingDnsClient() }, id);
    const before = readSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf');
    sysops.calls.length = 0;

    const previous = getProjectRow(db, id);
    db.update(projects).set({ subdomain: 'store' }).where(eq(projects.id, id)).run();

    let caught: unknown;
    try {
      await changeProjectSubdomain({ db, cfg, sysops, dns: new FailingDnsClient() }, id, previous);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProvisionError);
    expect((caught as ProvisionError).step).toBe('dns');
    expect(callNames(sysops)).toEqual([]);
    expect(readSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf')).toBe(before);
  });

  it('restores the old vhost AND deletes the record it just created when nginx -t fails', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    // Provision with a working sysops, then swap in one whose `nginx -t` fails, sharing the sandbox
    // root so the restore is asserted against the file the first one actually wrote.
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'shop', type: 'static' });
    await provisionProject({ db, cfg, sysops, dns }, id);
    const before = readSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf');
    dns.calls.length = 0;

    const previous = getProjectRow(db, id);
    db.update(projects).set({ subdomain: 'store' }).where(eq(projects.id, id)).run();

    let caught: unknown;
    try {
      await changeProjectSubdomain({ db, cfg, sysops: new FailingNginxTestSysOps(sysopsRoot(cfg)), dns }, id, previous);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProvisionError);
    expect((caught as ProvisionError).step).toBe('nginx-test');
    // Both halves of the rollback: the site is still served on its old name, and the record for the
    // domain nginx never learned about is gone again.
    expect(readSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf')).toBe(before);
    expect(readSandboxed(cfg, '/etc/nginx/sites-enabled/shipway-shop.conf')).toBe(before);
    expect([...dns.records.keys()]).toEqual(['shop.apps.example.com']);
    expect(dns.calls).toContain('deleteARecord store.apps.example.com');
  });

  it('leaves a pre-existing record for the new domain in place when nginx -t fails — it did not create it', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'shop', type: 'static' });
    await provisionProject({ db, cfg, sysops, dns }, id);
    await dns.createARecord('store.apps.example.com', '198.51.100.7');

    const previous = getProjectRow(db, id);
    db.update(projects).set({ subdomain: 'store' }).where(eq(projects.id, id)).run();

    await expect(
      changeProjectSubdomain({ db, cfg, sysops: new FailingNginxTestSysOps(sysopsRoot(cfg)), dns }, id, previous),
    ).rejects.toThrow(ProvisionError);

    expect(dns.records.get('store.apps.example.com')).toBe('198.51.100.7');
  });

  it('succeeds with a staleRecordWarning when the OLD record cannot be deleted', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new UndeletableDnsClient();
    const id = insertProject(db, { slug: 'shop', type: 'static' });
    await provisionProject({ db, cfg, sysops, dns }, id);

    const previous = getProjectRow(db, id);
    db.update(projects).set({ subdomain: 'store' }).where(eq(projects.id, id)).run();
    const result = await changeProjectSubdomain({ db, cfg, sysops, dns }, id, previous);

    // The move itself is a success — the project IS being served on its new domain.
    expect(result.domain).toBe('store.apps.example.com');
    expect(result.created).toBe(true);
    expect(result.oldRecordRemoved).toBe(false);
    expect(result.staleRecordWarning).toContain('shop.apps.example.com');
    expect(readSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf')).toContain('server_name store.apps.example.com;');
  });

  it('still moves the vhost with no DNS client configured, reporting dnsAttempted: false', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const id = insertProject(db, { slug: 'shop', type: 'static' });
    await provisionProject({ db, cfg, sysops, dns: null }, id);

    const previous = getProjectRow(db, id);
    db.update(projects).set({ subdomain: 'store' }).where(eq(projects.id, id)).run();
    const result = await changeProjectSubdomain({ db, cfg, sysops, dns: null }, id, previous);

    expect(result).toEqual({
      domain: 'store.apps.example.com',
      previousDomain: 'shop.apps.example.com',
      dnsAttempted: false,
      created: false,
      oldRecordRemoved: false,
    });
    expect(readSandboxed(cfg, '/etc/nginx/sites-available/shipway-shop.conf')).toContain('server_name store.apps.example.com;');
  });

  it('deprovisioning a moved project deletes the record for the domain it actually serves', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    configureSettings(db);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const dns = new RecordingDnsClient();
    const id = insertProject(db, { slug: 'shop', type: 'static' });
    await provisionProject({ db, cfg, sysops, dns }, id);
    const previous = getProjectRow(db, id);
    db.update(projects).set({ subdomain: 'store' }).where(eq(projects.id, id)).run();
    await changeProjectSubdomain({ db, cfg, sysops, dns }, id, previous);
    dns.calls.length = 0;

    await deprovisionProject({ db, cfg, sysops, dns }, id);

    expect(dns.calls).toContain('deleteARecord store.apps.example.com');
    expect([...dns.records.keys()]).toEqual([]);
  });
});
