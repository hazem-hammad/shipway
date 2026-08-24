import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, sql } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { auditEvents, notificationChannels, notificationSubscriptions, projects, users } from '../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../drizzle');

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-migration-test-'));
  return path.join(dir, 'shipway.db');
}

/**
 * Simulates a real pre-v2 db on disk: applies ONLY migration 0000 (via drizzle's own migrator, so
 * its `__drizzle_migrations` bookkeeping table matches exactly what a live v1 install has), then
 * inserts a couple of legacy-shape rows with raw SQL (the typed `schema.ts` already has the v2
 * columns, so a typed insert here would silently assume they exist).
 */
function buildLegacyV1Db(dbPath: string): void {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-legacy-migrations-'));
  fs.mkdirSync(path.join(legacyDir, 'meta'));
  fs.copyFileSync(path.join(MIGRATIONS_FOLDER, '0000_clever_nick_fury.sql'), path.join(legacyDir, '0000_clever_nick_fury.sql'));
  fs.copyFileSync(path.join(MIGRATIONS_FOLDER, 'meta/0000_snapshot.json'), path.join(legacyDir, 'meta/0000_snapshot.json'));
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => e.tag === '0000_clever_nick_fury');
  fs.writeFileSync(path.join(legacyDir, 'meta/_journal.json'), JSON.stringify(journal));

  const client = new Database(dbPath);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  const db = drizzle({ client });
  migrate(db, { migrationsFolder: legacyDir });

  // Two pre-existing users (legacy column set only: no role/status/invite_* columns yet) — the
  // earliest by id ('Alice', inserted first) is the one owner-bootstrap must promote.
  const insertUser = client.prepare('INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)');
  insertUser.run('Alice', 'alice@example.com', 'hash-a', Date.now() - 10_000);
  insertUser.run('Bob', 'bob@example.com', 'hash-b', Date.now());

  const insertProject = client.prepare(
    "INSERT INTO projects (name, slug, repo, branch, type, shared_paths, smtp_mode, created_at) VALUES (?, ?, ?, ?, ?, '[]', 'mailpit', ?)",
  );
  insertProject.run('My App', 'my-app', 'acme/my-app', 'main', 'node', Date.now());

  client.close();
}

describe('migration 0001 — fresh install', () => {
  it('creates every v2 table/column on a brand-new db', () => {
    const db = openDb(tmpDbPath());

    const tableNames = new Set(
      db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => row.name),
    );
    for (const table of ['notification_channels', 'notification_subscriptions', 'audit_events']) {
      expect(tableNames.has(table)).toBe(true);
    }

    const projectColumns = db.all<{ name: string }>(sql`PRAGMA table_info(projects)`).map((c) => c.name);
    expect(projectColumns).toContain('repo_url');

    const userColumns = db.all<{ name: string }>(sql`PRAGMA table_info(users)`).map((c) => c.name);
    expect(userColumns).toEqual(expect.arrayContaining(['role', 'status', 'invite_token', 'invite_expires_at']));
  });

  it('defaults a freshly inserted user to role member / status active', () => {
    const db = openDb(tmpDbPath());
    db.insert(users).values({ name: 'Grace Hopper', email: 'grace@example.com', passwordHash: 'hash' }).run();

    const row = db.select().from(users).where(eq(users.email, 'grace@example.com')).get();
    expect(row?.role).toBe('member');
    expect(row?.status).toBe('active');
    expect(row?.inviteToken).toBeNull();
    expect(row?.inviteExpiresAt).toBeNull();
  });

  it('projects.repoUrl defaults to null and can be set', () => {
    const db = openDb(tmpDbPath());
    db.insert(projects)
      .values({ name: 'Git URL App', slug: 'git-url-app', repo: '', branch: 'main', type: 'static', repoUrl: 'https://example.com/acme/app.git' })
      .run();

    const row = db.select().from(projects).where(eq(projects.slug, 'git-url-app')).get();
    expect(row?.repoUrl).toBe('https://example.com/acme/app.git');
  });

  it('notification_subscriptions rejects a duplicate (event, channelId) pair', () => {
    const db = openDb(tmpDbPath());
    db.insert(notificationChannels).values({ name: 'Default', url: 'https://hooks.example.com/x' }).run();
    const channel = db.select({ id: notificationChannels.id }).from(notificationChannels).get()!;

    db.insert(notificationSubscriptions).values({ event: 'deploy_failed', channelId: channel.id }).run();
    expect(() => db.insert(notificationSubscriptions).values({ event: 'deploy_failed', channelId: channel.id }).run()).toThrow();
  });

  it('notification_subscriptions cascades on channel delete', () => {
    const db = openDb(tmpDbPath());
    db.insert(notificationChannels).values({ name: 'Default', url: 'https://hooks.example.com/x' }).run();
    const channel = db.select({ id: notificationChannels.id }).from(notificationChannels).get()!;
    db.insert(notificationSubscriptions).values({ event: 'deploy_failed', channelId: channel.id }).run();

    db.delete(notificationChannels).where(eq(notificationChannels.id, channel.id)).run();

    expect(db.select().from(notificationSubscriptions).all()).toHaveLength(0);
  });

  it('audit_events.actorId is set null (not cascade-deleted) when the actor user is removed', () => {
    const db = openDb(tmpDbPath());
    db.insert(users).values({ name: 'Ada', email: 'ada@example.com', passwordHash: 'hash' }).run();
    const user = db.select({ id: users.id }).from(users).get()!;
    db.insert(auditEvents).values({ actorId: user.id, actorName: 'Ada', action: 'x', targetType: 't', targetName: 'n' }).run();

    db.delete(users).where(eq(users.id, user.id)).run();

    const row = db.select().from(auditEvents).all()[0];
    expect(row?.actorId).toBeNull();
    expect(row?.actorName).toBe('Ada'); // captured at write time, survives the user's deletion
  });

  it('a lone fresh user is NOT auto-promoted to owner by openDb (setup/admin does that directly)', () => {
    const db = openDb(tmpDbPath());
    db.insert(users).values({ name: 'Grace Hopper', email: 'grace@example.com', passwordHash: 'hash' }).run();

    const row = db.select().from(users).where(eq(users.email, 'grace@example.com')).get();
    expect(row?.role).toBe('member');
  });
});

describe('migration 0001 — upgrade from a legacy (0000-only) v1 db', () => {
  it('applies cleanly on top of existing rows, preserving their data', () => {
    const dbPath = tmpDbPath();
    buildLegacyV1Db(dbPath);

    const db = openDb(dbPath); // production path: applies pending migration 0001 + owner bootstrap

    const alice = db.select().from(users).where(eq(users.email, 'alice@example.com')).get();
    expect(alice).toBeDefined();
    expect(alice?.name).toBe('Alice');

    const project = db.select().from(projects).where(eq(projects.slug, 'my-app')).get();
    expect(project).toBeDefined();
    expect(project?.repoUrl).toBeNull();
  });

  it('promotes the earliest-created user (lowest id) to owner when no owner exists yet', () => {
    const dbPath = tmpDbPath();
    buildLegacyV1Db(dbPath);

    const db = openDb(dbPath);

    const alice = db.select().from(users).where(eq(users.email, 'alice@example.com')).get();
    const bob = db.select().from(users).where(eq(users.email, 'bob@example.com')).get();
    expect(alice?.role).toBe('owner');
    expect(bob?.role).toBe('member');
  });

  it('is idempotent: re-opening an already-upgraded db does not touch the existing owner', () => {
    const dbPath = tmpDbPath();
    buildLegacyV1Db(dbPath);
    openDb(dbPath);

    // Promote Bob by hand (simulating a future role-management action) and re-open — the boot hook
    // must not "fix" this back onto the earliest user, since an owner already exists.
    const first = openDb(dbPath);
    const bob = first.select().from(users).where(eq(users.email, 'bob@example.com')).get()!;
    first.update(users).set({ role: 'admin' }).where(eq(users.id, bob.id)).run();

    const second = openDb(dbPath);
    const alice = second.select().from(users).where(eq(users.email, 'alice@example.com')).get();
    const bobAgain = second.select().from(users).where(eq(users.email, 'bob@example.com')).get();
    expect(alice?.role).toBe('owner');
    expect(bobAgain?.role).toBe('admin');
  });

  it('running the full migration set (0000+0001) fresh matches applying 0000 then 0001 on an existing db (no divergence)', () => {
    const legacyPath = tmpDbPath();
    buildLegacyV1Db(legacyPath);
    const upgraded = openDb(legacyPath);

    const freshPath = tmpDbPath();
    const fresh = openDb(freshPath);

    const upgradedColumns = upgraded.all<{ name: string }>(sql`PRAGMA table_info(users)`).map((c) => c.name).sort();
    const freshColumns = fresh.all<{ name: string }>(sql`PRAGMA table_info(users)`).map((c) => c.name).sort();
    expect(upgradedColumns).toEqual(freshColumns);
  });
});
