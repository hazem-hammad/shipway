import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('buildApp', () => {
  it('GET /api/health returns 200 {status: "ok"}', async () => {
    const app = await buildApp(loadConfig({ SHIPWAY_DEV: '1' }));
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
