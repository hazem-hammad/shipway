import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { getSetting, setSetting } from '../src/db/settings.js';
import { cloneUrl, verifyWebhookSignature } from '../src/services/github.js';

describe('verifyWebhookSignature', () => {
  const secret = 'top-secret-webhook-key';
  const rawBody = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }));

  function validSigHeader(): string {
    return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  }

  it('returns true for a valid signature', () => {
    expect(verifyWebhookSignature(secret, rawBody, validSigHeader())).toBe(true);
  });

  it('returns false for a signature computed with the wrong secret', () => {
    const badSig = `sha256=${createHmac('sha256', 'wrong-secret').update(rawBody).digest('hex')}`;
    expect(verifyWebhookSignature(secret, rawBody, badSig)).toBe(false);
  });

  it('returns false for a signature computed over a different body', () => {
    const otherBody = Buffer.from(JSON.stringify({ ref: 'refs/heads/other' }));
    const sig = `sha256=${createHmac('sha256', secret).update(otherBody).digest('hex')}`;
    expect(verifyWebhookSignature(secret, rawBody, sig)).toBe(false);
  });

  it('returns false when the header is missing (undefined)', () => {
    expect(verifyWebhookSignature(secret, rawBody, undefined)).toBe(false);
  });

  it('returns false when the header is missing the sha256= prefix', () => {
    const raw = createHmac('sha256', secret).update(rawBody).digest('hex');
    expect(verifyWebhookSignature(secret, rawBody, raw)).toBe(false);
  });

  it('returns false (never throws) for a header of the wrong length, exercising the timing-safe length guard', () => {
    expect(() => verifyWebhookSignature(secret, rawBody, 'sha256=deadbeef')).not.toThrow();
    expect(verifyWebhookSignature(secret, rawBody, 'sha256=deadbeef')).toBe(false);
  });

  it('returns false (never throws) for an empty signature value', () => {
    expect(() => verifyWebhookSignature(secret, rawBody, 'sha256=')).not.toThrow();
    expect(verifyWebhookSignature(secret, rawBody, 'sha256=')).toBe(false);
  });
});

describe('cloneUrl', () => {
  it('builds an x-access-token clone URL from the repo full name and token', () => {
    expect(cloneUrl('acme/widgets', 'ghs_abc123')).toBe('https://x-access-token:ghs_abc123@github.com/acme/widgets.git');
  });
});

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-github-test-'));
}

async function buildTestApp(fetchImpl?: typeof fetch): Promise<FastifyInstance> {
  const dataDir = tmpDataDir();
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });
  return buildApp(cfg, { fetchImpl });
}

function sessionCookie(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') {
    throw new Error('expected a set-cookie header in the response');
  }
  return value.split(';')[0]!;
}

const ADMIN = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct-horse-battery' };

async function buildAuthedApp(fetchImpl?: typeof fetch): Promise<{ app: FastifyInstance; cookie: string }> {
  const app = await buildTestApp(fetchImpl);
  const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
  const cookie = sessionCookie(create);
  return { app, cookie };
}

const GITHUB_APP_CFG = {
  appId: 123456,
  privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
  webhookSecret: 'whsec_test',
};

describe('GET /api/github/status', () => {
  it('reports not configured / not installed when no github_app setting exists', async () => {
    const { app, cookie } = await buildAuthedApp();

    const res = await app.inject({ method: 'GET', url: '/api/github/status', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false, installed: false, appSlug: null });

    await app.close();
  });

  it('reports configured but not installed once github_app exists without an installationId', async () => {
    const { app, cookie } = await buildAuthedApp();
    const res1 = await app.inject({
      method: 'PUT',
      url: '/api/github/app',
      headers: { cookie },
      payload: GITHUB_APP_CFG,
    });
    expect(res1.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/github/status', headers: { cookie } });
    expect(res.json()).toEqual({ configured: true, installed: false, appSlug: null });

    await app.close();
  });

  it('reports configured and installed, with appSlug, once installationId + slug are set', async () => {
    const { app, cookie } = await buildAuthedApp();
    setSettingGithubApp(app, { ...GITHUB_APP_CFG, installationId: 999, slug: 'shipway-ab12' });

    const res = await app.inject({ method: 'GET', url: '/api/github/status', headers: { cookie } });
    expect(res.json()).toEqual({ configured: true, installed: true, appSlug: 'shipway-ab12' });

    await app.close();
  });

  it('is 401 without a session', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/github/status' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

/** Seeds the `github_app` setting directly, bypassing the PUT route (used to set up 3rd-state fixtures). */
function setSettingGithubApp(app: FastifyInstance, cfg: Record<string, unknown>): void {
  setSetting(app.db, 'github_app', cfg);
}

describe('GET /api/github/manifest', () => {
  it('returns a postUrl and a manifestJson with the expected fields', async () => {
    const { app, cookie } = await buildAuthedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/github/manifest?baseUrl=https://deploy.example.com',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { postUrl: string; manifestJson: string };
    expect(body.postUrl).toBe('https://github.com/settings/apps/new');

    const manifest = JSON.parse(body.manifestJson) as Record<string, unknown>;
    expect(manifest.name).toMatch(/^shipway-[0-9a-f]{4}$/);
    expect(manifest.url).toBe('https://deploy.example.com');
    expect(manifest.hook_attributes).toEqual({ url: 'https://deploy.example.com/api/webhooks/github' });
    expect(manifest.redirect_url).toBe('https://deploy.example.com/api/setup/github/callback');
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions).toEqual({ contents: 'read', metadata: 'read' });
    expect(manifest.default_events).toEqual(['push']);

    await app.close();
  });

  it('400s when baseUrl is missing', async () => {
    const { app, cookie } = await buildAuthedApp();
    const res = await app.inject({ method: 'GET', url: '/api/github/manifest', headers: { cookie } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('is 401 without a session', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/github/manifest?baseUrl=https://deploy.example.com' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /api/setup/github/callback', () => {
  function makeStubFetch(body: unknown, status = 200): { fetch: typeof fetch; calls: { url: string; method: string }[] } {
    const calls: { url: string; method: string }[] = [];
    const stub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ url, method: init?.method ?? 'GET' });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { fetch: stub, calls };
  }

  it('exchanges the code, stores the github_app setting, and redirects — with no session cookie required', async () => {
    const { fetch: stub, calls } = makeStubFetch({
      id: 777,
      pem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      webhook_secret: 'whsec_generated',
      slug: 'shipway-xy12',
    });
    const app = await buildTestApp(stub);

    const res = await app.inject({ method: 'GET', url: '/api/setup/github/callback?code=abc123' });

    expect(calls).toEqual([{ url: 'https://api.github.com/app-manifests/abc123/conversions', method: 'POST' }]);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/settings/github?created=1');

    const stored = getSetting<Record<string, unknown>>(app.db, 'github_app');
    expect(stored).toEqual({
      appId: 777,
      privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      webhookSecret: 'whsec_generated',
      slug: 'shipway-xy12',
    });

    await app.close();
  });

  it('400s when code is missing', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/setup/github/callback' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('502s when the exchange fails, and does not store a setting', async () => {
    const { fetch: stub } = makeStubFetch({ message: 'not found' }, 404);
    const app = await buildTestApp(stub);

    const res = await app.inject({ method: 'GET', url: '/api/setup/github/callback?code=bad' });
    expect(res.statusCode).toBe(502);
    expect(getSetting(app.db, 'github_app')).toBeNull();

    await app.close();
  });
});

describe('PUT /api/github/app', () => {
  it('stores the manual app config', async () => {
    const { app, cookie } = await buildAuthedApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/github/app',
      headers: { cookie },
      payload: GITHUB_APP_CFG,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: true, installed: false, appSlug: null });

    const stored = getSetting<Record<string, unknown>>(app.db, 'github_app');
    expect(stored).toMatchObject(GITHUB_APP_CFG);

    await app.close();
  });

  it('preserves an existing installationId and slug when re-saving manually', async () => {
    const { app, cookie } = await buildAuthedApp();
    setSettingGithubApp(app, { ...GITHUB_APP_CFG, installationId: 42, slug: 'shipway-old1' });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/github/app',
      headers: { cookie },
      payload: { appId: 999, privateKey: 'new-key', webhookSecret: 'new-secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: true, installed: true, appSlug: 'shipway-old1' });

    const stored = getSetting<{ installationId?: number; slug?: string }>(app.db, 'github_app');
    expect(stored?.installationId).toBe(42);
    expect(stored?.slug).toBe('shipway-old1');

    await app.close();
  });

  it('400s on an invalid body', async () => {
    const { app, cookie } = await buildAuthedApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/github/app',
      headers: { cookie },
      payload: { appId: 1 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('is 401 without a session', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'PUT', url: '/api/github/app', payload: GITHUB_APP_CFG });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /api/github/repos', () => {
  it('503s "not configured" when no github_app setting exists', async () => {
    const { app, cookie } = await buildAuthedApp();
    const res = await app.inject({ method: 'GET', url: '/api/github/repos', headers: { cookie } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'github app not configured' });
    await app.close();
  });

  it('503s "not installed" when github_app exists but has no installationId', async () => {
    const { app, cookie } = await buildAuthedApp();
    setSettingGithubApp(app, GITHUB_APP_CFG);

    const res = await app.inject({ method: 'GET', url: '/api/github/repos', headers: { cookie } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'github app not installed' });
    await app.close();
  });

  it('is 401 without a session', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/github/repos' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /api/github/branches', () => {
  it('503s "not configured" when no github_app setting exists', async () => {
    const { app, cookie } = await buildAuthedApp();
    const res = await app.inject({ method: 'GET', url: '/api/github/branches?repo=acme/widgets', headers: { cookie } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'github app not configured' });
    await app.close();
  });

  it('503s "not installed" when github_app exists but has no installationId', async () => {
    const { app, cookie } = await buildAuthedApp();
    setSettingGithubApp(app, GITHUB_APP_CFG);

    const res = await app.inject({ method: 'GET', url: '/api/github/branches?repo=acme/widgets', headers: { cookie } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'github app not installed' });
    await app.close();
  });

  it('400s on a malformed repo query param', async () => {
    const { app, cookie } = await buildAuthedApp();
    setSettingGithubApp(app, { ...GITHUB_APP_CFG, installationId: 1 });

    const res = await app.inject({ method: 'GET', url: '/api/github/branches?repo=not-owner-slash-repo', headers: { cookie } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('is 401 without a session', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/github/branches?repo=acme/widgets' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
