import secureSession from '@fastify/secure-session';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from './config.js';
import { openDb, type ShipwayDb } from './db/index.js';
import { authRoutes } from './routes/auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    cfg: Config;
    db: ShipwayDb;
  }
}

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

export async function buildApp(cfg: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: cfg.devMode,
  });

  app.decorate('cfg', cfg);
  app.decorate('db', openDb(cfg.dbPath));

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

  return app;
}
