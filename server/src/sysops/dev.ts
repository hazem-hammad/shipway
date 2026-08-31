import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertSystemUnit, assertUnitName, assertUnitPattern } from './types.js';
import type { SysOps, UnitAction, UnitStatus } from './types.js';

/**
 * DevSysOps sandboxes every operation under `rootDir` instead of touching
 * the real system: files are written under `rootDir` + dest, and everything
 * else is a recorded no-op. Used in dev mode, and as the test double
 * anywhere else needs a `SysOps`.
 */
export class DevSysOps implements SysOps {
  /** Human-readable record of every call made, in order. */
  readonly calls: string[] = [];

  private crontabContent = '';

  constructor(private readonly rootDir: string) {}

  async installFile(dest: string, content: string): Promise<void> {
    const target = path.join(this.rootDir, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    this.calls.push(`installFile ${dest} (${Buffer.byteLength(content, 'utf8')} bytes)`);
  }

  async removeFile(dest: string): Promise<void> {
    const target = path.join(this.rootDir, dest);
    fs.rmSync(target, { force: true });
    this.calls.push(`removeFile ${dest}`);
  }

  async nginxTest(): Promise<{ ok: boolean; output: string }> {
    this.calls.push('nginxTest');
    return { ok: true, output: 'syntax ok (dev)' };
  }

  async reloadNginx(): Promise<void> {
    this.calls.push('reloadNginx');
  }

  // `signal` (interface compliance with `SysOps`) is accepted but not acted on here: every
  // operation below is a synchronous, instant no-op with nothing to actually interrupt. Tests that
  // need a genuinely-abortable or genuinely-failing restart use a small subclass that overrides
  // `unitAction` (see e.g. `pipeline.test.ts`'s fixtures), not this base class.

  async reloadPhpFpm(version: string, signal?: AbortSignal): Promise<void> {
    void signal;
    this.calls.push(`reloadPhpFpm ${version}`);
  }

  async daemonReload(): Promise<void> {
    this.calls.push('daemonReload');
  }

  async unitAction(action: UnitAction, unit: string, signal?: AbortSignal): Promise<void> {
    void signal;
    assertUnitName(unit);
    this.calls.push(`unitAction ${action} ${unit}`);
  }

  async unitStatus(unit: string): Promise<UnitStatus> {
    assertUnitName(unit);
    this.calls.push(`unitStatus ${unit}`);
    return 'unknown';
  }

  async systemUnitStatus(unit: string): Promise<UnitStatus> {
    assertSystemUnit(unit);
    this.calls.push(`systemUnitStatus ${unit}`);
    return 'unknown';
  }

  async journalTail(unit: string, lines: number): Promise<string> {
    assertUnitPattern(unit);
    this.calls.push(`journalTail ${unit} ${lines}`);
    return '';
  }

  async syncPgAdminServers(payload: string): Promise<void> {
    this.calls.push(`syncPgAdminServers (${Buffer.byteLength(payload, 'utf8')} bytes)`);
  }

  async readCrontab(): Promise<string> {
    this.calls.push('readCrontab');
    return this.crontabContent;
  }

  async writeCrontab(content: string): Promise<void> {
    this.crontabContent = content;
    this.calls.push(`writeCrontab (${Buffer.byteLength(content, 'utf8')} bytes)`);
  }
}
