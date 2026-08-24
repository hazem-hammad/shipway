/**
 * Task 5's Home-dashboard summary: `GET /api/overview` → {user, projects, deployments,
 * servicesDown, recentProjects}. Uses `buildApp` directly (not `helpers.ts`'s `buildOwnerApp`, which
 * doesn't let a test control the injected `sysops`) so `servicesDown` can be exercised against a
 * controllable fake mirroring `servicewatch-wiring.test.ts`'s `MutableStatusSysOps`.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { deployments } from '../src/db/schema.js';
import { DevSysOps } from '../src/sysops/dev.js';
import type { SysOps, UnitStatus } from '../src/sysops/types.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-overview-test-'));
}

function sessionCookie(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') {
    throw new Error('expected a set-cookie header in the response');
  }
  return value.split(';')[0]!;
}

/** Same shape as `servicewatch-wiring.test.ts`'s double: a freely-mutable per-unit status, default
 * `'active'` (deliberately NOT `'unknown'`, so a test can assert "nothing down" independently of
 * dev mode's own default — see the dedicated dev-mode test below for that). */
class MutableStatusSysOps extends DevSysOps {
  private readonly statuses = new Map<string, UnitStatus>();

  setStatus(unit: string, status: UnitStatus): void {
    this.statuses.set(unit, status);
  }

  override async systemUnitStatus(unit: string): Promise<UnitStatus> {
    return this.statuses.get(unit) ?? 'active';
  }
}

const ADMIN = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct-horse-battery' };

async function buildOverviewTestApp(sysops?: SysOps): Promise<{ app: FastifyInstance; cookie: string }> {
  const dataDir = tmpDataDir();
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });
  const app = await buildApp(cfg, { sysops: sysops ?? new DevSysOps(path.join(dataDir, 'system')) });
  const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
  const cookie = sessionCookie(create);

  await app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: { cookie },
    payload: { base_domain: 'apps.example.com', server_ip: '203.0.113.10' },
  });

  return { app, cookie };
}

async function createProject(app: FastifyInstance, cookie: string, slug = 'app'): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie },
    payload: { name: slug, slug, repo: `acme/${slug}`, branch: 'main', type: 'static' },
  });
  return (res.json() as { id: number }).id;
}

describe('GET /api/overview', () => {
  it('returns user name, zero counts, and empty servicesDown/recentProjects with no data', async () => {
    const { app, cookie } = await buildOverviewTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: { name: 'Ada Lovelace' },
      projects: 0,
      deployments: 0,
      servicesDown: [],
      recentProjects: [],
    });

    await app.close();
  });

  it('counts projects/deployments and orders recentProjects by latest deployment then createdAt', async () => {
    const { app, cookie } = await buildOverviewTestApp();
    const idA = await createProject(app, cookie, 'alpha');
    const idB = await createProject(app, cookie, 'beta');
    await createProject(app, cookie, 'gamma'); // no deployments: falls back to createdAt ordering

    app.db.insert(deployments).values({ projectId: idA, status: 'success', trigger: 'manual', finishedAt: 100 }).run();
    app.db.insert(deployments).values({ projectId: idB, status: 'failed', trigger: 'manual', finishedAt: 200 }).run();

    const res = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });
    const body = res.json() as {
      projects: number;
      deployments: number;
      recentProjects: { id: number; name: string; slug: string; type: string; lastDeployment: { status: string; finishedAt: number | null } | null }[];
    };
    expect(body.projects).toBe(3);
    expect(body.deployments).toBe(2);
    expect(body.recentProjects).toHaveLength(3);
    // beta's deployment was inserted after alpha's (higher id -> more recent) -> beta first
    expect(body.recentProjects[0]).toMatchObject({ slug: 'beta', lastDeployment: { status: 'failed', finishedAt: 200 } });
    expect(body.recentProjects[1]).toMatchObject({ slug: 'alpha', lastDeployment: { status: 'success', finishedAt: 100 } });
    expect(body.recentProjects[2]).toMatchObject({ slug: 'gamma', lastDeployment: null });

    await app.close();
  });

  it('caps recentProjects at 5', async () => {
    const { app, cookie } = await buildOverviewTestApp();
    for (let i = 0; i < 7; i += 1) {
      await createProject(app, cookie, `p${String(i)}`);
    }

    const res = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });
    expect((res.json() as { recentProjects: unknown[] }).recentProjects).toHaveLength(5);

    await app.close();
  });

  it('servicesDown lists the live failed/inactive SYSTEM_UNITS by display name', async () => {
    const sysops = new MutableStatusSysOps(tmpDataDir());
    const { app, cookie } = await buildOverviewTestApp(sysops);

    const activeRes = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });
    expect((activeRes.json() as { servicesDown: string[] }).servicesDown).toEqual([]);

    sysops.setStatus('nginx', 'failed');
    sysops.setStatus('redis-server', 'inactive');

    const res = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });
    const body = res.json() as { servicesDown: string[] };
    expect(body.servicesDown).toEqual(expect.arrayContaining(['Nginx', 'Redis']));
    expect(body.servicesDown).toHaveLength(2);

    await app.close();
  });

  it("dev mode's default DevSysOps (every unit 'unknown') yields an empty servicesDown", async () => {
    const dataDir = tmpDataDir();
    const { app, cookie } = await buildOverviewTestApp(new DevSysOps(dataDir));

    const res = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });
    expect((res.json() as { servicesDown: string[] }).servicesDown).toEqual([]);

    await app.close();
  });

  it('unauthenticated requests are 401', async () => {
    const { app } = await buildOverviewTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/overview' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
