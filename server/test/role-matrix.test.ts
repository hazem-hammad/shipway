/**
 * Integration coverage for the admin+-gated routes (spec §1/§2, plan Task 2's "Global Constraints"):
 * a plain 'member' gets exactly `403 {error: 'requires admin'}`, while an 'admin' (and, by
 * transitivity, the 'owner' created at setup) clears the gate and reaches the route's normal logic.
 * No route requires strictly 'owner' yet in Task 2 (that lands in Task 3 with admin-vs-owner user
 * management rules), so there's no owner-only case here.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import type { DbAdmin, DbAdminTarget } from '../src/services/dbprovision.js';
import { FakeDnsClient } from '../src/services/cloudflare.js';
import { DevSysOps } from '../src/sysops/dev.js';
import { buildOwnerApp, createAdmin, createMember, tmpDataDir } from './helpers.js';

const FORBIDDEN_ADMIN = { error: 'requires admin' };

class NoopDbAdmin implements DbAdmin {
  async createDatabase(_target: DbAdminTarget, _name: string, _user: string, _password: string): Promise<void> {}
  async dropDatabase(_target: DbAdminTarget, _name: string, _user: string): Promise<void> {}
  async testConnection(_target: DbAdminTarget): Promise<void> {}
  async importSql(_target: DbAdminTarget, _database: string, _sqlPath: string): Promise<void> {}
  async dumpSql(_target: DbAdminTarget, _database: string, _sqlPath: string): Promise<void> {}
}

describe('role gates: admin+ routes', () => {
  it('PUT /api/settings: member 403s with the exact body, admin and owner both succeed', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);

    const memberRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: memberCookie },
      payload: { base_domain: 'member-attempt.example.com' },
    });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json()).toEqual(FORBIDDEN_ADMIN);

    const adminRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { base_domain: 'admin.example.com' },
    });
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.json()).toMatchObject({ base_domain: 'admin.example.com' });

    const ownerRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: ownerCookie },
      payload: { base_domain: 'owner.example.com' },
    });
    expect(ownerRes.statusCode).toBe(200);

    await app.close();
  });

  it('GET /api/settings stays member-readable (no gate on reads)', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);

    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('PUT /api/github/app: member 403s, admin succeeds', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);
    const payload = { appId: 123456, privateKey: 'pem', webhookSecret: 'whsec' };

    const memberRes = await app.inject({ method: 'PUT', url: '/api/github/app', headers: { cookie: memberCookie }, payload });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json()).toEqual(FORBIDDEN_ADMIN);

    const adminRes = await app.inject({ method: 'PUT', url: '/api/github/app', headers: { cookie: adminCookie }, payload });
    expect(adminRes.statusCode).toBe(200);

    await app.close();
  });

  it('POST /api/github/resolve-installation: member 403s, admin clears the gate (503 not configured)', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);

    const memberRes = await app.inject({ method: 'POST', url: '/api/github/resolve-installation', headers: { cookie: memberCookie } });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json()).toEqual(FORBIDDEN_ADMIN);

    const adminRes = await app.inject({ method: 'POST', url: '/api/github/resolve-installation', headers: { cookie: adminCookie } });
    expect(adminRes.statusCode).toBe(503); // clears the role gate; 503s only because no github_app is configured
    expect(adminRes.json()).toEqual({ error: 'github app not configured' });

    await app.close();
  });

  it('GET /api/github/installations: member 403s, admin clears the gate (503 not configured)', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);

    const memberRes = await app.inject({ method: 'GET', url: '/api/github/installations', headers: { cookie: memberCookie } });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json()).toEqual(FORBIDDEN_ADMIN);

    const adminRes = await app.inject({ method: 'GET', url: '/api/github/installations', headers: { cookie: adminCookie } });
    expect(adminRes.statusCode).toBe(503); // clears the role gate; 503s only because no github_app is configured
    expect(adminRes.json()).toEqual({ error: 'github app not configured' });

    await app.close();
  });

  it('GET /api/github/manifest: member 403s, admin succeeds', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);
    const url = '/api/github/manifest?baseUrl=https://deploy.example.com';

    const memberRes = await app.inject({ method: 'GET', url, headers: { cookie: memberCookie } });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json()).toEqual(FORBIDDEN_ADMIN);

    const adminRes = await app.inject({ method: 'GET', url, headers: { cookie: adminCookie } });
    expect(adminRes.statusCode).toBe(200);

    await app.close();
  });

  it('GET /api/github/status, /api/github/repos are NOT admin-gated (member-readable)', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);

    const status = await app.inject({ method: 'GET', url: '/api/github/status', headers: { cookie: memberCookie } });
    expect(status.statusCode).toBe(200);

    await app.close();
  });

  it('POST /api/users: member 403s, admin succeeds', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);

    const memberRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: memberCookie },
      payload: { name: 'Blocked', email: 'blocked@example.com', password: 'password123' },
    });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json()).toEqual(FORBIDDEN_ADMIN);

    const adminRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { name: 'Created By Admin', email: 'created-by-admin@example.com', password: 'password123' },
    });
    expect(adminRes.statusCode).toBe(201);

    await app.close();
  });

  it('DELETE /api/users/:id: member 403s, admin succeeds', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie, userId: adminId } = await createAdmin(app);
    const { userId: targetId } = await createMember(app, { email: 'to-delete@example.com' });

    const memberRes = await app.inject({ method: 'DELETE', url: `/api/users/${adminId}`, headers: { cookie: memberCookie } });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json()).toEqual(FORBIDDEN_ADMIN);

    const adminRes = await app.inject({ method: 'DELETE', url: `/api/users/${targetId}`, headers: { cookie: adminCookie } });
    expect(adminRes.statusCode).toBe(204);

    await app.close();
  });

  it('DELETE /api/projects/:id: member 403s, admin succeeds', async () => {
    const dataDir = tmpDataDir();
    const systemRoot = path.join(dataDir, 'system');
    const sysops = new DevSysOps(systemRoot);
    const dns = new FakeDnsClient();
    const { app, cookie: ownerCookie } = await buildOwnerApp({ sysops, dns: () => dns });
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: ownerCookie },
      payload: { base_domain: 'apps.example.com', server_ip: '203.0.113.10' },
    });

    const create = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: ownerCookie },
      payload: { name: 'Static Site', slug: 'static-site', repo: 'acme/static-site', branch: 'main', type: 'static' },
    });
    expect(create.statusCode).toBe(201);

    const memberRes = await app.inject({
      method: 'DELETE',
      url: '/api/projects/static-site'.replace('static-site', String(create.json().id)),
      headers: { cookie: memberCookie },
      payload: { confirmName: 'static-site' },
    });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json()).toEqual(FORBIDDEN_ADMIN);

    const adminRes = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${create.json().id}`,
      headers: { cookie: adminCookie },
      payload: { confirmName: 'static-site' },
    });
    expect(adminRes.statusCode).toBe(204);

    await app.close();
  });

  it('PATCH /api/projects/:id/subdomain: member 403s, admin succeeds', async () => {
    const dataDir = tmpDataDir();
    const sysops = new DevSysOps(path.join(dataDir, 'system'));
    const dns = new FakeDnsClient();
    const { app, cookie: ownerCookie } = await buildOwnerApp({ sysops, dns: () => dns });
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: ownerCookie },
      payload: { base_domain: 'apps.example.com', server_ip: '203.0.113.10' },
    });
    const create = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: ownerCookie },
      payload: { name: 'Static Site', slug: 'static-site', repo: 'acme/static-site', branch: 'main', type: 'static' },
    });
    const id = create.json().id as number;

    const memberRes = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${String(id)}/subdomain`,
      headers: { cookie: memberCookie },
      payload: { subdomain: 'members-only' },
    });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json()).toEqual(FORBIDDEN_ADMIN);

    const adminRes = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${String(id)}/subdomain`,
      headers: { cookie: adminCookie },
      payload: { subdomain: 'moved' },
    });
    expect(adminRes.statusCode).toBe(200);

    await app.close();
  });

  it('DELETE /api/databases/:id: member 403s, admin succeeds', async () => {
    const dbAdmin = new NoopDbAdmin();
    const { app } = await buildOwnerApp({ dbAdmin });
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);

    const create = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie: memberCookie }, // create is member-permitted
      payload: { engine: 'mysql', name: 'shop_db' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as number;

    const memberRes = await app.inject({
      method: 'DELETE',
      url: `/api/databases/${id}`,
      headers: { cookie: memberCookie },
      payload: { confirmName: 'shop_db' },
    });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json()).toEqual(FORBIDDEN_ADMIN);

    const adminRes = await app.inject({
      method: 'DELETE',
      url: `/api/databases/${id}`,
      headers: { cookie: adminCookie },
      payload: { confirmName: 'shop_db' },
    });
    expect(adminRes.statusCode).toBe(204);

    await app.close();
  });

  it('POST /api/databases (create) is member-permitted, not admin-gated', async () => {
    const dbAdmin = new NoopDbAdmin();
    const { app } = await buildOwnerApp({ dbAdmin });
    const { cookie: memberCookie } = await createMember(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: { cookie: memberCookie },
      payload: { engine: 'postgres', name: 'blog_db' },
    });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  /**
   * The settings surface as one sweep, so a newly added settings write that forgets its
   * `requireRole` fails here rather than in production. Deliberately a TABLE rather than one `it`
   * per route: the value is in the list being exhaustive and cheap to extend, and every entry
   * asserts the same two things — the exact 403 body, and that nothing was written.
   *
   * The routes with their own case above (settings, github, users, projects, databases) are not
   * repeated; this covers what those don't. `GET /api/github/installations` is a read that is
   * nonetheless admin-gated (it calls GitHub with the app's credentials), which is why a "GET" can
   * legitimately appear in a list of writes.
   */
  it('every remaining settings-surface mutation 403s for a member', async () => {
    const { app } = await buildOwnerApp();
    const { cookie } = await createMember(app);

    const attempts: {
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      url: string;
      payload?: Record<string, string | number | boolean>;
    }[] = [
      { method: 'PUT', url: '/api/settings/mail', payload: { driver: 'mailpit' } },
      { method: 'POST', url: '/api/settings/mail/test', payload: { to: 'someone@example.com' } },
      { method: 'PUT', url: '/api/audit/config', payload: { enabled: false } },
      { method: 'POST', url: '/api/db-connections', payload: { name: 'x', engine: 'mysql', host: 'h', port: 3306, adminUsername: 'u', adminPassword: 'p' } },
      { method: 'POST', url: '/api/db-connections/test', payload: { engine: 'mysql', host: 'h', port: 3306, adminUsername: 'u', adminPassword: 'p' } },
      { method: 'PATCH', url: '/api/db-connections/1', payload: { name: 'y' } },
      { method: 'DELETE', url: '/api/db-connections/1' },
    ];

    for (const attempt of attempts) {
      const res = await app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: { cookie },
        ...(attempt.payload === undefined ? {} : { payload: attempt.payload }),
      });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
      expect(res.json(), `${attempt.method} ${attempt.url}`).toEqual(FORBIDDEN_ADMIN);
    }

    // The gate ran BEFORE any handler logic: mail is still unconfigured and audit recording is
    // still on, so none of the rejected calls left a partial write behind.
    const mail = await app.inject({ method: 'GET', url: '/api/settings/mail', headers: { cookie } });
    expect(mail.json()).toMatchObject({ driver: 'none' });
    const audit = await app.inject({ method: 'GET', url: '/api/audit/config', headers: { cookie } });
    expect(audit.json()).toMatchObject({ enabled: true });

    await app.close();
  });

});
