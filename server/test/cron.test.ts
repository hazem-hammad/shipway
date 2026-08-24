import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { cronJobs, projects } from '../src/db/schema.js';
import { loadConfig, type Config } from '../src/config.js';
import { DevSysOps } from '../src/sysops/dev.js';
import { syncCrontab, validateCronExpr } from '../src/services/cron.js';

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-cron-test-'));
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

interface InsertProjectInput {
  slug: string;
  type: 'php' | 'node' | 'nextjs' | 'static';
  phpVersion?: string | null;
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
      sharedPaths: [],
      autoDeploy: true,
      smtpMode: 'mailpit',
    })
    .run();
  const row = db.select().from(projects).where(eq(projects.slug, input.slug)).get();
  if (!row) throw new Error('failed to insert test project');
  return row;
}

interface CronRowInput {
  projectId: number;
  schedule: string;
  command: string;
}

function insertCron(db: ShipwayDb, input: CronRowInput): typeof cronJobs.$inferSelect {
  const inserted = db.insert(cronJobs).values(input).run();
  const id = Number(inserted.lastInsertRowid);
  const row = db.select().from(cronJobs).where(eq(cronJobs.id, id)).get();
  if (!row) throw new Error('failed to insert test cron job');
  return row;
}

// ---------------------------------------------------------------------------
// validateCronExpr
// ---------------------------------------------------------------------------

describe('validateCronExpr', () => {
  it.each([
    '* * * * *',
    '*/5 * * * *',
    '0 3 * * 1-5',
    '1,15,30 0-12/2 * * *',
    '@daily',
    '@hourly',
    '@weekly',
    '@monthly',
    '@yearly',
    '@annually',
    '@reboot',
    '59 23 31 12 7',
    '0 0 1 1 0',
  ])('accepts %s', (expr) => {
    expect(validateCronExpr(expr)).toBe(true);
  });

  it.each([
    '60 * * * *', // minute out of range
    '* * * *', // 4 fields
    '* * * * * *', // 6 fields
    '*/0 * * * *', // step 0 invalid
    'a * * * *', // non-numeric
    '@fortnightly', // unknown alias
    '', // empty
    '* 24 * * *', // hour out of range
    '* * 0 * *', // day-of-month out of range (min 1)
    '* * 32 * *', // day-of-month out of range (max 31)
    '* * * 0 *', // month out of range (min 1)
    '* * * 13 *', // month out of range (max 12)
    '* * * * 8', // day-of-week out of range (max 7)
    '5-1 * * * *', // inverted range
  ])('rejects %s', (expr) => {
    expect(validateCronExpr(expr)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// syncCrontab
// ---------------------------------------------------------------------------

describe('syncCrontab', () => {
  it('writes a managed block with entries from 2 projects, preserving a pre-existing user line', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    await sysops.writeCrontab('0 0 * * * /usr/bin/some-other-tool\n');

    const blog = insertProject(db, { slug: 'blog', type: 'php', phpVersion: '8.3' });
    const shop = insertProject(db, { slug: 'shop', type: 'node' });
    const cronBlog = insertCron(db, { projectId: blog.id, schedule: '* * * * *', command: 'php8.3 artisan schedule:run' });
    const cronShop = insertCron(db, { projectId: shop.id, schedule: '0 3 * * *', command: 'node backup.js' });

    await syncCrontab({ db, sysops, cfg });

    const written = await sysops.readCrontab();
    expect(written).toContain('0 0 * * * /usr/bin/some-other-tool');
    expect(written).toContain('# >>> shipway managed >>>');
    expect(written).toContain('# <<< shipway managed <<<');
    expect(written).toContain(
      `* * * * * cd ${cfg.appsDir}/blog/current && php8.3 artisan schedule:run >> ${cfg.logsDir}/blog/cron-${String(cronBlog.id)}.log 2>&1`,
    );
    expect(written).toContain(
      `0 3 * * * cd ${cfg.appsDir}/shop/current && node backup.js >> ${cfg.logsDir}/shop/cron-${String(cronShop.id)}.log 2>&1`,
    );
  });

  it('writes an empty managed block (no markers) when there are no cron jobs', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const sysops = new DevSysOps(sysopsRoot(cfg));
    await sysops.writeCrontab('0 0 * * * /usr/bin/some-other-tool\n');

    await syncCrontab({ db, sysops, cfg });

    const written = await sysops.readCrontab();
    expect(written).toContain('0 0 * * * /usr/bin/some-other-tool');
    expect(written).not.toContain('shipway managed');
  });

  it('re-syncing replaces the previous managed block rather than duplicating it', async () => {
    const cfg = makeCfg();
    const db = makeDb(cfg);
    const sysops = new DevSysOps(sysopsRoot(cfg));

    const blog = insertProject(db, { slug: 'blog', type: 'static' });
    insertCron(db, { projectId: blog.id, schedule: '* * * * *', command: 'true' });
    await syncCrontab({ db, sysops, cfg });

    insertCron(db, { projectId: blog.id, schedule: '0 3 * * *', command: 'false' });
    await syncCrontab({ db, sysops, cfg });

    const written = await sysops.readCrontab();
    expect(written.match(/shipway managed >>>/g)).toHaveLength(1);
    expect(written).toContain('true');
    expect(written).toContain('false');
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

async function buildCronTestApp(makeSysOpsOverride?: (root: string) => DevSysOps): Promise<TestApp> {
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
  phpVersion?: string | null;
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
      phpVersion: type === 'php' ? (overrides.phpVersion ?? '8.3') : null,
      nodeVersion: type === 'node' || type === 'nextjs' ? '22' : null,
    })
    .run();
  const row = app.db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get();
  if (!row) throw new Error('failed to insert test project');
  return row.id;
}

class ThrowingWriteSysOps extends DevSysOps {
  override async writeCrontab(): Promise<void> {
    throw new Error('crontab write failed (test double)');
  }
}

describe('POST /api/projects/:id/cron', () => {
  it('creates the row, syncs the crontab, and returns it (201)', async () => {
    const { app, cookie, sysops } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'static' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '* * * * *', command: 'true' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ projectId, schedule: '* * * * *', command: 'true' });
    expect(typeof body.id).toBe('number');

    const row = app.db.select().from(cronJobs).where(eq(cronJobs.id, body.id)).get();
    expect(row).toBeDefined();

    const written = await sysops.readCrontab();
    expect(written).toContain('shipway managed');
    expect(written).toContain('true');

    await app.close();
  });

  it('rewrites a leading `php ` command using the project phpVersion for php projects', async () => {
    const { app, cookie } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'php', phpVersion: '8.2' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '* * * * *', command: 'php artisan schedule:run' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().command).toBe('php8.2 artisan schedule:run');

    const row = app.db.select().from(cronJobs).where(eq(cronJobs.id, res.json().id)).get();
    expect(row?.command).toBe('php8.2 artisan schedule:run');

    await app.close();
  });

  it('leaves a non-php project command untouched', async () => {
    const { app, cookie } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'api', type: 'node' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '* * * * *', command: 'php artisan schedule:run' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().command).toBe('php artisan schedule:run');

    await app.close();
  });

  it('leaves a php command untouched when it does not start with exactly `php `', async () => {
    const { app, cookie } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'php', phpVersion: '8.2' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '* * * * *', command: 'phpunit --version' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().command).toBe('phpunit --version');

    await app.close();
  });

  it('404s for an unknown project id', async () => {
    const { app, cookie } = await buildCronTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/999999/cron',
      headers: { cookie },
      payload: { schedule: '* * * * *', command: 'true' },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects an invalid cron expression with 400 and does not create a row', async () => {
    const { app, cookie } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'static' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '60 * * * *', command: 'true' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid cron expression');
    expect(app.db.select().from(cronJobs).all()).toEqual([]);

    await app.close();
  });

  it.each([{ command: '' }, { command: 'a\nb' }])('rejects an invalid command with 400 (%j)', async (payload) => {
    const { app, cookie } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'static' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '* * * * *', command: payload.command },
    });

    expect(res.statusCode).toBe(400);
    expect(app.db.select().from(cronJobs).all()).toEqual([]);

    await app.close();
  });

  it('returns 502 and deletes the row when syncCrontab fails', async () => {
    const { app, cookie } = await buildCronTestApp((root) => new ThrowingWriteSysOps(root));
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'static' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '* * * * *', command: 'true' },
    });

    expect(res.statusCode).toBe(502);
    expect(app.db.select().from(cronJobs).all()).toEqual([]);

    await app.close();
  });

  it('unauthenticated requests are 401', async () => {
    const { app } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'static' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      payload: { schedule: '* * * * *', command: 'true' },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /api/projects/:id/cron', () => {
  it('lists cron jobs for the project', async () => {
    const { app, cookie } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'static' });
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '* * * * *', command: 'true' },
    });

    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/cron`, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ projectId, schedule: '* * * * *', command: 'true' });

    await app.close();
  });

  it('404s for an unknown project id', async () => {
    const { app, cookie } = await buildCronTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/projects/999999/cron', headers: { cookie } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('PATCH /api/cron/:id', () => {
  it('updates the row, re-syncs the crontab, and returns it (200)', async () => {
    const { app, cookie, sysops } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'static' });
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '* * * * *', command: 'true' },
    });
    const { id } = create.json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/cron/${id}`,
      headers: { cookie },
      payload: { schedule: '0 3 * * *', command: 'false' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, schedule: '0 3 * * *', command: 'false' });

    const written = await sysops.readCrontab();
    expect(written).toContain('0 3 * * *');
    expect(written).toContain('false');

    await app.close();
  });

  it('rewrites the php command on PATCH', async () => {
    const { app, cookie } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'php', phpVersion: '8.1' });
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '* * * * *', command: 'true' },
    });
    const { id } = create.json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/cron/${id}`,
      headers: { cookie },
      payload: { command: 'php artisan schedule:run' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().command).toBe('php8.1 artisan schedule:run');

    await app.close();
  });

  it('404s for an unknown cron job id', async () => {
    const { app, cookie } = await buildCronTestApp();

    const res = await app.inject({ method: 'PATCH', url: '/api/cron/999999', headers: { cookie }, payload: { schedule: '* * * * *' } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects an invalid cron expression with 400', async () => {
    const { app, cookie } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'static' });
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '* * * * *', command: 'true' },
    });
    const { id } = create.json();

    const res = await app.inject({ method: 'PATCH', url: `/api/cron/${id}`, headers: { cookie }, payload: { schedule: '60 * * * *' } });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('restores the previous row values and returns 502 when syncCrontab fails', async () => {
    const { app, cookie } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'static' });
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '* * * * *', command: 'true' },
    });
    const { id } = create.json();

    // Swap in a sysops double whose writeCrontab throws, AFTER the create succeeded above (so the
    // initial insert's own sync used the working DevSysOps).
    (app.sysops as DevSysOps).writeCrontab = async () => {
      throw new Error('crontab write failed (test double)');
    };

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/cron/${id}`,
      headers: { cookie },
      payload: { schedule: '0 3 * * *', command: 'false' },
    });

    expect(res.statusCode).toBe(502);
    const row = app.db.select().from(cronJobs).where(eq(cronJobs.id, id)).get();
    expect(row).toMatchObject({ schedule: '* * * * *', command: 'true' });

    await app.close();
  });
});

describe('DELETE /api/cron/:id', () => {
  it('deletes the row, syncs the crontab, and returns 204', async () => {
    const { app, cookie, sysops } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'static' });
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '* * * * *', command: 'true' },
    });
    const { id } = create.json();

    const res = await app.inject({ method: 'DELETE', url: `/api/cron/${id}`, headers: { cookie } });

    expect(res.statusCode).toBe(204);
    expect(app.db.select().from(cronJobs).where(eq(cronJobs.id, id)).get()).toBeUndefined();

    const written = await sysops.readCrontab();
    expect(written).not.toContain('true');

    await app.close();
  });

  it('404s for an unknown cron job id', async () => {
    const { app, cookie } = await buildCronTestApp();

    const res = await app.inject({ method: 'DELETE', url: '/api/cron/999999', headers: { cookie } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 502 but keeps the row deleted when syncCrontab fails', async () => {
    const { app, cookie } = await buildCronTestApp();
    const projectId = insertRouteProject(app, { slug: 'blog', type: 'static' });
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/cron`,
      headers: { cookie },
      payload: { schedule: '* * * * *', command: 'true' },
    });
    const { id } = create.json();

    (app.sysops as DevSysOps).writeCrontab = async () => {
      throw new Error('crontab write failed (test double)');
    };

    const res = await app.inject({ method: 'DELETE', url: `/api/cron/${id}`, headers: { cookie } });

    expect(res.statusCode).toBe(502);
    expect(app.db.select().from(cronJobs).where(eq(cronJobs.id, id)).get()).toBeUndefined();

    await app.close();
  });
});
