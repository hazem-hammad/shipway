/**
 * Sends a deploy status notification to a webhook URL, shaping the request body to match the
 * target platform detected from the URL itself (no separate "provider" setting to keep in sync):
 *  - contains `discord.com/api/webhooks` -> Discord's `{content}` JSON body.
 *  - contains `api.telegram.org` -> Telegram's `sendMessage` endpoint, which takes the message as
 *    a `?text=` query param rather than a JSON body (the caller supplies the full
 *    `.../bot<token>/sendMessage?chat_id=<id>` URL); sent as a `GET`.
 *  - anything else -> Slack-compatible `{text}` JSON body (also works for Slack-compatible
 *    incoming webhooks like Mattermost).
 *
 * 10s request timeout via `AbortSignal.timeout`. Throws on a non-ok response (or on timeout/
 * network failure) rather than swallowing it — `pipeline.ts`'s `notifySafe` is the one place that
 * catches and logs it, so a deploy never fails just because a notification couldn't be sent.
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

export async function sendDeployNotification(
  fetchImpl: typeof fetch,
  webhookUrl: string,
  p: DeployNotificationPayload,
): Promise<void> {
  const text = formatText(p);
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  let url = webhookUrl;
  let init: RequestInit;

  if (webhookUrl.includes('discord.com/api/webhooks')) {
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text }),
      signal: timeoutSignal,
    };
  } else if (webhookUrl.includes('api.telegram.org')) {
    const withText = new URL(webhookUrl);
    withText.searchParams.set('text', text);
    url = withText.toString();
    init = { method: 'GET', signal: timeoutSignal };
  } else {
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: timeoutSignal,
    };
  }

  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`notification webhook responded with status ${String(response.status)}`);
  }
}
