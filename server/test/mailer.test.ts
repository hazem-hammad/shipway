import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/index.js';
import { settings } from '../src/db/schema.js';
import { setSetting } from '../src/db/settings.js';
import { SecretBox } from '../src/lib/secretbox.js';
import { getMailConfig, isMailConfigured, saveMailConfig, sendMail, type InstanceMailConfig, type MailTransport } from '../src/services/mailer.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-mailer-test-'));
}

function makeFixtures(): { db: ReturnType<typeof openDb>; secretBox: SecretBox } {
  const dir = tmpDir();
  const db = openDb(path.join(dir, 'shipway.db'));
  const secretBox = SecretBox.load(path.join(dir, 'secret.key'));
  return { db, secretBox };
}

describe('getMailConfig', () => {
  it('returns an inert driver: none config when instance_mail was never set', () => {
    const { db, secretBox } = makeFixtures();
    expect(getMailConfig(db, secretBox)).toEqual({ driver: 'none', host: '', port: 587, secure: false, fromAddress: '' });
  });

  it('defaults mailpit host/port to 127.0.0.1:1025 with no auth when mailpit_info is unset', () => {
    const { db, secretBox } = makeFixtures();
    saveMailConfig(db, secretBox, { driver: 'mailpit', host: 'ignored', port: 1, secure: true, fromAddress: '', username: 'ignored' });

    const cfg = getMailConfig(db, secretBox);
    expect(cfg).toEqual({ driver: 'mailpit', host: '127.0.0.1', port: 1025, secure: false, fromAddress: 'shipway@localhost', fromName: undefined });
  });

  it('overrides mailpit host/port from the mailpit_info bootstrap setting when present', () => {
    const { db, secretBox } = makeFixtures();
    setSetting(db, 'mailpit_info', { smtpHost: '10.0.0.5', smtpPort: 2025 });
    saveMailConfig(db, secretBox, { driver: 'mailpit', host: '', port: 0, secure: false, fromAddress: '' });

    const cfg = getMailConfig(db, secretBox);
    expect(cfg.host).toBe('10.0.0.5');
    expect(cfg.port).toBe(2025);
    expect(cfg.secure).toBe(false);
    expect(cfg.username).toBeUndefined();
  });
});

describe('config round-trip', () => {
  it('round-trips an smtp config, decrypting the password back to plaintext', () => {
    const { db, secretBox } = makeFixtures();
    const cfg: InstanceMailConfig = {
      driver: 'smtp',
      host: 'smtp.example.com',
      port: 587,
      secure: true,
      username: 'shipway',
      password: 'hunter2-super-secret',
      fromAddress: 'noreply@example.com',
      fromName: 'Shipway',
    };

    saveMailConfig(db, secretBox, cfg);
    expect(getMailConfig(db, secretBox)).toEqual(cfg);
  });

  it('encrypts the password at rest — the raw settings row never contains the plaintext', () => {
    const { db, secretBox } = makeFixtures();
    const plaintext = 'do-not-leak-this-password';

    saveMailConfig(db, secretBox, {
      driver: 'smtp',
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      username: 'user',
      password: plaintext,
      fromAddress: 'noreply@example.com',
    });

    const row = db.select().from(settings).where(eq(settings.key, 'instance_mail')).get();
    expect(row).toBeDefined();
    expect(row!.value).not.toContain(plaintext);
    // Round-tripping through JSON.parse must still decrypt back to the original plaintext.
    const stored = JSON.parse(row!.value) as { passwordEncrypted?: string };
    expect(stored.passwordEncrypted).toBeDefined();
    expect(secretBox.decrypt(Buffer.from(stored.passwordEncrypted!, 'base64'))).toBe(plaintext);
  });

  it('omits passwordEncrypted entirely when no password is set', () => {
    const { db, secretBox } = makeFixtures();
    saveMailConfig(db, secretBox, { driver: 'smtp', host: 'h', port: 25, secure: false, fromAddress: 'a@b.com' });

    const row = db.select().from(settings).where(eq(settings.key, 'instance_mail')).get();
    const stored = JSON.parse(row!.value) as { passwordEncrypted?: string };
    expect(stored.passwordEncrypted).toBeUndefined();
    expect(getMailConfig(db, secretBox).password).toBeUndefined();
  });
});

describe('isMailConfigured', () => {
  it('is false for driver: none', () => {
    expect(isMailConfigured({ driver: 'none', host: '', port: 0, secure: false, fromAddress: '' })).toBe(false);
  });

  it('is true for driver: mailpit', () => {
    expect(isMailConfigured({ driver: 'mailpit', host: '127.0.0.1', port: 1025, secure: false, fromAddress: 'a@b.com' })).toBe(true);
  });

  it('is true for driver: smtp', () => {
    expect(isMailConfigured({ driver: 'smtp', host: 'h', port: 25, secure: false, fromAddress: 'a@b.com' })).toBe(true);
  });
});

describe('sendMail', () => {
  const SMTP_CFG: InstanceMailConfig = {
    driver: 'smtp',
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    username: 'user',
    password: 'pass',
    fromAddress: 'noreply@example.com',
    fromName: 'Shipway',
  };

  it('resolves {ok: false, error} for driver: none without ever building a transport', async () => {
    const transportFactory = vi.fn();
    const result = await sendMail({ driver: 'none', host: '', port: 0, secure: false, fromAddress: '' }, { to: 'a@b.com', subject: 's', text: 't' }, transportFactory);

    expect(result).toEqual({ ok: false, error: 'instance mail is not configured' });
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('resolves {ok: true} via an injected fake transport, formatting from with fromName', async () => {
    const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'abc' });
    const fakeTransport: MailTransport = { sendMail: sendMailMock };

    const result = await sendMail(SMTP_CFG, { to: 'dest@example.com', subject: 'Hello', text: 'Body text' }, () => fakeTransport);

    expect(result).toEqual({ ok: true });
    expect(sendMailMock).toHaveBeenCalledWith({
      from: '"Shipway" <noreply@example.com>',
      to: 'dest@example.com',
      subject: 'Hello',
      text: 'Body text',
      html: undefined,
    });
  });

  it('never throws — a rejecting transport resolves {ok: false, error}', async () => {
    const fakeTransport: MailTransport = { sendMail: vi.fn().mockRejectedValue(new Error('connection refused')) };

    await expect(sendMail(SMTP_CFG, { to: 'dest@example.com', subject: 's', text: 't' }, () => fakeTransport)).resolves.toEqual({
      ok: false,
      error: 'connection refused',
    });
  });

  it('never throws even when transportFactory itself throws synchronously', async () => {
    const transportFactory = (): MailTransport => {
      throw new Error('boom');
    };

    await expect(sendMail(SMTP_CFG, { to: 'dest@example.com', subject: 's', text: 't' }, transportFactory)).resolves.toEqual({
      ok: false,
      error: 'boom',
    });
  });
});
