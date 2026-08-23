import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DevSysOps } from '../src/sysops/dev.js';
import { SYSTEM_UNITS, assertSystemUnit, assertUnitName, assertUnitPattern } from '../src/sysops/types.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sysops-dev-test-'));
}

describe('assertUnitName', () => {
  it.each([
    'shipway-app-foo',
    'shipway-worker-bar',
    'shipway-app-foo@1',
    'shipway-app-foo.service',
    'shipway-x',
    'shipway-app-123',
  ])('accepts %s', (unit) => {
    expect(() => assertUnitName(unit)).not.toThrow();
  });

  it.each([
    'nginx',
    'shipway-',
    'shipway',
    'Shipway-App-Foo',
    'shipway-app foo',
    'shipway-app_foo',
    'shipway-app/../etc',
    '',
    'shipway-App',
  ])('rejects %s', (unit) => {
    expect(() => assertUnitName(unit)).toThrow();
  });
});

describe('assertUnitPattern', () => {
  it.each([
    'shipway-app-foo',
    'shipway-worker-bar-baz@1.service',
    'shipway-worker-bar-baz@*',
    'shipway-worker-bar-baz@*.service',
    'shipway-*',
  ])('accepts %s', (pattern) => {
    expect(() => assertUnitPattern(pattern)).not.toThrow();
  });

  it.each(['nginx', 'shipway-', 'shipway', 'Shipway-App-Foo', 'shipway-app foo', 'shipway-app_foo', 'shipway-app/../etc', ''])(
    'rejects %s',
    (pattern) => {
      expect(() => assertUnitPattern(pattern)).toThrow();
    },
  );
});

describe('SYSTEM_UNITS / assertSystemUnit', () => {
  it.each(SYSTEM_UNITS)('accepts %s', (unit) => {
    expect(() => assertSystemUnit(unit)).not.toThrow();
  });

  it.each(['evil-unit', 'shipway-app-foo', 'NGINX', 'nginx; rm -rf /', 'php8.5-fpm', ''])('rejects %s', (unit) => {
    expect(() => assertSystemUnit(unit)).toThrow();
  });
});

describe('DevSysOps', () => {
  it('installFile writes content under rootDir + dest, creating parent dirs', async () => {
    const root = tmpDir();
    const sysops = new DevSysOps(root);

    await sysops.installFile('/etc/nginx/sites-available/shipway-foo.conf', 'server {}\n');

    const written = fs.readFileSync(path.join(root, '/etc/nginx/sites-available/shipway-foo.conf'), 'utf8');
    expect(written).toBe('server {}\n');
  });

  it('installFile records a human-readable call with byte length', async () => {
    const root = tmpDir();
    const sysops = new DevSysOps(root);
    const content = 'server {}\n';

    await sysops.installFile('/etc/nginx/sites-available/shipway-foo.conf', content);

    expect(sysops.calls).toContain(
      `installFile /etc/nginx/sites-available/shipway-foo.conf (${Buffer.byteLength(content, 'utf8')} bytes)`,
    );
  });

  it('removeFile deletes a previously installed file', async () => {
    const root = tmpDir();
    const sysops = new DevSysOps(root);
    await sysops.installFile('/etc/nginx/sites-available/shipway-foo.conf', 'x');

    await sysops.removeFile('/etc/nginx/sites-available/shipway-foo.conf');

    expect(fs.existsSync(path.join(root, '/etc/nginx/sites-available/shipway-foo.conf'))).toBe(false);
  });

  it('removeFile does not throw when the file does not exist', async () => {
    const root = tmpDir();
    const sysops = new DevSysOps(root);

    await expect(sysops.removeFile('/etc/nginx/sites-available/shipway-nope.conf')).resolves.toBeUndefined();
  });

  it('removeFile records the call', async () => {
    const root = tmpDir();
    const sysops = new DevSysOps(root);

    await sysops.removeFile('/etc/systemd/system/shipway-app-foo.service');

    expect(sysops.calls).toContain('removeFile /etc/systemd/system/shipway-app-foo.service');
  });

  it('nginxTest returns ok:true with a dev-labeled output, and records the call', async () => {
    const sysops = new DevSysOps(tmpDir());

    const result = await sysops.nginxTest();

    expect(result).toEqual({ ok: true, output: 'syntax ok (dev)' });
    expect(sysops.calls).toContain('nginxTest');
  });

  it('reloadNginx, reloadPhpFpm, daemonReload only record calls (no side effects)', async () => {
    const sysops = new DevSysOps(tmpDir());

    await sysops.reloadNginx();
    await sysops.reloadPhpFpm('8.3');
    await sysops.daemonReload();

    expect(sysops.calls).toEqual(['reloadNginx', 'reloadPhpFpm 8.3', 'daemonReload']);
  });

  it('unitAction records "unitAction <action> <unit>"', async () => {
    const sysops = new DevSysOps(tmpDir());

    await sysops.unitAction('restart', 'shipway-app-x');

    expect(sysops.calls).toContain('unitAction restart shipway-app-x');
  });

  it('unitAction rejects an invalid unit name and does not record the call', async () => {
    const sysops = new DevSysOps(tmpDir());

    await expect(sysops.unitAction('restart', 'evil; rm -rf /')).rejects.toThrow();
    expect(sysops.calls).toEqual([]);
  });

  it('unitStatus always returns "unknown" for a valid unit and records the call', async () => {
    const sysops = new DevSysOps(tmpDir());

    const status = await sysops.unitStatus('shipway-app-x');

    expect(status).toBe('unknown');
    expect(sysops.calls).toContain('unitStatus shipway-app-x');
  });

  it('unitStatus rejects an invalid unit name', async () => {
    const sysops = new DevSysOps(tmpDir());

    await expect(sysops.unitStatus('not-a-shipway-unit')).rejects.toThrow();
  });

  it('systemUnitStatus always returns "unknown" for an allowlisted unit and records the call', async () => {
    const sysops = new DevSysOps(tmpDir());

    const status = await sysops.systemUnitStatus('mysql');

    expect(status).toBe('unknown');
    expect(sysops.calls).toContain('systemUnitStatus mysql');
  });

  it('systemUnitStatus rejects a unit outside the SYSTEM_UNITS allowlist and does not record the call', async () => {
    const sysops = new DevSysOps(tmpDir());

    await expect(sysops.systemUnitStatus('evil-unit')).rejects.toThrow();
    expect(sysops.calls).toEqual([]);
  });

  it('journalTail always returns "" for a valid unit and records the call', async () => {
    const sysops = new DevSysOps(tmpDir());

    const output = await sysops.journalTail('shipway-app-x', 50);

    expect(output).toBe('');
    expect(sysops.calls).toContain('journalTail shipway-app-x 50');
  });

  it('journalTail rejects an invalid unit name', async () => {
    const sysops = new DevSysOps(tmpDir());

    await expect(sysops.journalTail('not-a-shipway-unit', 50)).rejects.toThrow();
  });

  it('journalTail accepts a systemd unit glob pattern (for tailing every instance of a template unit)', async () => {
    const sysops = new DevSysOps(tmpDir());

    const output = await sysops.journalTail('shipway-worker-shop-mailer@*', 50);

    expect(output).toBe('');
    expect(sysops.calls).toContain('journalTail shipway-worker-shop-mailer@* 50');
  });

  it('readCrontab returns "" before anything has been written', async () => {
    const sysops = new DevSysOps(tmpDir());

    expect(await sysops.readCrontab()).toBe('');
  });

  it('writeCrontab/readCrontab round-trip content in memory', async () => {
    const sysops = new DevSysOps(tmpDir());
    const content = '* * * * * /opt/shipway/bin/cron-entry\n';

    await sysops.writeCrontab(content);

    expect(await sysops.readCrontab()).toBe(content);
  });

  it('records calls in the order they were made', async () => {
    const root = tmpDir();
    const sysops = new DevSysOps(root);

    await sysops.installFile('/a', 'x');
    await sysops.removeFile('/a');
    await sysops.unitAction('start', 'shipway-app-x');

    expect(sysops.calls).toEqual(['installFile /a (1 bytes)', 'removeFile /a', 'unitAction start shipway-app-x']);
  });
});
