import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { deployments, projects } from '../src/db/schema.js';
import { loadConfig, type Config } from '../src/config.js';
import { DevSysOps } from '../src/sysops/dev.js';
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
  };
}

interface BaseHarness {
  cfg: Config;
  db: ShipwayDb;
  sysops: DevSysOps;
  gitOps: GitOps;
  shell: RecordingShell;
  secretBox: SecretBox;
  notifications: Array<{ project: string; status: 'success' | 'failed'; deploymentId: number; message: string }>;
  fetchHttp: (url: string) => Promise<{ status: number }>;
  logger: DeployLogger;
  deps: PipelineDeps;
}

function makeHarness(opts: { fetchHttp?: (url: string) => Promise<{ status: number }>; gitOps?: GitOps } = {}): BaseHarness {
  const cfg = makeCfg();
  const db = makeDb(cfg);
  const sysops = new DevSysOps(sysopsRoot(cfg));
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

    // install ran in the release dir
    expect(shell.calls).toEqual([{ cmd: 'composer install', cwd: releaseDir }]);

    // php restart, not systemd
    expect(sysops.calls).toContain('reloadPhpFpm 8.3');
    expect(sysops.calls.some((c) => c.startsWith('unitAction'))).toBe(false);

    // log sections in order
    const sections = lines.filter((l) => l.includes('==>')).map((l) => l.replace(/^\[[\d:]+\] ==> /, ''));
    expect(sections).toEqual(['resolve', 'export', 'shared', 'env', 'pre_deploy', 'build', 'activate', 'restart', 'health', 'post_deploy', 'prune']);

    // notify called on success
    expect(notifications).toEqual([{ project: 'shop', status: 'success', deploymentId, message: 'first commit' }]);
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
  });
});
