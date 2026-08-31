import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { projects, workers } from '../db/schema.js';
import { canAccessProject } from '../lib/projectaccess.js';
import { getActor, recordAudit } from '../services/audit.js';
import { applyWorker, removeWorker, workerInstances, type WorkerDeps } from '../services/workers.js';
import { unitNames } from '../system/templates.js';

type ProjectRow = typeof projects.$inferSelect;
type WorkerRow = typeof workers.$inferSelect;

/** How many lines of journal history `GET /api/workers/:id/logs` tails. */
const LOGS_TAIL_LINES = 200;

const projectIdParamsSchema = z.object({ id: z.coerce.number().int() });
const workerIdParamsSchema = z.object({ id: z.coerce.number().int() });
const actionParamsSchema = z.object({
  id: z.coerce.number().int(),
  action: z.enum(['start', 'stop', 'restart']),
});

/** Mirrors templates.ts's private worker-name shape: lowercase alphanumeric + hyphens, 1-31 chars, no leading hyphen. */
const WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Non-empty, single-line (unit files and journalctl invocations can't tolerate embedded newlines). */
const COMMAND_RE = /^[^\r\n]+$/;

/** Bounded on both ends: 0 would busy-loop systemd on a crashing worker, and anything beyond a few
 * minutes is better expressed as a cron job than a restart delay. */
const RESTART_SEC = z.number().int().min(1).max(300);

/** How long a worker gets to finish its current job after SIGTERM. Capped at 30 minutes — past that
 * a deploy would appear to hang while systemd waits. */
const STOP_TIMEOUT_SEC = z.number().int().min(1).max(1800);

const RESTART_POLICY = z.enum(['always', 'on-failure', 'no']);

const createWorkerSchema = z.object({
  name: z.string().regex(WORKER_NAME_RE),
  command: z.string().regex(COMMAND_RE),
  processes: z.number().int().min(1).max(8),
  autoStart: z.boolean().optional(),
  restartPolicy: RESTART_POLICY.optional(),
  restartSec: RESTART_SEC.optional(),
  stopTimeoutSec: STOP_TIMEOUT_SEC.optional(),
});

const patchWorkerSchema = z
  .object({
    command: z.string().regex(COMMAND_RE),
    processes: z.number().int().min(1).max(8),
    autoStart: z.boolean(),
    restartPolicy: RESTART_POLICY,
    restartSec: RESTART_SEC,
    stopTimeoutSec: STOP_TIMEOUT_SEC,
  })
  .partial();

interface WorkerWithProject {
  worker: WorkerRow;
  project: ProjectRow;
}

/**
 * Looks up a worker row by id along with its owning project. `null` if either is missing — OR if the
 * requesting user has no access to that project (`lib/projectaccess.ts`). Every `/api/workers/:id`
 * route already turns `null` into its "worker not found" 404, which is exactly the answer a scoped
 * member should get for a worker on a project they can't see; folding the check in here means it
 * can't be forgotten at one of the four call sites, and these routes are keyed by worker id, so
 * `buildApp`'s path-based project guard can't cover them.
 */
function getWorkerWithProject(app: FastifyInstance, request: FastifyRequest, id: number): WorkerWithProject | null {
  const worker = app.db.select().from(workers).where(eq(workers.id, id)).get();
  if (!worker) {
    return null;
  }
  const project = app.db.select().from(projects).where(eq(projects.id, worker.projectId)).get();
  if (!project) {
    return null;
  }
  if (!canAccessProject(app.db, request.session.get('userId'), project.id)) {
    return null;
  }
  return { worker, project };
}

/** The `shipway-worker-<slug>-<name>@*` journalctl glob covering every instance of a worker. */
function logsPattern(project: ProjectRow, worker: WorkerRow): string {
  const template = unitNames.worker(project.slug, worker.name); // validates slug/name; '...@.service'
  return `${template.slice(0, -'.service'.length)}*`; // '...@*'
}

/**
 * Registers `/api/projects/:id/workers` (list + create) and `/api/workers/:id` (update/delete,
 * plus the `:action` and `logs` sub-routes). All routes here sit under the global session guard in
 * `buildApp`.
 */
export async function workerRoutes(app: FastifyInstance): Promise<void> {
  function deps(): WorkerDeps {
    return { sysops: app.sysops, cfg: app.cfg };
  }

  app.get('/api/projects/:id/workers', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const project = app.db.select({ id: projects.id, slug: projects.slug }).from(projects).where(eq(projects.id, paramsParsed.data.id)).get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const rows = app.db.select().from(workers).where(eq(workers.projectId, project.id)).all();

    const result: Array<WorkerRow & { instances: Array<{ unit: string; status: string }> }> = [];
    for (const row of rows) {
      const instances: Array<{ unit: string; status: string }> = [];
      for (const unit of workerInstances(project.slug, row.name, row.processes)) {
        instances.push({ unit, status: await app.sysops.unitStatus(unit) });
      }
      result.push({ ...row, instances });
    }
    return result;
  });

  app.post('/api/projects/:id/workers', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const project = app.db.select().from(projects).where(eq(projects.id, paramsParsed.data.id)).get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const parsed = createWorkerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const { name, command, processes, autoStart, restartPolicy, restartSec, stopTimeoutSec } = parsed.data;

    const existing = app.db
      .select({ id: workers.id })
      .from(workers)
      .where(and(eq(workers.projectId, project.id), eq(workers.name, name)))
      .get();
    if (existing) {
      return reply.code(409).send({ error: 'a worker with this name already exists for this project' });
    }

    // Every runtime option is optional on create: omitting one takes the column default, which
    // reproduces the behavior workers had before they were configurable at all.
    app.db
      .insert(workers)
      .values({
        projectId: project.id,
        name,
        command,
        processes,
        ...(autoStart !== undefined ? { autoStart } : {}),
        ...(restartPolicy !== undefined ? { restartPolicy } : {}),
        ...(restartSec !== undefined ? { restartSec } : {}),
        ...(stopTimeoutSec !== undefined ? { stopTimeoutSec } : {}),
      })
      .run();
    const created = app.db
      .select()
      .from(workers)
      .where(and(eq(workers.projectId, project.id), eq(workers.name, name)))
      .get();
    if (!created) {
      return reply.code(500).send({ error: 'failed to create worker' });
    }

    await applyWorker(deps(), project, created);

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'worker.create', targetType: 'worker', targetName: created.name, meta: { project: project.slug } });

    return reply.code(201).send(created);
  });

  app.patch('/api/workers/:id', async (request, reply) => {
    const paramsParsed = workerIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'worker not found' });
    }

    const found = getWorkerWithProject(app, request, paramsParsed.data.id);
    if (!found) {
      return reply.code(404).send({ error: 'worker not found' });
    }
    const { worker: existing, project } = found;

    const parsed = patchWorkerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    if (Object.keys(parsed.data).length > 0) {
      app.db.update(workers).set(parsed.data).where(eq(workers.id, existing.id)).run();
    }

    const updated = app.db.select().from(workers).where(eq(workers.id, existing.id)).get();
    if (!updated) {
      return reply.code(500).send({ error: 'failed to update worker' });
    }

    await applyWorker(deps(), project, updated, existing.processes);

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'worker.update', targetType: 'worker', targetName: updated.name, meta: { project: project.slug } });

    return updated;
  });

  app.delete('/api/workers/:id', async (request, reply) => {
    const paramsParsed = workerIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'worker not found' });
    }

    const found = getWorkerWithProject(app, request, paramsParsed.data.id);
    if (!found) {
      return reply.code(404).send({ error: 'worker not found' });
    }
    const { worker, project } = found;

    await removeWorker(deps(), project, worker);
    app.db.delete(workers).where(eq(workers.id, worker.id)).run();

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'worker.delete', targetType: 'worker', targetName: worker.name, meta: { project: project.slug } });

    return reply.code(204).send();
  });

  app.post('/api/workers/:id/:action', async (request, reply) => {
    const paramsParsed = actionParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'worker not found' });
    }

    const found = getWorkerWithProject(app, request, paramsParsed.data.id);
    if (!found) {
      return reply.code(404).send({ error: 'worker not found' });
    }
    const { worker, project } = found;

    for (const unit of workerInstances(project.slug, worker.name, worker.processes)) {
      await app.sysops.unitAction(paramsParsed.data.action, unit);
    }

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'worker.action',
      targetType: 'worker',
      targetName: worker.name,
      meta: { project: project.slug, action: paramsParsed.data.action },
    });

    return reply.code(202).send({ ok: true });
  });

  app.get('/api/workers/:id/logs', async (request, reply) => {
    const paramsParsed = workerIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'worker not found' });
    }

    const found = getWorkerWithProject(app, request, paramsParsed.data.id);
    if (!found) {
      return reply.code(404).send({ error: 'worker not found' });
    }
    const { worker, project } = found;

    const content = await app.sysops.journalTail(logsPattern(project, worker), LOGS_TAIL_LINES);
    return { content };
  });
}
