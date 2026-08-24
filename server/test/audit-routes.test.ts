/**
 * Task 5's audit query API: `GET /api/audit` (category/q/actorId/since/cursor/limit filtering +
 * keyset pagination + tab-pill counts) and `GET`/`PUT /api/audit/config` (retention/enabled,
 * PUT admin+). `categoryForAction`'s completeness against every action string the codebase's
 * `recordAudit` call sites currently emit is asserted first — see its own describe block.
 */
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AUDIT_CATEGORIES, categoryForAction } from '../src/routes/audit.js';
import { buildOwnerApp, createAdmin, createMember } from './helpers.js';

/** Project creation needs `base_domain`/`server_ip` configured (dev mode's shared `FakeDnsClient` +
 * `DevSysOps` handle the rest) — mirrors `audit-wiring.test.ts`/`deployments-routes.test.ts`'s own
 * setup. */
async function configureBaseDomain(app: FastifyInstance, cookie: string): Promise<void> {
  await app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: { cookie },
    payload: { base_domain: 'apps.example.com', server_ip: '203.0.113.10' },
  });
}

/**
 * Every distinct `action` string a `recordAudit(...)` call site emits anywhere in `src/`, as of
 * Task 5 (grepped by hand — see the task report for the exact `grep -rn "action: '"` / `recordAudit(`
 * sweep this was built from). A category filter that can't reach one of these would silently hide
 * real audit rows from every non-'all' tab, so this list is intentionally hardcoded rather than
 * derived from the source it's checking.
 */
const ALL_EMITTED_ACTIONS = [
  'auth.login_failed',
  'cron.create',
  'cron.update',
  'cron.delete',
  'database.create',
  'database.drop',
  'database.inject',
  'deploy.trigger',
  'deploy.rollback',
  'deploy.cancel',
  'github.configure',
  'notification.channel.create',
  'notification.channel.update',
  'notification.channel.delete',
  'notification.subscribe',
  'notification.unsubscribe',
  'notification.migrated',
  'project.create',
  'project.update',
  'project.scripts.update',
  'project.delete',
  'project.env.update',
  'project.smtp.update',
  'settings.update',
  'user.create',
  'user.invite',
  'user.reinvite',
  'user.accept_invite',
  'user.role_change',
  'user.delete',
  'worker.create',
  'worker.update',
  'worker.delete',
  'worker.action',
  'service.down',
  'service.recovered',
  'audit.config',
];

describe('categoryForAction: completeness', () => {
  it('maps every currently-emitted action to exactly one non-"all" category', () => {
    for (const action of ALL_EMITTED_ACTIONS) {
      const category = categoryForAction(action);
      expect(category, `expected ${action} to map to a category`).not.toBeNull();
      expect(AUDIT_CATEGORIES).toContain(category);
    }
  });

  it('returns null for an action namespace nothing maps to', () => {
    expect(categoryForAction('totally.unknown.namespace')).toBeNull();
  });
});

describe('GET /api/audit', () => {
  it('lists events newest-first with the documented row shape', async () => {
    const { app, cookie } = await buildOwnerApp();

    await configureBaseDomain(app, cookie);

    const res = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: unknown[]; nextCursor: number | null; counts: Record<string, number> };
    expect(body.events.length).toBeGreaterThan(0);
    const first = body.events[0] as Record<string, unknown>;
    expect(first).toMatchObject({
      action: 'settings.update',
      targetType: 'settings',
      targetName: 'settings',
    });
    expect(typeof first.id).toBe('number');
    expect(typeof first.actorName).toBe('string');
    expect(typeof first.createdAt).toBe('number');
    expect((first.meta as { keys: string[] }).keys.sort()).toEqual(['base_domain', 'server_ip']);

    await app.close();
  });

  it('is readable by any authenticated member (no role gate on GET)', async () => {
    const { app } = await buildOwnerApp();
    const { cookie } = await createMember(app);

    const res = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('filters by category (deployments vs settings) using the same underlying rows', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureBaseDomain(app, cookie);

    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name: 'demo', slug: 'demo', repo: 'octocat/demo', branch: 'main', type: 'static' },
    });
    expect(project.statusCode).toBe(201);
    const projectId = (project.json() as { id: number }).id;
    await app.inject({ method: 'POST', url: `/api/projects/${String(projectId)}/deploy`, headers: { cookie } });

    const deployRes = await app.inject({ method: 'GET', url: '/api/audit?category=deployments', headers: { cookie } });
    const deployBody = deployRes.json() as { events: { action: string }[] };
    expect(deployBody.events.length).toBeGreaterThan(0);
    expect(deployBody.events.every((e) => e.action.startsWith('deploy.'))).toBe(true);

    const settingsRes = await app.inject({ method: 'GET', url: '/api/audit?category=settings', headers: { cookie } });
    const settingsBody = settingsRes.json() as { events: { action: string }[] };
    expect(settingsBody.events.length).toBeGreaterThan(0);
    expect(settingsBody.events.every((e) => e.action.startsWith('settings.'))).toBe(true);

    const projectsRes = await app.inject({ method: 'GET', url: '/api/audit?category=projects', headers: { cookie } });
    const projectsBody = projectsRes.json() as { events: { action: string }[] };
    expect(projectsBody.events.some((e) => e.action === 'project.create')).toBe(true);
    expect(projectsBody.events.every((e) => e.action.startsWith('project.'))).toBe(true);

    await app.close();
  });

  it('filters by q (case-insensitive substring over action/targetName/actorName)', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureBaseDomain(app, cookie);
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name: 'blueberry', slug: 'blueberry', repo: 'octocat/blueberry', branch: 'main', type: 'static' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/audit?q=BLUE', headers: { cookie } });
    const body = res.json() as { events: { targetName: string }[] };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.targetName.toLowerCase().includes('blue'))).toBe(true);

    const missRes = await app.inject({ method: 'GET', url: '/api/audit?q=zzz-nomatch-zzz', headers: { cookie } });
    expect((missRes.json() as { events: unknown[] }).events).toHaveLength(0);

    await app.close();
  });

  it('filters by actorId', async () => {
    const { app, cookie: ownerCookie, userId: ownerId } = await buildOwnerApp();
    await configureBaseDomain(app, ownerCookie);
    const { cookie: memberCookie } = await createMember(app);

    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: ownerCookie },
      payload: { name: 'owner-proj', slug: 'owner-proj', repo: 'octocat/owner-proj', branch: 'main', type: 'static' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: memberCookie },
      payload: { name: 'member-proj', slug: 'member-proj', repo: 'octocat/member-proj', branch: 'main', type: 'static' },
    });

    const res = await app.inject({ method: 'GET', url: `/api/audit?actorId=${String(ownerId)}`, headers: { cookie: ownerCookie } });
    const body = res.json() as { events: { actorId: number | null; targetName: string }[] };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.actorId === ownerId)).toBe(true);
    expect(body.events.some((e) => e.targetName === 'owner-proj')).toBe(true);
    expect(body.events.some((e) => e.targetName === 'member-proj')).toBe(false);

    await app.close();
  });

  it('filters by since (epoch ms)', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureBaseDomain(app, cookie);
    const future = Date.now() + 60_000;

    const res = await app.inject({ method: 'GET', url: `/api/audit?since=${String(future)}`, headers: { cookie } });
    expect((res.json() as { events: unknown[] }).events).toHaveLength(0);

    const past = Date.now() - 60_000;
    const res2 = await app.inject({ method: 'GET', url: `/api/audit?since=${String(past)}`, headers: { cookie } });
    expect((res2.json() as { events: unknown[] }).events.length).toBeGreaterThan(0);

    await app.close();
  });

  it('paginates via cursor (keyset, desc by id) and clamps/defaults limit', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureBaseDomain(app, cookie);
    for (let i = 0; i < 5; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { cookie },
        payload: { name: `p${String(i)}`, slug: `p${String(i)}`, repo: `octocat/p${String(i)}`, branch: 'main', type: 'static' },
      });
    }

    const page1 = await app.inject({ method: 'GET', url: '/api/audit?limit=2', headers: { cookie } });
    const page1Body = page1.json() as { events: { id: number }[]; nextCursor: number | null };
    expect(page1Body.events).toHaveLength(2);
    expect(page1Body.nextCursor).toBe(page1Body.events[1]!.id);
    expect(page1Body.events[0]!.id).toBeGreaterThan(page1Body.events[1]!.id);

    const page2 = await app.inject({ method: 'GET', url: `/api/audit?limit=2&cursor=${String(page1Body.nextCursor)}`, headers: { cookie } });
    const page2Body = page2.json() as { events: { id: number }[] };
    expect(page2Body.events).toHaveLength(2);
    expect(page2Body.events[0]!.id).toBeLessThan(page1Body.events[1]!.id);

    const clamped = await app.inject({ method: 'GET', url: '/api/audit?limit=1000', headers: { cookie } });
    const clampedBody = clamped.json() as { events: unknown[] };
    expect(clampedBody.events.length).toBeLessThanOrEqual(100);

    await app.close();
  });

  it('exposes counts per category computed with the same non-category filters (not the category filter itself)', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureBaseDomain(app, cookie);
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name: 'countme', slug: 'countme', repo: 'octocat/countme', branch: 'main', type: 'static' },
    });
    const projectId = (project.json() as { id: number }).id;
    await app.inject({ method: 'POST', url: `/api/projects/${String(projectId)}/deploy`, headers: { cookie } });

    const allRes = await app.inject({ method: 'GET', url: '/api/audit?category=all', headers: { cookie } });
    const allBody = allRes.json() as { counts: Record<string, number> };

    const deployRes = await app.inject({ method: 'GET', url: '/api/audit?category=deployments', headers: { cookie } });
    const deployBody = deployRes.json() as { counts: Record<string, number> };

    // counts are the SAME regardless of which category tab is currently selected (they describe
    // every tab's pill, not just the active one) — and they reflect the full unfiltered total here
    // since no q/actorId/since filter was applied.
    expect(deployBody.counts).toEqual(allBody.counts);
    expect(allBody.counts.deployments).toBeGreaterThan(0);
    expect(allBody.counts.projects).toBeGreaterThan(0);
    expect(allBody.counts.all).toBe(
      allBody.counts.deployments! + allBody.counts.projects! + (allBody.counts.databases ?? 0) + (allBody.counts.team ?? 0) + allBody.counts.settings!,
    );

    await app.close();
  });
});

describe('audit config', () => {
  it('GET returns {enabled, retentionDays} and is member-readable', async () => {
    const { app } = await buildOwnerApp();
    const { cookie } = await createMember(app);

    const res = await app.inject({ method: 'GET', url: '/api/audit/config', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, retentionDays: 90 });

    await app.close();
  });

  it('PUT round-trips enabled/retentionDays and records audit.config (meta keys only)', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/audit/config',
      headers: { cookie },
      payload: { enabled: false, retentionDays: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, retentionDays: 30 });

    // Re-enable so the audit.config write itself (and this GET) actually get recorded/visible.
    await app.inject({ method: 'PUT', url: '/api/audit/config', headers: { cookie }, payload: { enabled: true } });

    const listRes = await app.inject({ method: 'GET', url: '/api/audit?category=settings', headers: { cookie } });
    const listBody = listRes.json() as { events: { action: string; meta: unknown }[] };
    const configEvent = listBody.events.find((e) => e.action === 'audit.config' && Array.isArray((e.meta as { keys?: string[] })?.keys) && (e.meta as { keys: string[] }).keys.includes('enabled') && !(e.meta as { keys: string[] }).keys.includes('retentionDays'));
    expect(configEvent).toBeDefined();

    await app.close();
  });

  it('PUT rejects retentionDays outside {30,90,365}', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({ method: 'PUT', url: '/api/audit/config', headers: { cookie }, payload: { retentionDays: 45 } });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('role gate: member 403s on PUT, admin succeeds', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);

    const memberRes = await app.inject({ method: 'PUT', url: '/api/audit/config', headers: { cookie: memberCookie }, payload: { enabled: false } });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json()).toEqual({ error: 'requires admin' });

    const adminRes = await app.inject({ method: 'PUT', url: '/api/audit/config', headers: { cookie: adminCookie }, payload: { enabled: false } });
    expect(adminRes.statusCode).toBe(200);

    await app.close();
  });
});
