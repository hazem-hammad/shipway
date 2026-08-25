import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { setSetting } from '../src/db/settings.js';

// buildApp now opens a real (file-backed) db and generates a session key file, so point dataDir at
// a throwaway temp dir rather than the repo-relative `./data` default.
function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-app-test-'));
}

describe('buildApp', () => {
  it('GET /api/health returns 200 {status: "ok"}', async () => {
    const app = await buildApp(loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() }));
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  describe('dev-mode dns() honesty (fix wave M1)', () => {
    it('returns null (attempted: false, same as production unconfigured) when no Cloudflare credentials are set, even in dev mode', async () => {
      const app = await buildApp(loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() }));

      // No cloudflare_token/cloudflare_zone_id set at all — the Domain card's badge would read
      // "Cloudflare not configured"/"error", so a caller receiving a non-null client here (and then
      // creating a record from it) would be the exact contradiction M1 flagged: a card that says
      // Cloudflare isn't connected, followed by a green "DNS record created."
      expect(app.dns()).toBeNull();

      await app.close();
    });

    it('still returns the in-memory FakeDnsClient once real-looking Cloudflare credentials ARE configured', async () => {
      const app = await buildApp(loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() }));
      setSetting(app.db, 'cloudflare_token', 'a-token');
      setSetting(app.db, 'cloudflare_zone_id', 'a-zone-id');

      // Credentials configured: dev mode's offline-provisioning convenience (create/find/delete
      // fully in-memory, no real Cloudflare API call) is unchanged — only the no-credentials case
      // from the test above changed.
      const dns = app.dns();
      expect(dns).not.toBeNull();
      await expect(dns!.createARecord('demo.example.com', '203.0.113.9')).resolves.toEqual(expect.any(String));

      await app.close();
    });

    it('blank/whitespace-only credentials are treated the same as unset (returns null)', async () => {
      const app = await buildApp(loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() }));
      setSetting(app.db, 'cloudflare_token', '   ');
      setSetting(app.db, 'cloudflare_zone_id', '');

      expect(app.dns()).toBeNull();

      await app.close();
    });
  });
});
