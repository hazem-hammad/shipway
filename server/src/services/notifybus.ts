/**
 * Task 4's notification event bus: named delivery channels (`db/schema.ts`'s `notification_channels`
 * / `notification_subscriptions`, added in Task 2) can subscribe to any of `EVENTS`; `emitEvent` fans
 * a `{title, message}` payload out to every channel currently subscribed to that event, reusing
 * `services/notify.ts`'s URL-format detection (Slack/Discord/Telegram) via its exported
 * `sendWebhookText` helper. Per-channel delivery failures are caught and logged — `emitEvent` never
 * throws, so a deploy or the service poller (see `services/deploynotify.ts`/`servicewatch.ts`) never
 * fails just because a channel's webhook is down.
 */
import { eq } from 'drizzle-orm';
import type { ShipwayDb } from '../db/index.js';
import { notificationChannels, notificationSubscriptions } from '../db/schema.js';
import { sendWebhookText } from './notify.js';

export type NotifyEvent = 'deploy_failed' | 'deploy_succeeded' | 'deploy_canceled' | 'deploy_rolled_back' | 'service_down' | 'service_recovered';

export interface EventMeta {
  label: string;
  description: string;
  category: 'deployment' | 'services';
}

/** The six events channels can subscribe to, with the label/description/category `GET
 * /api/notifications` surfaces for the matrix UI. */
export const EVENTS: Record<NotifyEvent, EventMeta> = {
  deploy_failed: {
    label: 'Deploy failed',
    description: 'A deployment finished with a failure.',
    category: 'deployment',
  },
  deploy_succeeded: {
    label: 'Deploy succeeded',
    description: 'A deployment finished successfully.',
    category: 'deployment',
  },
  deploy_canceled: {
    label: 'Deploy canceled',
    description: 'A deployment was canceled before it finished.',
    category: 'deployment',
  },
  deploy_rolled_back: {
    label: 'Deploy rolled back',
    description: 'A health-check failure rolled the release back to the previous version.',
    category: 'deployment',
  },
  service_down: {
    label: 'Service down',
    description: 'A system service stopped running.',
    category: 'services',
  },
  service_recovered: {
    label: 'Service recovered',
    description: 'A system service that was down is running again.',
    category: 'services',
  },
};

export interface NotifyPayload {
  title: string;
  message: string;
}

/**
 * Looks up every channel currently subscribed to `event` and sends each one `"<title>: <message>"`
 * via `sendWebhookText`. Never throws: a single channel's delivery failure (thrown/rejected fetch,
 * or a non-ok response) is caught and logged, and every other subscribed channel still gets its
 * delivery attempt.
 */
export async function emitEvent(db: ShipwayDb, event: NotifyEvent, payload: NotifyPayload, fetchImpl: typeof fetch = fetch): Promise<void> {
  const channels = db
    .select({ id: notificationChannels.id, url: notificationChannels.url })
    .from(notificationSubscriptions)
    .innerJoin(notificationChannels, eq(notificationSubscriptions.channelId, notificationChannels.id))
    .where(eq(notificationSubscriptions.event, event))
    .all();

  const text = `${payload.title}: ${payload.message}`;

  for (const channel of channels) {
    try {
      await sendWebhookText(fetchImpl, channel.url, text);
    } catch (err) {
      console.error(`shipway: notification channel ${String(channel.id)} delivery failed for event "${event}"`, err);
    }
  }
}
