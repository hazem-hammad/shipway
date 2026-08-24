/**
 * Snapshot of the host's resource usage and the status of the fixed set of shared system services
 * (nginx, php-fpm per version, mysql, postgresql, redis, mailpit) that `GET /api/server/stats`
 * exposes. cpu/mem come from `node:os`; disk comes from shelling out to `df -k /`.
 */
import { execa } from 'execa';
import * as os from 'node:os';
import type { SysOps, UnitStatus } from '../sysops/types.js';
import { SYSTEM_UNITS, type SystemUnit } from '../sysops/types.js';

const BYTES_PER_MB = 1024 * 1024;
const KB_PER_GB = 1024 * 1024; // 1K-blocks per binary GB (matches mem's MiB-based "Mb" convention).

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Parses the output of `df -k /` into `{totalGb, usedGb}` (1K-blocks converted to binary GB, 1
 * decimal place). Tolerant of both the Linux (`1K-blocks`) and macOS (`1024-blocks`, extra inode
 * columns before `Mounted on`) column layouts: it locates the data line whose LAST
 * whitespace-separated field is exactly `/` (the mount point), then reads that line's 2nd and 3rd
 * fields (1K-blocks, Used) — both layouts agree on those two columns' position and content.
 */
export function parseDfOutput(stdout: string): { totalGb: number; usedGb: number } {
  const lines = stdout.split('\n').slice(1); // skip the header line
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    const fields = line.split(/\s+/);
    if (fields[fields.length - 1] !== '/') continue;

    const totalKb = Number(fields[1]);
    const usedKb = Number(fields[2]);
    if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb)) {
      throw new Error(`df -k /: could not parse blocks/used from line: "${line}"`);
    }
    return { totalGb: round1(totalKb / KB_PER_GB), usedGb: round1(usedKb / KB_PER_GB) };
  }
  throw new Error('df -k /: no line found for mount "/"');
}

/** Display name + unit for each of `SYSTEM_UNITS`, in the fixed order `getStats` reports them.
 * Exported so `services/servicewatch.ts` (Task 4's poller) can reuse the same display names in its
 * `service_down`/`service_recovered` bus messages instead of duplicating the map. */
export const SERVICE_NAMES: Record<SystemUnit, string> = {
  nginx: 'Nginx',
  'php8.1-fpm': 'PHP-FPM 8.1',
  'php8.2-fpm': 'PHP-FPM 8.2',
  'php8.3-fpm': 'PHP-FPM 8.3',
  'php8.4-fpm': 'PHP-FPM 8.4',
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  'redis-server': 'Redis',
  mailpit: 'Mailpit',
};

export interface StatsDeps {
  sysops: SysOps;
  /** Test-only override for the `df -k /` invocation; defaults to the real `execa`. */
  execRun?: typeof execa;
}

export interface ServerStats {
  cpu: { cores: number; load1: number };
  mem: { totalMb: number; usedMb: number };
  disk: { totalGb: number; usedGb: number; mount: '/' };
  services: { name: string; unit: SystemUnit; status: UnitStatus }[];
}

/**
 * Builds a `ServerStats` snapshot: cpu/mem read synchronously from `node:os`, disk from `df -k /`
 * (via `deps.execRun`, defaulting to the real `execa`) parsed by `parseDfOutput`, and the status of
 * every unit in `SYSTEM_UNITS` via `deps.sysops.systemUnitStatus`.
 */
export async function getStats(deps: StatsDeps): Promise<ServerStats> {
  const run = deps.execRun ?? execa;

  const cpu = { cores: os.cpus().length, load1: round2(os.loadavg()[0] ?? 0) };

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const mem = {
    totalMb: Math.round(totalMem / BYTES_PER_MB),
    usedMb: Math.round((totalMem - freeMem) / BYTES_PER_MB),
  };

  const dfResult = await run('df', ['-k', '/']);
  const disk = { ...parseDfOutput(dfResult.stdout), mount: '/' as const };

  const services: ServerStats['services'] = [];
  for (const unit of SYSTEM_UNITS) {
    services.push({ name: SERVICE_NAMES[unit], unit, status: await deps.sysops.systemUnitStatus(unit) });
  }

  return { cpu, mem, disk, services };
}
