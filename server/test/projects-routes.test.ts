import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { deployments, projects } from '../src/db/schema.js';
import { RESERVED_SLUGS } from '../src/routes/projects.js';
import { DevSysOps } from '../src/sysops/dev.js';
import { FakeDnsClient } from '../src/services/cloudflare.js';

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
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });
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
      installCmd: 'npm ci',
      buildCmd: 'npm run build',
      startCmd: 'npm start',
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
      installCmd: 'composer install --no-dev --optimize-autoloader --no-interaction',
      buildCmd: '',
      sharedPaths: ['storage', 'uploads'],
      port: null,
    });

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
    expect(put.statusCode).toBe(204);

    const row = app.db.select({ envEncrypted: projects.envEncrypted }).from(projects).where(eq(projects.id, id)).get();
    expect(row?.envEncrypted).toBeInstanceOf(Buffer);
    expect(row?.envEncrypted?.toString('utf8')).not.toBe(envText);
    expect(row?.envEncrypted?.includes('hunter2')).toBe(false);

    const get = await app.inject({ method: 'GET', url: `/api/projects/${id}/env`, headers: { cookie } });
    expect(get.json()).toEqual({ content: envText });

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

  it('returns an empty preview when SMTP mode is "none"', async () => {
    const { app, cookie } = await buildProjectsTestApp();
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: PHP_PAYLOAD });
    const id = create.json().id as number;

    await app.inject({ method: 'PUT', url: `/api/projects/${id}/smtp`, headers: { cookie }, payload: { mode: 'none' } });

    const res = await app.inject({ method: 'GET', url: `/api/projects/${id}/env/preview`, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ content: '' });

    await app.close();
  });

  it('404s for an unknown id', async () => {
    const { app, cookie } = await buildProjectsTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/projects/999999/env/preview', headers: { cookie } });
    expect(res.statusCode).toBe(404);

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

    expect(res.statusCode).toBe(204);
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
    expect(res.statusCode).toBe(204);

    await app.close();
  });
});
