/**
 * Team invite lifecycle + role management (plan Task 3, spec §1 "Team roles"/"Invites" + §2's
 * invites bullet): `POST /api/users/invite`, `POST /api/users/:id/reinvite`, the public
 * `GET`/`POST /api/invite/:token` pair, `PATCH /api/users/:id/role`, and the extended
 * `DELETE /api/users/:id` rules. Role-matrix basics for admin-gated routes already live in
 * `role-matrix.test.ts`; this file focuses on the owner-vs-admin distinctions and invite state
 * machine that are new in Task 3.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { auditEvents, users } from '../src/db/schema.js';
import { buildOwnerApp, createAdmin, createMember, sessionCookie } from './helpers.js';

const FORBIDDEN_ADMIN = { error: 'requires admin' };
const FORBIDDEN_OWNER = { error: 'requires owner' };
const INVALID_LOGIN = { error: 'invalid email or password' };

interface InviteResponse {
  id: number;
  email: string;
  role: 'member' | 'admin';
  inviteUrl: string;
  expiresAt: number;
}

function tokenFromInviteUrl(inviteUrl: string): string {
  const parts = inviteUrl.split('/');
  return parts[parts.length - 1]!;
}

function auditRowsFor(app: FastifyInstance, action: string) {
  return app.db.select().from(auditEvents).where(eq(auditEvents.action, action)).all();
}

async function invite(
  app: FastifyInstance,
  cookie: string,
  body: { email: string; role: 'member' | 'admin' },
): Promise<{ statusCode: number; json: InviteResponse }> {
  const res = await app.inject({ method: 'POST', url: '/api/users/invite', headers: { cookie }, payload: body });
  return { statusCode: res.statusCode, json: res.json() as InviteResponse };
}

describe('POST /api/users/invite', () => {
  it('member is forbidden; admin can invite a member; response never includes the raw token field', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);

    const memberAttempt = await invite(app, memberCookie, { email: 'blocked@example.com', role: 'member' });
    expect(memberAttempt.statusCode).toBe(403);
    expect(memberAttempt.json).toEqual(FORBIDDEN_ADMIN);

    const adminInvite = await invite(app, adminCookie, { email: 'newbie@example.com', role: 'member' });
    expect(adminInvite.statusCode).toBe(201);
    expect(adminInvite.json).toMatchObject({ email: 'newbie@example.com', role: 'member' });
    expect(typeof adminInvite.json.id).toBe('number');
    expect(adminInvite.json.inviteUrl).toBe(`/invite/${tokenFromInviteUrl(adminInvite.json.inviteUrl)}`);
    expect(tokenFromInviteUrl(adminInvite.json.inviteUrl)).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof adminInvite.json.expiresAt).toBe('number');
    expect(adminInvite.json.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(adminInvite.json)).not.toContain('inviteToken');

    void ownerCookie;
    await app.close();
  });

  it('inviting an admin requires owner: admin gets 403, owner succeeds', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { cookie: adminCookie } = await createAdmin(app);

    const adminAttempt = await invite(app, adminCookie, { email: 'wannabe-admin@example.com', role: 'admin' });
    expect(adminAttempt.statusCode).toBe(403);
    expect(adminAttempt.json).toEqual(FORBIDDEN_OWNER);

    const ownerInvite = await invite(app, ownerCookie, { email: 'new-admin@example.com', role: 'admin' });
    expect(ownerInvite.statusCode).toBe(201);
    expect(ownerInvite.json).toMatchObject({ email: 'new-admin@example.com', role: 'admin' });

    await app.close();
  });

  it('409s when the email already exists, whether active or invited', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    await createMember(app, { email: 'active@example.com' });
    await invite(app, ownerCookie, { email: 'pending@example.com', role: 'member' });

    const dupActive = await invite(app, ownerCookie, { email: 'active@example.com', role: 'member' });
    expect(dupActive.statusCode).toBe(409);

    const dupInvited = await invite(app, ownerCookie, { email: 'pending@example.com', role: 'member' });
    expect(dupInvited.statusCode).toBe(409);

    await app.close();
  });

  it('400s on an invalid role or malformed email', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();

    const badRole = await invite(app, ownerCookie, { email: 'x@example.com', role: 'owner' as 'admin' });
    expect(badRole.statusCode).toBe(400);

    const badEmail = await app.inject({
      method: 'POST',
      url: '/api/users/invite',
      headers: { cookie: ownerCookie },
      payload: { email: 'not-an-email', role: 'member' },
    });
    expect(badEmail.statusCode).toBe(400);

    await app.close();
  });

  it('records a user.invite audit row with meta.role', async () => {
    const { app, cookie: ownerCookie, userId: ownerId } = await buildOwnerApp();

    await invite(app, ownerCookie, { email: 'audited@example.com', role: 'member' });

    const rows = auditRowsFor(app, 'user.invite');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: ownerId, targetType: 'user', targetName: 'audited@example.com' });
    expect(JSON.parse(rows[0]!.meta!)).toEqual({ role: 'member' });

    await app.close();
  });
});

describe('full invite lifecycle', () => {
  it('invite -> GET token -> accept -> auto-login session works -> token reuse 404 -> login works after accept', async () => {
    const { app, cookie: ownerCookie, userId: ownerId } = await buildOwnerApp();

    const created = await invite(app, ownerCookie, { email: 'lifecycle@example.com', role: 'member' });
    expect(created.statusCode).toBe(201);
    const token = tokenFromInviteUrl(created.json.inviteUrl);

    const preview = await app.inject({ method: 'GET', url: `/api/invite/${token}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ email: 'lifecycle@example.com', valid: true });

    const accept = await app.inject({
      method: 'POST',
      url: `/api/invite/${token}`,
      payload: { name: 'New Person', password: 'a-strong-password' },
    });
    expect(accept.statusCode).toBe(200);
    const acceptCookie = sessionCookie(accept);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: acceptCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: created.json.id, name: 'New Person', email: 'lifecycle@example.com' });

    // Single-use: the token is cleared on accept.
    const reusePreview = await app.inject({ method: 'GET', url: `/api/invite/${token}` });
    expect(reusePreview.json()).toEqual({ email: '', valid: false });

    const reuseAccept = await app.inject({
      method: 'POST',
      url: `/api/invite/${token}`,
      payload: { name: 'Someone Else', password: 'another-password' },
    });
    expect(reuseAccept.statusCode).toBe(404);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'lifecycle@example.com', password: 'a-strong-password' },
    });
    expect(login.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: ownerCookie } });
    const listedUser = (list.json() as Array<{ id: number; status: string; role: string }>).find((u) => u.id === created.json.id);
    expect(listedUser).toMatchObject({ status: 'active', role: 'member' });

    void ownerId;
    await app.close();
  });

  it('records a user.accept_invite audit row where the actor is the newly-activated user', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();

    const created = await invite(app, ownerCookie, { email: 'auditee@example.com', role: 'member' });
    const token = tokenFromInviteUrl(created.json.inviteUrl);

    await app.inject({
      method: 'POST',
      url: `/api/invite/${token}`,
      payload: { name: 'Auditee', password: 'a-strong-password' },
    });

    const rows = auditRowsFor(app, 'user.accept_invite');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: created.json.id, actorName: 'Auditee', targetType: 'user', targetName: 'auditee@example.com' });

    await app.close();
  });

  it('GET /api/invite/:token 200s {valid:false} for an unknown token, without leaking an email', async () => {
    const { app } = await buildOwnerApp();

    const res = await app.inject({ method: 'GET', url: '/api/invite/0000000000000000000000000000ff' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: '', valid: false });

    await app.close();
  });

  it('POST /api/invite/:token 404s for an unknown token', async () => {
    const { app } = await buildOwnerApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/invite/0000000000000000000000000000ff',
      payload: { name: 'Nobody', password: 'whatever-password' },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('POST /api/invite/:token 400s on a too-short password or empty name', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const created = await invite(app, ownerCookie, { email: 'validate-body@example.com', role: 'member' });
    const token = tokenFromInviteUrl(created.json.inviteUrl);

    const shortPassword = await app.inject({ method: 'POST', url: `/api/invite/${token}`, payload: { name: 'X', password: 'short' } });
    expect(shortPassword.statusCode).toBe(400);

    const emptyName = await app.inject({ method: 'POST', url: `/api/invite/${token}`, payload: { name: '', password: 'a-long-password' } });
    expect(emptyName.statusCode).toBe(400);

    await app.close();
  });

  it('expiry: an expired token 410s on accept and reports valid:false on GET', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const created = await invite(app, ownerCookie, { email: 'expired@example.com', role: 'member' });
    const token = tokenFromInviteUrl(created.json.inviteUrl);

    app.db.update(users).set({ inviteExpiresAt: Date.now() - 1000 }).where(eq(users.id, created.json.id)).run();

    const preview = await app.inject({ method: 'GET', url: `/api/invite/${token}` });
    expect(preview.json()).toEqual({ email: '', valid: false });

    const accept = await app.inject({
      method: 'POST',
      url: `/api/invite/${token}`,
      payload: { name: 'Too Late', password: 'a-strong-password' },
    });
    expect(accept.statusCode).toBe(410);
    expect(accept.json()).toEqual({ error: 'invite expired' });

    await app.close();
  });

  it('an invited user cannot log in: same generic 401 body as a wrong password', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    await invite(app, ownerCookie, { email: 'pending-login@example.com', role: 'member' });

    const invitedLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'pending-login@example.com', password: 'anything-at-all' },
    });
    expect(invitedLogin.statusCode).toBe(401);
    expect(invitedLogin.json()).toEqual(INVALID_LOGIN);

    const wrongPasswordLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unknown@example.com', password: 'anything-at-all' },
    });
    expect(wrongPasswordLogin.statusCode).toBe(401);
    expect(wrongPasswordLogin.json()).toEqual(INVALID_LOGIN);

    await app.close();
  });
});

describe('POST /api/users/:id/reinvite', () => {
  it('rotates token + expiry; the old token stops working and the new one works', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const created = await invite(app, ownerCookie, { email: 'reinvite@example.com', role: 'member' });
    const oldToken = tokenFromInviteUrl(created.json.inviteUrl);

    const reinvite = await app.inject({ method: 'POST', url: `/api/users/${created.json.id}/reinvite`, headers: { cookie: ownerCookie } });
    expect(reinvite.statusCode).toBe(200);
    const newToken = tokenFromInviteUrl((reinvite.json() as InviteResponse).inviteUrl);
    expect(newToken).not.toBe(oldToken);

    const oldPreview = await app.inject({ method: 'GET', url: `/api/invite/${oldToken}` });
    expect(oldPreview.json()).toEqual({ email: '', valid: false });

    const newPreview = await app.inject({ method: 'GET', url: `/api/invite/${newToken}` });
    expect(newPreview.json()).toEqual({ email: 'reinvite@example.com', valid: true });

    const accept = await app.inject({
      method: 'POST',
      url: `/api/invite/${newToken}`,
      payload: { name: 'Reinvited', password: 'a-strong-password' },
    });
    expect(accept.statusCode).toBe(200);

    await app.close();
  });

  it('409s when the target is not currently invited', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { userId: memberId } = await createMember(app);

    const res = await app.inject({ method: 'POST', url: `/api/users/${memberId}/reinvite`, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it('member is forbidden; reinviting an invited admin requires owner', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const { cookie: adminCookie } = await createAdmin(app);
    const adminInvite = await invite(app, ownerCookie, { email: 'invited-admin@example.com', role: 'admin' });

    const memberAttempt = await app.inject({
      method: 'POST',
      url: `/api/users/${adminInvite.json.id}/reinvite`,
      headers: { cookie: memberCookie },
    });
    expect(memberAttempt.statusCode).toBe(403);
    expect(memberAttempt.json()).toEqual(FORBIDDEN_ADMIN);

    const adminAttempt = await app.inject({
      method: 'POST',
      url: `/api/users/${adminInvite.json.id}/reinvite`,
      headers: { cookie: adminCookie },
    });
    expect(adminAttempt.statusCode).toBe(403);
    expect(adminAttempt.json()).toEqual(FORBIDDEN_OWNER);

    const ownerAttempt = await app.inject({
      method: 'POST',
      url: `/api/users/${adminInvite.json.id}/reinvite`,
      headers: { cookie: ownerCookie },
    });
    expect(ownerAttempt.statusCode).toBe(200);

    await app.close();
  });

  it('records a user.reinvite audit row', async () => {
    const { app, cookie: ownerCookie, userId: ownerId } = await buildOwnerApp();
    const created = await invite(app, ownerCookie, { email: 'reinvite-audit@example.com', role: 'member' });

    await app.inject({ method: 'POST', url: `/api/users/${created.json.id}/reinvite`, headers: { cookie: ownerCookie } });

    const rows = auditRowsFor(app, 'user.reinvite');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: ownerId, targetType: 'user', targetName: 'reinvite-audit@example.com' });

    await app.close();
  });
});

describe('GET /api/users list shape', () => {
  it('includes role/status/inviteExpiresAt and never inviteToken', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    await createMember(app, { email: 'active-member@example.com' });
    const invited = await invite(app, ownerCookie, { email: 'invited-member@example.com', role: 'member' });

    const res = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<Record<string, unknown>>;

    const activeRow = list.find((u) => u.email === 'active-member@example.com')!;
    expect(activeRow).toMatchObject({ role: 'member', status: 'active' });
    expect(activeRow.inviteToken).toBeUndefined();
    expect(activeRow.passwordHash).toBeUndefined();

    const invitedRow = list.find((u) => u.email === 'invited-member@example.com')!;
    expect(invitedRow).toMatchObject({ id: invited.json.id, role: 'member', status: 'invited' });
    expect(invitedRow.inviteExpiresAt).toBeGreaterThan(Date.now());
    expect(invitedRow.inviteToken).toBeUndefined();
    expect(invitedRow.passwordHash).toBeUndefined();
    expect(JSON.stringify(invitedRow)).not.toContain(tokenFromInviteUrl(invited.json.inviteUrl));

    await app.close();
  });
});

describe('PATCH /api/users/:id/role', () => {
  it('member is forbidden', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);
    const { userId: otherMemberId } = await createMember(app, { email: 'other-member@example.com' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${otherMemberId}/role`,
      headers: { cookie: memberCookie },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN_ADMIN);

    await app.close();
  });

  it('admin can no-op change a member to member', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: adminCookie } = await createAdmin(app);
    const { userId: memberId } = await createMember(app);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${memberId}/role`,
      headers: { cookie: adminCookie },
      payload: { role: 'member' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'member' });

    await app.close();
  });

  it('promoting a member to admin requires owner: admin 403s, owner succeeds with an audit row', async () => {
    const { app, cookie: ownerCookie, userId: ownerId } = await buildOwnerApp();
    const { cookie: adminCookie } = await createAdmin(app);
    const { userId: memberId } = await createMember(app);

    const adminAttempt = await app.inject({
      method: 'PATCH',
      url: `/api/users/${memberId}/role`,
      headers: { cookie: adminCookie },
      payload: { role: 'admin' },
    });
    expect(adminAttempt.statusCode).toBe(403);
    expect(adminAttempt.json()).toEqual(FORBIDDEN_OWNER);

    const ownerAttempt = await app.inject({
      method: 'PATCH',
      url: `/api/users/${memberId}/role`,
      headers: { cookie: ownerCookie },
      payload: { role: 'admin' },
    });
    expect(ownerAttempt.statusCode).toBe(200);
    expect(ownerAttempt.json()).toMatchObject({ role: 'admin' });

    const rows = auditRowsFor(app, 'user.role_change');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: ownerId, targetType: 'user' });
    expect(JSON.parse(rows[0]!.meta!)).toEqual({ from: 'member', to: 'admin' });

    await app.close();
  });

  it('admin cannot touch admins: demoting an admin requires owner', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { cookie: adminCookieA } = await createAdmin(app, { email: 'admin-a@example.com' });
    const { userId: adminBId } = await createAdmin(app, { email: 'admin-b@example.com' });

    const adminAttempt = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminBId}/role`,
      headers: { cookie: adminCookieA },
      payload: { role: 'member' },
    });
    expect(adminAttempt.statusCode).toBe(403);
    expect(adminAttempt.json()).toEqual(FORBIDDEN_OWNER);

    const ownerAttempt = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminBId}/role`,
      headers: { cookie: ownerCookie },
      payload: { role: 'member' },
    });
    expect(ownerAttempt.statusCode).toBe(200);

    await app.close();
  });

  it("nobody can change the owner's role: owner cannot self-demote, admin cannot touch the owner", async () => {
    const { app, cookie: ownerCookie, userId: ownerId } = await buildOwnerApp();
    const { cookie: adminCookie } = await createAdmin(app);

    const selfAttempt = await app.inject({
      method: 'PATCH',
      url: `/api/users/${ownerId}/role`,
      headers: { cookie: ownerCookie },
      payload: { role: 'admin' },
    });
    expect(selfAttempt.statusCode).toBe(403);

    const adminAttempt = await app.inject({
      method: 'PATCH',
      url: `/api/users/${ownerId}/role`,
      headers: { cookie: adminCookie },
      payload: { role: 'member' },
    });
    expect(adminAttempt.statusCode).toBe(403);

    const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: ownerCookie } });
    const ownerRow = (list.json() as Array<{ id: number; role: string }>).find((u) => u.id === ownerId);
    expect(ownerRow?.role).toBe('owner');

    await app.close();
  });

  it('404s for an unknown user id and 400s on an invalid role', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { userId: memberId } = await createMember(app);

    const unknown = await app.inject({
      method: 'PATCH',
      url: '/api/users/999999/role',
      headers: { cookie: ownerCookie },
      payload: { role: 'admin' },
    });
    expect(unknown.statusCode).toBe(404);

    const badRole = await app.inject({
      method: 'PATCH',
      url: `/api/users/${memberId}/role`,
      headers: { cookie: ownerCookie },
      payload: { role: 'owner' },
    });
    expect(badRole.statusCode).toBe(400);

    await app.close();
  });
});

describe('DELETE /api/users/:id (extended rules)', () => {
  it('admin may delete a member and an invited user', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { cookie: adminCookie } = await createAdmin(app);
    const { userId: memberId } = await createMember(app);
    const invitedUser = await invite(app, ownerCookie, { email: 'to-delete-invited@example.com', role: 'member' });

    const deleteMember = await app.inject({ method: 'DELETE', url: `/api/users/${memberId}`, headers: { cookie: adminCookie } });
    expect(deleteMember.statusCode).toBe(204);

    const deleteInvited = await app.inject({ method: 'DELETE', url: `/api/users/${invitedUser.json.id}`, headers: { cookie: adminCookie } });
    expect(deleteInvited.statusCode).toBe(204);

    await app.close();
  });

  it('deleting an admin requires owner: admin 403s, owner succeeds', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { cookie: adminCookieA } = await createAdmin(app, { email: 'admin-a@example.com' });
    const { userId: adminBId } = await createAdmin(app, { email: 'admin-b@example.com' });

    const adminAttempt = await app.inject({ method: 'DELETE', url: `/api/users/${adminBId}`, headers: { cookie: adminCookieA } });
    expect(adminAttempt.statusCode).toBe(403);
    expect(adminAttempt.json()).toEqual(FORBIDDEN_OWNER);

    const ownerAttempt = await app.inject({ method: 'DELETE', url: `/api/users/${adminBId}`, headers: { cookie: ownerCookie } });
    expect(ownerAttempt.statusCode).toBe(204);

    await app.close();
  });

  it('the owner is undeletable by anyone, including themself', async () => {
    const { app, cookie: ownerCookie, userId: ownerId } = await buildOwnerApp();
    const { cookie: adminCookie } = await createAdmin(app);

    const selfAttempt = await app.inject({ method: 'DELETE', url: `/api/users/${ownerId}`, headers: { cookie: ownerCookie } });
    expect(selfAttempt.statusCode).toBe(403);
    expect(selfAttempt.json()).toEqual({ error: 'cannot delete your own account' });

    const adminAttempt = await app.inject({ method: 'DELETE', url: `/api/users/${ownerId}`, headers: { cookie: adminCookie } });
    expect(adminAttempt.statusCode).toBe(403);

    await app.close();
  });

  it('self-delete stays 403 for a non-owner admin', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: adminCookie, userId: adminId } = await createAdmin(app);

    const res = await app.inject({ method: 'DELETE', url: `/api/users/${adminId}`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'cannot delete your own account' });

    await app.close();
  });

  it('records a user.delete audit row', async () => {
    const { app, cookie: ownerCookie, userId: ownerId } = await buildOwnerApp();
    const { userId: memberId } = await createMember(app, { email: 'audit-delete@example.com' });

    await app.inject({ method: 'DELETE', url: `/api/users/${memberId}`, headers: { cookie: ownerCookie } });

    const rows = auditRowsFor(app, 'user.delete');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: ownerId, targetType: 'user', targetName: 'audit-delete@example.com' });

    await app.close();
  });
});
