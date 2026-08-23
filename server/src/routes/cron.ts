import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cronJobs, projects } from '../db/schema.js';
import { syncCrontab, validateCronExpr, type CronDeps } from '../services/cron.js';

type ProjectRow = typeof projects.$inferSelect;
type CronJobRow = typeof cronJobs.$inferSelect;

const projectIdParamsSchema = z.object({ id: z.coerce.number().int() });
const cronIdParamsSchema = z.object({ id: z.coerce.number().int() });

/** Non-empty, single-line (crontab entries can't tolerate embedded newlines). */
const COMMAND_RE = /^[^\r\n]+$/;

const createCronSchema = z.object({
  schedule: z.string(),
  command: z.string(),
});

const patchCronSchema = z
  .object({
    schedule: z.string(),
    command: z.string(),
  })
  .partial();

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Rewrites a php project's command from a leading `php ` to `php<phpVersion> ` (e.g. `php artisan
 * schedule:run` -> `php8.3 artisan schedule:run`). Non-php projects, projects without a phpVersion,
 * and commands that don't start with exactly `php ` are returned unchanged.
 */
function rewritePhpCommand(project: ProjectRow, command: string): string {
  if (project.type === 'php' && project.phpVersion && command.startsWith('php ')) {
    return `php${project.phpVersion} ${command.slice('php '.length)}`;
  }
  return command;
}

interface CronWithProject {
  cron: CronJobRow;
  project: ProjectRow;
}

/** Looks up a cron job row by id along with its owning project. `null` if either is missing. */
function getCronWithProject(app: FastifyInstance, id: number): CronWithProject | null {
  const cron = app.db.select().from(cronJobs).where(eq(cronJobs.id, id)).get();
  if (!cron) {
    return null;
  }
  const project = app.db.select().from(projects).where(eq(projects.id, cron.projectId)).get();
  if (!project) {
    return null;
  }
  return { cron, project };
}

/**
 * Registers `/api/projects/:id/cron` (list + create) and `/api/cron/:id` (update/delete). All
 * routes here sit under the global session guard in `buildApp`. Every mutation calls `syncCrontab`
 * (host mutation) inside a try/catch, per `databases.ts`'s pattern — never `workers.ts`'s (whose
 * reviewer flagged writing DB rows before host mutations with no try/catch): the DB write always
 * happens first here, and a `syncCrontab` failure is caught and reconciled (row deleted/restored)
 * before returning 502, so the DB and the host crontab never drift apart from a route's point of
 * view.
 */
export async function cronRoutes(app: FastifyInstance): Promise<void> {
  function deps(): CronDeps {
    return { db: app.db, sysops: app.sysops, cfg: app.cfg };
  }

  app.get('/api/projects/:id/cron', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const project = app.db.select({ id: projects.id }).from(projects).where(eq(projects.id, paramsParsed.data.id)).get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    return app.db.select().from(cronJobs).where(eq(cronJobs.projectId, project.id)).all();
  });

  app.post('/api/projects/:id/cron', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const project = app.db.select().from(projects).where(eq(projects.id, paramsParsed.data.id)).get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const parsed = createCronSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const { schedule, command } = parsed.data;

    if (!validateCronExpr(schedule)) {
      return reply.code(400).send({ error: 'invalid cron expression' });
    }
    if (!COMMAND_RE.test(command)) {
      return reply.code(400).send({ error: 'invalid command' });
    }

    const finalCommand = rewritePhpCommand(project, command);

    const inserted = app.db.insert(cronJobs).values({ projectId: project.id, schedule, command: finalCommand }).run();
    const id = Number(inserted.lastInsertRowid);

    try {
      await syncCrontab(deps());
    } catch (err) {
      app.db.delete(cronJobs).where(eq(cronJobs.id, id)).run();
      return reply.code(502).send({ error: 'crontab sync failed', detail: toErrorMessage(err) });
    }

    const created = app.db.select().from(cronJobs).where(eq(cronJobs.id, id)).get();
    if (!created) {
      return reply.code(500).send({ error: 'failed to create cron job' });
    }

    return reply.code(201).send(created);
  });

  app.patch('/api/cron/:id', async (request, reply) => {
    const paramsParsed = cronIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'cron job not found' });
    }

    const found = getCronWithProject(app, paramsParsed.data.id);
    if (!found) {
      return reply.code(404).send({ error: 'cron job not found' });
    }
    const { cron: existing, project } = found;

    const parsed = patchCronSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const patch: Partial<{ schedule: string; command: string }> = {};
    if (parsed.data.schedule !== undefined) {
      if (!validateCronExpr(parsed.data.schedule)) {
        return reply.code(400).send({ error: 'invalid cron expression' });
      }
      patch.schedule = parsed.data.schedule;
    }
    if (parsed.data.command !== undefined) {
      if (!COMMAND_RE.test(parsed.data.command)) {
        return reply.code(400).send({ error: 'invalid command' });
      }
      patch.command = rewritePhpCommand(project, parsed.data.command);
    }

    if (Object.keys(patch).length > 0) {
      app.db.update(cronJobs).set(patch).where(eq(cronJobs.id, existing.id)).run();
    }

    try {
      await syncCrontab(deps());
    } catch (err) {
      // Restore the pre-patch values so the DB and the (unsynced) host crontab stay consistent.
      app.db.update(cronJobs).set({ schedule: existing.schedule, command: existing.command }).where(eq(cronJobs.id, existing.id)).run();
      return reply.code(502).send({ error: 'crontab sync failed', detail: toErrorMessage(err) });
    }

    const updated = app.db.select().from(cronJobs).where(eq(cronJobs.id, existing.id)).get();
    if (!updated) {
      return reply.code(500).send({ error: 'failed to update cron job' });
    }

    return updated;
  });

  app.delete('/api/cron/:id', async (request, reply) => {
    const paramsParsed = cronIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'cron job not found' });
    }

    const cron = app.db.select().from(cronJobs).where(eq(cronJobs.id, paramsParsed.data.id)).get();
    if (!cron) {
      return reply.code(404).send({ error: 'cron job not found' });
    }

    app.db.delete(cronJobs).where(eq(cronJobs.id, cron.id)).run();

    try {
      await syncCrontab(deps());
    } catch (err) {
      // Best-effort: the row is already gone even though the host crontab couldn't be resynced —
      // a later mutation (or a manual retry) will pick it up. Surfaced via the error body since a
      // 204 can't carry one.
      return reply.code(502).send({ error: 'cron job deleted, but crontab sync failed', detail: toErrorMessage(err) });
    }

    return reply.code(204).send();
  });
}
