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
import { AbortedError } from '../lib/aborted-error.js';
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
  /** Health-check GET (injectable so tests avoid the network). `signal`, when given, aborts the
   * in-flight request immediately instead of waiting out its own timeout/response. */
  fetchHttp: (url: string, signal?: AbortSignal) => Promise<{ status: number }>;
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
  /** Injectable delay, used between health-check retries. `signal`, when given and aborted,
   * resolves the sleep immediately instead of waiting out the full `ms`. Tests pass an instant
   * stub. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Waits for a node-like app's port to accept connections. Defaults to a real TCP-connect poll
   * that also bails immediately if `signal` aborts. */
  waitForPort?: (port: number, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>;
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
    throw new AbortedError('deploy canceled');
  }
}

/**
 * Writes a `==> cancel requested` section (plus a one-line note) to the live log the instant
 * `signal` aborts — independent of when the pipeline itself next reaches a `checkAborted()` or an
 * abort-aware await, so a canceled deploy's log shows *something* immediately rather than going
 * quiet until whatever step is in flight unwinds. A no-op subscription if the signal never aborts.
 */
function watchForCancelRequest(signal: AbortSignal, logger: DeployLogger): void {
  const announce = (): void => {
    try {
      logger.section('cancel requested');
      logger.line('stopping after the current step');
    } catch {
      // The run may have already settled (and closed the logger's file) in the narrow race where
      // `abort()` fires right as it does — nothing left to announce to.
    }
  };
  if (signal.aborted) {
    announce();
    return;
  }
  signal.addEventListener('abort', announce, { once: true });
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

    // Seed the shared directory from whatever the repo actually committed at this path, before the
    // symlink below discards it. Without this, sharing `storage` on a Laravel project throws away
    // the tracked `storage/framework/{cache,sessions,views}/.gitignore` placeholders that create
    // those directories, and `artisan package:discover` — run by composer's post-autoload-dump —
    // dies with "Please provide a valid cache path." before the deploy can finish.
    //
    // `force: false` makes this strictly additive: anything already in shared (the real uploads,
    // logs, and other data that shared paths exist to preserve) is never overwritten, so this is
    // safe on every deploy and not just the first one — a subdirectory added to the repo later gets
    // created too.
    const releasePath = path.join(releaseDir, entry);
    if (fs.existsSync(releasePath) && fs.lstatSync(releasePath).isDirectory()) {
      fs.cpSync(releasePath, target, { recursive: true, force: false, errorOnExist: false });
    }

    replaceSymlink(releasePath, target);
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
 * The user php-fpm runs as. Every PHP project on the host is served by the distribution's own
 * `php<version>-fpm` pool (`system/templates.ts` points each vhost at `/run/php/php<v>-fpm.sock`),
 * which on Debian/Ubuntu — the only platform install.sh targets — runs as `www-data`.
 */
const WEB_USER = 'www-data';

/** Laravel compiles its package/service manifests here, and writes them at runtime if a deploy
 * didn't. Relative to the release, not shared: it is per-release build output. */
const PHP_RUNTIME_WRITE_PATHS = ['bootstrap/cache'];

/**
 * Wraps `value` in single quotes for a POSIX shell, escaping any single quote it contains as
 * `'\''` (close, escaped literal, reopen). A shared path is whatever the project's settings say —
 * `sharedPaths` is a free-form string array — so it reaches the command below unvalidated, and
 * naive quoting would break on a name as ordinary as `it's`.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Gives php-fpm write access to the paths a PHP app writes to while it is *running*.
 *
 * The deploy runs as `deployer` and everything it creates is `deployer:deployer` 0755, but the
 * requests that follow are served as `www-data` — so without this a Laravel app comes up and dies
 * on its first page render with "Failed to open stream: Permission denied" trying to compile a
 * Blade view. The build itself never hits this, which is what makes the failure so easy to ship: a
 * fully green deploy, and a 500 on the first request.
 *
 * POSIX ACLs rather than `chown`/`chgrp`: the `default:` entries make everything *later* created
 * inside these directories carry the same access, so a file written by `www-data` at runtime and a
 * file written by `deployer` on the next deploy are both readable and writable by the other. Group
 * ownership alone can't express that — a file's group is inherited, but its group-write bit is
 * whatever the creating process's umask says, and php-fpm's is 022. `deployer` owns these paths, so
 * no privilege is needed to set this; `X` (capital) grants directory traversal without marking
 * every plain file executable.
 *
 * Failure is logged, not fatal: a PHP project that never writes anything at runtime deploys fine
 * without this, and refusing to release working code over it would be the wrong trade. The log line
 * is what points at this when an app does need it.
 */
async function grantWebWriteAccess(
  deps: PipelineDeps,
  project: ProjectRow,
  projectDir: string,
  releaseDir: string,
  env: Record<string, string>,
  signal: AbortSignal,
  logger: DeployLogger,
): Promise<void> {
  // node/nextjs run as `deployer` under their own systemd unit, and a static site is only ever read
  // by nginx — php is the one runtime whose writes happen as another user.
  if (project.type !== 'php') {
    return;
  }

  // Shared paths are exactly the directories that exist to hold data written after the deploy
  // (`storage`, `uploads`), so all of them get this — not just Laravel's.
  const targets = [
    ...project.sharedPaths.map((entry) => path.join(projectDir, 'shared', entry)),
    ...PHP_RUNTIME_WRITE_PATHS.map((entry) => path.join(releaseDir, entry)),
  ].filter((target) => fs.existsSync(target));

  if (targets.length === 0) {
    return;
  }

  const quoted = targets.map(shellQuote).join(' ');
  const { exitCode } = await deps.runShell(
    `setfacl -R -m u:${WEB_USER}:rwX -m d:u:${WEB_USER}:rwX -- ${quoted}`,
    { cwd: releaseDir, env, signal, onOutput: (line) => { logger.line(line); } },
  );

  if (exitCode !== 0) {
    logger.line(
      `WARNING: could not grant ${WEB_USER} write access to ${targets.join(', ')} (setfacl exited ${String(exitCode)}). ` +
        'A PHP app that writes at runtime (Laravel\'s storage/, for one) will fail with "Permission denied" on its first request.',
    );
    return;
  }

  logger.line(`granted ${WEB_USER} write access to ${targets.join(', ')}`);
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

/**
 * `signal` is optional and deliberately NOT passed by the rollback path in
 * `handlePostActivateFailure`: that call must run to completion and restore the previous release
 * even when `signal` is already aborted (that's the whole point of a rollback during a cancel) — a
 * `cancelSignal` that's already fired would immediately kill it. The forward activate→restart path
 * does pass it, so a genuinely-hung restart is still interruptible, and (per `sysops/real.ts`'s
 * `unitAction`/`reloadPhpFpm`) a failure caused by that abort throws `AbortedError` specifically,
 * distinguishable from an unrelated restart failure that merely coincides with a cancel.
 */
async function restartRuntime(deps: PipelineDeps, project: ProjectRow, signal?: AbortSignal): Promise<void> {
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

function getProjectWorkers(db: ShipwayDb, projectId: number): WorkerRow[] {
  return db.select().from(workers).where(eq(workers.projectId, projectId)).all();
}

/** Restarts every instance of every worker in `rows`. See `restartRuntime`'s doc comment for why
 * `signal` is optional and omitted by the rollback path. */
async function restartWorkers(deps: PipelineDeps, project: ProjectRow, rows: WorkerRow[], signal?: AbortSignal): Promise<void> {
  for (const worker of rows) {
    for (const unit of workerInstances(project.slug, worker.name, worker.processes)) {
      await deps.sysops.unitAction('restart', unit, signal);
    }
  }
}

const HEALTH_CHECK_TRIES = 5;
const HEALTH_CHECK_INTERVAL_MS = 3000;
const WAIT_FOR_PORT_TIMEOUT_MS = 15000;

function defaultWaitForPort(port: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let socket: ReturnType<typeof connect> | null = null;

    function finish(result: boolean): void {
      if (settled) return;
      settled = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.destroy();
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    }

    function onAbort(): void {
      finish(false);
    }

    function attempt(): void {
      if (signal?.aborted) {
        finish(false);
        return;
      }
      socket = connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket?.end();
        finish(true);
      });
      socket.once('error', () => {
        socket?.destroy();
        if (signal?.aborted) {
          finish(false);
        } else if (Date.now() >= deadline) {
          finish(false);
        } else {
          retryTimer = setTimeout(attempt, 500);
        }
      });
    }

    if (signal) {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    attempt();
  });
}

/**
 * `healthCheckPath` set: polls the URL (node-like: `http://127.0.0.1:<port><path>`; php/static:
 * `https://<slug>.<baseDomain><path>`) up to 5 times, 3s apart, accepting any 2xx/3xx status.
 * Unset, node-like: waits up to 15s for the port to accept connections. Unset, php/static: skipped
 * (always healthy). `signal` short-circuits all of the above the moment it aborts — the fetch, the
 * between-retry sleep, and the port poll all bail immediately rather than running out their clock.
 *
 * When a bail was actually caused by `signal` firing, this throws `AbortedError` directly (checked
 * immediately after the specific abortable await that was interrupted) rather than returning
 * `false` — a plain `false` return is reserved for a genuine health failure (all retries exhausted,
 * or the port never opened, with `signal` never aborted), so the caller can classify by error type
 * instead of re-checking the ambient flag later, once other unrelated stages may have run too.
 */
async function runHealthCheck(deps: PipelineDeps, project: ProjectRow, signal: AbortSignal): Promise<boolean> {
  if (project.healthCheckPath) {
    const url = isNodeLike(project.type)
      ? `http://127.0.0.1:${String(project.port)}${project.healthCheckPath}`
      : `https://${project.slug}.${getSetting<string>(deps.db, 'base_domain') ?? ''}${project.healthCheckPath}`;

    for (let attempt = 1; attempt <= HEALTH_CHECK_TRIES; attempt++) {
      if (signal.aborted) {
        throw new AbortedError('health check canceled');
      }
      try {
        const res = await deps.fetchHttp(url, signal);
        if (res.status >= 200 && res.status < 400) {
          return true;
        }
      } catch {
        // network error (or abort) on this attempt — fall through and retry/bail
      }
      if (signal.aborted) {
        throw new AbortedError('health check canceled');
      }
      if (attempt < HEALTH_CHECK_TRIES) {
        await deps.sleep(HEALTH_CHECK_INTERVAL_MS, signal);
      }
    }
    return false;
  }

  if (isNodeLike(project.type)) {
    if (project.port === null) {
      return false;
    }
    const waitForPort = deps.waitForPort ?? defaultWaitForPort;
    const healthy = await waitForPort(project.port, WAIT_FOR_PORT_TIMEOUT_MS, signal);
    if (!healthy && signal.aborted) {
      // `waitForPort` only resolves `false` early like this by reacting to `signal` itself (see
      // `defaultWaitForPort`) — checked right here, immediately after the specific call that was
      // given the signal, so this is never a coincidental/unrelated abort.
      throw new AbortedError('health check canceled');
    }
    return healthy;
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
 * `resolve` -> `export` -> `shared` -> `env` -> `pre_deploy` -> `build` (install + build) ->
 * `permissions`. On any failure (including cancellation), deletes the release directory if one was
 * created, then rethrows for the caller to classify (failed vs. canceled).
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
    const { sha, message } = await deps.gitOps.fetchBranchTip(projectDir, url, project.branch, signal);
    patchDeployment(deps.db, deploymentId, { commitSha: sha, commitMessage: message });

    logger.section('export');
    checkAborted(signal);
    releaseDir = path.join(projectDir, 'releases', releaseTimestamp(new Date()));
    await deps.gitOps.exportRelease(projectDir, sha, releaseDir, signal);
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

    // After the build, so it covers everything the build just wrote, and before activate, so the
    // first request to reach the new release already has somewhere to write.
    logger.section('permissions');
    checkAborted(signal);
    await grantWebWriteAccess(deps, project, projectDir, releaseDir, shellEnv, signal, logger);

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
 * and restart the runtime — code may already be live, so this rollback attempt happens regardless
 * of *why* the stage stopped, and deliberately WITHOUT `signal` (an already-aborted `cancelSignal`
 * would immediately kill this restart too — the rollback must complete even during a cancel). The
 * reported status reflects `canceled`'s caller-supplied value, which by the time this is called has
 * already been determined by error TYPE (`err instanceof AbortedError`, not the ambient
 * `signal.aborted` flag — see `runPostActivate`'s catch) so a genuine restart/health failure that
 * merely coincides with a cancel click is never mislabeled as a calm cancellation. `canceled: true`
 * skips notify entirely (same as every other cancellation path); `false` notifies same as any other
 * failure, with `rolledBack` reflecting whether the rollback below actually succeeded.
 */
async function handlePostActivateFailure(
  deps: PipelineDeps,
  logger: DeployLogger,
  project: ProjectRow,
  projectDir: string,
  deploymentId: number,
  previousReleasePath: string | null,
  err: unknown,
  canceled = false,
): Promise<'failed' | 'canceled'> {
  const message = errMessage(err);
  logger.line(`ERROR: ${message}`);

  let rolledBack = false;
  if (previousReleasePath) {
    try {
      logger.section('rollback');
      activateRelease(projectDir, previousReleasePath);
      await restartRuntime(deps, project); // no `signal` — see doc comment above
      logger.line('rolled back to previous release');
      rolledBack = true;
    } catch (rollbackErr) {
      logger.line(`rollback failed: ${errMessage(rollbackErr)}`);
    }
  }

  const finishedAt = Date.now();
  if (canceled) {
    patchDeployment(deps.db, deploymentId, { status: 'canceled', finishedAt });
    logger.close();
    return 'canceled';
  }

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

  try {
    logger.section('activate');
    checkAborted(signal);
    previousReleasePath = activateRelease(projectDir, releaseDir);

    logger.section('restart');
    checkAborted(signal);
    await restartRuntime(deps, project, signal);

    const workerRows = getProjectWorkers(deps.db, project.id);
    if (workerRows.length > 0) {
      logger.section('workers');
      checkAborted(signal);
      await restartWorkers(deps, project, workerRows, signal);
    }

    logger.section('health');
    checkAborted(signal);
    const healthy = await runHealthCheck(deps, project, signal);
    if (!healthy) {
      throw new HealthCheckFailedError();
    }
  } catch (err) {
    // Classify by the error's CAUSE, not by whether `signal` merely happens to be aborted at catch
    // time: `checkAborted`'s stage-boundary throws, and an abort-attributed `restartRuntime`/
    // `restartWorkers`/health-check failure (see their doc comments), are `AbortedError` — reported
    // `canceled`. Anything else (a genuine restart/health failure, independent of cancellation, that
    // simply happens to coincide with a cancel click) stays `failed` even though `signal.aborted` is
    // also `true` in that case — a real post-activate infrastructure failure must never be silently
    // relabeled as a calm cancellation. See `handlePostActivateFailure` for why the rollback attempt
    // still runs regardless (previousReleasePath is `null`, a no-op, if `activate` never ran).
    return await handlePostActivateFailure(deps, logger, project, projectDir, deploymentId, previousReleasePath, err, err instanceof AbortedError);
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
  watchForCancelRequest(signal, logger);
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
