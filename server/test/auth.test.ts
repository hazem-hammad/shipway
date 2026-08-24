import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { users } from '../src/db/schema.js';
import { hashPassword, verifyPassword } from '../src/lib/passwords.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-auth-test-'));
}

async function buildTestApp(): Promise<FastifyInstance> {
  const dataDir = tmpDataDir();
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });
  return buildApp(cfg);
}

/** Extracts the `name=value` pair from a response's Set-Cookie header, for reuse in later injects. */
function sessionCookie(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') {
    throw new Error('expected a set-cookie header in the response');
  }
  return value.split(';')[0]!;
}

const ADMIN = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct-horse-battery' };

describe('passwords', () => {
  it('hashPassword produces an argon2id hash that verifyPassword accepts', async () => {
    const hash = await hashPassword('super-secret');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'super-secret')).toBe(true);
  });

  it('verifyPassword rejects the wrong password', async () => {
    const hash = await hashPassword('super-secret');
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
  });
});

describe('first-run setup + auth', () => {
  it('GET /api/setup/status reports needsSetup: true before any admin exists', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsSetup: true });
    await app.close();
  });

  it('POST /api/setup/admin creates the first user, logs in, flips needsSetup to false; a second call 409s', async () => {
    const app = await buildTestApp();

    const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
    expect(create.statusCode).toBe(201);
    const cookie = sessionCookie(create);

    const status = await app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(status.json()).toEqual({ needsSetup: false });

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ name: ADMIN.name, email: ADMIN.email, role: 'owner' });

    const secondCreate = await app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { name: 'Second', email: 'second@example.com', password: 'whatever123' },
    });
    expect(secondCreate.statusCode).toBe(409);

    await app.close();
  });

  it('POST /api/setup/admin is race-safe: two concurrent requests create exactly one admin', async () => {
    const app = await buildTestApp();

    // Both requests observe an empty `users` table at their initial (pre-hash) check, then race to
    // finish their `await hashPassword`. Only the check+insert inside `db.transaction` (see
    // src/routes/auth.ts) decides who actually wins.
    const [resA, resB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/setup/admin',
        payload: { name: 'Racer A', email: 'racer-a@example.com', password: 'password-a-123' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/setup/admin',
        payload: { name: 'Racer B', email: 'racer-b@example.com', password: 'password-b-123' },
      }),
    ]);

    const statuses = [resA.statusCode, resB.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const allUsers = app.db.select().from(users).all();
    expect(allUsers.length).toBe(1);

    await app.close();
  });

  it('POST /api/auth/login: wrong password 401, right password 200 + working session', async () => {
    const app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password: 'nope' },
    });
    expect(wrong.statusCode).toBe(401);

    const right = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(right.statusCode).toBe(200);
    const cookie = sessionCookie(right);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: ADMIN.email, role: 'owner' });

    await app.close();
  });

  it('POST /api/setup/admin, POST /api/auth/login, and GET /api/auth/me all expose the session user\'s role — the web UI gates admin/owner controls on it', async () => {
    const app = await buildTestApp();

    // The first-ever user is always 'owner' (see routes/auth.ts's setup/admin handler).
    const setup = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
    expect(setup.json()).toMatchObject({ role: 'owner' });
    const ownerCookie = sessionCookie(setup);

    // Invite + accept a plain member and confirm 'member' (not the owner's role) comes back from
    // every one of the three auth-surface responses that hand the web app its session user.
    const invite = await app.inject({
      method: 'POST',
      url: '/api/users/invite',
      headers: { cookie: ownerCookie },
      payload: { email: 'mona@example.com', role: 'member' },
    });
    expect(invite.statusCode).toBe(201);
    const token = (invite.json() as { inviteUrl: string }).inviteUrl.split('/').pop();

    const accept = await app.inject({
      method: 'POST',
      url: `/api/invite/${String(token)}`,
      payload: { name: 'Mona', password: 'super-secret-1' },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json()).toMatchObject({ email: 'mona@example.com', role: 'member' });
    const memberCookie = sessionCookie(accept);

    const memberMe = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: memberCookie } });
    expect(memberMe.json()).toMatchObject({ role: 'member' });

    const memberLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'mona@example.com', password: 'super-secret-1' },
    });
    expect(memberLogin.statusCode).toBe(200);
    expect(memberLogin.json()).toMatchObject({ email: 'mona@example.com', role: 'member' });

    await app.close();
  });

  it('login for an unknown email still pays the argon2 verify cost (no user-enumeration timing oracle)', async () => {
    const app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });

    const start = performance.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody-such-user@example.com', password: 'whatever-guess' },
    });
    const elapsedMs = performance.now() - start;

    expect(res.statusCode).toBe(401);
    // A real argon2id verify (the app's default cost params) takes on the order of tens of ms; a
    // bare "no such row, skip straight to 401" short-circuit would resolve in well under 1ms. This
    // floor proves the dummy-hash verify actually ran for the unknown-email branch rather than being
    // skipped, which is what closes the timing side-channel.
    expect(elapsedMs).toBeGreaterThan(5);

    await app.close();
  });

  it('GET /api/auth/me without a session cookie is 401', async () => {
    const app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });

    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('POST /api/auth/logout tells the client to clear the session cookie', async () => {
    const app = await buildTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
    const cookie = sessionCookie(create);

    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(204);

    // Secure-session cookies are stateless (all data lives in the signed cookie itself), so logout
    // cannot revoke a still-valid cookie server-side; it clears it via Max-Age=0 and the client is
    // expected to drop it. Confirm that directive is sent, then confirm /me 401s once it's honored.
    const raw = logout.headers['set-cookie'];
    const clearHeader = Array.isArray(raw) ? raw[0] : raw;
    expect(clearHeader).toContain('shipway=;');
    expect(clearHeader).toMatch(/Max-Age=0/i);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(me.statusCode).toBe(401);

    await app.close();
  });

  it('an unauthenticated request to an unimplemented /api/projects route 401s, not 404s (hook runs before routing)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/projects/does-not-exist' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('an authenticated request to an unimplemented /api/projects route 404s (guard passes through)', async () => {
    const app = await buildTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
    const cookie = sessionCookie(create);

    const res = await app.inject({ method: 'GET', url: '/api/projects/does-not-exist', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /api/health and /api/webhooks/* routes stay reachable (not 401) without a session', async () => {
    const app = await buildTestApp();
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);

    // /api/webhooks/github is a real route (see routes/webhooks.ts) — it 503s here because this
    // test app has no github_app setting configured, not because the auth guard blocked it (that
    // would be 401). The 503 is itself the evidence the guard-exempt prefix let the request through.
    const hook = await app.inject({ method: 'POST', url: '/api/webhooks/github' });
    expect(hook.statusCode).toBe(503);

    await app.close();
  });
});

describe('login rate limiting', () => {
  it('blocks after 10 failed attempts from one IP within the window, and resets the counter on success', async () => {
    const app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });

    const attempt = (password: string, remoteAddress: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress,
        payload: { email: ADMIN.email, password },
      });

    const ipA = '10.10.10.1';
    for (let i = 0; i < 10; i++) {
      const res = await attempt('nope', ipA);
      expect(res.statusCode).toBe(401);
    }
    const blocked = await attempt(ADMIN.password, ipA);
    expect(blocked.statusCode).toBe(429);

    const ipB = '10.10.10.2';
    for (let i = 0; i < 5; i++) {
      const res = await attempt('nope', ipB);
      expect(res.statusCode).toBe(401);
    }
    const success = await attempt(ADMIN.password, ipB);
    expect(success.statusCode).toBe(200);

    // Counter reset on success: another 10 failures (not just 5 more) are needed to trip the limit again.
    for (let i = 0; i < 10; i++) {
      const res = await attempt('nope', ipB);
      expect(res.statusCode).toBe(401);
    }
    const blockedAgain = await attempt(ADMIN.password, ipB);
    expect(blockedAgain.statusCode).toBe(429);

    await app.close();
  });
});

describe('trustProxy (B4)', () => {
  it("request.ip is derived from X-Forwarded-For, not nginx's own loopback remoteAddress", async () => {
    // In production every request arrives from nginx on 127.0.0.1 (the server only binds loopback —
    // see docs/server-setup.md), with the real client IP carried in X-Forwarded-For (set by both
    // setup/templates/nginx-dashboard.conf and nginx-mailpit.conf). `app.inject`'s `remoteAddress`
    // simulates the TCP peer (nginx); the `x-forwarded-for` header simulates what nginx forwards.
    // Without `trustProxy: true` in buildApp, `request.ip` would be 127.0.0.1 for every request here,
    // collapsing the login rate limiter (keyed on `request.ip`, routes/auth.ts) onto one shared
    // bucket for every real client — this test would then fail identically for both forwarded IPs.
    const app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });

    const attempt = (password: string, forwardedFor: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': forwardedFor },
        payload: { email: ADMIN.email, password },
      });

    const clientA = '198.51.100.7';
    for (let i = 0; i < 10; i++) {
      const res = await attempt('nope', clientA);
      expect(res.statusCode).toBe(401);
    }
    const blocked = await attempt(ADMIN.password, clientA);
    expect(blocked.statusCode).toBe(429);

    // A different forwarded client, arriving over the same nginx-loopback TCP connection shape, is
    // a fresh bucket — proof the limiter is keyed on the forwarded IP, not the shared remoteAddress.
    const clientB = '198.51.100.8';
    const freshClientSucceeds = await attempt(ADMIN.password, clientB);
    expect(freshClientSucceeds.statusCode).toBe(200);

    await app.close();
  });

  it('keys the rate limiter on the right-most (nginx-appended) X-Forwarded-For hop, not a client-spoofed left-most one', async () => {
    // nginx's $proxy_add_x_forwarded_for APPENDS to whatever X-Forwarded-For the client already
    // sent — it does not replace it. So an external attacker can send their own
    // `X-Forwarded-For: <anything>` on every request; what reaches Shipway is
    // `X-Forwarded-For: <attacker value>, <real peer nginx saw>`. If `trustProxy` trusted the whole
    // chain (`true`), `request.ip` would resolve to the LEFT-MOST (attacker-controlled) entry, so
    // an attacker could pick a fresh spoofed prefix on every login attempt and get a fresh
    // rate-limit bucket every time — bypassing the limiter entirely. Pinning `trustProxy` to the
    // loopback address (`'127.0.0.1'`) instead makes Fastify walk the chain from the right and stop
    // at the first hop NOT in the trusted list — nginx's own appended value — which the client
    // cannot influence.
    //
    // This test asserts on the right-most/nginx-appended IP by varying only the left-most/spoofed
    // prefix across attempts while holding the real (right-most) IP fixed: it must FAIL under
    // `trustProxy: true` (each attempt lands in a different bucket, so the 11th "attacker" attempt
    // below would still succeed) and PASS under `trustProxy: '127.0.0.1'`.
    const app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });

    const realNginxObservedIp = '203.0.113.9';

    const attemptWithSpoofedPrefix = (password: string, spoofSuffix: number) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': `6.6.6.${String(spoofSuffix)}, ${realNginxObservedIp}` },
        payload: { email: ADMIN.email, password },
      });

    for (let i = 0; i < 10; i++) {
      const res = await attemptWithSpoofedPrefix('nope', i);
      expect(res.statusCode).toBe(401);
    }

    // A fresh spoofed prefix (never used above) — if the limiter were keyed on the attacker-
    // controlled left-most entry, this would look like a brand-new client and succeed (200),
    // bypassing the limiter. Keyed on the real, nginx-appended right-most entry, it's still the
    // same bucket as the 10 failures above, so it must be blocked.
    const blocked = await attemptWithSpoofedPrefix(ADMIN.password, 999);
    expect(blocked.statusCode).toBe(429);

    await app.close();
  });
});
