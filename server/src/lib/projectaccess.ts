/**
 * Per-project access: which projects a given user may see and act on.
 *
 * The role system in `authz.ts` answers "what KIND of thing may this user do" (deploy vs. manage
 * the team); this answers the orthogonal question "which projects may they do it TO". The two are
 * enforced independently — a scoped member still can't touch settings, and an admin scoped to
 * nothing is still unscoped, see below.
 *
 * The rules, in full:
 *  - owner/admin  -> every project, always. Admins administer the instance (they create projects,
 *                    delete them, and manage everyone else's access), so scoping them would mean
 *                    locking an admin out of the very thing they're expected to manage. Their
 *                    `users.project_access` value is ignored rather than trusted.
 *  - member, `project_access: 'all'`      -> every project, present and future. The column default,
 *                    so every user that predates this feature keeps exactly the access they had —
 *                    upgrading never silently takes projects away from anyone.
 *  - member, `project_access: 'selected'` -> exactly the projects granted in `project_members`.
 *                    No rows means no projects (an empty Projects page), never "all".
 *
 * A denied project is reported as 404 `project not found`, never 403: a scoped member shouldn't be
 * able to enumerate the projects they aren't on by watching which ids answer differently, and the
 * 404 is also literally true from their point of view. Callers `return` immediately on `false`
 * exactly like `requireRole`.
 */
import { eq, inArray } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ShipwayDb } from '../db/index.js';
import { projectMembers, projects, users } from '../db/schema.js';
import { roleAtLeast } from './authz.js';

export type ProjectAccessMode = 'all' | 'selected';

/** The project ids `userId` may act on, or `null` for "every project" (see the module comment for
 * which users that is). `null` is deliberately NOT the empty set: callers must branch on it, and
 * conflating the two would turn "sees everything" into "sees nothing". An unknown/absent user id
 * (no session — shouldn't reach here behind the global guard) resolves to the empty set, the safe
 * end of the range. */
export function accessibleProjectIds(db: ShipwayDb, userId: number | undefined): Set<number> | null {
  if (userId === undefined) return new Set();

  const user = db.select({ role: users.role, projectAccess: users.projectAccess }).from(users).where(eq(users.id, userId)).get();
  if (!user) return new Set();
  if (roleAtLeast(user.role, 'admin') || user.projectAccess === 'all') return null;

  const rows = db.select({ projectId: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, userId)).all();
  return new Set(rows.map((row) => row.projectId));
}

/** Convenience over `accessibleProjectIds` for a single project. */
export function canAccessProject(db: ShipwayDb, userId: number | undefined, projectId: number): boolean {
  const allowed = accessibleProjectIds(db, userId);
  return allowed === null || allowed.has(projectId);
}

/**
 * Route guard: 404s (`{error: 'project not found'}`) and returns `false` when the session user may
 * not act on `projectId`. Callers MUST `return` on `false` — nothing further about the response is
 * sent for them, exactly as with `requireRole`.
 */
export function requireProjectAccess(request: FastifyRequest, reply: FastifyReply, projectId: number): boolean {
  if (canAccessProject(request.server.db, request.session.get('userId'), projectId)) return true;
  reply.code(404).send({ error: 'project not found' });
  return false;
}

/** Filters an already-loaded list of project-bearing rows down to what `userId` may see. Kept here
 * (rather than inlined per route) so every list endpoint filters by the same rule. */
export function filterAccessible<T>(db: ShipwayDb, userId: number | undefined, rows: T[], projectIdOf: (row: T) => number): T[] {
  const allowed = accessibleProjectIds(db, userId);
  if (allowed === null) return rows;
  return rows.filter((row) => allowed.has(projectIdOf(row)));
}

/** The project ids explicitly granted to `userId` — the raw `project_members` rows, regardless of
 * their role or mode. This is what the Team UI edits; it is NOT the effective access (an admin has
 * every project whatever this returns). Sorted so the API response is stable. */
export function getGrantedProjectIds(db: ShipwayDb, userId: number): number[] {
  return db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId))
    .all()
    .map((row) => row.projectId)
    .sort((a, b) => a - b);
}

/**
 * Sets `userId`'s access mode and (for `'selected'`) the exact set of granted projects, replacing
 * whatever was there — the grants are a set, so this is a full replace rather than an append, and
 * passing `[]` really does mean "no projects".
 *
 * `'all'` clears every grant: leaving stale rows behind would silently resurrect an old selection
 * the next time someone switched the mode back. `projectIds` is de-duplicated and intersected with
 * the projects that actually exist, so a stale id from a client that raced a project deletion is
 * dropped instead of failing the whole request on a foreign-key error.
 *
 * Not transactional on purpose: better-sqlite3 runs these synchronously back-to-back with no `await`
 * between them, so no other request can observe the intermediate state within this process.
 */
export function setUserProjectAccess(db: ShipwayDb, userId: number, mode: ProjectAccessMode, projectIds: number[]): void {
  db.update(users).set({ projectAccess: mode }).where(eq(users.id, userId)).run();
  db.delete(projectMembers).where(eq(projectMembers.userId, userId)).run();

  if (mode === 'all' || projectIds.length === 0) return;

  const unique = [...new Set(projectIds)];
  const existing = db
    .select({ id: projects.id })
    .from(projects)
    .where(inArray(projects.id, unique))
    .all()
    .map((row) => row.id);

  if (existing.length === 0) return;
  db.insert(projectMembers)
    .values(existing.map((projectId) => ({ projectId, userId })))
    .run();
}

/**
 * Grants `userId` one project, if they're the kind of user grants apply to. A no-op for an unscoped
 * user (`projectAccess: 'all'`, or any admin/owner): they already reach every project, and writing a
 * grant row for them would be a selection that silently takes effect the day someone scopes them.
 * Also a no-op with no session user.
 *
 * Exists for project CREATION: a scoped member who creates a project would otherwise be locked out
 * of it the instant it exists.
 */
export function grantProjectAccess(db: ShipwayDb, userId: number | undefined, projectId: number): void {
  if (userId === undefined) return;

  const user = db.select({ role: users.role, projectAccess: users.projectAccess }).from(users).where(eq(users.id, userId)).get();
  if (!user || roleAtLeast(user.role, 'admin') || user.projectAccess !== 'selected') return;

  db.insert(projectMembers).values({ projectId, userId }).onConflictDoNothing().run();
}
