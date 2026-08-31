import { execa } from 'execa';
import { AbortedError } from '../lib/aborted-error.js';
import { assertSystemUnit, assertUnitName, assertUnitPattern } from './types.js';
import type { SysOps, UnitAction, UnitStatus } from './types.js';

const PHP_VERSION_RE = /^8\.[0-9]+$/;
const MIN_JOURNAL_LINES = 1;
const MAX_JOURNAL_LINES = 1000;

/** SIGKILL escalation delay if a `signal`-aborted restart's process group doesn't exit promptly
 * after the SIGTERM `cancelSignal` sends — mirrors `deploy/runshell.ts`/`services/git.ts`. */
const CANCEL_FORCE_KILL_DELAY_MS = 5000;

/**
 * RealSysOps performs privileged system mutations by shelling out via
 * `sudo`, either to the whitelisted root helper `shipway-sysops` (for file
 * installs) or directly to `systemctl`/`nginx`/`journalctl`/`crontab`
 * (whitelisted by the sudoers file, or not privileged at all).
 *
 * `run` defaults to the real `execa`; tests may inject a stub to verify
 * command assembly without invoking real `sudo`.
 */
export class RealSysOps implements SysOps {
  constructor(private readonly run: typeof execa = execa) {}

  async installFile(dest: string, content: string): Promise<void> {
    await this.run('sudo', ['shipway-sysops', 'install-file', dest], { input: content });
  }

  async removeFile(dest: string): Promise<void> {
    await this.run('sudo', ['shipway-sysops', 'remove-file', dest]);
  }

  async nginxTest(): Promise<{ ok: boolean; output: string }> {
    const result = await this.run('sudo', ['nginx', '-t'], { reject: false });
    return { ok: result.exitCode === 0, output: result.stderr };
  }

  async reloadNginx(): Promise<void> {
    await this.run('sudo', ['systemctl', 'reload', 'nginx']);
  }

  async reloadPhpFpm(version: string, signal?: AbortSignal): Promise<void> {
    if (!PHP_VERSION_RE.test(version)) {
      throw new Error(`Invalid PHP version: ${version}`);
    }
    await this.runCancelable(['systemctl', 'reload', `php${version}-fpm`], signal, `php${version}-fpm reload`);
  }

  async daemonReload(): Promise<void> {
    await this.run('sudo', ['systemctl', 'daemon-reload']);
  }

  async unitAction(action: UnitAction, unit: string, signal?: AbortSignal): Promise<void> {
    assertUnitName(unit);
    await this.runCancelable(['systemctl', action, unit], signal, `systemctl ${action} ${unit}`);
  }

  /**
   * Shared by `unitAction`/`reloadPhpFpm`: `sudo <args>` with no extra options when `signal` is
   * omitted (preserving the exact command shape every other caller — routes, workers, cron — has
   * always gotten, none of which have a signal to pass), or with `cancelSignal`/`killDescendants`/
   * `forceKillAfterDelay` wired up when the deploy pipeline's post-activate restart passes one (see
   * `deploy/pipeline.ts`'s `restartRuntime`/`restartWorkers`). A failure while `signal` is aborted
   * is rethrown as `AbortedError` (attributing it to *this* abort specifically, not a coincidental
   * one) so callers can classify by error type; otherwise the raw error propagates unchanged.
   */
  private async runCancelable(args: string[], signal: AbortSignal | undefined, label: string): Promise<void> {
    if (!signal) {
      await this.run('sudo', args);
      return;
    }
    try {
      await this.run('sudo', args, { cancelSignal: signal, killDescendants: true, forceKillAfterDelay: CANCEL_FORCE_KILL_DELAY_MS });
    } catch (err) {
      throw signal.aborted ? new AbortedError(`${label} canceled`) : err;
    }
  }

  async unitStatus(unit: string): Promise<UnitStatus> {
    assertUnitName(unit);
    return this.queryIsActive(unit);
  }

  async systemUnitStatus(unit: string): Promise<UnitStatus> {
    assertSystemUnit(unit);
    return this.queryIsActive(unit);
  }

  /** Shared `systemctl is-active <unit>` query behind `unitStatus`/`systemUnitStatus`. No sudo; never throws. */
  private async queryIsActive(unit: string): Promise<UnitStatus> {
    try {
      const result = await this.run('systemctl', ['is-active', unit], { reject: false });
      const status = result.stdout.trim();
      if (status === 'active' || status === 'inactive' || status === 'failed') {
        return status;
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async journalTail(unit: string, lines: number): Promise<string> {
    assertUnitPattern(unit);
    const clamped = Math.min(MAX_JOURNAL_LINES, Math.max(MIN_JOURNAL_LINES, Math.trunc(lines)));
    const result = await this.run('journalctl', ['-u', unit, '-n', String(clamped), '--no-pager']);
    return result.stdout;
  }

  async syncPgAdminServers(payload: string): Promise<void> {
    await this.run('sudo', ['shipway-sysops', 'pgadmin-sync'], { input: payload });
  }

  async readCrontab(): Promise<string> {
    const result = await this.run('crontab', ['-l'], { reject: false });
    if (result.exitCode === 0) {
      return result.stdout;
    }
    if (result.stderr.includes('no crontab')) {
      return '';
    }
    throw new Error(`crontab -l failed (exit ${String(result.exitCode)}): ${result.stderr}`);
  }

  async writeCrontab(content: string): Promise<void> {
    await this.run('crontab', ['-'], { input: content });
  }
}
