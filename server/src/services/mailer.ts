/**
 * Instance mail: the SMTP settings Shipway itself uses to send mail (member invites, deploy
 * notifications via the `email` delivery-channel type) — entirely separate from a project's own
 * SMTP config (`deploy/envfile.ts`'s `SmtpConfig`, which only ever writes `MAIL_*`/`SMTP_*` into a
 * project's `.env`). Stored under settings key `instance_mail` (see `db/settings.ts`), with the
 * password encrypted at rest via `SecretBox` (never stored, logged, or audited in plaintext).
 */
import nodemailer from 'nodemailer';
import { getSetting, setSetting } from '../db/settings.js';
import type { ShipwayDb } from '../db/index.js';
import type { SecretBox } from '../lib/secretbox.js';

export type MailDriver = 'none' | 'mailpit' | 'smtp';

/** Resolved instance mail config — always fully populated (never partial), so callers never have to
 * juggle "which fields matter for this driver" themselves. */
export interface InstanceMailConfig {
  driver: MailDriver;
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  fromAddress: string;
  fromName?: string;
}

const SETTINGS_KEY = 'instance_mail';
const MAILPIT_INFO_KEY = 'mailpit_info';

/** Local mailpit's fixed default — matches `deploy/envfile.ts`'s `buildManagedVars` mailpit branch. */
const MAILPIT_DEFAULT_HOST = '127.0.0.1';
const MAILPIT_DEFAULT_PORT = 1025;
const MAILPIT_DEFAULT_FROM = 'shipway@localhost';

/** Shape actually persisted under `instance_mail`: `password` is replaced with a base64-encoded
 * SecretBox ciphertext (never plaintext) so a raw dump of the settings table never leaks it. */
interface StoredMailConfig {
  driver: MailDriver;
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  passwordEncrypted?: string;
  fromAddress?: string;
  fromName?: string;
}

/** Subset of `bootstrap.json`'s `mailpit_info` (`lib/bootstrap.ts`) this module cares about —
 * `install.sh`'s provisioned mailpit connection, when it differs from the plain local default. */
interface MailpitInfo {
  smtpHost?: string;
  smtpPort?: number;
}

/** Reads and decrypts the instance mail config. Unset → an inert `driver: 'none'` config. For
 * `driver: 'mailpit'`, `host`/`port` are always the local mailpit endpoint (overridden by the
 * `mailpit_info` bootstrap setting when present) rather than whatever was last stored — mailpit
 * never takes user-supplied connection details. */
export function getMailConfig(db: ShipwayDb, secretBox: SecretBox): InstanceMailConfig {
  const stored = getSetting<StoredMailConfig>(db, SETTINGS_KEY);
  if (!stored) {
    return { driver: 'none', host: '', port: 587, secure: false, fromAddress: '' };
  }

  const password = stored.passwordEncrypted ? secretBox.decrypt(Buffer.from(stored.passwordEncrypted, 'base64')) : undefined;

  if (stored.driver === 'mailpit') {
    const mailpitInfo = getSetting<MailpitInfo>(db, MAILPIT_INFO_KEY);
    return {
      driver: 'mailpit',
      host: mailpitInfo?.smtpHost ?? MAILPIT_DEFAULT_HOST,
      port: mailpitInfo?.smtpPort ?? MAILPIT_DEFAULT_PORT,
      secure: false,
      fromAddress: stored.fromAddress && stored.fromAddress.trim() !== '' ? stored.fromAddress : MAILPIT_DEFAULT_FROM,
      fromName: stored.fromName,
    };
  }

  return {
    driver: stored.driver,
    host: stored.host ?? '',
    port: stored.port ?? 587,
    secure: stored.secure ?? false,
    username: stored.username,
    password,
    fromAddress: stored.fromAddress ?? '',
    fromName: stored.fromName,
  };
}

/** Encrypts `cfg.password` (when present) and upserts the whole config under `instance_mail`. */
export function saveMailConfig(db: ShipwayDb, secretBox: SecretBox, cfg: InstanceMailConfig): void {
  const stored: StoredMailConfig = {
    driver: cfg.driver,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    username: cfg.username,
    passwordEncrypted: cfg.password ? secretBox.encrypt(cfg.password).toString('base64') : undefined,
    fromAddress: cfg.fromAddress,
    fromName: cfg.fromName,
  };
  setSetting(db, SETTINGS_KEY, stored);
}

/** `false` only for `driver: 'none'` — a `mailpit`/`smtp` config counts as configured even before a
 * successful test send (mailpit needs no credentials at all; smtp is validated at save time). */
export function isMailConfigured(cfg: InstanceMailConfig): boolean {
  return cfg.driver !== 'none';
}

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type SendMailResult = { ok: true } | { ok: false; error: string };

/** The minimal shape `sendMail` needs from a transport — matches nodemailer's `Transporter`
 * structurally (so a real `nodemailer.createTransport(...)` satisfies it with no cast) while staying
 * easy to fake in tests. */
export interface MailTransport {
  sendMail(options: { from: string; to: string; subject: string; text: string; html?: string }): Promise<unknown>;
}

export type TransportFactory = (cfg: InstanceMailConfig) => MailTransport;

const defaultTransportFactory: TransportFactory = (cfg) =>
  nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
  });

function formatFrom(cfg: InstanceMailConfig): string {
  return cfg.fromName ? `"${cfg.fromName}" <${cfg.fromAddress}>` : cfg.fromAddress;
}

/** Defensively removes the configured SMTP username from an error message before it's returned to
 * a caller (`emailError` on the invite response, `POST /api/settings/mail/test`'s result, a
 * channel's test-send result) — a remote SMTP server can echo the login back in its rejection text
 * (e.g. `535 authentication failed for user 'shipway@example.com'`), and that value can itself be
 * worth keeping out of a response even though it isn't a secret in the same class as the password.
 * Only strips an exact, case-sensitive match of a non-empty, non-whitespace username; anything else
 * in the message is left alone. */
function redactUsername(message: string, username: string | undefined): string {
  if (!username || username.trim() === '') return message;
  return message.split(username).join('[username]');
}

/**
 * Sends one email through `cfg`. NEVER throws — a `driver: 'none'` config or any transport/network
 * failure resolves `{ok: false, error}` instead, since a failed test-send or a failed best-effort
 * notification must never turn into an unhandled rejection or a 500. Never logs `cfg.password` or
 * any other credential; the returned error message also never contains `cfg.username` (see
 * `redactUsername`). `transportFactory` defaults to a real nodemailer SMTP transport; tests inject
 * a fake one.
 */
export async function sendMail(
  cfg: InstanceMailConfig,
  input: SendMailInput,
  transportFactory: TransportFactory = defaultTransportFactory,
): Promise<SendMailResult> {
  if (!isMailConfigured(cfg)) {
    return { ok: false, error: 'instance mail is not configured' };
  }

  try {
    const transport = transportFactory(cfg);
    await transport.sendMail({ from: formatFrom(cfg), to: input.to, subject: input.subject, text: input.text, html: input.html });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to send mail';
    return { ok: false, error: redactUsername(message, cfg.username) };
  }
}

/**
 * Team invites (spec §3 "What uses instance mail" (a)): the subject/text/html sent alongside
 * `POST /api/users/invite` and `POST /api/users/:id/reinvite` in `routes/users.ts`, whenever
 * instance mail is configured. `Content-Security`-minded on purpose — no images, no external CSS,
 * only inline styles on the HTML body — since this renders in whatever the invitee's mail client
 * allows.
 */
export interface InviteEmailInput {
  /** The invite's one-time token (`routes/users.ts`'s `generateInviteToken`). */
  token: string;
  /** The `base_domain` setting, or `null`/unset when the instance hasn't configured one yet. */
  baseDomain: string | null;
}

export interface InviteEmailContent {
  subject: string;
  text: string;
  html: string;
}

const INVITE_EMAIL_SUBJECT = "You're invited to Shipway";

/**
 * Builds the invite email. The link is absolute (`https://deploy.<baseDomain>/invite/<token>`)
 * when `base_domain` is configured; when it isn't, this never fabricates a host to fill the gap —
 * it falls back to the bare `/invite/<token>` path plus a note that the reader needs to open it on
 * their Shipway instance directly. Pure and synchronous: building the email content never touches
 * the network, so any failure downstream in `routes/users.ts` can only come from the actual send.
 */
export function buildInviteEmail({ token, baseDomain }: InviteEmailInput): InviteEmailContent {
  const invitePath = `/invite/${token}`;
  const domain = baseDomain && baseDomain.trim() !== '' ? baseDomain.trim() : null;
  const url = domain ? `https://deploy.${domain}${invitePath}` : null;

  const linkLine = url
    ? url
    : `${invitePath} (no base domain is configured yet, so this can't be a full link; open this path on your Shipway instance)`;

  const text = ["You've been invited to join Shipway.", '', `Accept your invite: ${linkLine}`, '', 'This link expires in 7 days.'].join('\n');

  const linkHtml = url
    ? `<a href="${url}" style="color: #141416; font-weight: 600;">Accept your invite</a>`
    : `Accept your invite at <code>${invitePath}</code> on your Shipway instance (no base domain is configured yet, so this link can't be made absolute).`;

  const html = [
    '<div style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #18181B;">',
    "  <p>You've been invited to join Shipway.</p>",
    `  <p>${linkHtml}</p>`,
    '  <p style="color: #8E8E93; font-size: 13px;">This link expires in 7 days.</p>',
    '</div>',
  ].join('\n');

  return { subject: INVITE_EMAIL_SUBJECT, text, html };
}
