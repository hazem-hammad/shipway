import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as fs from 'node:fs';
import { z } from 'zod';
import { deployments, projects } from '../db/schema.js';
import { accessibleProjectIds, canAccessProject } from '../lib/projectaccess.js';
import { getActor, recordAudit } from '../services/audit.js';

const projectIdParamsSchema = z.object({ id: z.coerce.number().int() });
const deploymentIdParamsSchema = z.object({ id: z.coerce.number().int() });
const rollbackBodySchema = z.object({ releasePath: z.string().min(1) });

/** `GET /api/projects/:id/deployments` returns at most this many rows, newest first. */
const DEPLOYMENTS_LIST_LIMIT = 50;

/** `GET /api/deployments` (Task 5's global list): default/max `limit`, mirroring the audit list's
 * pagination limits (`routes/audit.ts`). */
const GLOBAL_DEPLOYMENTS_DEFAULT_LIMIT = 50;
const GLOBAL_DEPLOYMENTS_MAX_LIMIT = 100;

const globalListQuerySchema = z.object({ limit: z.coerce.number().int().positive().optional() });

/** Full text of a deployment's log file, or `''` if `logPath` is unset or the file doesn't exist. */
function readLogFile(logPath: string | null): string {
  if (!logPath || !fs.existsSync(logPath)) {
    return '';
  }
  return fs.readFileSync(logPath, 'utf8');
}

type DeploymentRow = typeof deployments.$inferSelect;

/** A deployment row's status is terminal once it's one of these — never `cancelRequested`. */
const TERMINAL_STATUSES = new Set<DeploymentRow['status']>(['success', 'failed', 'rolled_back', 'canceled']);

/**
 * Adds the queue's in-memory `cancelRequested` flag (Task 2's "Canceling…" UI hint) to a
 * deployment row: `true` only while `queue.cancel()` has been called on this deployment's actually-
 * *running* entry but the run hasn't settled yet (`DeployQueue.isCancelRequested`'s own contract
 * already scopes it that tightly — it's never true for a merely-queued row). The terminal-status
 * check here is belt-and-suspenders against the narrow window where a row has just been patched to
 * its final status but the queue's own bookkeeping hasn't cleared yet: a terminal row must never
 * report `cancelRequested: true`, full stop.
 */
function withCancelRequested<T extends Pick<DeploymentRow, 'id' | 'status'>>(
  app: FastifyInstance,
  row: T,
): T & { cancelRequested: boolean } {
  return { ...row, cancelRequested: !TERMINAL_STATUSES.has(row.status) && app.queue.isCancelRequested(row.id) };
}

/**
 * Registers the deployment routes: kicking off/canceling/rolling back deploys, listing a project's
 * deployment history, and reading a single deployment's log (as a snapshot, or live over a
 * WebSocket). All routes here sit under the global session guard in `buildApp` — including the
 * WebSocket upgrade route, since `buildApp`'s `onRequest` hook runs before the upgrade completes.
 */
export async function deploymentRoutes(app: FastifyInstance): Promise<void> {
  // Task 5's global deployments list (spec §1's "Global deployments" row / §2's
  // `GET /api/deployments?limit=100`): recent deployments across every project, newest first, with
  // the owning project's name/slug joined in — distinct from `/api/projects/:id/deployments` above
  // (one project's history), which Fastify's router never confuses with this exact-path route.
  app.get('/api/deployments', async (request, reply) => {
    const parsedQuery = globalListQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: 'invalid query' });
    }
    const limit = Math.min(parsedQuery.data.limit ?? GLOBAL_DEPLOYMENTS_DEFAULT_LIMIT, GLOBAL_DEPLOYMENTS_MAX_LIMIT);

    // Scoped members see only their own projects' deploys here (see `lib/projectaccess.ts`); `null`
    // is unscoped and filters nothing. Applied as a WHERE rather than after the fact, so `limit`
    // still returns up to `limit` rows the caller can actually see instead of a short page.
    const allowed = accessibleProjectIds(app.db, request.session.get('userId'));
    const scope = allowed === null ? undefined : inArray(deployments.projectId, allowed.size > 0 ? [...allowed] : [-1]);

    return app.db
      .select({
        id: deployments.id,
        projectId: deployments.projectId,
        projectName: projects.name,
        projectSlug: projects.slug,
        status: deployments.status,
        trigger: deployments.trigger,
        branch: deployments.branch,
        commitSha: deployments.commitSha,
        commitMessage: deployments.commitMessage,
        startedAt: deployments.startedAt,
        finishedAt: deployments.finishedAt,
      })
      .from(deployments)
      .innerJoin(projects, eq(deployments.projectId, projects.id))
      .where(scope)
      .orderBy(desc(deployments.id))
      .limit(limit)
      .all();
  });

  app.post('/api/projects/:id/deploy', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const project = app.db.select({ id: projects.id, slug: projects.slug }).from(projects).where(eq(projects.id, paramsParsed.data.id)).get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const deploymentId = app.queue.enqueue({ projectId: project.id, trigger: 'manual' });

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'deploy.trigger', targetType: 'project', targetName: project.slug, meta: { trigger: 'manual', deploymentId } });

    return reply.code(202).send({ deploymentId });
  });

  app.post('/api/projects/:id/rollback', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const project = app.db.select({ id: projects.id, slug: projects.slug }).from(projects).where(eq(projects.id, paramsParsed.data.id)).get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const bodyParsed = rollbackBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const { releasePath } = bodyParsed.data;

    // The releasePath must belong to a deployment row of THIS project — otherwise a caller could
    // point a project at an arbitrary path (another project's release, or any string at all) and
    // have the pipeline activate it as if it were a real, already-built release of this project.
    const owningDeployment = app.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.projectId, project.id), eq(deployments.releasePath, releasePath)))
      .get();
    if (!owningDeployment) {
      return reply.code(400).send({ error: 'releasePath does not belong to a deployment of this project' });
    }

    const deploymentId = app.queue.enqueue({ projectId: project.id, trigger: 'rollback', releasePath });

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'deploy.rollback', targetType: 'project', targetName: project.slug, meta: { releasePath, deploymentId } });

    return reply.code(202).send({ deploymentId });
  });

  app.get('/api/projects/:id/deployments', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const project = app.db.select({ id: projects.id }).from(projects).where(eq(projects.id, paramsParsed.data.id)).get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const rows = app.db
      .select()
      .from(deployments)
      .where(eq(deployments.projectId, project.id))
      .orderBy(desc(deployments.id))
      .limit(DEPLOYMENTS_LIST_LIMIT)
      .all();
    return rows.map((row) => withCancelRequested(app, row));
  });

  app.get('/api/deployments/:id', async (request, reply) => {
    const paramsParsed = deploymentIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'deployment not found' });
    }

    const row = app.db.select().from(deployments).where(eq(deployments.id, paramsParsed.data.id)).get();
    if (!row) {
      return reply.code(404).send({ error: 'deployment not found' });
    }
    // Keyed by deployment id, so the owning project is only known once the row is loaded — the
    // path-based guard in `buildApp` can't cover this one. Reported as a deployment-not-found 404
    // for the same reason that guard 404s: a scoped member can't probe for what they can't see.
    if (!canAccessProject(app.db, request.session.get('userId'), row.projectId)) {
      return reply.code(404).send({ error: 'deployment not found' });
    }
    return withCancelRequested(app, row);
  });

  app.post('/api/deployments/:id/cancel', async (request, reply) => {
    const paramsParsed = deploymentIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'deployment not found' });
    }

    const row = app.db.select({ id: deployments.id, projectId: deployments.projectId }).from(deployments).where(eq(deployments.id, paramsParsed.data.id)).get();
    if (!row) {
      return reply.code(404).send({ error: 'deployment not found' });
    }
    if (!canAccessProject(app.db, request.session.get('userId'), row.projectId)) {
      return reply.code(404).send({ error: 'deployment not found' });
    }

    app.queue.cancel(row.id);

    const project = app.db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, row.projectId)).get();
    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'deploy.cancel', targetType: 'deployment', targetName: project?.slug ?? String(row.id) });

    return reply.code(202).send({});
  });

  app.get('/api/deployments/:id/log', async (request, reply) => {
    const paramsParsed = deploymentIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'deployment not found' });
    }

    const row = app.db
      .select({ logPath: deployments.logPath, projectId: deployments.projectId })
      .from(deployments)
      .where(eq(deployments.id, paramsParsed.data.id))
      .get();
    if (!row) {
      return reply.code(404).send({ error: 'deployment not found' });
    }
    // A deploy log carries build output and command lines from the project's own repo — exactly the
    // thing a member scoped away from that project must not read.
    if (!canAccessProject(app.db, request.session.get('userId'), row.projectId)) {
      return reply.code(404).send({ error: 'deployment not found' });
    }

    return { content: readLogFile(row.logPath) };
  });

  // WebSocket log tail: sends whatever's already on disk as one message, then (only while the
  // deployment is actually running) subscribes to the live logger and forwards each new line as
  // its own message, closing the socket once the run ends. A deployment that isn't currently
  // running (already terminal, or still queued) has no live logger to subscribe to — the backlog
  // is everything that will ever arrive, so the socket closes right after sending it.
  app.get('/api/deployments/:id/logs/stream', { websocket: true }, (socket, request) => {
    const paramsParsed = deploymentIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      socket.close();
      return;
    }

    const row = app.db.select().from(deployments).where(eq(deployments.id, paramsParsed.data.id)).get();
    if (!row) {
      socket.close();
      return;
    }
    // Same content as the snapshot route above, so the same scope check — closed silently, since a
    // WebSocket that has already upgraded has no status code left to answer with.
    if (!canAccessProject(app.db, request.session.get('userId'), row.projectId)) {
      socket.close();
      return;
    }

    const existingContent = readLogFile(row.logPath);
    if (existingContent) {
      socket.send(existingContent);
    }

    const logger = app.queue.getLogger(row.id);
    if (!logger) {
      socket.close();
      return;
    }

    const onLine = (line: string): void => {
      if (socket.readyState === socket.OPEN) {
        socket.send(line);
      }
    };
    const cleanup = (): void => {
      logger.off('line', onLine);
      logger.off('end', onEnd);
    };
    const onEnd = (): void => {
      cleanup();
      socket.close();
    };

    logger.on('line', onLine);
    logger.on('end', onEnd);
    socket.on('close', cleanup);
  });
}
