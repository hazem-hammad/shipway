import Database from 'better-sqlite3';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { users } from './schema.js';

export type ShipwayDb = BetterSQLite3Database<typeof schema>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This file lives at `src/db/index.ts` (and compiles to `dist/db/index.js`),
// so in both cases the migrations folder is two levels up, at the server
// package root: `server/drizzle`.
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle');

/**
 * If no user currently has `role: 'owner'`, promotes the earliest-created user (lowest `id`) to
 * owner. A no-op on a fresh, empty `users` table (the first `POST /api/setup/admin` call creates
 * its user as `'owner'` directly — see `routes/auth.ts` — so this never has to act on a fresh
 * install) and a no-op once an owner already exists. Exists so a db migrated from v1 (whose users
 * all default to `role: 'member'` via migration 0001) ends up with exactly one owner on first boot
 * after the upgrade.
 */
function promoteEarliestUserToOwner(db: ShipwayDb): void {
  const existingOwner = db.select({ id: users.id }).from(users).where(eq(users.role, 'owner')).limit(1).get();
  if (existingOwner) return;

  const earliest = db.select({ id: users.id }).from(users).orderBy(asc(users.id)).limit(1).get();
  if (!earliest) return;

  db.update(users).set({ role: 'owner' }).where(eq(users.id, earliest.id)).run();
}

/**
 * Opens (creating if necessary) the SQLite database at `dbPath`, applies
 * `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`, then runs any
 * pending migrations from `server/drizzle` before returning the typed db.
 *
 * FK enforcement is toggled OFF for the duration of `migrate()` itself (restored in a `finally`, so
 * a failed migration can never leave it off for the rest of this process). Reason: drizzle's
 * `migrate()` wraps every pending migration in one `BEGIN...COMMIT`, and SQLite silently NO-OPS a
 * `PRAGMA foreign_keys=OFF/ON` issued INSIDE an already-open transaction — so a migration `.sql`
 * file's own PRAGMA lines (e.g. 0002's table-rebuild dance: `DROP TABLE notification_channels` +
 * recreate/rename) are purely decorative and do nothing. Without this, FK enforcement stays ON
 * through the whole transaction, and a table-rebuild's `DROP TABLE` cascade-deletes every
 * referencing row (`notification_subscriptions.channel_id ON DELETE CASCADE`) before the table is
 * even recreated — silently destroying live data on any upgrade that hits such a migration. Toggling
 * the pragma here, OUTSIDE the transaction `migrate()` opens, is the only place it actually takes
 * effect.
 */
export function openDb(dbPath: string): ShipwayDb {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const client = new Database(dbPath);
  client.pragma('journal_mode = WAL');

  const db = drizzle({ client, schema });
  client.pragma('foreign_keys = OFF');
  try {
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    client.pragma('foreign_keys = ON');
  }
  promoteEarliestUserToOwner(db);

  return db;
}
