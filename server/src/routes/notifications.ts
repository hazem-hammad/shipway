/**
 * Task 4's notifications API: named delivery channels (CRUD, admin+) + a per-event subscriptions
 * matrix (`GET /api/notifications` for the full picture, `PUT /api/notifications/subscriptions` to
 * toggle one `{event, channelId}` pair, admin+) + a per-channel test-send (member+).
 */
import { and, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notificationChannels, notificationSubscriptions } from '../db/schema.js';
import { requireRole } from '../lib/authz.js';
import { getActor, recordAudit } from '../services/audit.js';
import { EVENTS, type NotifyEvent } from '../services/notifybus.js';
import { sendWebhookText } from '../services/notify.js';

const EVENT_KEYS = Object.keys(EVENTS) as [NotifyEvent, ...NotifyEvent[]];

/** `http://` or `https://` only, non-empty beyond the scheme. */
const WEBHOOK_URL_RE = /^https?:\/\/.+/;

const createChannelSchema = z.object({
  name: z.string().min(1),
  url: z.string().regex(WEBHOOK_URL_RE),
});

const patchChannelSchema = z
  .object({
    name: z.string().min(1),
    url: z.string().regex(WEBHOOK_URL_RE),
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
  return { id: channel.id, name: channel.name, url: channel.url };
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
    const { name, url } = parsed.data;

    const existing = app.db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.name, name)).get();
    if (existing) {
      return reply.code(409).send({ error: 'channel name already in use' });
    }

    app.db.insert(notificationChannels).values({ name, url }).run();
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

    app.db.update(notificationChannels).set(parsedBody.data).where(eq(notificationChannels.id, id)).run();
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

    try {
      await sendWebhookText(fetchImpl, channel.url, 'Test notification from Shipway');
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
