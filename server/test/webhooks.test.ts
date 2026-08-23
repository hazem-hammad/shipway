import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { deployments, projects } from '../src/db/schema.js';
import { setSetting } from '../src/db/settings.js';
import type { DeployQueueDeps } from '../src/deploy/queue.js';
import { FakeDnsClient } from '../src/services/cloudflare.js';
import { DevSysOps } from '../src/sysops/dev.js';

// ---------------------------------------------------------------------------
// fixture / test-double helpers
// ---------------------------------------------------------------------------

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-webhooks-test-'));
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

const WEBHOOK_SECRET = 'top-secret-webhook-key';
const GITHUB_APP_CFG = {
  appId: 123456,
  privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
  webhookSecret: WEBHOOK_SECRET,
};

/** A controllable fake queue `run`: resolves immediately and records every call's deploymentId. */
class FakeRun {
  readonly calls: number[] = [];

  run: DeployQueueDeps['run'] = async (deploymentId) => {
    this.calls.push(deploymentId);
  };
}

interface TestApp {
  app: FastifyInstance;
  cookie: string;
  fakeRun: FakeRun;
  dataDir: string;
}

async function buildWebhookTestApp(opts: { configureGithubApp?: boolean } = {}): Promise<TestApp> {
  const dataDir = tmpDataDir();
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });
  const sysops = new DevSysOps(path.join(dataDir, 'system'));
  const dns = new FakeDnsClient();
  const fakeRun = new FakeRun();
  const app = await buildApp(cfg, { sysops, dns: () => dns, queueRun: fakeRun.run });

  const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
  const cookie = sessionCookie(create);

  await app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: { cookie },
    payload: { base_domain: 'apps.example.com', server_ip: '203.0.113.10' },
  });

  if (opts.configureGithubApp ?? true) {
    setSetting(app.db, 'github_app', GITHUB_APP_CFG);
  }

  return { app, cookie, fakeRun, dataDir };
}

async function createProject(
  app: FastifyInstance,
  cookie: string,
  opts: { slug: string; repo: string; branch?: string; autoDeploy?: boolean },
): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie },
    payload: {
      name: opts.slug,
      slug: opts.slug,
      repo: opts.repo,
      branch: opts.branch ?? 'main',
      type: 'static',
      autoDeploy: opts.autoDeploy ?? true,
    },
  });
  return res.json().id as number;
}

/** Signs `payload` (JSON-encoded) with `secret`, returning the raw bytes and the header value. */
function signPayload(secret: string, payload: unknown): { raw: string; header: string } {
  const raw = JSON.stringify(payload);
  const header = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return { raw, header };
}

const COMMIT_SHA = 'a'.repeat(40);
const DELETED_BRANCH_SHA = '0'.repeat(40);

function pushPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: 'refs/heads/main',
    after: COMMIT_SHA,
    repository: { full_name: 'acme/widgets' },
    head_commit: { message: 'fix the thing' },
    ...overrides,
  };
}

/** Posts a signed webhook payload; `event` sets `X-GitHub-Event`, defaulting to `push`. */
async function postWebhook(
  app: FastifyInstance,
  secret: string,
  payload: unknown,
  opts: { event?: string; sigHeader?: string | null } = {},
): Promise<LightMyRequestResponse> {
  const { raw, header } = signPayload(secret, payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': opts.event ?? 'push',
  };
  if (opts.sigHeader !== null) {
    headers['x-hub-signature-256'] = opts.sigHeader ?? header;
  }
  return app.inject({ method: 'POST', url: '/api/webhooks/github', headers, payload: raw });
}

function eqId(id: number) {
  return eq(deployments.id, id);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/github', () => {
  it('503s when no github_app setting is configured', async () => {
    const { app } = await buildWebhookTestApp({ configureGithubApp: false });

    const res = await postWebhook(app, WEBHOOK_SECRET, pushPayload(), { event: 'ping' });
    expect(res.statusCode).toBe(503);

    await app.close();
  });

  it('401s for a missing signature header', async () => {
    const { app } = await buildWebhookTestApp();

    const res = await postWebhook(app, WEBHOOK_SECRET, pushPayload(), { event: 'ping', sigHeader: null });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('401s for a signature computed with the wrong secret', async () => {
    const { app } = await buildWebhookTestApp();

    const res = await postWebhook(app, 'wrong-secret', pushPayload(), { event: 'ping' });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('200s {ok: true} for a ping event', async () => {
    const { app } = await buildWebhookTestApp();

    const res = await postWebhook(app, WEBHOOK_SECRET, {}, { event: 'ping' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    await app.close();
  });

  it('200s {ignored: true} for an event that is neither ping nor push', async () => {
    const { app } = await buildWebhookTestApp();

    const res = await postWebhook(app, WEBHOOK_SECRET, pushPayload(), { event: 'pull_request' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ignored: true });

    await app.close();
  });

  it('enqueues exactly once for a matching push, with commit sha + message, and returns {deployed: [id]}', async () => {
    const { app, cookie, fakeRun } = await buildWebhookTestApp();
    const projectId = await createProject(app, cookie, { slug: 'widgets', repo: 'acme/widgets', branch: 'main' });

    const res = await postWebhook(app, WEBHOOK_SECRET, pushPayload());
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deployed: number[] };
    expect(body.deployed).toHaveLength(1);
    const deploymentId = body.deployed[0]!;

    const row = app.db.select().from(deployments).where(eqId(deploymentId)).get();
    expect(row).toMatchObject({
      projectId,
      trigger: 'push',
      commitSha: COMMIT_SHA,
      commitMessage: 'fix the thing',
    });

    expect(fakeRun.calls).toEqual([deploymentId]);

    await app.close();
  });

  it('ignores a push to a non-matching branch', async () => {
    const { app, cookie } = await buildWebhookTestApp();
    const projectId = await createProject(app, cookie, { slug: 'widgets', repo: 'acme/widgets', branch: 'main' });

    const res = await postWebhook(app, WEBHOOK_SECRET, pushPayload({ ref: 'refs/heads/develop' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ignored: true });

    const rows = app.db.select().from(deployments).where(eq(deployments.projectId, projectId)).all();
    expect(rows).toHaveLength(0);

    await app.close();
  });

  it('ignores a push when the matching project has autoDeploy disabled', async () => {
    const { app, cookie } = await buildWebhookTestApp();
    const projectId = await createProject(app, cookie, { slug: 'widgets', repo: 'acme/widgets', branch: 'main', autoDeploy: false });

    const res = await postWebhook(app, WEBHOOK_SECRET, pushPayload());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ignored: true });

    const rows = app.db.select().from(deployments).where(eq(deployments.projectId, projectId)).all();
    expect(rows).toHaveLength(0);

    await app.close();
  });

  it('ignores a deleted-branch push (after = all zeros), even for an otherwise-matching project', async () => {
    const { app, cookie } = await buildWebhookTestApp();
    await createProject(app, cookie, { slug: 'widgets', repo: 'acme/widgets', branch: 'main' });

    const res = await postWebhook(app, WEBHOOK_SECRET, pushPayload({ after: DELETED_BRANCH_SHA }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ignored: true });

    await app.close();
  });

  it('enqueues for every matching project when two projects share the same repo + branch', async () => {
    const { app, cookie, fakeRun } = await buildWebhookTestApp();
    const projectA = await createProject(app, cookie, { slug: 'widgets-a', repo: 'acme/widgets', branch: 'main' });
    const projectB = await createProject(app, cookie, { slug: 'widgets-b', repo: 'acme/widgets', branch: 'main' });

    const res = await postWebhook(app, WEBHOOK_SECRET, pushPayload());
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deployed: number[] };
    expect(body.deployed).toHaveLength(2);

    const projectIds = body.deployed.map((id) => {
      const row = app.db.select({ projectId: deployments.projectId }).from(deployments).where(eqId(id)).get();
      return row?.projectId;
    });
    expect(projectIds.sort()).toEqual([projectA, projectB].sort());
    expect(fakeRun.calls.sort()).toEqual([...body.deployed].sort());

    await app.close();
  });

  it('does not leak its raw-body content-type parser to other routes — normal JSON routes still parse objects', async () => {
    const { app, cookie } = await buildWebhookTestApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { notify_on_success: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ notify_on_success: true });

    await app.close();
  });
});
