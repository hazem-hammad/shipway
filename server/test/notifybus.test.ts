/**
 * Task 4's event bus: `EVENTS` (the six named events with labels/descriptions/category, surfaced by
 * `GET /api/notifications`) and `emitEvent` (fans a `{title, message}` payload out to every channel
 * currently subscribed to that event, reusing `services/notify.ts`'s URL-format detection).
 */
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { notificationChannels, notificationSubscriptions } from '../src/db/schema.js';
import { SecretBox } from '../src/lib/secretbox.js';
import { saveMailConfig } from '../src/services/mailer.js';
import type { MailTransport } from '../src/services/mailer.js';
import { EVENTS, emitEvent, type NotifyEvent } from '../src/services/notifybus.js';
import type { TeamsMessageCard } from '../src/services/notify.js';

interface TestFixtures {
  db: ShipwayDb;
  secretBox: SecretBox;
}

function tmpFixtures(): TestFixtures {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-notifybus-test-'));
  const db = openDb(path.join(dir, 'shipway.db'));
  const secretBox = SecretBox.load(path.join(dir, 'secret.key'));
  return { db, secretBox };
}

function tmpDb(): ShipwayDb {
  return tmpFixtures().db;
}

type ChannelType = 'webhook' | 'teams' | 'email';

function insertChannel(db: ShipwayDb, name: string, url: string, type: ChannelType = 'webhook'): number {
  db.insert(notificationChannels).values({ name, url, type }).run();
  const row = db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.name, name)).get();
  if (!row) throw new Error('failed to insert test channel');
  return row.id;
}

function insertEmailChannel(db: ShipwayDb, name: string, target: string): number {
  db.insert(notificationChannels).values({ name, type: 'email', target }).run();
  const row = db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.name, name)).get();
  if (!row) throw new Error('failed to insert test email channel');
  return row.id;
}

function subscribe(db: ShipwayDb, event: NotifyEvent, channelId: number): void {
  db.insert(notificationSubscriptions).values({ event, channelId }).run();
}

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(behavior: (url: string) => { ok: boolean; status: number } | Error = () => ({ ok: true, status: 200 })): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, init });
    const outcome = behavior(url);
    if (outcome instanceof Error) {
      return Promise.reject(outcome);
    }
    return Promise.resolve({ ok: outcome.ok, status: outcome.status } as Response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('EVENTS', () => {
  it('has all six events with a label, description, and deployment/services category', () => {
    const expectedKeys: NotifyEvent[] = [
      'deploy_failed',
      'deploy_succeeded',
      'deploy_canceled',
      'deploy_rolled_back',
      'service_down',
      'service_recovered',
    ];
    expect(Object.keys(EVENTS).sort()).toEqual([...expectedKeys].sort());

    for (const key of expectedKeys) {
      expect(EVENTS[key].label.length).toBeGreaterThan(0);
      expect(EVENTS[key].description.length).toBeGreaterThan(0);
      expect(['deployment', 'services']).toContain(EVENTS[key].category);
    }
  });

  it('labels deploy_failed and deploy_rolled_back per spec, the latter noting the health-check rollback', () => {
    expect(EVENTS.deploy_failed.label).toBe('Deploy failed');
    expect(EVENTS.deploy_rolled_back.label).toBe('Deploy rolled back');
    expect(EVENTS.deploy_rolled_back.description.toLowerCase()).toContain('health');
  });

  it('categorizes the four deploy_* events as deployment and the two service_* events as services', () => {
    expect(EVENTS.deploy_failed.category).toBe('deployment');
    expect(EVENTS.deploy_succeeded.category).toBe('deployment');
    expect(EVENTS.deploy_canceled.category).toBe('deployment');
    expect(EVENTS.deploy_rolled_back.category).toBe('deployment');
    expect(EVENTS.service_down.category).toBe('services');
    expect(EVENTS.service_recovered.category).toBe('services');
  });
});

describe('emitEvent', () => {
  it('fans out only to channels subscribed to the given event', async () => {
    const db = tmpDb();
    const subscribed1 = insertChannel(db, 'ops-slack', 'https://hooks.slack.com/services/aaa');
    const subscribed2 = insertChannel(db, 'ops-discord', 'https://discord.com/api/webhooks/1/aaa');
    const unrelated = insertChannel(db, 'other', 'https://hooks.slack.com/services/bbb');
    subscribe(db, 'deploy_failed', subscribed1);
    subscribe(db, 'deploy_failed', subscribed2);
    subscribe(db, 'deploy_succeeded', unrelated); // subscribed to a different event only

    const { fetchImpl, calls } = fakeFetch();

    await emitEvent(db, 'deploy_failed', { title: 'Deploy failed', message: '[shop] deploy #12 build failed' }, fetchImpl);

    expect(calls).toHaveLength(2);
    const urls = calls.map((c) => c.url).sort();
    expect(urls).toEqual(['https://discord.com/api/webhooks/1/aaa', 'https://hooks.slack.com/services/aaa'].sort());
  });

  it('sends "title: message" as the text, format-detected per channel URL via notify.ts', async () => {
    const db = tmpDb();
    const slackChannel = insertChannel(db, 'slack', 'https://hooks.slack.com/services/aaa');
    const discordChannel = insertChannel(db, 'discord', 'https://discord.com/api/webhooks/1/aaa');
    subscribe(db, 'service_down', slackChannel);
    subscribe(db, 'service_down', discordChannel);

    const { fetchImpl, calls } = fakeFetch();

    await emitEvent(db, 'service_down', { title: 'Service down', message: 'Nginx (nginx) is failed' }, fetchImpl);

    const slackCall = calls.find((c) => c.url.includes('hooks.slack.com'));
    const discordCall = calls.find((c) => c.url.includes('discord.com'));
    expect(JSON.parse(slackCall?.init?.body as string)).toEqual({ text: 'Service down: Nginx (nginx) is failed' });
    expect(JSON.parse(discordCall?.init?.body as string)).toEqual({ content: 'Service down: Nginx (nginx) is failed' });
  });

  it('never throws when no channel is subscribed to the event', async () => {
    const db = tmpDb();
    const { fetchImpl, calls } = fakeFetch();

    await expect(emitEvent(db, 'deploy_canceled', { title: 'x', message: 'y' }, fetchImpl)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('isolates one channel delivery failure: the other subscribed channel still gets its delivery, and emitEvent never throws', async () => {
    const db = tmpDb();
    const failingChannel = insertChannel(db, 'flaky', 'https://hooks.slack.com/services/flaky');
    const healthyChannel = insertChannel(db, 'healthy', 'https://hooks.slack.com/services/healthy');
    subscribe(db, 'deploy_failed', failingChannel);
    subscribe(db, 'deploy_failed', healthyChannel);

    const { fetchImpl, calls } = fakeFetch((url) => (url.includes('flaky') ? new Error('network down') : { ok: true, status: 200 }));

    await expect(emitEvent(db, 'deploy_failed', { title: 'Deploy failed', message: 'oops' }, fetchImpl)).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.includes('healthy'))).toBe(true);
  });

  it('also isolates a non-ok HTTP response from one channel (not just a thrown/rejected fetch)', async () => {
    const db = tmpDb();
    const failingChannel = insertChannel(db, 'unhealthy', 'https://hooks.slack.com/services/unhealthy');
    const healthyChannel = insertChannel(db, 'healthy2', 'https://hooks.slack.com/services/healthy2');
    subscribe(db, 'deploy_failed', failingChannel);
    subscribe(db, 'deploy_failed', healthyChannel);

    const { fetchImpl, calls } = fakeFetch((url) => (url.includes('unhealthy') ? { ok: false, status: 500 } : { ok: true, status: 200 }));

    await expect(emitEvent(db, 'deploy_failed', { title: 'Deploy failed', message: 'oops' }, fetchImpl)).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('defaults fetchImpl to the global fetch when omitted (does not throw for lack of a 4th arg)', async () => {
    const db = tmpDb();
    // No channels subscribed, so the default fetch is never actually invoked — this just proves the
    // 4th arg is optional per the spec's `emitEvent(db, event, payload, fetchImpl?)` signature.
    await expect(emitEvent(db, 'deploy_succeeded', { title: 'x', message: 'y' })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dispatch by channel type (plan Task 4 / spec §3 "Delivery channels")
// ---------------------------------------------------------------------------

describe('emitEvent — teams-typed channels', () => {
  it('formats an explicit type: teams channel as a MessageCard even when its URL does not match the auto-detect pattern', async () => {
    const db = tmpDb();
    const channelId = insertChannel(db, 'teams-ops', 'https://relay.example.com/teams-in', 'teams');
    subscribe(db, 'deploy_failed', channelId);

    const { fetchImpl, calls } = fakeFetch();
    await emitEvent(db, 'deploy_failed', { title: 'Deploy failed', message: '[shop] deploy #12 build failed' }, fetchImpl);

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]?.init?.body as string) as TeamsMessageCard;
    expect(body['@type']).toBe('MessageCard');
    expect(body.title).toBe('Deploy failed');
    // Same flattened "title: message" text every other webhook format gets (see the "sends 'title:
    // message' as the text" test above) — the MessageCard's separate `title` field is additive, not
    // a replacement for it.
    expect(body.text).toBe('Deploy failed: [shop] deploy #12 build failed');
    expect(body.themeColor).toBe('DC2626'); // failure -> red
  });

  it('auto-detects Teams formatting for a webhook-typed channel whose URL is a webhook.office.com endpoint', async () => {
    const db = tmpDb();
    const channelId = insertChannel(db, 'auto-teams', 'https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def', 'webhook');
    subscribe(db, 'deploy_succeeded', channelId);

    const { fetchImpl, calls } = fakeFetch();
    await emitEvent(db, 'deploy_succeeded', { title: 'Deploy succeeded', message: '[shop] deploy #13 ok' }, fetchImpl);

    const body = JSON.parse(calls[0]?.init?.body as string) as TeamsMessageCard;
    expect(body['@type']).toBe('MessageCard');
    expect(body.themeColor).toBe('16A34A'); // success -> green
  });

  it('uses the neutral/gray themeColor for deploy_canceled', async () => {
    const db = tmpDb();
    const channelId = insertChannel(db, 'teams-cancel', 'https://relay.example.com/teams-in', 'teams');
    subscribe(db, 'deploy_canceled', channelId);

    const { fetchImpl, calls } = fakeFetch();
    await emitEvent(db, 'deploy_canceled', { title: 'Deploy canceled', message: 'x' }, fetchImpl);

    const body = JSON.parse(calls[0]?.init?.body as string) as TeamsMessageCard;
    expect(body.themeColor).toBe('6B7280');
  });
});

describe('emitEvent — email-typed channels', () => {
  it('sends via the mailer to the channel target, subject = event label, body = the message', async () => {
    const { db, secretBox } = tmpFixtures();
    saveMailConfig(db, secretBox, { driver: 'smtp', host: 'smtp.example.com', port: 587, secure: false, fromAddress: 'noreply@example.com' });
    const channelId = insertEmailChannel(db, 'ops-email', 'ops@example.com');
    subscribe(db, 'deploy_failed', channelId);

    const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'abc' });
    const fakeTransport: MailTransport = { sendMail: sendMailMock };

    await emitEvent(db, 'deploy_failed', { title: 'Deploy failed', message: '[shop] deploy #12 build failed' }, fetch, secretBox, () => fakeTransport);

    expect(sendMailMock).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'ops@example.com',
      subject: 'Deploy failed',
      text: '[shop] deploy #12 build failed',
      html: undefined,
    });
  });

  it('skips (never throws) when instance mail is not configured', async () => {
    const { db, secretBox } = tmpFixtures();
    // instance mail left at its default driver: 'none'
    const channelId = insertEmailChannel(db, 'ops-email', 'ops@example.com');
    subscribe(db, 'deploy_failed', channelId);

    const sendMailMock = vi.fn();
    await expect(
      emitEvent(db, 'deploy_failed', { title: 'Deploy failed', message: 'x' }, fetch, secretBox, () => ({ sendMail: sendMailMock })),
    ).resolves.toBeUndefined();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('skips (never throws) when no secretBox is supplied at all', async () => {
    const db = tmpDb();
    const channelId = insertEmailChannel(db, 'ops-email', 'ops@example.com');
    subscribe(db, 'deploy_failed', channelId);

    await expect(emitEvent(db, 'deploy_failed', { title: 'Deploy failed', message: 'x' }, fetch)).resolves.toBeUndefined();
  });

  it('skips (never throws) when the email channel has no target', async () => {
    const { db, secretBox } = tmpFixtures();
    saveMailConfig(db, secretBox, { driver: 'mailpit', host: '127.0.0.1', port: 1025, secure: false, fromAddress: 'shipway@localhost' });
    db.insert(notificationChannels).values({ name: 'broken-email', type: 'email' }).run();
    const channel = db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.name, 'broken-email')).get()!;
    subscribe(db, 'deploy_failed', channel.id);

    const sendMailMock = vi.fn();
    await expect(
      emitEvent(db, 'deploy_failed', { title: 'x', message: 'y' }, fetch, secretBox, () => ({ sendMail: sendMailMock })),
    ).resolves.toBeUndefined();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('never throws when the mailer transport itself fails', async () => {
    const { db, secretBox } = tmpFixtures();
    saveMailConfig(db, secretBox, { driver: 'mailpit', host: '127.0.0.1', port: 1025, secure: false, fromAddress: 'shipway@localhost' });
    const channelId = insertEmailChannel(db, 'ops-email', 'ops@example.com');
    subscribe(db, 'deploy_failed', channelId);

    const fakeTransport: MailTransport = { sendMail: vi.fn().mockRejectedValue(new Error('connection refused')) };
    await expect(
      emitEvent(db, 'deploy_failed', { title: 'x', message: 'y' }, fetch, secretBox, () => fakeTransport),
    ).resolves.toBeUndefined();
  });
});

describe('emitEvent — mixed channel types isolate each other’s failures', () => {
  it('a failing webhook channel does not block a healthy teams channel or a healthy email channel subscribed to the same event', async () => {
    const { db, secretBox } = tmpFixtures();
    saveMailConfig(db, secretBox, { driver: 'mailpit', host: '127.0.0.1', port: 1025, secure: false, fromAddress: 'shipway@localhost' });

    const webhookId = insertChannel(db, 'flaky-webhook', 'https://hooks.slack.com/services/flaky', 'webhook');
    const teamsId = insertChannel(db, 'healthy-teams', 'https://relay.example.com/teams-in', 'teams');
    const emailId = insertEmailChannel(db, 'healthy-email', 'ops@example.com');
    subscribe(db, 'deploy_failed', webhookId);
    subscribe(db, 'deploy_failed', teamsId);
    subscribe(db, 'deploy_failed', emailId);

    const { fetchImpl, calls } = fakeFetch((url) => (url.includes('flaky') ? new Error('network down') : { ok: true, status: 200 }));
    const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'abc' });

    await expect(
      emitEvent(db, 'deploy_failed', { title: 'Deploy failed', message: 'oops' }, fetchImpl, secretBox, () => ({ sendMail: sendMailMock })),
    ).resolves.toBeUndefined();

    // The flaky webhook was attempted and failed, but the teams channel still got its HTTP call...
    expect(calls.some((c) => c.url.includes('relay.example.com'))).toBe(true);
    // ...and the email channel still got its delivery attempt.
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@example.com' }));
  });

  it('an unconfigured email channel does not block a healthy webhook channel subscribed to the same event', async () => {
    const db = tmpDb();
    const webhookId = insertChannel(db, 'healthy-webhook', 'https://hooks.slack.com/services/healthy', 'webhook');
    const emailId = insertEmailChannel(db, 'unconfigured-email', 'ops@example.com');
    subscribe(db, 'deploy_failed', webhookId);
    subscribe(db, 'deploy_failed', emailId);

    // No secretBox passed at all — the email channel is unusable, the webhook is not.
    const { fetchImpl, calls } = fakeFetch();
    await expect(emitEvent(db, 'deploy_failed', { title: 'Deploy failed', message: 'oops' }, fetchImpl)).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('healthy');
  });

  it('a hanging email channel (fix wave I2) does not stall a webhook channel behind it in the fan-out loop', async () => {
    const { db, secretBox } = tmpFixtures();
    saveMailConfig(db, secretBox, { driver: 'mailpit', host: '127.0.0.1', port: 1025, secure: false, fromAddress: 'shipway@localhost' });

    // The email channel is subscribed FIRST, so a still-unbounded await would delay the webhook
    // channel's turn in the sequential fan-out loop (server/src/services/notifybus.ts's `emitEvent`)
    // by however long the hang lasts.
    const emailId = insertEmailChannel(db, 'hanging-email', 'ops@example.com');
    const webhookId = insertChannel(db, 'healthy-webhook', 'https://hooks.slack.com/services/healthy', 'webhook');
    subscribe(db, 'deploy_failed', emailId);
    subscribe(db, 'deploy_failed', webhookId);

    const hangingTransport: MailTransport = { sendMail: () => new Promise(() => {}) }; // never settles
    const { fetchImpl, calls } = fakeFetch();
    const start = Date.now();

    // Short injected `mailSendTimeoutMs` (7th arg) so this test doesn't wait out the real
    // `DEFAULT_MAIL_TIMEOUT_MS` cap to prove the loop keeps moving.
    await expect(
      emitEvent(db, 'deploy_failed', { title: 'Deploy failed', message: 'oops' }, fetchImpl, secretBox, () => hangingTransport, 30),
    ).resolves.toBeUndefined();

    expect(Date.now() - start).toBeLessThan(1000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('healthy');
  });
});
