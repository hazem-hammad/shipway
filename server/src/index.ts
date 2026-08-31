import { mkdirSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { importBootstrap } from './lib/bootstrap.js';
import { syncPgAdminServers } from './services/pgadmin.js';

const cfg = loadConfig();

mkdirSync(cfg.dataDir, { recursive: true });

const app = await buildApp(cfg);

// One-time import of `setup/install.sh`'s bootstrap.json (admin DB credentials, redis/mailpit
// info) into settings, if present. See lib/bootstrap.ts.
importBootstrap(app.db, cfg);

// Rebuilds pgAdmin's Shipway server group from the databases on file. Not awaited: it shells out
// to pgAdmin's own (slow-starting) CLI, and nothing about serving requests depends on it. Every
// create and drop syncs too — this one exists so a sync that failed, or databases that predate the
// feature, are corrected by a restart. Never rejects (see services/pgadmin.ts).
void syncPgAdminServers(app);

await app.listen({ port: cfg.port, host: '127.0.0.1' });
