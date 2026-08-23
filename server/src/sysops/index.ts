import * as path from 'node:path';
import type { Config } from '../config.js';
import { DevSysOps } from './dev.js';
import { RealSysOps } from './real.js';
import type { SysOps } from './types.js';

export type { SysOps, UnitAction, UnitStatus } from './types.js';
export { assertUnitName, assertUnitPattern } from './types.js';
export { DevSysOps } from './dev.js';
export { RealSysOps } from './real.js';

/**
 * Builds the `SysOps` implementation for the given config: `DevSysOps`
 * sandboxed under `<dataDir>/system` in dev mode, `RealSysOps` (real
 * `sudo`) otherwise.
 */
export function makeSysOps(cfg: Config): SysOps {
  if (cfg.devMode) {
    return new DevSysOps(path.join(cfg.dataDir, 'system'));
  }
  return new RealSysOps();
}
