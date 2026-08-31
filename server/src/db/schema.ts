import { sql } from 'drizzle-orm';
import { blob, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Timestamp convention: all "*At" columns are stored as SQLite INTEGER epoch
 * milliseconds (`mode: 'number'`), not Drizzle's `timestamp_ms` Date mode.
 * This keeps values as plain numbers end-to-end (DB -> API JSON -> frontend)
 * without an implicit Date <-> number conversion at the ORM boundary.
 */

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  /** Enforced server-side (see `lib/authz.ts`); order is member < admin < owner. The first user
   * ever created (via `POST /api/setup/admin`, or the earliest-id user on a db migrated from v1
   * with no owner yet — see `db/index.ts`'s boot promotion) is always 'owner'. */
  role: text('role', { enum: ['owner', 'admin', 'member'] })
    .notNull()
    .default('member'),
  /** 'invited' users have a pending invite (see Task 3's `/api/users/invite`) and cannot log in
   * until they activate via `inviteToken`. */
  status: text('status', { enum: ['active', 'invited'] })
    .notNull()
    .default('active'),
  /** Single-use invite token (32 hex chars); `NULL` for already-active users. */
  inviteToken: text('invite_token').unique(),
  inviteExpiresAt: integer('invite_expires_at', { mode: 'number' }),
  /**
   * Which projects this user can see and act on (Task: per-project access).
   *  - `'all'`     — every project, present and future. The only value that ever applies to an
   *                  owner/admin (they administer the instance, so scoping them would just lock
   *                  them out of settings they're required to manage), and the DEFAULT, so every
   *                  user that existed before this column keeps exactly the access they had.
   *  - `'selected'` — only the projects listed in `project_members`. Members only.
   * Enforced server-side in `lib/projectaccess.ts`, never by the client.
   */
  projectAccess: text('project_access', { enum: ['all', 'selected'] })
    .notNull()
    .default('all'),
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .$defaultFn(() => Date.now()),
});

/**
 * Generic key/value store. `value` is always a JSON-encoded string produced
 * by `setSetting`/read by `getSetting` (see ./settings.ts). Known keys per
 * spec: base_domain, server_ip, cloudflare_token, cloudflare_zone_id,
 * github_app, notify_webhook_url, notify_on_success, acme_email.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /**
   * The host label this project is actually served at — `<subdomain>.<base_domain>` for its DNS `A`
   * record and its nginx `server_name`. `NULL` (the default, and the value on every row that
   * predates this column) means "same as the slug", so nothing changes for a project that has never
   * been moved.
   *
   * Separate from `slug` on purpose: the slug is the project's INTERNAL identity — `apps/<slug>`,
   * `logs/<slug>`, `shipway-app-<slug>.service`, `shipway-<slug>.conf`, the htpasswd file, worker
   * units — and renaming all of that on a live project is a different (and far riskier) operation
   * than moving the address it answers on. Read it through `lib/domain.ts`'s `projectHost` /
   * `projectDomain` rather than reaching for the column directly, so the fallback to `slug` is
   * applied in exactly one place.
   */
  subdomain: text('subdomain').unique(),
  repo: text('repo').notNull(), // "owner/name"
  branch: text('branch').notNull(),
  type: text('type', { enum: ['php', 'node', 'nextjs', 'static'] }).notNull(),
  phpVersion: text('php_version'),
  nodeVersion: text('node_version'),
  publicDir: text('public_dir'),
  port: integer('port'), // assigned from the 3001-3999 pool for node/nextjs
  installCmd: text('install_cmd'),
  buildCmd: text('build_cmd'),
  startCmd: text('start_cmd'),
  preDeployScript: text('pre_deploy_script'),
  postDeployScript: text('post_deploy_script'),
  sharedPaths: text('shared_paths', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  healthCheckPath: text('health_check_path'),
  autoDeploy: integer('auto_deploy', { mode: 'boolean' }).notNull().default(false),
  envEncrypted: blob('env_encrypted', { mode: 'buffer' }),
  /** How this project sends mail. `custom` and `ses` both store their (different) connection details
   * in `smtpConfigEncrypted`; `mailpit` and `none` store nothing. The column is plain TEXT with no
   * CHECK constraint, so widening this list needs no migration. */
  smtpMode: text('smtp_mode', { enum: ['mailpit', 'custom', 'ses', 'none'] })
    .notNull()
    .default('mailpit'),
  smtpConfigEncrypted: blob('smtp_config_encrypted', { mode: 'buffer' }),
  notifyWebhookUrl: text('notify_webhook_url'),
  /** Per-project HTTP basic auth on the public site (nginx `auth_basic`). `authHash` is an apr1
   * crypt string for `auth_basic_user_file` — the plaintext password is never stored, and the hash
   * is never returned by the API. Gates *access* to the site; it cannot stop a visitor who has
   * authenticated from reading the markup their own browser rendered. */
  authEnabled: integer('auth_enabled', { mode: 'boolean' }).notNull().default(false),
  authUser: text('auth_user'),
  authHash: text('auth_hash'),
  /** Git-URL source alternative to a GitHub App `repo` (Task 8): any https git URL, used verbatim
   * by the pipeline's `getCloneUrl` when set. `NULL` for GitHub-App-sourced projects. */
  repoUrl: text('repo_url'),
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const deployments = sqliteTable('deployments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  status: text('status', {
    enum: ['queued', 'running', 'success', 'failed', 'rolled_back', 'canceled'],
  }).notNull(),
  trigger: text('trigger', { enum: ['push', 'manual', 'rollback'] }).notNull(),
  /**
   * The branch this deployment actually built from, captured when it was queued (migration 0009).
   *
   * Recorded per deployment rather than read from `projects.branch` at display time, because that
   * column is the project's CURRENT setting: change it and every past deployment would retroactively
   * claim to have come from the new branch. Null for rows that predate this column, and for a
   * rollback whose target release Shipway can no longer attribute to a branch.
   */
  branch: text('branch'),
  commitSha: text('commit_sha'),
  commitMessage: text('commit_message'),
  releasePath: text('release_path'),
  logPath: text('log_path'),
  startedAt: integer('started_at', { mode: 'number' }),
  finishedAt: integer('finished_at', { mode: 'number' }),
});

/**
 * A database server Shipway can provision on: an external MySQL/Postgres (RDS, Cloud SQL, a managed
 * instance, another box) registered from the Databases page, holding the admin credentials Shipway
 * uses to create databases and roles there.
 *
 * The two engines on the host itself are deliberately NOT rows here — they come from the admin URLs
 * `install.sh` writes into settings (`mysql_admin_url` / `postgres_admin_url`), and moving them
 * would mean migrating live secrets between two stores for no gain. `services/dbconnections.ts`
 * presents both kinds as one list, which is the only place that distinction has to be understood.
 */
export const dbConnections = sqliteTable('db_connections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Display name, unique so it can be referred to unambiguously ("RDS production"). */
  name: text('name').notNull().unique(),
  engine: text('engine', { enum: ['mysql', 'postgres'] }).notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  /** The admin/superuser this connection provisions as — needs CREATE DATABASE and CREATE USER/ROLE. */
  adminUsername: text('admin_username').notNull(),
  adminPasswordEncrypted: blob('admin_password_encrypted', { mode: 'buffer' }).notNull(),
  /**
   * Connect over TLS without requiring the server's CA to be locally trusted — what a managed
   * instance (RDS and friends, which present their own CA) needs to connect at all. Stored per
   * connection because the answer differs per host, and a local socket needs it off.
   */
  tls: integer('tls', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const databases = sqliteTable('databases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  /**
   * Which connection this database lives on. NULL means the host's own engine for `engine` — the
   * only thing that existed before connections did, and still what every locally provisioned
   * database uses. `onDelete: 'restrict'` so a connection can't be unregistered out from under the
   * databases on it; the route refuses with a list of what is still there.
   */
  connectionId: integer('connection_id').references(() => dbConnections.id, { onDelete: 'restrict' }),
  engine: text('engine', { enum: ['mysql', 'postgres'] }).notNull(),
  name: text('name').notNull(),
  username: text('username').notNull(),
  passwordEncrypted: blob('password_encrypted', { mode: 'buffer' }).notNull(),
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .$defaultFn(() => Date.now()),
});

/**
 * A project's background workers. Each row becomes a systemd template unit run as `processes`
 * instances (`services/workers.ts`), so the columns below beyond `command`/`processes` map directly
 * onto systemd directives rather than being Shipway inventions:
 *  - `autoStart`  -> whether the instances are `enable`d (started on boot). Running now and starting
 *                    on boot are separate things in systemd, and this is the second one.
 *  - `restartPolicy`/`restartSec` -> `Restart=` / `RestartSec=`.
 *  - `stopTimeoutSec` -> `TimeoutStopSec=`, i.e. how long a worker gets to finish the job in hand
 *                    after SIGTERM before systemd kills it. The one setting a queue worker really
 *                    needs and the hardest to discover.
 * The defaults reproduce exactly what every worker got before these were configurable, so existing
 * rows keep their current behavior after the migration.
 */
export const workers = sqliteTable('workers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  command: text('command').notNull(),
  processes: integer('processes').notNull().default(1),
  autoStart: integer('auto_start', { mode: 'boolean' }).notNull().default(true),
  restartPolicy: text('restart_policy', { enum: ['always', 'on-failure', 'no'] })
    .notNull()
    .default('always'),
  restartSec: integer('restart_sec').notNull().default(3),
  /** systemd's own default is 90s; matching it means the migration changes nothing for existing rows. */
  stopTimeoutSec: integer('stop_timeout_sec').notNull().default(90),
  statusCached: text('status_cached'),
});

export const cronJobs = sqliteTable('cron_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  schedule: text('schedule').notNull(),
  command: text('command').notNull(),
});

/**
 * Per-project notification recipients: the email addresses a project's deploy notifications go to
 * (migration 0005). Notifications are a PROJECT feature — the instance-wide
 * `notification_channels`/`notification_subscriptions` tables this replaces are dropped by that
 * migration, along with their webhook/Teams delivery types. Email is the only delivery mechanism,
 * routed through instance mail (`services/mailer.ts`), so a project with recipients but no instance
 * mail configured simply sends nothing (logged, never thrown — see `services/notifybus.ts`).
 *
 * Deleting a project takes its recipients with it (`ON DELETE CASCADE`), and one address can appear
 * at most once per project.
 */
export const projectNotificationRecipients = sqliteTable(
  'project_notification_recipients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    createdAt: integer('created_at', { mode: 'number' })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [uniqueIndex('project_notification_recipients_project_email_unique').on(table.projectId, table.email)],
);

/** Which deploy events a project emails its recipients about (migration 0005). A row present means
 * "subscribed"; absent means "don't send". Scoped per project rather than per recipient — everyone
 * on a project's list gets the same events, which is the whole granularity the UI offers. */
export const projectNotificationEvents = sqliteTable(
  'project_notification_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
  },
  (table) => [uniqueIndex('project_notification_events_project_event_unique').on(table.projectId, table.event)],
);

/**
 * Which projects a `projectAccess: 'selected'` user may see and act on. A row is a grant; no row is
 * no access. Rows exist only for scoped members — a `projectAccess: 'all'` user is never listed
 * here, so this table is empty on an instance that has never scoped anyone.
 *
 * Both sides cascade: deleting a project drops its grants (nobody is left pointing at a project that
 * no longer exists), and deleting a user drops theirs. Grants are inserted at INVITE time, against
 * the pending `status: 'invited'` row, so the access is already in place the moment the invitee
 * activates rather than needing a second admin step afterwards.
 */
export const projectMembers = sqliteTable(
  'project_members',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'number' })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [
    uniqueIndex('project_members_project_user_unique').on(table.projectId, table.userId),
    index('project_members_user_idx').on(table.userId),
  ],
);

/**
 * Every mutating API action records one row here (see `services/audit.ts`'s `recordAudit`).
 * `actorId` is set null (not cascade-deleted) if the acting user is later removed, so the audit
 * trail survives user deletion; `actorName` is captured at write time so the row stays meaningful
 * even then. `meta` is an opaque JSON-encoded string (e.g. changed setting keys — never values).
 */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actorId: integer('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorName: text('actor_name').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetName: text('target_name').notNull(),
    meta: text('meta'),
    createdAt: integer('created_at', { mode: 'number' })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [index('audit_events_created_at_idx').on(table.createdAt), index('audit_events_action_idx').on(table.action)],
);
