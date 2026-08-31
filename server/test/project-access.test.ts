/**
 * Per-project access (`src/lib/projectaccess.ts`): the `project_access` column + `project_members`
 * grants that scope a member to specific projects, the `PUT /api/users/:id/projects` route and the
 * invite-time `projectAccess`/`projectIds` fields that set them, and the enforcement across the
 * project-scoped API — `buildApp`'s path-based guard for `/api/projects/:id/...`, plus the
 * child-resource routes (`/api/workers/:id`, `/api/cron/:id`, `/api/deployments/:id`,
 * `/api/databases/:id`) that can only check once the row is loaded.
 *
 * The invariants worth stating outright, since several tests below only make sense against them:
 *  - a denied project is always 404, never 403 (a scoped member must not be able to enumerate what
 *    they're off);
 *  - an unscoped user — an admin, or a member left at the `'all'` default — is unaffected by every
 *    one of these paths, which is what makes the upgrade a no-op for an existing instance.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { ShipwayDb } from '../src/db/index.js';
import { cronJobs, databases, deployments, projectMembers, projects, users, workers } from '../src/db/schema.js';
import { FakeDnsClient } from '../src/services/cloudflare.js';
import { pgAdminPayload } from '../src/services/pgadmin.js';
import { DevSysOps } from '../src/sysops/dev.js';
import { buildOwnerApp, createAdmin, createMember, OWNER_CREDENTIALS, sessionCookie, tmpDataDir } from './helpers.js';

function insertProject(db: ShipwayDb, slug: string): typeof projects.$inferSelect {
  db.insert(projects)
    .values({
      name: slug,
      slug,
      repo: `acme/${slug}`,
      branch: 'main',
      type: 'static',
      sharedPaths: [],
      autoDeploy: false,
      smtpMode: 'mailpit',
    })
    .run();
  const row = db.select().from(projects).where(eq(projects.slug, slug)).get();
  if (!row) throw new Error(`failed to insert test project ${slug}`);
  return row;
}

/** Scopes `userId` to `projectIds` by writing the columns directly, so a test that is exercising
 * ENFORCEMENT doesn't have to go through the route that is itself under test elsewhere. */
function scopeUser(db: ShipwayDb, userId: number, projectIds: number[]): void {
  db.update(users).set({ projectAccess: 'selected' }).where(eq(users.id, userId)).run();
  for (const projectId of projectIds) {
    db.insert(projectMembers).values({ projectId, userId }).run();
  }
}

/** An app whose provisioning side effects (nginx/systemd files, releases) all land inside a temp
 * dir, so `POST /api/projects` can actually succeed — mirrors `projects-routes.test.ts`'s fixture. */
async function buildProvisioningApp(): Promise<FastifyInstance> {
  const dataDir = tmpDataDir('shipway-project-access-');
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir, SHIPWAY_APPS_DIR: path.join(dataDir, 'apps') });
  const app = await buildApp(cfg, { sysops: new DevSysOps(path.join(dataDir, 'system')), dns: () => new FakeDnsClient() });

  const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: OWNER_CREDENTIALS });
  await app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: { cookie: sessionCookie(create) },
    payload: { base_domain: 'apps.example.com', server_ip: '203.0.113.10' },
  });
  return app;
}

async function get(app: FastifyInstance, cookie: string, url: string) {
  return app.inject({ method: 'GET', url, headers: { cookie } });
}

describe('project scope: reading', () => {
  it('GET /api/projects returns only granted projects for a scoped member, everything for everyone else', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const mine = insertProject(app.db, 'mine');
    insertProject(app.db, 'theirs');

    const { cookie: memberCookie, userId: memberId } = await createMember(app);
    const { cookie: unscopedCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);
    scopeUser(app.db, memberId, [mine.id]);

    const scoped = (await get(app, memberCookie, '/api/projects')).json() as { slug: string }[];
    expect(scoped.map((p) => p.slug)).toEqual(['mine']);

    for (const cookie of [ownerCookie, unscopedCookie, adminCookie]) {
      const all = (await get(app, cookie, '/api/projects')).json() as { slug: string }[];
      expect(all.map((p) => p.slug).sort()).toEqual(['mine', 'theirs']);
    }

    await app.close();
  });

  it('404s every /api/projects/:id route for a project the member was not granted, and serves the ones they were', async () => {
    const { app } = await buildOwnerApp();
    const mine = insertProject(app.db, 'mine');
    const theirs = insertProject(app.db, 'theirs');
    const { cookie, userId } = await createMember(app);
    scopeUser(app.db, userId, [mine.id]);

    // Every sub-resource, not just the project itself: the guard is registered by path, so this is
    // the assertion that a route nobody explicitly remembered is still covered.
    for (const suffix of ['', '/env', '/deployments', '/workers', '/cron', '/notifications']) {
      const denied = await get(app, cookie, `/api/projects/${String(theirs.id)}${suffix}`);
      expect(denied.statusCode, `GET /api/projects/:id${suffix}`).toBe(404);
      expect(denied.json()).toEqual({ error: 'project not found' });

      const allowed = await get(app, cookie, `/api/projects/${String(mine.id)}${suffix}`);
      expect(allowed.statusCode, `GET /api/projects/:id${suffix} (granted)`).toBe(200);
    }

    await app.close();
  });

  it('404s a write to a denied project too — the guard is not read-only', async () => {
    const { app } = await buildOwnerApp();
    const theirs = insertProject(app.db, 'theirs');
    const { cookie, userId } = await createMember(app);
    scopeUser(app.db, userId, []);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${String(theirs.id)}/deploy`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project not found' });

    await app.close();
  });

  it('scopes the overview counts and the global deployments list', async () => {
    const { app } = await buildOwnerApp();
    const mine = insertProject(app.db, 'mine');
    const theirs = insertProject(app.db, 'theirs');
    for (const project of [mine, theirs]) {
      app.db.insert(deployments).values({ projectId: project.id, status: 'success', trigger: 'manual' }).run();
    }

    const { cookie, userId } = await createMember(app);
    scopeUser(app.db, userId, [mine.id]);

    const overview = (await get(app, cookie, '/api/overview')).json() as {
      projects: number;
      deployments: number;
      recentProjects: { slug: string }[];
    };
    expect(overview.projects).toBe(1);
    expect(overview.deployments).toBe(1);
    expect(overview.recentProjects.map((p) => p.slug)).toEqual(['mine']);

    const list = (await get(app, cookie, '/api/deployments')).json() as { projectSlug: string }[];
    expect(list.map((row) => row.projectSlug)).toEqual(['mine']);

    await app.close();
  });
});

describe('project scope: child resources keyed by their own id', () => {
  it('404s a worker, cron job, deployment and database belonging to a denied project', async () => {
    const { app } = await buildOwnerApp();
    const theirs = insertProject(app.db, 'theirs');

    app.db.insert(workers).values({ projectId: theirs.id, name: 'queue', command: 'sleep 1' }).run();
    const worker = app.db.select().from(workers).where(eq(workers.projectId, theirs.id)).get()!;
    app.db.insert(cronJobs).values({ projectId: theirs.id, schedule: '* * * * *', command: 'echo hi' }).run();
    const cron = app.db.select().from(cronJobs).where(eq(cronJobs.projectId, theirs.id)).get()!;
    app.db.insert(deployments).values({ projectId: theirs.id, status: 'success', trigger: 'manual' }).run();
    const deployment = app.db.select().from(deployments).where(eq(deployments.projectId, theirs.id)).get()!;
    app.db
      .insert(databases)
      .values({
        projectId: theirs.id,
        engine: 'mysql',
        name: 'theirs_db',
        username: 'theirs_db',
        passwordEncrypted: app.secretBox.encrypt('secret'),
      })
      .run();
    const database = app.db.select().from(databases).where(eq(databases.projectId, theirs.id)).get()!;

    const { cookie, userId } = await createMember(app);
    scopeUser(app.db, userId, []);

    expect((await get(app, cookie, `/api/workers/${String(worker.id)}/logs`)).statusCode).toBe(404);
    expect((await get(app, cookie, `/api/deployments/${String(deployment.id)}`)).statusCode).toBe(404);
    // The log is the one that would actually leak repo contents, so it gets its own assertion.
    expect((await get(app, cookie, `/api/deployments/${String(deployment.id)}/log`)).statusCode).toBe(404);
    expect((await get(app, cookie, `/api/databases/${String(database.id)}/credentials`)).statusCode).toBe(404);

    const cronPatch = await app.inject({
      method: 'PATCH',
      url: `/api/cron/${String(cron.id)}`,
      headers: { cookie },
      payload: { command: 'echo pwned' },
    });
    expect(cronPatch.statusCode).toBe(404);

    // And the database list hides it rather than merely refusing the detail routes.
    const dbList = (await get(app, cookie, '/api/databases')).json() as unknown[];
    expect(dbList).toEqual([]);

    await app.close();
  });
});

describe('PUT /api/users/:id/projects', () => {
  it('grants, replaces and clears a member’s selection, and reports it back on GET /api/users', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const a = insertProject(app.db, 'alpha');
    const b = insertProject(app.db, 'beta');
    const { userId } = await createMember(app);

    async function setAccess(payload: { projectAccess: 'all' | 'selected'; projectIds?: number[] }) {
      return app.inject({ method: 'PUT', url: `/api/users/${String(userId)}/projects`, headers: { cookie: ownerCookie }, payload });
    }

    const granted = await setAccess({ projectAccess: 'selected', projectIds: [a.id, b.id] });
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({ projectAccess: 'selected', projectIds: [a.id, b.id] });

    // A replace, not an append: beta is dropped by sending only alpha.
    const replaced = await setAccess({ projectAccess: 'selected', projectIds: [a.id] });
    expect(replaced.json()).toMatchObject({ projectAccess: 'selected', projectIds: [a.id] });

    // An empty selection is a real state, not a rejected one.
    const emptied = await setAccess({ projectAccess: 'selected', projectIds: [] });
    expect(emptied.json()).toMatchObject({ projectAccess: 'selected', projectIds: [] });

    // Back to 'all' clears the grant rows, so switching back to 'selected' doesn't resurrect them.
    expect((await setAccess({ projectAccess: 'all' })).json()).toMatchObject({ projectAccess: 'all', projectIds: [] });
    expect(app.db.select().from(projectMembers).where(eq(projectMembers.userId, userId)).all()).toEqual([]);

    const listed = (await get(app, ownerCookie, '/api/users')).json() as { id: number; projectAccess: string }[];
    expect(listed.find((user) => user.id === userId)).toMatchObject({ projectAccess: 'all', projectIds: [] });

    await app.close();
  });

  it('is admin-gated, owner-gated for an admin target, and normalizes an admin to all projects', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const project = insertProject(app.db, 'alpha');
    const { cookie: memberCookie, userId: memberId } = await createMember(app);
    const { cookie: adminCookie, userId: adminId } = await createAdmin(app);

    const byMember = await app.inject({
      method: 'PUT',
      url: `/api/users/${String(memberId)}/projects`,
      headers: { cookie: memberCookie },
      payload: { projectAccess: 'selected', projectIds: [project.id] },
    });
    expect(byMember.statusCode).toBe(403);

    const adminTargetsAdmin = await app.inject({
      method: 'PUT',
      url: `/api/users/${String(adminId)}/projects`,
      headers: { cookie: adminCookie },
      payload: { projectAccess: 'selected', projectIds: [project.id] },
    });
    expect(adminTargetsAdmin.statusCode).toBe(403);
    expect(adminTargetsAdmin.json()).toEqual({ error: 'requires owner' });

    // The owner may target an admin, but a scope for one is meaningless and is stored as 'all'.
    const ownerTargetsAdmin = await app.inject({
      method: 'PUT',
      url: `/api/users/${String(adminId)}/projects`,
      headers: { cookie: ownerCookie },
      payload: { projectAccess: 'selected', projectIds: [project.id] },
    });
    expect(ownerTargetsAdmin.statusCode).toBe(200);
    expect(ownerTargetsAdmin.json()).toMatchObject({ projectAccess: 'all', projectIds: [] });

    await app.close();
  });

  it('drops a stale project id instead of failing the whole request', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const alpha = insertProject(app.db, 'alpha');
    const { userId } = await createMember(app);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${String(userId)}/projects`,
      headers: { cookie: ownerCookie },
      payload: { projectAccess: 'selected', projectIds: [alpha.id, 9999] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ projectAccess: 'selected', projectIds: [alpha.id] });

    await app.close();
  });

  it('promoting a member to admin clears their grants', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const alpha = insertProject(app.db, 'alpha');
    const { userId } = await createMember(app);
    scopeUser(app.db, userId, [alpha.id]);

    const promoted = await app.inject({
      method: 'PATCH',
      url: `/api/users/${String(userId)}/role`,
      headers: { cookie: ownerCookie },
      payload: { role: 'admin' },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ role: 'admin', projectAccess: 'all', projectIds: [] });
    expect(app.db.select().from(projectMembers).where(eq(projectMembers.userId, userId)).all()).toEqual([]);

    await app.close();
  });
});

describe('invite-time project scope', () => {
  it('stores the selection against the pending invite, so it is in force the moment it is accepted', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const alpha = insertProject(app.db, 'alpha');
    insertProject(app.db, 'beta');

    const invited = await app.inject({
      method: 'POST',
      url: '/api/users/invite',
      headers: { cookie: ownerCookie },
      payload: { email: 'scoped@example.com', role: 'member', projectAccess: 'selected', projectIds: [alpha.id] },
    });
    expect(invited.statusCode).toBe(201);
    const body = invited.json() as { id: number; inviteUrl: string; projectAccess: string; projectIds: number[] };
    expect(body).toMatchObject({ projectAccess: 'selected', projectIds: [alpha.id] });

    const token = body.inviteUrl.split('/').pop()!;
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/invite/${token}`,
      payload: { name: 'Scoped Sam', password: 'a-long-enough-password' },
    });
    expect(accepted.statusCode).toBe(200);
    const cookie = (accepted.headers['set-cookie'] as string).split(';')[0]!;

    const visible = (await get(app, cookie, '/api/projects')).json() as { slug: string }[];
    expect(visible.map((project) => project.slug)).toEqual(['alpha']);

    await app.close();
  });

  it('defaults to all projects when the client sends no scope, and ignores one sent for an admin', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const alpha = insertProject(app.db, 'alpha');

    const legacy = await app.inject({
      method: 'POST',
      url: '/api/users/invite',
      headers: { cookie: ownerCookie },
      payload: { email: 'legacy@example.com', role: 'member' },
    });
    expect(legacy.json()).toMatchObject({ projectAccess: 'all', projectIds: [] });

    const admin = await app.inject({
      method: 'POST',
      url: '/api/users/invite',
      headers: { cookie: ownerCookie },
      payload: { email: 'admin-invite@example.com', role: 'admin', projectAccess: 'selected', projectIds: [alpha.id] },
    });
    expect(admin.json()).toMatchObject({ projectAccess: 'all', projectIds: [] });

    await app.close();
  });
});

describe('project creation by a scoped member', () => {
  it('grants the creator their own new project', async () => {
    // Real provisioning runs on `POST /api/projects`, so this one test needs the fully sandboxed
    // app the projects-route suite uses (apps dir + DevSysOps system root inside the temp dir)
    // rather than `buildOwnerApp`, whose provisioning would try to write to the real host.
    const app = await buildProvisioningApp();
    const existing = insertProject(app.db, 'alpha');
    const { cookie, userId } = await createMember(app);
    scopeUser(app.db, userId, [existing.id]);

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name: 'Mine', slug: 'mine', repoUrl: 'https://example.com/acme/mine.git', branch: 'main', type: 'static' },
    });
    expect(created.statusCode).toBe(201);

    const visible = (await get(app, cookie, '/api/projects')).json() as { slug: string }[];
    expect(visible.map((project) => project.slug).sort()).toEqual(['alpha', 'mine']);

    await app.close();
  });
});

describe('pgAdmin server list', () => {
  it('narrows a scoped member to their own Postgres databases, and leaves everyone else on the full list', async () => {
    const { app } = await buildOwnerApp();
    const mine = insertProject(app.db, 'mine');
    const theirs = insertProject(app.db, 'theirs');

    for (const [project, name] of [
      [mine, 'mine_db'],
      [theirs, 'theirs_db'],
    ] as const) {
      app.db
        .insert(databases)
        .values({
          projectId: project.id,
          engine: 'postgres',
          name,
          username: name,
          passwordEncrypted: app.secretBox.encrypt('secret'),
        })
        .run();
    }

    const { userId: scopedId } = await createMember(app, { email: 'scoped@example.com' });
    await createMember(app, { email: 'unscoped@example.com' });
    scopeUser(app.db, scopedId, [mine.id]);

    const payload = JSON.parse(pgAdminPayload(app)) as {
      servers: { name: string }[];
      serversByUser: Record<string, string[]>;
    };

    // The full list is unchanged — the narrowing is per account, not a filter on the payload.
    expect(payload.servers.map((server) => server.name).sort()).toEqual(['mine_db', 'theirs_db']);
    expect(payload.serversByUser).toEqual({ 'scoped@example.com': ['mine_db'] });
    // Absent, not empty: an unscoped account must get everything, and `[]` would mean nothing.
    expect(payload.serversByUser['unscoped@example.com']).toBeUndefined();
    expect(payload.serversByUser['ada@example.com']).toBeUndefined();

    await app.close();
  });
});
