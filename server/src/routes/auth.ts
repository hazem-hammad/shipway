import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';

const setupAdminSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const MAX_FAILED_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

interface AttemptRecord {
  count: number;
  windowStart: number;
}

/**
 * Registers `/api/setup/*` and `/api/auth/*`. Both are exempt from the global session guard (see
 * `buildApp`), so `/api/auth/me` performs its own session check and returns 401 rather than relying
 * on the hook.
 *
 * Login rate limiting is a simple in-memory counter keyed by IP, scoped to this plugin invocation
 * (one `Map` per `buildApp()` call/process) so it doesn't leak across independently-built app
 * instances in tests: at most `MAX_FAILED_ATTEMPTS` failed logins per IP per `WINDOW_MS`, after which
 * further attempts (even with the correct password) 429 until the window rolls over. A successful
 * login resets that IP's counter.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const failedAttempts = new Map<string, AttemptRecord>();

  function isRateLimited(ip: string): boolean {
    const record = failedAttempts.get(ip);
    if (!record) return false;
    if (Date.now() - record.windowStart > WINDOW_MS) {
      failedAttempts.delete(ip);
      return false;
    }
    return record.count >= MAX_FAILED_ATTEMPTS;
  }

  function recordFailure(ip: string): void {
    const now = Date.now();
    const record = failedAttempts.get(ip);
    if (!record || now - record.windowStart > WINDOW_MS) {
      failedAttempts.set(ip, { count: 1, windowStart: now });
      return;
    }
    record.count += 1;
  }

  function resetAttempts(ip: string): void {
    failedAttempts.delete(ip);
  }

  app.get('/api/setup/status', async () => {
    const existing = app.db.select({ id: users.id }).from(users).limit(1).get();
    return { needsSetup: !existing };
  });

  app.post('/api/setup/admin', async (request, reply) => {
    const parsed = setupAdminSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const existing = app.db.select({ id: users.id }).from(users).limit(1).get();
    if (existing) {
      return reply.code(409).send({ error: 'setup already completed' });
    }

    const { name, email, password } = parsed.data;
    const passwordHash = await hashPassword(password);
    app.db.insert(users).values({ name, email, passwordHash }).run();
    const created = app.db.select().from(users).where(eq(users.email, email)).get();
    if (!created) {
      throw new Error('failed to read back newly-created admin user');
    }

    request.session.set('userId', created.id);
    return reply.code(201).send({ id: created.id, name: created.name, email: created.email });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const ip = request.ip;
    if (isRateLimited(ip)) {
      return reply.code(429).send({ error: 'too many failed login attempts, try again later' });
    }

    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const { email, password } = parsed.data;
    const user = app.db.select().from(users).where(eq(users.email, email)).get();
    const valid = user ? await verifyPassword(user.passwordHash, password) : false;

    if (!user || !valid) {
      recordFailure(ip);
      return reply.code(401).send({ error: 'invalid email or password' });
    }

    resetAttempts(ip);
    request.session.set('userId', user.id);
    return { id: user.id, name: user.name, email: user.email };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    request.session.delete();
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (request, reply) => {
    const userId = request.session.get('userId');
    if (userId === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const user = app.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    return { id: user.id, name: user.name, email: user.email };
  });
}
