import secureSession from '@fastify/secure-session';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from './config.js';
import { openDb, type ShipwayDb } from './db/index.js';
import { getSetting } from './db/settings.js';
import { SecretBox } from './lib/secretbox.js';
import { authRoutes } from './routes/auth.js';
import { githubRoutes } from './routes/github.js';
import { projectRoutes } from './routes/projects.js';
import { settingsRoutes } from './routes/settings.js';
import { userRoutes } from './routes/users.js';
import { FakeDnsClient, makeCloudflareClient, type DnsClient } from './services/cloudflare.js';
import { GitHubService, type GithubAppConfig } from './services/github.js';
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

  // Global auth guard: registered as a plain onRequest hook (not nested in a sub-plugin) so it runs
  // for every request under `/api/`, including ones that don't match any route — Fastify copies
  // root-level onRequest hooks into the 404 handler's context too, so this 401s before routing ever
  // gets a chance to 404. Runs after the secure-session plugin's own onRequest hook, so
  // `request.session` is already decoded here.
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

  return app;
}
