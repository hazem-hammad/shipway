/**
 * Instance mail settings: `GET`/`PUT /api/settings/mail` (the config Shipway itself uses for
 * invites/notifications) plus `POST /api/settings/mail/test` (a real send through the saved
 * config). Mirrors `routes/settings.ts`'s masking convention for `cloudflare_token` — the password
 * is never returned in full, and a masked echo on `PUT` means "keep the current password" rather
 * than "set the password to this literal masked string".
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../lib/authz.js';
import { getActor, recordAudit } from '../services/audit.js';
import { getMailConfig, isMailConfigured, saveMailConfig, sendMail, type InstanceMailConfig, type MailDriver } from '../services/mailer.js';

/** Prefix used to mask the stored password in `GET`/`PUT` responses — same convention as
 * `routes/settings.ts`'s `cloudflare_token` masking. */
const MASK_PREFIX = '•••';

function maskPassword(password: string): string {
  return `${MASK_PREFIX}${password.slice(-4)}`;
}

const mailUpdateSchema = z.object({
  driver: z.enum(['none', 'mailpit', 'smtp']),
  host: z.string().optional(),
  port: z.coerce.number().int().positive().optional(),
  secure: z.boolean().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  fromAddress: z.string().optional(),
  fromName: z.string().optional(),
});

const testSchema = z.object({ to: z.string().email() });

interface MailConfigResponse {
  driver: MailDriver;
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password: string | null;
  fromAddress: string;
  fromName: string | null;
  configured: boolean;
}

function toPublicMailConfig(cfg: InstanceMailConfig): MailConfigResponse {
  return {
    driver: cfg.driver,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    username: cfg.username ?? null,
    password: cfg.password ? maskPassword(cfg.password) : null,
    fromAddress: cfg.fromAddress,
    fromName: cfg.fromName ?? null,
    configured: isMailConfigured(cfg),
  };
}

/** Registers the instance-mail routes under the global session guard in `buildApp`. `GET` is
 * member-readable (matches `GET /api/settings`); `PUT` and the test-send are admin+. */
export async function mailRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings/mail', async () => {
    return toPublicMailConfig(getMailConfig(app.db, app.secretBox));
  });

  app.put('/api/settings/mail', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsed = mailUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid mail config' });
    }
    const body = parsed.data;

    if (body.driver === 'smtp') {
      const missing: string[] = [];
      if (!body.host || body.host.trim() === '') missing.push('host');
      if (body.port === undefined) missing.push('port');
      if (!body.fromAddress || body.fromAddress.trim() === '') missing.push('fromAddress');
      if (missing.length > 0) {
        return reply.code(400).send({ error: `smtp driver requires: ${missing.join(', ')}` });
      }
    }

    // Password semantics: an OMITTED field (the frontend never touched it) or a masked echo (the
    // "•••1234" it got from GET, sent back unchanged) both mean "leave the stored password alone".
    // An explicit empty string is the one way to clear it.
    const current = getMailConfig(app.db, app.secretBox);
    let password: string | undefined;
    if (body.password === undefined || body.password.startsWith(MASK_PREFIX)) {
      password = current.password;
    } else if (body.password === '') {
      password = undefined;
    } else {
      password = body.password;
    }

    const next: InstanceMailConfig = {
      driver: body.driver,
      host: body.host ?? '',
      port: body.port ?? 587,
      secure: body.secure ?? false,
      username: body.username,
      password,
      fromAddress: body.fromAddress ?? '',
      fromName: body.fromName,
    };

    saveMailConfig(app.db, app.secretBox, next);

    // meta carries the driver plus the submitted field NAMES only — never values, since one of them
    // is the password.
    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'mail.configure',
      targetType: 'settings',
      targetName: 'instance_mail',
      meta: { driver: next.driver, keys: Object.keys(body) },
    });

    return toPublicMailConfig(getMailConfig(app.db, app.secretBox));
  });

  app.post('/api/settings/mail/test', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsed = testSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'a valid "to" address is required' });
    }
    const { to } = parsed.data;

    const cfg = getMailConfig(app.db, app.secretBox);
    const result = await sendMail(
      cfg,
      {
        to,
        subject: 'Shipway test email',
        text: 'This is a test email from Shipway. If you received this, your instance mail configuration is working.',
      },
      undefined,
      app.mailSendTimeoutMs,
    );

    // meta carries the destination address only (the admin's own test target) — never credentials.
    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'mail.test', targetType: 'settings', targetName: 'instance_mail', meta: { to } });

    return result;
  });
}
