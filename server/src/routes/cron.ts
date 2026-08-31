import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cronJobs, projects } from '../db/schema.js';
import { canAccessProject } from '../lib/projectaccess.js';
import { getActor, recordAudit } from '../services/audit.js';
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

/** The host's IANA timezone, or `'UTC'` if the runtime can't name it (a container with no tzdata
 * resolves to an empty string on some builds). Read per request rather than cached, so changing the
 * host timezone doesn't need a Shipway restart to show correctly. */
function hostTimezone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && zone.trim() !== '' ? zone : 'UTC';
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Rewrites a php project's command from a leading `php ` to `php<phpVersion> ` (e.g. `php artisan
 * schedule:run` -> `php8.3 artisan schedule:run`). Non-php projects, projects without a phpVersion,
 * and commands that don't start with exactly `php ` are returned unchanged.
 *
 * Exported so `routes/projects.ts` can apply the same rewrite to the scheduler cron it seeds for a
 * new Laravel project — a second copy of this rule would be free to drift from the one that runs on
 * every later edit.
 */
export function rewritePhpCommand(project: ProjectRow, command: string): string {
  if (project.type === 'php' && project.phpVersion && command.startsWith('php ')) {
    return `php${project.phpVersion} ${command.slice('php '.length)}`;
  }
  return command;
}

interface CronWithProject {
  cron: CronJobRow;
  project: ProjectRow;
}

/**
 * Looks up a cron job row by id along with its owning project. `null` if either is missing — OR if
 * the requesting user has no access to that project (`lib/projectaccess.ts`). Same reasoning as
 * `routes/workers.ts`'s `getWorkerWithProject`: these routes are keyed by cron id, so `buildApp`'s
 * path-based project guard can't reach them, and every call site already renders `null` as the
 * "cron job not found" 404 that a scoped member should see.
 */
function getCronWithProject(app: FastifyInstance, request: FastifyRequest, id: number): CronWithProject | null {
  const cron = app.db.select().from(cronJobs).where(eq(cronJobs.id, id)).get();
  if (!cron) {
    return null;
  }
  const project = app.db.select().from(projects).where(eq(projects.id, cron.projectId)).get();
  if (!project) {
    return null;
  }
  if (!canAccessProject(app.db, request.session.get('userId'), project.id)) {
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

    const project = app.db.select({ id: projects.id, slug: projects.slug }).from(projects).where(eq(projects.id, paramsParsed.data.id)).get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const jobs = app.db.select().from(cronJobs).where(eq(cronJobs.projectId, project.id)).all();

    // `jobs` plus the context the dashboard needs to explain a schedule rather than just echo it —
    // see `renderCronLine` in system/templates.ts, which is what these describe:
    //  - `timezone`: the HOST's clock, which is the one cron actually fires on. Without it the
    //    dashboard would compute "next run" against the viewer's browser timezone and quietly show
    //    the wrong time to anyone in a different one.
    //  - `workingDir`/`logDir`: the `cd` target and the log destination every rendered crontab line
    //    gets, so the UI can answer "where does this run" and "where do I look when it fails"
    //    without the reader having to know the layout.
    return {
      jobs,
      timezone: hostTimezone(),
      workingDir: `${app.cfg.appsDir}/${project.slug}/current`,
      logDir: `${app.cfg.logsDir}/${project.slug}`,
    };
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

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'cron.create', targetType: 'cron', targetName: created.command, meta: { project: project.slug } });

    return reply.code(201).send(created);
  });

  app.patch('/api/cron/:id', async (request, reply) => {
    const paramsParsed = cronIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'cron job not found' });
    }

    const found = getCronWithProject(app, request, paramsParsed.data.id);
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

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'cron.update', targetType: 'cron', targetName: updated.command, meta: { project: project.slug } });

    return updated;
  });

  app.delete('/api/cron/:id', async (request, reply) => {
    const paramsParsed = cronIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'cron job not found' });
    }

    const found = getCronWithProject(app, request, paramsParsed.data.id);
    if (!found) {
      return reply.code(404).send({ error: 'cron job not found' });
    }
    const { cron, project } = found;

    app.db.delete(cronJobs).where(eq(cronJobs.id, cron.id)).run();

    try {
      await syncCrontab(deps());
    } catch (err) {
      // Best-effort: the row is already gone even though the host crontab couldn't be resynced —
      // a later mutation (or a manual retry) will pick it up. Surfaced via the error body since a
      // 204 can't carry one.
      return reply.code(502).send({ error: 'cron job deleted, but crontab sync failed', detail: toErrorMessage(err) });
    }

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'cron.delete', targetType: 'cron', targetName: cron.command, meta: { project: project.slug } });

    return reply.code(204).send();
  });
}
