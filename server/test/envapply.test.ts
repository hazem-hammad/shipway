/**
 * `services/envapply.ts`'s SQLite fallback: a php project with NO database gets a working
 * `DB_CONNECTION=sqlite` setup rather than an env that fails `php artisan migrate --force` on its
 * first deploy.
 *
 * Two things have to hold, and both are easy to get wrong:
 *  - the file lives in the project's SHARED directory, so rotating releases doesn't delete the data;
 *  - the file EXISTS before the build runs, because SQLite refuses to open a path that isn't there.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { databases, projects } from '../src/db/schema.js';
import { loadConfig, type Config } from '../src/config.js';
import { SecretBox } from '../src/lib/secretbox.js';
import { DevSysOps } from '../src/sysops/dev.js';
import { renderProjectEnv, sqliteFallbackPath, writeSharedEnv } from '../src/services/envapply.js';

/** `cfg.appsDir` is shared across test configs, so every harness needs its own slug or one test's
 * SQLite file shows up in the next one's assertions. */
let slugCounter = 0;

function harness(type: 'php' | 'node' = 'php') {
  slugCounter += 1;
  const slug = `shop${String(slugCounter)}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-envapply-test-'));
  const cfg: Config = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: dataDir });
  const db: ShipwayDb = openDb(cfg.dbPath);
  const secretBox = SecretBox.load(path.join(dataDir, 'secret.key'));

  db.insert(projects)
    .values({ name: slug, slug, repo: `acme/${slug}`, branch: 'main', type, phpVersion: type === 'php' ? '8.3' : null, sharedPaths: [], smtpMode: 'none' })
    .run();
  const project = db.select().from(projects).where(eq(projects.slug, slug)).get()!;

  return { cfg, db, secretBox, project, slug, deps: { cfg, db, secretBox, sysops: new DevSysOps(path.join(dataDir, 'sysops')) } };
}

function attachDatabase(db: ShipwayDb, projectId: number): void {
  db.insert(databases).values({ projectId, engine: 'mysql', name: 'shop', username: 'shop', passwordEncrypted: Buffer.from('x') }).run();
}

describe('sqliteFallbackPath', () => {
  it('points a database-less php project at a file in its shared directory', () => {
    const h = harness('php');
    expect(sqliteFallbackPath(h, h.project)).toBe(`${h.cfg.appsDir}/${h.slug}/shared/database.sqlite`);
  });

  it('is undefined once a real database is attached, with nothing to undo by hand', () => {
    const h = harness('php');
    attachDatabase(h.db, h.project.id);
    expect(sqliteFallbackPath(h, h.project)).toBeUndefined();
  });

  it('is undefined for a non-php project', () => {
    const h = harness('node');
    expect(sqliteFallbackPath(h, h.project)).toBeUndefined();
  });
});

describe('renderProjectEnv', () => {
  it('writes the managed DB_DATABASE for a database-less php project', () => {
    const h = harness('php');
    expect(renderProjectEnv(h, h.project)).toContain(`DB_DATABASE=${h.cfg.appsDir}/${h.slug}/shared/database.sqlite`);
  });

  it('writes no DB_DATABASE once the project has a database of its own', () => {
    const h = harness('php');
    attachDatabase(h.db, h.project.id);
    expect(renderProjectEnv(h, h.project)).not.toContain('database.sqlite');
  });

  it('yields to a user-defined DB_DATABASE', () => {
    const h = harness('php');
    h.db.update(projects).set({ envEncrypted: h.secretBox.encrypt('DB_CONNECTION=mysql\nDB_DATABASE=shop\n') }).where(eq(projects.id, h.project.id)).run();
    const project = h.db.select().from(projects).where(eq(projects.id, h.project.id)).get()!;

    const env = renderProjectEnv(h, project);
    expect(env).toContain('DB_DATABASE=shop');
    expect(env).not.toContain('database.sqlite');
  });
});

describe('writeSharedEnv', () => {
  it('creates the SQLite file, since SQLite will not open a path that does not exist', () => {
    const h = harness('php');
    const expected = `${h.cfg.appsDir}/${h.slug}/shared/database.sqlite`;

    writeSharedEnv(h.deps, h.project);

    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.readFileSync(expected, 'utf8')).toBe('');
  });

  it('never truncates an existing file — that is the project\'s data', () => {
    const h = harness('php');
    const expected = `${h.cfg.appsDir}/${h.slug}/shared/database.sqlite`;
    writeSharedEnv(h.deps, h.project);
    fs.writeFileSync(expected, 'PRETEND SQLITE CONTENTS');

    writeSharedEnv(h.deps, h.project); // a second deploy

    expect(fs.readFileSync(expected, 'utf8')).toBe('PRETEND SQLITE CONTENTS');
  });

  it('creates nothing for a project with a real database', () => {
    const h = harness('php');
    attachDatabase(h.db, h.project.id);

    writeSharedEnv(h.deps, h.project);

    expect(fs.existsSync(`${h.cfg.appsDir}/${h.slug}/shared/database.sqlite`)).toBe(false);
  });
});
