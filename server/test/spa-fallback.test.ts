import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-spa-test-'));
}

/** Creates a throwaway `dist`-like directory, optionally seeded with a fixture `index.html`. */
function tmpWebDist(withIndex: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-spa-dist-'));
  if (withIndex) {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Shipway</title><div id="root"></div>');
  }
  return dir;
}

const ADMIN = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct-horse-battery' };

describe('SPA static serving', () => {
  it('serves the fixture index.html for a non-/api GET path when web/dist is present', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { webDistDir: tmpWebDist(true) });

    const res = await app.inject({ method: 'GET', url: '/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<div id="root"></div>');

    await app.close();
  });

  it('serves index.html for the root path too, not just deep client-side routes', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { webDistDir: tmpWebDist(true) });

    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="root"></div>');

    await app.close();
  });

  it('still returns a plain JSON 404 for an unknown authenticated /api path when web/dist is present', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { webDistDir: tmpWebDist(true) });

    const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
    const raw = create.headers['set-cookie'];
    const cookieHeader = Array.isArray(raw) ? raw[0] : raw;
    if (!cookieHeader || typeof cookieHeader !== 'string') {
      throw new Error('expected a set-cookie header in the response');
    }
    const cookie = cookieHeader.split(';')[0]!;

    const res = await app.inject({ method: 'GET', url: '/api/nope', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });

    await app.close();
  });

  it('404s cleanly (no crash) for a non-/api path when web/dist is absent', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { webDistDir: path.join(os.tmpdir(), 'shipway-spa-dist-does-not-exist') });

    const res = await app.inject({ method: 'GET', url: '/projects' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
