import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { DnsClient } from '../src/services/cloudflare.js';

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

/** Builds an app (with the given `dns()` override), creates the first admin, and returns a ready cookie. */
async function buildAuthedApp(dns: () => DnsClient | null): Promise<{ app: FastifyInstance; cookie: string }> {
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
  const app = await buildApp(cfg, { dns });
  const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
  return { app, cookie: sessionCookie(create) };
}

const FAKE_CONFIGURED: DnsClient = {
  verifyToken: async () => true,
  createARecord: async () => 'unused',
  findARecord: async () => null,
  deleteARecord: async () => {},
};

describe('GET /api/cloudflare/verify', () => {
  it('returns {ok: true} when a configured dns client verifies the token', async () => {
    const { app, cookie } = await buildAuthedApp(() => FAKE_CONFIGURED);

    const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    await app.close();
  });

  it('returns {ok: false} when a configured dns client reports an invalid token', async () => {
    const invalid: DnsClient = { ...FAKE_CONFIGURED, verifyToken: async () => false };
    const { app, cookie } = await buildAuthedApp(() => invalid);

    const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false });

    await app.close();
  });

  it('returns {ok: false} without calling verifyToken when cloudflare is unconfigured (dns() is null)', async () => {
    const { app, cookie } = await buildAuthedApp(() => null);

    const res = await app.inject({ method: 'GET', url: '/api/cloudflare/verify', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false });

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
