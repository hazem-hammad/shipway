import { describe, expect, it } from 'vitest';
import { sendDeployNotification, sendWebhookText } from '../src/services/notify.js';

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
