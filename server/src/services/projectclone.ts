/**
 * Clones a project: a second project, on its own subdomain, configured identically to the first and
 * pointed at its own copy of the first's data.
 *
 * What "identically" covers is spelled out by `COPIED_COLUMNS` below and by the steps in
 * `cloneProject` — the project row's build/runtime settings, its env, its workers, its cron entries,
 * its mail config and notification recipients, and the contents of its `shared/` directory. What it
 * deliberately does NOT cover is history: deployments, releases and the audit trail belong to the
 * project that actually ran them, and a clone has run nothing yet.
 *
 * The database is the part that makes this more than "New Project with the fields pre-filled": each
 * database linked to the source is recreated under a name the caller chooses, on the same server,
 * and the source's contents are dumped into it (`DbAdmin.dumpSql`/`importSql`). The clone's env is
 * then rewritten to point at those copies.
 *
 * That rewrite is the single most important thing in this file. A clone whose `DB_*` still named the
 * source's database would be a second app writing to the first one's production data — so a failure
 * anywhere in the database step tears the whole clone down (`deprovisionProject`) rather than
 * leaving a project behind that is one deploy away from doing exactly that. There is no partial
 * clone: it either exists with its own database, or it does not exist.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import { and, isNull } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { ShipwayDb } from '../db/index.js';
import { cronJobs, databases, projectNotificationEvents, projectNotificationRecipients, projects, workers } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import { upsertEnvVars } from '../deploy/laravel.js';
import { projectDomain } from '../lib/domain.js';
import type { SecretBox } from '../lib/secretbox.js';
import type { SysOps } from '../sysops/types.js';
import { allocatePort } from '../system/ports.js';
import type { DnsClient } from './cloudflare.js';
import { syncCrontab } from './cron.js';
import { adminUrl, connectionForDatabase, type ResolvedConnection } from './dbconnections.js';
import { connectionEnv, generateDbPassword, isReservedDbName, IDENTIFIER_RE, type DbAdmin, type DbEngine } from './dbprovision.js';
import { deprovisionProject, provisionProject, ProvisionError, type DnsOutcome, type ProvisionDeps } from './provisioner.js';
import { applyWorker } from './workers.js';

export interface CloneDeps extends ProvisionDeps {
  db: ShipwayDb;
  cfg: Config;
  sysops: SysOps;
  dns: DnsClient | null;
  /** Required here, unlike on `ProvisionDeps`: copying a database is the point of this operation. */
  dbAdmin: DbAdmin;
  secretBox: SecretBox;
}

type ProjectRow = typeof projects.$inferSelect;
type DatabaseRow = typeof databases.$inferSelect;

/** One database to copy: which of the source's databases, and what to call the copy. */
export interface CloneDatabaseInput {
  sourceId: number;
  name: string;
}

export interface CloneInput {
  name: string;
  slug: string;
  /** One entry per database of the source's that should be copied. An empty list copies none. */
  databases: CloneDatabaseInput[];
}

export interface ClonedDatabase {
  sourceName: string;
  name: string;
  engine: DbEngine;
  connectionName: string;
  /** True for the one whose credentials were written into the clone's `DB_*` vars. */
  usedInEnv: boolean;
}

export interface CloneResult {
  project: ProjectRow;
  dns: DnsOutcome;
  databases: ClonedDatabase[];
  workers: number;
  cronJobs: number;
  /** Whether the source's `shared/` directory (uploads, storage) was copied. `null` if there was
   *  nothing to copy; `false` if the copy was attempted and failed — see `copySharedFiles`. */
  sharedFilesCopied: boolean | null;
}

/**
 * Thrown by every failure path here. `step` says which stage failed so the route can pick a status
 * code rather than flattening everything into a 500: the validation steps are the caller's mistake
 * (404/409), and everything after them is the host's or a database server's (502).
 */
export class CloneError extends Error {
  constructor(
    public readonly step: 'source' | 'slug' | 'database' | 'provision' | 'copy',
    message: string,
  ) {
    super(message);
    this.name = 'CloneError';
  }
}

/**
 * The project columns a clone inherits verbatim. Everything absent from this list is either
 * identity (`id`, `name`, `slug`, `createdAt`), allocated fresh (`port`), or copied by a later step
 * that has to do more than assign it (`envEncrypted`).
 *
 * Written as an explicit list rather than a spread-minus-omissions so that a column added to
 * `projects` later is NOT silently inherited: a new setting has to be considered here, which is the
 * safer default for a feature whose whole risk is copying something it shouldn't.
 */
const COPIED_COLUMNS = [
  'repo',
  'repoUrl',
  'branch',
  'type',
  'phpVersion',
  'nodeVersion',
  'publicDir',
  'installCmd',
  'buildCmd',
  'startCmd',
  'preDeployScript',
  'postDeployScript',
  'sharedPaths',
  'healthCheckPath',
  'autoDeploy',
  'smtpMode',
  'smtpConfigEncrypted',
  'notifyWebhookUrl',
  // Basic auth comes across whole, hash included: it protects the same site under a second name, and
  // a clone that silently dropped its password protection would be a staging copy of a protected app
  // sitting open on a guessable subdomain.
  'authEnabled',
  'authUser',
  'authHash',
] as const satisfies readonly (keyof ProjectRow)[];

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNodeLike(type: ProjectRow['type']): boolean {
  return type === 'node' || type === 'nextjs';
}

/**
 * Matches one `KEY=value` assignment, capturing the assignment prefix and the raw value separately
 * so a rewrite can replace the value and leave the key, its spacing and any inline formatting alone.
 */
const ENV_ASSIGNMENT_RE = /^(\s*[A-Za-z_][A-Za-z0-9_]*\s*=)(.*)$/;

/** Strips one matching pair of surrounding quotes, returning the bare value and the quote used. */
function unquote(raw: string): { value: string; quote: string } {
  const trimmed = raw.trim();
  const quote = trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'")) && trimmed.endsWith(trimmed[0]!) ? trimmed[0]! : '';
  return { value: quote === '' ? trimmed : trimmed.slice(1, -1), quote };
}

/**
 * Rewrites env values that are EXACTLY one of `replacements`' keys, leaving every other line — and
 * every value that merely contains one — untouched.
 *
 * Exact-match rather than a global search-and-replace on purpose: the values being replaced are a
 * database's name, user and password, and a name like `app` or `shop` would otherwise be rewritten
 * inside `APP_NAME`, a URL, or a queue prefix that has nothing to do with the database. What this
 * does catch is the case that matters — a second copy of the source's credentials under keys that
 * aren't `DB_*` (a read replica, a reporting connection), which would otherwise leave the clone
 * quietly talking to the original's database.
 */
export function rewriteEnvValues(envText: string, replacements: Map<string, string>): string {
  return envText
    .split('\n')
    .map((line) => {
      const match = ENV_ASSIGNMENT_RE.exec(line);
      if (!match) return line;
      const { value, quote } = unquote(match[2]!);
      const replacement = replacements.get(value);
      if (replacement === undefined || value === '') return line;
      return `${match[1]!}${quote}${replacement}${quote}`;
    })
    .join('\n');
}

/**
 * Points every mention of the source's own domain at the clone's. A full `<slug>.<base-domain>` is
 * specific enough to replace as a substring: it is the project's address, so `APP_URL`,
 * `SANCTUM_STATEFUL_DOMAINS`, `SESSION_DOMAIN` and any hard-coded link in the env all move together.
 */
export function rewriteEnvDomain(envText: string, fromDomain: string, toDomain: string): string {
  if (fromDomain === toDomain) return envText;
  return envText.split(fromDomain).join(toDomain);
}

/**
 * Copies the source's `shared/` tree (a Laravel app's `storage`, an uploads directory — whatever its
 * `sharedPaths` symlink into each release) into the clone's app directory.
 *
 * `.env` is excluded: the clone writes its own from the env this service just rewrote, and copying
 * the source's would put the original's database credentials on disk under the clone's name until
 * the first deploy overwrote them.
 *
 * Best-effort, and reported rather than thrown: unlike the database, a missing uploads directory
 * makes a clone incomplete, not dangerous — and a project with gigabytes of user uploads should not
 * lose an otherwise-finished clone to a copy that ran out of disk.
 */
function copySharedFiles(cfg: Config, fromSlug: string, toSlug: string): boolean | null {
  const source = path.join(cfg.appsDir, fromSlug, 'shared');
  if (!fs.existsSync(source) || fs.readdirSync(source).length === 0) {
    return null;
  }
  try {
    fs.cpSync(source, path.join(cfg.appsDir, toSlug, 'shared'), {
      recursive: true,
      force: true,
      filter: (src) => path.basename(src) !== '.env',
    });
    return true;
  } catch (err) {
    console.error(`shipway: could not copy shared files from ${fromSlug} to ${toSlug}: ${errMessage(err)}`);
    return false;
  }
}

/** The admin target for acting on one database AS ITSELF — what `dumpSql`/`importSql` both want. */
function ownerTarget(connection: ResolvedConnection, engine: DbEngine, username: string, password: string) {
  return {
    engine,
    url: adminUrl(engine, connection.endpoint.host, connection.endpoint.port, username, password),
    tls: connection.target.tls,
  };
}

/**
 * Resolves each requested copy against the source's actual databases and checks the new names, all
 * before anything is created. Throws `CloneError('database')` on the first problem, which is the
 * caller's to fix — so it happens here, while there is still nothing to tear down.
 */
function planDatabaseCopies(
  deps: CloneDeps,
  sourceId: number,
  requests: CloneDatabaseInput[],
): { source: DatabaseRow; connection: ResolvedConnection; name: string }[] {
  const owned = deps.db.select().from(databases).where(eq(databases.projectId, sourceId)).all();
  const seen = new Set<string>();

  return requests.map((request) => {
    const source = owned.find((row) => row.id === request.sourceId);
    if (!source) {
      throw new CloneError('database', 'that database does not belong to this project');
    }
    if (!IDENTIFIER_RE.test(request.name)) {
      throw new CloneError('database', `"${request.name}" is not a valid database name`);
    }
    if (isReservedDbName(request.name)) {
      throw new CloneError('database', `"${request.name}" is a system database name on MySQL or PostgreSQL — pick another name`);
    }
    if (seen.has(request.name)) {
      throw new CloneError('database', `"${request.name}" is used twice — each copy needs its own name`);
    }
    seen.add(request.name);

    const connection = connectionForDatabase(deps.db, deps.secretBox, source);
    if (!connection) {
      throw new CloneError('database', `no admin credentials for the ${source.engine} server ${source.name} lives on`);
    }

    // Same scoping rule as `POST /api/databases`: a name is taken per SERVER, not per engine.
    const clash = deps.db
      .select({ id: databases.id })
      .from(databases)
      .where(
        and(
          eq(databases.name, request.name),
          connection.id === null ? and(eq(databases.engine, source.engine), isNull(databases.connectionId)) : eq(databases.connectionId, connection.id),
        ),
      )
      .get();
    if (clash) {
      throw new CloneError('database', `a database named "${request.name}" already exists on ${connection.name}`);
    }

    return { source, connection, name: request.name };
  });
}

/**
 * Creates each copy and fills it from the source, returning what to write into the clone's env.
 *
 * The dump goes to a temp file that is deleted before this returns, whether the copy worked or not —
 * it is a complete snapshot of someone's live data, and it does not get to outlive the request. Any
 * failure propagates: the caller's response to a half-copied database is to remove the whole clone.
 */
async function copyDatabases(
  deps: CloneDeps,
  projectId: number,
  plan: { source: DatabaseRow; connection: ResolvedConnection; name: string }[],
): Promise<{ row: DatabaseRow; password: string; connection: ResolvedConnection; sourceName: string }[]> {
  const copied: { row: DatabaseRow; password: string; connection: ResolvedConnection; sourceName: string }[] = [];
  if (plan.length === 0) return copied;

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shipway-clone-'));
  try {
    for (const { source, connection, name } of plan) {
      const username = name;
      const password = generateDbPassword();

      try {
        await deps.dbAdmin.createDatabase(connection.target, name, username, password);
      } catch (err) {
        throw new CloneError('copy', `could not create ${name} on ${connection.name}: ${errMessage(err)}`);
      }

      // Registered before the copy, not after: if the dump or the restore fails, teardown has to be
      // able to find this database to drop it, and it can only do that from a row.
      deps.db
        .insert(databases)
        .values({
          projectId,
          connectionId: connection.id,
          engine: source.engine,
          name,
          username,
          passwordEncrypted: deps.secretBox.encrypt(password),
        })
        .run();
      const row = deps.db.select().from(databases).where(eq(databases.name, name)).orderBy(databases.id).all().at(-1);
      if (!row) {
        throw new CloneError('copy', `could not record the new database ${name}`);
      }

      const sqlPath = path.join(dir, `${name}.sql`);
      const sourcePassword = deps.secretBox.decrypt(source.passwordEncrypted);
      try {
        await deps.dbAdmin.dumpSql(ownerTarget(connection, source.engine, source.username, sourcePassword), source.name, sqlPath);
      } catch (err) {
        throw new CloneError('copy', `could not read ${source.name}: ${errMessage(err)}`);
      }
      try {
        await deps.dbAdmin.importSql(ownerTarget(connection, source.engine, username, password), name, sqlPath);
      } catch (err) {
        throw new CloneError('copy', `could not copy ${source.name} into ${name}: ${errMessage(err)}`);
      }

      copied.push({ row, password, connection, sourceName: source.name });
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }

  return copied;
}

/**
 * The clone's env: the source's, with every value that named the source's database replaced by the
 * copy's, its domain moved to the new subdomain, and a `DB_*` block written from the first copy.
 *
 * The `DB_*` upsert is unconditional (rather than only filling blanks) because it is the guarantee
 * this whole feature rests on — whatever the source's env said, after this the clone's `DB_*` names
 * the clone's own database. Only the first copy gets that treatment: `DB_*` is one connection's
 * worth of keys, and a project with a second database keeps it under whatever keys it already used,
 * which the exact-value rewrite above has already re-pointed.
 */
function buildCloneEnv(
  sourceEnv: string,
  copies: { row: DatabaseRow; password: string; connection: ResolvedConnection; sourceName: string }[],
  sources: DatabaseRow[],
  secretBox: SecretBox,
  fromDomain: string | null,
  toDomain: string | null,
): string {
  const replacements = new Map<string, string>();
  for (const copy of copies) {
    const source = sources.find((row) => row.name === copy.sourceName);
    if (!source) continue;
    replacements.set(source.name, copy.row.name);
    replacements.set(source.username, copy.row.username);
    replacements.set(secretBox.decrypt(source.passwordEncrypted), copy.password);
  }

  let text = rewriteEnvValues(sourceEnv, replacements);
  if (fromDomain !== null && toDomain !== null) {
    text = rewriteEnvDomain(text, fromDomain, toDomain);
  }

  const primary = copies[0];
  if (primary) {
    text = upsertEnvVars(
      text,
      connectionEnv(
        primary.row.engine,
        { name: primary.row.name, username: primary.row.username, password: primary.password },
        primary.connection.endpoint,
      ),
    );
  }
  return text;
}

/** Copies the source's worker rows and installs their units on the host. */
async function copyWorkers(deps: CloneDeps, source: ProjectRow, clone: ProjectRow): Promise<number> {
  const rows = deps.db.select().from(workers).where(eq(workers.projectId, source.id)).all();
  for (const worker of rows) {
    // `statusCached` is deliberately not copied — it describes units that are running for the source,
    // and the clone's own have not been asked anything yet.
    deps.db
      .insert(workers)
      .values({
        projectId: clone.id,
        name: worker.name,
        command: worker.command,
        processes: worker.processes,
        autoStart: worker.autoStart,
        restartPolicy: worker.restartPolicy,
        restartSec: worker.restartSec,
        stopTimeoutSec: worker.stopTimeoutSec,
      })
      .run();
  }

  const created = deps.db.select().from(workers).where(eq(workers.projectId, clone.id)).all();
  for (const worker of created) {
    await applyWorker({ sysops: deps.sysops, cfg: deps.cfg }, clone, worker);
  }
  return created.length;
}

/** Copies the source's cron rows and rewrites the host crontab so the clone's entries appear. */
async function copyCronJobs(deps: CloneDeps, source: ProjectRow, clone: ProjectRow): Promise<number> {
  const rows = deps.db.select().from(cronJobs).where(eq(cronJobs.projectId, source.id)).all();
  for (const job of rows) {
    // Commands are stored release-relative (the crontab renderer supplies the working directory from
    // the slug), so they copy verbatim — and the clone shares the source's phpVersion, so a command
    // already rewritten to `php8.3 …` stays correct.
    deps.db.insert(cronJobs).values({ projectId: clone.id, schedule: job.schedule, command: job.command }).run();
  }
  if (rows.length > 0) {
    await syncCrontab(deps);
  }
  return rows.length;
}

/** Copies who gets emailed about the clone's deploys, and about what. */
function copyNotifications(deps: CloneDeps, source: ProjectRow, clone: ProjectRow): void {
  const events = deps.db.select().from(projectNotificationEvents).where(eq(projectNotificationEvents.projectId, source.id)).all();
  for (const row of events) {
    deps.db.insert(projectNotificationEvents).values({ projectId: clone.id, event: row.event }).onConflictDoNothing().run();
  }
  const recipients = deps.db.select().from(projectNotificationRecipients).where(eq(projectNotificationRecipients.projectId, source.id)).all();
  for (const row of recipients) {
    deps.db.insert(projectNotificationRecipients).values({ projectId: clone.id, email: row.email }).onConflictDoNothing().run();
  }
}

/**
 * Creates `input.slug` as a copy of project `sourceId`. See this file's header for what is and isn't
 * carried across; the caller is responsible for having checked that the slug is free and allowed
 * (`RESERVED_SLUGS`, `SLUG_RE`) before calling.
 *
 * Either returns a complete clone or leaves nothing behind: every failure after the project row is
 * inserted runs `deprovisionProject`, which removes the DNS record, the vhost, the units, the
 * directories, the row — and any database this call had already created for it.
 */
export async function cloneProject(deps: CloneDeps, sourceId: number, input: CloneInput): Promise<CloneResult> {
  const source = deps.db.select().from(projects).where(eq(projects.id, sourceId)).get();
  if (!source) {
    throw new CloneError('source', 'project not found');
  }
  if (deps.db.select({ id: projects.id }).from(projects).where(eq(projects.slug, input.slug)).get()) {
    throw new CloneError('slug', 'slug already in use');
  }

  // Everything the caller could have got wrong is checked before anything is created.
  const plan = planDatabaseCopies(deps, sourceId, input.databases);

  const usedPorts = deps.db
    .select({ port: projects.port })
    .from(projects)
    .all()
    .map((row) => row.port)
    .filter((port): port is number => port !== null);

  const values: Record<string, unknown> = { name: input.name, slug: input.slug, port: isNodeLike(source.type) ? allocatePort(usedPorts) : null };
  for (const column of COPIED_COLUMNS) {
    values[column] = source[column];
  }
  deps.db.insert(projects).values(values as typeof projects.$inferInsert).run();

  const clone = deps.db.select().from(projects).where(eq(projects.slug, input.slug)).get();
  if (!clone) {
    throw new CloneError('provision', 'failed to create the cloned project');
  }

  try {
    const dns = await provisionProject(deps, clone.id);

    const copies = await copyDatabases(deps, clone.id, plan);

    const baseDomain = getSetting<string>(deps.db, 'base_domain');
    const sourceEnv = source.envEncrypted ? deps.secretBox.decrypt(source.envEncrypted) : '';
    const envText = buildCloneEnv(
      sourceEnv,
      copies,
      plan.map((entry) => entry.source),
      deps.secretBox,
      baseDomain ? projectDomain(source, baseDomain) : null,
      baseDomain ? projectDomain(clone, baseDomain) : null,
    );
    // Stored only. There is deliberately no `applyEnvToRunning` here: a clone has never been
    // deployed, so there is no `current` release holding old values and nothing to restart — the
    // first deploy writes `shared/.env` from this.
    if (envText !== '') {
      deps.db.update(projects).set({ envEncrypted: deps.secretBox.encrypt(envText) }).where(eq(projects.id, clone.id)).run();
    }

    copyNotifications(deps, source, clone);
    const workerCount = await copyWorkers(deps, source, clone);
    const cronCount = await copyCronJobs(deps, source, clone);
    const sharedFilesCopied = copySharedFiles(deps.cfg, source.slug, clone.slug);

    const updated = deps.db.select().from(projects).where(eq(projects.id, clone.id)).get() ?? clone;
    return {
      project: updated,
      dns,
      databases: copies.map((copy, index) => ({
        sourceName: copy.sourceName,
        name: copy.row.name,
        engine: copy.row.engine,
        connectionName: copy.connection.name,
        usedInEnv: index === 0,
      })),
      workers: workerCount,
      cronJobs: cronCount,
      sharedFilesCopied,
    };
  } catch (err) {
    // No half-clones. Most of what could fail here (a vhost that won't test, a dump the engine
    // refused) leaves a project that either can't serve or would serve against the ORIGINAL's
    // database — and the second of those is worth tearing the first one down to avoid.
    await deprovisionProject(deps, clone.id);
    if (err instanceof CloneError) throw err;
    // A ProvisionError names the stage it died at ('dns', 'nginx-test', …), which is the most useful
    // half of the message — keep it rather than flattening every provisioning failure into one.
    throw new CloneError('provision', err instanceof ProvisionError ? `${err.step}: ${err.message}` : errMessage(err));
  }
}
