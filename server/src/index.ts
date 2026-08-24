import { mkdirSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { importBootstrap } from './lib/bootstrap.js';

const cfg = loadConfig();

mkdirSync(cfg.dataDir, { recursive: true });

const app = await buildApp(cfg);

// One-time import of `setup/install.sh`'s bootstrap.json (admin DB credentials, redis/mailpit
// info) into settings, if present. See lib/bootstrap.ts.
importBootstrap(app.db, cfg);

await app.listen({ port: cfg.port, host: '127.0.0.1' });
