/**
 * Task 7 (spec §3 "What uses instance mail" (a)): `POST /api/users/invite` and
 * `POST /api/users/:id/reinvite` additionally email the invite link through instance mail when it's
 * configured. The invite lifecycle itself (roles, 409s, expiry, accept flow) is already covered by
 * `invites.test.ts`, including the mail-unconfigured baseline (`emailed: false`, no `emailError`,
 * unchanged from before this task) — this file is scoped to the emailed/failed/base_domain-unset
 * states layered on top, using a mocked `nodemailer` transport (see `services/mailer.ts`'s
 * `sendMail`/`defaultTransportFactory`) so no real network call is ever made.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditEvents } from '../src/db/schema.js';
import { buildOwnerApp } from './helpers.js';

const sendMailMock = vi.fn();

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail: sendMailMock }),
  },
}));

interface InviteEmailResponse {
  id: number;
  email: string;
  role: 'member' | 'admin';
  inviteUrl: string;
  expiresAt: number;
  emailed: boolean;
  emailError?: string;
}

function tokenFromInviteUrl(inviteUrl: string): string {
  const parts = inviteUrl.split('/');
  return parts[parts.length - 1]!;
}

async function setBaseDomain(app: FastifyInstance, cookie: string, baseDomain: string): Promise<void> {
  const res = await app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { base_domain: baseDomain } });
  expect(res.statusCode).toBe(200);
}

async function configureSmtpMail(app: FastifyInstance, cookie: string): Promise<void> {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/settings/mail',
    headers: { cookie },
    payload: { driver: 'smtp', host: 'smtp.example.com', port: 587, fromAddress: 'noreply@example.com' },
  });
  expect(res.statusCode).toBe(200);
}

beforeEach(() => {
  sendMailMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/users/invite — email delivery', () => {
  it('emails the invite when mail is configured: subject + body contain the exact URL and token, response says emailed:true', async () => {
    const { app, cookie } = await buildOwnerApp();
    await setBaseDomain(app, cookie, 'intcore.dev');
    await configureSmtpMail(app, cookie);
    sendMailMock.mockResolvedValue({ messageId: 'abc' });

    const res = await app.inject({ method: 'POST', url: '/api/users/invite', headers: { cookie }, payload: { email: 'newbie@example.com', role: 'member' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as InviteEmailResponse;
    expect(body.emailed).toBe(true);
    expect(body.emailError).toBeUndefined();
    // The relative inviteUrl in the response is unchanged either way.
    expect(body.inviteUrl).toBe(`/invite/${tokenFromInviteUrl(body.inviteUrl)}`);

    const token = tokenFromInviteUrl(body.inviteUrl);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const sent = sendMailMock.mock.calls[0]![0] as { to: string; subject: string; text: string; html: string };
    expect(sent.to).toBe('newbie@example.com');
    expect(sent.subject).toBe("You're invited to Shipway");

    const expectedUrl = `https://ship.intcore.dev/invite/${token}`;
    expect(sent.text).toContain(expectedUrl);
    expect(sent.html).toContain(expectedUrl);
    expect(sent.text).toContain(token);
    expect(sent.html).toContain(token);

    await app.close();
  });

  it('mail-unconfigured path is unchanged: emailed:false, no send attempted', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({ method: 'POST', url: '/api/users/invite', headers: { cookie }, payload: { email: 'plain@example.com', role: 'member' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as InviteEmailResponse;
    expect(body.emailed).toBe(false);
    expect(body.emailError).toBeUndefined();
    expect(sendMailMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('mail-throws path: still 201 with emailed:false + a sanitized error, and the invite itself stays valid', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureSmtpMail(app, cookie);
    sendMailMock.mockRejectedValue(new Error('connection refused'));

    const res = await app.inject({ method: 'POST', url: '/api/users/invite', headers: { cookie }, payload: { email: 'broken@example.com', role: 'member' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as InviteEmailResponse;
    expect(body.emailed).toBe(false);
    expect(body.emailError).toBe('connection refused');

    const token = tokenFromInviteUrl(body.inviteUrl);
    const preview = await app.inject({ method: 'GET', url: `/api/invite/${token}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ email: 'broken@example.com', valid: true });

    const accept = await app.inject({
      method: 'POST',
      url: `/api/invite/${token}`,
      payload: { name: 'Broken Mail', password: 'a-strong-password' },
    });
    expect(accept.statusCode).toBe(200);

    await app.close();
  });

  it('mail-timeout path (fix wave I2): still 201 with emailed:false + the copy link, well inside a short injected cap', async () => {
    // A short `mailSendTimeoutMs` override (see app.ts's `deps.mailSendTimeoutMs`, threaded to
    // `sendMail`'s `timeoutMs`) so this test proves the route answers promptly without waiting out
    // the real ~12s `DEFAULT_MAIL_TIMEOUT_MS` cap — the actual bug (I2) was the invite route hanging
    // for minutes against an unreachable SMTP host, since the send was awaited inline before
    // responding with no timeout anywhere in the chain.
    const { app, cookie } = await buildOwnerApp({ mailSendTimeoutMs: 30 });
    await configureSmtpMail(app, cookie);
    sendMailMock.mockImplementation(() => new Promise(() => {})); // never resolves

    const start = Date.now();
    const res = await app.inject({ method: 'POST', url: '/api/users/invite', headers: { cookie }, payload: { email: 'stalled@example.com', role: 'member' } });
    expect(Date.now() - start).toBeLessThan(1000);

    expect(res.statusCode).toBe(201);
    const body = res.json() as InviteEmailResponse;
    expect(body.emailed).toBe(false);
    expect(body.emailError).toMatch(/timed out/);
    // The copy-link fallback the spec promises is reachable: the response carries a valid invite URL
    // even though the email itself never went out.
    expect(body.inviteUrl).toBe(`/invite/${tokenFromInviteUrl(body.inviteUrl)}`);

    await app.close();
  });

  it('base_domain unset: still emails, with a relative-path note instead of a fabricated host', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureSmtpMail(app, cookie);
    sendMailMock.mockResolvedValue({ messageId: 'abc' });

    const res = await app.inject({ method: 'POST', url: '/api/users/invite', headers: { cookie }, payload: { email: 'nodomain@example.com', role: 'member' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as InviteEmailResponse;
    expect(body.emailed).toBe(true);

    const token = tokenFromInviteUrl(body.inviteUrl);
    const sent = sendMailMock.mock.calls[0]![0] as { text: string; html: string };
    expect(sent.text).toContain(`/invite/${token}`);
    expect(sent.text).not.toMatch(/https:\/\/deploy\./);
    expect(sent.html).not.toMatch(/https:\/\/deploy\./);

    await app.close();
  });

  it('records a user.invite audit row with meta.emailed:true — no addresses beyond targetName, no credentials', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureSmtpMail(app, cookie);
    sendMailMock.mockResolvedValue({ messageId: 'abc' });

    await app.inject({ method: 'POST', url: '/api/users/invite', headers: { cookie }, payload: { email: 'audited-emailed@example.com', role: 'member' } });

    const rows = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'user.invite')).all();
    const row = rows.find((r) => r.targetName === 'audited-emailed@example.com');
    expect(row).toBeDefined();
    // `projectAccess`/`projectCount` record WHAT access the invite granted (see
    // `lib/projectaccess.ts`) — a count, never project names, keeping this row as free of
    // free-form data as the rest of the audit trail.
    expect(JSON.parse(row!.meta!)).toEqual({ role: 'member', emailed: true, projectAccess: 'all', projectCount: 0 });
    expect(row!.meta).not.toContain('smtp.example.com');

    await app.close();
  });
});

describe('POST /api/users/:id/reinvite — email delivery', () => {
  it('emails the regenerated link too, using the new token (not the original one)', async () => {
    const { app, cookie } = await buildOwnerApp();
    await setBaseDomain(app, cookie, 'intcore.dev');
    await configureSmtpMail(app, cookie);
    sendMailMock.mockResolvedValue({ messageId: 'abc' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/users/invite',
      headers: { cookie },
      payload: { email: 'reinvite-email@example.com', role: 'member' },
    });
    const originalToken = tokenFromInviteUrl((created.json() as InviteEmailResponse).inviteUrl);
    sendMailMock.mockClear();

    const id = (created.json() as InviteEmailResponse).id;
    const res = await app.inject({ method: 'POST', url: `/api/users/${id}/reinvite`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as InviteEmailResponse;
    expect(body.emailed).toBe(true);

    const newToken = tokenFromInviteUrl(body.inviteUrl);
    expect(newToken).not.toBe(originalToken);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const sent = sendMailMock.mock.calls[0]![0] as { to: string; text: string };
    expect(sent.to).toBe('reinvite-email@example.com');
    expect(sent.text).toContain(`https://ship.intcore.dev/invite/${newToken}`);
    expect(sent.text).not.toContain(originalToken);

    await app.close();
  });

  it('reinvite mail-throws path: still 200 with emailed:false + sanitized error', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureSmtpMail(app, cookie);
    sendMailMock.mockResolvedValueOnce({ messageId: 'ok' }).mockRejectedValueOnce(new Error('550 mailbox unavailable'));

    const created = await app.inject({
      method: 'POST',
      url: '/api/users/invite',
      headers: { cookie },
      payload: { email: 'reinvite-fail@example.com', role: 'member' },
    });
    const id = (created.json() as InviteEmailResponse).id;

    const res = await app.inject({ method: 'POST', url: `/api/users/${id}/reinvite`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as InviteEmailResponse;
    expect(body.emailed).toBe(false);
    expect(body.emailError).toBe('550 mailbox unavailable');

    await app.close();
  });

  it('records a user.reinvite audit row with meta.emailed', async () => {
    const { app, cookie } = await buildOwnerApp();
    await configureSmtpMail(app, cookie);
    sendMailMock.mockResolvedValue({ messageId: 'abc' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/users/invite',
      headers: { cookie },
      payload: { email: 'reinvite-audit-emailed@example.com', role: 'member' },
    });
    const id = (created.json() as InviteEmailResponse).id;

    await app.inject({ method: 'POST', url: `/api/users/${id}/reinvite`, headers: { cookie } });

    const rows = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'user.reinvite')).all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.meta!)).toEqual({ role: 'member', emailed: true });

    await app.close();
  });
});
