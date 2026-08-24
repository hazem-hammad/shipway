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
  smtpMode: text('smtp_mode', { enum: ['mailpit', 'custom', 'none'] })
    .notNull()
    .default('mailpit'),
  smtpConfigEncrypted: blob('smtp_config_encrypted', { mode: 'buffer' }),
  notifyWebhookUrl: text('notify_webhook_url'),
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
  commitSha: text('commit_sha'),
  commitMessage: text('commit_message'),
  releasePath: text('release_path'),
  logPath: text('log_path'),
  startedAt: integer('started_at', { mode: 'number' }),
  finishedAt: integer('finished_at', { mode: 'number' }),
});

export const databases = sqliteTable('databases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  engine: text('engine', { enum: ['mysql', 'postgres'] }).notNull(),
  name: text('name').notNull(),
  username: text('username').notNull(),
  passwordEncrypted: blob('password_encrypted', { mode: 'buffer' }).notNull(),
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const workers = sqliteTable('workers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  command: text('command').notNull(),
  processes: integer('processes').notNull().default(1),
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

/** Named notification delivery targets. `type` picks the delivery mechanism (migration 0002, plan
 * Task 4): `'webhook'` (default; Slack-compatible/Discord/Telegram auto-detected by
 * `services/notify.ts`'s formatter, and Microsoft Teams auto-detected the same way from a
 * `webhook.office.com`/`logic.azure.com` URL even without an explicit `type: 'teams'`), `'teams'`
 * (explicit — always formatted as a Teams MessageCard regardless of URL), or `'email'` (routes
 * through instance mail to `target` instead of posting to `url`). `url` is nullable so an email
 * channel can leave it unset; `target` is the email address for `type: 'email'` channels, null for
 * everything else. Existing pre-migration rows read back as `type: 'webhook'` with their `url`
 * untouched — see `drizzle/0002_*.sql`. */
export const notificationChannels = sqliteTable('notification_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  url: text('url'),
  type: text('type', { enum: ['webhook', 'teams', 'email'] })
    .notNull()
    .default('webhook'),
  target: text('target'),
  createdAt: integer('created_at', { mode: 'number' })
    .notNull()
    .$defaultFn(() => Date.now()),
});

/** Per-event opt-in for a channel (Task 4's notification matrix); a given (event, channelId) pair
 * is subscribed at most once. */
export const notificationSubscriptions = sqliteTable(
  'notification_subscriptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    event: text('event').notNull(),
    channelId: integer('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
  },
  (table) => [uniqueIndex('notification_subscriptions_event_channel_id_unique').on(table.event, table.channelId)],
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
