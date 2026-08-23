import { sql } from 'drizzle-orm';
import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
