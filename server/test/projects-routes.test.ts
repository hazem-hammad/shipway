import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { auditEvents, cronJobs, deployments, projects, workers } from '../src/db/schema.js';
import { RESERVED_SLUGS } from '../src/routes/projects.js';
import { NODE_BUILD_CMD, NODE_INSTALL_CMD, NODE_START_CMD } from '../src/deploy/node.js';
import { DevSysOps } from '../src/sysops/dev.js';
import { FakeDnsClient } from '../src/services/cloudflare.js';
import {
  LARAVEL_BUILD_CMD,
  LARAVEL_INSTALL_CMD,
  LARAVEL_POST_DEPLOY_SCRIPT,
  LARAVEL_PRE_DEPLOY_SCRIPT,
} from '../src/deploy/laravel.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-projects-routes-test-'));
}

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
  dns: FakeDnsClient;
  dataDir: string;
}

/** Builds an app wired with DevSysOps (or, via `makeSysOps`, a subclass sharing its sandbox root —
 * e.g. one that fails a particular call) + FakeDnsClient test doubles, an authed session, and
 * (unless `configureDomain` is false) base_domain/server_ip settings already set. */
async function buildProjectsTestApp(
  opts: { configureDomain?: boolean; makeSysOps?: (systemRoot: string) => DevSysOps } = {},
): Promise<TestApp> {
  const dataDir = tmpDataDir();
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir, SHIPWAY_APPS_DIR: path.join(dataDir, 'apps') });
  const systemRoot = path.join(dataDir, 'system');
  const sysops = opts.makeSysOps ? opts.makeSysOps(systemRoot) : new DevSysOps(systemRoot);
  const dns = new FakeDnsClient();
  const app = await buildApp(cfg, { sysops, dns: () => dns });

  const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
  const cookie = sessionCookie(create);

  if (opts.configureDomain !== false) {
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { base_domain: 'apps.example.com', server_ip: '203.0.113.10' },
    });
  }

  return { app, cookie, sysops, dns, dataDir };
}

// 'api' itself is a reserved slug (RESERVED_SLUGS, B3) — this fixture uses 'app' instead so the
// existing node-project tests aren't incidentally exercising the reserved-slug rejection.
const NODE_PAYLOAD = {
  name: 'App',
  slug: 'app',
  repo: 'acme/app',
  branch: 'main',
  type: 'node',
};

const PHP_PAYLOAD = {
  name: 'Shop',
  slug: 'shop',
  repo: 'acme/shop',
  branch: 'main',
  type: 'php',
};

/** Fails partway through the node/nextjs app-unit step (after the vhost + DNS are already live),
 * so tests can assert POST /api/projects cleans up everything created before the failure. */
class DaemonReloadFailsSysOps extends DevSysOps {
  async daemonReload(): Promise<void> {
    this.calls.push('daemonReload (attempted)');
    throw new Error('systemctl daemon-reload failed');
  }
}

describe('POST /api/projects', () => {
  it('creates a node project with the documented defaults and provisions it (201)', async () => {
    const { app, cookie, sysops, dns } = await buildProjectsTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: NODE_PAYLOAD });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      name: 'App',
      slug: 'app',
      repo: 'acme/app',
      branch: 'main',
      type: 'node',
      nodeVersion: '22',
      publicDir: '',
      installCmd: NODE_INSTALL_CMD,
      buildCmd: NODE_BUILD_CMD,
      startCmd: NODE_START_CMD,
      sharedPaths: [],
      healthCheckPath: null,
      autoDeploy: true,
      smtpMode: 'mailpit',
      port: 3001,
    });
    expect(body.envEncrypted).toBeUndefined();
    expect(body.smtpConfigEncrypted).toBeUndefined();

    // DNS + nginx + systemd side effects actually ran.
    expect(dns.records.get('app.apps.example.com')).toBe('203.0.113.10');
    expect(sysops.calls.some((c) => c.startsWith('installFile /etc/nginx/sites-available/shipway-app.conf'))).toBe(true);
    expect(sysops.calls.some((c) => c.startsWith('installFile /etc/systemd/system/shipway-app-app.service'))).toBe(true);
    expect(sysops.calls).toContain('unitAction enable shipway-app-app.service');

    await app.close();
  });

  it('creates a php project with the documented defaults', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      type: 'php',
      phpVersion: '8.3',
      publicDir: 'public',
      installCmd: LARAVEL_INSTALL_CMD,
      // A php project is assumed to be Laravel: migrations run pre-activation, and the pre/post
      // deploy scripts come prefilled (see deploy/laravel.ts).
      buildCmd: LARAVEL_BUILD_CMD,
      preDeployScript: LARAVEL_PRE_DEPLOY_SCRIPT,
      postDeployScript: LARAVEL_POST_DEPLOY_SCRIPT,
      sharedPaths: ['storage', 'uploads'],
      port: null,
    });

    await app.close();
  });

  it('lets the request override the prefilled php scripts, including clearing them', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { ...PHP_PAYLOAD, buildCmd: 'php artisan migrate --force', preDeployScript: '', postDeployScript: 'php artisan queue:restart' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      buildCmd: 'php artisan migrate --force',
      preDeployScript: '',
      postDeployScript: 'php artisan queue:restart',
    });

    await app.close();
  });

  it('leaves the pre/post deploy scripts empty for a non-php project', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: NODE_PAYLOAD });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ preDeployScript: null, postDeployScript: null });

    await app.close();
  });

  it('creates a static project with the documented defaults', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name: 'Docs', slug: 'docs', repo: 'acme/docs', branch: 'main', type: 'static' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ installCmd: '', buildCmd: '', publicDir: '', sharedPaths: [], port: null });

    await app.close();
  });

  it('allocates increasing ports for successive node/nextjs projects', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    const first = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: NODE_PAYLOAD });
    const second = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { ...NODE_PAYLOAD, slug: 'app2', name: 'App 2' },
    });

    expect(first.json().port).toBe(3001);
    expect(second.json().port).toBe(3002);

    await app.close();
  });

  it('rejects an invalid slug with 400', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { ...NODE_PAYLOAD, slug: 'UPPER CASE' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('rejects a repo not in owner/name format with 400', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { ...NODE_PAYLOAD, repo: 'not-a-valid-repo' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it.each(['../etc', 'a b', '/etc', 'public/../../etc', 'public;rm -rf /'])(
    'rejects an unsafe publicDir with 400 (%s) — config injection / path traversal (B1)',
    async (publicDir) => {
      const { app, cookie } = await buildProjectsTestApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { cookie },
        payload: { ...NODE_PAYLOAD, publicDir },
      });

      expect(res.statusCode).toBe(400);

      await app.close();
    },
  );

  it.each(RESERVED_SLUGS)('rejects the reserved slug "%s" with 409 (B3)', async (slug) => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { ...NODE_PAYLOAD, slug },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('this name is reserved');

    const list = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    expect(list.json()).toEqual([]);

    await app.close();
  });

  it('rejects a duplicate slug with 409', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: NODE_PAYLOAD });
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { ...NODE_PAYLOAD, name: 'Another API' },
    });

    expect(res.statusCode).toBe(409);

    await app.close();
  });

  describe('dns outcome (plan Task 5 / spec §3 "New Project DNS")', () => {
    it('the 201 body includes dns:{attempted:true, created:true, existed:false} for a fresh record', async () => {
      const { app, cookie } = await buildProjectsTestApp();

      const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: NODE_PAYLOAD });

      expect(res.statusCode).toBe(201);
      expect(res.json().dns).toEqual({ attempted: true, created: true, existed: false });

      await app.close();
    });

    it('reports existed:true when an A record for the slug is already there', async () => {
      const { app, cookie, dns } = await buildProjectsTestApp();
      await dns.createARecord('app.apps.example.com', '203.0.113.10');

      const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: NODE_PAYLOAD });

      expect(res.statusCode).toBe(201);
      expect(res.json().dns).toEqual({ attempted: true, created: false, existed: true });

      await app.close();
    });

    it('reports attempted:false when no DNS client is configured (app.dns() returns null)', async () => {
      const dataDir = tmpDataDir();
      const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir, SHIPWAY_APPS_DIR: path.join(dataDir, 'apps') });
      const sysops = new DevSysOps(path.join(dataDir, 'system'));
      const app = await buildApp(cfg, { sysops, dns: () => null });

      const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
      const cookie = sessionCookie(create);
      await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { cookie },
        payload: { base_domain: 'apps.example.com', server_ip: '203.0.113.10' },
      });

      const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: NODE_PAYLOAD });

      expect(res.statusCode).toBe(201);
      expect(res.json().dns).toEqual({ attempted: false, created: false, existed: false });

      await app.close();
    });
  });

  it('returns 502 with step info and deletes the row when base_domain/server_ip are unset', async () => {
    const { app, cookie } = await buildProjectsTestApp({ configureDomain: false });

    const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: NODE_PAYLOAD });

    expect(res.statusCode).toBe(502);
    expect(res.json().step).toBe('settings');

    const list = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    expect(list.json()).toEqual([]);

    await app.close();
  });

  it('unauthenticated requests are 401', async () => {
    const { app } = await buildProjectsTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: NODE_PAYLOAD });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('on failure at the app-unit step, deprovisions everything already created (vhost + DNS + dirs) and deletes the row, not just the row', async () => {
    const { app, cookie, sysops, dns, dataDir } = await buildProjectsTestApp({
      makeSysOps: (root) => new DaemonReloadFailsSysOps(root),
    });

    const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: NODE_PAYLOAD });

    expect(res.statusCode).toBe(502);

    // The DNS record and vhost were created before the app-unit step failed — both must be torn
    // down, not just the DB row deleted out from under live/orphaned host state.
    expect(dns.records.has('app.apps.example.com')).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'system/etc/nginx/sites-available/shipway-app.conf'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'system/etc/nginx/sites-enabled/shipway-app.conf'))).toBe(false);
    expect(sysops.calls.some((c) => c.startsWith('removeFile /etc/nginx/sites-available/shipway-app.conf'))).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    expect(list.json()).toEqual([]);

    await app.close();
  });
});

describe('POST /api/projects — repoUrl source (Task 8)', () => {
  it('creates with repoUrl when github is not configured, provisions it, and records an audit row (201)', async () => {
    const { app, cookie, sysops, dns } = await buildProjectsTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: {
        name: 'External',
        slug: 'external',
        repoUrl: 'https://git.example.com/acme/external.git',
        branch: 'main',
        type: 'static',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.repo).toBe('');
    expect(body.repoUrl).toBe('https://git.example.com/acme/external.git');

    // Provisioning side effects ran exactly as they would for a repo-sourced project.
    expect(dns.records.get('external.apps.example.com')).toBe('203.0.113.10');
    expect(sysops.calls.some((c) => c.startsWith('installFile /etc/nginx/sites-available/shipway-external.conf'))).toBe(true);

    const audit = app.db.select().from(auditEvents).orderBy(desc(auditEvents.id)).limit(1).get();
    expect(audit).toMatchObject({ action: 'project.create', targetType: 'project', targetName: 'external' });

    await app.close();
  });

  it('accepts a repoUrl with embedded credentials', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { ...NODE_PAYLOAD, repo: undefined, repoUrl: 'https://x-access-token:ghp_abc123@github.com/acme/private.git' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().repoUrl).toBe('https://x-access-token:ghp_abc123@github.com/acme/private.git');

    await app.close();
  });

  it('rejects a request with both repo and repoUrl (400)', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { ...NODE_PAYLOAD, repoUrl: 'https://example.com/acme/app.git' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('rejects a request with neither repo nor repoUrl (400)', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const { repo: _repo, ...withoutRepo } = NODE_PAYLOAD;

    const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: withoutRepo });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it.each([
    'not-a-url',
    'ftp://example.com/acme/app.git',
    'git@github.com:acme/app.git',
    'https://exa mple.com/acme/app.git',
    'https://example.com/acme/app.git\n',
    `https://example.com/${'a'.repeat(500)}.git`,
  ])('rejects an invalid repoUrl with 400 (%s)', async (repoUrl) => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { ...NODE_PAYLOAD, repo: undefined, repoUrl },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });
});

describe('GET /api/projects', () => {
  it('lists projects with lastDeployment: null when none exist', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });

    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].lastDeployment).toBeNull();

    await app.close();
  });

  it('joins the latest deployment (status, finishedAt, commitSha) per project', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const projectId = create.json().id as number;

    app.db
      .insert(deployments)
      .values({ projectId, status: 'success', trigger: 'manual', commitSha: 'aaa111', finishedAt: 1000 })
      .run();
    app.db
      .insert(deployments)
      .values({ projectId, status: 'failed', trigger: 'manual', commitSha: 'bbb222', finishedAt: 2000 })
      .run();

    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    const body = res.json();

    expect(body[0].lastDeployment).toMatchObject({ status: 'failed', commitSha: 'bbb222', finishedAt: 2000 });

    await app.close();
  });
});

describe('GET /api/projects/:id', () => {
  it('returns a single project', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const res = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, slug: 'shop' });

    await app.close();
  });

  it('404s for an unknown id', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/projects/999999', headers: { cookie } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe('PATCH /api/projects/:id', () => {
  it('updates an editable field', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      headers: { cookie },
      payload: { name: 'Shop Renamed', autoDeploy: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Shop Renamed', autoDeploy: false });

    await app.close();
  });

  it('refuses to enable basic auth without a username and password — enabling with nothing to enforce would render an auth_basic_user_file that does not exist', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const bare = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, headers: { cookie }, payload: { authEnabled: true } });
    expect(bare.statusCode).toBe(400);
    expect(bare.json()).toEqual({ error: 'authEnabled requires authUser and a password' });

    const userOnly = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      headers: { cookie },
      payload: { authEnabled: true, authUser: 'client' },
    });
    expect(userOnly.statusCode).toBe(400);

    await app.close();
  });

  it('stores the basic-auth password as a hash and never returns it — the client only learns that one is set', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      headers: { cookie },
      payload: { authEnabled: true, authUser: 'client', authPassword: 'hunter2' },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ authEnabled: true, authUser: 'client', authPasswordSet: true });
    expect(body.authHash).toBeUndefined();
    expect(body.authPassword).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('hunter2');

    // GET must redact it too, not just the PATCH response.
    const get = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie } });
    const fetched = get.json() as Record<string, unknown>;
    expect(fetched.authHash).toBeUndefined();
    expect(fetched.authPasswordSet).toBe(true);

    await app.close();
  });

  it('rejects a username that would break the htpasswd line format', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    for (const authUser of ['has space', 'colon:here', 'sl/ash']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${id}`,
        headers: { cookie },
        payload: { authEnabled: true, authUser, authPassword: 'hunter2' },
      });
      expect(res.statusCode, authUser).toBe(400);
    }

    await app.close();
  });

  it('rejects attempts to change the immutable slug field with 400', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      headers: { cookie },
      payload: { slug: 'new-slug' },
    });

    expect(res.statusCode).toBe(400);

    const check = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie } });
    expect(check.json().slug).toBe('shop');

    await app.close();
  });

  it('rejects attempts to change the immutable repo/type fields with 400', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const repoRes = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      headers: { cookie },
      payload: { repo: 'acme/other' },
    });
    expect(repoRes.statusCode).toBe(400);

    const typeRes = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      headers: { cookie },
      payload: { type: 'static' },
    });
    expect(typeRes.statusCode).toBe(400);

    await app.close();
  });

  it.each(['../etc', 'a b', '/etc', 'public/../../etc'])(
    'rejects an unsafe publicDir with 400 (%s) — config injection / path traversal (B1)',
    async (publicDir) => {
      const { app, cookie } = await buildProjectsTestApp();
      const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
      const id = create.json().id as number;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${id}`,
        headers: { cookie },
        payload: { publicDir },
      });

      expect(res.statusCode).toBe(400);

      const check = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie } });
      expect(check.json().publicDir).toBe('public');

      await app.close();
    },
  );

  it('re-renders and reinstalls the vhost when phpVersion changes', async () => {
    const { app, cookie, sysops } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;
    sysops.calls.length = 0;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      headers: { cookie },
      payload: { phpVersion: '8.4' },
    });

    expect(res.statusCode).toBe(200);
    expect(sysops.calls.some((c) => c.startsWith('installFile /etc/nginx/sites-available/shipway-shop.conf'))).toBe(true);
    expect(sysops.calls).toContain('reloadNginx');

    await app.close();
  });

  it('404s for an unknown id', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/999999',
      headers: { cookie },
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe('DELETE /api/projects/:id', () => {
  it('requires body {confirmName} to match the slug, else 400', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}`,
      headers: { cookie },
      payload: { confirmName: 'wrong-name' },
    });

    expect(res.statusCode).toBe(400);

    const check = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie } });
    expect(check.statusCode).toBe(200);

    await app.close();
  });

  it('deprovisions and removes the row on a matching confirmName (204)', async () => {
    const { app, cookie, sysops, dns } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${id}`,
      headers: { cookie },
      payload: { confirmName: 'shop' },
    });

    expect(res.statusCode).toBe(204);
    expect(dns.records.has('shop.apps.example.com')).toBe(false);
    expect(sysops.calls.some((c) => c.startsWith('removeFile /etc/nginx/sites-available/shipway-shop.conf'))).toBe(true);

    const check = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie } });
    expect(check.statusCode).toBe(404);

    await app.close();
  });
});

describe('project env', () => {
  it('GET returns an empty string before anything is set', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const res = await app.inject({ method: 'GET', url: `/api/projects/${id}/env`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ content: '' });

    await app.close();
  });

  it('PUT encrypts content at rest and GET decrypts it back', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;
    const envText = 'APP_KEY=base64:supersecret\nDB_PASSWORD=hunter2\n';

    const put = await app.inject({ method: 'PUT', url: `/api/projects/${id}/env`, headers: { cookie }, payload: { content: envText } });
    expect(put.statusCode).toBe(200);
    // Nothing has been deployed in this test, so there is no release for the env to reach — the
    // save still succeeds, and says so rather than claiming to be live.
    expect(put.json()).toEqual({ applied: false, reason: 'never-deployed', workersRestarted: 0 });

    const row = app.db.select({ envEncrypted: projects.envEncrypted }).from(projects).where(eq(projects.id, id)).get();
    expect(row?.envEncrypted).toBeInstanceOf(Buffer);
    expect(row?.envEncrypted?.toString('utf8')).not.toBe(envText);
    expect(row?.envEncrypted?.includes('hunter2')).toBe(false);

    const get = await app.inject({ method: 'GET', url: `/api/projects/${id}/env`, headers: { cookie } });
    expect(get.json()).toEqual({ content: envText });

    await app.close();
  });
});

describe('PUT /api/projects/:id/env — applying to the running release', () => {
  /** Fakes what a deploy leaves behind: a release directory with `.env` symlinked to `shared/.env`,
   * and the `current` symlink pointing at it. Enough for `applyEnvToRunning` to consider the
   * project live, without running the pipeline. */
  function fakeRelease(app: FastifyInstance, slug: string): { sharedEnv: string; releaseEnv: string } {
    const dir = path.join(app.cfg.appsDir, slug);
    const shared = path.join(dir, 'shared');
    const release = path.join(dir, 'releases', '20260101_000000');
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(release, { recursive: true });
    const sharedEnv = path.join(shared, '.env');
    fs.writeFileSync(sharedEnv, 'OLD=value\n', 'utf8');
    const releaseEnv = path.join(release, '.env');
    fs.symlinkSync(sharedEnv, releaseEnv);
    fs.symlinkSync(release, path.join(dir, 'current'));
    return { sharedEnv, releaseEnv };
  }

  it('rewrites shared/.env and reloads php-fpm, so the live release sees it through its symlink', async () => {
    const { app, cookie, sysops } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;
    const slug = create.json().slug as string;
    const { releaseEnv } = fakeRelease(app, slug);
    sysops.calls.length = 0;

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(id)}/env`,
      headers: { cookie },
      payload: { content: 'QUEUE_CONNECTION=redis\n' },
    });

    expect(put.statusCode).toBe(200);
    // A Laravel project is seeded with a 2-process queue worker at creation
    // (`seedLaravelDefaults`), so "no workers" is no longer the baseline for a php project.
    expect(put.json()).toEqual({ applied: true, workersRestarted: 2 });
    // Read through the RELEASE's symlink, which is the path the running app actually opens.
    expect(fs.readFileSync(releaseEnv, 'utf8')).toContain('QUEUE_CONNECTION=redis');
    expect(sysops.calls).toContain('reloadPhpFpm 8.3');

    await app.close();
  });

  it('restarts every worker instance, since EnvironmentFile is only read at process start', async () => {
    const { app, cookie, sysops } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;
    const slug = create.json().slug as string;
    fakeRelease(app, slug);
    await app.inject({
      method: 'POST',
      url: `/api/projects/${String(id)}/workers`,
      headers: { cookie },
      payload: { name: 'app-queue', command: 'php artisan queue:work redis', processes: 2 },
    });
    sysops.calls.length = 0;

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(id)}/env`,
      headers: { cookie },
      payload: { content: 'QUEUE_CONNECTION=redis\n' },
    });

    // 4 = this test's own 2-process `app-queue` plus the 2-process `queue` worker seeded at creation.
    expect(put.json()).toEqual({ applied: true, workersRestarted: 4 });
    expect(sysops.calls).toContain(`unitAction restart shipway-worker-${slug}-app-queue@1.service`);
    expect(sysops.calls).toContain(`unitAction restart shipway-worker-${slug}-app-queue@2.service`);
    expect(sysops.calls).toContain(`unitAction restart shipway-worker-${slug}-queue@1.service`);

    await app.close();
  });

  it('stands off while a deploy is in flight rather than racing it for the same file', async () => {
    const { app, cookie, sysops } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;
    const slug = create.json().slug as string;
    const { sharedEnv } = fakeRelease(app, slug);
    app.db.insert(deployments).values({ projectId: id, status: 'running', trigger: 'manual', logPath: '' }).run();
    sysops.calls.length = 0;

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(id)}/env`,
      headers: { cookie },
      payload: { content: 'QUEUE_CONNECTION=redis\n' },
    });

    // The deploy writes shared/.env itself, from this same stored env — so the save is not lost,
    // it just isn't applied twice by two writers.
    expect(put.json()).toEqual({ applied: false, reason: 'deploy-in-flight', workersRestarted: 0 });
    expect(fs.readFileSync(sharedEnv, 'utf8')).toBe('OLD=value\n');
    expect(sysops.calls).toEqual([]);

    await app.close();
  });

  it('keeps the saved env when the restart fails, and says the restart is what broke', async () => {
    const { app, cookie } = await buildProjectsTestApp({
      makeSysOps: (root) =>
        new (class extends DevSysOps {
          async reloadPhpFpm(): Promise<void> {
            throw new Error('Job for php8.3-fpm.service failed');
          }
        })(root),
    });
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;
    const { releaseEnv } = fakeRelease(app, create.json().slug as string);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(id)}/env`,
      headers: { cookie },
      payload: { content: 'QUEUE_CONNECTION=redis\n' },
    });

    // Losing the saved env because a unit was wedged would be the worse of the two failures.
    expect(put.statusCode).toBe(200);
    expect(put.json().restartError).toContain('php8.3-fpm');
    expect(fs.readFileSync(releaseEnv, 'utf8')).toContain('QUEUE_CONNECTION=redis');
    const get = await app.inject({ method: 'GET', url: `/api/projects/${String(id)}/env`, headers: { cookie } });
    expect(get.json().content).toBe('QUEUE_CONNECTION=redis\n');

    await app.close();
  });

  it('records whether it applied in the audit trail', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;
    fakeRelease(app, create.json().slug as string);

    await app.inject({ method: 'PUT', url: `/api/projects/${String(id)}/env`, headers: { cookie }, payload: { content: 'A=1\n' } });

    const row = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'project.env.update')).get();
    expect(JSON.parse(row?.meta ?? '{}')).toMatchObject({ applied: true });

    await app.close();
  });
});

describe('GET /api/projects/:id/env/preview', () => {
  it('returns the mailpit managed block by default', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const res = await app.inject({ method: 'GET', url: `/api/projects/${id}/env/preview`, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const { content } = res.json() as { content: string };
    expect(content).toContain('MAIL_HOST=127.0.0.1');
    expect(content).toContain('SMTP_PORT=1025');
    expect(content).toContain('# >>> shipway managed');

    await app.close();
  });

  it('returns the decrypted custom SMTP config once mode is "custom"', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/smtp`,
      headers: { cookie },
      payload: { mode: 'custom', config: { host: 'smtp.example.com', port: 587, username: 'bot', password: 'hunter2' } },
    });

    const res = await app.inject({ method: 'GET', url: `/api/projects/${id}/env/preview`, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const { content } = res.json() as { content: string };
    expect(content).toContain('MAIL_HOST=smtp.example.com');
    expect(content).toContain('MAIL_USERNAME=bot');
    expect(content).toContain('MAIL_PASSWORD=hunter2');

    await app.close();
  });

  it('returns SES vars with a derived host once mode is "ses"', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/smtp`,
      headers: { cookie },
      payload: { mode: 'ses', config: { region: 'eu-central-1', username: 'AKIAEXAMPLE', password: 'ses-pass', fromAddress: 'noreply@example.com' } },
    });

    const res = await app.inject({ method: 'GET', url: `/api/projects/${id}/env/preview`, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const { content } = res.json() as { content: string };
    expect(content).toContain('MAIL_HOST=email-smtp.eu-central-1.amazonaws.com');
    expect(content).toContain('MAIL_PORT=587');
    expect(content).toContain('MAIL_ENCRYPTION=tls');
    expect(content).toContain('MAIL_USERNAME=AKIAEXAMPLE');
    expect(content).toContain('MAIL_FROM_ADDRESS=noreply@example.com');

    await app.close();
  });

  it('previews only the SQLite fallback when SMTP mode is "none" — a php project always has that', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;
    const slug = create.json().slug as string;

    await app.inject({ method: 'PUT', url: `/api/projects/${id}/smtp`, headers: { cookie }, payload: { mode: 'none' } });

    const res = await app.inject({ method: 'GET', url: `/api/projects/${id}/env/preview`, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const { content } = res.json() as { content: string };
    // No MAIL_* at all, but the managed DB_DATABASE remains: with no database attached, this is the
    // SQLite file the project actually runs on.
    expect(content).not.toContain('MAIL_');
    expect(content).toContain(`DB_DATABASE=${app.cfg.appsDir}/${slug}/shared/database.sqlite`);

    await app.close();
  });

  it('404s for an unknown id', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/projects/999999/env/preview', headers: { cookie } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe('PUT /api/projects/:id/smtp — ses mode', () => {
  it('rejects ses without a config', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const res = await app.inject({ method: 'PUT', url: `/api/projects/${id}/smtp`, headers: { cookie }, payload: { mode: 'ses' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('region');

    await app.close();
  });

  it('rejects ses missing any required credential field', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;
    const full = { region: 'us-east-1', username: 'u', password: 'p', fromAddress: 'a@b.com' };

    for (const missing of ['region', 'username', 'password', 'fromAddress'] as const) {
      const config: Record<string, string> = { ...full };
      delete config[missing];
      const res = await app.inject({ method: 'PUT', url: `/api/projects/${id}/smtp`, headers: { cookie }, payload: { mode: 'ses', config } });
      expect(res.statusCode, missing).toBe(400);
    }

    await app.close();
  });

  it('rejects a ses region that is not a well-formed AWS region code', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    for (const region of ['us-east-1.evil.example.com', 'evil.example.com', 'US-EAST-1', '   ']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/projects/${id}/smtp`,
        headers: { cookie },
        payload: { mode: 'ses', config: { region, username: 'u', password: 'p', fromAddress: 'a@b.com' } },
      });
      expect(res.statusCode, region).toBe(400);
    }

    // Nothing was persisted by any of the rejected attempts.
    const row = app.db.select().from(projects).where(eq(projects.id, id)).get();
    expect(row?.smtpMode).toBe('mailpit');

    await app.close();
  });

  it('accepts a complete ses config, stores it encrypted, and never returns it', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/smtp`,
      headers: { cookie },
      payload: { mode: 'ses', config: { region: 'us-east-1', username: 'AKIAEXAMPLE', password: 'ses-pass', fromAddress: 'a@b.com' } },
    });
    // 200 with an apply result, not 204: this writes the project's .env, so it now also applies
    // it to the running release (services/envapply.ts).
    expect(res.statusCode).toBe(200);

    const row = app.db.select().from(projects).where(eq(projects.id, id)).get();
    expect(row?.smtpMode).toBe('ses');
    expect(row?.smtpConfigEncrypted).not.toBeNull();
    // Stored ciphertext, not plaintext.
    expect(row?.smtpConfigEncrypted?.toString('utf8')).not.toContain('ses-pass');
    expect(JSON.parse(app.secretBox.decrypt(row!.smtpConfigEncrypted!))).toMatchObject({ region: 'us-east-1', password: 'ses-pass' });

    // The credential never comes back out through the API.
    const get = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: { cookie } });
    expect(JSON.stringify(get.json())).not.toContain('ses-pass');

    await app.close();
  });

  it('clears the stored config when switching from ses back to mailpit', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/smtp`,
      headers: { cookie },
      payload: { mode: 'ses', config: { region: 'us-east-1', username: 'u', password: 'p', fromAddress: 'a@b.com' } },
    });
    await app.inject({ method: 'PUT', url: `/api/projects/${id}/smtp`, headers: { cookie }, payload: { mode: 'mailpit' } });

    const row = app.db.select().from(projects).where(eq(projects.id, id)).get();
    expect(row?.smtpMode).toBe('mailpit');
    expect(row?.smtpConfigEncrypted).toBeNull();

    await app.close();
  });
});

describe('PUT /api/projects/:id/smtp', () => {
  it('rejects mode "custom" without a config with 400', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const res = await app.inject({ method: 'PUT', url: `/api/projects/${id}/smtp`, headers: { cookie }, payload: { mode: 'custom' } });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('accepts mode "custom" with a config, stores it encrypted (204)', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${id}/smtp`,
      headers: { cookie },
      payload: { mode: 'custom', config: { host: 'smtp.example.com', port: 587, username: 'bot', password: 'hunter2' } },
    });

    // 200 with an apply result, not 204: this writes the project's .env, so it now also applies
    // it to the running release (services/envapply.ts).
    expect(res.statusCode).toBe(200);
    const row = app.db
      .select({ smtpMode: projects.smtpMode, smtpConfigEncrypted: projects.smtpConfigEncrypted })
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    expect(row?.smtpMode).toBe('custom');
    expect(row?.smtpConfigEncrypted).toBeInstanceOf(Buffer);
    expect(row?.smtpConfigEncrypted?.includes('hunter2')).toBe(false);

    await app.close();
  });

  it('accepts mode "mailpit" without a config (204)', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const res = await app.inject({ method: 'PUT', url: `/api/projects/${id}/smtp`, headers: { cookie }, payload: { mode: 'mailpit' } });
    // 200 with an apply result, not 204: the SMTP mode renders part of the project's .env, so saving
    // it now writes and applies that file the same way the Environment tab does.
    expect(res.statusCode).toBe(200);

    await app.close();
  });
});

/**
 * A Laravel project needs two things nobody new to it knows are required: the every-minute
 * `schedule:run` cron (without which `$schedule` never fires at all) and a queue worker. Both are
 * seeded at creation and remain ordinary, editable rows.
 */
describe('POST /api/projects — Laravel defaults', () => {
  it('seeds the every-minute scheduler cron, with the php version pinned', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const rows = app.db.select().from(cronJobs).where(eq(cronJobs.projectId, id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.schedule).toBe('* * * * *');
    // Rewritten to the project's pinned version, exactly as a hand-added cron would be.
    expect(rows[0]?.command).toBe('php8.3 artisan schedule:run');

    await app.close();
  });

  it('seeds a queue worker with a shutdown grace period, and no hardcoded queue connection', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const rows = app.db.select().from(workers).where(eq(workers.projectId, id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'queue', processes: 2, autoStart: true, restartPolicy: 'always', stopTimeoutSec: 120 });
    expect(rows[0]?.command).toContain('php artisan queue:work');
    // Naming a connection would break on a host with no redis, where QUEUE_CONNECTION is `sync`.
    expect(rows[0]?.command).not.toContain('redis');

    await app.close();
  });

  it('installs them on the host, not just in the database', async () => {
    const { app, cookie, sysops } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const slug = create.json().slug as string;

    expect(sysops.calls.some((call) => call.startsWith('writeCrontab'))).toBe(true);
    expect(sysops.calls).toContain(`unitAction start shipway-worker-${slug}-queue@1.service`);
    expect(sysops.calls).toContain(`unitAction start shipway-worker-${slug}-queue@2.service`);

    await app.close();
  });

  it('seeds nothing for a non-php project', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: NODE_PAYLOAD });
    const id = create.json().id as number;

    expect(app.db.select().from(cronJobs).where(eq(cronJobs.projectId, id)).all()).toHaveLength(0);
    expect(app.db.select().from(workers).where(eq(workers.projectId, id)).all()).toHaveLength(0);

    await app.close();
  });

  it('leaves them fully editable — they are ordinary rows, not fixed config', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    const workerId = app.db.select().from(workers).where(eq(workers.projectId, id)).all()[0]!.id;
    const cronId = app.db.select().from(cronJobs).where(eq(cronJobs.projectId, id)).all()[0]!.id;

    expect((await app.inject({ method: 'DELETE', url: `/api/workers/${String(workerId)}`, headers: { cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/cron/${String(cronId)}`, headers: { cookie } })).statusCode).toBe(204);
    expect(app.db.select().from(workers).where(eq(workers.projectId, id)).all()).toHaveLength(0);

    await app.close();
  });
});

describe('PATCH /api/projects/:id/subdomain', () => {
  /** Creates a static project and returns its id. `PHP_PAYLOAD`/`NODE_PAYLOAD` both work too — the
   *  move is type-independent, so the cheapest project type is used throughout. */
  async function createStatic(app: FastifyInstance, cookie: string, slug: string): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name: slug, slug, repo: `acme/${slug}`, branch: 'main', type: 'static' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as number;
  }

  it('moves the DNS record and the vhost, and reports what it did', async () => {
    const { app, cookie, dns, dataDir } = await buildProjectsTestApp();
    const id = await createStatic(app, cookie, 'shop');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${String(id)}/subdomain`,
      headers: { cookie },
      payload: { subdomain: 'store' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.project).toMatchObject({ slug: 'shop', subdomain: 'store' });
    expect(body.move).toMatchObject({
      domain: 'store.apps.example.com',
      previousDomain: 'shop.apps.example.com',
      dnsAttempted: true,
      created: true,
      oldRecordRemoved: true,
    });
    expect([...dns.records.keys()]).toEqual(['store.apps.example.com']);

    // The vhost file keeps the slug in its name — only what it serves changed.
    const vhost = fs.readFileSync(path.join(dataDir, 'system/etc/nginx/sites-available/shipway-shop.conf'), 'utf8');
    expect(vhost).toContain('store.apps.example.com');

    const audit = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'project.subdomain.update')).get();
    expect(JSON.parse(audit?.meta ?? '{}')).toMatchObject({ from: 'shop.apps.example.com', to: 'store.apps.example.com' });

    await app.close();
  });

  it('stores null (not a copy of the slug) when moved back, so the slug stays the default', async () => {
    const { app, cookie, dns } = await buildProjectsTestApp();
    const id = await createStatic(app, cookie, 'shop');
    await app.inject({ method: 'PATCH', url: `/api/projects/${String(id)}/subdomain`, headers: { cookie }, payload: { subdomain: 'store' } });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${String(id)}/subdomain`,
      headers: { cookie },
      payload: { subdomain: 'shop' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().project.subdomain).toBeNull();
    expect([...dns.records.keys()]).toEqual(['shop.apps.example.com']);

    await app.close();
  });

  it('repoints the old domain in the project env at the new one', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const id = await createStatic(app, cookie, 'shop');
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${String(id)}/env`,
      headers: { cookie },
      payload: { content: 'APP_URL=https://shop.apps.example.com\nSESSION_DOMAIN=shop.apps.example.com\nDB_HOST=127.0.0.1\n' },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${String(id)}/subdomain`,
      headers: { cookie },
      payload: { subdomain: 'store' },
    });
    expect(res.json().envRewritten).toBe(true);

    const env = await app.inject({ method: 'GET', url: `/api/projects/${String(id)}/env`, headers: { cookie } });
    expect(env.json().content).toBe('APP_URL=https://store.apps.example.com\nSESSION_DOMAIN=store.apps.example.com\nDB_HOST=127.0.0.1\n');

    await app.close();
  });

  it('reports envRewritten: false when the old domain was not in the env', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const id = await createStatic(app, cookie, 'shop');
    await app.inject({ method: 'PUT', url: `/api/projects/${String(id)}/env`, headers: { cookie }, payload: { content: 'DB_HOST=127.0.0.1\n' } });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${String(id)}/subdomain`,
      headers: { cookie },
      payload: { subdomain: 'store' },
    });

    expect(res.json().envRewritten).toBe(false);
    const env = await app.inject({ method: 'GET', url: `/api/projects/${String(id)}/env`, headers: { cookie } });
    expect(env.json().content).toBe('DB_HOST=127.0.0.1\n');

    await app.close();
  });

  it('409s on a reserved subdomain, and on one another project already answers to', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const id = await createStatic(app, cookie, 'shop');
    await createStatic(app, cookie, 'blog');

    for (const reserved of RESERVED_SLUGS) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${String(id)}/subdomain`,
        headers: { cookie },
        payload: { subdomain: reserved },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'this name is reserved' });
    }

    const taken = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${String(id)}/subdomain`,
      headers: { cookie },
      payload: { subdomain: 'blog' },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'subdomain already in use' });

    await app.close();
  });

  it('frees the slug of a project that has itself been moved away', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const blogId = await createStatic(app, cookie, 'blog');
    const shopId = await createStatic(app, cookie, 'shop');

    // 'blog' vacates its slug...
    await app.inject({ method: 'PATCH', url: `/api/projects/${String(blogId)}/subdomain`, headers: { cookie }, payload: { subdomain: 'journal' } });
    // ...so 'shop' can take it, even though a row still has `slug: 'blog'`.
    const res = await app.inject({ method: 'PATCH', url: `/api/projects/${String(shopId)}/subdomain`, headers: { cookie }, payload: { subdomain: 'blog' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().move.domain).toBe('blog.apps.example.com');

    await app.close();
  });

  it('400s on a no-op move, an invalid shape, and 404s on an unknown project', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const id = await createStatic(app, cookie, 'shop');

    const noop = await app.inject({ method: 'PATCH', url: `/api/projects/${String(id)}/subdomain`, headers: { cookie }, payload: { subdomain: 'shop' } });
    expect(noop.statusCode).toBe(400);
    expect(noop.json()).toEqual({ error: 'this project already uses that subdomain' });

    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${String(id)}/subdomain`,
      headers: { cookie },
      payload: { subdomain: 'Not A Subdomain' },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({ method: 'PATCH', url: '/api/projects/9999/subdomain', headers: { cookie }, payload: { subdomain: 'store' } });
    expect(missing.statusCode).toBe(404);

    await app.close();
  });

  it('rolls the column back when the host work fails, so the row never claims an unserved domain', async () => {
    // Toggled on only after the project exists, so provisioning succeeds and it is the MOVE's
    // `nginx -t` that fails.
    class ToggleableNginxTestSysOps extends DevSysOps {
      failNginxTest = false;
      async nginxTest(): Promise<{ ok: boolean; output: string }> {
        if (this.failNginxTest) {
          this.calls.push('nginxTest');
          return { ok: false, output: 'nginx: [emerg] duplicate server_name' };
        }
        return super.nginxTest();
      }
    }
    let sysops!: ToggleableNginxTestSysOps;
    const { app, cookie, dns } = await buildProjectsTestApp({
      makeSysOps: (root) => (sysops = new ToggleableNginxTestSysOps(root)),
    });
    const id = await createStatic(app, cookie, 'shop');
    sysops.failNginxTest = true;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${String(id)}/subdomain`,
      headers: { cookie },
      payload: { subdomain: 'store' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'could not move the project', step: 'nginx-test' });
    expect(app.db.select().from(projects).where(eq(projects.id, id)).get()?.subdomain).toBeNull();
    expect([...dns.records.keys()]).toEqual(['shop.apps.example.com']);

    await app.close();
  });

  it('rejects a subdomain sent to the general PATCH route, pointing at the one that moves DNS too', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const id = await createStatic(app, cookie, 'shop');

    const res = await app.inject({ method: 'PATCH', url: `/api/projects/${String(id)}`, headers: { cookie }, payload: { subdomain: 'store' } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'use PATCH /api/projects/:id/subdomain to move a project' });
    expect(app.db.select().from(projects).where(eq(projects.id, id)).get()?.subdomain).toBeNull();

    await app.close();
  });
});
