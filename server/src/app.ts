import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import secureSession from '@fastify/secure-session';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { openDb, type ShipwayDb } from './db/index.js';
import { notificationChannels, notificationSubscriptions } from './db/schema.js';
import { deleteSetting, getSetting } from './db/settings.js';
import { DeployQueue, type DeployQueueDeps } from './deploy/queue.js';
import type { DeployLogger } from './deploy/logger.js';
import { runDeploy, type PipelineDeps } from './deploy/pipeline.js';
import { makeRunShell } from './deploy/runshell.js';
import { SecretBox } from './lib/secretbox.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { cloudflareRoutes } from './routes/cloudflare.js';
import { cronRoutes } from './routes/cron.js';
import { databaseRoutes, servicesRoutes } from './routes/databases.js';
import { deploymentRoutes } from './routes/deployments.js';
import { githubRoutes } from './routes/github.js';
import { mailRoutes } from './routes/mail.js';
import { notificationRoutes } from './routes/notifications.js';
import { overviewRoutes } from './routes/overview.js';
import { projectRoutes } from './routes/projects.js';
import { serverRoutes } from './routes/server.js';
import { settingsRoutes } from './routes/settings.js';
import { userRoutes } from './routes/users.js';
import { webhookRoutes } from './routes/webhooks.js';
import { workerRoutes } from './routes/workers.js';
import { recordAudit, runAuditPurgeOnce, startAuditPurge, type AuditPurgeHandle } from './services/audit.js';
import { FakeDnsClient, isBlankCredential, makeCloudflareClient, type DnsClient } from './services/cloudflare.js';
import { makeDbAdmin, type DbAdmin } from './services/dbprovision.js';
import { notifyDeployCanceled, notifyDeployTerminal } from './services/deploynotify.js';
import { makeGitOps } from './services/git.js';
import { GitHubService, resolveCloneUrl, type GithubAppConfig } from './services/github.js';
import { startServiceWatch, type ServiceWatchHandle } from './services/servicewatch.js';
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
     * `FakeDnsClient` (never `null`) so record provisioning works offline regardless of whether
     * real credentials are configured — but its `setCredentials()` is refreshed from the current
     * settings on every call, so its `verifyToken()` stays honest (plan Task 1 / spec §3
     * "Cloudflare verify") rather than always reporting success. Called fresh per use so routes
     * always see the latest stored credentials.
     */
    dns: () => DnsClient | null;
    /** Schedules and tracks deploy/rollback jobs; wired to `runDeploy` in `buildApp`. */
    queue: DeployQueue;
    /** Provisions/deprovisions MySQL/Postgres databases; backed by `mysql_admin_url`/`postgres_admin_url` settings. */
    dbAdmin: DbAdmin;
    /** The 60s service-status poller's handle (Task 4), or `undefined` when it isn't running — see
     * `buildApp`'s `deps.serviceWatch` for when that is. `app.close()` stops it via an `onClose` hook. */
    serviceWatch: ServiceWatchHandle | undefined;
    /** The hourly audit-retention purge timer's handle (Task 5), or `undefined` when it isn't
     * running — see `buildApp`'s `deps.auditPurge` for when that is. `app.close()` stops it via an
     * `onClose` hook. A purge also always runs once synchronously at boot regardless of this. */
    auditPurge: AuditPurgeHandle | undefined;
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The built web SPA's `dist` directory. This file lives at `src/app.ts` (compiles to
 * `dist/app.js`), so in both cases the sibling `web` package is two levels up: `src`/`dist` ->
 * `server` -> repo root -> `web/dist`.
 */
const DEFAULT_WEB_DIST_DIR = path.resolve(__dirname, '../../web/dist');

/**
 * Path prefixes under `/api/` that do NOT require an authenticated session. Everything else under
 * `/api/` is guarded by the global `onRequest` hook below. `/api/health` itself is checked
 * separately as an exact match (see `isPublicApiPath`), not a prefix, so a future route like
 * `/api/healthcheck` doesn't accidentally slip through unauthenticated too. `/api/invite/` is
 * public (Task 3): the invitee has no session yet — `GET` previews the pending invite and `POST`
 * activates it — both routes validate the token itself as their credential (see `routes/users.ts`).
 */
const PUBLIC_API_PREFIXES = ['/api/auth/', '/api/setup/', '/api/webhooks/', '/api/invite/'];

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

/** How often the service-status poller reads `SYSTEM_UNITS` in production (Task 4). */
const SERVICE_WATCH_INTERVAL_MS = 60_000;

/** How often the audit-retention purge timer runs in production (Task 5, spec: "hourly timer + boot"). */
const AUDIT_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * One-time migration (Task 4, spec §2's notifybus bullet): if the legacy global
 * `notify_webhook_url` setting is set and no notification channel exists yet, creates a "Default"
 * channel with that URL subscribed to `deploy_failed` (and also `deploy_succeeded` when the legacy
 * `notify_on_success` setting was `true`) — carrying v1's webhook behavior forward as a Task 4
 * channel. Then clears the legacy `notify_webhook_url` setting so `deploynotify.ts`'s global
 * fallback (services/deploynotify.ts:54-63) no longer fires alongside the new channel — otherwise an
 * upgraded install posts twice per event to the same URL (final-review.md finding I-1). Per-project
 * `notifyWebhookUrl` overrides are a separate, still-supported feature and are left untouched.
 *
 * Naturally idempotent — once ANY channel exists (this migration's own "Default", or one a user
 * created by hand first), it never runs again, and once `notify_webhook_url` is cleared the `if
 * (!webhookUrl) return;` guard below makes every later boot a no-op — so this can just be called
 * unconditionally on every boot.
 */
function migrateLegacyWebhookChannel(db: ShipwayDb): void {
  const webhookUrl = getSetting<string>(db, 'notify_webhook_url');
  if (!webhookUrl) return;

  const existingChannel = db.select({ id: notificationChannels.id }).from(notificationChannels).limit(1).get();
  if (existingChannel) return;

  db.insert(notificationChannels).values({ name: 'Default', url: webhookUrl }).run();
  const created = db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.name, 'Default')).get();
  if (!created) return; // unreachable: just inserted this row above

  db.insert(notificationSubscriptions).values({ event: 'deploy_failed', channelId: created.id }).run();
  if (getSetting<boolean>(db, 'notify_on_success') === true) {
    db.insert(notificationSubscriptions).values({ event: 'deploy_succeeded', channelId: created.id }).run();
  }

  // Silence the legacy global fallback now that the Default channel covers it — see the doc
  // comment above (finding I-1). Per-project notifyWebhookUrl overrides are untouched.
  deleteSetting(db, 'notify_webhook_url');

  recordAudit(db, {
    actorId: null,
    actorName: 'system',
    action: 'notification.migrated',
    targetType: 'notification_channel',
    targetName: 'Default',
  });
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
    /** Test-only override: path to the built web SPA's `dist` directory, in place of the real
     * `web/dist` sibling package. Lets tests exercise the SPA-fallback static serving (present and
     * absent) without depending on whether `web` has actually been built in the checkout. */
    webDistDir?: string;
    /** Test-only override: starts the Task 4 service-status poller with this config instead of the
     * default "skip entirely under `NODE_ENV=test`" behavior — lets tests exercise the wiring (short
     * `intervalMs`, a fake `fetchImpl`) deterministically. In production this is never passed; the
     * poller always runs at `SERVICE_WATCH_INTERVAL_MS`. */
    serviceWatch?: { intervalMs: number; fetchImpl?: typeof fetch };
    /** Test-only override: starts the Task 5 hourly audit-retention purge timer at this interval
     * instead of the default "skip entirely under `NODE_ENV=test`" behavior — lets tests drive it
     * deterministically via `.tick()`. In production this is never passed; the timer always runs at
     * `AUDIT_PURGE_INTERVAL_MS`. The boot-time purge itself is unconditional either way (see
     * `runAuditPurgeOnce(app.db)` below, right after `migrateLegacyWebhookChannel`). */
    auditPurge?: { intervalMs: number };
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: cfg.devMode,
    // The server process only ever binds 127.0.0.1 (see docs/server-setup.md) — nginx is the sole
    // caller, and its dashboard/mailpit vhost templates always set X-Forwarded-For via
    // $proxy_add_x_forwarded_for (see setup/templates/nginx-dashboard.conf), which APPENDS to
    // whatever X-Forwarded-For a client already sent rather than replacing it. Without any
    // trustProxy, every request's `request.ip` is nginx's own loopback address in production, so
    // per-IP logic (the login rate limiter in routes/auth.ts) collapses onto one shared bucket for
    // every real client. But `trustProxy: true` trusts the WHOLE chain and resolves `request.ip` to
    // the LEFT-MOST entry — which is client-supplied, so any external caller could set
    // `X-Forwarded-For: 1.2.3.4` themselves and have nginx simply append its own hop after it,
    // spoofing an arbitrary rate-limit bucket on every request. Pinning trustProxy to the loopback
    // address instead (`@fastify/proxy-addr` semantics: walk the chain from the right, stop at the
    // first hop that ISN'T in the trusted list) makes Fastify stop at nginx's own appended hop — the
    // right-most, untrusted-but-nginx-written entry — which is exactly the real client IP nginx saw
    // on the actual TCP connection, and can't be overridden by anything the client puts in the header.
    trustProxy: '127.0.0.1',
  });

  app.decorate('cfg', cfg);
  app.decorate('db', openDb(cfg.dbPath));
  migrateLegacyWebhookChannel(app.db);
  // Task 5's boot-time audit-retention purge: unconditional (not gated by test mode, unlike the
  // hourly timer below) since it's a single cheap DELETE — mirrors `migrateLegacyWebhookChannel`
  // running unconditionally on every boot too.
  runAuditPurgeOnce(app.db);
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
        const token = getSetting<string>(app.db, 'cloudflare_token');
        const zoneId = getSetting<string>(app.db, 'cloudflare_zone_id');
        const hasCredentials = !isBlankCredential(token) && !isBlankCredential(zoneId);

        if (cfg.devMode) {
          // Record provisioning (create/find/delete) stays fully in-memory/offline unconditionally
          // (FakeDnsClient's own doc comment) — only its verifyToken() reflects real configured
          // state, refreshed here on every call so "Test connection" in dev mode is never a lie
          // (see routes/cloudflare.ts and the root-cause note in the v3 design spec §2).
          sharedDevDnsClient ??= new FakeDnsClient();
          sharedDevDnsClient.setCredentials(hasCredentials ? { token: token!.trim(), zoneId: zoneId!.trim() } : null);
          return sharedDevDnsClient;
        }

        if (!hasCredentials) return null;
        return makeCloudflareClient(token!.trim(), zoneId!.trim());
      }),
  );

  const fetchImpl = deps.fetchImpl ?? fetch;

  // Resolves a project's clone URL: `repoUrl` (Task 8's Git-URL source) verbatim when set, else
  // `repo` ("owner/name") via the configured GitHub App's installation token. Throws a clear error
  // (surfaced in the deploy log, see pipeline.ts's `handlePreActivateFailure`) if a repo-sourced
  // project's app isn't configured/installed yet, rather than letting a confusing git/auth failure
  // be the first sign something's wrong. Thin wrapper over `resolveCloneUrl` — see that function's
  // doc comment for why the precedence logic itself lives there instead of here.
  async function getCloneUrl(repo: string, repoUrl: string | null): Promise<string> {
    return resolveCloneUrl(repo, repoUrl, app.github());
  }

  // Wired as `PipelineDeps.notify`: preserves v1's per-project/global webhook override (gated by
  // `notify_on_success`) AND additionally (always — Task 4's bus events are additive) emits the
  // matching `notifybus` event to every channel subscribed to it. See `services/deploynotify.ts`.
  async function notify(p: {
    project: string;
    status: 'success' | 'failed';
    deploymentId: number;
    message: string;
    rolledBack?: boolean;
  }): Promise<void> {
    await notifyDeployTerminal(app.db, fetchImpl, p);
  }

  const pipelineDeps: PipelineDeps = {
    cfg,
    db: app.db,
    sysops: app.sysops,
    gitOps: makeGitOps(),
    secretBox: app.secretBox,
    getCloneUrl,
    runShell: makeRunShell(),
    fetchHttp: async (url, signal) => ({ status: (await fetchImpl(url, { signal })).status }),
    notify,
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }),
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
          const result = await runDeploy(pipelineDeps, deploymentId, logger, signal);
          // The pipeline's own `notify` hook is deliberately never called for a cancellation
          // (unchanged v1 behavior — see deploy/pipeline.ts), so it's the one terminal status the
          // bus needs a separate emission for, driven off `runDeploy`'s own return value instead.
          if (result === 'canceled') {
            try {
              await notifyDeployCanceled(app.db, fetchImpl, deploymentId);
            } catch (err) {
              app.log.error({ err }, 'notifyDeployCanceled failed');
            }
          }
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
  await app.register(cloudflareRoutes);
  await app.register(mailRoutes);
  await app.register(githubRoutes, { fetchImpl: deps.fetchImpl, stateTtlMs: deps.githubStateTtlMs });
  await app.register(projectRoutes);
  await app.register(deploymentRoutes);
  await app.register(databaseRoutes);
  await app.register(servicesRoutes);
  await app.register(workerRoutes);
  await app.register(cronRoutes);
  await app.register(serverRoutes);
  await app.register(webhookRoutes);
  await app.register(notificationRoutes, { fetchImpl: deps.fetchImpl });
  await app.register(auditRoutes);
  await app.register(overviewRoutes);

  // Serves the built web SPA (see `web/`, Task 22) when present. Guarded on existence so dev mode
  // — where `web/dist` may not exist yet, since `web` ships its own Vite dev server instead — never
  // errors: buildApp just skips static serving entirely, and every non-`/api` request falls through
  // to Fastify's plain JSON 404 as it always did.
  const webDistDir = deps.webDistDir ?? DEFAULT_WEB_DIST_DIR;
  if (fs.existsSync(webDistDir)) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      // `index.html` is served explicitly below (for `/`) and by the SPA-fallback 404 handler
      // (for every other client-side route) instead of by this plugin's own index-serving/
      // directory-listing behavior — with `index` left at its default, a bare `GET /` falls into
      // `@fastify/static`'s own directory handling and 403s instead of reaching either handler.
      index: false,
    });

    // `@fastify/static`'s wildcard route (`{prefix}*`) doesn't cover the exact empty path, so `/`
    // needs its own explicit handler alongside the 404-based fallback below for every other route.
    app.get('/', (_request, reply) => reply.sendFile('index.html'));

    // Registered at the root level (not nested in a sub-plugin), so it applies across every
    // prefix. The global auth guard's onRequest hook above already lets non-`/api` requests
    // through unauthenticated (see its own comment) — the SPA shell must load before any client-
    // side auth check can run. Non-GET or `/api/*` requests that fall through routing (no matching
    // route registered, and — for `/api/*` — no static file either) still get a plain JSON 404
    // instead of the HTML shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  // Service-status poller (Task 4): runs at `SERVICE_WATCH_INTERVAL_MS` in production. Under
  // `NODE_ENV=test` (vitest's default) it's skipped entirely unless a test explicitly opts in via
  // `deps.serviceWatch`, so the hundreds of app-level tests that never touch it don't each leave a
  // background timer running. Stopped via an `onClose` hook so `app.close()` always leaves no open
  // handles behind — otherwise a real interval would keep the process (and vitest) alive forever.
  const serviceWatchEnabled = deps.serviceWatch !== undefined || process.env.NODE_ENV !== 'test';
  app.decorate(
    'serviceWatch',
    serviceWatchEnabled
      ? startServiceWatch({
          db: app.db,
          sysops: app.sysops,
          intervalMs: deps.serviceWatch?.intervalMs ?? SERVICE_WATCH_INTERVAL_MS,
          fetchImpl: deps.serviceWatch?.fetchImpl ?? fetchImpl,
        })
      : undefined,
  );
  app.addHook('onClose', () => {
    app.serviceWatch?.stop();
  });

  // Hourly audit-retention purge timer (Task 5): same test-gating shape as the service-status
  // poller just above — skipped under `NODE_ENV=test` unless a test injects `deps.auditPurge`, and
  // stopped via `onClose`. The boot-time purge itself already ran unconditionally, right after
  // `migrateLegacyWebhookChannel` above, regardless of this timer's on/off state.
  const auditPurgeEnabled = deps.auditPurge !== undefined || process.env.NODE_ENV !== 'test';
  app.decorate('auditPurge', auditPurgeEnabled ? startAuditPurge(app.db, deps.auditPurge?.intervalMs ?? AUDIT_PURGE_INTERVAL_MS) : undefined);
  app.addHook('onClose', () => {
    app.auditPurge?.stop();
  });

  // Re-queues rows left `queued`/`running` by a previous process (e.g. a restart) — must run after
  // every route is registered, since it can start deploys immediately via the queue's `run`.
  app.queue.recoverOnBoot();

  return app;
}
