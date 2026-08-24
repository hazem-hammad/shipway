/**
 * Sends webhook-shaped notification text, shaping the request body to match the target platform
 * detected from the URL itself (no separate "provider" setting to keep in sync):
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

/**
 * Shapes a `fetch` call (url + `RequestInit`) for delivering `text` to `webhookUrl`, format-detected
 * from the URL itself — the URL-sniffing logic `sendDeployNotification` has always used, factored
 * out so `services/notifybus.ts` (Task 4's event bus) can reuse it for arbitrary channel text
 * instead of only deploy-shaped payloads.
 */
export function formatWebhookRequest(webhookUrl: string, text: string): { url: string; init: RequestInit } {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

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
export async function sendWebhookText(fetchImpl: typeof fetch, webhookUrl: string, text: string): Promise<void> {
  const { url, init } = formatWebhookRequest(webhookUrl, text);
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
