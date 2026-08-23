import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

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
});
