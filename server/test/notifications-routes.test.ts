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

interface PublicChannel {
  id: number;
  name: string;
  type: 'webhook' | 'teams' | 'email';
  url: string | null;
  target: string | null;
}

interface MatrixResponse {
  channels: PublicChannel[];
  events: { event: string; label: string; description: string; category: string }[];
  subscriptions: { event: string; channelId: number }[];
}

/** Configures instance mail (driver: mailpit — no validation, no real credentials needed) via the
 * Task 3 route, a prerequisite for creating/keeping an `email`-typed channel. */
async function configureMail(app: Awaited<ReturnType<typeof buildOwnerApp>>['app'], cookie: string): Promise<void> {
  const res = await app.inject({ method: 'PUT', url: '/api/settings/mail', headers: { cookie }, payload: { driver: 'mailpit' } });
  if (res.statusCode !== 200) throw new Error(`configureMail: PUT /api/settings/mail failed (${res.statusCode}): ${res.body}`);
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
    expect(body.channels[0]).toMatchObject({ name: 'ops', type: 'webhook', url: 'https://hooks.slack.com/services/aaa', target: null });
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

// ---------------------------------------------------------------------------
// Channel type: teams / email (plan Task 4 / spec §3 "Delivery channels")
// ---------------------------------------------------------------------------

describe('POST /api/notifications/channels — type: teams', () => {
  it('creates a teams channel with a valid http(s) url, same as a webhook channel', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'teams-ops', type: 'teams', url: 'https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as PublicChannel;
    expect(body).toMatchObject({ name: 'teams-ops', type: 'teams', url: 'https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def', target: null });

    await app.close();
  });

  it('400s a teams channel with a missing/invalid url', async () => {
    const { app, cookie } = await buildOwnerApp();

    const missing = await app.inject({ method: 'POST', url: '/api/notifications/channels', headers: { cookie }, payload: { name: 'x', type: 'teams' } });
    expect(missing.statusCode).toBe(400);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'y', type: 'teams', url: 'not-a-url' },
    });
    expect(invalid.statusCode).toBe(400);

    await app.close();
  });
});

describe('POST /api/notifications/channels — type: email', () => {
  it('400s with a clear message when instance mail is not configured', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops-email', type: 'email', target: 'ops@example.com' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('configure instance mail');

    await app.close();
  });

  it('400s for a syntactically invalid email address, even with mail configured', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureMail(app, cookie);

    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops-email', type: 'email', target: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('400s for a missing target address', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureMail(app, cookie);

    const res = await app.inject({ method: 'POST', url: '/api/notifications/channels', headers: { cookie }, payload: { name: 'ops-email', type: 'email' } });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('creates an email channel once mail is configured and the address is valid — url null, target set', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureMail(app, cookie);

    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops-email', type: 'email', target: 'ops@example.com' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as PublicChannel;
    expect(body).toMatchObject({ name: 'ops-email', type: 'email', url: null, target: 'ops@example.com' });

    const row = app.db.select().from(notificationChannels).where(eq(notificationChannels.id, body.id)).get();
    expect(row?.url).toBeNull();
    expect(row?.target).toBe('ops@example.com');

    await app.close();
  });

  it('member 403s creating an email channel (same admin gate as every other channel type)', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie: memberCookie },
      payload: { name: 'ops-email', type: 'email', target: 'ops@example.com' },
    });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('a duplicate name is still 409 even across different types', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureMail(app, cookie);
    await app.inject({ method: 'POST', url: '/api/notifications/channels', headers: { cookie }, payload: { name: 'ops', url: 'https://hooks.slack.com/services/aaa' } });

    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops', type: 'email', target: 'ops@example.com' },
    });
    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it('omitting type defaults to webhook (backward-compatible payload shape)', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'legacy-shape', url: 'https://hooks.slack.com/services/aaa' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as PublicChannel).type).toBe('webhook');

    await app.close();
  });
});

describe('PATCH /api/notifications/channels/:id — changing type', () => {
  it('switching an existing webhook channel to email requires a target AND mail already configured', async () => {
    const { app, cookie } = await buildOwnerApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops', url: 'https://hooks.slack.com/services/aaa' },
    });
    const id = (created.json() as PublicChannel).id;

    // Mail not yet configured — even with a target supplied, this must 400 with the same message
    // POST would give.
    const notConfigured = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/channels/${String(id)}`,
      headers: { cookie },
      payload: { type: 'email', target: 'ops@example.com' },
    });
    expect(notConfigured.statusCode).toBe(400);
    expect((notConfigured.json() as { error: string }).error).toContain('configure instance mail');

    await configureMail(app, cookie);

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/channels/${String(id)}`,
      headers: { cookie },
      payload: { type: 'email', target: 'ops@example.com' },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as PublicChannel;
    expect(body).toMatchObject({ type: 'email', url: null, target: 'ops@example.com' });

    await app.close();
  });

  it('switching type to email WITHOUT supplying a target 400s rather than silently keeping the old url as a "target"', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureMail(app, cookie);
    const created = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops', url: 'https://hooks.slack.com/services/aaa' },
    });
    const id = (created.json() as PublicChannel).id;

    const res = await app.inject({ method: 'PATCH', url: `/api/notifications/channels/${String(id)}`, headers: { cookie }, payload: { type: 'email' } });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('switching an email channel back to webhook requires a fresh url (the old target does not carry over)', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureMail(app, cookie);
    const created = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops-email', type: 'email', target: 'ops@example.com' },
    });
    const id = (created.json() as PublicChannel).id;

    const missingUrl = await app.inject({ method: 'PATCH', url: `/api/notifications/channels/${String(id)}`, headers: { cookie }, payload: { type: 'webhook' } });
    expect(missingUrl.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/channels/${String(id)}`,
      headers: { cookie },
      payload: { type: 'webhook', url: 'https://hooks.slack.com/services/back' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ type: 'webhook', url: 'https://hooks.slack.com/services/back', target: null });

    await app.close();
  });

  it('a PATCH that only touches name keeps the existing type/url/target untouched', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureMail(app, cookie);
    const created = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops-email', type: 'email', target: 'ops@example.com' },
    });
    const id = (created.json() as PublicChannel).id;

    const res = await app.inject({ method: 'PATCH', url: `/api/notifications/channels/${String(id)}`, headers: { cookie }, payload: { name: 'ops-email-renamed' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'ops-email-renamed', type: 'email', url: null, target: 'ops@example.com' });

    await app.close();
  });

  it('renaming an existing email channel still works after instance mail is later un-configured (a name-only PATCH must not re-run the live isMailConfigured check)', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureMail(app, cookie);
    const created = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops-email', type: 'email', target: 'ops@example.com' },
    });
    const id = (created.json() as PublicChannel).id;

    // Instance mail is un-configured again after the channel already exists (a realistic later
    // state — see the same scenario in the test-send describe block below).
    await app.inject({ method: 'PUT', url: '/api/settings/mail', headers: { cookie }, payload: { driver: 'none' } });

    const res = await app.inject({ method: 'PATCH', url: `/api/notifications/channels/${String(id)}`, headers: { cookie }, payload: { name: 'ops-email-renamed' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'ops-email-renamed', type: 'email', url: null, target: 'ops@example.com' });

    await app.close();
  });
});

describe('POST /api/notifications/channels/:id/test — per-type', () => {
  it('an email channel test-send returns {ok: false, error} when instance mail is not configured', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureMail(app, cookie);
    const created = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops-email', type: 'email', target: 'ops@example.com' },
    });
    const id = (created.json() as PublicChannel).id;

    // Un-configure mail again after the channel already exists (a realistic later state).
    await app.inject({ method: 'PUT', url: '/api/settings/mail', headers: { cookie }, payload: { driver: 'none' } });

    const res = await app.inject({ method: 'POST', url: `/api/notifications/channels/${String(id)}/test`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: 'instance mail is not configured' });

    await app.close();
  });

  it('an email channel test-send never 500s when the configured smtp host is unreachable', async () => {
    const { app, cookie } = await buildOwnerApp();
    await app.inject({
      method: 'PUT',
      url: '/api/settings/mail',
      headers: { cookie },
      // Port 1 is reserved (TCPMUX) and never has an SMTP listener — connection is refused fast.
      payload: { driver: 'smtp', host: '127.0.0.1', port: 1, fromAddress: 'a@b.com' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'ops-email', type: 'email', target: 'ops@example.com' },
    });
    const id = (created.json() as PublicChannel).id;

    const res = await app.inject({ method: 'POST', url: `/api/notifications/channels/${String(id)}/test`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');

    await app.close();
  }, 10_000);

  it('a teams channel test-send posts a MessageCard body and returns {ok: true}', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: input.toString(), body: (init?.body as string) ?? '' });
      return Promise.resolve({ ok: true, status: 200 } as Response);
    }) as typeof fetch;
    const { app, cookie } = await buildOwnerApp({ fetchImpl });

    const created = await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'teams-ops', type: 'teams', url: 'https://relay.example.com/teams-in' },
    });
    const id = (created.json() as PublicChannel).id;

    const res = await app.inject({ method: 'POST', url: `/api/notifications/channels/${String(id)}/test`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]?.body ?? '{}') as { '@type': string };
    expect(body['@type']).toBe('MessageCard');

    await app.close();
  });
});

describe('GET /api/notifications — matrix includes type/target', () => {
  it('lists a mix of webhook/teams/email channels with their type and target', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureMail(app, cookie);

    await app.inject({ method: 'POST', url: '/api/notifications/channels', headers: { cookie }, payload: { name: 'webhook-ops', url: 'https://hooks.slack.com/services/aaa' } });
    await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'teams-ops', type: 'teams', url: 'https://relay.example.com/teams-in' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/notifications/channels',
      headers: { cookie },
      payload: { name: 'email-ops', type: 'email', target: 'ops@example.com' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie } });
    const body = res.json() as MatrixResponse;
    const byName = new Map(body.channels.map((c) => [c.name, c]));

    expect(byName.get('webhook-ops')).toMatchObject({ type: 'webhook', url: 'https://hooks.slack.com/services/aaa', target: null });
    expect(byName.get('teams-ops')).toMatchObject({ type: 'teams', url: 'https://relay.example.com/teams-in', target: null });
    expect(byName.get('email-ops')).toMatchObject({ type: 'email', url: null, target: 'ops@example.com' });

    await app.close();
  });
});
