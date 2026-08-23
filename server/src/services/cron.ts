/**
 * Rebuilds the managed crontab block from every `cron_jobs` row and writes it to the host. Routes
 * call `syncCrontab` after every cron job mutation (create/update/delete) so the host crontab stays
 * in lockstep with the DB.
 */
import { asc, eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { ShipwayDb } from '../db/index.js';
import { cronJobs, projects } from '../db/schema.js';
import type { SysOps } from '../sysops/types.js';
import { mergeCrontab, renderCrontabSection, type CronLine } from '../system/templates.js';

export interface CronDeps {
  db: ShipwayDb;
  sysops: SysOps;
  cfg: Config;
}

/**
 * Reads every `cron_jobs` row (joined with its project for `slug`/`phpVersion`), renders the
 * managed crontab block from them — using each job's `command` exactly as stored, since the
 * php-prefix rewrite already happened at create/update time — merges that block into whatever the
 * host crontab currently contains, and writes the result back.
 */
export async function syncCrontab(deps: CronDeps): Promise<void> {
  const rows = deps.db
    .select({
      id: cronJobs.id,
      schedule: cronJobs.schedule,
      command: cronJobs.command,
      slug: projects.slug,
      phpVersion: projects.phpVersion,
    })
    .from(cronJobs)
    .innerJoin(projects, eq(cronJobs.projectId, projects.id))
    .orderBy(asc(cronJobs.id))
    .all();

  const lines: CronLine[] = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    appsDir: deps.cfg.appsDir,
    logsDir: deps.cfg.logsDir,
    schedule: row.schedule,
    command: row.command,
  }));

  const section = renderCrontabSection(lines);
  const existing = await deps.sysops.readCrontab();
  await deps.sysops.writeCrontab(mergeCrontab(existing, section));
}

// ---------------------------------------------------------------------------
// validateCronExpr
// ---------------------------------------------------------------------------

/** Standard cron aliases accepted in place of the 5-field form. */
const CRON_ALIASES = new Set(['@hourly', '@daily', '@weekly', '@monthly', '@yearly', '@annually', '@reboot']);

interface FieldRange {
  min: number;
  max: number;
}

/** minute, hour, day-of-month, month, day-of-week — in field order. */
const FIELD_RANGES: readonly FieldRange[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
];

/** One comma-separated cron token: `*`, `N`, `N-M`, or any of those with a trailing `/step`. */
const TOKEN_RE = /^(\*|\d+(?:-\d+)?)(\/(\d+))?$/;

function inRange(n: number, range: FieldRange): boolean {
  return Number.isInteger(n) && n >= range.min && n <= range.max;
}

function validateToken(token: string, range: FieldRange): boolean {
  const m = TOKEN_RE.exec(token);
  if (!m) return false;

  const step = m[3];
  if (step !== undefined && Number(step) < 1) return false;

  const base = m[1] as string;
  if (base === '*') return true;

  if (base.includes('-')) {
    const [loStr, hiStr] = base.split('-') as [string, string];
    const lo = Number(loStr);
    const hi = Number(hiStr);
    return inRange(lo, range) && inRange(hi, range) && lo <= hi;
  }

  return inRange(Number(base), range);
}

function validateField(field: string, range: FieldRange): boolean {
  if (field === '') return false;
  return field.split(',').every((token) => validateToken(token, range));
}

/**
 * `true` iff `expr` is one of the standard `@`-aliases, or exactly 5 whitespace-separated fields
 * each matching cron token grammar (`*`, a number, a range, an optional `/step`, or a comma-list of
 * those) with values in range for that field's position (minute 0-59, hour 0-23, day-of-month 1-31,
 * month 1-12, day-of-week 0-7).
 */
export function validateCronExpr(expr: string): boolean {
  const trimmed = expr.trim();
  if (CRON_ALIASES.has(trimmed)) return true;

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;

  return fields.every((field, i) => validateField(field, FIELD_RANGES[i] as FieldRange));
}
