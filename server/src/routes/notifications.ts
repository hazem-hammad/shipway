/**
 * Task 4's notifications API: named delivery channels (CRUD, admin+) + a per-event subscriptions
 * matrix (`GET /api/notifications` for the full picture, `PUT /api/notifications/subscriptions` to
 * toggle one `{event, channelId}` pair, admin+) + a per-channel test-send (member+). Migration 0002
 * added `type` (`'webhook'` | `'teams'` | `'email'`, default `'webhook'`) and `target` (the email
 * address for `type: 'email'`, null otherwise) — `webhook`/`teams` channels are validated/stored the
 * same way channels always were (a `url`), `email` channels validate/store a `target` instead and
 * require instance mail to already be configured (spec §3 "Delivery channels").
 */
import { and, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notificationChannels, notificationSubscriptions } from '../db/schema.js';
import { requireRole } from '../lib/authz.js';
import { getActor, recordAudit } from '../services/audit.js';
import { getMailConfig, isMailConfigured, sendMail } from '../services/mailer.js';
import { EVENTS, type NotifyEvent } from '../services/notifybus.js';
import { sendWebhookText } from '../services/notify.js';

const EVENT_KEYS = Object.keys(EVENTS) as [NotifyEvent, ...NotifyEvent[]];

const CHANNEL_TYPES = ['webhook', 'teams', 'email'] as const;
type ChannelType = (typeof CHANNEL_TYPES)[number];

/** `http://` or `https://` only, non-empty beyond the scheme. */
const WEBHOOK_URL_RE = /^https?:\/\/.+/;

const emailSchema = z.string().email();

function isValidEmail(value: string): boolean {
  return emailSchema.safeParse(value).success;
}

const createChannelSchema = z.object({
  name: z.string().min(1),
  type: z.enum(CHANNEL_TYPES).optional().default('webhook'),
  url: z.string().optional(),
  target: z.string().optional(),
});

const patchChannelSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(CHANNEL_TYPES),
    url: z.string(),
    target: z.string(),
  })
  .partial();

const channelIdParamsSchema = z.object({ id: z.coerce.number().int() });

const subscriptionSchema = z.object({
  event: z.enum(EVENT_KEYS),
  channelId: z.number().int(),
  enabled: z.boolean(),
});

type ChannelRow = typeof notificationChannels.$inferSelect;

function toPublicChannel(channel: ChannelRow) {
  return { id: channel.id, name: channel.name, type: channel.type, url: channel.url, target: channel.target };
}

/**
 * Validates a channel's type-specific fields, returning a display-ready error message (never null)
 * on failure or `null` on success. `webhook`/`teams` require a valid http(s) `url`; `email` requires
 * a syntactically valid `target` address AND instance mail already configured — checked here (not in
 * the zod schema) since it needs a live `isMailConfigured` read.
 */
function validateChannelType(app: FastifyInstance, type: ChannelType, url: string | undefined, target: string | undefined): string | null {
  if (type === 'email') {
    if (!target || !isValidEmail(target)) {
      return 'email channels require a valid email address';
    }
    const cfg = getMailConfig(app.db, app.secretBox);
    if (!isMailConfigured(cfg)) {
      return 'configure instance mail before adding an email channel';
    }
    return null;
  }

  if (!url || !WEBHOOK_URL_RE.test(url)) {
    return `${type} channels require a valid http(s) url`;
  }
  return null;
}

/**
 * Registers the full notifications route set under the global session guard in `buildApp`.
 * `GET /api/notifications` and the test-send endpoint are readable/usable by any authenticated user
 * (member+); every mutation is admin+.
 */
export async function notificationRoutes(app: FastifyInstance, opts: { fetchImpl?: typeof fetch } = {}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  app.get('/api/notifications', async () => {
    const channels = app.db.select().from(notificationChannels).all().map(toPublicChannel);
    const subscriptions = app.db
      .select({ event: notificationSubscriptions.event, channelId: notificationSubscriptions.channelId })
      .from(notificationSubscriptions)
      .all();
    const events = Object.entries(EVENTS).map(([event, meta]) => ({ event, ...meta }));

    return { channels, events, subscriptions };
  });

  app.post('/api/notifications/channels', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsed = createChannelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const { name, type, url, target } = parsed.data;

    const typeError = validateChannelType(app, type, url, target);
    if (typeError) {
      return reply.code(400).send({ error: typeError });
    }

    const existing = app.db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.name, name)).get();
    if (existing) {
      return reply.code(409).send({ error: 'channel name already in use' });
    }

    app.db
      .insert(notificationChannels)
      .values({ name, type, url: type === 'email' ? null : (url ?? null), target: type === 'email' ? (target ?? null) : null })
      .run();
    const created = app.db.select().from(notificationChannels).where(eq(notificationChannels.name, name)).get();
    if (!created) {
      // Should be unreachable: we just inserted this row inside this handler.
      return reply.code(500).send({ error: 'failed to create channel' });
    }

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'notification.channel.create', targetType: 'notification_channel', targetName: created.name });

    return reply.code(201).send(toPublicChannel(created));
  });

  app.patch('/api/notifications/channels/:id', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsedParams = channelIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(404).send({ error: 'channel not found' });
    }
    const { id } = parsedParams.data;

    const parsedBody = patchChannelSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const target = app.db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).get();
    if (!target) {
      return reply.code(404).send({ error: 'channel not found' });
    }

    if (parsedBody.data.name !== undefined) {
      const nameConflict = app.db
        .select({ id: notificationChannels.id })
        .from(notificationChannels)
        .where(and(eq(notificationChannels.name, parsedBody.data.name), ne(notificationChannels.id, id)))
        .get();
      if (nameConflict) {
        return reply.code(409).send({ error: 'channel name already in use' });
      }
    }

    // Effective type/url/target after this PATCH: an explicit field in the body wins; otherwise, if
    // the type ISN'T changing, the existing row's url/target carries over (today's "PATCH just the
    // name" behavior). If the type IS changing, the old url/target never carries over — an email
    // channel switching to webhook doesn't silently keep a stale `target`, and vice versa — so the
    // new type's required field must be supplied in the same request.
    const effectiveType: ChannelType = parsedBody.data.type ?? (target.type as ChannelType);
    const typeChanged = parsedBody.data.type !== undefined && parsedBody.data.type !== target.type;
    const effectiveUrl = parsedBody.data.url ?? (typeChanged ? undefined : (target.url ?? undefined));
    const effectiveTarget = parsedBody.data.target ?? (typeChanged ? undefined : (target.target ?? undefined));

    const typeError = validateChannelType(app, effectiveType, effectiveUrl, effectiveTarget);
    if (typeError) {
      return reply.code(400).send({ error: typeError });
    }

    const patch: Partial<ChannelRow> = { ...parsedBody.data };
    if (parsedBody.data.type !== undefined || parsedBody.data.url !== undefined || parsedBody.data.target !== undefined) {
      patch.type = effectiveType;
      patch.url = effectiveType === 'email' ? null : (effectiveUrl ?? null);
      patch.target = effectiveType === 'email' ? (effectiveTarget ?? null) : null;
    }

    app.db.update(notificationChannels).set(patch).where(eq(notificationChannels.id, id)).run();
    const updated = app.db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).get();
    if (!updated) {
      // Should be unreachable: we just updated this row inside this handler.
      return reply.code(500).send({ error: 'failed to update channel' });
    }

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'notification.channel.update', targetType: 'notification_channel', targetName: updated.name });

    return reply.code(200).send(toPublicChannel(updated));
  });

  app.delete('/api/notifications/channels/:id', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsedParams = channelIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(404).send({ error: 'channel not found' });
    }
    const { id } = parsedParams.data;

    const target = app.db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).get();
    if (!target) {
      return reply.code(404).send({ error: 'channel not found' });
    }

    // Cascade removes its subscriptions too (notification_subscriptions.channel_id FK, ON DELETE
    // CASCADE — see db/schema.ts).
    app.db.delete(notificationChannels).where(eq(notificationChannels.id, id)).run();

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'notification.channel.delete', targetType: 'notification_channel', targetName: target.name });

    return reply.code(204).send();
  });

  app.post('/api/notifications/channels/:id/test', async (request, reply) => {
    const parsedParams = channelIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(404).send({ error: 'channel not found' });
    }
    const { id } = parsedParams.data;

    const channel = app.db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).get();
    if (!channel) {
      return reply.code(404).send({ error: 'channel not found' });
    }

    // Email: a real send through the instance mailer, returning its own {ok, error?} shape.
    if (channel.type === 'email') {
      if (!channel.target) {
        return { ok: false, error: 'channel has no target address configured' };
      }
      const cfg = getMailConfig(app.db, app.secretBox);
      return sendMail(cfg, { to: channel.target, subject: 'Shipway test notification', text: 'Test notification from Shipway' });
    }

    // webhook/teams: unchanged HTTP-post path (Teams formatting is picked up automatically by
    // sendWebhookText — via URL auto-detection, or forced here for an explicit type: teams channel).
    if (!channel.url) {
      return { ok: false };
    }
    try {
      await sendWebhookText(fetchImpl, channel.url, 'Test notification from Shipway', {
        context: { title: 'Shipway test notification', severity: 'neutral' },
        forceTeams: channel.type === 'teams',
      });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  app.put('/api/notifications/subscriptions', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsed = subscriptionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const { event, channelId, enabled } = parsed.data;

    const channel = app.db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.id, channelId)).get();
    if (!channel) {
      return reply.code(404).send({ error: 'channel not found' });
    }

    const actor = getActor(app.db, request.session.get('userId'));

    if (enabled) {
      app.db.insert(notificationSubscriptions).values({ event, channelId }).onConflictDoNothing().run();
      recordAudit(app.db, { ...actor, action: 'notification.subscribe', targetType: 'notification_subscription', targetName: `${event}:${String(channelId)}` });
    } else {
      app.db
        .delete(notificationSubscriptions)
        .where(and(eq(notificationSubscriptions.event, event), eq(notificationSubscriptions.channelId, channelId)))
        .run();
      recordAudit(app.db, { ...actor, action: 'notification.unsubscribe', targetType: 'notification_subscription', targetName: `${event}:${String(channelId)}` });
    }

    return reply.code(200).send({ event, channelId, enabled });
  });
}
