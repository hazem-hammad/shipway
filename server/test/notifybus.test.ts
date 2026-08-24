/**
 * Task 4's event bus: `EVENTS` (the six named events with labels/descriptions/category, surfaced by
 * `GET /api/notifications`) and `emitEvent` (fans a `{title, message}` payload out to every channel
 * currently subscribed to that event, reusing `services/notify.ts`'s URL-format detection).
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { notificationChannels, notificationSubscriptions } from '../src/db/schema.js';
import { EVENTS, emitEvent, type NotifyEvent } from '../src/services/notifybus.js';

function tmpDb(): ShipwayDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-notifybus-test-'));
  return openDb(path.join(dir, 'shipway.db'));
}

function insertChannel(db: ShipwayDb, name: string, url: string): number {
  db.insert(notificationChannels).values({ name, url }).run();
  const row = db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.name, name)).get();
  if (!row) throw new Error('failed to insert test channel');
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
