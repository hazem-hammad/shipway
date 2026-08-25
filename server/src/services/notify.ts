/**
 * Sends webhook-shaped notification text, shaping the request body to match the target platform
 * detected from the URL itself (no separate "provider" setting to keep in sync):
 *  - contains `webhook.office.com` or `logic.azure.com` -> Microsoft Teams' MessageCard JSON body
 *    (see {@link formatTeamsMessageCard}), or when `opts.forceTeams` is set (an explicit
 *    `type: 'teams'` channel — Task 4 — always gets Teams formatting even if its URL doesn't match
 *    either pattern, e.g. a custom relay).
 *  - contains `discord.com/api/webhooks` -> Discord's `{content}` JSON body.
 *  - contains `api.telegram.org` -> Telegram's `sendMessage` endpoint, which takes the message as
 *    a `?text=` query param rather than a JSON body (the caller supplies the full
 *    `.../bot<token>/sendMessage?chat_id=<id>` URL); sent as a `GET`.
 *  - anything else -> Slack-compatible `{text}` JSON body (also works for Slack-compatible
 *    incoming webhooks like Mattermost).
 *
 * 10s request timeout via `AbortSignal.timeout`. Throws on a non-ok response (or on timeout/
 * network failure) rather than swallowing it — `pipeline.ts`'s `notifySafe` (deploy-shaped
 * payloads) and `services/notifybus.ts`'s `emitEvent` (arbitrary event text) are the two callers
 * that catch and log it, so neither a deploy nor an event-bus fan-out ever fails just because one
 * notification couldn't be sent.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export interface DeployNotificationPayload {
  project: string;
  status: 'success' | 'failed';
  deploymentId: number;
  message: string;
}

function formatText(p: DeployNotificationPayload): string {
  const icon = p.status === 'success' ? '✅' : '❌';
  return `${icon} [${p.project}] deploy #${String(p.deploymentId)} ${p.status}: ${p.message}`;
}

// ---------------------------------------------------------------------------
// Microsoft Teams (plan Task 4 / spec §3 "Delivery channels")
// ---------------------------------------------------------------------------

export type NotifySeverity = 'success' | 'failure' | 'neutral';

/** Separate title Slack/Discord/Telegram fold into the flat `text` body (unchanged v1 shape for
 * those); Teams' MessageCard is the one format with its own `title`/`summary` fields, so this is
 * the extra context only it needs. */
export interface NotifyContext {
  title: string;
  severity?: NotifySeverity;
}

/** A Teams "Incoming Webhook" connector URL — `*.webhook.office.com/...` (the classic Office 365
 * Connectors host) or `*.logic.azure.com/...` (a Power Automate/Logic Apps relay standing in for
 * one, which is Microsoft's current recommended replacement) — either way the payload is the same
 * MessageCard JSON. */
export function isTeamsWebhookUrl(url: string): boolean {
  return url.includes('webhook.office.com') || url.includes('logic.azure.com');
}

export interface TeamsMessageCard {
  '@type': 'MessageCard';
  '@context': 'https://schema.org/extensions';
  themeColor: string;
  summary: string;
  title: string;
  text: string;
}

/** Hex (no `#`, per the MessageCard schema) themeColor by severity: red for a failure, green for a
 * success, gray for anything else (a plain test-send, a cancellation, etc). */
const TEAMS_THEME_COLORS: Record<NotifySeverity, string> = {
  failure: 'DC2626',
  success: '16A34A',
  neutral: '6B7280',
};

export function formatTeamsMessageCard(context: NotifyContext, text: string): TeamsMessageCard {
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    themeColor: TEAMS_THEME_COLORS[context.severity ?? 'neutral'],
    summary: context.title,
    title: context.title,
    text,
  };
}

/**
 * Shapes a `fetch` call (url + `RequestInit`) for delivering `text` to `webhookUrl`, format-detected
 * from the URL itself — the URL-sniffing logic `sendDeployNotification` has always used, factored
 * out so `services/notifybus.ts` (Task 4's event bus) can reuse it for arbitrary channel text
 * instead of only deploy-shaped payloads. `opts.context` supplies the Teams card's title/severity
 * (ignored by every other format); `opts.forceTeams` requests Teams formatting regardless of what
 * the URL looks like, for an explicit `type: 'teams'` channel.
 */
export function formatWebhookRequest(
  webhookUrl: string,
  text: string,
  opts: { context?: NotifyContext; forceTeams?: boolean } = {},
): { url: string; init: RequestInit } {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  if (opts.forceTeams === true || isTeamsWebhookUrl(webhookUrl)) {
    const context: NotifyContext = opts.context ?? { title: 'Shipway notification' };
    return {
      url: webhookUrl,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(formatTeamsMessageCard(context, text)),
        signal: timeoutSignal,
      },
    };
  }

  if (webhookUrl.includes('discord.com/api/webhooks')) {
    return {
      url: webhookUrl,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text }),
        signal: timeoutSignal,
      },
    };
  }

  if (webhookUrl.includes('api.telegram.org')) {
    const withText = new URL(webhookUrl);
    withText.searchParams.set('text', text);
    return { url: withText.toString(), init: { method: 'GET', signal: timeoutSignal } };
  }

  return {
    url: webhookUrl,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: timeoutSignal,
    },
  };
}

/**
 * Sends `text` to `webhookUrl`, format-detected via {@link formatWebhookRequest}. Throws on a
 * non-ok response (or on timeout/network failure) — see the module doc for who catches it.
 */
export async function sendWebhookText(
  fetchImpl: typeof fetch,
  webhookUrl: string,
  text: string,
  opts: { context?: NotifyContext; forceTeams?: boolean } = {},
): Promise<void> {
  const { url, init } = formatWebhookRequest(webhookUrl, text, opts);
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`notification webhook responded with status ${String(response.status)}`);
  }
}

export async function sendDeployNotification(
  fetchImpl: typeof fetch,
  webhookUrl: string,
  p: DeployNotificationPayload,
): Promise<void> {
  await sendWebhookText(fetchImpl, webhookUrl, formatText(p));
}
