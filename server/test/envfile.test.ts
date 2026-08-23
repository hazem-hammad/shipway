import { describe, expect, it } from 'vitest';
import { buildManagedVars, buildEnvFile } from '../src/deploy/envfile.js';

const MARKER_START = '# >>> shipway managed — do not edit below >>>';
const MARKER_END = '# <<< shipway managed <<<';

describe('buildManagedVars', () => {
  it('mailpit mode returns the mailpit smtp defaults with SMTP_ aliases', () => {
    expect(buildManagedVars({ smtpMode: 'mailpit' })).toEqual({
      MAIL_MAILER: 'smtp',
      MAIL_HOST: '127.0.0.1',
      MAIL_PORT: '1025',
      MAIL_ENCRYPTION: 'null',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
    });
  });

  it('mailpit mode ignores any smtpConfig passed alongside it', () => {
    expect(
      buildManagedVars({
        smtpMode: 'mailpit',
        smtpConfig: { host: 'smtp.example.com', port: 587 },
      }),
    ).toEqual({
      MAIL_MAILER: 'smtp',
      MAIL_HOST: '127.0.0.1',
      MAIL_PORT: '1025',
      MAIL_ENCRYPTION: 'null',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
    });
  });

  it('custom mode maps every smtpConfig field, stringifies port, and adds SMTP_ aliases', () => {
    const out = buildManagedVars({
      smtpMode: 'custom',
      smtpConfig: {
        host: 'smtp.example.com',
        port: 587,
        username: 'user@example.com',
        password: 's3cret',
        fromAddress: 'noreply@example.com',
        encryption: 'tls',
      },
    });
    expect(out).toEqual({
      MAIL_MAILER: 'smtp',
      MAIL_HOST: 'smtp.example.com',
      MAIL_PORT: '587',
      MAIL_USERNAME: 'user@example.com',
      MAIL_PASSWORD: 's3cret',
      MAIL_FROM_ADDRESS: 'noreply@example.com',
      MAIL_ENCRYPTION: 'tls',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
    });
  });

  it('custom mode omits keys whose source field is undefined', () => {
    const out = buildManagedVars({
      smtpMode: 'custom',
      smtpConfig: { host: 'smtp.example.com', port: 25 },
    });
    expect(out).toEqual({
      MAIL_MAILER: 'smtp',
      MAIL_HOST: 'smtp.example.com',
      MAIL_PORT: '25',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '25',
    });
    expect(out).not.toHaveProperty('MAIL_USERNAME');
    expect(out).not.toHaveProperty('MAIL_PASSWORD');
    expect(out).not.toHaveProperty('MAIL_FROM_ADDRESS');
    expect(out).not.toHaveProperty('MAIL_ENCRYPTION');
  });

  it('custom mode throws when smtpConfig is missing', () => {
    expect(() => buildManagedVars({ smtpMode: 'custom' })).toThrow();
  });

  it('none mode returns no managed vars', () => {
    expect(buildManagedVars({ smtpMode: 'none' })).toEqual({});
  });

  it('none mode ignores any smtpConfig passed alongside it', () => {
    expect(
      buildManagedVars({ smtpMode: 'none', smtpConfig: { host: 'x', port: 25 } }),
    ).toEqual({});
  });
});

describe('buildEnvFile', () => {
  it('appends the managed block using the exact delimiter lines', () => {
    const out = buildEnvFile('APP_NAME=demo\n', { MAIL_MAILER: 'smtp' });
    expect(out).toContain(MARKER_START);
    expect(out).toContain(MARKER_END);
  });

  it('appends managed vars after user content, separated by a blank line, in insertion order', () => {
    const out = buildEnvFile('APP_NAME=demo\n', {
      MAIL_MAILER: 'smtp',
      MAIL_HOST: '127.0.0.1',
    });
    expect(out).toBe(
      [
        'APP_NAME=demo',
        '',
        MARKER_START,
        'MAIL_MAILER=smtp',
        'MAIL_HOST=127.0.0.1',
        MARKER_END,
        '',
      ].join('\n'),
    );
  });

  it('appends the block with no leading blank line when userEnv is empty', () => {
    const out = buildEnvFile('', { MAIL_MAILER: 'smtp' });
    expect(out).toBe([MARKER_START, 'MAIL_MAILER=smtp', MARKER_END, ''].join('\n'));
  });

  it('quotes managed values containing spaces or #, leaves plain values raw', () => {
    const out = buildEnvFile('', {
      MAIL_FROM_ADDRESS: 'no reply',
      MAIL_ENCRYPTION: 'tls#insecure',
      MAIL_HOST: 'plain.example.com',
    });
    expect(out).toContain('MAIL_FROM_ADDRESS="no reply"');
    expect(out).toContain('MAIL_ENCRYPTION="tls#insecure"');
    expect(out).toContain('MAIL_HOST=plain.example.com');
  });

  it('does not emit a managed key already defined by the user (user wins)', () => {
    const out = buildEnvFile('MAIL_HOST=custom.example.com\n', {
      MAIL_MAILER: 'smtp',
      MAIL_HOST: '127.0.0.1',
      MAIL_PORT: '1025',
    });
    expect(out).toContain('MAIL_HOST=custom.example.com');
    expect(out).not.toContain('MAIL_HOST=127.0.0.1');
    expect(out).toContain('MAIL_MAILER=smtp');
    expect(out).toContain('MAIL_PORT=1025');
  });

  it('ignores commented-out lines when detecting user-defined keys', () => {
    const out = buildEnvFile('# MAIL_HOST=old.example.com\n', { MAIL_HOST: '127.0.0.1' });
    expect(out).toContain('MAIL_HOST=127.0.0.1');
  });

  it('treats an indented KEY=value line as user-defined', () => {
    const out = buildEnvFile('  MAIL_HOST=custom.example.com\n', { MAIL_HOST: '127.0.0.1' });
    expect(out).not.toContain('MAIL_HOST=127.0.0.1');
    expect(out).toContain('MAIL_HOST=custom.example.com');
  });

  it('emits userEnv unchanged (no empty block) when every managed key is already user-defined', () => {
    const userEnv = 'MAIL_HOST=custom.example.com\nMAIL_PORT=2525\n';
    const out = buildEnvFile(userEnv, { MAIL_HOST: '127.0.0.1', MAIL_PORT: '1025' });
    expect(out).toBe(userEnv);
    expect(out).not.toContain(MARKER_START);
    expect(out).not.toContain(MARKER_END);
  });

  it('emits userEnv unchanged (no empty block) when managed has no vars', () => {
    const userEnv = 'APP_NAME=demo\n';
    expect(buildEnvFile(userEnv, {})).toBe(userEnv);
  });

  it('ensures a trailing newline even when no block is appended', () => {
    expect(buildEnvFile('APP_NAME=demo', {})).toBe('APP_NAME=demo\n');
  });

  it('ensures a trailing newline on a fully empty file with no managed vars', () => {
    expect(buildEnvFile('', {})).toBe('');
  });

  it('strips a pre-existing managed block (old delimiters+content), keeping content before and after it', () => {
    const userEnv = [
      'APP_NAME=demo',
      '',
      MARKER_START,
      'MAIL_HOST=old.stale.example.com',
      'MAIL_PORT=999',
      MARKER_END,
      'DB_CONNECTION=sqlite',
      '',
    ].join('\n');

    const out = buildEnvFile(userEnv, { MAIL_HOST: '127.0.0.1' });

    expect(out).toContain('APP_NAME=demo');
    expect(out).toContain('DB_CONNECTION=sqlite');
    expect(out).not.toContain('old.stale.example.com');
    expect(out).not.toContain('MAIL_PORT=999');
    expect(out.match(/MAIL_HOST=127\.0\.0\.1/g)?.length).toBe(1);
    expect(out.split(MARKER_START).length - 1).toBe(1);
    expect(out.split(MARKER_END).length - 1).toBe(1);
  });

  it('strips the one optional blank line preceding an old managed block, leaving no stray blank line', () => {
    const userEnv = ['APP_NAME=demo', '', MARKER_START, 'MAIL_HOST=old', MARKER_END, ''].join(
      '\n',
    );
    const out = buildEnvFile(userEnv, {});
    expect(out).toBe('APP_NAME=demo\n');
  });

  it('is idempotent: re-running with different managed vars replaces the block rather than duplicating it', () => {
    const userEnv = 'APP_NAME=demo\n';
    const first = buildEnvFile(userEnv, { MAIL_MAILER: 'smtp', MAIL_HOST: '127.0.0.1' });
    const second = buildEnvFile(first, {
      MAIL_MAILER: 'smtp',
      MAIL_HOST: 'smtp.example.com',
      MAIL_PORT: '587',
    });

    expect(second.split(MARKER_START).length - 1).toBe(1);
    expect(second.split(MARKER_END).length - 1).toBe(1);
    expect(second).toContain('MAIL_HOST=smtp.example.com');
    expect(second).not.toContain('MAIL_HOST=127.0.0.1');
    expect(second).toContain('APP_NAME=demo');
  });

  it('is a true fixpoint: re-running with the same managed vars produces byte-identical output', () => {
    const userEnv = 'APP_NAME=demo\n';
    const managed = { MAIL_MAILER: 'smtp', MAIL_HOST: '127.0.0.1' };
    const once = buildEnvFile(userEnv, managed);
    const twice = buildEnvFile(once, managed);
    expect(twice).toBe(once);
  });

  it('leaves userEnv without a managed block untouched aside from the appended block', () => {
    const userEnv = '# my app config\nAPP_NAME=demo\nAPP_DEBUG=true\n';
    const out = buildEnvFile(userEnv, { MAIL_MAILER: 'smtp' });
    expect(out.startsWith(userEnv.replace(/\n$/, ''))).toBe(true);
  });
});
