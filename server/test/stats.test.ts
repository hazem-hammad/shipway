import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { execa } from 'execa';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { DevSysOps } from '../src/sysops/dev.js';
import { SYSTEM_UNITS } from '../src/sysops/types.js';
import { getStats, parseDfOutput } from '../src/services/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_PACKAGE_JSON = path.resolve(__dirname, '../../package.json');

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-stats-test-'));
}

function makeCfg(): Config {
  return loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
}

function sysopsRoot(cfg: Config): string {
  return path.join(cfg.dataDir, 'system');
}

/** A stub `execa`-shaped `run` that ignores its arguments and always resolves with `stdout`. */
function stubExecRun(stdout: string): typeof execa {
  return (async () => ({ stdout, stderr: '', exitCode: 0 })) as unknown as typeof execa;
}

const LINUX_DF_FIXTURE = [
  'Filesystem     1K-blocks     Used Available Use% Mounted on',
  'tmpfs             204800        0    204800   0% /dev/shm',
  '/dev/sda1       20971520 10485760  10486000  50% /',
  '/dev/sda2        1048576   102400    946176  10% /boot',
  '',
].join('\n');

const MACOS_DF_FIXTURE = [
  'Filesystem     1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on',
  '/dev/disk3s1s1   20971520  10485760   9999999    50%  1000   2000    1%   /',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// parseDfOutput
// ---------------------------------------------------------------------------

describe('parseDfOutput', () => {
  it('parses a Linux-style `df -k /` fixture ("1K-blocks" header, multiple mounted filesystems)', () => {
    expect(parseDfOutput(LINUX_DF_FIXTURE)).toEqual({ totalGb: 20, usedGb: 10 });
  });

  it('parses a macOS-style `df -k /` fixture ("1024-blocks" header, extra inode columns before "Mounted on")', () => {
    expect(parseDfOutput(MACOS_DF_FIXTURE)).toEqual({ totalGb: 20, usedGb: 10 });
  });

  it('rounds 1K-blocks -> GB to 1 decimal place', () => {
    const stdout = ['Filesystem     1K-blocks     Used Available Use% Mounted on', '/dev/sda1        1048576   524288    500000  50% /', ''].join(
      '\n',
    );
    // 1048576 KB = 1 GiB exactly; 524288 KB = 0.5 GiB exactly.
    expect(parseDfOutput(stdout)).toEqual({ totalGb: 1, usedGb: 0.5 });
  });

  it('throws when no line for mount "/" is present', () => {
    const stdout = ['Filesystem     1K-blocks     Used Available Use% Mounted on', '/dev/sda2        1048576   102400    946176  10% /boot', ''].join(
      '\n',
    );
    expect(() => parseDfOutput(stdout)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------------

describe('getStats', () => {
  it('reports cpu/mem from node:os and disk from the parsed df output', async () => {
    const sysops = new DevSysOps(sysopsRoot(makeCfg()));

    const stats = await getStats({ sysops, execRun: stubExecRun(LINUX_DF_FIXTURE) });

    expect(stats.cpu.cores).toBe(os.cpus().length);
    expect(typeof stats.cpu.load1).toBe('number');
    expect(stats.mem.totalMb).toBe(Math.round(os.totalmem() / (1024 * 1024)));
    // `os.freemem()` is a live reading — it can shift by a few MB between getStats()'s internal call
    // and this one (GC, other processes), so assert the shape/range rather than exact equality
    // between two independent live reads.
    expect(Number.isInteger(stats.mem.usedMb)).toBe(true);
    expect(stats.mem.usedMb).toBeGreaterThan(0);
    expect(stats.mem.usedMb).toBeLessThanOrEqual(stats.mem.totalMb);
    expect(stats.disk).toEqual({ totalGb: 20, usedGb: 10, mount: '/' });
  });

  it('returns every SYSTEM_UNITS entry, "unknown" via DevSysOps, in a fixed order with display names', async () => {
    const sysops = new DevSysOps(sysopsRoot(makeCfg()));

    const stats = await getStats({ sysops, execRun: stubExecRun(LINUX_DF_FIXTURE) });

    expect(stats.services.map((s) => s.unit)).toEqual([...SYSTEM_UNITS]);
    expect(stats.services.every((s) => s.status === 'unknown')).toBe(true);
    expect(stats.services.find((s) => s.unit === 'nginx')?.name).toBe('Nginx');
    expect(stats.services.find((s) => s.unit === 'php8.3-fpm')?.name).toBe('PHP-FPM 8.3');
    expect(stats.services.find((s) => s.unit === 'mailpit')?.name).toBe('Mailpit');
  });

  it('defaults execRun to the real execa (df -k / actually runs)', async () => {
    const sysops = new DevSysOps(sysopsRoot(makeCfg()));

    const stats = await getStats({ sysops });

    expect(stats.disk.totalGb).toBeGreaterThan(0);
    expect(stats.disk.mount).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// GET /api/server/stats
// ---------------------------------------------------------------------------

function sessionCookie(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') {
    throw new Error('expected a set-cookie header in the response');
  }
  return value.split(';')[0]!;
}

const ADMIN = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct-horse-battery' };

async function buildTestApp(): Promise<{ app: FastifyInstance; cookie: string }> {
  const cfg = makeCfg();
  const sysops = new DevSysOps(sysopsRoot(cfg));
  const app = await buildApp(cfg, { sysops });

  const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
  const cookie = sessionCookie(create);

  return { app, cookie };
}

describe('GET /api/server/stats', () => {
  it('401s without a session', async () => {
    const cfg = makeCfg();
    const app = await buildApp(cfg, { sysops: new DevSysOps(sysopsRoot(cfg)) });

    const res = await app.inject({ method: 'GET', url: '/api/server/stats' });

    expect(res.statusCode).toBe(401);
  });

  it('returns cpu/mem/disk numbers, all SYSTEM_UNITS services (unknown via DevSysOps), and shipwayVersion', async () => {
    const { app, cookie } = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/server/stats', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      cpu: { cores: number; load1: number };
      mem: { totalMb: number; usedMb: number };
      disk: { totalGb: number; usedGb: number; mount: string };
      services: { name: string; unit: string; status: string }[];
      shipwayVersion: string;
    };

    expect(typeof body.cpu.cores).toBe('number');
    expect(typeof body.cpu.load1).toBe('number');
    expect(typeof body.mem.totalMb).toBe('number');
    expect(typeof body.mem.usedMb).toBe('number');
    expect(typeof body.disk.totalGb).toBe('number');
    expect(typeof body.disk.usedGb).toBe('number');
    expect(body.disk.mount).toBe('/');
    expect(body.services).toHaveLength(SYSTEM_UNITS.length);
    for (const s of body.services) {
      expect(s.status).toBe('unknown');
    }

    const rootPkg = JSON.parse(fs.readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as { version: string };
    expect(body.shipwayVersion).toBe(rootPkg.version);
  });
});
