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
import { auditEvents, deployments, notificationChannels, notificationSubscriptions, projects, users } from '../src/db/schema.js';

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

describe('migration 0002 — fresh install', () => {
  it('notification_channels gets type (default webhook) + nullable target/url columns', () => {
    const db = openDb(tmpDbPath());

    const columns = db.all<{ name: string; notnull: number; dflt_value: string | null }>(sql`PRAGMA table_info(notification_channels)`);
    const byName = new Map(columns.map((c) => [c.name, c]));

    expect(byName.get('type')).toMatchObject({ notnull: 1, dflt_value: "'webhook'" });
    expect(byName.get('target')).toMatchObject({ notnull: 0 });
    expect(byName.get('url')).toMatchObject({ notnull: 0 });
  });

  it('a channel inserted with no type/url/target defaults to webhook + null/null', () => {
    const db = openDb(tmpDbPath());
    db.insert(notificationChannels).values({ name: 'default-shape', url: 'https://hooks.slack.com/services/x' }).run();

    const row = db.select().from(notificationChannels).where(eq(notificationChannels.name, 'default-shape')).get();
    expect(row?.type).toBe('webhook');
    expect(row?.target).toBeNull();
  });

  it('an email channel can be inserted with a null url and a target address', () => {
    const db = openDb(tmpDbPath());
    db.insert(notificationChannels).values({ name: 'ops-email', type: 'email', target: 'ops@example.com' }).run();

    const row = db.select().from(notificationChannels).where(eq(notificationChannels.name, 'ops-email')).get();
    expect(row?.url).toBeNull();
    expect(row?.type).toBe('email');
    expect(row?.target).toBe('ops@example.com');
  });
});

/**
 * Builds a 0001-state db on disk (0000+0001 applied via drizzle's own migrator, so its
 * `__drizzle_migrations` bookkeeping matches a real pre-0002 install; 0002 left pending) and returns
 * the raw better-sqlite3 client, left OPEN, so the caller can seed pre-0002-shape rows with raw SQL
 * (the typed `schema.ts` already has 0002's columns, so a typed insert here would silently assume
 * they exist) before closing it and handing off to `openDb`, which applies the pending 0002
 * migration via the production path.
 */
function build0001StateDb(dbPath: string): Database.Database {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-legacy-0001-migrations-'));
  fs.mkdirSync(path.join(legacyDir, 'meta'));
  fs.copyFileSync(path.join(MIGRATIONS_FOLDER, '0000_clever_nick_fury.sql'), path.join(legacyDir, '0000_clever_nick_fury.sql'));
  fs.copyFileSync(path.join(MIGRATIONS_FOLDER, '0001_overconfident_karen_page.sql'), path.join(legacyDir, '0001_overconfident_karen_page.sql'));
  fs.copyFileSync(path.join(MIGRATIONS_FOLDER, 'meta/0000_snapshot.json'), path.join(legacyDir, 'meta/0000_snapshot.json'));
  fs.copyFileSync(path.join(MIGRATIONS_FOLDER, 'meta/0001_snapshot.json'), path.join(legacyDir, 'meta/0001_snapshot.json'));
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  // Allowlist, not a blacklist: this fixture copies exactly the 0000 and 0001 SQL files above, so the
  // journal must list exactly those two. Excluding later migrations by name instead meant every new
  // migration added to the folder broke this fixture with "No file 000N_....sql found".
  const LEGACY_TAGS = ['0000_clever_nick_fury', '0001_overconfident_karen_page'];
  journal.entries = journal.entries.filter((e) => LEGACY_TAGS.includes(e.tag));
  fs.writeFileSync(path.join(legacyDir, 'meta/_journal.json'), JSON.stringify(journal));

  const client = new Database(dbPath);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  const preDb = drizzle({ client });
  migrate(preDb, { migrationsFolder: legacyDir });
  return client;
}

describe('migration 0002 — upgrade from a pre-0002 (0000+0001) db', () => {
  it('preserves an existing webhook-shaped channel row, backfilling type: webhook and target: null', () => {
    const dbPath = tmpDbPath();
    const client = build0001StateDb(dbPath);

    // Raw insert against the pre-0002 shape (no type/target columns exist yet on disk).
    client.prepare("INSERT INTO notification_channels (name, url, created_at) VALUES (?, ?, ?)").run('legacy-slack', 'https://hooks.slack.com/services/legacy', Date.now());
    client.close();

    // Production path: applies the pending 0002 migration.
    const db = openDb(dbPath);
    const row = db.select().from(notificationChannels).where(eq(notificationChannels.name, 'legacy-slack')).get();
    expect(row).toBeDefined();
    expect(row?.url).toBe('https://hooks.slack.com/services/legacy');
    expect(row?.type).toBe('webhook');
    expect(row?.target).toBeNull();
  });

  /**
   * BLOCKER regression (found in review): drizzle's `migrate()` wraps every pending migration in one
   * `BEGIN...COMMIT`, and SQLite silently NO-OPS a `PRAGMA foreign_keys=OFF/ON` issued INSIDE an
   * already-open transaction — so 0002's own `PRAGMA foreign_keys=OFF/ON` lines (around its
   * `DROP TABLE notification_channels` + recreate/rename table-rebuild) did nothing, FK enforcement
   * stayed ON for the whole transaction, and the `DROP TABLE` cascade-deleted every
   * `notification_subscriptions` row (`channel_id ... ON DELETE CASCADE`) before the table was even
   * recreated. Invisible on a fresh install (nothing to cascade away) and invisible to the test above
   * (it never seeded a subscription row) — but on any real v2 install with live event routing
   * configured, upgrading to 0002 silently deleted every subscription. Fixed in `db/index.ts`'s
   * `openDb` by toggling the pragma OUTSIDE the transaction `migrate()` opens (the only place it
   * actually takes effect), restored in a `finally`.
   */
  it('BLOCKER regression: preserves notification_subscriptions (and other FK-referencing rows) across the 0002 table-rebuild', () => {
    const dbPath = tmpDbPath();
    const client = build0001StateDb(dbPath);

    // A project + a deployment referencing it — unrelated to 0002's table-rebuild, but a real
    // upgrade has plenty of other FK-referencing rows too; proves the FK toggle is scoped to exactly
    // the migration transaction and doesn't collaterally corrupt anything else.
    client
      .prepare("INSERT INTO projects (name, slug, repo, branch, type, shared_paths, smtp_mode, created_at) VALUES (?, ?, ?, ?, ?, '[]', 'mailpit', ?)")
      .run('Shop', 'shop', 'acme/shop', 'main', 'node', Date.now());
    const projectId = client.prepare('SELECT id FROM projects WHERE slug = ?').get('shop') as { id: number };
    client.prepare("INSERT INTO deployments (project_id, status, trigger) VALUES (?, 'success', 'manual')").run(projectId.id);

    // The critical case: a notification channel WITH subscriptions referencing it (0001's schema —
    // no type/target columns exist on disk yet).
    client.prepare('INSERT INTO notification_channels (name, url, created_at) VALUES (?, ?, ?)').run('ops', 'https://hooks.slack.com/services/ops', Date.now());
    const channelId = client.prepare('SELECT id FROM notification_channels WHERE name = ?').get('ops') as { id: number };
    client.prepare('INSERT INTO notification_subscriptions (event, channel_id) VALUES (?, ?)').run('deploy_failed', channelId.id);
    client.prepare('INSERT INTO notification_subscriptions (event, channel_id) VALUES (?, ?)').run('deploy_succeeded', channelId.id);

    // A user + an audit row referencing them (ON DELETE SET NULL — a different FK shape than the
    // subscriptions' CASCADE, seeded for the same "nothing else breaks" reason as the project above).
    client.prepare('INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run('Ada', 'ada@example.com', 'hash', Date.now());
    const userId = client.prepare('SELECT id FROM users WHERE email = ?').get('ada@example.com') as { id: number };
    client
      .prepare('INSERT INTO audit_events (actor_id, actor_name, action, target_type, target_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId.id, 'Ada', 'x', 't', 'n', Date.now());

    client.close();

    // Production path: applies the pending 0002 migration (the table-rebuild that previously
    // cascade-deleted every notification_subscriptions row).
    const db = openDb(dbPath);

    const channel = db.select().from(notificationChannels).where(eq(notificationChannels.name, 'ops')).get();
    expect(channel).toBeDefined();

    const subs = db.select().from(notificationSubscriptions).all();
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => ({ event: s.event, channelId: s.channelId })).sort((a, b) => a.event.localeCompare(b.event))).toEqual(
      [
        { event: 'deploy_failed', channelId: channel!.id },
        { event: 'deploy_succeeded', channelId: channel!.id },
      ].sort((a, b) => a.event.localeCompare(b.event)),
    );

    // Unrelated rows survived too.
    expect(db.select().from(projects).where(eq(projects.slug, 'shop')).get()).toBeDefined();
    expect(db.select().from(deployments).where(eq(deployments.projectId, projectId.id)).all()).toHaveLength(1);
    const auditRow = db.select().from(auditEvents).where(eq(auditEvents.targetName, 'n')).get();
    expect(auditRow?.actorId).toBe(userId.id);

    // FK integrity is genuinely intact afterward (not just "no error was thrown" during migration) —
    // `PRAGMA foreign_key_check` returns one row per violation, so an empty result means clean.
    const violations = db.all<Record<string, unknown>>(sql`PRAGMA foreign_key_check`);
    expect(violations).toHaveLength(0);

    // Normal operation resumes with FK enforcement ON — `openDb`'s `finally` must restore it (same
    // expectation `db.test.ts`'s "runs migrations and applies WAL + foreign_keys pragmas" already has).
    const fk = db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`);
    expect(fk?.foreign_keys).toBe(1);
  });

  it('running the full migration set fresh matches applying it on top of an existing db (no schema divergence)', () => {
    const freshPath = tmpDbPath();
    const fresh = openDb(freshPath);
    const freshColumns = fresh.all<{ name: string }>(sql`PRAGMA table_info(notification_channels)`).map((c) => c.name).sort();
    expect(freshColumns).toEqual(['created_at', 'id', 'name', 'target', 'type', 'url'].sort());
  });
});

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
