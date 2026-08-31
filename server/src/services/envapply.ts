/**
 * Rendering a project's `.env` onto the host, and pushing it into whatever is already running.
 *
 * Two callers, one definition. The deploy pipeline writes `shared/.env` as one stage of building a
 * release; the Environment tab's save writes the same file against the release that is already
 * live. Before this module existed only the first of those did anything, so editing env in the
 * dashboard stored a new value in Shipway's own database and changed nothing on the machine —
 * the app kept serving the old values until someone happened to deploy.
 *
 * What makes the second path work at all is that a release's `.env` is a SYMLINK to
 * `shared/.env` (see `writeReleaseEnv` in `deploy/pipeline.ts`), so rewriting that one file is
 * already visible to the running release. Nothing here creates or moves a release.
 *
 * Who actually needs telling, per consumer, which is what `applyEnvToRunning` sequences:
 *   - php-fpm  — reloaded. A project without a cached config re-reads `.env` per request anyway,
 *                but one that ran `config:cache` does not, and the reload is cheap either way.
 *   - node/nextjs app unit — restarted. `EnvironmentFile=` is read once, at process start.
 *   - workers  — restarted, for the same reason.
 *   - cron     — nothing. Every tick is a fresh process that reads `.env` on its own.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { eq, inArray, and } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { ShipwayDb } from '../db/index.js';
import { databases, deployments, projects, workers } from '../db/schema.js';
import type { SecretBox } from '../lib/secretbox.js';
import { buildEnvFile, buildManagedVars, sqlitePath, type SesSmtpConfig, type SmtpConfig } from '../deploy/envfile.js';
import { workerInstances } from './workers.js';
import type { SysOps } from '../sysops/types.js';
import { unitNames } from '../system/templates.js';

type ProjectRow = typeof projects.$inferSelect;
type WorkerRow = typeof workers.$inferSelect;

/**
 * The slice of the pipeline's dependencies this module needs. `PipelineDeps` satisfies it
 * structurally, so the deploy path passes its own `deps` straight through with no adapter.
 */
export interface EnvApplyDeps {
  cfg: Config;
  db: ShipwayDb;
  sysops: SysOps;
  secretBox: SecretBox;
}

/** Decodes the project's stored SMTP blob. One blob holds whichever mode's config was last saved
 * (`custom`'s host/port or `ses`'s region/credentials), so it's returned untyped and assigned to the
 * field matching the CURRENT mode by the caller — a blob left over from a previous mode is then
 * ignored rather than misread as the other shape. */
function decryptSmtpConfig(secretBox: SecretBox, project: ProjectRow): unknown {
  if (!project.smtpConfigEncrypted) {
    return undefined;
  }
  return JSON.parse(secretBox.decrypt(project.smtpConfigEncrypted)) as unknown;
}

/**
 * The SQLite file a php project with NO database falls back to, or `undefined` when it has one (or
 * isn't php).
 *
 * Decided from the `databases` table rather than from the env text, so attaching a real database
 * later simply stops the managed `DB_DATABASE` being written — there is nothing to undo by hand. A
 * user-defined `DB_DATABASE` suppresses it either way (`buildEnvFile` filters managed vars down to
 * the keys the user hasn't set).
 */
export function sqliteFallbackPath(deps: Pick<EnvApplyDeps, 'cfg' | 'db'>, project: ProjectRow): string | undefined {
  if (project.type !== 'php') return undefined;
  const linked = deps.db.select({ id: databases.id }).from(databases).where(eq(databases.projectId, project.id)).all();
  return linked.length > 0 ? undefined : sqlitePath(deps.cfg.appsDir, project.slug);
}

/** The exact text `shared/.env` should hold: the user's own env, plus the managed block Shipway
 * renders from the project's SMTP mode and its SQLite fallback. Pure — nothing is read from or
 * written to disk. */
export function renderProjectEnv(deps: Pick<EnvApplyDeps, 'cfg' | 'db' | 'secretBox'>, project: ProjectRow): string {
  const userEnv = project.envEncrypted ? deps.secretBox.decrypt(project.envEncrypted) : '';
  const decoded = decryptSmtpConfig(deps.secretBox, project);
  const managed = buildManagedVars({
    smtpMode: project.smtpMode,
    smtpConfig: project.smtpMode === 'custom' ? (decoded as SmtpConfig | undefined) : undefined,
    sesConfig: project.smtpMode === 'ses' ? (decoded as SesSmtpConfig | undefined) : undefined,
    sqliteDatabasePath: sqliteFallbackPath(deps, project),
  });
  return buildEnvFile(userEnv, managed);
}

export function projectDir(cfg: Config, project: ProjectRow): string {
  return path.join(cfg.appsDir, project.slug);
}

export function sharedEnvPath(cfg: Config, project: ProjectRow): string {
  return path.join(projectDir(cfg, project), 'shared', '.env');
}

/** Writes `shared/.env`, creating `shared/` if it isn't there yet. Returns the path written. */
export function writeSharedEnv(deps: EnvApplyDeps, project: ProjectRow): string {
  const envPath = sharedEnvPath(deps.cfg, project);
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, renderProjectEnv(deps, project), 'utf8');

  // SQLite refuses to open a file that doesn't exist ("Database file at path ... does not exist"),
  // so the build's `php artisan migrate --force` would fail on a project's first deploy. Created
  // empty, and only ever created: an existing file — the project's actual data — is left untouched.
  const sqliteFile = sqliteFallbackPath(deps, project);
  if (sqliteFile !== undefined && !fs.existsSync(sqliteFile)) {
    fs.writeFileSync(sqliteFile, '');
  }

  return envPath;
}

/** Every worker row belonging to `projectId`. */
export function projectWorkers(db: ShipwayDb, projectId: number): WorkerRow[] {
  return db.select().from(workers).where(eq(workers.projectId, projectId)).all();
}

/**
 * Reloads/restarts whatever serves this project's requests: php-fpm for a php project, the app
 * unit for node/nextjs, nothing at all for static (nginx serves the files directly, and there is
 * no process holding an old environment).
 *
 * `signal` is optional and deliberately NOT passed by the pipeline's rollback path
 * (`handlePostActivateFailure`): that call must run to completion and restore the previous release
 * even when `signal` is already aborted — a `cancelSignal` that's already fired would immediately
 * kill it. The forward activate→restart path does pass it, so a genuinely-hung restart is still
 * interruptible, and (per `sysops/real.ts`'s `unitAction`/`reloadPhpFpm`) a failure caused by that
 * abort throws `AbortedError` specifically, distinguishable from an unrelated restart failure that
 * merely coincides with a cancel.
 */
export async function restartRuntime(deps: EnvApplyDeps, project: ProjectRow, signal?: AbortSignal): Promise<void> {
  switch (project.type) {
    case 'php': {
      if (!project.phpVersion) {
        throw new Error(`project "${project.slug}" has no phpVersion configured`);
      }
      await deps.sysops.reloadPhpFpm(project.phpVersion, signal);
      return;
    }
    case 'node':
    case 'nextjs':
      await deps.sysops.unitAction('restart', unitNames.app(project.slug), signal);
      return;
    case 'static':
      return;
  }
}

/** Restarts every instance of every worker in `rows`. See `restartRuntime`'s doc comment for why
 * `signal` is optional and omitted by the rollback path. */
export async function restartWorkers(deps: EnvApplyDeps, project: ProjectRow, rows: WorkerRow[], signal?: AbortSignal): Promise<void> {
  for (const worker of rows) {
    for (const unit of workerInstances(project.slug, worker.name, worker.processes)) {
      await deps.sysops.unitAction('restart', unit, signal);
    }
  }
}

/** Statuses that mean a deploy is going to write `shared/.env` itself, at a moment of its choosing. */
const IN_FLIGHT_STATUSES = ['queued', 'running'] as const;

/** True while this project has a queued or running deployment. */
function deployInFlight(db: ShipwayDb, projectId: number): boolean {
  const row = db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.projectId, projectId), inArray(deployments.status, [...IN_FLIGHT_STATUSES])))
    .get();
  return row !== undefined;
}

/** Why `applyEnvToRunning` declined to touch the host. */
export type ApplyEnvSkipReason =
  /** Nothing has been deployed, so there is no `current` release for a new `.env` to reach. */
  | 'never-deployed'
  /** A deploy is queued or running and will write `shared/.env` itself; racing it would mean two
   * writers on one file and a restart against a release that is about to be replaced. */
  | 'deploy-in-flight';

export interface ApplyEnvResult {
  /** Whether `shared/.env` was rewritten and the running processes told about it. */
  applied: boolean;
  /** Set only when `applied` is false. */
  reason?: ApplyEnvSkipReason;
  /** How many worker instances were restarted. Zero is a normal answer — most projects have none. */
  workersRestarted: number;
  /**
   * Set when the file was written but a reload/restart failed. The new env IS on disk and will be
   * picked up by the next restart or deploy, so this is reported rather than thrown: losing the
   * saved env because a systemd unit was wedged would be the worse of the two outcomes.
   */
  restartError?: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Writes the project's current stored env to `shared/.env` and pushes it into the running release.
 * Never throws: a restart failure comes back in `restartError`, and the two cases where touching
 * the host would be wrong come back as `applied: false` with a `reason`.
 */
export async function applyEnvToRunning(deps: EnvApplyDeps, project: ProjectRow): Promise<ApplyEnvResult> {
  // No `current` symlink means nothing has ever been deployed. Writing `shared/.env` now would be
  // harmless, but "applied" would be a lie — there is no running release holding old values, and
  // the first deploy rewrites this file anyway.
  if (!fs.existsSync(path.join(projectDir(deps.cfg, project), 'current'))) {
    return { applied: false, reason: 'never-deployed', workersRestarted: 0 };
  }
  if (deployInFlight(deps.db, project.id)) {
    return { applied: false, reason: 'deploy-in-flight', workersRestarted: 0 };
  }

  writeSharedEnv(deps, project);

  const rows = projectWorkers(deps.db, project.id);
  const workersRestarted = rows.reduce((total, row) => total + row.processes, 0);
  try {
    await restartRuntime(deps, project);
    await restartWorkers(deps, project, rows);
  } catch (err) {
    return { applied: true, workersRestarted: 0, restartError: errMessage(err) };
  }

  return { applied: true, workersRestarted };
}
