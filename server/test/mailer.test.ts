import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/index.js';
import { settings } from '../src/db/schema.js';
import { setSetting } from '../src/db/settings.js';
import { SecretBox } from '../src/lib/secretbox.js';
import {
  buildInviteEmail,
  getMailConfig,
  isMailConfigured,
  isValidSesRegion,
  saveMailConfig,
  sendMail,
  sesSmtpHost,
  type InstanceMailConfig,
  type MailTransport,
} from '../src/services/mailer.js';

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

  it('derives the ses host/port/TLS from the stored region, ignoring any stored host/port', () => {
    const { db, secretBox } = makeFixtures();
    saveMailConfig(db, secretBox, {
      driver: 'ses',
      host: 'attacker.example.com',
      port: 2525,
      secure: true,
      region: 'eu-west-2',
      username: 'AKIAIOSFODNN7EXAMPLE',
      password: 'ses-smtp-password',
      fromAddress: 'noreply@example.com',
    });

    const cfg = getMailConfig(db, secretBox);
    expect(cfg.host).toBe('email-smtp.eu-west-2.amazonaws.com');
    expect(cfg.port).toBe(587);
    expect(cfg.secure).toBe(false);
    expect(cfg.region).toBe('eu-west-2');
    expect(cfg.username).toBe('AKIAIOSFODNN7EXAMPLE');
    expect(cfg.password).toBe('ses-smtp-password');
  });

  it('yields an empty ses host rather than a fabricated one when the stored region is malformed', () => {
    const { db, secretBox } = makeFixtures();
    // Written straight into settings, bypassing the route's validation — e.g. a hand-edited row.
    setSetting(db, 'instance_mail', { driver: 'ses', region: 'evil.example.com/', fromAddress: 'a@b.com' });

    const cfg = getMailConfig(db, secretBox);
    expect(cfg.host).toBe('');
    expect(cfg.port).toBe(587);
  });
});

describe('isValidSesRegion', () => {
  it('accepts well-formed AWS region codes', () => {
    for (const region of ['us-east-1', 'ap-southeast-2', 'eu-central-2', 'me-central-1', 'il-central-1', 'us-gov-west-1']) {
      expect(isValidSesRegion(region)).toBe(true);
    }
  });

  it('rejects anything that could smuggle a different host into the SES endpoint', () => {
    for (const region of [undefined, '', '   ', 'us-east-1.evil.com', 'evil.com', 'us-east-1/', 'US-EAST-1', 'us_east_1', 'us-east']) {
      expect(isValidSesRegion(region)).toBe(false);
    }
  });

  it('builds the regional SES SMTP hostname', () => {
    expect(sesSmtpHost('us-west-2')).toBe('email-smtp.us-west-2.amazonaws.com');
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

  it('is true for driver: ses', () => {
    expect(
      isMailConfigured({ driver: 'ses', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false, region: 'us-east-1', fromAddress: 'a@b.com' }),
    ).toBe(true);
  });

  it('is true for driver: smtp', () => {
    expect(isMailConfigured({ driver: 'smtp', host: 'h', port: 25, secure: false, fromAddress: 'a@b.com' })).toBe(true);
  });
});

describe('sendMail — provider message id', () => {
  const cfg: InstanceMailConfig = { driver: 'smtp', host: 'smtp.example.com', port: 587, secure: false, fromAddress: 'a@b.com' };

  it("extracts SES's `250 Ok <id>` response id, which is what the provider dashboard indexes", async () => {
    const transport: MailTransport = { sendMail: () => Promise.resolve({ response: '250 Ok 010701a04a9459d1-abc-000000', messageId: '<local@host>' }) };
    const result = await sendMail(cfg, { to: 'a@b.com', subject: 's', text: 't' }, () => transport);
    expect(result).toEqual({ ok: true, messageId: '010701a04a9459d1-abc-000000' });
  });

  it("falls back to the transport's own messageId when the response carries no id", async () => {
    const transport: MailTransport = { sendMail: () => Promise.resolve({ response: '250 Message accepted', messageId: '<local@host>' }) };
    const result = await sendMail(cfg, { to: 'a@b.com', subject: 's', text: 't' }, () => transport);
    expect(result).toEqual({ ok: true, messageId: '<local@host>' });
  });

  it('reports no id rather than throwing when the transport resolves with nothing useful', async () => {
    for (const value of [undefined, null, 'a string', 42, {}]) {
      const transport: MailTransport = { sendMail: () => Promise.resolve(value) };
      const result = await sendMail(cfg, { to: 'a@b.com', subject: 's', text: 't' }, () => transport);
      expect(result).toEqual({ ok: true, messageId: undefined });
    }
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

    expect(result).toMatchObject({ ok: true });
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

  it('strips the configured username out of a rejecting transport error message', async () => {
    const fakeTransport: MailTransport = {
      sendMail: vi.fn().mockRejectedValue(new Error("535 authentication failed for 'user'")),
    };

    const result = await sendMail(SMTP_CFG, { to: 'dest@example.com', subject: 's', text: 't' }, () => fakeTransport);

    expect(result).toEqual({ ok: false, error: "535 authentication failed for '[username]'" });
  });

  it('leaves the error message untouched when no username is configured', async () => {
    const cfgNoUsername: InstanceMailConfig = { ...SMTP_CFG, username: undefined };
    const fakeTransport: MailTransport = { sendMail: vi.fn().mockRejectedValue(new Error('connection refused')) };

    await expect(sendMail(cfgNoUsername, { to: 'dest@example.com', subject: 's', text: 't' }, () => fakeTransport)).resolves.toEqual({
      ok: false,
      error: 'connection refused',
    });
  });

  describe('timeout (fix wave I2)', () => {
    it('resolves {ok: false, error} within a short injected cap when the transport never resolves', async () => {
      const fakeTransport: MailTransport = { sendMail: () => new Promise(() => {}) }; // never settles
      const start = Date.now();

      const result = await sendMail(SMTP_CFG, { to: 'dest@example.com', subject: 's', text: 't' }, () => fakeTransport, 30);

      expect(Date.now() - start).toBeLessThan(1000);
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toMatch(/timed out/);
    });

    it('a transport that resolves comfortably inside the cap still succeeds', async () => {
      const fakeTransport: MailTransport = { sendMail: vi.fn().mockResolvedValue({ messageId: 'abc' }) };

      await expect(sendMail(SMTP_CFG, { to: 'dest@example.com', subject: 's', text: 't' }, () => fakeTransport, 30)).resolves.toMatchObject({ ok: true });
    });

    it('redacts the username from a timeout error too, same as any other failure', async () => {
      const fakeTransport: MailTransport = { sendMail: () => new Promise(() => {}) };

      const result = await sendMail(SMTP_CFG, { to: 'dest@example.com', subject: 's', text: 't' }, () => fakeTransport, 20);

      expect((result as { ok: false; error: string }).error).not.toContain(SMTP_CFG.username);
    });
  });
});

describe('buildInviteEmail', () => {
  it('builds an absolute ship.<baseDomain> URL, present in both text and html, plus the fixed subject', () => {
    const content = buildInviteEmail({ token: 'abc123deadbeef', baseDomain: 'intcore.dev' });

    expect(content.subject).toBe("You're invited to Shipway");
    expect(content.text).toContain('https://ship.intcore.dev/invite/abc123deadbeef');
    expect(content.html).toContain('https://ship.intcore.dev/invite/abc123deadbeef');
    expect(content.html).toContain('href="https://ship.intcore.dev/invite/abc123deadbeef"');
  });

  it('falls back to a relative-path note instead of fabricating a host when base_domain is unset', () => {
    const content = buildInviteEmail({ token: 'abc123deadbeef', baseDomain: null });

    expect(content.text).toContain('/invite/abc123deadbeef');
    expect(content.text).not.toMatch(/https?:\/\//);
    expect(content.html).toContain('/invite/abc123deadbeef');
    expect(content.html).not.toMatch(/https?:\/\//);
  });

  it('treats a blank/whitespace-only base_domain the same as unset', () => {
    const content = buildInviteEmail({ token: 'tok', baseDomain: '   ' });

    expect(content.text).not.toMatch(/https?:\/\//);
    expect(content.html).not.toMatch(/https?:\/\//);
  });

  it('names the granted projects when the invite is scoped, and says "all projects" when it is not', () => {
    const unscoped = buildInviteEmail({ token: 'tok', baseDomain: 'intcore.dev' });
    expect(unscoped.text).toContain("You'll have access to all projects.");

    const scoped = buildInviteEmail({ token: 'tok', baseDomain: 'intcore.dev', projectNames: ['Shop', 'Blog'] });
    expect(scoped.text).toContain("You'll have access to: Shop, Blog.");
    expect(scoped.html).toContain("You'll have access to: Shop, Blog.");

    // A scoped invite with nothing granted yet says so rather than reading as "all projects".
    const empty = buildInviteEmail({ token: 'tok', baseDomain: 'intcore.dev', projectNames: [] });
    expect(empty.text).toContain("don't have access to any projects yet");
  });

  it('truncates a long project list instead of pasting every name into the email', () => {
    const names = Array.from({ length: 11 }, (_, i) => `Project ${String(i + 1)}`);
    const content = buildInviteEmail({ token: 'tok', baseDomain: 'intcore.dev', projectNames: names });

    expect(content.text).toContain('Project 8, and 3 more.');
    expect(content.text).not.toContain('Project 9');
  });

  it('escapes a project name in the HTML body, so a name can never inject markup', () => {
    const content = buildInviteEmail({ token: 'tok', baseDomain: 'intcore.dev', projectNames: ['<script>alert(1)</script>'] });

    expect(content.html).not.toContain('<script>alert(1)</script>');
    expect(content.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('the HTML body has no <img> tags and no external stylesheet/script references', () => {
    const content = buildInviteEmail({ token: 'tok', baseDomain: 'intcore.dev' });

    expect(content.html).not.toContain('<img');
    expect(content.html).not.toContain('<link');
    expect(content.html).not.toContain('<script');
  });
});
