/**
 * Schedules deploys: `enqueue` records a `queued` deployment row and hands it to an in-memory
 * FIFO queue; `pump` starts eligible items (never two running for the same project, never more
 * than `deps.concurrency` running overall) whenever something is enqueued or a run settles.
 *
 * `deps.run` is expected to be a thin wrapper around `runDeploy` (see `./pipeline.ts`) — it owns
 * setting the deployment row to `running` and to its terminal status, and it never throws. This
 * queue only manages *scheduling*: which deployment gets a `DeployLogger` + `AbortController` and
 * when, per-project serialization, the global concurrency cap, and the supersede rule below.
 *
 * Supersede rule: enqueuing a new `'push'` while a `'push'` deployment for the same project is
 * still queued (not yet running) cancels that older queued push and drops it from the queue before
 * the new one is added. `'manual'`/`'rollback'` enqueues never supersede anything and are never
 * superseded themselves — they always queue behind whatever's already there.
 */
import { eq } from 'drizzle-orm';
import * as path from 'node:path';
import type { Config } from '../config.js';
import type { ShipwayDb } from '../db/index.js';
import { deployments, projects } from '../db/schema.js';
import { DeployLogger } from './logger.js';

type Trigger = 'push' | 'manual' | 'rollback';
type DeploymentStatus = (typeof deployments.$inferSelect)['status'];

export interface DeployQueueDeps {
  db: ShipwayDb;
  cfg: Config;
  concurrency: number;
  run: (deploymentId: number, signal: AbortSignal, logger: DeployLogger) => Promise<void>;
}

export interface EnqueueInput {
  projectId: number;
  trigger: Trigger;
  commitSha?: string;
  commitMessage?: string;
  releasePath?: string;
}

interface QueueItem {
  id: number;
  projectId: number;
  trigger: Trigger;
  logPath: string;
}

interface RunningEntry {
  projectId: number;
  controller: AbortController;
}

const NON_TERMINAL_STATUSES: readonly DeploymentStatus[] = ['queued', 'running'];

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class DeployQueue {
  private readonly deps: DeployQueueDeps;
  private readonly queue: QueueItem[] = [];
  private readonly running = new Map<number, RunningEntry>();
  private readonly loggers = new Map<number, DeployLogger>();

  constructor(deps: DeployQueueDeps) {
    this.deps = deps;
  }

  /** Creates a `queued` deployment row for `p.projectId` and schedules it. Returns its id. */
  enqueue(p: EnqueueInput): number {
    const project = this.deps.db.select().from(projects).where(eq(projects.id, p.projectId)).get();
    if (!project) {
      throw new Error(`project ${String(p.projectId)} not found`);
    }

    if (p.trigger === 'push') {
      this.supersedeQueuedPush(p.projectId);
    }

    const inserted = this.deps.db
      .insert(deployments)
      .values({
        projectId: p.projectId,
        status: 'queued',
        trigger: p.trigger,
        commitSha: p.commitSha ?? null,
        commitMessage: p.commitMessage ?? null,
        releasePath: p.releasePath ?? null,
        logPath: '',
      })
      .run();
    const id = Number(inserted.lastInsertRowid);

    const logPath = path.join(this.deps.cfg.logsDir, project.slug, `${String(id)}.log`);
    this.deps.db.update(deployments).set({ logPath }).where(eq(deployments.id, id)).run();

    this.queue.push({ id, projectId: p.projectId, trigger: p.trigger, logPath });
    this.pump();
    return id;
  }

  /** Running: aborts its signal. Queued: removes it and marks the row `canceled`. Otherwise: no-op. */
  cancel(deploymentId: number): void {
    const runningEntry = this.running.get(deploymentId);
    if (runningEntry) {
      runningEntry.controller.abort();
      return;
    }

    const idx = this.queue.findIndex((item) => item.id === deploymentId);
    if (idx === -1) {
      return; // unknown, or already terminal — nothing to do
    }
    this.queue.splice(idx, 1);
    this.markCanceled(deploymentId);
  }

  /**
   * Called once at boot, before the queue has scheduled anything: rows left `running` by a killed
   * process are interrupted, so they're marked `failed`; rows left `queued` are still valid work,
   * so they're re-added to the in-memory queue (oldest first) and the queue is pumped.
   */
  recoverOnBoot(): void {
    const runningRows = this.deps.db.select().from(deployments).where(eq(deployments.status, 'running')).all();
    for (const row of runningRows) {
      this.deps.db
        .update(deployments)
        .set({ status: 'failed', finishedAt: Date.now() })
        .where(eq(deployments.id, row.id))
        .run();
    }

    const queuedRows = this.deps.db
      .select()
      .from(deployments)
      .where(eq(deployments.status, 'queued'))
      .orderBy(deployments.id)
      .all();
    for (const row of queuedRows) {
      this.queue.push({ id: row.id, projectId: row.projectId, trigger: row.trigger, logPath: row.logPath ?? '' });
    }

    this.pump();
  }

  /** The live logger for a currently-running deployment, or `undefined` if it's not running. */
  getLogger(deploymentId: number): DeployLogger | undefined {
    return this.loggers.get(deploymentId);
  }

  private markCanceled(deploymentId: number): void {
    this.deps.db
      .update(deployments)
      .set({ status: 'canceled', finishedAt: Date.now() })
      .where(eq(deployments.id, deploymentId))
      .run();
  }

  /** Cancels + drops the older queued `'push'` for `projectId`, if one is sitting in the queue. */
  private supersedeQueuedPush(projectId: number): void {
    const idx = this.queue.findIndex((item) => item.projectId === projectId && item.trigger === 'push');
    if (idx === -1) {
      return;
    }
    const [old] = this.queue.splice(idx, 1);
    if (!old) {
      return;
    }
    this.markCanceled(old.id);
  }

  /** Starts every eligible queued item until the concurrency cap is hit or none remain eligible. */
  private pump(): void {
    for (;;) {
      if (this.running.size >= this.deps.concurrency) {
        return;
      }
      const idx = this.queue.findIndex((item) => !this.isProjectRunning(item.projectId));
      if (idx === -1) {
        return;
      }
      const item = this.queue.splice(idx, 1)[0];
      if (!item) {
        return;
      }
      this.start(item);
    }
  }

  private isProjectRunning(projectId: number): boolean {
    for (const entry of this.running.values()) {
      if (entry.projectId === projectId) {
        return true;
      }
    }
    return false;
  }

  private start(item: QueueItem): void {
    const logger = new DeployLogger(item.logPath);
    const controller = new AbortController();
    this.running.set(item.id, { projectId: item.projectId, controller });
    this.loggers.set(item.id, logger);

    void this.deps.run(item.id, controller.signal, logger)
      .catch((err: unknown) => {
        // `deps.run` (a `runDeploy` wrapper) is contractually not supposed to throw — but if it
        // does anyway, don't leave the row stuck `queued`/`running` forever.
        logger.line(`ERROR: unexpected queue run failure: ${errMessage(err)}`);
        const row = this.deps.db.select().from(deployments).where(eq(deployments.id, item.id)).get();
        if (row && NON_TERMINAL_STATUSES.includes(row.status)) {
          this.deps.db
            .update(deployments)
            .set({ status: 'failed', finishedAt: Date.now() })
            .where(eq(deployments.id, item.id))
            .run();
        }
      })
      .finally(() => {
        logger.close(); // idempotent — a no-op if the pipeline already closed it
        this.running.delete(item.id);
        this.loggers.delete(item.id);
        this.pump();
      });
  }
}
