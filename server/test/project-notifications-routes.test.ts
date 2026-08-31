/**
 * A project's notification settings (`server/src/routes/projectnotifications.ts`):
 * `GET`/`PUT /api/projects/:id/notifications` and `POST /api/projects/:id/notifications/test`.
 * `GET` is member-readable; the `PUT` and the test-send are admin+.
 *
 * These replace the instance-wide `/api/notifications` channel API, which is gone along with
 * webhook/Teams delivery — email is the only mechanism now, and it's configured per project.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { auditEvents, projectNotificationEvents, projects } from '../src/db/schema.js';
import { saveMailConfig } from '../src/services/mailer.js';
import { buildOwnerApp, createMember } from './helpers.js';

interface NotificationsResponse {
  recipients: string[];
  events: { event: string; label: string; description: string; enabled: boolean }[];
  mailConfigured: boolean;
}

/** Inserts a project row directly — these routes only need a project to exist, and going through
 * `POST /api/projects` would drag the whole provisioning path in. */
function insertProject(app: FastifyInstance, slug = 'shop'): number {
  app.db.insert(projects).values({ name: slug, slug, repo: `acme/${slug}`, branch: 'main', type: 'static' }).run();
  const row = app.db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get();
  if (!row) throw new Error('failed to insert test project');
  return row.id;
}

function configureMail(app: FastifyInstance): void {
  saveMailConfig(app.db, app.secretBox, { driver: 'smtp', host: 'smtp.example.com', port: 587, secure: false, fromAddress: 'shipway@example.com' });
}

function enabledEvents(body: NotificationsResponse): string[] {
  return body.events.filter((e) => e.enabled).map((e) => e.event);
}

describe('GET /api/projects/:id/notifications', () => {
  it('is member-readable and starts empty for a directly-inserted project', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const projectId = insertProject(app);

    const res = await app.inject({ method: 'GET', url: `/api/projects/${String(projectId)}/notifications`, headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(200);

    const body = res.json() as NotificationsResponse;
    expect(body.recipients).toEqual([]);
    expect(body.events.map((e) => e.event)).toEqual(['deploy_failed', 'deploy_succeeded', 'deploy_canceled', 'deploy_rolled_back']);
    expect(enabledEvents(body)).toEqual([]);
    expect(body.mailConfigured).toBe(false);

    await app.close();
  });

  it('reports mailConfigured once instance mail is set up', async () => {
    const { app, cookie } = await buildOwnerApp();
    const projectId = insertProject(app);
    configureMail(app);

    const res = await app.inject({ method: 'GET', url: `/api/projects/${String(projectId)}/notifications`, headers: { cookie } });
    expect((res.json() as NotificationsResponse).mailConfigured).toBe(true);

    await app.close();
  });

  it('404s for an unknown project', async () => {
    const { app, cookie } = await buildOwnerApp();
    const res = await app.inject({ method: 'GET', url: '/api/projects/999999/notifications', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('requires authentication', async () => {
    const { app } = await buildOwnerApp();
    const projectId = insertProject(app);
    const res = await app.inject({ method: 'GET', url: `/api/projects/${String(projectId)}/notifications` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('PUT /api/projects/:id/notifications', () => {
  it('rejects a plain member with 403 and changes nothing', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const projectId = insertProject(app);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(projectId)}/notifications`,
      headers: { cookie: memberCookie },
      payload: { recipients: ['ops@example.com'], events: ['deploy_failed'] },
    });

    expect(res.statusCode).toBe(403);
    expect(app.db.select().from(projectNotificationEvents).all()).toHaveLength(0);

    await app.close();
  });

  it('saves recipients and events, and reads them back', async () => {
    const { app, cookie } = await buildOwnerApp();
    const projectId = insertProject(app);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(projectId)}/notifications`,
      headers: { cookie },
      payload: { recipients: ['ops@example.com', 'dev@example.com'], events: ['deploy_failed', 'deploy_succeeded'] },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as NotificationsResponse;
    expect(body.recipients).toEqual(['ops@example.com', 'dev@example.com']);
    expect(enabledEvents(body).sort()).toEqual(['deploy_failed', 'deploy_succeeded']);

    const get = await app.inject({ method: 'GET', url: `/api/projects/${String(projectId)}/notifications`, headers: { cookie } });
    expect((get.json() as NotificationsResponse).recipients).toEqual(['ops@example.com', 'dev@example.com']);

    await app.close();
  });

  it('normalizes addresses: trimmed, lowercased, blanks dropped, duplicates collapsed', async () => {
    const { app, cookie } = await buildOwnerApp();
    const projectId = insertProject(app);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(projectId)}/notifications`,
      headers: { cookie },
      payload: { recipients: ['  Ops@Example.com ', '', '   ', 'ops@example.com', 'dev@example.com'], events: [] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as NotificationsResponse).recipients).toEqual(['ops@example.com', 'dev@example.com']);

    await app.close();
  });

  it('rejects an invalid address, naming it, and persists nothing from that request', async () => {
    const { app, cookie } = await buildOwnerApp();
    const projectId = insertProject(app);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(projectId)}/notifications`,
      headers: { cookie },
      payload: { recipients: ['ops@example.com', 'not-an-address'], events: ['deploy_failed'] },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('not-an-address');

    const get = await app.inject({ method: 'GET', url: `/api/projects/${String(projectId)}/notifications`, headers: { cookie } });
    expect((get.json() as NotificationsResponse).recipients).toEqual([]);

    await app.close();
  });

  it('rejects an unknown event key', async () => {
    const { app, cookie } = await buildOwnerApp();
    const projectId = insertProject(app);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(projectId)}/notifications`,
      headers: { cookie },
      payload: { recipients: [], events: ['service_down'] },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('caps the recipient list rather than accepting an unbounded paste', async () => {
    const { app, cookie } = await buildOwnerApp();
    const projectId = insertProject(app);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(projectId)}/notifications`,
      headers: { cookie },
      payload: { recipients: Array.from({ length: 51 }, (_, i) => `user${String(i)}@example.com`), events: [] },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('is replace-all: removing an address and unchecking an event drops them', async () => {
    const { app, cookie } = await buildOwnerApp();
    const projectId = insertProject(app);
    const url = `/api/projects/${String(projectId)}/notifications`;

    await app.inject({ method: 'PUT', url, headers: { cookie }, payload: { recipients: ['a@example.com', 'b@example.com'], events: ['deploy_failed', 'deploy_succeeded'] } });
    const res = await app.inject({ method: 'PUT', url, headers: { cookie }, payload: { recipients: ['a@example.com'], events: ['deploy_failed'] } });

    const body = res.json() as NotificationsResponse;
    expect(body.recipients).toEqual(['a@example.com']);
    expect(enabledEvents(body)).toEqual(['deploy_failed']);

    await app.close();
  });

  it('an empty events list is honored rather than being re-seeded with the defaults', async () => {
    const { app, cookie } = await buildOwnerApp();
    const projectId = insertProject(app);
    const url = `/api/projects/${String(projectId)}/notifications`;

    await app.inject({ method: 'PUT', url, headers: { cookie }, payload: { recipients: ['a@example.com'], events: ['deploy_failed'] } });
    await app.inject({ method: 'PUT', url, headers: { cookie }, payload: { recipients: ['a@example.com'], events: [] } });

    const get = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(enabledEvents(get.json() as NotificationsResponse)).toEqual([]);

    await app.close();
  });

  it("never touches another project's settings", async () => {
    const { app, cookie } = await buildOwnerApp();
    const shop = insertProject(app, 'shop');
    const blog = insertProject(app, 'blog');

    await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(shop)}/notifications`,
      headers: { cookie },
      payload: { recipients: ['shop@example.com'], events: ['deploy_failed'] },
    });

    const get = await app.inject({ method: 'GET', url: `/api/projects/${String(blog)}/notifications`, headers: { cookie } });
    expect((get.json() as NotificationsResponse).recipients).toEqual([]);

    await app.close();
  });

  it('records an audit row with counts and event names, never the addresses themselves', async () => {
    const { app, cookie } = await buildOwnerApp();
    const projectId = insertProject(app);

    await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(projectId)}/notifications`,
      headers: { cookie },
      payload: { recipients: ['secret-person@example.com'], events: ['deploy_failed'] },
    });

    const rows = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'project.notifications.update')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meta).not.toContain('secret-person');
    const meta = JSON.parse(rows[0]?.meta ?? '{}') as { recipients: number; events: string[] };
    expect(meta.recipients).toBe(1);
    expect(meta.events).toEqual(['deploy_failed']);

    await app.close();
  });

  it('404s for an unknown project', async () => {
    const { app, cookie } = await buildOwnerApp();
    const res = await app.inject({ method: 'PUT', url: '/api/projects/999999/notifications', headers: { cookie }, payload: { recipients: [], events: [] } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /api/projects/:id/notifications/test', () => {
  it('rejects a plain member with 403', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const projectId = insertProject(app);

    const res = await app.inject({ method: 'POST', url: `/api/projects/${String(projectId)}/notifications/test`, headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('reports a clear reason when the project has no recipients yet', async () => {
    const { app, cookie } = await buildOwnerApp();
    const projectId = insertProject(app);
    configureMail(app);

    const res = await app.inject({ method: 'POST', url: `/api/projects/${String(projectId)}/notifications/test`, headers: { cookie } });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('recipient');

    await app.close();
  });

  it('reports a clear reason when instance mail is not configured', async () => {
    const { app, cookie } = await buildOwnerApp();
    const projectId = insertProject(app);
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(projectId)}/notifications`,
      headers: { cookie },
      payload: { recipients: ['ops@example.com'], events: ['deploy_failed'] },
    });

    const res = await app.inject({ method: 'POST', url: `/api/projects/${String(projectId)}/notifications/test`, headers: { cookie } });
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('instance mail');

    await app.close();
  });

  it('records a test audit row carrying only the recipient count', async () => {
    // A 50ms mail cap keeps this fast: the send against an unroutable host fails rather than
    // waiting out the real timeout, which is fine — the audit row is what's under test.
    const { app, cookie } = await buildOwnerApp({ mailSendTimeoutMs: 50 });
    const projectId = insertProject(app);
    configureMail(app);
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(projectId)}/notifications`,
      headers: { cookie },
      payload: { recipients: ['ops@example.com'], events: ['deploy_failed'] },
    });

    await app.inject({ method: 'POST', url: `/api/projects/${String(projectId)}/notifications/test`, headers: { cookie } });

    const rows = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'project.notifications.test')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meta).not.toContain('ops@example.com');
    expect(JSON.parse(rows[0]?.meta ?? '{}')).toEqual({ recipients: 1 });

    await app.close();
  });

  it('404s for an unknown project', async () => {
    const { app, cookie } = await buildOwnerApp();
    const res = await app.inject({ method: 'POST', url: '/api/projects/999999/notifications/test', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
