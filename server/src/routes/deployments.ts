import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as fs from 'node:fs';
import { z } from 'zod';
import { deployments, projects } from '../db/schema.js';
import { getActor, recordAudit } from '../services/audit.js';

const projectIdParamsSchema = z.object({ id: z.coerce.number().int() });
const deploymentIdParamsSchema = z.object({ id: z.coerce.number().int() });
const rollbackBodySchema = z.object({ releasePath: z.string().min(1) });

/** `GET /api/projects/:id/deployments` returns at most this many rows, newest first. */
const DEPLOYMENTS_LIST_LIMIT = 50;

/** Full text of a deployment's log file, or `''` if `logPath` is unset or the file doesn't exist. */
function readLogFile(logPath: string | null): string {
  if (!logPath || !fs.existsSync(logPath)) {
    return '';
  }
  return fs.readFileSync(logPath, 'utf8');
}

/**
 * Registers the deployment routes: kicking off/canceling/rolling back deploys, listing a project's
 * deployment history, and reading a single deployment's log (as a snapshot, or live over a
 * WebSocket). All routes here sit under the global session guard in `buildApp` — including the
 * WebSocket upgrade route, since `buildApp`'s `onRequest` hook runs before the upgrade completes.
 */
export async function deploymentRoutes(app: FastifyInstance): Promise<void> {
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

    return app.db
      .select()
      .from(deployments)
      .where(eq(deployments.projectId, project.id))
      .orderBy(desc(deployments.id))
      .limit(DEPLOYMENTS_LIST_LIMIT)
      .all();
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
    return row;
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
      .select({ logPath: deployments.logPath })
      .from(deployments)
      .where(eq(deployments.id, paramsParsed.data.id))
      .get();
    if (!row) {
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
