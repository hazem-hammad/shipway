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

/**
 * Sends one email through `cfg`. NEVER throws — a `driver: 'none'` config or any transport/network
 * failure resolves `{ok: false, error}` instead, since a failed test-send or a failed best-effort
 * notification must never turn into an unhandled rejection or a 500. Never logs `cfg.password` or
 * any other credential. `transportFactory` defaults to a real nodemailer SMTP transport; tests
 * inject a fake one.
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
    return { ok: false, error: err instanceof Error ? err.message : 'failed to send mail' };
  }
}
