import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { projects, workers } from '../src/db/schema.js';
import { loadConfig, type Config } from '../src/config.js';
import { DevSysOps } from '../src/sysops/dev.js';
import { nodeBinDir } from '../src/services/provisioner.js';
import { applyWorker, removeWorker, workerInstances } from '../src/services/workers.js';

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-workers-test-'));
}

function makeCfg(): Config {
  return loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
}

function makeDb(cfg: Config): ShipwayDb {
  return openDb(cfg.dbPath);
}

/** The dir DevSysOps sandboxes everything under, in dev mode — matches sysops/index.ts's makeSysOps. */
function sysopsRoot(cfg: Config): string {
  return path.join(cfg.dataDir, 'system');
}

/** Strips the "(N bytes)" suffix DevSysOps appends to installFile call records, so tests can assert
 * on call shape/order without pinning exact rendered byte lengths. */
function callNames(sysops: DevSysOps): string[] {
  return sysops.calls.map((c) => c.replace(/ \(\d+ bytes\)$/, ''));
}

interface InsertProjectInput {
  slug: string;
  type: 'php' | 'node' | 'nextjs' | 'static';
  phpVersion?: string | null;
  nodeVersion?: string | null;
}

function insertProject(db: ShipwayDb, input: InsertProjectInput): typeof projects.$inferSelect {
  db.insert(projects)
    .values({
      name: input.slug,
      slug: input.slug,
      repo: `acme/${input.slug}`,
      branch: 'main',
      type: input.type,
      phpVersion: input.phpVersion ?? null,
      nodeVersion: input.nodeVersion ?? null,
      sharedPaths: [],
      autoDeploy: true,
      smtpMode: 'mailpit',
    })
    .run();
  const row = db.select().from(projects).where(eq(projects.slug, input.slug)).get();
  if (!row) throw new Error('failed to insert test project');
  return row;
}

interface WorkerRowInput {
  projectId: number;
  name: string;
  command: string;
  processes: number;
}

function makeWorkerRow(input: WorkerRowInput): typeof workers.$inferSelect {
  return { id: 1, projectId: input.projectId, name: input.name, command: input.command, processes: input.processes, statusCached: null };
}

function unitFilePath(dest: string): string {
  return dest; // installFile's dest is already the absolute /etc/systemd/system/... path
}

function readInstalledUnit(cfg: Config, dest: string): string {
  return fs.readFileSync(path.join(sysopsRoot(cfg), unitFilePath(dest)), 'utf8');
}

// ---------------------------------------------------------------------------
// workerInstances
// ---------------------------------------------------------------------------

describe('workerInstances', () => {
  it('builds instance unit names @1..@processes', () => {
    expect(workerInstances('shop', 'mailer', 3)).toEqual([
      'shipway-worker-shop-mailer@1.service',
      'shipway-worker-shop-mailer@2.service',
      'shipway-worker-shop-mailer@3.service',
    ]);
  });

  it('returns an empty array for processes = 0', () => {
    expect(workerInstances('shop', 'mailer', 0)).toEqual([]);
  });

  it('validates slug/name the same way unitNames.worker does', () => {
    expect(() => workerInstances('UPPER', 'mailer', 1)).toThrow();
    expect(() => workerInstances('shop', 'UPPER', 1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// applyWorker
// ---------------------------------------------------------------------------

describe('applyWorker', () => {
  it('installs the template unit with the rendered command, daemon-reloads, then enables+starts each instance in order', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const project = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3' });
    const worker = makeWorkerRow({ projectId: project.id, name: 'mailer', command: 'php artisan queue:work', processes: 2 });

    await applyWorker({ sysops, cfg }, project, worker);

    const unitDest = '/etc/systemd/system/shipway-worker-shop-mailer@.service';
    const content = readInstalledUnit(cfg, unitDest);
    expect(content).toContain('php artisan queue:work');
    expect(content).toContain('PATH=/usr/bin:$PATH');

    expect(callNames(sysops)).toEqual([
      `installFile ${unitDest}`,
      'daemonReload',
      'unitAction enable shipway-worker-shop-mailer@1.service',
      'unitAction start shipway-worker-shop-mailer@1.service',
      'unitAction enable shipway-worker-shop-mailer@2.service',
      'unitAction start shipway-worker-shop-mailer@2.service',
    ]);
  });

  it('uses nodeBinDir as the PATH prefix for node/nextjs projects', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const project = insertProject(db, { slug: 'api', type: 'node', nodeVersion: '22' });
    const worker = makeWorkerRow({ projectId: project.id, name: 'consumer', command: 'node worker.js', processes: 1 });

    await applyWorker({ sysops, cfg }, project, worker);

    const content = readInstalledUnit(cfg, '/etc/systemd/system/shipway-worker-api-consumer@.service');
    expect(content).toContain(`PATH=${nodeBinDir(cfg, '22')}:$PATH`);
  });

  it('scaling down (previousProcesses > processes) stops+disables the now-removed instances', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const project = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3' });
    const worker = makeWorkerRow({ projectId: project.id, name: 'mailer', command: 'php artisan queue:work', processes: 1 });

    await applyWorker({ sysops, cfg }, project, worker, 3);

    expect(callNames(sysops)).toEqual([
      'installFile /etc/systemd/system/shipway-worker-shop-mailer@.service',
      'daemonReload',
      'unitAction enable shipway-worker-shop-mailer@1.service',
      'unitAction start shipway-worker-shop-mailer@1.service',
      'unitAction stop shipway-worker-shop-mailer@2.service',
      'unitAction disable shipway-worker-shop-mailer@2.service',
      'unitAction stop shipway-worker-shop-mailer@3.service',
      'unitAction disable shipway-worker-shop-mailer@3.service',
    ]);
  });

  it('does not stop/disable anything when previousProcesses <= processes', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const project = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3' });
    const worker = makeWorkerRow({ projectId: project.id, name: 'mailer', command: 'php artisan queue:work', processes: 2 });

    await applyWorker({ sysops, cfg }, project, worker, 2);

    expect(callNames(sysops).some((c) => c.includes('stop') || c.includes('disable'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeWorker
// ---------------------------------------------------------------------------

describe('removeWorker', () => {
  it('stops+disables every instance, removes the unit file, and daemon-reloads', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    const project = insertProject(db, { slug: 'shop', type: 'php', phpVersion: '8.3' });
    const worker = makeWorkerRow({ projectId: project.id, name: 'mailer', command: 'php artisan queue:work', processes: 2 });
    await applyWorker({ sysops, cfg }, project, worker);
    sysops.calls.length = 0;

    await removeWorker({ sysops, cfg }, project, worker);

    expect(callNames(sysops)).toEqual([
      'unitAction stop shipway-worker-shop-mailer@1.service',
      'unitAction disable shipway-worker-shop-mailer@1.service',
      'unitAction stop shipway-worker-shop-mailer@2.service',
      'unitAction disable shipway-worker-shop-mailer@2.service',
      'removeFile /etc/systemd/system/shipway-worker-shop-mailer@.service',
      'daemonReload',
    ]);
    expect(fs.existsSync(path.join(sysopsRoot(cfg), '/etc/systemd/system/shipway-worker-shop-mailer@.service'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

function sessionCookie(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') {
    throw new Error('expected a set-cookie header in the response');
  }
  return value.split(';')[0]!;
}

const ADMIN = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct-horse-battery' };

interface TestApp {
  app: FastifyInstance;
  cookie: string;
  sysops: DevSysOps;
}

async function buildWorkersTestApp(makeSysOpsOverride?: (root: string) => DevSysOps): Promise<TestApp> {
  const cfg = makeCfg();
  const sysops = makeSysOpsOverride ? makeSysOpsOverride(sysopsRoot(cfg)) : new DevSysOps(sysopsRoot(cfg));
  const app = await buildApp(cfg, { sysops });

  const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
  const cookie = sessionCookie(create);

  return { app, cookie, sysops };
}

interface InsertRouteProjectInput {
  slug?: string;
  type?: 'php' | 'node' | 'nextjs' | 'static';
}

/** Inserts a project row directly (skipping the full provisioning pipeline — irrelevant here). */
function insertRouteProject(app: FastifyInstance, overrides: InsertRouteProjectInput = {}): number {
  const slug = overrides.slug ?? 'shop';
  const type = overrides.type ?? 'php';
  app.db
    .insert(projects)
    .values({
      name: slug,
      slug,
      repo: `acme/${slug}`,
      branch: 'main',
      type,
      phpVersion: type === 'php' ? '8.3' : null,
      nodeVersion: type === 'node' || type === 'nextjs' ? '22' : null,
    })
    .run();
  const row = app.db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get();
  if (!row) throw new Error('failed to insert test project');
  return row.id;
}

describe('POST /api/projects/:id/workers', () => {
  it('creates the worker row, applies it (installs unit + starts instances), and returns it (201)', async () => {
    const { app, cookie, sysops } = await buildWorkersTestApp();
    const projectId = insertRouteProject(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workers`,
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work', processes: 2 },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ projectId, name: 'mailer', command: 'php artisan queue:work', processes: 2 });
    expect(typeof body.id).toBe('number');

    const row = app.db.select().from(workers).where(eq(workers.id, body.id)).get();
    expect(row).toBeDefined();

    expect(sysops.calls).toContain('unitAction enable shipway-worker-shop-mailer@1.service');
    expect(sysops.calls).toContain('unitAction start shipway-worker-shop-mailer@2.service');

    await app.close();
  });

  it('404s for an unknown project id', async () => {
    const { app, cookie } = await buildWorkersTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/999999/workers',
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work', processes: 1 },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it.each([
    { name: 'Mailer', command: 'x', processes: 1 }, // uppercase
    { name: '-mailer', command: 'x', processes: 1 }, // leading hyphen
    { name: '', command: 'x', processes: 1 }, // empty
  ])('rejects an invalid name with 400 (%j)', async (payload) => {
    const { app, cookie, sysops } = await buildWorkersTestApp();
    const projectId = insertRouteProject(app);

    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/workers`, headers: { cookie }, payload });

    expect(res.statusCode).toBe(400);
    expect(sysops.calls).toEqual([]);
    await app.close();
  });

  it.each([
    { name: 'mailer', command: '', processes: 1 }, // empty command
    { name: 'mailer', command: 'a\nb', processes: 1 }, // newline
  ])('rejects an invalid command with 400 (%j)', async (payload) => {
    const { app, cookie, sysops } = await buildWorkersTestApp();
    const projectId = insertRouteProject(app);

    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/workers`, headers: { cookie }, payload });

    expect(res.statusCode).toBe(400);
    expect(sysops.calls).toEqual([]);
    await app.close();
  });

  it.each([
    { name: 'mailer', command: 'x', processes: 0 },
    { name: 'mailer', command: 'x', processes: 9 },
    { name: 'mailer', command: 'x', processes: 1.5 },
  ])('rejects an invalid processes count with 400 (%j)', async (payload) => {
    const { app, cookie, sysops } = await buildWorkersTestApp();
    const projectId = insertRouteProject(app);

    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/workers`, headers: { cookie }, payload });

    expect(res.statusCode).toBe(400);
    expect(sysops.calls).toEqual([]);
    await app.close();
  });

  it('rejects a duplicate name within the same project with 409', async () => {
    const { app, cookie } = await buildWorkersTestApp();
    const projectId = insertRouteProject(app);
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workers`,
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work', processes: 1 },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workers`,
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work --tries=3', processes: 1 },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('allows the same worker name across different projects', async () => {
    const { app, cookie } = await buildWorkersTestApp();
    const projectA = insertRouteProject(app, { slug: 'shop-a' });
    const projectB = insertRouteProject(app, { slug: 'shop-b' });
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectA}/workers`,
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work', processes: 1 },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectB}/workers`,
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work', processes: 1 },
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('unauthenticated requests are 401', async () => {
    const { app } = await buildWorkersTestApp();
    const projectId = insertRouteProject(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workers`,
      payload: { name: 'mailer', command: 'x', processes: 1 },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /api/projects/:id/workers', () => {
  it('lists workers with live per-instance status', async () => {
    const { app, cookie } = await buildWorkersTestApp();
    const projectId = insertRouteProject(app);
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workers`,
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work', processes: 2 },
    });

    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/workers`, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ name: 'mailer', command: 'php artisan queue:work', processes: 2 });
    expect(body[0].instances).toEqual([
      { unit: 'shipway-worker-shop-mailer@1.service', status: 'unknown' },
      { unit: 'shipway-worker-shop-mailer@2.service', status: 'unknown' },
    ]);

    await app.close();
  });

  it('404s for an unknown project id', async () => {
    const { app, cookie } = await buildWorkersTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/projects/999999/workers', headers: { cookie } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('PATCH /api/workers/:id', () => {
  it('updates the row and re-applies (200)', async () => {
    const { app, cookie, sysops } = await buildWorkersTestApp();
    const projectId = insertRouteProject(app);
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workers`,
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work', processes: 1 },
    });
    const { id } = create.json();
    sysops.calls.length = 0;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/workers/${id}`,
      headers: { cookie },
      payload: { command: 'php artisan queue:work --tries=5' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, command: 'php artisan queue:work --tries=5', processes: 1 });
    expect(sysops.calls).toContain('unitAction start shipway-worker-shop-mailer@1.service');

    await app.close();
  });

  it('scaling down from 3 to 1 stops+disables instances @2 and @3', async () => {
    const { app, cookie, sysops } = await buildWorkersTestApp();
    const projectId = insertRouteProject(app);
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workers`,
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work', processes: 3 },
    });
    const { id } = create.json();
    sysops.calls.length = 0;

    const res = await app.inject({ method: 'PATCH', url: `/api/workers/${id}`, headers: { cookie }, payload: { processes: 1 } });

    expect(res.statusCode).toBe(200);
    expect(sysops.calls).toContain('unitAction stop shipway-worker-shop-mailer@2.service');
    expect(sysops.calls).toContain('unitAction disable shipway-worker-shop-mailer@2.service');
    expect(sysops.calls).toContain('unitAction stop shipway-worker-shop-mailer@3.service');
    expect(sysops.calls).toContain('unitAction disable shipway-worker-shop-mailer@3.service');

    await app.close();
  });

  it('404s for an unknown worker id', async () => {
    const { app, cookie } = await buildWorkersTestApp();

    const res = await app.inject({ method: 'PATCH', url: '/api/workers/999999', headers: { cookie }, payload: { processes: 2 } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects an invalid processes count with 400', async () => {
    const { app, cookie } = await buildWorkersTestApp();
    const projectId = insertRouteProject(app);
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workers`,
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work', processes: 1 },
    });
    const { id } = create.json();

    const res = await app.inject({ method: 'PATCH', url: `/api/workers/${id}`, headers: { cookie }, payload: { processes: 0 } });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('DELETE /api/workers/:id', () => {
  it('removes the unit and deletes the row (204)', async () => {
    const { app, cookie, sysops } = await buildWorkersTestApp();
    const projectId = insertRouteProject(app);
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workers`,
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work', processes: 1 },
    });
    const { id } = create.json();
    sysops.calls.length = 0;

    const res = await app.inject({ method: 'DELETE', url: `/api/workers/${id}`, headers: { cookie } });

    expect(res.statusCode).toBe(204);
    expect(sysops.calls).toContain('unitAction stop shipway-worker-shop-mailer@1.service');
    expect(sysops.calls).toContain('removeFile /etc/systemd/system/shipway-worker-shop-mailer@.service');
    expect(app.db.select().from(workers).where(eq(workers.id, id)).get()).toBeUndefined();

    await app.close();
  });

  it('404s for an unknown worker id', async () => {
    const { app, cookie } = await buildWorkersTestApp();

    const res = await app.inject({ method: 'DELETE', url: '/api/workers/999999', headers: { cookie } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /api/workers/:id/:action', () => {
  it.each(['start', 'stop', 'restart'] as const)('%s calls unitAction on every instance (202)', async (action) => {
    const { app, cookie, sysops } = await buildWorkersTestApp();
    const projectId = insertRouteProject(app);
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workers`,
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work', processes: 2 },
    });
    const { id } = create.json();
    sysops.calls.length = 0;

    const res = await app.inject({ method: 'POST', url: `/api/workers/${id}/${action}`, headers: { cookie } });

    expect(res.statusCode).toBe(202);
    expect(sysops.calls).toEqual([
      `unitAction ${action} shipway-worker-shop-mailer@1.service`,
      `unitAction ${action} shipway-worker-shop-mailer@2.service`,
    ]);

    await app.close();
  });

  it('404s for an invalid action', async () => {
    const { app, cookie } = await buildWorkersTestApp();
    const projectId = insertRouteProject(app);
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workers`,
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work', processes: 1 },
    });
    const { id } = create.json();

    const res = await app.inject({ method: 'POST', url: `/api/workers/${id}/nuke`, headers: { cookie } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('404s for an unknown worker id', async () => {
    const { app, cookie } = await buildWorkersTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/workers/999999/restart', headers: { cookie } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /api/workers/:id/logs', () => {
  class StubJournalSysOps extends DevSysOps {
    override async journalTail(unit: string, lines: number): Promise<string> {
      this.calls.push(`journalTail ${unit} ${lines}`);
      return `log content for ${unit} (${String(lines)})`;
    }
  }

  it('returns the journalTail content for a @* glob over all instances', async () => {
    const { app, cookie, sysops } = await buildWorkersTestApp((root) => new StubJournalSysOps(root));
    const projectId = insertRouteProject(app);
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workers`,
      headers: { cookie },
      payload: { name: 'mailer', command: 'php artisan queue:work', processes: 1 },
    });
    const { id } = create.json();

    const res = await app.inject({ method: 'GET', url: `/api/workers/${id}/logs`, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ content: 'log content for shipway-worker-shop-mailer@* (200)' });
    expect(sysops.calls).toContain('journalTail shipway-worker-shop-mailer@* 200');

    await app.close();
  });

  it('404s for an unknown worker id', async () => {
    const { app, cookie } = await buildWorkersTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/workers/999999/logs', headers: { cookie } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
