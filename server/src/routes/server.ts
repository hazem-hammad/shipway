import type { FastifyInstance } from 'fastify';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStats } from '../services/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This file lives at `src/routes/server.ts` (and compiles to `dist/routes/server.js`), so in both
// cases the repo root `package.json` is three levels up: routes -> src -> server -> repo root.
const ROOT_PACKAGE_JSON = path.resolve(__dirname, '../../../package.json');

interface RootPackageJson {
  version?: string;
}

/** Reads `version` from the repo root `package.json`. */
export function readShipwayVersion(): string {
  const raw = fs.readFileSync(ROOT_PACKAGE_JSON, 'utf8');
  const parsed = JSON.parse(raw) as RootPackageJson;
  return parsed.version ?? 'unknown';
}

/**
 * Registers `GET /api/server/stats`. Sits under the global session guard in `buildApp`. The
 * Shipway version is read from the root `package.json` once, at registration time (startup) — not
 * re-read on every request.
 */
export async function serverRoutes(app: FastifyInstance): Promise<void> {
  const shipwayVersion = readShipwayVersion();

  app.get('/api/server/stats', async () => {
    const stats = await getStats({ sysops: app.sysops });
    return { ...stats, shipwayVersion };
  });
}
