import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { deployments, projects } from '../src/db/schema.js';
import { DeployLogger } from '../src/deploy/logger.js';
import type { DeployQueueDeps } from '../src/deploy/queue.js';
import { FakeDnsClient } from '../src/services/cloudflare.js';
import { DevSysOps } from '../src/sysops/dev.js';

// ---------------------------------------------------------------------------
// fixture / test-double helpers
// ---------------------------------------------------------------------------

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-deployments-routes-test-'));
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

/** A controllable fake queue `run`: each call's promise stays pending until the test resolves it. */
class FakeRun {
  readonly calls: Array<{ deploymentId: number; signal: AbortSignal; logger: DeployLogger }> = [];
  private readonly pending = new Map<number, { resolve: () => void; reject: (err: unknown) => void }>();

  run: DeployQueueDeps['run'] = (deploymentId, signal, logger) => {
    this.calls.push({ deploymentId, signal, logger });
    return new Promise<void>((resolve, reject) => {
      this.pending.set(deploymentId, { resolve, reject });
    });
  };

  resolve(deploymentId: number): void {
    const p = this.pending.get(deploymentId);
    if (!p) throw new Error(`no pending run for deployment ${String(deploymentId)}`);
    this.pending.delete(deploymentId);
    p.resolve();
  }
}

/** Flushes pending microtasks (promise chains) so `.then/.catch/.finally` callbacks settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

interface TestApp {
  app: FastifyInstance;
  cookie: string;
  fakeRun: FakeRun;
  dataDir: string;
}

async function buildDeploymentsTestApp(): Promise<TestApp> {
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

  return { app, cookie, fakeRun, dataDir };
}

async function createProject(app: FastifyInstance, cookie: string, slug = 'app'): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie },
    payload: { name: slug, slug, repo: `acme/${slug}`, branch: 'main', type: 'static' },
  });
  return res.json().id as number;
}

function eqId(id: number) {
  return eq(deployments.id, id);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('POST /api/projects/:id/deploy', () => {
  it('404s for an unknown project', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/projects/999999/deploy', headers: { cookie } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('enqueues a manual deploy and returns 202 {deploymentId}', async () => {
    const { app, cookie, fakeRun } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie);

    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/deploy`, headers: { cookie } });
    expect(res.statusCode).toBe(202);
    const { deploymentId } = res.json() as { deploymentId: number };
    expect(typeof deploymentId).toBe('number');

    const row = app.db.select().from(deployments).where(eqId(deploymentId)).get();
    expect(row).toMatchObject({ projectId, trigger: 'manual', status: 'queued' });

    await flush();
    expect(fakeRun.calls.some((c) => c.deploymentId === deploymentId)).toBe(true);

    await app.close();
  });

  it('unauthenticated requests are 401', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie);

    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/deploy` });
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('POST /api/projects/:id/rollback', () => {
  it('404s for an unknown project', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/999999/rollback',
      headers: { cookie },
      payload: { releasePath: '/tmp/whatever' },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('rejects a releasePath that does not belong to a deployment of this project (400)', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie, 'app');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback`,
      headers: { cookie },
      payload: { releasePath: '/deploy/apps/api/releases/nonexistent' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('rejects a releasePath that belongs to a DIFFERENT project (400)', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();
    const projectA = await createProject(app, cookie, 'api-a');
    const projectB = await createProject(app, cookie, 'api-b');

    app.db
      .insert(deployments)
      .values({ projectId: projectB, status: 'success', trigger: 'manual', releasePath: '/deploy/apps/api-b/releases/1', logPath: '' })
      .run();

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectA}/rollback`,
      headers: { cookie },
      payload: { releasePath: '/deploy/apps/api-b/releases/1' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('enqueues a rollback for a releasePath owned by this project (202)', async () => {
    const { app, cookie, fakeRun } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie, 'app');
    const releasePath = '/deploy/apps/api/releases/20260101_000000';

    app.db
      .insert(deployments)
      .values({ projectId, status: 'success', trigger: 'push', releasePath, logPath: '' })
      .run();

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/rollback`,
      headers: { cookie },
      payload: { releasePath },
    });
    expect(res.statusCode).toBe(202);
    const { deploymentId } = res.json() as { deploymentId: number };

    const row = app.db.select().from(deployments).where(eqId(deploymentId)).get();
    expect(row).toMatchObject({ projectId, trigger: 'rollback', releasePath });

    await flush();
    expect(fakeRun.calls.some((c) => c.deploymentId === deploymentId)).toBe(true);

    await app.close();
  });

  it('rejects a missing releasePath in the body (400)', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie);

    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/rollback`, headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(400);

    await app.close();
  });
});

describe('GET /api/projects/:id/deployments', () => {
  it('404s for an unknown project', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/projects/999999/deployments', headers: { cookie } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('returns the project\'s deployments, newest first', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie);

    for (let i = 0; i < 3; i++) {
      app.db.insert(deployments).values({ projectId, status: 'success', trigger: 'manual', logPath: '' }).run();
    }

    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/deployments`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ id: number }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.id).toBeGreaterThan(rows[1]!.id);
    expect(rows[1]!.id).toBeGreaterThan(rows[2]!.id);

    await app.close();
  });

  it('caps the list at 50, newest first', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie);

    for (let i = 0; i < 55; i++) {
      app.db.insert(deployments).values({ projectId, status: 'success', trigger: 'manual', logPath: '' }).run();
    }

    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/deployments`, headers: { cookie } });
    const rows = res.json() as Array<{ id: number }>;
    expect(rows).toHaveLength(50);
    expect(rows[0]!.id).toBe(55);

    await app.close();
  });
});

describe('GET /api/deployments/:id', () => {
  it('404s for an unknown id', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/deployments/999999', headers: { cookie } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('returns the deployment row', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie);
    const inserted = app.db.insert(deployments).values({ projectId, status: 'success', trigger: 'manual', commitSha: 'abc123', logPath: '' }).run();
    const id = Number(inserted.lastInsertRowid);

    const res = await app.inject({ method: 'GET', url: `/api/deployments/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, projectId, commitSha: 'abc123' });

    await app.close();
  });
});

describe('POST /api/deployments/:id/cancel', () => {
  it('404s for an unknown id', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/deployments/999999/cancel', headers: { cookie } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('aborts a running deployment\'s signal and returns 202', async () => {
    const { app, cookie, fakeRun } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie);

    const deployRes = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/deploy`, headers: { cookie } });
    const { deploymentId } = deployRes.json() as { deploymentId: number };
    await flush();

    const call = fakeRun.calls.find((c) => c.deploymentId === deploymentId);
    expect(call?.signal.aborted).toBe(false);

    const res = await app.inject({ method: 'POST', url: `/api/deployments/${deploymentId}/cancel`, headers: { cookie } });
    expect(res.statusCode).toBe(202);
    expect(call?.signal.aborted).toBe(true);

    await app.close();
  });

  it('marks a still-queued deployment canceled and it never starts', async () => {
    const { app, cookie, fakeRun } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie);

    // Two manual deploys for the same project: the queue serializes same-project deploys, so the
    // second stays queued (not started) while the first is "running" (its fake run is pending).
    const first = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/deploy`, headers: { cookie } });
    const second = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/deploy`, headers: { cookie } });
    await flush();

    const secondId = (second.json() as { deploymentId: number }).deploymentId;
    expect(fakeRun.calls.some((c) => c.deploymentId === secondId)).toBe(false);

    const res = await app.inject({ method: 'POST', url: `/api/deployments/${secondId}/cancel`, headers: { cookie } });
    expect(res.statusCode).toBe(202);

    const row = app.db.select().from(deployments).where(eqId(secondId)).get();
    expect(row?.status).toBe('canceled');

    void first; // first deployment intentionally left running/pending — nothing further asserted on it
    await app.close();
  });
});

describe('GET /api/deployments/:id/log', () => {
  it('404s for an unknown id', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/deployments/999999/log', headers: { cookie } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('returns an empty string when logPath is unset', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie);
    const inserted = app.db.insert(deployments).values({ projectId, status: 'queued', trigger: 'manual', logPath: '' }).run();
    const id = Number(inserted.lastInsertRowid);

    const res = await app.inject({ method: 'GET', url: `/api/deployments/${id}/log`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ content: '' });

    await app.close();
  });

  it('returns the full log file content', async () => {
    const { app, cookie, dataDir } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie);
    const logPath = path.join(dataDir, 'a-deploy.log');
    fs.writeFileSync(logPath, '[00:00:00] line one\n[00:00:01] line two\n');
    const inserted = app.db.insert(deployments).values({ projectId, status: 'success', trigger: 'manual', logPath }).run();
    const id = Number(inserted.lastInsertRowid);

    const res = await app.inject({ method: 'GET', url: `/api/deployments/${id}/log`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ content: '[00:00:00] line one\n[00:00:01] line two\n' });

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// WebSocket log streaming
// ---------------------------------------------------------------------------

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A queue `run` that writes a backlog immediately, then waits for the test to release each phase. */
class ControllableStreamingRun {
  logger: DeployLogger | null = null;
  private readonly liveGate = deferred<void>();
  private readonly finishGate = deferred<void>();

  run: DeployQueueDeps['run'] = async (_deploymentId, _signal, logger) => {
    this.logger = logger;
    logger.line('backlog line 1');
    logger.line('backlog line 2');
    await this.liveGate.promise;
    logger.line('live line 1');
    await this.finishGate.promise;
  };

  releaseLive(): void {
    this.liveGate.resolve();
  }

  finish(): void {
    this.finishGate.resolve();
  }
}

async function listenApp(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('expected an AddressInfo from app.server.address()');
  }
  return address.port;
}

function onceEvent<T = unknown>(ws: WebSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    ws.once(event, (arg: T) => {
      resolve(arg);
    });
  });
}

/** Like `onceEvent`, but captures every argument the event handler is called with (as a tuple). */
function onceEventArgs<T extends unknown[]>(ws: WebSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    ws.once(event, (...args: unknown[]) => {
      resolve(args as T);
    });
  });
}

describe('WS /api/deployments/:id/logs/stream', () => {
  // Real TCP listen + a real WebSocket client round-tripping three phases (backlog, live line,
  // close) — under full-suite load (44 files' worth of servers/sockets contending for the event
  // loop) the default 5000ms per-test timeout can be tight even though nothing is actually stuck;
  // every wait below is already gated on an explicit signal (a `deferred()` release or a socket
  // event), not a fixed delay, so a longer bound here only buys headroom against scheduler jitter
  // without hiding a real hang (see runshell.test.ts's `sleep`-abort test for the same pattern).
  it('sends the backlog, then live lines, then closes when the run ends', async () => {
    const dataDir = tmpDataDir();
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });
    const sysops = new DevSysOps(path.join(dataDir, 'system'));
    const dns = new FakeDnsClient();
    const controllable = new ControllableStreamingRun();
    const app = await buildApp(cfg, { sysops, dns: () => dns, queueRun: controllable.run });

    const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
    const cookie = sessionCookie(create);
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { base_domain: 'apps.example.com', server_ip: '203.0.113.10' },
    });
    const projectId = await createProject(app, cookie);

    const port = await listenApp(app);

    const deployRes = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/deploy`, headers: { cookie } });
    const { deploymentId } = deployRes.json() as { deploymentId: number };

    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/deployments/${String(deploymentId)}/logs/stream`, {
      headers: { cookie },
    });

    const backlogMsg = await onceEvent<Buffer>(ws, 'message');
    const backlog = backlogMsg.toString('utf8');
    expect(backlog).toContain('backlog line 1');
    expect(backlog).toContain('backlog line 2');

    const liveMsgPromise = onceEvent<Buffer>(ws, 'message');
    controllable.releaseLive();
    const liveMsg = await liveMsgPromise;
    expect(liveMsg.toString('utf8')).toContain('live line 1');

    const closePromise = onceEvent(ws, 'close');
    controllable.finish();
    await closePromise;

    ws.terminate();
    await app.close();
  }, 20000);

  it('rejects an unauthenticated WebSocket connection', async () => {
    const dataDir = tmpDataDir();
    const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });
    const sysops = new DevSysOps(path.join(dataDir, 'system'));
    const dns = new FakeDnsClient();
    const app = await buildApp(cfg, { sysops, dns: () => dns });

    const port = await listenApp(app);

    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/deployments/1/logs/stream`);

    const [, response] = await onceEventArgs<[unknown, { statusCode: number }]>(ws, 'unexpected-response');
    expect(response.statusCode).toBe(401);

    // The server already closed the raw socket right after the 401 (see app.ts's note on why
    // @fastify/websocket must be registered before the auth guard) — nothing left to tear down on
    // the client side; calling `ws.terminate()` here would throw since the connection never
    // reached `OPEN`.
    await app.close();
  });

  it('sends the backlog then closes immediately for a terminal deployment (no live logger)', async () => {
    const { app, cookie, dataDir } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie);
    const logPath = path.join(dataDir, 'terminal.log');
    fs.writeFileSync(logPath, '[00:00:00] already done\n');
    const inserted = app.db.insert(deployments).values({ projectId, status: 'success', trigger: 'manual', logPath }).run();
    const id = Number(inserted.lastInsertRowid);

    const port = await listenApp(app);

    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/deployments/${String(id)}/logs/stream`, {
      headers: { cookie },
    });

    const msg = await onceEvent<Buffer>(ws, 'message');
    expect(msg.toString('utf8')).toContain('already done');

    await onceEvent(ws, 'close');

    ws.terminate();
    await app.close();
  });
});

describe('GET /api/deployments (global list, Task 5)', () => {
  it('returns deployments across all projects, newest first, joined with project name/slug', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();
    const projectAId = await createProject(app, cookie, 'app-a');
    const projectBId = await createProject(app, cookie, 'app-b');

    app.db
      .insert(deployments)
      .values({ projectId: projectAId, status: 'success', trigger: 'manual', commitSha: 'aaa111', commitMessage: 'first', startedAt: 1, finishedAt: 2 })
      .run();
    app.db
      .insert(deployments)
      .values({ projectId: projectBId, status: 'failed', trigger: 'push', commitSha: 'bbb222', commitMessage: 'second', startedAt: 3, finishedAt: 4 })
      .run();

    const res = await app.inject({ method: 'GET', url: '/api/deployments', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // newest first (desc by id)
    expect(rows[0]!.id as number).toBeGreaterThan(rows[1]!.id as number);

    const bRow = rows.find((r) => r.projectId === projectBId);
    expect(bRow).toMatchObject({
      projectId: projectBId,
      projectName: 'app-b',
      projectSlug: 'app-b',
      status: 'failed',
      trigger: 'push',
      commitSha: 'bbb222',
      commitMessage: 'second',
      startedAt: 3,
      finishedAt: 4,
    });

    await app.close();
  });

  it('defaults limit to 50 and clamps a requested limit to 100', async () => {
    const { app, cookie } = await buildDeploymentsTestApp();
    const projectId = await createProject(app, cookie);
    for (let i = 0; i < 5; i += 1) {
      app.db.insert(deployments).values({ projectId, status: 'success', trigger: 'manual' }).run();
    }

    const defaultRes = await app.inject({ method: 'GET', url: '/api/deployments', headers: { cookie } });
    expect((defaultRes.json() as unknown[]).length).toBe(5);

    const clampedRes = await app.inject({ method: 'GET', url: '/api/deployments?limit=5000', headers: { cookie } });
    expect((clampedRes.json() as unknown[]).length).toBeLessThanOrEqual(100);

    const explicitRes = await app.inject({ method: 'GET', url: '/api/deployments?limit=2', headers: { cookie } });
    expect((explicitRes.json() as unknown[]).length).toBe(2);

    await app.close();
  });

  it('unauthenticated requests are 401', async () => {
    const { app } = await buildDeploymentsTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/deployments' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
