import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { getSetting, setSetting } from '../src/db/settings.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-users-settings-test-'));
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

/** Builds an app, creates the first admin, and returns the app plus a ready-to-use session cookie. */
async function buildAuthedApp(): Promise<{ app: FastifyInstance; cookie: string; adminId: number }> {
  const app = await buildTestApp();
  const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
  const cookie = sessionCookie(create);
  const adminId = create.json().id as number;
  return { app, cookie, adminId };
}

describe('users API', () => {
  it('GET /api/users lists the first admin', async () => {
    const { app, cookie, adminId } = await buildAuthedApp();

    const res = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: adminId, name: ADMIN.name, email: ADMIN.email });
    expect(body[0].passwordHash).toBeUndefined();

    await app.close();
  });

  it('POST /api/users creates a new user with a hashed password, usable to log in', async () => {
    const { app, cookie } = await buildAuthedApp();

    const newUser = { name: 'Grace Hopper', email: 'grace@example.com', password: 'admiral-password' };
    const res = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: newUser });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ name: newUser.name, email: newUser.email });
    expect(typeof body.id).toBe('number');
    expect(body.passwordHash).toBeUndefined();

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: newUser.email, password: newUser.password },
    });
    expect(login.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie } });
    expect(list.json()).toHaveLength(2);

    await app.close();
  });

  it('POST /api/users rejects a password shorter than 8 characters', async () => {
    const { app, cookie } = await buildAuthedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: { name: 'Short Pass', email: 'short@example.com', password: 'short' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('POST /api/users rejects a duplicate email', async () => {
    const { app, cookie } = await buildAuthedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: { name: 'Duplicate Ada', email: ADMIN.email, password: 'another-password' },
    });
    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it('DELETE /api/users/:id removes another user', async () => {
    const { app, cookie } = await buildAuthedApp();

    const create = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: { name: 'Grace Hopper', email: 'grace@example.com', password: 'admiral-password' },
    });
    const otherId = create.json().id as number;

    const del = await app.inject({ method: 'DELETE', url: `/api/users/${otherId}`, headers: { cookie } });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie } });
    expect(list.json()).toHaveLength(1);

    await app.close();
  });

  it('DELETE /api/users/:id returns 403 when deleting your own account', async () => {
    const { app, cookie, adminId } = await buildAuthedApp();

    const res = await app.inject({ method: 'DELETE', url: `/api/users/${adminId}`, headers: { cookie } });
    expect(res.statusCode).toBe(403);

    const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie } });
    expect(list.json()).toHaveLength(1);

    await app.close();
  });

  it('DELETE /api/users/:id returns 404 for an unknown id', async () => {
    const { app, cookie } = await buildAuthedApp();

    const res = await app.inject({ method: 'DELETE', url: '/api/users/999999', headers: { cookie } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe('settings API', () => {
  it('GET /api/settings returns null for every unset key, plus github_app.configured: false', async () => {
    const { app, cookie } = await buildAuthedApp();

    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      base_domain: null,
      server_ip: null,
      acme_email: null,
      cloudflare_token: null,
      cloudflare_zone_id: null,
      notify_webhook_url: null,
      notify_on_success: null,
      github_app: { configured: false },
    });

    await app.close();
  });

  it('PUT /api/settings stores a partial update without clobbering other keys across calls', async () => {
    const { app, cookie } = await buildAuthedApp();

    const first = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { base_domain: 'apps.example.com', server_ip: '203.0.113.10' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ base_domain: 'apps.example.com', server_ip: '203.0.113.10' });

    const second = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { acme_email: 'ops@example.com' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      base_domain: 'apps.example.com',
      server_ip: '203.0.113.10',
      acme_email: 'ops@example.com',
    });

    await app.close();
  });

  it('PUT /api/settings stores notify_on_success as a boolean and round-trips it', async () => {
    const { app, cookie } = await buildAuthedApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { notify_on_success: true, notify_webhook_url: 'https://example.com/hook' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ notify_on_success: true, notify_webhook_url: 'https://example.com/hook' });

    await app.close();
  });

  it('GET /api/settings masks cloudflare_token as "•••" + last 4 chars', async () => {
    const { app, cookie } = await buildAuthedApp();

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { cloudflare_token: 'super-secret-cf-token-1234' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(res.json().cloudflare_token).toBe('•••1234');

    await app.close();
  });

  it('PUT /api/settings ignores a masked cloudflare_token value instead of overwriting the real one', async () => {
    const { app, cookie } = await buildAuthedApp();

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { cloudflare_token: 'super-secret-cf-token-1234' },
    });

    // Simulate the frontend sending back the masked value it received from GET, alongside an
    // unrelated real change.
    const roundTrip = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { cloudflare_token: '•••1234', cloudflare_zone_id: 'zone-abc' },
    });
    expect(roundTrip.statusCode).toBe(200);
    expect(roundTrip.json()).toMatchObject({ cloudflare_token: '•••1234', cloudflare_zone_id: 'zone-abc' });

    // The underlying stored secret must be untouched by the masked round-trip.
    expect(getSetting<string>(app.db, 'cloudflare_token')).toBe('super-secret-cf-token-1234');

    await app.close();
  });

  it('GET /api/settings reports github_app.configured: true once a github_app setting exists', async () => {
    const { app, cookie } = await buildAuthedApp();

    setSetting(app.db, 'github_app', { id: 1, slug: 'shipway-bot', privateKey: 'pem', installationId: 2 });

    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(res.json().github_app).toEqual({ configured: true });

    await app.close();
  });

  it('PUT /api/settings 400s on an invalid body (bad acme_email)', async () => {
    const { app, cookie } = await buildAuthedApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { acme_email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('unauthenticated requests to /api/users and /api/settings are 401', async () => {
    const app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });

    const usersRes = await app.inject({ method: 'GET', url: '/api/users' });
    expect(usersRes.statusCode).toBe(401);

    const settingsRes = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(settingsRes.statusCode).toBe(401);

    await app.close();
  });
});
