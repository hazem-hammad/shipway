import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { projects, users } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import { requireRole, roleAtLeast } from '../lib/authz.js';
import { getGrantedProjectIds, setUserProjectAccess, type ProjectAccessMode } from '../lib/projectaccess.js';
import { hashPassword } from '../lib/passwords.js';
import { getActor, recordAudit } from '../services/audit.js';
import { syncPgAdminServers } from '../services/pgadmin.js';
import { buildInviteEmail, getMailConfig, isMailConfigured, sendMail } from '../services/mailer.js';

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

const userIdParamsSchema = z.object({
  id: z.coerce.number().int(),
});

const inviteTokenParamsSchema = z.object({
  token: z.string().min(1),
});

/** `projectAccess`/`projectIds` are the per-project scope the invitee lands with (see
 * `lib/projectaccess.ts`). Both are optional so an older client that knows nothing about them still
 * invites successfully — omitting them means `'all'`, exactly the behavior every invite had before
 * project scoping existed. `projectIds` is ignored for `'all'` rather than rejected, since the two
 * arrive together from a UI that keeps a selection around while the mode is toggled. */
const projectScopeSchema = z.object({
  projectAccess: z.enum(['all', 'selected']).optional(),
  projectIds: z.array(z.number().int()).optional(),
});

const inviteUserSchema = z.object({
  email: z.string().email(),
  role: z.enum(['member', 'admin']),
  ...projectScopeSchema.shape,
});

/** Body of `PUT /api/users/:id/projects`: the same scope fields, but `projectAccess` is required —
 * this route's whole purpose is to set it, so leaving it out is a malformed request rather than a
 * default. */
const setProjectAccessSchema = z.object({
  projectAccess: z.enum(['all', 'selected']),
  projectIds: z.array(z.number().int()).optional(),
});

const acceptInviteSchema = z.object({
  name: z.string().min(1),
  password: z.string().min(8),
});

const changeRoleSchema = z.object({
  role: z.enum(['member', 'admin']),
});

/** Invite tokens live for 7 days from the moment they're (re-)issued (spec §1's Invites row). */
const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Placeholder `passwordHash` for an invited-but-not-yet-activated user. Deliberately NOT a valid
 * argon2 PHC string: `verifyPassword` (see `lib/passwords.ts`) catches any malformed hash and
 * returns `false` unconditionally, so this can never itself be "guessed". In practice the login
 * route never even reaches this value for a `status: 'invited'` row — it routes around it entirely
 * (see `routes/auth.ts`) — this sentinel is defense in depth, not the sole guard.
 */
const UNUSABLE_PASSWORD_HASH = '!invite-pending-no-password-set';

type UserRow = typeof users.$inferSelect;

/**
 * Shape returned to clients: never leaks `passwordHash` or the raw `inviteToken`.
 *
 * `projectAccess`/`projectIds` describe the user's project scope. Both report the EFFECTIVE access,
 * not just the stored columns: an admin/owner is always `'all'` with no id list, because that's what
 * `lib/projectaccess.ts` actually enforces for them regardless of what the row happens to say — the
 * Team UI would otherwise render a scope for an admin that has no bearing on what they can reach.
 */
function toPublicUser(db: FastifyInstance['db'], user: UserRow) {
  const effectiveAccess: ProjectAccessMode = roleAtLeast(user.role, 'admin') ? 'all' : user.projectAccess;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    inviteExpiresAt: user.inviteExpiresAt,
    createdAt: user.createdAt,
    projectAccess: effectiveAccess,
    projectIds: effectiveAccess === 'selected' ? getGrantedProjectIds(db, user.id) : [],
  };
}

/** The project NAMES for a set of ids, in the ids' own project order — only used to tell an invitee
 * what they're getting in the invite email. Unknown ids simply don't appear. */
function projectNamesFor(db: FastifyInstance['db'], projectIds: number[]): string[] {
  if (projectIds.length === 0) return [];
  return db
    .select({ name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIds))
    .orderBy(asc(projects.name))
    .all()
    .map((row) => row.name);
}

/**
 * Resolves the scope an invite/update should actually apply, given the target's role. An admin or
 * owner is pinned to `'all'` with no grants: `lib/projectaccess.ts` gives them every project anyway,
 * so storing a selection for them would be a lie the UI then displays. Everything else takes the
 * requested mode, defaulting to `'all'` when the client didn't ask (pre-scoping clients).
 */
function resolveScope(role: UserRow['role'], requested: { projectAccess?: ProjectAccessMode; projectIds?: number[] }): {
  mode: ProjectAccessMode;
  projectIds: number[];
} {
  if (roleAtLeast(role, 'admin')) return { mode: 'all', projectIds: [] };
  const mode = requested.projectAccess ?? 'all';
  return { mode, projectIds: mode === 'selected' ? (requested.projectIds ?? []) : [] };
}

/** 32 lowercase-hex characters (16 random bytes) — unguessable, URL-safe, and matches the spec's
 * "32-hex random" invite token shape. */
function generateInviteToken(): { token: string; expiresAt: number } {
  return { token: randomBytes(16).toString('hex'), expiresAt: Date.now() + INVITE_EXPIRY_MS };
}

/**
 * Emails the invite link when instance mail is configured (Task 7, spec §3 "What uses instance
 * mail" (a)). NEVER throws and never blocks the invite/reinvite response: `driver: 'none'` skips
 * sending entirely (`emailed: false`, no `emailError`), and any other failure (a transport error,
 * or even a synchronous throw while building the email) is caught, logged server-side, and
 * reported back as `emailed: false, emailError` instead of failing the request. Callers always
 * still return `inviteUrl` regardless of this outcome — email is additive, never the only path.
 */
async function emailInvite(
  app: FastifyInstance,
  log: FastifyBaseLogger,
  email: string,
  token: string,
  /** The projects the invite grants, for the email's access line — `null` for unscoped ("all
   * projects"). See `buildInviteEmail`'s `projectNames`. */
  projectNames: string[] | null,
): Promise<{ emailed: boolean; emailError?: string }> {
  const cfg = getMailConfig(app.db, app.secretBox);
  if (!isMailConfigured(cfg)) {
    return { emailed: false };
  }

  try {
    const baseDomain = getSetting<string>(app.db, 'base_domain');
    const { subject, text, html } = buildInviteEmail({ token, baseDomain, projectNames });
    // `app.mailSendTimeoutMs` bounds this (fix wave I2), so a hanging SMTP host can never stall this
    // response — the copy-link fallback the spec promises has to actually be reachable, which it
    // isn't if the request itself never comes back.
    const result = await sendMail(cfg, { to: email, subject, text, html }, undefined, app.mailSendTimeoutMs);
    if (result.ok) {
      return { emailed: true };
    }
    log.error({ email, error: result.error }, 'failed to email invite');
    return { emailed: false, emailError: result.error };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to email invite';
    log.error({ email, err }, 'failed to email invite');
    return { emailed: false, emailError: message };
  }
}

/**
 * Registers `/api/users` CRUD plus the invite lifecycle (Task 3), including Task 7's best-effort
 * invite email (`emailInvite`, above) on both `POST /api/users/invite` and
 * `POST /api/users/:id/reinvite`. Every route here sits under the global session guard in
 * `buildApp` EXCEPT `GET`/`POST /api/invite/:token`, which `buildApp` exempts via
 * `PUBLIC_API_PREFIXES` — the invitee has no session yet, and the token itself is their
 * credential. Every other handler can assume `request.session.get('userId')` is defined.
 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users', async () => {
    const all = app.db.select().from(users).all();
    return all.map((user) => toPublicUser(app.db, user));
  });

  app.post('/api/users', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const { name, email, password } = parsed.data;

    const existing = app.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
    if (existing) {
      return reply.code(409).send({ error: 'email already in use' });
    }

    const passwordHash = await hashPassword(password);
    app.db.insert(users).values({ name, email, passwordHash }).run();
    const created = app.db.select().from(users).where(eq(users.email, email)).get();
    if (!created) {
      // Should be unreachable: we just inserted this row inside this handler.
      return reply.code(500).send({ error: 'failed to create user' });
    }

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'user.create', targetType: 'user', targetName: created.email });

    // Gives them a pgAdmin account holding the current databases, so the Databases page's Manage
    // link works on their first visit rather than after the next sync. Not awaited, and never
    // throws — see services/pgadmin.ts.
    void syncPgAdminServers(app);

    return reply.code(201).send(toPublicUser(app.db, created));
  });

  /**
   * Creates a pending (`status: 'invited'`) user with a one-time token, per spec §2's Invites
   * bullet. Base gate is admin+; inviting an ADMIN additionally requires owner (ruling in Task 3's
   * brief: "admins may invite members; inviting an ADMIN requires owner"). 409s if the email is
   * already in use by an active OR invited user — never leaks which.
   */
  app.post('/api/users/invite', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsed = inviteUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const { email, role } = parsed.data;
    const scope = resolveScope(role, parsed.data);

    if (role === 'admin' && !requireRole(request, reply, 'owner')) return;

    const existing = app.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
    if (existing) {
      return reply.code(409).send({ error: 'email already in use' });
    }

    const { token, expiresAt } = generateInviteToken();
    app.db
      .insert(users)
      .values({
        name: '',
        email,
        passwordHash: UNUSABLE_PASSWORD_HASH,
        role,
        status: 'invited',
        inviteToken: token,
        inviteExpiresAt: expiresAt,
      })
      .run();

    const created = app.db.select().from(users).where(eq(users.email, email)).get();
    if (!created) {
      // Should be unreachable: we just inserted this row inside this handler.
      return reply.code(500).send({ error: 'failed to create invite' });
    }

    // Grants are attached to the pending row NOW, not on activation, so the access is already in
    // place the moment the invitee sets their password — and so the email below can name it.
    setUserProjectAccess(app.db, created.id, scope.mode, scope.projectIds);
    const grantedIds = getGrantedProjectIds(app.db, created.id);
    const projectNames = scope.mode === 'selected' ? projectNamesFor(app.db, grantedIds) : null;

    const { emailed, emailError } = await emailInvite(app, request.log, email, token, projectNames);

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'user.invite',
      targetType: 'user',
      targetName: email,
      meta: { role, emailed, projectAccess: scope.mode, projectCount: grantedIds.length },
    });

    return reply.code(201).send({
      id: created.id,
      email: created.email,
      role: created.role,
      projectAccess: scope.mode,
      projectIds: grantedIds,
      inviteUrl: `/invite/${token}`,
      expiresAt,
      emailed,
      ...(emailError !== undefined ? { emailError } : {}),
    });
  });

  /**
   * Rotates the token + expiry for a still-pending invite (admin+; owner if the invited role is
   * 'admin', mirroring `POST /api/users/invite`'s rule). 409s if the target has already activated
   * (or was never an invite at all).
   */
  app.post('/api/users/:id/reinvite', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsedParams = userIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(404).send({ error: 'user not found' });
    }
    const { id } = parsedParams.data;

    const target = app.db.select().from(users).where(eq(users.id, id)).get();
    if (!target) {
      return reply.code(404).send({ error: 'user not found' });
    }
    if (target.status !== 'invited') {
      return reply.code(409).send({ error: 'user is not pending invite' });
    }

    if (target.role === 'admin' && !requireRole(request, reply, 'owner')) return;

    const { token, expiresAt } = generateInviteToken();
    app.db.update(users).set({ inviteToken: token, inviteExpiresAt: expiresAt }).where(eq(users.id, id)).run();

    // The re-sent email describes the invite's CURRENT scope, which an admin may have changed via
    // `PUT /api/users/:id/projects` since it was first issued — reinvite never re-states the
    // original selection.
    const grantedIds = getGrantedProjectIds(app.db, target.id);
    const scopeMode: ProjectAccessMode = roleAtLeast(target.role, 'admin') ? 'all' : target.projectAccess;
    const projectNames = scopeMode === 'selected' ? projectNamesFor(app.db, grantedIds) : null;

    const { emailed, emailError } = await emailInvite(app, request.log, target.email, token, projectNames);

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'user.reinvite', targetType: 'user', targetName: target.email, meta: { role: target.role, emailed } });

    return reply.code(200).send({
      id: target.id,
      email: target.email,
      role: target.role,
      projectAccess: scopeMode,
      projectIds: scopeMode === 'selected' ? grantedIds : [],
      inviteUrl: `/invite/${token}`,
      expiresAt,
      emailed,
      ...(emailError !== undefined ? { emailError } : {}),
    });
  });

  /**
   * Public preview for the invite-accept page: `{email, valid}` only — `valid` is `false` for an
   * unknown token, an expired one, or one that's already been used (status no longer 'invited'),
   * and the `email` is withheld (`''`) in every invalid case so an unauthenticated caller can't
   * learn anything beyond "this link doesn't work".
   */
  app.get('/api/invite/:token', async (request) => {
    const parsedParams = inviteTokenParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return { email: '', valid: false };
    }

    const user = app.db.select().from(users).where(eq(users.inviteToken, parsedParams.data.token)).get();
    const valid = user !== undefined && user.status === 'invited' && (user.inviteExpiresAt ?? 0) > Date.now();

    return { email: valid ? user!.email : '', valid };
  });

  /**
   * Activates a pending invite: sets name/password, flips `status` to 'active', clears the token
   * fields (single-use), and auto-logs the new user in. 404 for an unknown/already-used token, 410
   * for a known-but-expired one — checked in that order, before the request body is even validated,
   * since a stale/reused link is the more informative failure to report first.
   */
  app.post('/api/invite/:token', async (request, reply) => {
    const parsedParams = inviteTokenParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(404).send({ error: 'invite not found' });
    }

    const user = app.db.select().from(users).where(eq(users.inviteToken, parsedParams.data.token)).get();
    if (!user || user.status !== 'invited') {
      return reply.code(404).send({ error: 'invite not found' });
    }
    if ((user.inviteExpiresAt ?? 0) <= Date.now()) {
      return reply.code(410).send({ error: 'invite expired' });
    }

    const parsedBody = acceptInviteSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const { name, password } = parsedBody.data;

    const passwordHash = await hashPassword(password);
    app.db
      .update(users)
      .set({ name, passwordHash, status: 'active', inviteToken: null, inviteExpiresAt: null })
      .where(eq(users.id, user.id))
      .run();

    request.session.set('userId', user.id);

    // Actor is the newly-activated user themselves, per Task 3's audit requirements.
    const actor = getActor(app.db, user.id);
    recordAudit(app.db, { ...actor, action: 'user.accept_invite', targetType: 'user', targetName: user.email });

    // Same reason as `POST /api/users`: their pgAdmin account and its server list are built now,
    // not on their first click of a Postgres database's Manage link.
    void syncPgAdminServers(app);

    return reply.code(200).send({ id: user.id, name, email: user.email, role: user.role });
  });

  /**
   * Changes a user's `member`/`admin` role. The owner role is a singleton and immutable through
   * this route for anyone, including the owner themself (self-demotion is impossible — spec §1).
   * Any transition that touches 'admin' — either the target's CURRENT role or the requested NEW
   * one — requires owner; that's the only case a plain admin actor is blocked, so e.g. an admin
   * changing a member to member (a no-op) still succeeds.
   */
  app.patch('/api/users/:id/role', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsedParams = userIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(404).send({ error: 'user not found' });
    }
    const { id } = parsedParams.data;

    const parsedBody = changeRoleSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const { role: newRole } = parsedBody.data;

    const target = app.db.select().from(users).where(eq(users.id, id)).get();
    if (!target) {
      return reply.code(404).send({ error: 'user not found' });
    }

    if (target.role === 'owner') {
      return reply.code(403).send({ error: "cannot change the owner's role" });
    }

    const involvesAdmin = target.role === 'admin' || newRole === 'admin';
    if (involvesAdmin && !requireRole(request, reply, 'owner')) return;

    app.db.update(users).set({ role: newRole }).where(eq(users.id, id)).run();

    // Promoting to admin drops any project scope: an admin reaches every project regardless (see
    // `lib/projectaccess.ts`), so leaving the old grants in place would strand a selection that no
    // longer means anything — and would silently come back into force on a later demotion.
    if (newRole === 'admin') {
      setUserProjectAccess(app.db, id, 'all', []);
    }

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'user.role_change',
      targetType: 'user',
      targetName: target.email,
      meta: { from: target.role, to: newRole },
    });

    const updated = app.db.select().from(users).where(eq(users.id, id)).get();
    return reply.code(200).send(toPublicUser(app.db, updated ?? { ...target, role: newRole }));
  });

  /**
   * Replaces a user's project scope (`lib/projectaccess.ts`): `{projectAccess: 'all'}` for every
   * project, or `{projectAccess: 'selected', projectIds: [...]}` for exactly those. The grants are a
   * SET, so this is a full replace — sending `[]` really does mean "no projects", and there is no
   * partial/append form.
   *
   * Admin+ to call, owner to target an admin (the same rule invite and role-change use). Targeting
   * an admin or the owner is accepted but always normalizes to `'all'` with no grants: they reach
   * every project by role, so storing a narrower selection for them would be recorded, displayed,
   * and never enforced.
   */
  app.put('/api/users/:id/projects', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsedParams = userIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(404).send({ error: 'user not found' });
    }
    const { id } = parsedParams.data;

    const parsedBody = setProjectAccessSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const target = app.db.select().from(users).where(eq(users.id, id)).get();
    if (!target) {
      return reply.code(404).send({ error: 'user not found' });
    }

    if (roleAtLeast(target.role, 'admin') && !requireRole(request, reply, 'owner')) return;

    const scope = resolveScope(target.role, parsedBody.data);
    setUserProjectAccess(app.db, id, scope.mode, scope.projectIds);

    const updated = app.db.select().from(users).where(eq(users.id, id)).get();
    const result = toPublicUser(app.db, updated ?? { ...target, projectAccess: scope.mode });

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'user.project_access',
      targetType: 'user',
      targetName: target.email,
      // Ids, not names: the audit row has to stay readable after a project is renamed or deleted,
      // and a count alone wouldn't say WHICH access was granted.
      meta: { projectAccess: result.projectAccess, projectIds: result.projectIds },
    });

    return reply.code(200).send(result);
  });

  app.delete('/api/users/:id', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsedParams = userIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(404).send({ error: 'user not found' });
    }
    const { id } = parsedParams.data;

    const sessionUserId = request.session.get('userId');
    if (sessionUserId !== undefined && id === sessionUserId) {
      return reply.code(403).send({ error: 'cannot delete your own account' });
    }

    const existing = app.db.select({ id: users.id, email: users.email, role: users.role }).from(users).where(eq(users.id, id)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'user not found' });
    }

    // The owner is undeletable, full stop — regardless of who's asking (self-delete is already
    // caught above; this also blocks e.g. an admin targeting the owner).
    if (existing.role === 'owner') {
      return reply.code(403).send({ error: 'cannot delete the owner' });
    }

    // Deleting an admin (or a still-pending invited admin) requires owner; members and invited
    // members are admin+-deletable per the base gate above.
    if (existing.role === 'admin' && !requireRole(request, reply, 'owner')) return;

    app.db.delete(users).where(eq(users.id, id)).run();

    const actor = getActor(app.db, sessionUserId);
    recordAudit(app.db, { ...actor, action: 'user.delete', targetType: 'user', targetName: existing.email });

    return reply.code(204).send();
  });
}
