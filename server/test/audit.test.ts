import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { auditEvents, users } from '../src/db/schema.js';
import { getSetting } from '../src/db/settings.js';
import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  getActor,
  getAuditEnabled,
  getAuditRetentionDays,
  purgeAudit,
  recordAudit,
  setAuditEnabled,
  setAuditRetentionDays,
} from '../src/services/audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../drizzle');

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-audit-test-'));
  return path.join(dir, 'shipway.db');
}

/** Like `openDb`, but also hands back the raw better-sqlite3 client so a test can `.close()` it to
 * simulate a broken/unavailable db (recordAudit must swallow whatever that throws). */
function openDbWithClient(dbPath: string): { db: ShipwayDb; client: Database.Database } {
  const client = new Database(dbPath);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  const db = drizzle({ client }) as unknown as ShipwayDb;
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, client };
}

describe('recordAudit', () => {
  it('inserts a row with the given actor/action/target/meta', () => {
    const db = openDb(tmpDbPath());
    db.insert(users).values({ name: 'Ada Lovelace', email: 'ada@example.com', passwordHash: 'hash' }).run();
    const actor = db.select({ id: users.id }).from(users).get()!;

    recordAudit(db, {
      actorId: actor.id,
      actorName: 'Ada Lovelace',
      action: 'project.create',
      targetType: 'project',
      targetName: 'my-app',
      meta: { type: 'node' },
    });

    const rows = db.select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: actor.id,
      actorName: 'Ada Lovelace',
      action: 'project.create',
      targetType: 'project',
      targetName: 'my-app',
    });
    expect(JSON.parse(rows[0]!.meta!)).toEqual({ type: 'node' });
    expect(typeof rows[0]!.createdAt).toBe('number');
  });

  it('allows a null actorId (e.g. a webhook-triggered action) and an omitted meta', () => {
    const db = openDb(tmpDbPath());

    recordAudit(db, {
      actorId: null,
      actorName: 'github',
      action: 'deploy.trigger',
      targetType: 'project',
      targetName: 'my-app',
    });

    const row = db.select().from(auditEvents).all()[0];
    expect(row?.actorId).toBeNull();
    expect(row?.actorName).toBe('github');
    expect(row?.meta).toBeNull();
  });

  it('no-ops (no row inserted) when audit_enabled is set to false', () => {
    const db = openDb(tmpDbPath());
    setAuditEnabled(db, false);

    recordAudit(db, { actorId: null, actorName: 'x', action: 'project.create', targetType: 'project', targetName: 'x' });

    expect(db.select().from(auditEvents).all()).toHaveLength(0);
  });

  it('records normally when audit_enabled is unset (defaults to enabled)', () => {
    const db = openDb(tmpDbPath());

    recordAudit(db, { actorId: null, actorName: 'x', action: 'project.create', targetType: 'project', targetName: 'x' });

    expect(db.select().from(auditEvents).all()).toHaveLength(1);
  });

  it('never throws into the caller when the db is broken, and logs the failure instead', () => {
    const { db, client } = openDbWithClient(tmpDbPath());
    client.close();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      recordAudit(db, { actorId: null, actorName: 'x', action: 'project.create', targetType: 'project', targetName: 'x' }),
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe('purgeAudit', () => {
  it('deletes rows older than the retention window and keeps newer ones', () => {
    const db = openDb(tmpDbPath());
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    db.insert(auditEvents)
      .values([
        { actorId: null, actorName: 'old', action: 'a', targetType: 't', targetName: 'n', createdAt: now - 100 * oneDayMs },
        { actorId: null, actorName: 'recent', action: 'a', targetType: 't', targetName: 'n', createdAt: now - 1 * oneDayMs },
      ])
      .run();

    purgeAudit(db, 90);

    const remaining = db.select().from(auditEvents).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.actorName).toBe('recent');
  });

  it('deletes nothing when every row is within the retention window', () => {
    const db = openDb(tmpDbPath());
    recordAudit(db, { actorId: null, actorName: 'x', action: 'a', targetType: 't', targetName: 'n' });

    purgeAudit(db, 90);

    expect(db.select().from(auditEvents).all()).toHaveLength(1);
  });
});

describe('audit config (settings-backed)', () => {
  it('getAuditEnabled defaults to true when unset', () => {
    const db = openDb(tmpDbPath());
    expect(getAuditEnabled(db)).toBe(true);
  });

  it('setAuditEnabled/getAuditEnabled round-trips', () => {
    const db = openDb(tmpDbPath());
    setAuditEnabled(db, false);
    expect(getAuditEnabled(db)).toBe(false);
    expect(getSetting<boolean>(db, 'audit_enabled')).toBe(false);
  });

  it('getAuditRetentionDays defaults to 90 when unset', () => {
    const db = openDb(tmpDbPath());
    expect(getAuditRetentionDays(db)).toBe(90);
    expect(DEFAULT_AUDIT_RETENTION_DAYS).toBe(90);
  });

  it('setAuditRetentionDays/getAuditRetentionDays round-trips', () => {
    const db = openDb(tmpDbPath());
    setAuditRetentionDays(db, 30);
    expect(getAuditRetentionDays(db)).toBe(30);
  });
});

describe('getActor', () => {
  it('resolves an actorId to the user row name', () => {
    const db = openDb(tmpDbPath());
    db.insert(users).values({ name: 'Ada Lovelace', email: 'ada@example.com', passwordHash: 'hash' }).run();
    const row = db.select({ id: users.id }).from(users).get()!;

    expect(getActor(db, row.id)).toEqual({ actorId: row.id, actorName: 'Ada Lovelace' });
  });

  it('returns a null actor for an undefined userId (no session)', () => {
    const db = openDb(tmpDbPath());
    expect(getActor(db, undefined)).toEqual({ actorId: null, actorName: 'unknown' });
  });

  it('returns a null actorId + "unknown" name for a userId with no matching row', () => {
    const db = openDb(tmpDbPath());
    expect(getActor(db, 999999)).toEqual({ actorId: null, actorName: 'unknown' });
  });
});
