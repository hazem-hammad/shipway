/**
 * Server-enforced team roles. Order is `member < admin < owner` (see spec §1's role decision
 * table): member can create projects, deploy, rollback, and manage env/scripts/workers/cron on any
 * project; admin+ additionally manages team, settings, GitHub/Cloudflare config, deletes projects,
 * drops databases, and configures audit retention; owner is exactly one user (the earliest-created,
 * or the first `POST /api/setup/admin` caller — see `db/index.ts` and `routes/auth.ts`) who alone
 * can touch other admins (Task 3).
 */
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { users } from '../db/schema.js';

export type Role = 'member' | 'admin' | 'owner';

const ROLE_RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

/** `true` when `role` meets or exceeds `min` in the member < admin < owner ordering. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * Reads the current session user's role from the db (via `request.server.db`, the Fastify instance
 * every route handler runs on) and, if it doesn't meet `min`, sends the spec's 403 body
 * (`{error: 'requires admin'}` / `{error: 'requires owner'}`) and returns `false`. Callers must
 * `return` immediately when this returns `false` — nothing else about the response is sent for
 * them. A missing session user (shouldn't happen behind the global auth guard, but handled
 * defensively) is treated as the lowest role and also 403s.
 */
export function requireRole(request: FastifyRequest, reply: FastifyReply, min: Extract<Role, 'admin' | 'owner'>): boolean {
  const userId = request.session.get('userId');
  const row =
    userId === undefined ? undefined : request.server.db.select({ role: users.role }).from(users).where(eq(users.id, userId)).get();
  const role: Role = row?.role ?? 'member';

  if (!roleAtLeast(role, min)) {
    reply.code(403).send({ error: `requires ${min}` });
    return false;
  }
  return true;
}
