import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type ShipwayDb = BetterSQLite3Database<typeof schema>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This file lives at `src/db/index.ts` (and compiles to `dist/db/index.js`),
// so in both cases the migrations folder is two levels up, at the server
// package root: `server/drizzle`.
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle');

/**
 * Opens (creating if necessary) the SQLite database at `dbPath`, applies
 * `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`, then runs any
 * pending migrations from `server/drizzle` before returning the typed db.
 */
export function openDb(dbPath: string): ShipwayDb {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const client = new Database(dbPath);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');

  const db = drizzle({ client, schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return db;
}
