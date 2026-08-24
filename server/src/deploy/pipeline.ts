/**
 * The deploy pipeline: resolve a commit, export it into a fresh release, wire up shared
 * paths/`.env`, run the project's scripts, atomically activate the release, restart the runtime,
 * health-check it, run the post-deploy script, and prune old releases.
 *
 * `runDeploy` never throws — every failure path (pre-activate, post-activate, cancellation, or a
 * genuinely unexpected error) is caught, logged, persisted to the `deployments` row, and turned
 * into a `'success' | 'failed' | 'canceled'` return value. Each pipeline stage is a small named
 * function below; `runDeploy` and its two phase functions (`runBuildPhase`, `runPostActivate`)
 * just sequence them and decide what happens on failure.
 *
 * Trigger `'rollback'`: the deployment row already has `releasePath` set (picked by the caller) —
 * `resolve`/`export`/`shared`/`env`/`pre_deploy`/`build` are all skipped entirely and the pipeline
 * jumps straight to `activate`, then runs `restart`/`health`/`post_deploy` as normal against that
 * existing release directory.
 */
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import { connect } from 'node:net';
import * as path from 'node:path';
import type { Config } from '../config.js';
import type { ShipwayDb } from '../db/index.js';
import { deployments, projects, workers } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import type { SecretBox } from '../lib/secretbox.js';
import type { GitOps } from '../services/git.js';
import { nodeBinDir, phpBinDir } from '../services/provisioner.js';
import { workerInstances } from '../services/workers.js';
import type { SysOps } from '../sysops/types.js';
import { unitNames } from '../system/templates.js';
import { buildEnvFile, buildManagedVars, type SmtpConfig } from './envfile.js';
import type { DeployLogger } from './logger.js';

type DeploymentRow = typeof deployments.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type WorkerRow = typeof workers.$inferSelect;

export interface PipelineDeps {
  cfg: Config;
  db: ShipwayDb;
  sysops: SysOps;
  gitOps: GitOps;
  secretBox: SecretBox;
  /** Resolves a project's clone URL: `repoUrl` (Task 8's Git-URL source) verbatim when set, else
   * `repo` (`"owner/name"`) to an authenticated GitHub App clone URL. */
  getCloneUrl: (repo: string, repoUrl: string | null) => Promise<string>;
  runShell: (
    cmd: string,
    opts: { cwd: string; env: Record<string, string>; signal: AbortSignal; onOutput: (s: string) => void },
  ) => Promise<{ exitCode: number }>;
  /** Health-check GET (injectable so tests avoid the network). */
  fetchHttp: (url: string) => Promise<{ status: number }>;
  notify: (p: {
    project: string;
    status: 'success' | 'failed';
    deploymentId: number;
    message: string;
    /** Set on a post-activate failure whose rollback attempt succeeded (see
     * `handlePostActivateFailure`) — lets the caller (app.ts's notify wiring) emit `deploy_rolled_back`
     * instead of `deploy_failed` on the notification bus. Unset for a plain failure or a pre-activate
     * one, where nothing was ever rolled back. */
    rolledBack?: boolean;
  }) => Promise<void>;
  /** Injectable delay, used between health-check retries. Tests pass an instant stub. */
  sleep: (ms: number) => Promise<void>;
  /** Waits for a node-like app's port to accept connections. Defaults to a real TCP-connect poll. */
  waitForPort?: (port: number, timeoutMs: number) => Promise<boolean>;
}

/** Thrown by a script stage (`pre_deploy`/`install`/`build`/`post_deploy`) on a non-zero exit. */
class StageError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
  ) {
    super(message);
    this.name = 'StageError';
  }
}

/** Thrown internally when `signal.aborted` is observed at a stage boundary. */
class AbortedError extends Error {
  constructor() {
    super('deploy canceled');
    this.name = 'AbortedError';
  }
}

/** Thrown internally when the health check exhausts its retries. */
class HealthCheckFailedError extends Error {
  constructor() {
    super('health check failed');
    this.name = 'HealthCheckFailedError';
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AbortedError();
  }
}

// ---------------------------------------------------------------------------
// db helpers
// ---------------------------------------------------------------------------

function getDeploymentOrThrow(db: ShipwayDb, id: number): DeploymentRow {
  const row = db.select().from(deployments).where(eq(deployments.id, id)).get();
  if (!row) {
    throw new Error(`deployment ${String(id)} not found`);
  }
  return row;
}

function getProjectOrThrow(db: ShipwayDb, id: number): ProjectRow {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) {
    throw new Error(`project ${String(id)} not found`);
  }
  return row;
}

function patchDeployment(db: ShipwayDb, id: number, patch: Partial<DeploymentRow>): void {
  db.update(deployments).set(patch).where(eq(deployments.id, id)).run();
}

// ---------------------------------------------------------------------------
// small pure/fs helpers
// ---------------------------------------------------------------------------

function isNodeLike(type: ProjectRow['type']): type is 'node' | 'nextjs' {
  return type === 'node' || type === 'nextjs';
}

/** `YYYYMMDD_HHMMSS`, UTC, of `now` — lexicographically sortable in release/creation order. */
function releaseTimestamp(now: Date): string {
  const iso = now.toISOString(); // e.g. 2026-08-23T14:05:09.123Z
  const date = iso.slice(0, 10).replace(/-/g, '');
  const time = iso.slice(11, 19).replace(/:/g, '');
  return `${date}_${time}`;
}

/**
 * (Re)creates the symlink `<linkPath>` -> `target`, removing anything already at `linkPath` first
 * (dir or file) and creating `linkPath`'s parent directory if needed.
 */
function replaceSymlink(linkPath: string, target: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(target, linkPath);
}

/** Symlinks each `sharedPaths` entry from `<projectDir>/shared/<entry>` into `releaseDir/<entry>`. */
function linkSharedPaths(projectDir: string, project: ProjectRow, releaseDir: string): void {
  const sharedDir = path.join(projectDir, 'shared');
  for (const entry of project.sharedPaths) {
    const target = path.join(sharedDir, entry);
    fs.mkdirSync(target, { recursive: true }); // mkdir -p, no-op if it already exists
    replaceSymlink(path.join(releaseDir, entry), target);
  }
}

/** Decrypts and JSON-parses `project.smtpConfigEncrypted`, or `undefined` if unset. */
function decryptSmtpConfig(secretBox: SecretBox, project: ProjectRow): SmtpConfig | undefined {
  if (!project.smtpConfigEncrypted) {
    return undefined;
  }
  return JSON.parse(secretBox.decrypt(project.smtpConfigEncrypted)) as SmtpConfig;
}

/** Writes `shared/.env` (decrypted user env + managed block) and symlinks it into the release. */
function writeReleaseEnv(deps: PipelineDeps, project: ProjectRow, projectDir: string, releaseDir: string): void {
  const sharedDir = path.join(projectDir, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });

  const userEnv = project.envEncrypted ? deps.secretBox.decrypt(project.envEncrypted) : '';
  const smtpConfig = decryptSmtpConfig(deps.secretBox, project);
  const managed = buildManagedVars({ smtpMode: project.smtpMode, smtpConfig });
  const content = buildEnvFile(userEnv, managed);

  const envPath = path.join(sharedDir, '.env');
  fs.writeFileSync(envPath, content, 'utf8');
  replaceSymlink(path.join(releaseDir, '.env'), envPath);
}

/** Matches a `KEY=value` line; leading whitespace allowed, comments never match. */
const ENV_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Simple line parser for the release's final `.env` content: splits `KEY=value` pairs (comments
 * and non-matching lines ignored) and strips a single layer of surrounding quotes, unescaping
 * `\"`/`\\` inside a double-quoted value (the inverse of `envfile.ts`'s `formatAssignment`).
 */
function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = ENV_LINE_RE.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1] as string;
    let value = match[2] as string;
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Builds the environment for `runShell`: `process.env`, with `PATH` prefixed by the project's node
 * bin dir for node-like projects or its php version's shim dir for php projects (see
 * `services/provisioner.ts`'s `nodeBinDir`/`phpBinDir`), then every `KEY=value` pair parsed from the
 * release's final `.env` content, then (node-like only) `PORT` set from the project's assigned port.
 */
function buildShellEnv(cfg: Config, project: ProjectRow, envFileContent: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (isNodeLike(project.type)) {
    const prefix = nodeBinDir(cfg, project.nodeVersion ?? '22');
    env.PATH = env.PATH ? `${prefix}:${env.PATH}` : prefix;
  } else if (project.type === 'php' && project.phpVersion) {
    const prefix = phpBinDir(project.phpVersion);
    env.PATH = env.PATH ? `${prefix}:${env.PATH}` : prefix;
  }

  for (const [key, value] of Object.entries(parseEnvContent(envFileContent))) {
    env[key] = value;
  }

  if (isNodeLike(project.type) && project.port !== null) {
    env.PORT = String(project.port);
  }

  return env;
}

/** Reads `releaseDir/.env` (following the symlink `writeReleaseEnv` set up) or `''` if absent. */
function readReleaseEnvContent(releaseDir: string): string {
  const envPath = path.join(releaseDir, '.env');
  if (!fs.existsSync(envPath)) {
    return '';
  }
  return fs.readFileSync(envPath, 'utf8');
}

function buildShellEnvFromRelease(cfg: Config, project: ProjectRow, releaseDir: string): Record<string, string> {
  return buildShellEnv(cfg, project, readReleaseEnvContent(releaseDir));
}

/** Runs `script` (a no-op if empty/null) via `deps.runShell`; throws `StageError(stage, ...)` on a non-zero exit. */
async function runScript(
  deps: PipelineDeps,
  stage: string,
  script: string | null,
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
  logger: DeployLogger,
): Promise<void> {
  if (!script) {
    return;
  }
  const { exitCode } = await deps.runShell(script, { cwd, env, signal, onOutput: (s) => { logger.line(s); } });
  if (exitCode !== 0) {
    throw new StageError(stage, `${stage} script exited with code ${String(exitCode)}`);
  }
}

/**
 * Atomically points `<projectDir>/current` at `releaseDir` (`ln -sfn` + `mv -T` via a temp symlink
 * + rename). Returns the path `current` pointed at before the switch, or `null` if it didn't exist.
 */
function activateRelease(projectDir: string, releaseDir: string): string | null {
  const currentPath = path.join(projectDir, 'current');
  const tmpPath = path.join(projectDir, 'current.tmp');

  let previous: string | null;
  try {
    previous = fs.readlinkSync(currentPath);
  } catch {
    previous = null;
  }

  fs.rmSync(tmpPath, { force: true });
  fs.symlinkSync(releaseDir, tmpPath);
  fs.renameSync(tmpPath, currentPath);

  return previous;
}

async function restartRuntime(deps: PipelineDeps, project: ProjectRow): Promise<void> {
  switch (project.type) {
    case 'php': {
      if (!project.phpVersion) {
        throw new Error(`project "${project.slug}" has no phpVersion configured`);
      }
      await deps.sysops.reloadPhpFpm(project.phpVersion);
      return;
    }
    case 'node':
    case 'nextjs':
      await deps.sysops.unitAction('restart', unitNames.app(project.slug));
      return;
    case 'static':
      return;
  }
}

function getProjectWorkers(db: ShipwayDb, projectId: number): WorkerRow[] {
  return db.select().from(workers).where(eq(workers.projectId, projectId)).all();
}

/** Restarts every instance of every worker in `rows`. */
async function restartWorkers(deps: PipelineDeps, project: ProjectRow, rows: WorkerRow[]): Promise<void> {
  for (const worker of rows) {
    for (const unit of workerInstances(project.slug, worker.name, worker.processes)) {
      await deps.sysops.unitAction('restart', unit);
    }
  }
}

const HEALTH_CHECK_TRIES = 5;
const HEALTH_CHECK_INTERVAL_MS = 3000;
const WAIT_FOR_PORT_TIMEOUT_MS = 15000;

function defaultWaitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    function attempt(): void {
      const socket = connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          resolve(false);
        } else {
          setTimeout(attempt, 500);
        }
      });
    }
    attempt();
  });
}

/**
 * `healthCheckPath` set: polls the URL (node-like: `http://127.0.0.1:<port><path>`; php/static:
 * `https://<slug>.<baseDomain><path>`) up to 5 times, 3s apart, accepting any 2xx/3xx status.
 * Unset, node-like: waits up to 15s for the port to accept connections. Unset, php/static: skipped
 * (always healthy).
 */
async function runHealthCheck(deps: PipelineDeps, project: ProjectRow): Promise<boolean> {
  if (project.healthCheckPath) {
    const url = isNodeLike(project.type)
      ? `http://127.0.0.1:${String(project.port)}${project.healthCheckPath}`
      : `https://${project.slug}.${getSetting<string>(deps.db, 'base_domain') ?? ''}${project.healthCheckPath}`;

    for (let attempt = 1; attempt <= HEALTH_CHECK_TRIES; attempt++) {
      try {
        const res = await deps.fetchHttp(url);
        if (res.status >= 200 && res.status < 400) {
          return true;
        }
      } catch {
        // network error on this attempt — fall through and retry
      }
      if (attempt < HEALTH_CHECK_TRIES) {
        await deps.sleep(HEALTH_CHECK_INTERVAL_MS);
      }
    }
    return false;
  }

  if (isNodeLike(project.type)) {
    if (project.port === null) {
      return false;
    }
    const waitForPort = deps.waitForPort ?? defaultWaitForPort;
    return waitForPort(project.port, WAIT_FOR_PORT_TIMEOUT_MS);
  }

  return true; // php/static without a health check path: nothing to check
}

/** Keeps the 5 newest release directories, deleting the rest — never the one `current` points at. */
function pruneReleases(projectDir: string): void {
  const releasesDir = path.join(projectDir, 'releases');
  if (!fs.existsSync(releasesDir)) {
    return;
  }

  let currentTarget: string | null;
  try {
    currentTarget = fs.readlinkSync(path.join(projectDir, 'current'));
  } catch {
    currentTarget = null;
  }
  const currentResolved = currentTarget ? path.resolve(currentTarget) : null;

  const names = fs.readdirSync(releasesDir).sort().reverse(); // timestamp names sort chronologically
  const keep = new Set(names.slice(0, 5));

  for (const name of names) {
    if (keep.has(name)) {
      continue;
    }
    const full = path.join(releasesDir, name);
    if (currentResolved !== null && path.resolve(full) === currentResolved) {
      continue;
    }
    fs.rmSync(full, { recursive: true, force: true });
  }
}

async function notifySafe(
  deps: PipelineDeps,
  logger: DeployLogger,
  payload: { project: string; status: 'success' | 'failed'; deploymentId: number; message: string; rolledBack?: boolean },
): Promise<void> {
  try {
    await deps.notify(payload);
  } catch (err) {
    logger.line(`notify failed: ${errMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// phases
// ---------------------------------------------------------------------------

/**
 * `resolve` -> `export` -> `shared` -> `env` -> `pre_deploy` -> `build` (install + build). On any
 * failure (including cancellation), deletes the release directory if one was created, then
 * rethrows for the caller to classify (failed vs. canceled).
 */
async function runBuildPhase(
  deps: PipelineDeps,
  logger: DeployLogger,
  signal: AbortSignal,
  project: ProjectRow,
  projectDir: string,
  deploymentId: number,
): Promise<{ releaseDir: string; commitMessage: string }> {
  let releaseDir: string | null = null;

  try {
    logger.section('resolve');
    checkAborted(signal);
    const url = await deps.getCloneUrl(project.repo, project.repoUrl);
    const { sha, message } = await deps.gitOps.fetchBranchTip(projectDir, url, project.branch);
    patchDeployment(deps.db, deploymentId, { commitSha: sha, commitMessage: message });

    logger.section('export');
    checkAborted(signal);
    releaseDir = path.join(projectDir, 'releases', releaseTimestamp(new Date()));
    await deps.gitOps.exportRelease(projectDir, sha, releaseDir);
    patchDeployment(deps.db, deploymentId, { releasePath: releaseDir });

    logger.section('shared');
    checkAborted(signal);
    linkSharedPaths(projectDir, project, releaseDir);

    logger.section('env');
    checkAborted(signal);
    writeReleaseEnv(deps, project, projectDir, releaseDir);

    const shellEnv = buildShellEnvFromRelease(deps.cfg, project, releaseDir);

    logger.section('pre_deploy');
    checkAborted(signal);
    await runScript(deps, 'pre_deploy', project.preDeployScript, releaseDir, shellEnv, signal, logger);

    logger.section('build');
    checkAborted(signal);
    await runScript(deps, 'install', project.installCmd, releaseDir, shellEnv, signal, logger);
    await runScript(deps, 'build', project.buildCmd, releaseDir, shellEnv, signal, logger);

    return { releaseDir, commitMessage: message };
  } catch (err) {
    if (releaseDir) {
      fs.rmSync(releaseDir, { recursive: true, force: true });
    }
    throw err;
  }
}

/** Pre-activate failure/cancellation: status `canceled` if aborted, else `failed`; notify (unless canceled); close the logger. */
async function handlePreActivateFailure(
  deps: PipelineDeps,
  logger: DeployLogger,
  signal: AbortSignal,
  project: ProjectRow,
  deploymentId: number,
  err: unknown,
): Promise<'failed' | 'canceled'> {
  const message = errMessage(err);
  logger.line(`ERROR: ${message}`);
  const finishedAt = Date.now();

  if (signal.aborted) {
    patchDeployment(deps.db, deploymentId, { status: 'canceled', finishedAt });
    logger.close();
    return 'canceled';
  }

  patchDeployment(deps.db, deploymentId, { status: 'failed', finishedAt });
  await notifySafe(deps, logger, { project: project.slug, status: 'failed', deploymentId, message });
  logger.close();
  return 'failed';
}

/**
 * Any failure from `activate` onward through the health check (thrown error, or the health check
 * itself failing): attempts to roll the `current` symlink back to `previousReleasePath` (if any)
 * and restart the runtime, then always marks the deployment `failed` (never `canceled` — code may
 * already be live, so cancellation isn't a coherent outcome once we're past `activate`).
 */
async function handlePostActivateFailure(
  deps: PipelineDeps,
  logger: DeployLogger,
  project: ProjectRow,
  projectDir: string,
  deploymentId: number,
  previousReleasePath: string | null,
  err: unknown,
): Promise<'failed'> {
  const message = errMessage(err);
  logger.line(`ERROR: ${message}`);

  let rolledBack = false;
  if (previousReleasePath) {
    try {
      logger.section('rollback');
      activateRelease(projectDir, previousReleasePath);
      await restartRuntime(deps, project);
      logger.line('rolled back to previous release');
      rolledBack = true;
    } catch (rollbackErr) {
      logger.line(`rollback failed: ${errMessage(rollbackErr)}`);
    }
  }

  const finishedAt = Date.now();
  patchDeployment(deps.db, deploymentId, { status: 'failed', finishedAt });
  await notifySafe(deps, logger, { project: project.slug, status: 'failed', deploymentId, message, rolledBack: rolledBack || undefined });
  logger.close();
  return 'failed';
}

/**
 * `activate` -> `restart` -> `health` (failure here rolls back and returns early) -> `post_deploy`
 * (failure here does NOT roll back) -> `prune` -> persist final status + notify.
 */
async function runPostActivate(
  deps: PipelineDeps,
  logger: DeployLogger,
  signal: AbortSignal,
  project: ProjectRow,
  projectDir: string,
  releaseDir: string,
  deploymentId: number,
  commitMessage: string | null,
): Promise<'success' | 'failed' | 'canceled'> {
  let previousReleasePath: string | null = null;
  let activated = false;

  try {
    logger.section('activate');
    checkAborted(signal);
    previousReleasePath = activateRelease(projectDir, releaseDir);
    activated = true;

    logger.section('restart');
    checkAborted(signal);
    await restartRuntime(deps, project);

    const workerRows = getProjectWorkers(deps.db, project.id);
    if (workerRows.length > 0) {
      logger.section('workers');
      checkAborted(signal);
      await restartWorkers(deps, project, workerRows);
    }

    logger.section('health');
    checkAborted(signal);
    const healthy = await runHealthCheck(deps, project);
    if (!healthy) {
      throw new HealthCheckFailedError();
    }
  } catch (err) {
    // An abort observed at the very first stage boundary, before `activate` actually ran: `current`
    // was never touched, so this is indistinguishable from a pre-activate cancellation — report it
    // the same way, rather than as a 'failed' deploy with a (no-op) rollback attempt.
    if (!activated && signal.aborted) {
      logger.line(`ERROR: ${errMessage(err)}`);
      patchDeployment(deps.db, deploymentId, { status: 'canceled', finishedAt: Date.now() });
      logger.close();
      return 'canceled';
    }
    return await handlePostActivateFailure(deps, logger, project, projectDir, deploymentId, previousReleasePath, err);
  }

  let result: 'success' | 'failed' = 'success';
  let failureMessage = '';
  try {
    logger.section('post_deploy');
    const shellEnv = buildShellEnvFromRelease(deps.cfg, project, releaseDir);
    await runScript(deps, 'post_deploy', project.postDeployScript, releaseDir, shellEnv, signal, logger);
  } catch (err) {
    result = 'failed';
    failureMessage = errMessage(err);
    logger.line(`post_deploy failed (code stays live, not rolled back): ${failureMessage}`);
  }

  logger.section('prune');
  pruneReleases(projectDir);

  const finishedAt = Date.now();
  patchDeployment(deps.db, deploymentId, { status: result, finishedAt });
  const message = result === 'success' ? (commitMessage ?? '') : failureMessage;
  await notifySafe(deps, logger, { project: project.slug, status: result, deploymentId, message });
  logger.close();
  return result;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function runDeployInner(
  deps: PipelineDeps,
  deploymentId: number,
  logger: DeployLogger,
  signal: AbortSignal,
): Promise<'success' | 'failed' | 'canceled'> {
  const deploymentRow = getDeploymentOrThrow(deps.db, deploymentId);
  const project = getProjectOrThrow(deps.db, deploymentRow.projectId);
  const projectDir = path.join(deps.cfg.appsDir, project.slug);

  patchDeployment(deps.db, deploymentId, { status: 'running', startedAt: Date.now() });

  let releaseDir: string;
  let commitMessage: string | null;

  if (deploymentRow.trigger === 'rollback') {
    if (!deploymentRow.releasePath) {
      return await handlePreActivateFailure(
        deps,
        logger,
        signal,
        project,
        deploymentId,
        new Error(`rollback deployment ${String(deploymentId)} has no releasePath`),
      );
    }
    // The release a rollback targets may have since been pruned (prune only keeps the 5 newest,
    // but a deployment row's releasePath is never updated when its release is deleted). Activating
    // a dangling symlink would leave the site broken while still reporting success (health checks
    // for php/static without a healthCheckPath pass unconditionally) — so this must be caught here,
    // before activate, not discovered later.
    if (!fs.existsSync(deploymentRow.releasePath)) {
      return await handlePreActivateFailure(
        deps,
        logger,
        signal,
        project,
        deploymentId,
        new Error(`release no longer on disk — it was pruned: ${deploymentRow.releasePath}`),
      );
    }
    releaseDir = deploymentRow.releasePath;
    commitMessage = deploymentRow.commitMessage;
  } else {
    try {
      const built = await runBuildPhase(deps, logger, signal, project, projectDir, deploymentId);
      releaseDir = built.releaseDir;
      commitMessage = built.commitMessage;
    } catch (err) {
      return await handlePreActivateFailure(deps, logger, signal, project, deploymentId, err);
    }
  }

  return await runPostActivate(deps, logger, signal, project, projectDir, releaseDir, deploymentId, commitMessage);
}

/**
 * Runs one full deploy job for `deploymentId`: loads the deployment + project, sets it `running`,
 * runs the pipeline stages, and always ends with the deployment row's status/`finishedAt` set, the
 * logger closed, and a `'success' | 'failed' | 'canceled'` result — this function never throws.
 */
export async function runDeploy(
  deps: PipelineDeps,
  deploymentId: number,
  logger: DeployLogger,
  signal: AbortSignal,
): Promise<'success' | 'failed' | 'canceled'> {
  try {
    return await runDeployInner(deps, deploymentId, logger, signal);
  } catch (err) {
    logger.line(`ERROR: ${errMessage(err)}`);
    try {
      patchDeployment(deps.db, deploymentId, { status: 'failed', finishedAt: Date.now() });
    } catch {
      // deployment row may not even exist — nothing more we can do
    }
    logger.close();
    return 'failed';
  }
}
