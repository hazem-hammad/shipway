import { describe, expect, it } from 'vitest';
import { formatTeamsMessageCard, isTeamsWebhookUrl, sendDeployNotification, sendWebhookText, type TeamsMessageCard } from '../src/services/notify.js';

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(status = 200): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: input.toString(), init });
    return Promise.resolve({ ok: status >= 200 && status < 300, status } as Response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const PAYLOAD = { project: 'api', status: 'success' as const, deploymentId: 5, message: 'deployed cleanly' };

describe('sendDeployNotification', () => {
  it('posts a Slack-compatible {text} body to a generic webhook URL', async () => {
    const { fetchImpl, calls } = fakeFetch();

    await sendDeployNotification(fetchImpl, 'https://hooks.slack.com/services/xxx', PAYLOAD);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://hooks.slack.com/services/xxx');
    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(calls[0]?.init?.body as string) as unknown;
    expect(body).toEqual({ text: '✅ [api] deploy #5 success: deployed cleanly' });
  });

  it('posts a Discord {content} body when the URL contains discord.com/api/webhooks', async () => {
    const { fetchImpl, calls } = fakeFetch();

    await sendDeployNotification(fetchImpl, 'https://discord.com/api/webhooks/123/abc', {
      ...PAYLOAD,
      status: 'failed',
      deploymentId: 6,
      message: 'build failed',
    });

    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(calls[0]?.init?.body as string) as unknown;
    expect(body).toEqual({ content: '❌ [api] deploy #6 failed: build failed' });
  });

  it('sends a GET with the text appended as a query param for a Telegram sendMessage URL', async () => {
    const { fetchImpl, calls } = fakeFetch();

    await sendDeployNotification(fetchImpl, 'https://api.telegram.org/bot123:ABC/sendMessage?chat_id=456', {
      ...PAYLOAD,
      deploymentId: 7,
      message: 'ok',
    });

    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.body).toBeUndefined();
    const url = new URL(calls[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://api.telegram.org/bot123:ABC/sendMessage');
    expect(url.searchParams.get('chat_id')).toBe('456');
    expect(url.searchParams.get('text')).toBe('✅ [api] deploy #7 success: ok');
  });

  it('throws when the response is not ok', async () => {
    const { fetchImpl } = fakeFetch(500);

    await expect(sendDeployNotification(fetchImpl, 'https://hooks.slack.com/services/xxx', PAYLOAD)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sendWebhookText — the URL-format-detection helper factored out of
// sendDeployNotification (Task 4's notifybus reuses this for arbitrary channel text instead of
// only deploy-shaped payloads).
// ---------------------------------------------------------------------------

describe('sendWebhookText', () => {
  it('posts a Slack-compatible {text} body verbatim to a generic webhook URL', async () => {
    const { fetchImpl, calls } = fakeFetch();

    await sendWebhookText(fetchImpl, 'https://hooks.slack.com/services/xxx', 'hello world');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://hooks.slack.com/services/xxx');
    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(calls[0]?.init?.body as string) as unknown;
    expect(body).toEqual({ text: 'hello world' });
  });

  it('posts a Discord {content} body when the URL contains discord.com/api/webhooks', async () => {
    const { fetchImpl, calls } = fakeFetch();

    await sendWebhookText(fetchImpl, 'https://discord.com/api/webhooks/123/abc', 'hi there');

    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(calls[0]?.init?.body as string) as unknown;
    expect(body).toEqual({ content: 'hi there' });
  });

  it('sends a GET with the text appended as a query param for a Telegram sendMessage URL', async () => {
    const { fetchImpl, calls } = fakeFetch();

    await sendWebhookText(fetchImpl, 'https://api.telegram.org/bot123:ABC/sendMessage?chat_id=456', 'test message');

    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.body).toBeUndefined();
    const url = new URL(calls[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://api.telegram.org/bot123:ABC/sendMessage');
    expect(url.searchParams.get('chat_id')).toBe('456');
    expect(url.searchParams.get('text')).toBe('test message');
  });

  it('throws when the response is not ok', async () => {
    const { fetchImpl } = fakeFetch(500);

    await expect(sendWebhookText(fetchImpl, 'https://hooks.slack.com/services/xxx', 'x')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Microsoft Teams (plan Task 4 / spec §3 "Delivery channels")
// ---------------------------------------------------------------------------

describe('isTeamsWebhookUrl', () => {
  it('detects *.webhook.office.com URLs', () => {
    expect(isTeamsWebhookUrl('https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def')).toBe(true);
  });

  it('detects *.logic.azure.com URLs (the Power Automate/Logic Apps relay)', () => {
    expect(isTeamsWebhookUrl('https://prod-01.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke')).toBe(true);
  });

  it('does not flag Slack/Discord/Telegram/generic URLs', () => {
    expect(isTeamsWebhookUrl('https://hooks.slack.com/services/xxx')).toBe(false);
    expect(isTeamsWebhookUrl('https://discord.com/api/webhooks/123/abc')).toBe(false);
    expect(isTeamsWebhookUrl('https://api.telegram.org/bot123/sendMessage')).toBe(false);
    expect(isTeamsWebhookUrl('https://example.com/hook')).toBe(false);
  });
});

describe('formatTeamsMessageCard', () => {
  it('shapes the MessageCard schema with the given title/text and a themeColor by severity', () => {
    const card = formatTeamsMessageCard({ title: 'Deploy failed', severity: 'failure' }, '[shop] deploy #12 build failed');
    expect(card).toEqual<TeamsMessageCard>({
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      themeColor: 'DC2626',
      summary: 'Deploy failed',
      title: 'Deploy failed',
      text: '[shop] deploy #12 build failed',
    });
  });

  it('uses a green themeColor for severity: success', () => {
    expect(formatTeamsMessageCard({ title: 'Deploy succeeded', severity: 'success' }, 'ok').themeColor).toBe('16A34A');
  });

  it('uses a gray themeColor for severity: neutral, and defaults to neutral when severity is omitted', () => {
    expect(formatTeamsMessageCard({ title: 'x', severity: 'neutral' }, 'y').themeColor).toBe('6B7280');
    expect(formatTeamsMessageCard({ title: 'x' }, 'y').themeColor).toBe('6B7280');
  });
});

describe('sendWebhookText — Teams auto-detection and explicit type', () => {
  it('posts a MessageCard body to a webhook.office.com URL with no explicit opts (auto-detected)', async () => {
    const { fetchImpl, calls } = fakeFetch();

    await sendWebhookText(fetchImpl, 'https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def', 'plain test text');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(calls[0]?.init?.body as string) as TeamsMessageCard;
    expect(body['@type']).toBe('MessageCard');
    expect(body['@context']).toBe('https://schema.org/extensions');
    expect(body.text).toBe('plain test text');
    expect(body.title).toBe('Shipway notification'); // default title when no context is supplied
  });

  it('posts a MessageCard body to a logic.azure.com URL, using the supplied context title/severity', async () => {
    const { fetchImpl, calls } = fakeFetch();

    await sendWebhookText(fetchImpl, 'https://prod.logic.azure.com/workflows/abc/triggers/manual', 'Nginx is failed', {
      context: { title: 'Service down', severity: 'failure' },
    });

    const body = JSON.parse(calls[0]?.init?.body as string) as TeamsMessageCard;
    expect(body).toEqual<TeamsMessageCard>({
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      themeColor: 'DC2626',
      summary: 'Service down',
      title: 'Service down',
      text: 'Nginx is failed',
    });
  });

  it('forces Teams formatting via opts.forceTeams even when the URL does not match either Teams pattern (explicit type: teams)', async () => {
    const { fetchImpl, calls } = fakeFetch();

    await sendWebhookText(fetchImpl, 'https://relay.example.com/teams-in', 'hello', { forceTeams: true, context: { title: 'Test', severity: 'neutral' } });

    const body = JSON.parse(calls[0]?.init?.body as string) as TeamsMessageCard;
    expect(body['@type']).toBe('MessageCard');
  });

  it('does NOT use Teams formatting for a plain webhook URL even when forceTeams is false/omitted', async () => {
    const { fetchImpl, calls } = fakeFetch();

    await sendWebhookText(fetchImpl, 'https://hooks.slack.com/services/xxx', 'hello');

    const body = JSON.parse(calls[0]?.init?.body as string) as unknown;
    expect(body).toEqual({ text: 'hello' });
  });

  it('a webhook.office.com URL still throws on a non-ok response, same as every other format', async () => {
    const { fetchImpl } = fakeFetch(500);

    await expect(sendWebhookText(fetchImpl, 'https://acme.webhook.office.com/webhookb2/abc', 'x')).rejects.toThrow();
  });
});
