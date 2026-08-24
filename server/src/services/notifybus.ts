/**
 * Task 4's notification event bus: named delivery channels (`db/schema.ts`'s `notification_channels`
 * / `notification_subscriptions`, added in Task 2, gaining `type`/`target` in migration 0002) can
 * subscribe to any of `EVENTS`; `emitEvent` fans a `{title, message}` payload out to every channel
 * currently subscribed to that event, dispatched by the channel's `type`:
 *  - `'webhook'`/`'teams'` -> HTTP post via `services/notify.ts`'s `sendWebhookText`, which
 *    format-detects Slack/Discord/Telegram/Teams from the URL itself (a `'teams'`-typed channel
 *    additionally forces Teams' MessageCard formatting even if its URL doesn't match the auto-detect
 *    patterns).
 *  - `'email'` -> `services/mailer.ts`'s `sendMail`, addressed to the channel's `target`. Skipped
 *    (logged, never thrown) when no `secretBox` was supplied or instance mail isn't configured —
 *    both are realistic states (mail can be un-configured again after a channel was created) and
 *    must never crash the fan-out.
 * Every per-channel delivery failure is caught and logged — `emitEvent` never throws, so a deploy or
 * the service poller (see `services/deploynotify.ts`/`servicewatch.ts`) never fails just because one
 * channel is down or misconfigured.
 */
import { eq } from 'drizzle-orm';
import type { ShipwayDb } from '../db/index.js';
import { notificationChannels, notificationSubscriptions } from '../db/schema.js';
import type { SecretBox } from '../lib/secretbox.js';
import { getMailConfig, isMailConfigured, sendMail, type TransportFactory } from './mailer.js';
import { sendWebhookText, type NotifySeverity } from './notify.js';

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

/** `themeColor`/urgency hint for a Teams-typed channel's MessageCard — `sendWebhookText` ignores
 * this for every other format, so it costs nothing to compute unconditionally. */
const EVENT_SEVERITY: Record<NotifyEvent, NotifySeverity> = {
  deploy_failed: 'failure',
  deploy_succeeded: 'success',
  deploy_canceled: 'neutral',
  deploy_rolled_back: 'failure',
  service_down: 'failure',
  service_recovered: 'success',
};

/** Sends one `'email'`-typed channel's delivery via instance mail. Never throws: an unusable state
 * (no `secretBox`, no `target`, or instance mail not currently configured) is logged and skipped
 * exactly like a failed HTTP delivery would be. */
async function dispatchEmailChannel(
  db: ShipwayDb,
  secretBox: SecretBox | undefined,
  channel: { id: number; target: string | null },
  payload: NotifyPayload,
  mailTransportFactory: TransportFactory | undefined,
): Promise<void> {
  if (!channel.target) {
    console.error(`shipway: notification channel ${String(channel.id)} is type "email" but has no target address — skipping delivery`);
    return;
  }
  if (!secretBox) {
    console.error(`shipway: notification channel ${String(channel.id)} (email) skipped — no secretBox available to read instance mail config`);
    return;
  }

  const cfg = getMailConfig(db, secretBox);
  if (!isMailConfigured(cfg)) {
    console.error(`shipway: notification channel ${String(channel.id)} (email) skipped — instance mail is not configured`);
    return;
  }

  const result = await sendMail(cfg, { to: channel.target, subject: payload.title, text: payload.message }, mailTransportFactory);
  if (!result.ok) {
    console.error(`shipway: notification channel ${String(channel.id)} (email) delivery failed: ${result.error}`);
  }
}

/**
 * Looks up every channel currently subscribed to `event` and delivers `payload` to each one,
 * dispatched by the channel's `type` (webhook/teams -> HTTP, email -> instance mail — see the module
 * doc comment). Never throws: a single channel's delivery failure is caught and logged, and every
 * other subscribed channel still gets its delivery attempt. `secretBox`/`mailTransportFactory` are
 * only needed for `'email'`-typed channels — `secretBox` is what production wiring (`app.ts`)
 * always passes; `mailTransportFactory` is test-only (mirrors `services/mailer.ts`'s `sendMail`).
 */
export async function emitEvent(
  db: ShipwayDb,
  event: NotifyEvent,
  payload: NotifyPayload,
  fetchImpl: typeof fetch = fetch,
  secretBox?: SecretBox,
  mailTransportFactory?: TransportFactory,
): Promise<void> {
  const channels = db
    .select({ id: notificationChannels.id, url: notificationChannels.url, type: notificationChannels.type, target: notificationChannels.target })
    .from(notificationSubscriptions)
    .innerJoin(notificationChannels, eq(notificationSubscriptions.channelId, notificationChannels.id))
    .where(eq(notificationSubscriptions.event, event))
    .all();

  const text = `${payload.title}: ${payload.message}`;

  for (const channel of channels) {
    try {
      if (channel.type === 'email') {
        await dispatchEmailChannel(db, secretBox, channel, payload, mailTransportFactory);
        continue;
      }

      if (!channel.url) {
        console.error(`shipway: notification channel ${String(channel.id)} (type "${channel.type}") has no url configured — skipping delivery`);
        continue;
      }

      await sendWebhookText(fetchImpl, channel.url, text, {
        context: { title: payload.title, severity: EVENT_SEVERITY[event] },
        forceTeams: channel.type === 'teams',
      });
    } catch (err) {
      console.error(`shipway: notification channel ${String(channel.id)} delivery failed for event "${event}"`, err);
    }
  }
}
