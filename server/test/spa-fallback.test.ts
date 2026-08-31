import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-spa-test-'));
}

/**
 * Creates a throwaway `dist`-like directory, optionally seeded with a fixture `index.html` and a
 * fingerprinted asset under `assets/` — the two files whose caching must differ, so a test can
 * assert on both.
 */
function tmpWebDist(withIndex: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-spa-dist-'));
  if (withIndex) {
    // Carries the %OG_ORIGIN% placeholder the real shell uses, so the substitution is exercised.
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<!doctype html><title>Shipway</title><meta property="og:image" content="%OG_ORIGIN%/og.png" /><div id="root"></div>',
    );
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
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

  /**
   * The caching contract, pinned because getting it wrong is invisible from the server side and
   * shows up only as "my deploy didn't do anything": a browser holding `index.html` keeps loading
   * the bundle that file named, however many times the real one is replaced.
   */
  it('serves index.html as no-cache, on both the root and a deep route', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { webDistDir: tmpWebDist(true) });

    for (const url of ['/', '/projects']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['cache-control'], `cache-control for ${url}`).toContain('no-cache');
      // `no-cache` means revalidate, not "don't store" — the ETag is what makes that revalidation
      // a cheap 304 when nothing has shipped.
      expect(res.headers.etag).toBeDefined();
    }

    await app.close();
  });

  it('serves a fingerprinted asset as immutable, since a new build is a new filename', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { webDistDir: tmpWebDist(true) });

    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['cache-control']).not.toContain('no-cache');

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

describe('SPA shell — Open Graph origin', () => {
  const dist = () => tmpWebDist(true);

  it('rewrites the placeholder to this install\'s own absolute origin', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { webDistDir: dist() });

    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'ship.example.com' } });

    // Absolute, not relative: WhatsApp and Facebook won't resolve a relative og:image.
    expect(res.body).toContain('content="http://ship.example.com/og.png"');
    expect(res.body).not.toContain('%OG_ORIGIN%');

    await app.close();
  });

  it('never reflects a Host header that isn\'t a plain hostname', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { webDistDir: dist() });

    // The Host header is client-controlled and lands inside an HTML attribute, so a crafted one
    // must not be able to close that attribute and inject markup.
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.com"><script>alert(1)</script><x y="' } });

    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).not.toContain('evil.com');
    // Falls back to a working relative URL rather than a broken or dangerous absolute one.
    expect(res.body).toContain('content="/og.png"');

    await app.close();
  });

  it('still answers 304 for an unchanged shell, and varies the etag by origin', async () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
    const app = await buildApp(cfg, { webDistDir: dist() });

    const first = await app.inject({ method: 'GET', url: '/', headers: { host: 'a.example.com' } });
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    const repeat = await app.inject({ method: 'GET', url: '/', headers: { host: 'a.example.com', 'if-none-match': etag } });
    expect(repeat.statusCode).toBe(304);

    // Same file, different origin — the body genuinely differs, so the etag must too.
    const other = await app.inject({ method: 'GET', url: '/', headers: { host: 'b.example.com', 'if-none-match': etag } });
    expect(other.statusCode).toBe(200);
    expect(other.body).toContain('content="http://b.example.com/og.png"');

    await app.close();
  });
});
