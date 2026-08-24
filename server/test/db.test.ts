import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { openDb } from '../src/db/index.js';
import { cronJobs, databases, deployments, projects, users, workers } from '../src/db/schema.js';
import { getSetting, setSetting } from '../src/db/settings.js';

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-db-test-'));
  return path.join(dir, 'shipway.db');
}

const fullProject = {
  name: 'My App',
  slug: 'my-app',
  repo: 'acme/my-app',
  branch: 'main',
  type: 'node' as const,
  phpVersion: null,
  nodeVersion: '20',
  publicDir: null,
  port: 3001,
  installCmd: 'npm install',
  buildCmd: 'npm run build',
  startCmd: 'npm start',
  preDeployScript: 'echo pre',
  postDeployScript: 'echo post',
  sharedPaths: ['storage', 'public/uploads'],
  healthCheckPath: '/health',
  autoDeploy: true,
  envEncrypted: Buffer.from('encrypted-env-bytes'),
  smtpMode: 'mailpit' as const,
  smtpConfigEncrypted: Buffer.from('encrypted-smtp-bytes'),
  notifyWebhookUrl: 'https://example.com/hook',
};

describe('openDb', () => {
  it('runs migrations and applies WAL + foreign_keys pragmas', () => {
    const db = openDb(tmpDbPath());

    const journalMode = db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`);
    expect(journalMode?.journal_mode).toBe('wal');

    const fk = db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`);
    expect(fk?.foreign_keys).toBe(1);

    const tableNames = new Set(
      db
        .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .map((row) => row.name),
    );
    for (const table of ['users', 'settings', 'projects', 'deployments', 'databases', 'workers', 'cron_jobs']) {
      expect(tableNames.has(table)).toBe(true);
    }
  });

  it('inserts a user and reads it back', () => {
    const db = openDb(tmpDbPath());

    db.insert(users).values({ name: 'Ada Lovelace', email: 'ada@example.com', passwordHash: 'argon2-hash' }).run();
    const row = db.select().from(users).where(eq(users.email, 'ada@example.com')).get();

    expect(row).toBeDefined();
    expect(row?.name).toBe('Ada Lovelace');
    expect(row?.email).toBe('ada@example.com');
    expect(row?.passwordHash).toBe('argon2-hash');
    expect(typeof row?.id).toBe('number');
    expect(typeof row?.createdAt).toBe('number');
  });

  it('inserts a project with all fields and reads it back exactly', () => {
    const db = openDb(tmpDbPath());

    db.insert(projects).values(fullProject).run();
    const row = db.select().from(projects).where(eq(projects.slug, 'my-app')).get();

    expect(row).toBeDefined();
    expect(row?.name).toBe(fullProject.name);
    expect(row?.slug).toBe(fullProject.slug);
    expect(row?.repo).toBe(fullProject.repo);
    expect(row?.branch).toBe(fullProject.branch);
    expect(row?.type).toBe(fullProject.type);
    expect(row?.phpVersion).toBeNull();
    expect(row?.nodeVersion).toBe(fullProject.nodeVersion);
    expect(row?.publicDir).toBeNull();
    expect(row?.port).toBe(fullProject.port);
    expect(row?.installCmd).toBe(fullProject.installCmd);
    expect(row?.buildCmd).toBe(fullProject.buildCmd);
    expect(row?.startCmd).toBe(fullProject.startCmd);
    expect(row?.preDeployScript).toBe(fullProject.preDeployScript);
    expect(row?.postDeployScript).toBe(fullProject.postDeployScript);
    expect(row?.sharedPaths).toEqual(fullProject.sharedPaths);
    expect(row?.healthCheckPath).toBe(fullProject.healthCheckPath);
    expect(row?.autoDeploy).toBe(true);
    expect(row?.envEncrypted).toBeInstanceOf(Buffer);
    expect((row?.envEncrypted as Buffer).equals(fullProject.envEncrypted)).toBe(true);
    expect(row?.smtpMode).toBe(fullProject.smtpMode);
    expect(row?.smtpConfigEncrypted).toBeInstanceOf(Buffer);
    expect((row?.smtpConfigEncrypted as Buffer).equals(fullProject.smtpConfigEncrypted)).toBe(true);
    expect(row?.notifyWebhookUrl).toBe(fullProject.notifyWebhookUrl);
    expect(typeof row?.createdAt).toBe('number');
  });

  it('allows nullable BLOB/text fields to be omitted', () => {
    const db = openDb(tmpDbPath());

    db.insert(projects)
      .values({
        name: 'Static Site',
        slug: 'static-site',
        repo: 'acme/static-site',
        branch: 'main',
        type: 'static',
        smtpMode: 'none',
      })
      .run();

    const row = db.select().from(projects).where(eq(projects.slug, 'static-site')).get();
    expect(row?.envEncrypted).toBeNull();
    expect(row?.smtpConfigEncrypted).toBeNull();
    expect(row?.healthCheckPath).toBeNull();
    expect(row?.sharedPaths).toEqual([]);
    expect(row?.autoDeploy).toBe(false);
  });

  it('throws on duplicate projects.slug (unique constraint)', () => {
    const db = openDb(tmpDbPath());

    db.insert(projects).values(fullProject).run();
    expect(() => db.insert(projects).values({ ...fullProject, name: 'Dupe' }).run()).toThrow();
  });

  it('setSetting/getSetting round-trips an object', () => {
    const db = openDb(tmpDbPath());

    setSetting(db, 'github_app', { id: 123, slug: 'shipway-bot', privateKey: 'pem', installationId: 456 });
    const value = getSetting<{ id: number; slug: string; privateKey: string; installationId: number }>(
      db,
      'github_app',
    );

    expect(value).toEqual({ id: 123, slug: 'shipway-bot', privateKey: 'pem', installationId: 456 });
  });

  it('setSetting overwrites an existing key rather than duplicating it', () => {
    const db = openDb(tmpDbPath());

    setSetting(db, 'base_domain', 'v1.example.com');
    setSetting(db, 'base_domain', 'v2.example.com');

    expect(getSetting<string>(db, 'base_domain')).toBe('v2.example.com');
    const count = db.get<{ n: number }>(sql`SELECT COUNT(*) as n FROM settings WHERE key = 'base_domain'`);
    expect(count?.n).toBe(1);
  });

  it('getSetting returns null for a missing key', () => {
    const db = openDb(tmpDbPath());
    expect(getSetting(db, 'does-not-exist')).toBeNull();
  });

  it('inserts a deployment tied to a project and reads it back', () => {
    const db = openDb(tmpDbPath());
    db.insert(projects).values(fullProject).run();
    const project = db.select().from(projects).where(eq(projects.slug, 'my-app')).get()!;

    db.insert(deployments)
      .values({
        projectId: project.id,
        status: 'queued',
        trigger: 'push',
        commitSha: 'abc123',
        commitMessage: 'Initial commit',
      })
      .run();

    const row = db.select().from(deployments).where(eq(deployments.projectId, project.id)).get();
    expect(row?.status).toBe('queued');
    expect(row?.trigger).toBe('push');
    expect(row?.commitSha).toBe('abc123');
    expect(row?.commitMessage).toBe('Initial commit');
    expect(row?.startedAt).toBeNull();
    expect(row?.finishedAt).toBeNull();
  });

  it('rejects a deployment referencing a nonexistent project (foreign_keys enforced)', () => {
    const db = openDb(tmpDbPath());
    expect(() =>
      db
        .insert(deployments)
        .values({ projectId: 999999, status: 'queued', trigger: 'manual' })
        .run(),
    ).toThrow();
  });

  it('inserts a database record, a worker, and a cron job tied to a project', () => {
    const db = openDb(tmpDbPath());
    db.insert(projects).values(fullProject).run();
    const project = db.select().from(projects).where(eq(projects.slug, 'my-app')).get()!;

    db.insert(databases)
      .values({
        projectId: project.id,
        engine: 'mysql',
        name: 'my_app_db',
        username: 'my_app_user',
        passwordEncrypted: Buffer.from('db-secret'),
      })
      .run();
    const dbRow = db.select().from(databases).where(eq(databases.projectId, project.id)).get();
    expect(dbRow?.engine).toBe('mysql');
    expect((dbRow?.passwordEncrypted as Buffer).equals(Buffer.from('db-secret'))).toBe(true);

    db.insert(workers)
      .values({ projectId: project.id, name: 'queue-worker', command: 'php artisan queue:work', processes: 2 })
      .run();
    const workerRow = db.select().from(workers).where(eq(workers.projectId, project.id)).get();
    expect(workerRow?.name).toBe('queue-worker');
    expect(workerRow?.processes).toBe(2);

    db.insert(cronJobs)
      .values({ projectId: project.id, schedule: '* * * * *', command: 'php artisan schedule:run' })
      .run();
    const cronRow = db.select().from(cronJobs).where(eq(cronJobs.projectId, project.id)).get();
    expect(cronRow?.schedule).toBe('* * * * *');
    expect(cronRow?.command).toBe('php artisan schedule:run');
  });
});
