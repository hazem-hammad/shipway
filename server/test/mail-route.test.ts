/**
 * Task 3's instance-mail routes: `GET`/`PUT /api/settings/mail` (config with password masking,
 * `GET` member-readable / `PUT` admin+) and `POST /api/settings/mail/test` (admin+, a real send
 * through the saved config). See `server/src/routes/mail.ts` and `server/src/services/mailer.ts`.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents } from '../src/db/schema.js';
import { getMailConfig } from '../src/services/mailer.js';
import { buildOwnerApp, createAdmin, createMember } from './helpers.js';

const FORBIDDEN_ADMIN = { error: 'requires admin' };

interface MailConfigResponse {
  driver: 'none' | 'mailpit' | 'smtp';
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password: string | null;
  fromAddress: string;
  fromName: string | null;
  configured: boolean;
}

describe('GET /api/settings/mail', () => {
  it('is member-readable and defaults to an unconfigured driver: none', async () => {
    const { app, cookie: ownerCookie } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);

    const res = await app.inject({ method: 'GET', url: '/api/settings/mail', headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      driver: 'none',
      host: '',
      port: 587,
      secure: false,
      username: null,
      password: null,
      fromAddress: '',
      fromName: null,
      configured: false,
    });

    void ownerCookie;
    await app.close();
  });

  it('requires authentication', async () => {
    const { app } = await buildOwnerApp();
    const res = await app.inject({ method: 'GET', url: '/api/settings/mail' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('PUT /api/settings/mail', () => {
  it('rejects a plain member with 403 and does not change the stored config', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/mail',
      headers: { cookie: memberCookie },
      payload: { driver: 'smtp', host: 'smtp.example.com', port: 587, fromAddress: 'a@b.com' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN_ADMIN);
    expect(getMailConfig(app.db, app.secretBox).driver).toBe('none');

    await app.close();
  });

  it('saves driver: none with no further validation', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({ method: 'PUT', url: '/api/settings/mail', headers: { cookie }, payload: { driver: 'none' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as MailConfigResponse).driver).toBe('none');
    expect((res.json() as MailConfigResponse).configured).toBe(false);

    await app.close();
  });

  it('saves driver: mailpit with no further validation, defaulting host/port/fromAddress', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({ method: 'PUT', url: '/api/settings/mail', headers: { cookie }, payload: { driver: 'mailpit' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MailConfigResponse;
    expect(body.driver).toBe('mailpit');
    expect(body.host).toBe('127.0.0.1');
    expect(body.port).toBe(1025);
    expect(body.secure).toBe(false);
    expect(body.fromAddress).toBe('shipway@localhost');
    expect(body.configured).toBe(true);

    await app.close();
  });

  describe('driver validation matrix', () => {
    it('rejects smtp with no host/port/fromAddress at all', async () => {
      const { app, cookie } = await buildOwnerApp();
      const res = await app.inject({ method: 'PUT', url: '/api/settings/mail', headers: { cookie }, payload: { driver: 'smtp' } });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string };
      expect(body.error).toContain('host');
      expect(body.error).toContain('port');
      expect(body.error).toContain('fromAddress');
      await app.close();
    });

    it('rejects smtp missing only fromAddress', async () => {
      const { app, cookie } = await buildOwnerApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/mail',
        headers: { cookie },
        payload: { driver: 'smtp', host: 'smtp.example.com', port: 587 },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string };
      expect(body.error).toContain('fromAddress');
      expect(body.error).not.toContain('host,');
      await app.close();
    });

    it('rejects smtp with a blank (whitespace-only) host', async () => {
      const { app, cookie } = await buildOwnerApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/mail',
        headers: { cookie },
        payload: { driver: 'smtp', host: '   ', port: 587, fromAddress: 'a@b.com' },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('accepts smtp with host/port/fromAddress present', async () => {
      const { app, cookie } = await buildOwnerApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/mail',
        headers: { cookie },
        payload: { driver: 'smtp', host: 'smtp.example.com', port: 587, fromAddress: 'noreply@example.com' },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('rejects an unknown driver value', async () => {
      const { app, cookie } = await buildOwnerApp();
      const res = await app.inject({ method: 'PUT', url: '/api/settings/mail', headers: { cookie }, payload: { driver: 'sendgrid' } });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  it('masks the password in the PUT and subsequent GET response ("•••" + last 4 chars)', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/mail',
      headers: { cookie },
      payload: { driver: 'smtp', host: 'smtp.example.com', port: 587, fromAddress: 'a@b.com', password: 'hunter2-secret' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MailConfigResponse;
    expect(body.password).toBe('•••cret');
    expect(body.password).not.toContain('hunter2');

    const getRes = await app.inject({ method: 'GET', url: '/api/settings/mail', headers: { cookie } });
    expect((getRes.json() as MailConfigResponse).password).toBe('•••cret');

    // The real secret is still recoverable server-side (encrypted at rest, never exposed over the API).
    expect(getMailConfig(app.db, app.secretBox).password).toBe('hunter2-secret');

    await app.close();
  });

  it('a masked password echo on PUT keeps the existing stored secret unchanged', async () => {
    const { app, cookie } = await buildOwnerApp();

    await app.inject({
      method: 'PUT',
      url: '/api/settings/mail',
      headers: { cookie },
      payload: { driver: 'smtp', host: 'smtp.example.com', port: 587, fromAddress: 'a@b.com', password: 'original-secret' },
    });
    const maskedGet = (await app.inject({ method: 'GET', url: '/api/settings/mail', headers: { cookie } })).json() as MailConfigResponse;
    expect(maskedGet.password).not.toBeNull();

    // Editing an unrelated field (host) and echoing back the masked password unchanged.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/mail',
      headers: { cookie },
      payload: { driver: 'smtp', host: 'smtp2.example.com', port: 2525, fromAddress: 'a@b.com', password: maskedGet.password },
    });
    expect(res.statusCode).toBe(200);
    expect(getMailConfig(app.db, app.secretBox).password).toBe('original-secret');
    expect(getMailConfig(app.db, app.secretBox).host).toBe('smtp2.example.com');

    await app.close();
  });

  it('omitting the password field entirely on a later update keeps the existing stored secret', async () => {
    const { app, cookie } = await buildOwnerApp();
    await app.inject({
      method: 'PUT',
      url: '/api/settings/mail',
      headers: { cookie },
      payload: { driver: 'smtp', host: 'smtp.example.com', port: 587, fromAddress: 'a@b.com', password: 'never-touched-again' },
    });

    // Edits an unrelated field without sending `password` at all — the frontend never included the
    // key because the user never touched that input.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/mail',
      headers: { cookie },
      payload: { driver: 'smtp', host: 'smtp3.example.com', port: 2525, fromAddress: 'a@b.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(getMailConfig(app.db, app.secretBox).password).toBe('never-touched-again');
    expect(getMailConfig(app.db, app.secretBox).host).toBe('smtp3.example.com');

    await app.close();
  });

  it('an explicit empty-string password clears the stored secret', async () => {
    const { app, cookie } = await buildOwnerApp();
    await app.inject({
      method: 'PUT',
      url: '/api/settings/mail',
      headers: { cookie },
      payload: { driver: 'smtp', host: 'h', port: 25, fromAddress: 'a@b.com', password: 'to-be-cleared' },
    });

    await app.inject({
      method: 'PUT',
      url: '/api/settings/mail',
      headers: { cookie },
      payload: { driver: 'smtp', host: 'h', port: 25, fromAddress: 'a@b.com', password: '' },
    });

    expect(getMailConfig(app.db, app.secretBox).password).toBeUndefined();
    await app.close();
  });

  it('records a mail.configure audit row with driver + changed keys, never the password value', async () => {
    const { app, cookie, userId } = await buildOwnerApp();

    await app.inject({
      method: 'PUT',
      url: '/api/settings/mail',
      headers: { cookie },
      payload: { driver: 'smtp', host: 'smtp.example.com', port: 587, fromAddress: 'a@b.com', password: 'super-secret-value' },
    });

    const rows = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'mail.configure')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(userId);
    const meta = JSON.parse(rows[0]!.meta ?? '{}') as { driver: string; keys: string[] };
    expect(meta.driver).toBe('smtp');
    expect(meta.keys).toEqual(expect.arrayContaining(['driver', 'host', 'port', 'fromAddress', 'password']));
    expect(rows[0]!.meta).not.toContain('super-secret-value');

    await app.close();
  });
});

describe('POST /api/settings/mail/test', () => {
  it('rejects a plain member with 403', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: memberCookie } = await createMember(app);

    const res = await app.inject({ method: 'POST', url: '/api/settings/mail/test', headers: { cookie: memberCookie }, payload: { to: 'a@b.com' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN_ADMIN);

    await app.close();
  });

  it('allows an admin (not just the owner)', async () => {
    const { app } = await buildOwnerApp();
    const { cookie: adminCookie } = await createAdmin(app);

    const res = await app.inject({ method: 'POST', url: '/api/settings/mail/test', headers: { cookie: adminCookie }, payload: { to: 'a@b.com' } });
    // Unconfigured (driver: none) — expect a calm {ok:false}, never a 403/500.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: 'instance mail is not configured' });

    await app.close();
  });

  it('rejects a missing/invalid "to" address with 400', async () => {
    const { app, cookie } = await buildOwnerApp();

    const missing = await app.inject({ method: 'POST', url: '/api/settings/mail/test', headers: { cookie }, payload: {} });
    expect(missing.statusCode).toBe(400);

    const invalid = await app.inject({ method: 'POST', url: '/api/settings/mail/test', headers: { cookie }, payload: { to: 'not-an-email' } });
    expect(invalid.statusCode).toBe(400);

    await app.close();
  });

  it('returns {ok: false, error} without a 500 when the config is unconfigured (driver: none)', async () => {
    const { app, cookie } = await buildOwnerApp();
    const res = await app.inject({ method: 'POST', url: '/api/settings/mail/test', headers: { cookie }, payload: { to: 'dest@example.com' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: 'instance mail is not configured' });
    await app.close();
  });

  it('returns {ok: false, error} without throwing when the saved smtp config points at an unreachable host', async () => {
    const { app, cookie } = await buildOwnerApp();
    await app.inject({
      method: 'PUT',
      url: '/api/settings/mail',
      headers: { cookie },
      // Port 1 is reserved (TCPMUX) and never has an SMTP listener — connection is refused fast.
      payload: { driver: 'smtp', host: '127.0.0.1', port: 1, fromAddress: 'a@b.com' },
    });

    const res = await app.inject({ method: 'POST', url: '/api/settings/mail/test', headers: { cookie }, payload: { to: 'dest@example.com' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');

    await app.close();
  }, 10_000);

  it('records a mail.test audit row with only the destination address, never credentials', async () => {
    const { app, cookie, userId } = await buildOwnerApp();

    await app.inject({ method: 'POST', url: '/api/settings/mail/test', headers: { cookie }, payload: { to: 'dest@example.com' } });

    const rows = app.db.select().from(auditEvents).where(eq(auditEvents.action, 'mail.test')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(userId);
    expect(JSON.parse(rows[0]!.meta ?? '{}')).toEqual({ to: 'dest@example.com' });

    await app.close();
  });

  it('requires authentication', async () => {
    const { app } = await buildOwnerApp();
    const res = await app.inject({ method: 'POST', url: '/api/settings/mail/test', payload: { to: 'a@b.com' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
