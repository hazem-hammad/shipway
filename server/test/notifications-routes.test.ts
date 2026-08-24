/**
 * Task 4's notifications API: channels CRUD (admin+, with URL validation + unique-name 409),
 * `GET /api/notifications` (the full matrix: channels/events/subscriptions, member-readable),
 * test-send (member+), and the subscriptions PUT (admin+).
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { notificationChannels, notificationSubscriptions } from '../src/db/schema.js';
import { auditEvents } from '../src/db/schema.js';
import { buildOwnerApp, createAdmin, createMember } from './helpers.js';

const FORBIDDEN_ADMIN = { error: 'requires admin' };

interface MatrixResponse {
  channels: { id: number; name: string; url: string }[];
  events: { event: string; label: string; description: string; category: string }[];
  subscriptions: { event: string; channelId: number }[];
}

describe('GET /api/notifications', () => {
  it('is readable by a plain member and returns {channels, events, subscriptions}', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);

    await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie: ownerCookie },
      payload: { name: 'ops', url: 'https://hooks.slack.com/services/aaa' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MatrixResponse;

    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({ name: 'ops', url: 'https://hooks.slack.com/services/aaa' });
    expect(body.events).toHaveLength(6);
    const eventNames = body.events.map((e) => e.event).sort();
    expect(eventNames).toEqual(
      ['deploy_failed', 'deploy_succeeded', 'deploy_canceled', 'deploy_rolled_back', 'service_down', 'service_recovered'].sort(),
    );
    for (const e of body.events) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
      expect(['deployment', 'services']).toContain(e.category);
    }
    expect(body.subscriptions).toEqual([]);

    await app.close();
  });

  it('401s without a session', async () => {
    const { app } = await buildOwnerApp();
    const res = await app.inject({ method: 'GET', url: '/api/notifications' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /api/notifications/channels', () => {
  it('member 403s, admin creates a channel and records an audit row', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);

    const memberRes = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie: memberCookie },
      payload: { name: 'ops', url: 'https://hooks.slack.com/services/aaa' },
    });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json()).toEqual(FORBIDDEN_ADMIN);

    const adminRes = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie: adminCookie },
      payload: { name: 'ops', url: 'https://hooks.slack.com/services/aaa' },
    });
    expect(adminRes.statusCode).toBe(201);
    const created = adminRes.json() as { id: number; name: string; url: string };
    expect(created).toMatchObject({ name: 'ops', url: 'https://hooks.slack.com/services/aaa' });

    const rows = app.db.select().from(notificationChannels).all();
    expect(rows).toHaveLength(1);

    const auditRows = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'notification.channel.create')).all();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.targetName).toBe('ops');

    void ownerCookie;
    await app.close();
  });

  it('400s for a non-http(s) url', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'bad', url: 'ftp://example.com/hook' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('400s for a missing name', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { url: 'https://hooks.slack.com/services/aaa' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('409s on a duplicate channel name', async () => {
    const { app, cookie } = await buildOwnerApp();

    await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops', url: 'https://hooks.slack.com/services/aaa' },
    });
    const dupe = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops', url: 'https://hooks.slack.com/services/bbb' },
    });
    expect(dupe.statusCode).toBe(409);

    await app.close();
  });
});

describe('PATCH /api/notifications/channels/:id', () => {
  async function makeChannel(app: Awaited<ReturnType<typeof buildOwnerApp>>['app'], cookie: string, name = 'ops'): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name, url: 'https://hooks.slack.com/services/aaa' },
    });
    return (res.json() as { id: number }).id;
  }

  it('member 403s, admin updates name/url', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const channelId = await makeChannel(app, ownerCookie);

    const memberRes = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/channels/${String(channelId)}`,
      headers: { cookie: memberCookie },
      payload: { name: 'renamed' },
    });
    expect(memberRes.statusCode).toBe(403);

    const adminRes = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/channels/${String(channelId)}`,
      headers: { cookie: ownerCookie },
      payload: { name: 'renamed', url: 'https://hooks.slack.com/services/renamed' },
    });
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.json()).toMatchObject({ name: 'renamed', url: 'https://hooks.slack.com/services/renamed' });

    const auditRows = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'notification.channel.update')).all();
    expect(auditRows).toHaveLength(1);

    await app.close();
  });

  it('404s for an unknown channel', async () => {
    const { app, cookie } = await buildOwnerApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/notifications/channels/999999',
      headers: { cookie },
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('409s when renaming to a name already used by another channel', async () => {
    const { app, cookie } = await buildOwnerApp();
    await makeChannel(app, cookie, 'first');
    const secondId = await makeChannel(app, cookie, 'second');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/channels/${String(secondId)}`,
      headers: { cookie },
      payload: { name: 'first' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('allows PATCHing a channel to keep its own current name (no false 409 against itself)', async () => {
    const { app, cookie } = await buildOwnerApp();
    const channelId = await makeChannel(app, cookie, 'ops');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/channels/${String(channelId)}`,
      headers: { cookie },
      payload: { name: 'ops', url: 'https://hooks.slack.com/services/updated' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('400s for an invalid url on update', async () => {
    const { app, cookie } = await buildOwnerApp();
    const channelId = await makeChannel(app, cookie);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/channels/${String(channelId)}`,
      headers: { cookie },
      payload: { url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('DELETE /api/notifications/channels/:id', () => {
  it('member 403s; admin deletes the channel and cascades its subscriptions; records an audit row', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie: ownerCookie },
      payload: { name: 'ops', url: 'https://hooks.slack.com/services/aaa' },
    });
    const channelId = (createRes.json() as { id: number }).id;

    await app.inject({
      method: 'PUT',
      url: '/api/notifications/subscriptions',
      headers: { cookie: ownerCookie },
      payload: { event: 'deploy_failed', channelId, enabled: true },
    });

    const memberRes = await app.inject({
      method: 'DELETE',
      url: `/api/notifications/channels/${String(channelId)}`,
      headers: { cookie: memberCookie },
    });
    expect(memberRes.statusCode).toBe(403);

    const adminRes = await app.inject({
      method: 'DELETE',
      url: `/api/notifications/channels/${String(channelId)}`,
      headers: { cookie: ownerCookie },
    });
    expect(adminRes.statusCode).toBe(204);

    expect(app.db.select().from(notificationChannels).all()).toHaveLength(0);
    expect(app.db.select().from(notificationSubscriptions).all()).toHaveLength(0);

    const auditRows = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'notification.channel.delete')).all();
    expect(auditRows).toHaveLength(1);

    await app.close();
  });

  it('404s for an unknown channel', async () => {
    const { app, cookie } = await buildOwnerApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/notifications/channels/999999', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /api/notifications/channels/:id/test', () => {
  it('sends "Test notification from Shipway" and returns {ok: true} on a successful delivery', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: input.toString(), body: (init?.body as string) ?? '' });
      return Promise.resolve({ ok: true, status: 200 } as Response);
    }) as typeof fetch;

    const { app, cookie: ownerCookie } = await buildOwnerApp({ fetchImpl });
    const { cookie: memberCookie } = await createMember(app);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie: ownerCookie },
      payload: { name: 'ops', url: 'https://hooks.slack.com/services/aaa' },
    });
    const channelId = (createRes.json() as { id: number }).id;

    // member+ (any authenticated user) can trigger a test send
    const res = await app.inject({
      method: 'POST',
      url: `/api/notifications/channels/${String(channelId)}/test`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ text: 'Test notification from Shipway' });

    await app.close();
  });

  it('returns {ok: false} (not a 500) when the channel delivery fails', async () => {
    const fetchImpl = (() => Promise.resolve({ ok: false, status: 500 } as Response)) as typeof fetch;
    const { app, cookie } = await buildOwnerApp({ fetchImpl });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'flaky', url: 'https://hooks.slack.com/services/flaky' },
    });
    const channelId = (createRes.json() as { id: number }).id;

    const res = await app.inject({ method: 'POST', url: `/api/notifications/channels/${String(channelId)}/test`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false });

    await app.close();
  });

  it('404s for an unknown channel', async () => {
    const { app, cookie } = await buildOwnerApp();
    const res = await app.inject({ method: 'POST', url: '/api/notifications/channels/999999/test', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('PUT /api/notifications/subscriptions', () => {
  async function makeChannel(app: Awaited<ReturnType<typeof buildOwnerApp>>['app'], cookie: string): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops', url: 'https://hooks.slack.com/services/aaa' },
    });
    return (res.json() as { id: number }).id;
  }

  it('member 403s; admin subscribing with enabled:true inserts the pair and records an audit row', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const channelId = await makeChannel(app, ownerCookie);

    const memberRes = await app.inject({
      method: 'PUT',
      url: '/api/notifications/subscriptions',
      headers: { cookie: memberCookie },
      payload: { event: 'deploy_failed', channelId, enabled: true },
    });
    expect(memberRes.statusCode).toBe(403);

    const adminRes = await app.inject({
      method: 'PUT',
      url: '/api/notifications/subscriptions',
      headers: { cookie: ownerCookie },
      payload: { event: 'deploy_failed', channelId, enabled: true },
    });
    expect(adminRes.statusCode).toBe(200);

    const rows = app.db.select().from(notificationSubscriptions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'deploy_failed', channelId });

    const auditRows = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'notification.subscribe')).all();
    expect(auditRows).toHaveLength(1);

    await app.close();
  });

  it('is idempotent: subscribing twice to the same event does not create a duplicate row or error', async () => {
    const { app, cookie } = await buildOwnerApp();
    const channelId = await makeChannel(app, cookie);

    await app.inject({
      method: 'PUT',
      url: '/api/notifications/subscriptions',
      headers: { cookie },
      payload: { event: 'deploy_failed', channelId, enabled: true },
    });
    const second = await app.inject({
      method: 'PUT',
      url: '/api/notifications/subscriptions',
      headers: { cookie },
      payload: { event: 'deploy_failed', channelId, enabled: true },
    });
    expect(second.statusCode).toBe(200);

    const rows = app.db.select().from(notificationSubscriptions).all();
    expect(rows).toHaveLength(1);

    await app.close();
  });

  it('enabled:false removes the subscription and records notification.unsubscribe', async () => {
    const { app, cookie } = await buildOwnerApp();
    const channelId = await makeChannel(app, cookie);

    await app.inject({
      method: 'PUT',
      url: '/api/notifications/subscriptions',
      headers: { cookie },
      payload: { event: 'deploy_failed', channelId, enabled: true },
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/notifications/subscriptions',
      headers: { cookie },
      payload: { event: 'deploy_failed', channelId, enabled: false },
    });
    expect(res.statusCode).toBe(200);

    expect(app.db.select().from(notificationSubscriptions).all()).toHaveLength(0);

    const auditRows = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'notification.unsubscribe')).all();
    expect(auditRows).toHaveLength(1);

    await app.close();
  });

  it('enabled:false on a not-currently-subscribed pair is a harmless no-op', async () => {
    const { app, cookie } = await buildOwnerApp();
    const channelId = await makeChannel(app, cookie);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/notifications/subscriptions',
      headers: { cookie },
      payload: { event: 'deploy_failed', channelId, enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(app.db.select().from(notificationSubscriptions).all()).toHaveLength(0);

    await app.close();
  });

  it('400s for an event not in EVENTS', async () => {
    const { app, cookie } = await buildOwnerApp();
    const channelId = await makeChannel(app, cookie);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/notifications/subscriptions',
      headers: { cookie },
      payload: { event: 'not_a_real_event', channelId, enabled: true },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('404s for an unknown channelId', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/notifications/subscriptions',
      headers: { cookie },
      payload: { event: 'deploy_failed', channelId: 999999, enabled: true },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
