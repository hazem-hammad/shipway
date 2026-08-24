import { describe, expect, it, vi } from 'vitest';
import type { execa } from 'execa';
import { AbortedError } from '../src/lib/aborted-error.js';
import { RealSysOps } from '../src/sysops/real.js';

interface StubCall {
  file: string;
  args: readonly string[];
  options?: Record<string, unknown>;
}

interface StubResult {
  exitCode?: number;
  stdout: string;
  stderr: string;
}

function makeStubRun(result: Partial<StubResult> = {}) {
  const calls: StubCall[] = [];
  const resolved: StubResult = { exitCode: 0, stdout: '', stderr: '', ...result };
  const run = vi.fn(async (file: string, args: readonly string[] = [], options?: Record<string, unknown>) => {
    calls.push({ file, args, options });
    return resolved;
  });
  return { run: run as unknown as typeof execa, calls };
}

describe('RealSysOps command assembly', () => {
  it('installFile shells out to the root helper with content on stdin', async () => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);

    await sysops.installFile('/etc/nginx/sites-available/shipway-foo.conf', 'server {}\n');

    expect(calls).toEqual([
      {
        file: 'sudo',
        args: ['shipway-sysops', 'install-file', '/etc/nginx/sites-available/shipway-foo.conf'],
        options: { input: 'server {}\n' },
      },
    ]);
  });

  it('removeFile shells out to the root helper', async () => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);

    await sysops.removeFile('/etc/systemd/system/shipway-app-foo.service');

    expect(calls).toEqual([
      {
        file: 'sudo',
        args: ['shipway-sysops', 'remove-file', '/etc/systemd/system/shipway-app-foo.service'],
        options: undefined,
      },
    ]);
  });

  it('nginxTest returns ok:true on exit 0 and never throws', async () => {
    const { run, calls } = makeStubRun({ exitCode: 0, stderr: '' });
    const sysops = new RealSysOps(run);

    const result = await sysops.nginxTest();

    expect(result).toEqual({ ok: true, output: '' });
    expect(calls[0]).toEqual({ file: 'sudo', args: ['nginx', '-t'], options: { reject: false } });
  });

  it('nginxTest returns ok:false with captured stderr on nonzero exit, never throws', async () => {
    const { run } = makeStubRun({ exitCode: 1, stderr: 'nginx: [emerg] bad config\n' });
    const sysops = new RealSysOps(run);

    const result = await sysops.nginxTest();

    expect(result).toEqual({ ok: false, output: 'nginx: [emerg] bad config\n' });
  });

  it('reloadNginx runs systemctl reload nginx', async () => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);

    await sysops.reloadNginx();

    expect(calls).toEqual([{ file: 'sudo', args: ['systemctl', 'reload', 'nginx'], options: undefined }]);
  });

  it('reloadPhpFpm reloads php<version>-fpm for a valid version', async () => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);

    await sysops.reloadPhpFpm('8.3');

    expect(calls).toEqual([{ file: 'sudo', args: ['systemctl', 'reload', 'php8.3-fpm'], options: undefined }]);
  });

  it('reloadPhpFpm rejects an invalid version without shelling out', async () => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);

    await expect(sysops.reloadPhpFpm('8.3; rm -rf /')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('daemonReload runs systemctl daemon-reload', async () => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);

    await sysops.daemonReload();

    expect(calls).toEqual([{ file: 'sudo', args: ['systemctl', 'daemon-reload'], options: undefined }]);
  });

  it('unitAction runs sudo systemctl <action> <unit>', async () => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);

    await sysops.unitAction('restart', 'shipway-app-foo');

    expect(calls).toEqual([{ file: 'sudo', args: ['systemctl', 'restart', 'shipway-app-foo'], options: undefined }]);
  });

  it('unitAction rejects an invalid unit name without shelling out', async () => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);

    await expect(sysops.unitAction('restart', 'not-a-unit')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('unitAction, given a signal, passes it through as cancelSignal (plus killDescendants + forceKillAfterDelay)', async () => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);
    const controller = new AbortController();

    await sysops.unitAction('restart', 'shipway-app-foo', controller.signal);

    expect(calls).toEqual([
      {
        file: 'sudo',
        args: ['systemctl', 'restart', 'shipway-app-foo'],
        options: { cancelSignal: controller.signal, killDescendants: true, forceKillAfterDelay: 5000 },
      },
    ]);
  });

  it('unitAction, given a signal that fires mid-command, rejects promptly with a clear AbortedError (not the raw execa/DOMException message) — a genuinely-interrupted restart, not just a stage-boundary check', async () => {
    // A stub `run` that never settles on its own — only the `cancelSignal` it was given (execa's
    // real behavior on abort) rejects it, simulating a hung/wedged `systemctl restart`. The raw
    // rejection is deliberately generic/confusing to prove `unitAction` replaces it.
    const run = vi.fn(
      (_file: string, _args: readonly string[] = [], options?: { cancelSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.cancelSignal?.addEventListener(
            'abort',
            () => {
              reject(new Error('This operation was aborted'));
            },
            { once: true },
          );
        }),
    ) as unknown as typeof execa;
    const sysops = new RealSysOps(run);
    const controller = new AbortController();

    const promise = sysops.unitAction('restart', 'shipway-app-foo', controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 20);

    const start = Date.now();
    await expect(promise).rejects.toThrow(AbortedError);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('unitAction, given a signal, still rejects with the RAW error when the command fails for an unrelated reason (signal never aborts)', async () => {
    const run = vi.fn(async () => {
      throw new Error('systemctl restart shipway-app-foo: unit failed to start (Result: exit-code)');
    }) as unknown as typeof execa;
    const sysops = new RealSysOps(run);
    const controller = new AbortController();

    await expect(sysops.unitAction('restart', 'shipway-app-foo', controller.signal)).rejects.toThrow(
      /unit failed to start/,
    );
    await expect(sysops.unitAction('restart', 'shipway-app-foo', controller.signal)).rejects.not.toBeInstanceOf(
      AbortedError,
    );
  });

  it('reloadPhpFpm, given a signal that fires mid-command, rejects promptly with a clear AbortedError', async () => {
    const run = vi.fn(
      (_file: string, _args: readonly string[] = [], options?: { cancelSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.cancelSignal?.addEventListener(
            'abort',
            () => {
              reject(new Error('This operation was aborted'));
            },
            { once: true },
          );
        }),
    ) as unknown as typeof execa;
    const sysops = new RealSysOps(run);
    const controller = new AbortController();

    const promise = sysops.reloadPhpFpm('8.3', controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 20);

    const start = Date.now();
    await expect(promise).rejects.toThrow(AbortedError);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('unitStatus runs systemctl is-active <unit> without sudo and maps stdout', async () => {
    const { run, calls } = makeStubRun({ stdout: 'active\n' });
    const sysops = new RealSysOps(run);

    const status = await sysops.unitStatus('shipway-app-foo');

    expect(status).toBe('active');
    expect(calls).toEqual([{ file: 'systemctl', args: ['is-active', 'shipway-app-foo'], options: { reject: false } }]);
  });

  it.each([
    ['inactive\n', 'inactive'],
    ['failed\n', 'failed'],
    ['activating\n', 'unknown'],
    ['', 'unknown'],
  ])('unitStatus maps stdout %j to %s', async (stdout, expected) => {
    const { run } = makeStubRun({ stdout });
    const sysops = new RealSysOps(run);

    expect(await sysops.unitStatus('shipway-app-foo')).toBe(expected);
  });

  it('unitStatus returns "unknown" instead of throwing when the run fails', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn failed');
    }) as unknown as typeof execa;
    const sysops = new RealSysOps(run);

    await expect(sysops.unitStatus('shipway-app-foo')).resolves.toBe('unknown');
  });

  it('unitStatus rejects an invalid unit name without shelling out', async () => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);

    await expect(sysops.unitStatus('not-a-unit')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('systemUnitStatus runs systemctl is-active <unit> without sudo, for shared (non-shipway-prefixed) units', async () => {
    const { run, calls } = makeStubRun({ stdout: 'active\n' });
    const sysops = new RealSysOps(run);

    const status = await sysops.systemUnitStatus('nginx');

    expect(status).toBe('active');
    expect(calls).toEqual([{ file: 'systemctl', args: ['is-active', 'nginx'], options: { reject: false } }]);
  });

  it.each([
    ['inactive\n', 'inactive'],
    ['failed\n', 'failed'],
    ['activating\n', 'unknown'],
    ['', 'unknown'],
  ])('systemUnitStatus maps stdout %j to %s', async (stdout, expected) => {
    const { run } = makeStubRun({ stdout });
    const sysops = new RealSysOps(run);

    expect(await sysops.systemUnitStatus('mailpit')).toBe(expected);
  });

  it('systemUnitStatus returns "unknown" instead of throwing when the run fails', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn failed');
    }) as unknown as typeof execa;
    const sysops = new RealSysOps(run);

    await expect(sysops.systemUnitStatus('nginx')).resolves.toBe('unknown');
  });

  it('systemUnitStatus rejects a unit outside the SYSTEM_UNITS allowlist, without shelling out', async () => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);

    await expect(sysops.systemUnitStatus('evil-unit')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('journalTail runs journalctl without sudo and clamps lines into [1, 1000]', async () => {
    const { run, calls } = makeStubRun({ stdout: 'log line\n' });
    const sysops = new RealSysOps(run);

    const output = await sysops.journalTail('shipway-app-foo', 50);

    expect(output).toBe('log line\n');
    expect(calls).toEqual([
      { file: 'journalctl', args: ['-u', 'shipway-app-foo', '-n', '50', '--no-pager'], options: undefined },
    ]);
  });

  it.each([
    [0, '1'],
    [-5, '1'],
    [1.9, '1'],
    [5000, '1000'],
    [1000, '1000'],
  ])('journalTail clamps %d lines to %s', async (lines, expected) => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);

    await sysops.journalTail('shipway-app-foo', lines);

    expect(calls[0]?.args).toEqual(['-u', 'shipway-app-foo', '-n', expected, '--no-pager']);
  });

  it('journalTail rejects an invalid unit name without shelling out', async () => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);

    await expect(sysops.journalTail('not-a-unit', 50)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('journalTail accepts a systemd unit glob pattern (for tailing every instance of a template unit)', async () => {
    const { run, calls } = makeStubRun({ stdout: 'log line\n' });
    const sysops = new RealSysOps(run);

    const output = await sysops.journalTail('shipway-worker-shop-mailer@*', 50);

    expect(output).toBe('log line\n');
    expect(calls).toEqual([
      { file: 'journalctl', args: ['-u', 'shipway-worker-shop-mailer@*', '-n', '50', '--no-pager'], options: undefined },
    ]);
  });

  it('readCrontab runs crontab -l without sudo and returns stdout on success', async () => {
    const { run, calls } = makeStubRun({ stdout: '* * * * * /bin/true\n' });
    const sysops = new RealSysOps(run);

    expect(await sysops.readCrontab()).toBe('* * * * * /bin/true\n');
    expect(calls).toEqual([{ file: 'crontab', args: ['-l'], options: { reject: false } }]);
  });

  it('readCrontab returns "" when there is no crontab (exit 1, "no crontab" message)', async () => {
    const { run } = makeStubRun({ exitCode: 1, stdout: '', stderr: 'no crontab for deployer\n' });
    const sysops = new RealSysOps(run);

    expect(await sysops.readCrontab()).toBe('');
  });

  it('readCrontab throws on other failures', async () => {
    const { run } = makeStubRun({ exitCode: 1, stdout: '', stderr: 'permission denied\n' });
    const sysops = new RealSysOps(run);

    await expect(sysops.readCrontab()).rejects.toThrow();
  });

  it('writeCrontab runs crontab - with content on stdin', async () => {
    const { run, calls } = makeStubRun();
    const sysops = new RealSysOps(run);

    await sysops.writeCrontab('* * * * * /bin/true\n');

    expect(calls).toEqual([{ file: 'crontab', args: ['-'], options: { input: '* * * * * /bin/true\n' } }]);
  });

  it('defaults to the real execa when no run is injected', () => {
    const sysops = new RealSysOps();
    expect(sysops).toBeInstanceOf(RealSysOps);
  });
});
