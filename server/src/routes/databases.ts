import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { databases, projects } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import { requireRole } from '../lib/authz.js';
import { accessibleProjectIds, canAccessProject } from '../lib/projectaccess.js';
import { getActor, recordAudit } from '../services/audit.js';
import { adminUrl, connectionForDatabase, fallbackEndpoint, resolveConnection, type ResolvedConnection } from '../services/dbconnections.js';
import { applyEnvToRunning } from '../services/envapply.js';
import { syncPgAdminServers } from '../services/pgadmin.js';
import {
  connectionEnv,
  connectionKey,
  generateDbPassword,
  IDENTIFIER_RE,
  isReservedDbName,
  parseConnectionKey,
  type DbEndpoint,
  type DbEngine,
} from '../services/dbprovision.js';

const idParamsSchema = z.object({ id: z.coerce.number().int() });

/**
 * `connection` is the `connectionKey` of the server to create on (`local:mysql`, `external:7`).
 * `engine` is still accepted on its own for a database on this host, which is all this route could
 * target before connections existed — a caller that sends only an engine still means "the engine on
 * this server", and gets exactly what it got before.
 */
const createDatabaseSchema = z
  .object({
    engine: z.enum(['mysql', 'postgres']).optional(),
    connection: z.string().optional(),
    name: z.string().regex(IDENTIFIER_RE),
    projectId: z.number().int().optional(),
  })
  .refine((body) => body.engine !== undefined || body.connection !== undefined, {
    message: 'one of engine or connection is required',
  });

const deleteBodySchema = z.object({ confirmName: z.string() });

const injectBodySchema = z.object({ projectId: z.number().int() });

/**
 * Largest dump `POST /api/databases/:id/import` will take. Deliberately the same figure as the
 * dashboard vhost's `client_max_body_size` (setup/templates/nginx-dashboard.conf), so a file that
 * is too big is refused by whichever of the two sees it first with the same number in the message
 * rather than by nginx with a bare 413 the dashboard can't explain.
 */
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

/** What an uploaded dump is posted as. `application/sql` and not `text/plain`, so the raw parser
 * below can be added without changing how anything else in the API is read. */
const SQL_CONTENT_TYPE = 'application/sql';

/** Thrown by `capBytes` once the upload passes `MAX_IMPORT_BYTES`, so the route can tell "too big"
 * apart from a connection that simply broke mid-upload. */
class UploadTooLargeError extends Error {}

/**
 * Passes `source` through unchanged while counting it, aborting the moment it exceeds `limit`.
 * A cap enforced here rather than by Fastify's `bodyLimit` because the dump is streamed to disk by
 * a raw content-type parser (see `sqlUploadStream`) — nothing ever buffers it, which is the whole
 * point, and `bodyLimit` only ever applies to bodies Fastify itself buffers.
 */
async function* capBytes(source: AsyncIterable<Buffer>, limit: number): AsyncGenerator<Buffer> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.length;
    if (total > limit) {
      throw new UploadTooLargeError();
    }
    yield chunk;
  }
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Matches a `KEY=` assignment at the start of a line (leading whitespace allowed); comments never match. */
const ENV_KEY_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Collects the set of keys already assigned in `text` (comments ignored), mirroring `deploy/envfile.ts`. */
function definedEnvKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const m = ENV_KEY_RE.exec(line);
    if (m) {
      keys.add(m[1] as string);
    }
  }
  return keys;
}

/**
 * Appends the `DB_*` vars for `db` to `envText` under a `# added by shipway` comment, skipping any
 * key `envText` already defines (line-start `KEY=` match). Returns `envText` unchanged if every key
 * is already defined. Unlike `deploy/envfile.ts`'s managed block, this is a one-time append (no
 * strip-and-regenerate) — the injected lines become ordinary user-owned env text from then on.
 */
function appendConnectionEnv(
  envText: string,
  engine: 'mysql' | 'postgres',
  db: { name: string; username: string; password: string },
  endpoint: DbEndpoint,
): string {
  const alreadyDefined = definedEnvKeys(envText);
  const entries = Object.entries(connectionEnv(engine, db, endpoint)).filter(([key]) => !alreadyDefined.has(key));
  if (entries.length === 0) {
    return envText;
  }

  const lines = [`# added by shipway — database ${db.name}`, ...entries.map(([key, value]) => `${key}=${value}`)];
  const base = envText === '' ? '' : envText.endsWith('\n') ? envText : `${envText}\n`;
  const separator = base === '' ? '' : '\n';
  return `${base}${separator}${lines.join('\n')}\n`;
}

/**
 * Where an app dials to reach `row` — its connection's endpoint, or this host if that connection has
 * gone missing (see `fallbackEndpoint`). The credentials rendered alongside it are the database's
 * real ones either way; only the host/port would be a guess.
 */
function endpointFor(app: FastifyInstance, row: { engine: DbEngine; connectionId: number | null }): DbEndpoint {
  const connection: ResolvedConnection | null = connectionForDatabase(app.db, app.secretBox, row);
  return connection?.endpoint ?? fallbackEndpoint(row.engine);
}

/**
 * Registers `/api/databases` CRUD + credential reveal + env injection, plus `/api/services/info`.
 * All routes here sit under the global session guard in `buildApp`.
 */
export async function databaseRoutes(app: FastifyInstance): Promise<void> {
  // A dump arrives as a raw body under this content type and is handed to the route as the request
  // stream itself, unbuffered and unparsed — see `POST /api/databases/:id/import`. Registered on
  // this plugin's own encapsulated context, so nothing outside these routes can be posted a body
  // Fastify won't parse.
  app.addContentTypeParser(SQL_CONTENT_TYPE, (_request, payload, done) => {
    done(null, payload);
  });

  /**
   * Whether the requesting user may act on one database row. A database belongs to a project (or to
   * nothing at all), so its scope is its project's: a `projectAccess: 'selected'` member reaches
   * only the databases attached to a project they were granted, and never an UNATTACHED one — an
   * unattached database can't be attributed to any project, so there's no grant that could cover it.
   * Unscoped users (admins, and members with `'all'`) reach every database exactly as before.
   */
  function canAccessDatabase(request: FastifyRequest, projectId: number | null): boolean {
    const allowed = accessibleProjectIds(app.db, request.session.get('userId'));
    if (allowed === null) return true;
    return projectId !== null && allowed.has(projectId);
  }

  app.get('/api/databases', async (request) => {
    const rows = app.db
      .select({
        id: databases.id,
        projectId: databases.projectId,
        connectionId: databases.connectionId,
        engine: databases.engine,
        name: databases.name,
        username: databases.username,
        createdAt: databases.createdAt,
        projectName: projects.name,
      })
      .from(databases)
      .leftJoin(projects, eq(databases.projectId, projects.id))
      .all()
      .filter((row) => canAccessDatabase(request, row.projectId));

    // Resolved per row rather than joined, because a host engine isn't a row to join to — see
    // `services/dbconnections.ts`. `connectionName` is null only when the connection has gone
    // missing under the database (a host engine whose admin URL was removed), which the dashboard
    // shows as an unreachable database rather than pretending it is fine.
    return rows.map((row) => {
      const connection = connectionForDatabase(app.db, app.secretBox, row);
      const endpoint = connection?.endpoint ?? fallbackEndpoint(row.engine);
      return {
        ...row,
        connectionKey: connectionKey(row.connectionId === null ? { kind: 'local', engine: row.engine } : { kind: 'external', id: row.connectionId }),
        connectionName: connection?.name ?? null,
        host: endpoint.host,
        port: endpoint.port,
      };
    });
  });

  app.post('/api/databases', async (request, reply) => {
    const parsed = createDatabaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const { name, projectId } = parsed.data;

    // An explicit connection wins; a bare engine means this host's engine, which is what every
    // caller meant before connections existed.
    const key = parsed.data.connection ?? connectionKey({ kind: 'local', engine: parsed.data.engine as DbEngine });
    const connection = resolveConnection(app.db, app.secretBox, key);
    if (!connection) {
      // A host engine that resolves to nothing means the installer never wrote its admin URL — the
      // same condition that used to surface from `DbAdmin` as "…admin credentials not configured",
      // and still the more useful thing to say than "connection not found" about a server that is
      // plainly running. A missing *registered* connection really is a 404.
      const ref = parseConnectionKey(key);
      if (ref?.kind === 'local') {
        return reply
          .code(502)
          .send({ error: 'database provisioning failed', detail: `${ref.engine} admin credentials not configured` });
      }
      return reply.code(404).send({ error: 'connection not found' });
    }
    if (parsed.data.engine !== undefined && parsed.data.engine !== connection.engine) {
      return reply.code(400).send({ error: `connection ${connection.name} is ${connection.engine}, not ${parsed.data.engine}` });
    }
    const engine = connection.engine;

    // A system-database name passes IDENTIFIER_RE happily, and creating one is quietly destructive:
    // `CREATE DATABASE IF NOT EXISTS \`mysql\`` is a no-op on the server's own schema, and the GRANT
    // that follows would hand a project full access to MySQL's user and grant tables. See
    // `isReservedDbName`.
    if (isReservedDbName(name)) {
      return reply.code(409).send({ error: `"${name}" is a system database name on MySQL or PostgreSQL — pick another name` });
    }

    if (projectId !== undefined) {
      const project = app.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
      if (!project) {
        return reply.code(404).send({ error: 'project not found' });
      }
      // Same 404-not-403 rule as everywhere else project scope is enforced (`lib/projectaccess.ts`).
      if (!canAccessProject(app.db, request.session.get('userId'), projectId)) {
        return reply.code(404).send({ error: 'project not found' });
      }
    } else if (accessibleProjectIds(app.db, request.session.get('userId')) !== null) {
      // A scoped member can't see an unattached database once it exists (see `canAccessDatabase`),
      // so creating one would hand them a database — and a live role on a real server — that
      // immediately vanishes from their Databases page. Requiring the project up front is the
      // honest failure.
      return reply.code(400).send({ error: 'select a project for this database' });
    }

    // Scoped to the connection, not the engine: the same database name on two different servers is
    // two different databases, and refusing the second would be refusing something that works.
    const existing = app.db
      .select({ id: databases.id })
      .from(databases)
      .where(
        and(
          eq(databases.name, name),
          connection.id === null ? and(eq(databases.engine, engine), isNull(databases.connectionId)) : eq(databases.connectionId, connection.id),
        ),
      )
      .get();
    if (existing) {
      return reply.code(409).send({ error: `a database with this name already exists on ${connection.name}` });
    }

    const username = name;
    const password = generateDbPassword();

    try {
      await app.dbAdmin.createDatabase(connection.target, name, username, password);
    } catch (err) {
      return reply.code(502).send({ error: 'database provisioning failed', detail: toErrorMessage(err) });
    }

    const passwordEncrypted = app.secretBox.encrypt(password);
    app.db
      .insert(databases)
      .values({ projectId: projectId ?? null, connectionId: connection.id, engine, name, username, passwordEncrypted })
      .run();

    const created = app.db
      .select({ id: databases.id })
      .from(databases)
      .where(
        and(
          eq(databases.name, name),
          connection.id === null ? and(eq(databases.engine, engine), isNull(databases.connectionId)) : eq(databases.connectionId, connection.id),
        ),
      )
      .get();
    if (!created) {
      return reply.code(500).send({ error: 'failed to create database' });
    }

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'database.create',
      targetType: 'database',
      targetName: name,
      meta: { engine, connection: connection.name },
    });

    // A Postgres database on this host is one pgAdmin can be pointed at, so register it there.
    // Not awaited — pgAdmin's CLI takes seconds to start, and the database exists either way; the
    // console link is the only thing that lags, until the next sync. See services/pgadmin.ts.
    if (engine === 'postgres' && connection.id === null) {
      void syncPgAdminServers(app);
    }

    // The ONE time the plaintext password is ever returned — every other read (GET
    // /api/databases, /:id/credentials) either omits it or requires a separate decrypt.
    return reply.code(201).send({
      id: created.id,
      engine,
      name,
      username,
      password,
      connectionKey: connection.key,
      connectionName: connection.name,
      host: connection.endpoint.host,
      port: connection.endpoint.port,
    });
  });

  app.get('/api/databases/:id/credentials', async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'database not found' });
    }

    const row = app.db.select().from(databases).where(eq(databases.id, paramsParsed.data.id)).get();
    if (!row || !canAccessDatabase(request, row.projectId)) {
      return reply.code(404).send({ error: 'database not found' });
    }

    const password = app.secretBox.decrypt(row.passwordEncrypted);
    const endpoint = endpointFor(app, row);
    return {
      // `name`/`engine` are already in `GET /api/databases`; they are repeated here so a caller
      // that has only an id — the phpMyAdmin signon shim at /db/signon.php — can build a complete
      // connection from this one response instead of fetching the whole list to find the name.
      name: row.name,
      engine: row.engine,
      username: row.username,
      password,
      host: endpoint.host,
      port: endpoint.port,
      env: connectionEnv(row.engine, { name: row.name, username: row.username, password }, endpoint),
    };
  });

  app.delete('/api/databases/:id', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'database not found' });
    }
    const { id } = paramsParsed.data;

    const bodyParsed = deleteBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const row = app.db.select().from(databases).where(eq(databases.id, id)).get();
    if (!row) {
      return reply.code(404).send({ error: 'database not found' });
    }

    if (bodyParsed.data.confirmName !== row.name) {
      return reply.code(400).send({ error: 'confirmName does not match the database name' });
    }

    // A row whose name is a system database can only have come from before the create-time guard
    // above existed. Dropping it for real would take out the engine's own schema, so the record and
    // its user are removed and the database itself is left untouched — which is exactly the cleanup
    // such a row needs, and is reported as `keptDatabase` in the audit trail so it isn't mistaken
    // for an ordinary drop.
    const keepDatabase = isReservedDbName(row.name);

    const connection = connectionForDatabase(app.db, app.secretBox, row);
    if (!connection) {
      return reply.code(502).send({
        error: 'database deprovisioning failed',
        detail: `no admin credentials for the ${row.engine} server this database lives on`,
      });
    }

    try {
      await app.dbAdmin.dropDatabase(connection.target, row.name, row.username, { keepDatabase });
    } catch (err) {
      return reply.code(502).send({ error: 'database deprovisioning failed', detail: toErrorMessage(err) });
    }

    app.db.delete(databases).where(eq(databases.id, id)).run();

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'database.drop',
      targetType: 'database',
      targetName: row.name,
      meta: keepDatabase ? { engine: row.engine, keptDatabase: true } : { engine: row.engine },
    });

    // Drops the matching pgAdmin server too, so the console stops offering a connection to a
    // database that is gone. Same fire-and-forget reasoning as the create path above.
    if (row.engine === 'postgres' && row.connectionId === null) {
      void syncPgAdminServers(app);
    }

    return reply.code(204).send();
  });

  app.post('/api/databases/:id/inject', async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'database not found' });
    }

    const dbRow = app.db.select().from(databases).where(eq(databases.id, paramsParsed.data.id)).get();
    if (!dbRow || !canAccessDatabase(request, dbRow.projectId)) {
      return reply.code(404).send({ error: 'database not found' });
    }

    const bodyParsed = injectBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const project = app.db
      .select({ id: projects.id, envEncrypted: projects.envEncrypted })
      .from(projects)
      .where(eq(projects.id, bodyParsed.data.projectId))
      .get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const currentEnv = project.envEncrypted ? app.secretBox.decrypt(project.envEncrypted) : '';
    const password = app.secretBox.decrypt(dbRow.passwordEncrypted);
    const nextEnv = appendConnectionEnv(currentEnv, dbRow.engine, { name: dbRow.name, username: dbRow.username, password }, endpointFor(app, dbRow));

    app.db
      .update(projects)
      .set({ envEncrypted: app.secretBox.encrypt(nextEnv) })
      .where(eq(projects.id, project.id))
      .run();

    // Injecting a standalone database's credentials into a project is how that database becomes
    // that project's database, so record the association too — otherwise the Databases page keeps
    // listing it as belonging to nobody. Only ever fills in a blank: a database already attached to
    // some project is never silently re-pointed at another one by an env injection.
    const attached = dbRow.projectId === null;
    if (attached) {
      app.db.update(databases).set({ projectId: project.id }).where(eq(databases.id, dbRow.id)).run();
    }

    // "Add to project env" writes DB_* into the same file the Environment tab does, so it applies
    // the same way — a project handed a database's credentials should be able to reach it without
    // waiting for a deploy. Selected fresh because the row above is a two-column projection.
    const full = app.db.select().from(projects).where(eq(projects.id, project.id)).get();
    const applied = full ? await applyEnvToRunning(app, full) : { applied: false, workersRestarted: 0 };

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'database.inject',
      targetType: 'database',
      targetName: dbRow.name,
      meta: { projectId: project.id, attached, applied: applied.applied },
    });

    return reply.code(200).send(applied);
  });

  /**
   * Replays an uploaded SQL dump into an existing database. The body is the dump itself
   * (`Content-Type: application/sql`), streamed straight to a temp file and handed to the engine's
   * own client — see `DbAdmin.importSql` for why the file never goes through a driver.
   *
   * No role gate beyond the session, matching `POST /api/databases`: anyone who can sign in already
   * reaches every database on this host through the phpMyAdmin/pgAdmin consoles the dashboard vhost
   * proxies, so requiring admin here would guard a door that is open next to it.
   */
  app.post('/api/databases/:id/import', async (request, reply) => {
    const upload = request.body as Readable;

    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return discardThen(upload, () => reply.code(404).send({ error: 'database not found' }));
    }

    const row = app.db.select().from(databases).where(eq(databases.id, paramsParsed.data.id)).get();
    if (!row || !canAccessDatabase(request, row.projectId)) {
      return discardThen(upload, () => reply.code(404).send({ error: 'database not found' }));
    }

    const connection = connectionForDatabase(app.db, app.secretBox, row);
    if (!connection) {
      return discardThen(upload, () =>
        reply.code(502).send({
          error: 'sql import failed',
          detail: `no admin credentials for the ${row.engine} server this database lives on`,
        }),
      );
    }

    // The dump is replayed as the database's OWN user, not as the server admin whose credentials
    // `connection.target` carries. On Postgres that is the difference between a working import and
    // one whose every table is owned by `shipway_admin` and invisible to the app; on MySQL it keeps
    // a dump someone else wrote confined to the grants that database's user already has.
    const password = app.secretBox.decrypt(row.passwordEncrypted);
    const importTarget = {
      engine: row.engine,
      url: adminUrl(row.engine, connection.endpoint.host, connection.endpoint.port, row.username, password),
      tls: connection.target.tls,
    };

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipway-sql-'));
    const sqlPath = path.join(dir, 'import.sql');
    // The outcome is decided first and sent last, with the temp file deleted in between. A dump is
    // someone's live data — it does not get to outlive the request in /tmp whether the import
    // worked, failed, or the upload was refused — and doing the cleanup after `send` would leave
    // the file on disk for as long as it takes an unawaited promise to get around to it.
    const runImport = async (): Promise<{ code: number; body: unknown }> => {
      try {
        await pipeline(upload, (source: AsyncIterable<Buffer>) => capBytes(source, MAX_IMPORT_BYTES), createWriteStream(sqlPath));
      } catch (err) {
        if (err instanceof UploadTooLargeError) {
          return { code: 413, body: { error: `the file is larger than ${String(MAX_IMPORT_BYTES / (1024 * 1024))} MB` } };
        }
        return { code: 400, body: { error: 'the upload did not finish', detail: toErrorMessage(err) } };
      }

      const { size } = await fs.stat(sqlPath);
      if (size === 0) {
        return { code: 400, body: { error: 'the uploaded file is empty' } };
      }

      try {
        await app.dbAdmin.importSql(importTarget, row.name, sqlPath);
      } catch (err) {
        return { code: 502, body: { error: 'sql import failed', detail: toErrorMessage(err) } };
      }

      const actor = getActor(app.db, request.session.get('userId'));
      recordAudit(app.db, {
        ...actor,
        action: 'database.import',
        targetType: 'database',
        targetName: row.name,
        meta: { engine: row.engine, bytes: size },
      });
      return { code: 200, body: { bytes: size } };
    };

    let outcome: { code: number; body: unknown };
    try {
      outcome = await runImport();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }

    return reply.code(outcome.code).send(outcome.body);
  });
}

/**
 * Sends `respond`'s reply after throwing away the rest of the upload. A raw-stream route that
 * answers without reading its body leaves the client pushing a dump into a socket nobody is
 * draining, which surfaces to the browser as a connection reset instead of as the 404 that was
 * actually sent.
 */
function discardThen<T>(upload: Readable, respond: () => T): T {
  upload.resume();
  return respond();
}

interface RedisInfo {
  host: string;
  port: number;
  password?: string;
}

interface MailpitInfo {
  smtpHost: string;
  smtpPort: number;
  webUrl: string;
  /** Basic-auth credentials for the mailpit web UI vhost, when install.sh provisioned them (see
   * `lib/bootstrap.ts`'s `MailpitInfo`) — surfaced so the dashboard's Mailpit info card can show them. */
  username?: string;
  webPassword?: string;
}

/**
 * Which engines this host can actually provision a database on: an engine with no admin URL in
 * settings would fail every create with "…admin credentials not configured", so the dashboard uses
 * this to offer only the engines that can work rather than letting someone pick one and find out
 * from a 502. Booleans only — the URLs themselves carry the admin password.
 */
function configuredEngines(app: FastifyInstance): Record<'mysql' | 'postgres', boolean> {
  return {
    mysql: !!getSetting<string>(app.db, 'mysql_admin_url'),
    postgres: !!getSetting<string>(app.db, 'postgres_admin_url'),
  };
}

/** Registers `GET /api/services/info` — connection info for the shared redis/mailpit instances. */
export async function servicesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/services/info', async () => {
    return {
      redis: getSetting<RedisInfo>(app.db, 'redis_info'),
      mailpit: getSetting<MailpitInfo>(app.db, 'mailpit_info'),
      databaseEngines: configuredEngines(app),
    };
  });
}
