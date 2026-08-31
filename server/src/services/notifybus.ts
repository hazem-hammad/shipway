/**
 * Project deploy notifications: each project keeps its own list of recipient email addresses
 * (`db/schema.ts`'s `project_notification_recipients`) and its own per-event opt-in
 * (`project_notification_events`); `emitProjectEvent` emails every recipient whenever that project
 * is subscribed to the event being emitted.
 *
 * This replaces the instance-wide channel bus (migration 0005/0006 dropped
 * `notification_channels`/`notification_subscriptions`). Two things went away with it, deliberately:
 * webhook/Teams delivery — email is the only mechanism now — and the host-wide
 * `service_down`/`service_recovered` events, which had no project to belong to once notifications
 * became a per-project feature. `services/servicewatch.ts` still records those transitions as
 * `service.down`/`service.recovered` audit rows, so the history is intact in the Audit Log; it just
 * no longer sends mail. The legacy per-project `notifyWebhookUrl` deploy webhook
 * (`services/deploynotify.ts`) is a separate, untouched feature.
 *
 * Delivery rides on instance mail (`services/mailer.ts`, Settings > Mail). Every failure mode here —
 * mail not configured, no `secretBox`, an SMTP host that's down — is logged and swallowed:
 * `emitProjectEvent` never throws, so a deploy never fails because a notification couldn't be sent.
 */
import { eq } from 'drizzle-orm';
import type { ShipwayDb } from '../db/index.js';
import { projectNotificationEvents, projectNotificationRecipients } from '../db/schema.js';
import type { SecretBox } from '../lib/secretbox.js';
import { getMailConfig, isMailConfigured, sendMail, type TransportFactory } from './mailer.js';

export type NotifyEvent = 'deploy_failed' | 'deploy_succeeded' | 'deploy_canceled' | 'deploy_rolled_back';

export interface EventMeta {
  label: string;
  description: string;
}

/** The four deploy events a project can subscribe to, with the label/description the project's
 * Notifications card renders. */
export const EVENTS: Record<NotifyEvent, EventMeta> = {
  deploy_failed: {
    label: 'Deploy failed',
    description: 'A deployment finished with a failure.',
  },
  deploy_succeeded: {
    label: 'Deploy succeeded',
    description: 'A deployment finished successfully.',
  },
  deploy_canceled: {
    label: 'Deploy canceled',
    description: 'A deployment was canceled before it finished.',
  },
  deploy_rolled_back: {
    label: 'Deploy rolled back',
    description: 'A health-check failure rolled the release back to the previous version.',
  },
};

export const EVENT_KEYS = Object.keys(EVENTS) as NotifyEvent[];

/** What a brand-new project subscribes to: everything except a successful deploy. A green deploy is
 * the common case and the one nobody needs mail about, whereas a failure, a cancellation, or an
 * automatic rollback all mean someone should look. Recipients start empty, so a new project still
 * sends nothing at all until someone adds an address. */
export const DEFAULT_SUBSCRIBED_EVENTS: NotifyEvent[] = ['deploy_failed', 'deploy_canceled', 'deploy_rolled_back'];

/**
 * What one `emitProjectEvent` call actually did. Returned rather than only logged so a caller can
 * put it somewhere a human will find it — `services/deploynotify.ts` hands it to the deploy
 * pipeline, which writes it into the deploy log. "Did this deploy email anyone, and if not why not"
 * used to be answerable only by reading the source and guessing; now every deploy records it.
 */
export type NotifyOutcome =
  /** `messageIds` are the provider's own ids for the accepted messages (SES's `250 Ok <id>`), so a
   * "Shipway says it sent but nothing arrived" report can be traced to specific messages in the
   * provider's dashboard instead of ending in guesswork. */
  | { status: 'sent'; recipients: number; messageIds: string[] }
  /** Nothing was attempted, and this is why — an unsubscribed event, an empty list, or mail that
   * isn't configured. Not an error: all three are ordinary states. */
  | { status: 'skipped'; reason: string }
  /** At least one recipient's send failed. `sent` may still be non-zero: one bad address never stops
   * the others. `error` is the first failure's message, already username-redacted by `sendMail`. */
  | { status: 'failed'; sent: number; failed: number; error: string };

/** A one-line, human-readable rendering of an outcome, for a deploy log. */
export function describeOutcome(outcome: NotifyOutcome): string {
  switch (outcome.status) {
    case 'sent': {
      const head = `notification: emailed ${String(outcome.recipients)} recipient${outcome.recipients === 1 ? '' : 's'}`;
      return outcome.messageIds.length > 0 ? `${head} (${outcome.messageIds.join(', ')})` : head;
    }
    case 'skipped':
      return `notification: skipped (${outcome.reason})`;
    case 'failed':
      return `notification: ${String(outcome.failed)} of ${String(outcome.sent + outcome.failed)} failed (${outcome.error})`;
  }
}

/** The already-built email a caller wants delivered. The bus deliberately does NOT format anything
 * itself — `services/notifyemail.ts` owns the template, and `services/deploynotify.ts` owns the
 * facts — so this is a straight pass-through to `sendMail`. */
export interface NotifyPayload {
  subject: string;
  text: string;
  /** An optional HTML part. Deploy notifications are deliberately text-only (see
   * `services/notifyemail.ts`), so nothing currently sets this; `sendMail` still supports it for
   * other mail, such as the team invite. */
  html?: string;
}

/** A project's recipient addresses, oldest first. Exported for the routes layer and the test-send.
 *
 * The `ORDER BY id` is load-bearing, not decoration: without it SQLite is free to answer from the
 * `(project_id, email)` unique index and hand back the list alphabetized, so the order an admin
 * typed their recipients in would silently rearrange itself on the next page load. */
export function getProjectRecipients(db: ShipwayDb, projectId: number): string[] {
  return db
    .select({ email: projectNotificationRecipients.email })
    .from(projectNotificationRecipients)
    .where(eq(projectNotificationRecipients.projectId, projectId))
    .orderBy(projectNotificationRecipients.id)
    .all()
    .map((row) => row.email);
}

/** The events a project is currently subscribed to. Absent rows mean "not subscribed" — there is no
 * implicit default at read time; `DEFAULT_SUBSCRIBED_EVENTS` is applied ONCE, when the project is
 * created, so an admin who deliberately unchecks everything stays unsubscribed. */
export function getProjectSubscribedEvents(db: ShipwayDb, projectId: number): NotifyEvent[] {
  const rows = db
    .select({ event: projectNotificationEvents.event })
    .from(projectNotificationEvents)
    .where(eq(projectNotificationEvents.projectId, projectId))
    .all();
  // Filtered against EVENT_KEYS so a row left behind by a removed event (the dropped service_*
  // events, say) can never surface as an unknown event key to a caller.
  return rows.map((row) => row.event).filter((event): event is NotifyEvent => (EVENT_KEYS as string[]).includes(event));
}

/**
 * Emails `payload` to every recipient of `projectId`, if and only if that project is subscribed to
 * `event`. Never throws — an unsubscribed project, an empty recipient list, a missing `secretBox`,
 * unconfigured instance mail, and a failed send all come back as a `NotifyOutcome` instead, because
 * none of them are a reason for the deploy that triggered this to report failure. The caller is
 * expected to record that outcome somewhere visible (the deploy log) rather than discard it.
 *
 * Each recipient gets their own `sendMail` call, dispatched CONCURRENTLY via `Promise.allSettled`:
 * `sendMail` bounds each send on its own (`services/mailer.ts`'s `DEFAULT_MAIL_TIMEOUT_MS`), so
 * sending one at a time would let N unreachable recipients cost N x that timeout while the deploy
 * queue waits. One recipient's failure never affects another's.
 *
 * `mailTransportFactory`/`mailSendTimeoutMs` are test-only overrides, mirroring `sendMail`'s own.
 */
export async function emitProjectEvent(
  db: ShipwayDb,
  projectId: number,
  event: NotifyEvent,
  payload: NotifyPayload,
  secretBox?: SecretBox,
  mailTransportFactory?: TransportFactory,
  mailSendTimeoutMs?: number,
): Promise<NotifyOutcome> {
  if (!getProjectSubscribedEvents(db, projectId).includes(event)) {
    return { status: 'skipped', reason: `project is not subscribed to ${event}` };
  }

  const recipients = getProjectRecipients(db, projectId);
  if (recipients.length === 0) {
    return { status: 'skipped', reason: 'no recipients configured for this project' };
  }

  if (!secretBox) {
    return { status: 'skipped', reason: 'no secretBox available to read the instance mail config' };
  }

  const cfg = getMailConfig(db, secretBox);
  if (!isMailConfigured(cfg)) {
    return { status: 'skipped', reason: 'instance mail is not configured' };
  }

  const results = await Promise.all(
    recipients.map(async (to): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> => {
      try {
        const result = await sendMail(cfg, { to, subject: payload.subject, text: payload.text, html: payload.html }, mailTransportFactory, mailSendTimeoutMs);
        return result.ok ? { ok: true, messageId: result.messageId } : { ok: false, error: result.error };
      } catch (err) {
        // `sendMail` is documented never to throw, so reaching here means something upstream of it
        // broke. Caught anyway: a notification must never be able to fail a deploy.
        return { ok: false, error: err instanceof Error ? err.message : 'unknown send failure' };
      }
    }),
  );

  const failures = results.filter((result): result is { ok: false; error: string } => !result.ok);
  if (failures.length === 0) {
    const messageIds = results.flatMap((result) => (result.ok && result.messageId !== undefined ? [result.messageId] : []));
    return { status: 'sent', recipients: recipients.length, messageIds };
  }

  // Still logged, not only returned: a caller that discards the outcome shouldn't silently lose a
  // real delivery failure.
  const error = (failures[0] as { ok: false; error: string }).error;
  console.error(`shipway: project ${String(projectId)} notification for "${event}": ${String(failures.length)} of ${String(recipients.length)} sends failed: ${error}`);
  return { status: 'failed', sent: recipients.length - failures.length, failed: failures.length, error };
}
