/**
 * A project's notification settings: `GET`/`PUT /api/projects/:id/notifications` (the recipient
 * email list plus which deploy events they're mailed about) and
 * `POST /api/projects/:id/notifications/test` (a real send to every recipient through instance mail).
 *
 * Replaces the instance-wide `/api/notifications` channel API — notifications are per-project now,
 * and email is the only delivery mechanism (see `services/notifybus.ts`). `GET` is member-readable,
 * matching `GET /api/projects/:id`; the `PUT` and the test-send are admin+, matching every other
 * project mutation.
 *
 * `PUT` is replace-all rather than per-row CRUD: the UI is one card with a Save button, so the whole
 * list and the whole event set arrive together and the stored rows are made to match exactly.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectNotificationEvents, projectNotificationRecipients, projects } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import { requireRole } from '../lib/authz.js';
import { getActor, recordAudit } from '../services/audit.js';
import { getMailConfig, isMailConfigured, sendMail } from '../services/mailer.js';
import { EVENTS, EVENT_KEYS, getProjectRecipients, getProjectSubscribedEvents, type NotifyEvent } from '../services/notifybus.js';
import { buildTestNotificationEmail } from '../services/notifyemail.js';

const projectIdParamsSchema = z.object({ id: z.coerce.number().int() });

/** Guards against a paste of a thousand addresses becoming a thousand SMTP sends per deploy. Well
 * above any real team's list. */
const MAX_RECIPIENTS = 50;

const updateSchema = z.object({
  recipients: z.array(z.string()).max(MAX_RECIPIENTS),
  events: z.array(z.enum(EVENT_KEYS as [NotifyEvent, ...NotifyEvent[]])),
});

const emailSchema = z.string().email();

interface ProjectNotificationsResponse {
  recipients: string[];
  events: { event: NotifyEvent; label: string; description: string; enabled: boolean }[];
  /** Whether instance mail (Settings > Mail) is configured at all. `false` means nothing will
   * actually be delivered no matter what's saved here — the UI says so rather than letting an admin
   * configure recipients that silently never receive anything. */
  mailConfigured: boolean;
}

function buildResponse(app: FastifyInstance, projectId: number): ProjectNotificationsResponse {
  const enabled = new Set<NotifyEvent>(getProjectSubscribedEvents(app.db, projectId));
  return {
    recipients: getProjectRecipients(app.db, projectId),
    events: EVENT_KEYS.map((event) => ({ event, ...EVENTS[event], enabled: enabled.has(event) })),
    mailConfigured: isMailConfigured(getMailConfig(app.db, app.secretBox)),
  };
}

/** Normalizes and validates a submitted recipient list: each address trimmed and lowercased (so
 * `Ops@X.com` and `ops@x.com` can't both sit on the list and double every notification), blanks
 * dropped, duplicates collapsed, order preserved. Returns an error message instead of a list if any
 * surviving entry isn't a valid address. */
function normalizeRecipients(raw: string[]): { emails: string[] } | { error: string } {
  const emails: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const email = entry.trim().toLowerCase();
    if (email === '') continue;
    if (!emailSchema.safeParse(email).success) {
      return { error: `"${entry.trim()}" is not a valid email address` };
    }
    if (seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return { emails };
}

export async function projectNotificationRoutes(app: FastifyInstance): Promise<void> {
  /** Resolves `:id` to an existing project, replying 404 itself when it can't. The slug comes back
   * alongside the id because the test-send's email is headlined with it. */
  function resolveProject(
    request: { params: unknown },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): { id: number; slug: string } | null {
    const parsed = projectIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(404).send({ error: 'project not found' });
      return null;
    }
    const project = app.db.select({ id: projects.id, slug: projects.slug }).from(projects).where(eq(projects.id, parsed.data.id)).get();
    if (!project) {
      reply.code(404).send({ error: 'project not found' });
      return null;
    }
    return project;
  }

  app.get('/api/projects/:id/notifications', async (request, reply) => {
    const project = resolveProject(request, reply);
    if (!project) return;
    return buildResponse(app, project.id);
  });

  app.put('/api/projects/:id/notifications', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const project = resolveProject(request, reply);
    if (!project) return;
    const projectId = project.id;

    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: `recipients must be a list of at most ${String(MAX_RECIPIENTS)} addresses, events a list of known deploy events` });
    }

    const normalized = normalizeRecipients(parsed.data.recipients);
    if ('error' in normalized) {
      return reply.code(400).send({ error: normalized.error });
    }
    const { emails } = normalized;
    const events = [...new Set(parsed.data.events)];

    // Replace-all, but by DIFF rather than delete-then-reinsert: an unchanged recipient keeps its
    // row (and its created_at, which orders the list) instead of being churned on every save.
    const existingEmails = getProjectRecipients(app.db, projectId);
    const removed = existingEmails.filter((email) => !emails.includes(email));
    const added = emails.filter((email) => !existingEmails.includes(email));
    if (removed.length > 0) {
      app.db
        .delete(projectNotificationRecipients)
        .where(and(eq(projectNotificationRecipients.projectId, projectId), inArray(projectNotificationRecipients.email, removed)))
        .run();
    }
    if (added.length > 0) {
      app.db
        .insert(projectNotificationRecipients)
        .values(added.map((email) => ({ projectId, email })))
        .onConflictDoNothing()
        .run();
    }

    const existingEvents = getProjectSubscribedEvents(app.db, projectId);
    const removedEvents = existingEvents.filter((event) => !events.includes(event));
    const addedEvents = events.filter((event) => !existingEvents.includes(event));
    if (removedEvents.length > 0) {
      app.db
        .delete(projectNotificationEvents)
        .where(and(eq(projectNotificationEvents.projectId, projectId), inArray(projectNotificationEvents.event, removedEvents)))
        .run();
    }
    if (addedEvents.length > 0) {
      app.db
        .insert(projectNotificationEvents)
        .values(addedEvents.map((event) => ({ projectId, event })))
        .onConflictDoNothing()
        .run();
    }

    // meta carries counts and event names — never the addresses themselves, which are personal data
    // and have no business in a durable audit row.
    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'project.notifications.update',
      targetType: 'project',
      targetName: String(projectId),
      meta: { recipients: emails.length, events },
    });

    return buildResponse(app, projectId);
  });

  app.post('/api/projects/:id/notifications/test', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const project = resolveProject(request, reply);
    if (!project) return;
    const projectId = project.id;

    const recipients = getProjectRecipients(app.db, projectId);
    if (recipients.length === 0) {
      return { ok: false, error: 'add at least one recipient first' };
    }

    const cfg = getMailConfig(app.db, app.secretBox);
    if (!isMailConfigured(cfg)) {
      return { ok: false, error: 'instance mail is not configured — see Settings > Mail' };
    }

    // Built from the real deploy template with sample values, so the test proves the APPEARANCE as
    // well as the delivery path — an admin clicking this wants to see what their team will get.
    const email = buildTestNotificationEmail(project.slug, projectId, getSetting<string>(app.db, 'base_domain') ?? null);

    // Every recipient at once, so one unreachable address doesn't hold the request open for the
    // others (each `sendMail` is individually bounded — see mailer.ts's DEFAULT_MAIL_TIMEOUT_MS).
    const results = await Promise.all(
      recipients.map((to) => sendMail(cfg, { to, subject: email.subject, text: email.text }, undefined, app.mailSendTimeoutMs)),
    );

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'project.notifications.test',
      targetType: 'project',
      targetName: String(projectId),
      meta: { recipients: recipients.length },
    });

    // One failure fails the whole test: a partially-delivered test that reported success would be
    // worse than useless. The first error is surfaced verbatim (already username-redacted by
    // `sendMail`), since they're nearly always the same underlying SMTP problem.
    const failure = results.find((result) => !result.ok);
    if (failure && !failure.ok) {
      return { ok: false, error: failure.error };
    }
    return { ok: true };
  });
}
