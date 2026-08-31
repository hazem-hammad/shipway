import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import secureSession from '@fastify/secure-session';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { openDb, type ShipwayDb } from './db/index.js';
import { getSetting } from './db/settings.js';
import { DeployQueue, type DeployQueueDeps } from './deploy/queue.js';
import type { DeployLogger } from './deploy/logger.js';
import { runDeploy, type PipelineDeps } from './deploy/pipeline.js';
import { makeRunShell } from './deploy/runshell.js';
import { canAccessProject } from './lib/projectaccess.js';
import { SecretBox } from './lib/secretbox.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { cloudflareRoutes } from './routes/cloudflare.js';
import { cronRoutes } from './routes/cron.js';
import { databaseRoutes, servicesRoutes } from './routes/databases.js';
import { dbConnectionRoutes } from './routes/dbconnections.js';
import { deploymentRoutes } from './routes/deployments.js';
import { gitRoutes } from './routes/git.js';
import { githubRoutes } from './routes/github.js';
import { mailRoutes } from './routes/mail.js';
import { projectNotificationRoutes } from './routes/projectnotifications.js';
import { overviewRoutes } from './routes/overview.js';
import { projectRoutes } from './routes/projects.js';
import { serverRoutes } from './routes/server.js';
import { settingsRoutes } from './routes/settings.js';
import { userRoutes } from './routes/users.js';
import { webhookRoutes } from './routes/webhooks.js';
import { workerRoutes } from './routes/workers.js';
import { runAuditPurgeOnce, startAuditPurge, type AuditPurgeHandle } from './services/audit.js';
import { FakeDnsClient, isBlankCredential, makeCloudflareClient, type DnsClient } from './services/cloudflare.js';
import { makeDbAdmin, type DbAdmin } from './services/dbprovision.js';
import { ensureDefaultVhost } from './services/provisioner.js';
import { notifyDeployCanceled, notifyDeployTerminal } from './services/deploynotify.js';
import { describeOutcome } from './services/notifybus.js';
import { makeGitOps, type GitOps } from './services/git.js';
import { GitHubService, resolveCloneUrl, type GithubAppConfig } from './services/github.js';
import { DEFAULT_MAIL_TIMEOUT_MS } from './services/mailer.js';
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
    /** The overall cap (ms) every route's direct `sendMail(...)` call site (invite, mail test-send,
     * notification-channel test-send) passes as `sendMail`'s `timeoutMs` (fix wave I2) — defaults to
     * `services/mailer.ts`'s `DEFAULT_MAIL_TIMEOUT_MS`, overridable per-app via `deps.mailSendTimeoutMs`
     * so a test can prove a hanging SMTP host doesn't stall a response without waiting out the real
     * cap. */
    mailSendTimeoutMs: number;
    /** Schedules and tracks deploy/rollback jobs; wired to `runDeploy` in `buildApp`. */
    queue: DeployQueue;
    /** Provisions/deprovisions MySQL/Postgres databases; backed by `mysql_admin_url`/`postgres_admin_url` settings. */
    dbAdmin: DbAdmin;
    /** Git plumbing (mirror fetch, release export, remote branch listing). Shared by the deploy
     * pipeline and `routes/git.ts`, so a test can inject one double for both. */
    gitOps: GitOps;
    /** The 60s service-status poller's handle (Task 4), or `undefined` when it isn't running — see
     * `buildApp`'s `deps.serviceWatch` for when that is. `app.close()` stops it via an `onClose` hook. */
    serviceWatch: ServiceWatchHandle | undefined;
    /** The hourly audit-retention purge timer's handle (Task 5), or `undefined` when it isn't
     * running — see `buildApp`'s `deps.auditPurge` for when that is. `app.close()` stops it via an
     * `onClose` hook. A purge also always runs once synchronously at boot regardless of this. */
    auditPurge: AuditPurgeHandle | undefined;
  }
}

/** Placeholder in `web/index.html` for this install's own origin — see that file's comment. */
const OG_ORIGIN_TOKEN = '%OG_ORIGIN%';

/**
 * A hostname, optionally with a port. Deliberately strict: `request.host` comes from the client's
 * own `Host` header, and the result is interpolated into the HTML shell's `og:url`/`og:image`, so
 * anything outside this shape could close the attribute and inject markup into a page we serve.
 */
const SAFE_HOST_RE = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/i;

/**
 * The absolute origin to write into the shell's Open Graph tags, or `''` when the Host header isn't
 * a plain hostname. Empty leaves `og:image` as `/og.png` — a relative URL most crawlers still
 * resolve — which is a far better failure than reflecting an attacker-chosen string.
 */
function shellOrigin(request: FastifyRequest): string {
  return SAFE_HOST_RE.test(request.host) ? `${request.protocol}://${request.host}` : '';
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
    /** Test-only override for `app.mailSendTimeoutMs` (fix wave I2) — a short cap lets a test prove
     * an invite/test-send route still answers promptly against a hanging mail transport, instead of
     * waiting out the real `DEFAULT_MAIL_TIMEOUT_MS`. In production this is never passed. */
    mailSendTimeoutMs?: number;
    /** Test-only override: replaces the real `runDeploy`-backed queue `run` with a fake. */
    queueRun?: DeployQueueDeps['run'];
    /** Test-only override: replaces the real mysql2/pg-backed `DbAdmin` with a fake (e.g. one that
     * records calls and can be made to throw), so database route tests never touch a real server. */
    dbAdmin?: DbAdmin;
    /** Test-only override: replaces the real `execa`-backed `GitOps` (used by both the deploy
     * pipeline and `/api/git/branches`) with a stub, so a route test never shells out to git. */
    gitOps?: GitOps;
    /** Test-only override: path to the built web SPA's `dist` directory, in place of the real
     * `web/dist` sibling package. Lets tests exercise the SPA-fallback static serving (present and
     * absent) without depending on whether `web` has actually been built in the checkout. */
    webDistDir?: string;
    /** Test-only override: starts the Task 4 service-status poller with this config instead of the
     * default "skip entirely under `NODE_ENV=test`" behavior — lets tests exercise the wiring (short
     * `intervalMs`, a fake `fetchImpl`) deterministically. In production this is never passed; the
     * poller always runs at `SERVICE_WATCH_INTERVAL_MS`. */
    serviceWatch?: { intervalMs: number };
    /** Test-only override: starts the Task 5 hourly audit-retention purge timer at this interval
     * instead of the default "skip entirely under `NODE_ENV=test`" behavior — lets tests drive it
     * deterministically via `.tick()`. In production this is never passed; the timer always runs at
     * `AUDIT_PURGE_INTERVAL_MS`. The boot-time purge itself is unconditional either way (see
     * `runAuditPurgeOnce(app.db)` below). */
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
  // Task 5's boot-time audit-retention purge: unconditional (not gated by test mode, unlike the
  // hourly timer below) since it's a single cheap DELETE — mirrors the other boot-time maintenance
  // running unconditionally on every boot too.
  runAuditPurgeOnce(app.db);

  app.decorate('github', () => {
    const githubAppCfg = getSetting<GithubAppConfig>(app.db, 'github_app');
    return githubAppCfg ? new GitHubService(githubAppCfg) : null;
  });
  app.decorate('sysops', deps.sysops ?? makeSysOps(cfg));
  app.decorate('gitOps', deps.gitOps ?? makeGitOps());
  app.decorate('secretBox', SecretBox.load(cfg.secretKeyPath));
  app.decorate('mailSendTimeoutMs', deps.mailSendTimeoutMs ?? DEFAULT_MAIL_TIMEOUT_MS);
  // Takes its admin credentials per call, from the connection the route resolved (see
  // `services/dbconnections.ts`) — nothing to configure here.
  app.decorate('dbAdmin', deps.dbAdmin ?? makeDbAdmin());
  app.decorate(
    'dns',
    deps.dns ??
      ((): DnsClient | null => {
        const token = getSetting<string>(app.db, 'cloudflare_token');
        const zoneId = getSetting<string>(app.db, 'cloudflare_zone_id');
        const hasCredentials = !isBlankCredential(token) && !isBlankCredential(zoneId);

        if (cfg.devMode) {
          // Record provisioning (create/find/delete) stays fully in-memory/offline once credentials
          // ARE configured (FakeDnsClient's own doc comment) — verifyToken() reflects real configured
          // state, refreshed here on every call so "Test connection" in dev mode is never a lie
          // (see routes/cloudflare.ts and the root-cause note in the v3 design spec §2). The shared
          // instance itself is built unconditionally (its in-memory records need to persist across
          // calls once credentials do show up), but is only ever HANDED to a caller when credentials
          // are actually configured — fix wave M1: `resolveDnsOutcome`/`provisionProject` previously
          // always got a non-null client here, so the New Project Domain card could show a green "DNS
          // record created." for a write to this in-memory map in the very same session where the
          // card itself said Cloudflare wasn't connected. Gating the return value on `hasCredentials`
          // (exactly like the production branch below) makes that `attempted: false` here too — the
          // same honest "No DNS record was created." the UI already renders for that state — without
          // touching anything about production's own (already-honest) behavior.
          sharedDevDnsClient ??= new FakeDnsClient();
          sharedDevDnsClient.setCredentials(hasCredentials ? { token: token!.trim(), zoneId: zoneId!.trim() } : null);
          return hasCredentials ? sharedDevDnsClient : null;
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
  }): Promise<string> {
    // The returned summary is written into the deploy log by the pipeline's `notifySafe`, so every
    // deploy leaves a record of whether it emailed anyone and why not if it didn't.
    return describeOutcome(await notifyDeployTerminal(app.db, fetchImpl, p, app.secretBox));
  }

  const pipelineDeps: PipelineDeps = {
    cfg,
    db: app.db,
    sysops: app.sysops,
    gitOps: app.gitOps,
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
          // (unchanged v1 behavior — see deploy/pipeline.ts), so it's the one terminal status that
          // needs a separate emission, driven off `runDeploy`'s own return value instead.
          if (result === 'canceled') {
            try {
              await notifyDeployCanceled(app.db, deploymentId, app.secretBox);
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

  /**
   * Per-project access guard for every `/api/projects/<id>/...` route, in one place (see
   * `lib/projectaccess.ts` for the rules themselves). Registered as a second global `onRequest` hook,
   * after the auth guard above, so `request.session` is decoded and an unauthenticated caller has
   * already been 401'd before this runs.
   *
   * Central rather than per-handler ON PURPOSE: the project id sits in the same path position for
   * every one of these routes across five route files (`projects`, `deployments`, `cron`, `workers`,
   * `projectnotifications`), so a new `/api/projects/:id/<thing>` route is covered the moment it is
   * registered instead of only if its author remembered the check. Routes keyed by a CHILD resource's
   * id instead (`/api/workers/:id`, `/api/cron/:id`, `/api/deployments/:id`, `/api/databases/:id`)
   * can't be matched by path alone — the owning project is only known after the row is loaded — so
   * those call `requireProjectAccess` themselves once they have it.
   *
   * 404, not 403 — see `lib/projectaccess.ts` for why. A non-numeric id falls through to the route's
   * own 404.
   */
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    const match = /^\/api\/projects\/(\d+)(?:\/|$)/.exec(path);
    if (!match) return;

    if (!canAccessProject(app.db, request.session.get('userId'), Number(match[1]))) {
      reply.code(404).send({ error: 'project not found' });
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
  await app.register(gitRoutes);
  await app.register(githubRoutes, { fetchImpl: deps.fetchImpl, stateTtlMs: deps.githubStateTtlMs });
  await app.register(projectRoutes);
  await app.register(deploymentRoutes);
  await app.register(dbConnectionRoutes);
  await app.register(databaseRoutes);
  await app.register(servicesRoutes);
  await app.register(workerRoutes);
  await app.register(cronRoutes);
  await app.register(serverRoutes);
  await app.register(webhookRoutes);
  await app.register(projectNotificationRoutes);
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
      // Vite fingerprints everything under `assets/` (`index-<hash>.js`), so those files are
      // immutable by construction: a new build is a new name, never new bytes under an old one.
      // Telling browsers that turns every repeat visit into zero revalidation requests instead of a
      // 304 round-trip per asset.
      //
      // `index.html` is the exception and gets the opposite treatment (see `sendShell`): it is the
      // one file whose name never changes while its contents do — it is what names the current
      // bundle — so a cached copy of it is precisely how a browser ends up loading yesterday's app
      // after a deploy. It must be revalidated every time.
      maxAge: '1y',
      immutable: true,
      // Called with a real `FastifyReply` (see @fastify/static's `sendFileTo`), after the plugin's
      // own headers are applied — so this overrides the `maxAge`/`immutable` pair above for the one
      // file it must not apply to.
      setHeaders(reply, filePath) {
        if (path.basename(filePath) === 'index.html') {
          reply.header('cache-control', 'no-cache');
        }
      },
    });

    /**
     * The SPA shell. `no-cache` (revalidate every time, a 304 when unchanged) rather than
     * `no-store`, so the response is still cheap when nothing has shipped — but never reused
     * without asking, which is what makes a deploy show up on the next reload instead of whenever
     * the browser next feels like checking.
     *
     * Set here as well as in `setHeaders` above because these two handlers reach `index.html`
     * through `sendFile`, and a future change to either path must not be able to lose it.
     */
    const shellPath = path.join(webDistDir, 'index.html');

    const sendShell = (request: FastifyRequest, reply: FastifyReply): FastifyReply => {
      // Read per request rather than cached at boot: a web-only deploy replaces this file WITHOUT
      // restarting the service (see setup/deploy-local.sh), so a boot-time cache would keep serving
      // the previous bundle's shell until something else happened to restart us.
      const stat = fs.statSync(shellPath);
      const origin = shellOrigin(request);
      // Covers the file AND the substitution, so the same shell served to two different hostnames
      // is not mistaken for a cache hit. Preserves the 304 that `sendFile` gave us for free.
      const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}-${Buffer.from(origin).toString('base64url')}"`;
      reply.header('cache-control', 'no-cache').header('etag', etag);
      if (request.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }
      return reply.type('text/html; charset=utf-8').send(fs.readFileSync(shellPath, 'utf8').replaceAll(OG_ORIGIN_TOKEN, origin));
    };

    // `@fastify/static`'s wildcard route (`{prefix}*`) doesn't cover the exact empty path, so `/`
    // needs its own explicit handler alongside the 404-based fallback below for every other route.
    app.get('/', (request, reply) => sendShell(request, reply));

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
      return sendShell(request, reply);
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
        })
      : undefined,
  );
  // The catch-all HTTPS vhost (see `renderDefaultVhost`). Installed at boot rather than only by
  // install.sh, so an install predating it picks it up on the next restart — without it nginx answers
  // any unmatched Host with whichever project vhost sorts first, and a deleted project's still-
  // resolving wildcard subdomain serves an unrelated site.
  //
  // MUST come after `app.decorate('sysops', ...)`: an earlier call got `app.sysops === undefined`,
  // failed inside its own try/catch, and reported the failure to a logger nothing reads — so it
  // silently did nothing. Logged via console.error rather than `app.log` for the same reason.
  // Skipped under test (no real nginx) and never allowed to block startup.
  if (process.env.NODE_ENV !== 'test') {
    void ensureDefaultVhost({ db: app.db, cfg, sysops: app.sysops, dns: null }).then((result) => {
      if (!result.ok) console.error(`shipway: default vhost not installed — ${result.detail}`);
    });
  }

  app.addHook('onClose', () => {
    app.serviceWatch?.stop();
  });

  // Hourly audit-retention purge timer (Task 5): same test-gating shape as the service-status
  // poller just above — skipped under `NODE_ENV=test` unless a test injects `deps.auditPurge`, and
  // stopped via `onClose`. The boot-time purge itself already ran unconditionally, right after
  // the boot-time purge above, regardless of this timer's on/off state.
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
