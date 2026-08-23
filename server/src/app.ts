import fastifyWebsocket from '@fastify/websocket';
import secureSession from '@fastify/secure-session';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from './config.js';
import { openDb, type ShipwayDb } from './db/index.js';
import { deployments, projects } from './db/schema.js';
import { getSetting } from './db/settings.js';
import { DeployQueue, type DeployQueueDeps } from './deploy/queue.js';
import type { DeployLogger } from './deploy/logger.js';
import { runDeploy, type PipelineDeps } from './deploy/pipeline.js';
import { makeRunShell } from './deploy/runshell.js';
import { SecretBox } from './lib/secretbox.js';
import { authRoutes } from './routes/auth.js';
import { cronRoutes } from './routes/cron.js';
import { databaseRoutes, servicesRoutes } from './routes/databases.js';
import { deploymentRoutes } from './routes/deployments.js';
import { githubRoutes } from './routes/github.js';
import { projectRoutes } from './routes/projects.js';
import { settingsRoutes } from './routes/settings.js';
import { userRoutes } from './routes/users.js';
import { webhookRoutes } from './routes/webhooks.js';
import { workerRoutes } from './routes/workers.js';
import { FakeDnsClient, makeCloudflareClient, type DnsClient } from './services/cloudflare.js';
import { makeDbAdmin, type DbAdmin } from './services/dbprovision.js';
import { makeGitOps } from './services/git.js';
import { cloneUrl, GitHubService, type GithubAppConfig } from './services/github.js';
import { sendDeployNotification } from './services/notify.js';
import { makeSysOps, type SysOps } from './sysops/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    cfg: Config;
    db: ShipwayDb;
    /**
     * Lazily builds a `GitHubService` from the current `github_app` setting, or `null` when
     * unconfigured. Called fresh per use (not cached on the instance) so routes always see the
     * latest stored credentials/installation id.
     */
    github: () => GitHubService | null;
    /** All privileged system mutations (nginx/systemd/file installs) go through this. */
    sysops: SysOps;
    /** Encrypts/decrypts project secrets at rest (env text, SMTP config). */
    secretBox: SecretBox;
    /**
     * Lazily builds a `DnsClient` from the current `cloudflare_token`/`cloudflare_zone_id`
     * settings, or `null` when unconfigured. In dev mode, always returns a shared in-process
     * `FakeDnsClient` so provisioning works offline. Called fresh per use so routes always see the
     * latest stored credentials.
     */
    dns: () => DnsClient | null;
    /** Schedules and tracks deploy/rollback jobs; wired to `runDeploy` in `buildApp`. */
    queue: DeployQueue;
    /** Provisions/deprovisions MySQL/Postgres databases; backed by `mysql_admin_url`/`postgres_admin_url` settings. */
    dbAdmin: DbAdmin;
  }
}

/**
 * Shared across every dev-mode `buildApp()` call in this process (not per-app), matching a real
 * Cloudflare zone's behavior of being one durable store rather than reset per request — so
 * find-then-create DNS idempotency holds the same way it would in production.
 */
let sharedDevDnsClient: FakeDnsClient | undefined;

declare module '@fastify/secure-session' {
  interface SessionData {
    userId: number;
  }
}

const SESSION_KEY_LENGTH = 32;

/**
 * Path prefixes under `/api/` that do NOT require an authenticated session. Everything else under
 * `/api/` is guarded by the global `onRequest` hook below. `/api/health` itself is checked
 * separately as an exact match (see `isPublicApiPath`), not a prefix, so a future route like
 * `/api/healthcheck` doesn't accidentally slip through unauthenticated too.
 */
const PUBLIC_API_PREFIXES = ['/api/auth/', '/api/setup/', '/api/webhooks/'];

function isPublicApiPath(path: string): boolean {
  if (path === '/api/health') return true;
  return PUBLIC_API_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Loads the session signing/encryption key from `keyPath`. If missing, generates a new random
 * 32-byte key and writes it with mode 0600 (mirrors `SecretBox.load` in `lib/secretbox.ts`).
 */
function loadOrCreateSessionKey(keyPath: string): Buffer {
  if (fs.existsSync(keyPath)) {
    const key = fs.readFileSync(keyPath);
    if (key.length !== SESSION_KEY_LENGTH) {
      throw new Error(`session key at ${keyPath} must be ${SESSION_KEY_LENGTH} bytes, got ${key.length}`);
    }
    return key;
  }

  const key = randomBytes(SESSION_KEY_LENGTH);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  return key;
}

export async function buildApp(
  cfg: Config,
  deps: {
    fetchImpl?: typeof fetch;
    githubStateTtlMs?: number;
    /** Test-only override: skips `makeSysOps(cfg)` in favor of an injected double (e.g. `DevSysOps`
     * built by the test, so it can inspect `.calls`). */
    sysops?: SysOps;
    /** Test-only override: skips the default lazy `dns()` in favor of an injected function. */
    dns?: () => DnsClient | null;
    /** Test-only override: replaces the real `runDeploy`-backed queue `run` with a fake. */
    queueRun?: DeployQueueDeps['run'];
    /** Test-only override: replaces the real mysql2/pg-backed `DbAdmin` with a fake (e.g. one that
     * records calls and can be made to throw), so database route tests never touch a real server. */
    dbAdmin?: DbAdmin;
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: cfg.devMode,
  });

  app.decorate('cfg', cfg);
  app.decorate('db', openDb(cfg.dbPath));
  app.decorate('github', () => {
    const githubAppCfg = getSetting<GithubAppConfig>(app.db, 'github_app');
    return githubAppCfg ? new GitHubService(githubAppCfg) : null;
  });
  app.decorate('sysops', deps.sysops ?? makeSysOps(cfg));
  app.decorate('secretBox', SecretBox.load(cfg.secretKeyPath));
  app.decorate(
    'dbAdmin',
    deps.dbAdmin ??
      makeDbAdmin(() => ({
        mysqlUrl: getSetting<string>(app.db, 'mysql_admin_url') ?? undefined,
        postgresUrl: getSetting<string>(app.db, 'postgres_admin_url') ?? undefined,
      })),
  );
  app.decorate(
    'dns',
    deps.dns ??
      ((): DnsClient | null => {
        if (cfg.devMode) {
          sharedDevDnsClient ??= new FakeDnsClient();
          return sharedDevDnsClient;
        }
        const token = getSetting<string>(app.db, 'cloudflare_token');
        const zoneId = getSetting<string>(app.db, 'cloudflare_zone_id');
        if (!token || !zoneId) return null;
        return makeCloudflareClient(token, zoneId);
      }),
  );

  const fetchImpl = deps.fetchImpl ?? fetch;

  // Resolves a project's `repo` ("owner/name") to an authenticated HTTPS clone URL via the
  // configured GitHub App's installation token. Throws a clear error (surfaced in the deploy log,
  // see pipeline.ts's `handlePreActivateFailure`) if the app isn't configured/installed yet, rather
  // than letting a confusing git/auth failure be the first sign something's wrong.
  async function getCloneUrl(repo: string): Promise<string> {
    const github = app.github();
    if (!github) {
      throw new Error('cannot deploy: the GitHub App is not configured');
    }
    const token = await github.getInstallationToken();
    return cloneUrl(repo, token);
  }

  // Resolves the webhook to notify for a given deploy: the project's own `notifyWebhookUrl` if
  // set, else the global `notify_webhook_url` setting; skips silently (no webhook configured
  // anywhere) and skips `'success'` notifications unless `notify_on_success` is set — failures are
  // always sent regardless of that setting.
  async function notify(p: { project: string; status: 'success' | 'failed'; deploymentId: number; message: string }): Promise<void> {
    if (p.status === 'success' && getSetting<boolean>(app.db, 'notify_on_success') !== true) {
      return;
    }

    const deploymentRow = app.db.select({ projectId: deployments.projectId }).from(deployments).where(eq(deployments.id, p.deploymentId)).get();
    const projectRow = deploymentRow
      ? app.db.select({ notifyWebhookUrl: projects.notifyWebhookUrl }).from(projects).where(eq(projects.id, deploymentRow.projectId)).get()
      : undefined;

    const webhookUrl = projectRow?.notifyWebhookUrl ?? getSetting<string>(app.db, 'notify_webhook_url');
    if (!webhookUrl) {
      return;
    }

    await sendDeployNotification(fetchImpl, webhookUrl, p);
  }

  const pipelineDeps: PipelineDeps = {
    cfg,
    db: app.db,
    sysops: app.sysops,
    gitOps: makeGitOps(),
    secretBox: app.secretBox,
    getCloneUrl,
    runShell: makeRunShell(),
    fetchHttp: async (url) => ({ status: (await fetchImpl(url)).status }),
    notify,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  app.decorate(
    'queue',
    new DeployQueue({
      db: app.db,
      cfg,
      concurrency: 2,
      run:
        deps.queueRun ??
        (async (deploymentId: number, signal: AbortSignal, logger: DeployLogger) => {
          await runDeploy(pipelineDeps, deploymentId, logger, signal);
        }),
    }),
  );

  await app.register(secureSession, {
    cookieName: 'shipway',
    key: loadOrCreateSessionKey(cfg.sessionKeyPath),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: 'auto',
    },
  });

  // Registered before both the global auth guard below and any route using `{websocket: true}`
  // (see routes/deployments.ts's log stream). Order relative to the auth guard matters, not just
  // "before routes": `@fastify/websocket` adds its own onRequest hook that unconditionally flags
  // `request.ws` (needed by its onResponse hook, which destroys the raw upgrade socket once a
  // non-101 response is sent) and an onResponse hook that acts on that flag. Fastify skips
  // subsequent onRequest hooks once one of them sends a reply — so if the auth guard below were
  // registered first, it would short-circuit an unauthenticated WS upgrade before `request.ws` is
  // ever set, the onResponse hook's `if (request.ws)` check would see `null`, and the socket behind
  // the 401 response would be left open on `Connection: keep-alive` instead of being closed —
  // silently hanging the client forever instead of surfacing the rejection.
  await app.register(fastifyWebsocket);

  // Global auth guard: registered as a plain onRequest hook (not nested in a sub-plugin) so it runs
  // for every request under `/api/`, including ones that don't match any route — Fastify copies
  // root-level onRequest hooks into the 404 handler's context too, so this 401s before routing ever
  // gets a chance to 404. Runs after the secure-session plugin's own onRequest hook, so
  // `request.session` is already decoded here. This also covers WebSocket upgrade requests (see the
  // `@fastify/websocket` registration above for why it must come first): the onRequest hook runs
  // before the upgrade completes, so an unauthenticated client gets a 401 HTTP response — and the
  // connection is actually closed afterward — instead of a successful upgrade.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;

    const path = request.url.split('?')[0]!;
    if (isPublicApiPath(path)) return;

    if (request.session.get('userId') === undefined) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/api/health', async () => {
    return { status: 'ok' };
  });

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(settingsRoutes);
  await app.register(githubRoutes, { fetchImpl: deps.fetchImpl, stateTtlMs: deps.githubStateTtlMs });
  await app.register(projectRoutes);
  await app.register(deploymentRoutes);
  await app.register(databaseRoutes);
  await app.register(servicesRoutes);
  await app.register(workerRoutes);
  await app.register(cronRoutes);
  await app.register(webhookRoutes);

  // Re-queues rows left `queued`/`running` by a previous process (e.g. a restart) — must run after
  // every route is registered, since it can start deploys immediately via the queue's `run`.
  app.queue.recoverOnBoot();

  return app;
}
