import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { recordAudit } from '../services/audit.js';

const setupAdminSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * A static, valid argon2id PHC hash for a password nobody knows (generated once with the same
 * default cost params `hashPassword` uses). When a login's email doesn't match any user, we still
 * `verifyPassword` against this instead of short-circuiting straight to 401 — otherwise "unknown
 * email" would resolve measurably faster than "wrong password for a real user", letting an attacker
 * enumerate valid emails purely from response timing.
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$hZp9d933yN2wkmJNcfz4Kg$8nXdEajInLRcy1Nb85SnTR8VLn41RcQ4GrlkMJTkJZA';

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

    // Fast path: skip the expensive hash entirely when setup is obviously already done.
    const alreadySetUp = app.db.select({ id: users.id }).from(users).limit(1).get();
    if (alreadySetUp) {
      return reply.code(409).send({ error: 'setup already completed' });
    }

    const { name, email, password } = parsed.data;
    const passwordHash = await hashPassword(password);

    // The `await` above yields the event loop, so a second concurrent request could have raced past
    // the fast-path check too. `db.transaction` on the better-sqlite3 driver runs its callback fully
    // synchronously (no `await` inside it), so re-checking and inserting here — with no suspension
    // point in between — is the actual TOCTOU-safe guarantee: only one concurrent caller can ever
    // observe an empty `users` table inside this block.
    const created = app.db.transaction((tx) => {
      const existing = tx.select({ id: users.id }).from(users).limit(1).get();
      if (existing) {
        return null;
      }
      // The very first user is always created as 'owner' directly (spec §2) — there's no earlier
      // user for `db/index.ts`'s boot-time promotion to act on, since that only runs at db-open
      // time, before this handler exists to insert anyone.
      tx.insert(users).values({ name, email, passwordHash, role: 'owner' }).run();
      return tx.select().from(users).where(eq(users.email, email)).get() ?? null;
    });

    if (!created) {
      return reply.code(409).send({ error: 'setup already completed' });
    }

    request.session.set('userId', created.id);
    return reply.code(201).send({ id: created.id, name: created.name, email: created.email, role: created.role });
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
    // Always run a real argon2id verify against DUMMY_PASSWORD_HASH — see its doc comment — for
    // both an unknown email AND a `status: 'invited'` user (Task 3: invited users can't log in
    // until they activate via `/api/invite/:token`; their `passwordHash` is an unusable sentinel
    // anyway, but we still route around it explicitly here rather than relying on that). This keeps
    // "unknown email", "not yet activated", and "wrong password" 401s equally expensive — an
    // attacker can't distinguish any of the three from response timing.
    const canAttemptLogin = user !== undefined && user.status === 'active';
    const valid = await verifyPassword(canAttemptLogin ? user.passwordHash : DUMMY_PASSWORD_HASH, password);

    if (!canAttemptLogin || !valid) {
      recordFailure(ip);
      recordAudit(app.db, {
        actorId: user?.id ?? null,
        actorName: email,
        action: 'auth.login_failed',
        targetType: 'auth',
        targetName: email,
      });
      return reply.code(401).send({ error: 'invalid email or password' });
    }

    resetAttempts(ip);
    request.session.set('userId', user.id);
    return { id: user.id, name: user.name, email: user.email, role: user.role };
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

    // Echoed for nginx's `auth_request`, which uses this route as its subrequest target on the
    // dashboard vhost (setup/templates/nginx-dashboard.conf). `auth_request_set` copies this header
    // out of the subrequest response and forwards it to pgAdmin as the remote user, which is how
    // pgAdmin knows who is signed in without a login of its own. Harmless to every other caller.
    reply.header('X-Shipway-User', user.email);
    return { id: user.id, name: user.name, email: user.email, role: user.role };
  });
}
