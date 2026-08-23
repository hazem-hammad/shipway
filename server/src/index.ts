import { mkdirSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();

mkdirSync(cfg.dataDir, { recursive: true });

const app = await buildApp(cfg);

await app.listen({ port: cfg.port, host: '127.0.0.1' });
