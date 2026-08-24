import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { deployments, projects } from '../src/db/schema.js';
import { loadConfig, type Config } from '../src/config.js';
import { DeployQueue, type DeployQueueDeps } from '../src/deploy/queue.js';
import { DeployLogger } from '../src/deploy/logger.js';

// ---------------------------------------------------------------------------
// fixture / test-double helpers
// ---------------------------------------------------------------------------

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function makeCfg(): Config {
  return loadConfig({
    SHIPWAY_DEV: '1',
    SHIPWAY_DATA_DIR: tmpDir('shipway-queue-data'),
    SHIPWAY_APPS_DIR: tmpDir('shipway-queue-apps'),
    SHIPWAY_LOGS_DIR: tmpDir('shipway-queue-logs'),
  });
}

function makeDb(cfg: Config): ShipwayDb {
  return openDb(cfg.dbPath);
}

function insertProject(db: ShipwayDb, slug: string): number {
  db.insert(projects)
    .values({
      name: slug,
      slug,
      repo: `acme/${slug}`,
      branch: 'main',
      type: 'static',
      sharedPaths: [],
      autoDeploy: true,
      smtpMode: 'mailpit',
    })
    .run();
  const row = db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get();
  if (!row) throw new Error('failed to insert test project');
  return row.id;
}

interface SeedDeploymentInput {
  projectId: number;
  status: 'queued' | 'running' | 'success' | 'failed' | 'rolled_back' | 'canceled';
  trigger?: 'push' | 'manual' | 'rollback';
  logPath?: string;
}

/** Seeds a deployment row directly (bypassing `enqueue`) — used for `recoverOnBoot` fixtures. */
function seedDeployment(db: ShipwayDb, input: SeedDeploymentInput): number {
  const result = db
    .insert(deployments)
    .values({
      projectId: input.projectId,
      status: input.status,
      trigger: input.trigger ?? 'push',
      logPath: input.logPath ?? '',
    })
    .run();
  return Number(result.lastInsertRowid);
}

function getDeploymentRow(db: ShipwayDb, id: number): typeof deployments.$inferSelect {
  const row = db.select().from(deployments).where(eq(deployments.id, id)).get();
  if (!row) throw new Error(`deployment ${String(id)} not found`);
  return row;
}

/** A controllable fake `run`: each call's promise stays pending until the test resolves it. */
class FakeRun {
  readonly calls: Array<{ deploymentId: number; signal: AbortSignal; logger: DeployLogger }> = [];
  private readonly pending = new Map<number, { resolve: () => void; reject: (err: unknown) => void }>();

  run = (deploymentId: number, signal: AbortSignal, logger: DeployLogger): Promise<void> => {
    this.calls.push({ deploymentId, signal, logger });
    return new Promise<void>((resolve, reject) => {
      this.pending.set(deploymentId, { resolve, reject });
    });
  };

  resolve(deploymentId: number): void {
    const p = this.pending.get(deploymentId);
    if (!p) throw new Error(`no pending run for deployment ${String(deploymentId)}`);
    this.pending.delete(deploymentId);
    p.resolve();
  }

  reject(deploymentId: number, err: unknown): void {
    const p = this.pending.get(deploymentId);
    if (!p) throw new Error(`no pending run for deployment ${String(deploymentId)}`);
    this.pending.delete(deploymentId);
    p.reject(err);
  }

  started(deploymentId: number): boolean {
    return this.calls.some((c) => c.deploymentId === deploymentId);
  }

  signalFor(deploymentId: number): AbortSignal {
    const call = this.calls.find((c) => c.deploymentId === deploymentId);
    if (!call) throw new Error(`deployment ${String(deploymentId)} never started`);
    return call.signal;
  }
}

/** Flushes pending microtasks (promise chains) so `.then/.catch/.finally` callbacks settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function makeQueue(db: ShipwayDb, cfg: Config, concurrency: number, fakeRun: FakeRun): DeployQueue {
  const deps: DeployQueueDeps = { db, cfg, concurrency, run: fakeRun.run };
  return new DeployQueue(deps);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('DeployQueue', () => {
  it('serializes deploys for the same project (second starts only after the first resolves)', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const fakeRun = new FakeRun();
    const queue = makeQueue(db, cfg, 2, fakeRun);
    const projectId = insertProject(db, 'proj-a');

    const id1 = queue.enqueue({ projectId, trigger: 'push' });
    const id2 = queue.enqueue({ projectId, trigger: 'push' });
    await flush();

    expect(fakeRun.started(id1)).toBe(true);
    expect(fakeRun.started(id2)).toBe(false);

    fakeRun.resolve(id1);
    await flush();

    expect(fakeRun.started(id2)).toBe(true);
  });

  it('enforces a global concurrency cap across different projects', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const fakeRun = new FakeRun();
    const queue = makeQueue(db, cfg, 2, fakeRun);
    const p1 = insertProject(db, 'proj-1');
    const p2 = insertProject(db, 'proj-2');
    const p3 = insertProject(db, 'proj-3');

    const id1 = queue.enqueue({ projectId: p1, trigger: 'push' });
    const id2 = queue.enqueue({ projectId: p2, trigger: 'push' });
    const id3 = queue.enqueue({ projectId: p3, trigger: 'push' });
    await flush();

    expect(fakeRun.started(id1)).toBe(true);
    expect(fakeRun.started(id2)).toBe(true);
    expect(fakeRun.started(id3)).toBe(false);

    fakeRun.resolve(id1);
    await flush();

    expect(fakeRun.started(id3)).toBe(true);
  });

  it('supersedes an older queued push with a newer push for the same project, leaving the running one untouched', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const fakeRun = new FakeRun();
    const queue = makeQueue(db, cfg, 1, fakeRun);
    const projectId = insertProject(db, 'proj-super');

    const running = queue.enqueue({ projectId, trigger: 'push' });
    await flush();
    expect(fakeRun.started(running)).toBe(true);

    const oldQueued = queue.enqueue({ projectId, trigger: 'push' });
    const newQueued = queue.enqueue({ projectId, trigger: 'push' });
    await flush();

    expect(fakeRun.started(oldQueued)).toBe(false);
    expect(fakeRun.started(newQueued)).toBe(false);

    const oldRow = getDeploymentRow(db, oldQueued);
    expect(oldRow.status).toBe('canceled');
    expect(oldRow.finishedAt).not.toBeNull();

    const runningRow = getDeploymentRow(db, running);
    expect(runningRow.status).not.toBe('canceled');

    fakeRun.resolve(running);
    await flush();

    expect(fakeRun.started(newQueued)).toBe(true);
    expect(fakeRun.started(oldQueued)).toBe(false);
  });

  it('does not supersede a queued deployment with a manual enqueue, and a manual enqueue is never itself superseded', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const fakeRun = new FakeRun();
    const queue = makeQueue(db, cfg, 1, fakeRun);
    const projectId = insertProject(db, 'proj-manual');

    const running = queue.enqueue({ projectId, trigger: 'push' });
    await flush();

    const queuedManual = queue.enqueue({ projectId, trigger: 'manual' });
    const queuedPush = queue.enqueue({ projectId, trigger: 'push' });
    await flush();

    // The new push must not supersede the earlier manual enqueue.
    expect(getDeploymentRow(db, queuedManual).status).toBe('queued');
    expect(getDeploymentRow(db, queuedPush).status).toBe('queued');

    fakeRun.resolve(running);
    await flush();

    // FIFO: the manual one (enqueued first) runs before the push behind it.
    expect(fakeRun.started(queuedManual)).toBe(true);
    expect(fakeRun.started(queuedPush)).toBe(false);
  });

  it('cancel on a queued deployment marks it canceled and it never runs', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const fakeRun = new FakeRun();
    const queue = makeQueue(db, cfg, 1, fakeRun);
    const projectId = insertProject(db, 'proj-cancel-queued');

    const running = queue.enqueue({ projectId, trigger: 'push' });
    await flush();
    const queued = queue.enqueue({ projectId, trigger: 'push' });

    queue.cancel(queued);

    const row = getDeploymentRow(db, queued);
    expect(row.status).toBe('canceled');
    expect(row.finishedAt).not.toBeNull();

    fakeRun.resolve(running);
    await flush();

    expect(fakeRun.started(queued)).toBe(false);
  });

  it('cancel on a running deployment aborts its signal', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const fakeRun = new FakeRun();
    const queue = makeQueue(db, cfg, 1, fakeRun);
    const projectId = insertProject(db, 'proj-cancel-running');

    const running = queue.enqueue({ projectId, trigger: 'push' });
    await flush();

    const signal = fakeRun.signalFor(running);
    expect(signal.aborted).toBe(false);

    queue.cancel(running);

    expect(signal.aborted).toBe(true);
  });

  it('cancel on an unknown deployment id is a no-op', () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const fakeRun = new FakeRun();
    const queue = makeQueue(db, cfg, 2, fakeRun);

    expect(() => {
      queue.cancel(999999);
    }).not.toThrow();
  });

  it('recoverOnBoot marks interrupted running rows failed and re-queues queued rows', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const fakeRun = new FakeRun();
    const projectId = insertProject(db, 'proj-recover');

    const wasRunning = seedDeployment(db, { projectId, status: 'running' });
    const wasQueued = seedDeployment(db, { projectId, status: 'queued', logPath: path.join(cfg.logsDir, 'proj-recover', 'q.log') });

    const queue = makeQueue(db, cfg, 2, fakeRun);
    queue.recoverOnBoot();
    await flush();

    const runningRow = getDeploymentRow(db, wasRunning);
    expect(runningRow.status).toBe('failed');
    expect(runningRow.finishedAt).not.toBeNull();

    expect(fakeRun.started(wasQueued)).toBe(true);
  });

  it('getLogger returns the live logger while a deployment runs and undefined once it settles', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const fakeRun = new FakeRun();
    const queue = makeQueue(db, cfg, 1, fakeRun);
    const projectId = insertProject(db, 'proj-logger');

    const id = queue.enqueue({ projectId, trigger: 'push' });
    await flush();

    const logger = queue.getLogger(id);
    expect(logger).toBeInstanceOf(DeployLogger);

    fakeRun.resolve(id);
    await flush();

    expect(queue.getLogger(id)).toBeUndefined();
  });

  it('enqueue throws for an unknown project', () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const fakeRun = new FakeRun();
    const queue = makeQueue(db, cfg, 2, fakeRun);

    expect(() => {
      queue.enqueue({ projectId: 999999, trigger: 'push' });
    }).toThrow();
  });

  it('enqueue creates a queued row with a logPath under cfg.logsDir/<slug>/<id>.log and returns its id', () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const fakeRun = new FakeRun();
    const queue = makeQueue(db, cfg, 1, fakeRun);
    const projectId = insertProject(db, 'proj-row');

    const id = queue.enqueue({
      projectId,
      trigger: 'manual',
      commitSha: 'abc123',
      commitMessage: 'a commit',
    });

    const row = getDeploymentRow(db, id);
    expect(row.trigger).toBe('manual');
    expect(row.commitSha).toBe('abc123');
    expect(row.commitMessage).toBe('a commit');
    expect(row.logPath).toBe(path.join(cfg.logsDir, 'proj-row', `${String(id)}.log`));
  });
});
