import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { setSetting } from '../src/db/settings.js';
import { FakeDnsClient, makeCloudflareClient, type DnsClient } from '../src/services/cloudflare.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-cloudflare-route-test-'));
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

/**
 * Builds an app (with the given `dns()` override), creates the first admin, seeds
 * `cloudflare_token`/`cloudflare_zone_id` settings (when given), and returns a ready cookie.
 * Settings are written directly via `setSetting` rather than through `PUT /api/settings` so tests
 * can exercise whitespace-only/empty values that the route's own zod schema would otherwise reject
 * before they ever reach the verify route's blank check.
 */
async function buildAuthedApp(
  dns: () => DnsClient | null,
  settings?: { cloudflare_token?: string | null; cloudflare_zone_id?: string | null },
): Promise<{ app: FastifyInstance; cookie: string }> {
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
  const app = await buildApp(cfg, { dns });
  const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
  const cookie = sessionCookie(create);

  if (settings?.cloudflare_token !== undefined) setSetting(app.db, 'cloudflare_token', settings.cloudflare_token);
  if (settings?.cloudflare_zone_id !== undefined) setSetting(app.db, 'cloudflare_zone_id', settings.cloudflare_zone_id);

  return { app, cookie };
}

const FAKE_CONFIGURED: DnsClient = {
  verifyToken: async () => true,
  createARecord: async () => 'unused',
  findARecord: async () => null,
  deleteARecord: async () => {},
};

/** A `dns()` override that fails the test if it's ever called — proves the route short-circuits
 * on the settings check before asking for a client at all. */
function dnsThatMustNotBeCalled(): () => DnsClient | null {
  return () => {
    throw new Error('dns() should not have been called for an unconfigured verify');
  };
}

describe('GET /api/cloudflare/verify', () => {
  describe('not configured', () => {
    it('reports not_configured without calling dns() when no settings exist at all', async () => {
      const { app, cookie } = await buildAuthedApp(dnsThatMustNotBeCalled());

      const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: false, reason: 'not_configured' });

      await app.close();
    });

    it('reports not_configured when the token is an empty string', async () => {
      const { app, cookie } = await buildAuthedApp(dnsThatMustNotBeCalled(), {
        cloudflare_token: '',
        cloudflare_zone_id: 'zone-1',
      });

      const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
      expect(res.json()).toEqual({ ok: false, reason: 'not_configured' });

      await app.close();
    });

    it('reports not_configured when the token is whitespace-only', async () => {
      const { app, cookie } = await buildAuthedApp(dnsThatMustNotBeCalled(), {
        cloudflare_token: '   ',
        cloudflare_zone_id: 'zone-1',
      });

      const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
      expect(res.json()).toEqual({ ok: false, reason: 'not_configured' });

      await app.close();
    });

    it('reports not_configured when the zone id is missing (token present)', async () => {
      const { app, cookie } = await buildAuthedApp(dnsThatMustNotBeCalled(), { cloudflare_token: 'tok-1' });

      const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
      expect(res.json()).toEqual({ ok: false, reason: 'not_configured' });

      await app.close();
    });

    it('reports not_configured when the zone id is whitespace-only', async () => {
      const { app, cookie } = await buildAuthedApp(dnsThatMustNotBeCalled(), {
        cloudflare_token: 'tok-1',
        cloudflare_zone_id: '\t\n ',
      });

      const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
      expect(res.json()).toEqual({ ok: false, reason: 'not_configured' });

      await app.close();
    });
  });

  it('returns {ok: true, reason: "ok"} when a configured dns client verifies the token', async () => {
    const { app, cookie } = await buildAuthedApp(() => FAKE_CONFIGURED, {
      cloudflare_token: 'tok-1',
      cloudflare_zone_id: 'zone-1',
    });

    const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, reason: 'ok' });

    await app.close();
  });

  it('returns {ok: false, reason: "invalid_token"} when a configured dns client reports an invalid token', async () => {
    const invalid: DnsClient = { ...FAKE_CONFIGURED, verifyToken: async () => false };
    const { app, cookie } = await buildAuthedApp(() => invalid, {
      cloudflare_token: 'tok-1',
      cloudflare_zone_id: 'zone-1',
    });

    const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, reason: 'invalid_token' });

    await app.close();
  });

  it('dev-with-credentials path: a configured FakeDnsClient makes a real (injected-fetch) call and honestly fails a wrong token', async () => {
    const stub = (async () =>
      new Response(JSON.stringify({ success: false, result: null, errors: [{ code: 1000, message: 'Invalid API Token' }] }), {
        status: 400,
      })) as typeof fetch;
    const fake = new FakeDnsClient(stub);
    fake.setCredentials({ token: 'wrong-token', zoneId: 'zone-1' });

    const { app, cookie } = await buildAuthedApp(() => fake, {
      cloudflare_token: 'wrong-token',
      cloudflare_zone_id: 'zone-1',
    });

    const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, reason: 'invalid_token' });

    // Fake CRUD still works fully offline, independent of the (wrong) credentials above.
    await expect(fake.createARecord('foo.example.com', '1.2.3.4')).resolves.toBe('fake-1');

    await app.close();
  });

  it('dev-with-credentials path: a configured FakeDnsClient makes a real (injected-fetch) call and honestly succeeds for a good token', async () => {
    const stub = (async () =>
      new Response(JSON.stringify({ success: true, result: { id: 'tok', status: 'active' }, errors: [] }), { status: 200 })) as typeof fetch;
    const fake = new FakeDnsClient(stub);
    fake.setCredentials({ token: 'good-token', zoneId: 'zone-1' });

    const { app, cookie } = await buildAuthedApp(() => fake, {
      cloudflare_token: 'good-token',
      cloudflare_zone_id: 'zone-1',
    });

    const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
    expect(res.json()).toEqual({ ok: true, reason: 'ok' });

    await app.close();
  });

  it('maps invalid_token via an injected fetch through the real CloudflareDnsClient (not a hand-rolled fake)', async () => {
    const stub = (async () =>
      new Response(JSON.stringify({ success: false, result: null, errors: [{ code: 1000, message: 'Invalid API Token' }] }), {
        status: 400,
      })) as typeof fetch;
    const dns = () => makeCloudflareClient('bad-token', 'zone-1', stub);

    const { app, cookie } = await buildAuthedApp(dns, { cloudflare_token: 'bad-token', cloudflare_zone_id: 'zone-1' });

    const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
    expect(res.json()).toEqual({ ok: false, reason: 'invalid_token' });

    await app.close();
  });

  it('maps a thrown network error to reason "error" with a sanitized message', async () => {
    const throwing: DnsClient = {
      ...FAKE_CONFIGURED,
      verifyToken: async () => {
        throw new Error('fetch failed: getaddrinfo ENOTFOUND api.cloudflare.com');
      },
    };
    const { app, cookie } = await buildAuthedApp(() => throwing, {
      cloudflare_token: 'tok-1',
      cloudflare_zone_id: 'zone-1',
    });

    const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; reason: string; message?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('error');
    expect(body.message).toContain('ENOTFOUND');

    await app.close();
  });

  it('never echoes the stored token in the error message, even when the thrown error contains it verbatim', async () => {
    const secretToken = 'super-secret-cf-token-xyz789';
    const throwing: DnsClient = {
      ...FAKE_CONFIGURED,
      verifyToken: async () => {
        throw new Error(`request failed with token ${secretToken} attached to the request`);
      },
    };
    const { app, cookie } = await buildAuthedApp(() => throwing, {
      cloudflare_token: secretToken,
      cloudflare_zone_id: 'zone-1',
    });

    const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
    const body = res.json() as { ok: boolean; reason: string; message?: string };
    expect(body.reason).toBe('error');
    expect(body.message).not.toContain(secretToken);
    expect(body.message).toContain('[redacted]');

    // Belt and suspenders: the raw response body (not just the parsed message field) never
    // contains the token either.
    expect(res.payload).not.toContain(secretToken);

    await app.close();
  });

  it('requires authentication', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { dns: () => null });
    await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });

    const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify' });
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
