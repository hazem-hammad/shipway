import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { users } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import { requireRole } from '../lib/authz.js';
import { hashPassword } from '../lib/passwords.js';
import { getActor, recordAudit } from '../services/audit.js';
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

const inviteUserSchema = z.object({
  email: z.string().email(),
  role: z.enum(['member', 'admin']),
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

/** Shape returned to clients: never leaks `passwordHash` or the raw `inviteToken`. */
function toPublicUser(user: UserRow) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    inviteExpiresAt: user.inviteExpiresAt,
    createdAt: user.createdAt,
  };
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
async function emailInvite(app: FastifyInstance, log: FastifyBaseLogger, email: string, token: string): Promise<{ emailed: boolean; emailError?: string }> {
  const cfg = getMailConfig(app.db, app.secretBox);
  if (!isMailConfigured(cfg)) {
    return { emailed: false };
  }

  try {
    const baseDomain = getSetting<string>(app.db, 'base_domain');
    const { subject, text, html } = buildInviteEmail({ token, baseDomain });
    const result = await sendMail(cfg, { to: email, subject, text, html });
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
    return all.map(toPublicUser);
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

    return reply.code(201).send(toPublicUser(created));
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

    const { emailed, emailError } = await emailInvite(app, request.log, email, token);

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'user.invite', targetType: 'user', targetName: email, meta: { role, emailed } });

    return reply.code(201).send({
      id: created.id,
      email: created.email,
      role: created.role,
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

    const { emailed, emailError } = await emailInvite(app, request.log, target.email, token);

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'user.reinvite', targetType: 'user', targetName: target.email, meta: { role: target.role, emailed } });

    return reply.code(200).send({
      id: target.id,
      email: target.email,
      role: target.role,
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

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'user.role_change',
      targetType: 'user',
      targetName: target.email,
      meta: { from: target.role, to: newRole },
    });

    const updated = app.db.select().from(users).where(eq(users.id, id)).get();
    return reply.code(200).send(toPublicUser(updated ?? { ...target, role: newRole }));
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
