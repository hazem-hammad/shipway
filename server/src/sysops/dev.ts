import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertUnitName, assertUnitPattern } from './types.js';
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

  async reloadPhpFpm(version: string): Promise<void> {
    this.calls.push(`reloadPhpFpm ${version}`);
  }

  async daemonReload(): Promise<void> {
    this.calls.push('daemonReload');
  }

  async unitAction(action: UnitAction, unit: string): Promise<void> {
    assertUnitName(unit);
    this.calls.push(`unitAction ${action} ${unit}`);
  }

  async unitStatus(unit: string): Promise<UnitStatus> {
    assertUnitName(unit);
    this.calls.push(`unitStatus ${unit}`);
    return 'unknown';
  }

  async journalTail(unit: string, lines: number): Promise<string> {
    assertUnitPattern(unit);
    this.calls.push(`journalTail ${unit} ${lines}`);
    return '';
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
