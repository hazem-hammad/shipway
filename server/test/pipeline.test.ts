import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { deployments, projects, workers } from '../src/db/schema.js';
import { loadConfig, type Config } from '../src/config.js';
import { DevSysOps } from '../src/sysops/dev.js';
import type { UnitAction } from '../src/sysops/types.js';
import { makeGitOps, type GitOps } from '../src/services/git.js';
import { SecretBox } from '../src/lib/secretbox.js';
import { DeployLogger } from '../src/deploy/logger.js';
import { runDeploy, type PipelineDeps } from '../src/deploy/pipeline.js';

// ---------------------------------------------------------------------------
// fixture / test-double helpers
// ---------------------------------------------------------------------------

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function fileUrl(dir: string): string {
  return `file://${dir}`;
}

/** Creates a real git repo at `dir` with an initial commit of `index.html`. Returns its sha. */
async function makeFixtureRepo(dir: string, content: string): Promise<string> {
  await execa('git', ['init', '-b', 'main'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'index.html'), content);
  await execa('git', ['add', 'index.html'], { cwd: dir });
  await execa('git', ['commit', '-m', 'first commit'], { cwd: dir });
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

/** Like `makeFixtureRepo`, plus arbitrary extra tracked files (path -> content), dirs created. */
async function makeFixtureRepoWithFiles(dir: string, content: string, extra: Record<string, string>): Promise<string> {
  await execa('git', ['init', '-b', 'main'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'index.html'), content);
  for (const [rel, body] of Object.entries(extra)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['commit', '-m', 'first commit'], { cwd: dir });
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

function makeCfg(): Config {
  return loadConfig({
    SHIPWAY_DEV: '1',
    SHIPWAY_DATA_DIR: tmpDir('shipway-pipeline-data'),
    SHIPWAY_APPS_DIR: tmpDir('shipway-pipeline-apps'),
    SHIPWAY_LOGS_DIR: tmpDir('shipway-pipeline-logs'),
  });
}

function makeDb(cfg: Config): ShipwayDb {
  return openDb(cfg.dbPath);
}

function makeSecretBox(cfg: Config): SecretBox {
  return SecretBox.load(cfg.secretKeyPath);
}

interface InsertProjectInput {
  slug: string;
  type: 'php' | 'node' | 'nextjs' | 'static';
  branch?: string;
  phpVersion?: string | null;
  nodeVersion?: string | null;
  port?: number | null;
  installCmd?: string | null;
  buildCmd?: string | null;
  preDeployScript?: string | null;
  postDeployScript?: string | null;
  sharedPaths?: string[];
  healthCheckPath?: string | null;
}

function insertProject(db: ShipwayDb, input: InsertProjectInput): number {
  db.insert(projects)
    .values({
      name: input.slug,
      slug: input.slug,
      repo: `acme/${input.slug}`,
      branch: input.branch ?? 'main',
      type: input.type,
      phpVersion: input.phpVersion ?? null,
      nodeVersion: input.nodeVersion ?? null,
      port: input.port ?? null,
      installCmd: input.installCmd ?? null,
      buildCmd: input.buildCmd ?? null,
      preDeployScript: input.preDeployScript ?? null,
      postDeployScript: input.postDeployScript ?? null,
      sharedPaths: input.sharedPaths ?? [],
      healthCheckPath: input.healthCheckPath ?? null,
      autoDeploy: true,
      smtpMode: 'mailpit',
    })
    .run();
  const row = db.select({ id: projects.id }).from(projects).where(eq(projects.slug, input.slug)).get();
  if (!row) throw new Error('failed to insert test project');
  return row.id;
}

interface InsertDeploymentInput {
  projectId: number;
  trigger: 'push' | 'manual' | 'rollback';
  releasePath?: string | null;
  commitSha?: string | null;
  commitMessage?: string | null;
}

function insertDeployment(db: ShipwayDb, input: InsertDeploymentInput): number {
  db.insert(deployments)
    .values({
      projectId: input.projectId,
      status: 'queued',
      trigger: input.trigger,
      releasePath: input.releasePath ?? null,
      commitSha: input.commitSha ?? null,
      commitMessage: input.commitMessage ?? null,
    })
    .run();
  const row = db
    .select({ id: deployments.id })
    .from(deployments)
    .where(eq(deployments.projectId, input.projectId))
    .orderBy(deployments.id)
    .all();
  const last = row[row.length - 1];
  if (!last) throw new Error('failed to insert test deployment');
  return last.id;
}

function getDeploymentRow(db: ShipwayDb, id: number): typeof deployments.$inferSelect {
  const row = db.select().from(deployments).where(eq(deployments.id, id)).get();
  if (!row) throw new Error(`deployment ${String(id)} not found`);
  return row;
}

/** Records every `runShell` invocation; can be told to fail or to abort-and-fail on a cmd substring. */
class RecordingShell {
  readonly calls: Array<{ cmd: string; cwd: string }> = [];
  /** Parallel to `calls` — the `env` each invocation ran with (kept separate so existing `{cmd, cwd}`
   * equality assertions on `calls` don't have to also pin down the full environment). */
  readonly envs: Array<Record<string, string>> = [];
  failSubstring: string | null = null;
  abortSubstring: string | null = null;
  private abortFn: (() => void) | null = null;

  onAbort(fn: () => void): void {
    this.abortFn = fn;
  }

  run = async (
    cmd: string,
    opts: { cwd: string; env: Record<string, string>; signal: AbortSignal; onOutput: (s: string) => void },
  ): Promise<{ exitCode: number }> => {
    this.calls.push({ cmd, cwd: opts.cwd });
    this.envs.push(opts.env);
    opts.onOutput(`running: ${cmd}`);

    if (this.abortSubstring && cmd.includes(this.abortSubstring)) {
      this.abortFn?.();
      return { exitCode: 137 };
    }
    if (this.failSubstring && cmd.includes(this.failSubstring)) {
      return { exitCode: 1 };
    }
    return { exitCode: 0 };
  };
}

function sysopsRoot(cfg: Config): string {
  return path.join(cfg.dataDir, 'system');
}

function noopSleep(): Promise<void> {
  return Promise.resolve();
}

async function alwaysOkFetch(): Promise<{ status: number }> {
  return { status: 200 };
}

function poisonedGitOps(): GitOps {
  return {
    fetchBranchTip: () => Promise.reject(new Error('gitOps.fetchBranchTip must not be called for a rollback deploy')),
    exportRelease: () => Promise.reject(new Error('gitOps.exportRelease must not be called for a rollback deploy')),
    listRemoteBranches: () => Promise.reject(new Error('gitOps.listRemoteBranches is not part of the deploy pipeline')),
  };
}

interface BaseHarness {
  cfg: Config;
  db: ShipwayDb;
  sysops: DevSysOps;
  gitOps: GitOps;
  shell: RecordingShell;
  secretBox: SecretBox;
  notifications: Array<{ project: string; status: 'success' | 'failed'; deploymentId: number; message: string; rolledBack?: boolean }>;
  fetchHttp: (url: string) => Promise<{ status: number }>;
  logger: DeployLogger;
  deps: PipelineDeps;
}

function makeHarness(
  opts: {
    fetchHttp?: (url: string) => Promise<{ status: number }>;
    gitOps?: GitOps;
    /** Test-only override: builds the harness's sysops from `cfg` instead of a plain `DevSysOps`. */
    sysopsFactory?: (cfg: Config) => DevSysOps;
  } = {},
): BaseHarness {
  const cfg = makeCfg();
  const db = makeDb(cfg);
  const sysops = opts.sysopsFactory ? opts.sysopsFactory(cfg) : new DevSysOps(sysopsRoot(cfg));
  const gitOps = opts.gitOps ?? makeGitOps();
  const shell = new RecordingShell();
  const secretBox = makeSecretBox(cfg);
  const notifications: BaseHarness['notifications'] = [];
  const fetchHttp = opts.fetchHttp ?? alwaysOkFetch;
  const logger = new DeployLogger(path.join(cfg.logsDir, 'deploy.log'));

  const deps: PipelineDeps = {
    cfg,
    db,
    sysops,
    gitOps,
    secretBox,
    getCloneUrl: (repo) => Promise.resolve(repo), // tests pass a file:// URL directly as `repo`
    runShell: shell.run,
    fetchHttp,
    notify: (p) => {
      notifications.push(p);
      return Promise.resolve();
    },
    sleep: noopSleep,
    waitForPort: () => Promise.resolve(true),
  };

  return { cfg, db, sysops, gitOps, shell, secretBox, notifications, fetchHttp, logger, deps };
}

/** Fails `unitAction` for exactly one unit name (e.g. a worker instance), succeeding for everything else. */
class FailingUnitActionSysOps extends DevSysOps {
  constructor(
    root: string,
    private readonly failUnit: string,
  ) {
    super(root);
  }

  override async unitAction(action: UnitAction, unit: string): Promise<void> {
    if (unit === this.failUnit) {
      this.calls.push(`unitAction ${action} ${unit} (FAILS)`);
      throw new Error(`systemctl ${action} ${unit}: failed`);
    }
    return super.unitAction(action, unit);
  }
}

/**
 * Simulates a *genuine* restart failure (a broken unit in the new release — nothing to do with
 * cancellation) that happens to coincide with a user clicking Cancel at that exact moment: the
 * first `restart` call both aborts `controller` (as if the click landed right then) AND throws an
 * unrelated error. Every subsequent `restart` call (i.e. the rollback's own restart, back to the
 * previous — presumably working — release) succeeds normally, so a caller can tell whether the
 * rollback attempt actually ran to completion.
 */
class AbortOnFirstRestartSysOps extends DevSysOps {
  private restartCalls = 0;

  constructor(
    root: string,
    private readonly controller: AbortController,
  ) {
    super(root);
  }

  override async unitAction(action: UnitAction, unit: string, signal?: AbortSignal): Promise<void> {
    if (action === 'restart') {
      this.restartCalls += 1;
      if (this.restartCalls === 1) {
        this.calls.push(`unitAction ${action} ${unit} (FAILS, coincidental abort)`);
        this.controller.abort();
        throw new Error(`systemctl ${action} ${unit}: unit failed to start (Result: exit-code)`);
      }
    }
    return super.unitAction(action, unit, signal);
  }
}

function currentPath(cfg: Config, slug: string): string {
  return path.join(cfg.appsDir, slug, 'current');
}

function readCurrentTarget(cfg: Config, slug: string): string | null {
  try {
    return fs.readlinkSync(currentPath(cfg, slug));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DeployLogger
// ---------------------------------------------------------------------------

describe('DeployLogger', () => {
  it('prefixes each line with a UTC [HH:MM:SS] timestamp, writes it to the file, and emits it', () => {
    const dir = tmpDir('shipway-logger');
    const filePath = path.join(dir, 'deploy.log');
    const logger = new DeployLogger(filePath);
    const emitted: string[] = [];
    logger.on('line', (l: string) => emitted.push(l));

    logger.line('hello world');
    logger.close();

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^\[\d{2}:\d{2}:\d{2}\] hello world\n$/);
    expect(emitted).toEqual([content.trimEnd()]);
  });

  it('section() writes a "==> <title>" line', () => {
    const dir = tmpDir('shipway-logger');
    const logger = new DeployLogger(path.join(dir, 'deploy.log'));
    logger.section('resolve');
    logger.close();
    const content = fs.readFileSync(path.join(dir, 'deploy.log'), 'utf8');
    expect(content).toMatch(/\] ==> resolve\n$/);
  });

  it('creates parent directories for the log file', () => {
    const dir = tmpDir('shipway-logger');
    const nested = path.join(dir, 'a', 'b', 'deploy.log');
    expect(() => new DeployLogger(nested)).not.toThrow();
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('close() emits "end" and is idempotent', () => {
    const dir = tmpDir('shipway-logger');
    const logger = new DeployLogger(path.join(dir, 'deploy.log'));
    let endCount = 0;
    logger.on('end', () => {
      endCount++;
    });
    logger.close();
    logger.close();
    expect(endCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runDeploy
// ---------------------------------------------------------------------------

describe('runDeploy — happy path (php)', () => {
  it('runs resolve/export/shared/env/build/activate/restart, updates the row, writes .env, and never touches health/post_deploy sections', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    const sha = await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const { cfg, db, sysops, shell, notifications, logger, deps } = makeHarness();

    const projectId = insertProject(db, {
      slug: 'shop',
      type: 'php',
      phpVersion: '8.3',
      installCmd: 'composer install',
      sharedPaths: ['storage'],
    });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });

    const lines: string[] = [];
    logger.on('line', (l: string) => lines.push(l));

    const result = await runDeploy(deps, deploymentId, logger, new AbortController().signal);

    expect(result).toBe('success');

    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('success');
    expect(row.commitSha).toBe(sha);
    expect(row.commitMessage).toBe('first commit');
    expect(row.startedAt).not.toBeNull();
    expect(row.finishedAt).not.toBeNull();
    expect(row.releasePath).not.toBeNull();

    // current -> the new release
    const releaseDir = row.releasePath as string;
    expect(readCurrentTarget(cfg, 'shop')).toBe(releaseDir);

    // .env has the mailpit managed block
    const envContent = fs.readFileSync(path.join(releaseDir, '.env'), 'utf8');
    expect(envContent).toContain('shipway managed');
    expect(envContent).toContain('MAIL_MAILER=smtp');
    expect(envContent).toContain('MAIL_HOST=127.0.0.1');

    // sharedPaths symlinked
    const storageLink = path.join(releaseDir, 'storage');
    expect(fs.lstatSync(storageLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(storageLink)).toBe(fs.realpathSync(path.join(cfg.appsDir, 'shop', 'shared', 'storage')));

    // install ran in the release dir, then the php runtime was given write access to what it
    // writes at runtime (see `grantWebWriteAccess`).
    expect(shell.calls).toEqual([
      { cmd: 'composer install', cwd: releaseDir },
      {
        cmd: `setfacl -R -m u:www-data:rwX -m d:u:www-data:rwX -- '${path.join(cfg.appsDir, 'shop', 'shared', 'storage')}'`,
        cwd: releaseDir,
      },
    ]);

    // B5: the install command's PATH is prefixed with the project's version-pinned php shim dir
    // (install.sh's /opt/php/<ver>/bin/php -> /usr/bin/php<ver>), so a bare `composer`/`php`
    // invocation resolves to the project's pinned phpVersion instead of the PPA's current default.
    expect(shell.envs[0]?.PATH?.startsWith('/opt/php/8.3/bin:')).toBe(true);

    // php restart, not systemd
    expect(sysops.calls).toContain('reloadPhpFpm 8.3');
    expect(sysops.calls.some((c) => c.startsWith('unitAction'))).toBe(false);

    // log sections in order
    const sections = lines.filter((l) => l.includes('==>')).map((l) => l.replace(/^\[[\d:]+\] ==> /, ''));
    expect(sections).toEqual([
      'resolve',
      'export',
      'shared',
      'env',
      'pre_deploy',
      'build',
      'permissions',
      'activate',
      'restart',
      'health',
      'post_deploy',
      'prune',
    ]);

    // notify called on success
    expect(notifications).toEqual([{ project: 'shop', status: 'success', deploymentId, message: 'first commit' }]);
  });
});

/**
 * The deploy runs as `deployer`; the requests that follow are served by php-fpm as `www-data`. A
 * Laravel app that can't write `storage/` builds perfectly and then 500s on its first page render,
 * which is exactly the failure this stage exists to prevent — so what it grants, on which paths,
 * and for which project types is pinned here.
 */
describe('runDeploy — runtime write access for php', () => {
  it("grants www-data write access to the project's shared paths and bootstrap/cache, with inheritance", async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepoWithFiles(fixtureDir, '<h1>v1</h1>\n', {
      'storage/logs/.gitignore': '*\n!.gitignore\n',
      'bootstrap/cache/.gitignore': '*\n!.gitignore\n',
    });
    const { cfg, db, shell, logger, deps } = makeHarness();

    const projectId = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3', sharedPaths: ['storage', 'uploads'] });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    const deploymentId = insertDeployment(db, { projectId, trigger: 'manual' });

    expect(await runDeploy(deps, deploymentId, logger, new AbortController().signal)).toBe('success');

    const releaseDir = getDeploymentRow(db, deploymentId).releasePath as string;
    const setfacl = shell.calls.find((call) => call.cmd.startsWith('setfacl'));
    expect(setfacl).toBeDefined();

    // `d:` (default) entries are the point: a file written by www-data at runtime and one written
    // by deployer on the next deploy both stay accessible to the other.
    expect(setfacl?.cmd).toContain('-m u:www-data:rwX');
    expect(setfacl?.cmd).toContain('-m d:u:www-data:rwX');
    // Every shared path, plus the release's own bootstrap/cache.
    expect(setfacl?.cmd).toContain(`'${path.join(cfg.appsDir, 'shop', 'shared', 'storage')}'`);
    expect(setfacl?.cmd).toContain(`'${path.join(cfg.appsDir, 'shop', 'shared', 'uploads')}'`);
    expect(setfacl?.cmd).toContain(`'${path.join(releaseDir, 'bootstrap/cache')}'`);
  });

  it('skips bootstrap/cache when the repo has none, rather than naming a path that does not exist', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    const { cfg, db, shell, logger, deps } = makeHarness();
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');

    const projectId = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3', sharedPaths: ['storage'] });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    const deploymentId = insertDeployment(db, { projectId, trigger: 'manual' });

    expect(await runDeploy(deps, deploymentId, logger, new AbortController().signal)).toBe('success');

    const setfacl = shell.calls.find((call) => call.cmd.startsWith('setfacl'));
    expect(setfacl?.cmd).toContain(`'${path.join(cfg.appsDir, 'shop', 'shared', 'storage')}'`);
    expect(setfacl?.cmd).not.toContain('bootstrap/cache');
  });

  it('does not run at all for a static project, which nginx only ever reads', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const { db, shell, logger, deps } = makeHarness();

    // Shared paths are set, so this is about the project type and not about there being nothing to
    // grant: a static site is served straight off disk by nginx, and a node app runs as `deployer`
    // under its own unit, so neither has a second user that needs writing rights.
    const projectId = insertProject(db, { slug: 'brochure', type: 'static', sharedPaths: ['storage'] });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    const deploymentId = insertDeployment(db, { projectId, trigger: 'manual' });

    await runDeploy(deps, deploymentId, logger, new AbortController().signal);

    expect(shell.calls.some((call) => call.cmd.startsWith('setfacl'))).toBe(false);
  });

  it('warns but still deploys when setfacl fails — working code is not withheld over an ACL', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const { db, shell, logger, deps } = makeHarness();
    shell.failSubstring = 'setfacl';

    const projectId = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3', sharedPaths: ['storage'] });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    const deploymentId = insertDeployment(db, { projectId, trigger: 'manual' });

    const lines: string[] = [];
    logger.on('line', (l: string) => lines.push(l));

    expect(await runDeploy(deps, deploymentId, logger, new AbortController().signal)).toBe('success');
    expect(lines.join('\n')).toContain('WARNING: could not grant www-data write access');
  });

  it('quotes a shared path containing a single quote instead of breaking the command', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const { db, shell, logger, deps } = makeHarness();

    // `sharedPaths` is a free-form string array on the project row, so this reaches the command
    // unvalidated.
    const projectId = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3', sharedPaths: ["it's"] });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    const deploymentId = insertDeployment(db, { projectId, trigger: 'manual' });

    expect(await runDeploy(deps, deploymentId, logger, new AbortController().signal)).toBe('success');

    // The whole path is one quoted word, with the embedded quote closed/escaped/reopened — so the
    // trailing `s'` still belongs to the same argument rather than starting a new one.
    const setfacl = shell.calls.find((call) => call.cmd.startsWith('setfacl'));
    expect(setfacl?.cmd).toContain(`shared/it'\\''s'`);
    expect(setfacl?.cmd.endsWith(`s'`)).toBe(true);
  });
});

describe('runDeploy — shared paths seed from the release', () => {
  it("copies the repo's committed skeleton into shared before symlinking, without overwriting existing shared data", async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    // A Laravel-shaped repo: the directories that matter exist in git only as .gitignore
    // placeholders, and are exactly what the shared symlink used to discard.
    await makeFixtureRepoWithFiles(fixtureDir, '<h1>v1</h1>\n', {
      'storage/framework/views/.gitignore': '*\n!.gitignore\n',
      'storage/framework/cache/data/.gitignore': '*\n!.gitignore\n',
      'storage/logs/.gitignore': '*\n!.gitignore\n',
    });
    const { cfg, db, shell, logger, deps } = makeHarness();

    const projectId = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3', sharedPaths: ['storage'] });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();

    // Pre-existing shared data — a log from an earlier deploy — must survive untouched.
    const sharedStorage = path.join(cfg.appsDir, 'shop', 'shared', 'storage');
    fs.mkdirSync(path.join(sharedStorage, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(sharedStorage, 'logs', 'laravel.log'), 'EXISTING LOG\n');

    const deploymentId = insertDeployment(db, { projectId, trigger: 'manual' });
    const result = await runDeploy(deps, deploymentId, logger, new AbortController().signal);
    expect(result).toBe('success');

    // The skeleton is now in shared, so `artisan package:discover` has a real cache path.
    expect(fs.existsSync(path.join(sharedStorage, 'framework', 'views', '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(sharedStorage, 'framework', 'cache', 'data', '.gitignore'))).toBe(true);

    // ...and it is reachable through the release symlink, which is what the app actually uses.
    const releaseDir = getDeploymentRow(db, deploymentId).releasePath as string;
    expect(fs.existsSync(path.join(releaseDir, 'storage', 'framework', 'views'))).toBe(true);

    // Strictly additive: existing shared content wins over the repo's placeholder.
    expect(fs.readFileSync(path.join(sharedStorage, 'logs', 'laravel.log'), 'utf8')).toBe('EXISTING LOG\n');

    expect(shell.calls.length).toBeGreaterThanOrEqual(0);
  });
});

describe('runDeploy — build failure', () => {
  it('leaves current untouched, deletes the new release dir, and marks the deployment failed', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const { cfg, db, notifications, logger, shell, deps } = makeHarness();
    shell.failSubstring = 'npm run build';

    const projectId = insertProject(db, {
      slug: 'app-build-fail',
      type: 'static',
      installCmd: 'npm ci',
      buildCmd: 'npm run build',
    });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();

    // A pre-existing "current" release, standing in for a prior successful deploy.
    const prevReleaseDir = path.join(cfg.appsDir, 'app-build-fail', 'releases', 'prev-release');
    fs.mkdirSync(prevReleaseDir, { recursive: true });
    fs.mkdirSync(path.dirname(currentPath(cfg, 'app-build-fail')), { recursive: true });
    fs.symlinkSync(prevReleaseDir, currentPath(cfg, 'app-build-fail'));

    const deploymentId = insertDeployment(db, { projectId, trigger: 'manual' });

    const result = await runDeploy(deps, deploymentId, logger, new AbortController().signal);

    expect(result).toBe('failed');
    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('failed');
    expect(row.finishedAt).not.toBeNull();

    // current untouched
    expect(readCurrentTarget(cfg, 'app-build-fail')).toBe(prevReleaseDir);
    // new release directory was deleted
    expect(fs.existsSync(row.releasePath as string)).toBe(false);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.status).toBe('failed');
    // a pre-activate failure never rolls anything back — `rolledBack` must be unset, not `false`
    expect(notifications[0]?.rolledBack).toBeUndefined();
  });
});

describe('runDeploy — node health-check failure', () => {
  it('rolls the symlink back to the previous release, restarts twice, and marks failed', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const failingFetch = async (): Promise<{ status: number }> => ({ status: 500 });
    const { cfg, db, sysops, notifications, logger, deps } = makeHarness({ fetchHttp: failingFetch });

    const projectId = insertProject(db, {
      slug: 'api',
      type: 'node',
      nodeVersion: '22',
      port: 3099,
      healthCheckPath: '/health',
    });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();

    const prevReleaseDir = path.join(cfg.appsDir, 'api', 'releases', 'prev-release');
    fs.mkdirSync(prevReleaseDir, { recursive: true });
    fs.mkdirSync(path.dirname(currentPath(cfg, 'api')), { recursive: true });
    fs.symlinkSync(prevReleaseDir, currentPath(cfg, 'api'));

    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });

    const result = await runDeploy(deps, deploymentId, logger, new AbortController().signal);

    expect(result).toBe('failed');
    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('failed');

    // symlink flipped back to the previous release
    expect(readCurrentTarget(cfg, 'api')).toBe(prevReleaseDir);

    // restart called twice: once for the new release's activate, once for the rollback
    const restarts = sysops.calls.filter((c) => c === 'unitAction restart shipway-app-api.service');
    expect(restarts).toHaveLength(2);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.status).toBe('failed');
    // the health check failure rolled the release back — the caller (app.ts's notify wiring) needs
    // this to emit `deploy_rolled_back` instead of `deploy_failed`.
    expect(notifications[0]?.rolledBack).toBe(true);
  });
});

describe('runDeploy — post_deploy failure', () => {
  it('marks the deployment failed but leaves current pointed at the new release (no rollback)', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const { cfg, db, notifications, logger, shell, deps } = makeHarness();
    shell.failSubstring = 'cache:warm';

    const projectId = insertProject(db, {
      slug: 'blog',
      type: 'php',
      phpVersion: '8.3',
      postDeployScript: 'php artisan cache:warm',
    });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });

    const result = await runDeploy(deps, deploymentId, logger, new AbortController().signal);

    expect(result).toBe('failed');
    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('failed');

    // current DOES point at the new release — post_deploy failures never roll back
    expect(readCurrentTarget(cfg, 'blog')).toBe(row.releasePath);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.status).toBe('failed');
    expect(notifications[0]?.rolledBack).toBeUndefined();
  });
});

describe('runDeploy — prune', () => {
  it('keeps only the 5 newest release directories', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const { cfg, db, logger, deps } = makeHarness();

    const projectId = insertProject(db, { slug: 'static-site', type: 'static' });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();

    const releasesDir = path.join(cfg.appsDir, 'static-site', 'releases');
    fs.mkdirSync(releasesDir, { recursive: true });
    const seeded = ['20200101_000001', '20200102_000001', '20200103_000001', '20200104_000001', '20200105_000001', '20200106_000001'];
    for (const name of seeded) {
      fs.mkdirSync(path.join(releasesDir, name), { recursive: true });
    }

    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });
    const result = await runDeploy(deps, deploymentId, logger, new AbortController().signal);
    expect(result).toBe('success');

    const remaining = fs.readdirSync(releasesDir).sort();
    // 6 seeded + 1 new release = 7 total; prune keeps the 5 newest.
    expect(remaining).toHaveLength(5);
    // the two oldest seeded dirs are gone
    expect(remaining).not.toContain('20200101_000001');
    expect(remaining).not.toContain('20200102_000001');
    // the newest seeded ones and the fresh release survive
    expect(remaining).toContain('20200106_000001');
  });
});

describe('runDeploy — cancel', () => {
  it('aborting mid-install returns canceled, skips notify, and removes the release dir', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const { db, notifications, logger, shell, deps } = makeHarness();

    const controller = new AbortController();
    shell.abortSubstring = 'npm ci';
    shell.onAbort(() => {
      controller.abort();
    });

    const projectId = insertProject(db, { slug: 'cancel-me', type: 'static', installCmd: 'npm ci' });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });

    const result = await runDeploy(deps, deploymentId, logger, controller.signal);

    expect(result).toBe('canceled');
    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('canceled');
    expect(fs.existsSync(row.releasePath as string)).toBe(false);
    expect(notifications).toHaveLength(0);
  });

  it('an abort observed before activate ever runs is reported canceled, not failed, and current is untouched', async () => {
    const { cfg, db, sysops, notifications, logger, deps } = makeHarness({ gitOps: poisonedGitOps() });

    const projectId = insertProject(db, { slug: 'cancel-before-activate', type: 'static' });
    const existingRelease = path.join(cfg.appsDir, 'cancel-before-activate', 'releases', '20200101_000000');
    fs.mkdirSync(existingRelease, { recursive: true });

    // Rollback trigger skips straight to the post-activate phase, so aborting up front lands
    // exactly on the narrow pre-activate window inside runPostActivate.
    const deploymentId = insertDeployment(db, { projectId, trigger: 'rollback', releasePath: existingRelease });

    const controller = new AbortController();
    controller.abort();

    const result = await runDeploy(deps, deploymentId, logger, controller.signal);

    expect(result).toBe('canceled');
    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('canceled');
    // current was never touched — activate never ran
    expect(readCurrentTarget(cfg, 'cancel-before-activate')).toBeNull();
    expect(sysops.calls).toEqual([]);
    expect(notifications).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 2: cancellation reaches every previously-unabortable await (root cause fix)
// ---------------------------------------------------------------------------

describe('runDeploy — cancel during git resolve (root cause: GitOps never got the signal)', () => {
  it('a gitOps.fetchBranchTip that only settles on abort returns canceled promptly, not after a long hang', async () => {
    const controller = new AbortController();
    // Simulates a slow/unreachable remote: never settles on its own — only the signal it was given
    // unsticks it, exactly like the fixed real `GitOps` (see git.ts). If the pipeline still failed
    // to thread `signal` through to this call, this promise — and the test — would hang forever.
    const hangingGitOps: GitOps = {
      fetchBranchTip: (_projectDir, _url, _branch, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('git operation canceled'));
            },
            { once: true },
          );
        }),
      exportRelease: () => Promise.reject(new Error('exportRelease must not be called — resolve never got past fetchBranchTip')),
      listRemoteBranches: () => Promise.reject(new Error('listRemoteBranches is not part of the deploy pipeline')),
    };

    const { db, notifications, logger, deps } = makeHarness({ gitOps: hangingGitOps });
    const projectId = insertProject(db, { slug: 'slow-remote', type: 'static' });
    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });

    setTimeout(() => {
      controller.abort();
    }, 30);

    const start = Date.now();
    const result = await runDeploy(deps, deploymentId, logger, controller.signal);
    const elapsed = Date.now() - start;

    expect(result).toBe('canceled');
    expect(elapsed).toBeLessThan(1000);
    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('canceled');
    expect(notifications).toHaveLength(0);
  });
});

describe('runDeploy — cancel during the health-check retry sleep', () => {
  it('returns canceled fast instead of waiting out the 5x3s retry budget', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const controller = new AbortController();

    // A "real" abortable sleep (mirrors app.ts's production `PipelineDeps.sleep` wiring) — the
    // harness's default `noopSleep` resolves instantly regardless of its signal, which would make
    // this test pass trivially without actually exercising the new abort-aware sleep behavior.
    const realishSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
      new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

    // The health check's first fetch always fails (so the loop is headed into a 3s retry sleep)
    // and, the instant it's actually called — i.e. once the pipeline has genuinely reached the
    // health stage, whatever the real timing of resolve/export/activate/restart turned out to be —
    // schedules the cancel, so the abort lands squarely inside the retry sleep.
    const failThenCancel = async (): Promise<{ status: number }> => {
      setTimeout(() => {
        controller.abort();
      }, 0);
      return { status: 500 };
    };

    const { db, notifications, logger, deps } = makeHarness({ fetchHttp: failThenCancel });
    deps.sleep = realishSleep;

    const projectId = insertProject(db, { slug: 'health-cancel', type: 'static', healthCheckPath: '/health' });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });

    const start = Date.now();
    const result = await runDeploy(deps, deploymentId, logger, controller.signal);
    const elapsed = Date.now() - start;

    expect(result).toBe('canceled');
    expect(elapsed).toBeLessThan(2000);
    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('canceled');
    expect(notifications).toHaveLength(0);
  }, 10000);
});

describe('runDeploy — waitForPort bails on abort', () => {
  it('a node project relying on the default TCP-poll waitForPort cancels fast, not after its 15s timeout', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const controller = new AbortController();
    const { db, notifications, logger, deps } = makeHarness();
    deps.waitForPort = undefined; // exercise the pipeline's real `defaultWaitForPort`, not the harness stub

    logger.on('line', (l: string) => {
      if (l.includes('==> health')) {
        // Deferred a tick so the `checkAborted` right after this section header still sees an
        // un-aborted signal — the point is to cancel *during* the port poll, not before the
        // pipeline ever reaches it.
        setTimeout(() => {
          controller.abort();
        }, 0);
      }
    });

    const projectId = insertProject(db, { slug: 'wait-for-port-cancel', type: 'node', nodeVersion: '22', port: 58211 });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });

    const start = Date.now();
    const result = await runDeploy(deps, deploymentId, logger, controller.signal);
    const elapsed = Date.now() - start;

    expect(result).toBe('canceled');
    expect(elapsed).toBeLessThan(2000);
    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('canceled');
    expect(notifications).toHaveLength(0);
  }, 10000);
});

describe('runDeploy — cancel-requested log line', () => {
  it('writes a "==> cancel requested" section to the live log the moment the signal aborts', async () => {
    const { db, logger, deps } = makeHarness();

    // A rollback deploy whose releasePath doesn't exist on disk fails fast, pre-activate — plenty
    // for this test, which only cares about the log line a pre-aborted signal produces, not which
    // stage it lands in.
    const projectId = insertProject(db, { slug: 'cancel-log', type: 'static' });
    const deploymentId = insertDeployment(db, { projectId, trigger: 'rollback', releasePath: '/nonexistent' });

    const lines: string[] = [];
    logger.on('line', (l: string) => lines.push(l));

    const controller = new AbortController();
    controller.abort();

    await runDeploy(deps, deploymentId, logger, controller.signal);

    expect(lines.some((l) => l.includes('==> cancel requested'))).toBe(true);
    expect(lines.some((l) => l.includes('stopping after the current step'))).toBe(true);
  });
});

describe('runDeploy — post-activate cancel classification is by cause, not coincidence', () => {
  it('a genuine restart failure that coincides with a cancel click is reported failed (not canceled), notifies deploy_failed, and still rolls back', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const controller = new AbortController();

    const { cfg, db, notifications, logger, deps } = makeHarness({
      sysopsFactory: (cfg) => new AbortOnFirstRestartSysOps(sysopsRoot(cfg), controller),
    });

    const projectId = insertProject(db, { slug: 'coincidental-cancel', type: 'node', nodeVersion: '22', port: 3098 });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();

    const prevReleaseDir = path.join(cfg.appsDir, 'coincidental-cancel', 'releases', 'prev-release');
    fs.mkdirSync(prevReleaseDir, { recursive: true });
    fs.mkdirSync(path.dirname(currentPath(cfg, 'coincidental-cancel')), { recursive: true });
    fs.symlinkSync(prevReleaseDir, currentPath(cfg, 'coincidental-cancel'));

    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });

    const result = await runDeploy(deps, deploymentId, logger, controller.signal);

    // The restart's own failure is unrelated to the cancel — must be `failed`, never `canceled`,
    // even though `signal.aborted` is `true` by the time the outer catch runs.
    expect(result).toBe('failed');
    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('failed');

    // Rolled back to the previous release — the rollback's own restart call (the SECOND `restart`,
    // which the stub lets succeed) actually ran, proving cancellation didn't short-circuit it.
    expect(readCurrentTarget(cfg, 'coincidental-cancel')).toBe(prevReleaseDir);

    // The real (non-cancellation) failure path: notified as `failed` with `rolledBack: true`, not
    // silently swallowed the way every other cancellation path swallows notify entirely.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.status).toBe('failed');
    expect(notifications[0]?.rolledBack).toBe(true);
    expect(notifications[0]?.message).toContain('unit failed to start');
  });

  it('an abort that genuinely interrupts the restart (no independent failure) is still reported canceled', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const { db, notifications, logger, deps } = makeHarness();

    const projectId = insertProject(db, { slug: 'genuine-restart-cancel', type: 'static' });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });

    // static projects skip restartRuntime entirely, so drive the abort at the 'restart' stage
    // boundary itself (checkAborted) — still exercises the same `err instanceof AbortedError`
    // classification path in runPostActivate's catch, just via the stage-boundary check rather
    // than a genuinely-interrupted sysops call.
    const controller = new AbortController();
    logger.on('line', (l: string) => {
      if (l.includes('==> restart')) {
        controller.abort();
      }
    });

    const result = await runDeploy(deps, deploymentId, logger, controller.signal);

    expect(result).toBe('canceled');
    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('canceled');
    expect(notifications).toHaveLength(0);
  });
});

describe('runDeploy — rollback trigger', () => {
  it('reuses the existing release without calling gitOps, and leaves commitSha/commitMessage untouched', async () => {
    const { cfg, db, sysops, notifications, logger, deps } = makeHarness({ gitOps: poisonedGitOps() });

    const projectId = insertProject(db, { slug: 'reroll', type: 'static' });

    // A pre-existing release, as if built by an earlier deploy.
    const existingRelease = path.join(cfg.appsDir, 'reroll', 'releases', '20200101_000000');
    fs.mkdirSync(existingRelease, { recursive: true });
    fs.writeFileSync(path.join(existingRelease, 'index.html'), '<h1>old</h1>\n');

    const deploymentId = insertDeployment(db, {
      projectId,
      trigger: 'rollback',
      releasePath: existingRelease,
      commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      commitMessage: 'rollback to old release',
    });

    const result = await runDeploy(deps, deploymentId, logger, new AbortController().signal);

    expect(result).toBe('success');
    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('success');
    // resolve/export skipped entirely: sha/message are exactly what was on the row already
    expect(row.commitSha).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(row.commitMessage).toBe('rollback to old release');
    expect(row.releasePath).toBe(existingRelease);

    expect(readCurrentTarget(cfg, 'reroll')).toBe(existingRelease);
    // static type: no systemd/php-fpm restart calls at all
    expect(sysops.calls.filter((c) => c.startsWith('unitAction') || c.startsWith('reloadPhpFpm'))).toEqual([]);

    expect(notifications).toEqual([{ project: 'reroll', status: 'success', deploymentId, message: 'rollback to old release' }]);
  });

  it('fails cleanly (does not activate a dangling symlink) when the target release was since pruned off disk', async () => {
    const { cfg, db, sysops, notifications, logger, deps } = makeHarness({ gitOps: poisonedGitOps() });

    const projectId = insertProject(db, { slug: 'reroll-pruned', type: 'static' });

    // A pre-existing "current" release, standing in for whatever is live right now.
    const liveRelease = path.join(cfg.appsDir, 'reroll-pruned', 'releases', '20200105_000000');
    fs.mkdirSync(liveRelease, { recursive: true });
    fs.mkdirSync(path.dirname(currentPath(cfg, 'reroll-pruned')), { recursive: true });
    fs.symlinkSync(liveRelease, currentPath(cfg, 'reroll-pruned'));

    // The rollback target's directory does NOT exist on disk (e.g. prune deleted it after this
    // deployment row's releasePath was recorded) — deliberately never created.
    const prunedRelease = path.join(cfg.appsDir, 'reroll-pruned', 'releases', '20200101_000000');

    const deploymentId = insertDeployment(db, {
      projectId,
      trigger: 'rollback',
      releasePath: prunedRelease,
      commitMessage: 'rollback to pruned release',
    });

    const result = await runDeploy(deps, deploymentId, logger, new AbortController().signal);

    expect(result).toBe('failed');
    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('failed');

    // current untouched — never pointed at the missing release
    expect(readCurrentTarget(cfg, 'reroll-pruned')).toBe(liveRelease);
    // activate/restart never ran
    expect(sysops.calls).toEqual([]);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.status).toBe('failed');
    // caught before activate ever ran — nothing was rolled back
    expect(notifications[0]?.rolledBack).toBeUndefined();
  });
});

describe('runDeploy — workers', () => {
  it('restarts every instance of every project worker after the runtime restart, sectioned between restart and health', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const { db, sysops, logger, deps } = makeHarness();

    const projectId = insertProject(db, { slug: 'queue-app', type: 'static' });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    db.insert(workers).values({ projectId, name: 'mailer', command: 'php artisan queue:work', processes: 2 }).run();

    const lines: string[] = [];
    logger.on('line', (l: string) => lines.push(l));

    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });
    const result = await runDeploy(deps, deploymentId, logger, new AbortController().signal);

    expect(result).toBe('success');
    expect(sysops.calls).toContain('unitAction restart shipway-worker-queue-app-mailer@1.service');
    expect(sysops.calls).toContain('unitAction restart shipway-worker-queue-app-mailer@2.service');

    const sections = lines.filter((l) => l.includes('==>')).map((l) => l.replace(/^\[[\d:]+\] ==> /, ''));
    expect(sections).toEqual([
      'resolve',
      'export',
      'shared',
      'env',
      'pre_deploy',
      'build',
      'permissions',
      'activate',
      'restart',
      'workers',
      'health',
      'post_deploy',
      'prune',
    ]);
  });

  it('restarts instances for every worker of the project, not just the first', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const { db, sysops, logger, deps } = makeHarness();

    const projectId = insertProject(db, { slug: 'multi-worker', type: 'static' });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    db.insert(workers).values({ projectId, name: 'mailer', command: 'php artisan queue:work', processes: 1 }).run();
    db.insert(workers).values({ projectId, name: 'reaper', command: 'php artisan schedule:work', processes: 1 }).run();

    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });
    const result = await runDeploy(deps, deploymentId, logger, new AbortController().signal);

    expect(result).toBe('success');
    expect(sysops.calls).toContain('unitAction restart shipway-worker-multi-worker-mailer@1.service');
    expect(sysops.calls).toContain('unitAction restart shipway-worker-multi-worker-reaper@1.service');
  });

  it('skips the workers stage silently (no "workers" log section) when the project has no workers', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const { db, logger, deps } = makeHarness();

    const projectId = insertProject(db, { slug: 'no-workers', type: 'static' });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();

    const lines: string[] = [];
    logger.on('line', (l: string) => lines.push(l));

    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });
    const result = await runDeploy(deps, deploymentId, logger, new AbortController().signal);

    expect(result).toBe('success');
    const sections = lines.filter((l) => l.includes('==>')).map((l) => l.replace(/^\[[\d:]+\] ==> /, ''));
    expect(sections).not.toContain('workers');
  });

  it('a worker restart failure triggers rollback the same way a runtime restart failure would', async () => {
    const fixtureDir = tmpDir('shipway-pipeline-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const failUnit = 'shipway-worker-queue-fail-mailer@1.service';
    const { cfg, db, notifications, logger, deps } = makeHarness({
      sysopsFactory: (cfg) => new FailingUnitActionSysOps(sysopsRoot(cfg), failUnit),
    });

    const projectId = insertProject(db, { slug: 'queue-fail', type: 'static' });
    db.update(projects).set({ repo: fileUrl(fixtureDir) }).where(eq(projects.id, projectId)).run();
    db.insert(workers).values({ projectId, name: 'mailer', command: 'php artisan queue:work', processes: 1 }).run();

    const prevReleaseDir = path.join(cfg.appsDir, 'queue-fail', 'releases', 'prev-release');
    fs.mkdirSync(prevReleaseDir, { recursive: true });
    fs.mkdirSync(path.dirname(currentPath(cfg, 'queue-fail')), { recursive: true });
    fs.symlinkSync(prevReleaseDir, currentPath(cfg, 'queue-fail'));

    const deploymentId = insertDeployment(db, { projectId, trigger: 'push' });
    const result = await runDeploy(deps, deploymentId, logger, new AbortController().signal);

    expect(result).toBe('failed');
    const row = getDeploymentRow(db, deploymentId);
    expect(row.status).toBe('failed');

    // rolled back to the previous release, same as a runtime restart failure would
    expect(readCurrentTarget(cfg, 'queue-fail')).toBe(prevReleaseDir);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.status).toBe('failed');
    expect(notifications[0]?.rolledBack).toBe(true);
  });
});
