import { eq } from 'drizzle-orm';
import { settings } from './schema.js';
import type { ShipwayDb } from './index.js';

/** Reads and JSON-decodes the value stored under `key`, or `null` if unset. */
export function getSetting<T>(db: ShipwayDb, key: string): T | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return null;
  return JSON.parse(row.value) as T;
}

/** JSON-encodes `value` and upserts it under `key`. */
export function setSetting(db: ShipwayDb, key: string, value: unknown): void {
  const encoded = JSON.stringify(value);
  db.insert(settings)
    .values({ key, value: encoded })
    .onConflictDoUpdate({ target: settings.key, set: { value: encoded } })
    .run();
}

/** Deletes the row for `key`, if any. Idempotent — a no-op when the key is already unset. */
export function deleteSetting(db: ShipwayDb, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}
