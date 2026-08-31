/**
 * `/api/db-connections` — the registry of external database servers Shipway can provision on (an
 * RDS instance, a managed Postgres, another box), plus the two engines on this host, which are read
 * out of settings rather than stored here (see `services/dbconnections.ts`).
 *
 * Admin credentials are the whole point of a connection and are never returned by any route here:
 * they go in encrypted and only ever come back out inside `services/dbconnections.ts`, on their way
 * to a database driver. What a client gets is the host, port, engine and admin *username*.
 *
 * Every write tests the credentials against the real server before storing them. A connection that
 * cannot connect is not a connection, and finding that out at save time is the difference between a
 * typo and a project deploy that fails hours later with "database provisioning failed".
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { databases, dbConnections } from '../db/schema.js';
import { requireRole } from '../lib/authz.js';
import { getActor, recordAudit } from '../services/audit.js';
import { adminUrl, listConnections, toSummary } from '../services/dbconnections.js';
import { dbPort, type DbAdminTarget } from '../services/dbprovision.js';

const idParamsSchema = z.object({ id: z.coerce.number().int() });

/**
 * A hostname or IP, loosely checked: no scheme, no path, no whitespace, no credentials. The point
 * is to catch a pasted `postgres://user:pass@host/db` (a real habit, and one that would silently
 * store a password in a plaintext column) rather than to validate DNS.
 */
const HOST_RE = /^[A-Za-z0-9._-]+$/;

const connectionBodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  engine: z.enum(['mysql', 'postgres']),
  host: z.string().trim().regex(HOST_RE),
  port: z.number().int().min(1).max(65535).optional(),
  adminUsername: z.string().trim().min(1).max(128),
  adminPassword: z.string().min(1),
  tls: z.boolean().optional(),
});

/** Same shape, but every field optional and the password omissible — a rename or a host change
 * shouldn't require re-typing a credential the server already holds. */
const updateBodySchema = connectionBodySchema.partial().extend({ adminPassword: z.string().min(1).optional() });

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reduces a driver error to something a person can act on. `mysql2` and `pg` both put the useful
 * part (`ECONNREFUSED`, `ENOTFOUND`, `password authentication failed`) in the message, so it is
 * passed through as-is; the codes are named here only to keep the shape obvious to the next reader.
 */
function connectionErrorMessage(err: unknown): string {
  const message = toErrorMessage(err);
  return message === '' ? 'could not connect' : message;
}

export async function dbConnectionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every connection a database can live on, host engines first — what both the Databases page and
   * the new-project form build their picker from. Safe for any signed-in user to read: no
   * credentials, and the host/port are already in every project's env.
   */
  app.get('/api/db-connections', async () => {
    const rows = app.db.select().from(dbConnections).all();
    const stored = new Map(rows.map((row) => [row.id, row]));
    const allDatabases = app.db
      .select({ engine: databases.engine, connectionId: databases.connectionId })
      .from(databases)
      .all();

    return listConnections(app.db, app.secretBox).map((connection) => {
      const row = connection.id === null ? null : (stored.get(connection.id) ?? null);
      return {
        ...toSummary(connection),
        // Null for a host engine: its credentials are the installer's, not something anyone entered
        // here, and there is no row to show a creation date for.
        adminUsername: row?.adminUsername ?? null,
        createdAt: row?.createdAt ?? null,
        // How many databases Shipway has on this connection — what the page shows per row, and what
        // makes a connection refuse to be unregistered.
        databaseCount: allDatabases.filter((database) =>
          connection.id === null ? database.connectionId === null && database.engine === connection.engine : database.connectionId === connection.id,
        ).length,
      };
    });
  });

  /**
   * Registers an external server. The credentials are tested first: a 502 here means they reached
   * the server and it said no (or nothing was listening), which is the useful failure to report at
   * the moment someone can still fix it.
   */
  app.post('/api/db-connections', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsed = connectionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const { name, engine, host, adminUsername, adminPassword } = parsed.data;
    const port = parsed.data.port ?? dbPort(engine);
    const tls = parsed.data.tls ?? false;

    const clash = app.db.select({ id: dbConnections.id }).from(dbConnections).where(eq(dbConnections.name, name)).get();
    if (clash) {
      return reply.code(409).send({ error: 'a connection with this name already exists' });
    }

    const target: DbAdminTarget = { engine, url: adminUrl(engine, host, port, adminUsername, adminPassword), tls };
    try {
      await app.dbAdmin.testConnection(target);
    } catch (err) {
      return reply.code(502).send({ error: 'could not connect with these credentials', detail: connectionErrorMessage(err) });
    }

    app.db
      .insert(dbConnections)
      .values({
        name,
        engine,
        host,
        port,
        adminUsername,
        adminPasswordEncrypted: app.secretBox.encrypt(adminPassword),
        tls,
      })
      .run();

    const created = app.db.select().from(dbConnections).where(eq(dbConnections.name, name)).get();
    if (!created) {
      return reply.code(500).send({ error: 'failed to create connection' });
    }

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'dbconnection.create',
      targetType: 'dbconnection',
      targetName: name,
      meta: { engine, host, port },
    });

    return reply.code(201).send({
      key: `external:${String(created.id)}`,
      kind: 'external',
      id: created.id,
      name: created.name,
      engine: created.engine,
      host: created.host,
      port: created.port,
      tls: created.tls,
      adminUsername: created.adminUsername,
      createdAt: created.createdAt,
    });
  });

  /**
   * Tries credentials without storing anything — what the form's "Test connection" button calls,
   * and the only route here that a client can hit repeatedly with guesses, hence admin-only like
   * the writes. Answers `{ ok: true }` or `{ ok: false, detail }` with a 200 either way: a
   * connection that refuses the credentials is a successful test, not a failed request.
   */
  app.post('/api/db-connections/test', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsed = connectionBodySchema.omit({ name: true }).extend({ id: z.number().int().optional() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const { engine, host, adminUsername, adminPassword } = parsed.data;
    const port = parsed.data.port ?? dbPort(engine);

    try {
      await app.dbAdmin.testConnection({
        engine,
        url: adminUrl(engine, host, port, adminUsername, adminPassword),
        tls: parsed.data.tls ?? false,
      });
    } catch (err) {
      return { ok: false, detail: connectionErrorMessage(err) };
    }
    return { ok: true };
  });

  /** Edits a registered connection. Anything not sent keeps its stored value — including the admin
   * password, so a rename doesn't require re-entering a credential that already works. */
  app.patch('/api/db-connections/:id', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'connection not found' });
    }
    const bodyParsed = updateBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const row = app.db.select().from(dbConnections).where(eq(dbConnections.id, paramsParsed.data.id)).get();
    if (!row) {
      return reply.code(404).send({ error: 'connection not found' });
    }

    const next = {
      name: bodyParsed.data.name ?? row.name,
      // The engine is not editable: the databases already on this connection were created with that
      // engine's SQL and are named in its namespace. Changing it would point them at a server that
      // has never heard of them, so a different engine is a different connection.
      engine: row.engine,
      host: bodyParsed.data.host ?? row.host,
      port: bodyParsed.data.port ?? row.port,
      adminUsername: bodyParsed.data.adminUsername ?? row.adminUsername,
      tls: bodyParsed.data.tls ?? row.tls,
    };
    const password = bodyParsed.data.adminPassword ?? app.secretBox.decrypt(row.adminPasswordEncrypted);

    if (next.name !== row.name) {
      const clash = app.db.select({ id: dbConnections.id }).from(dbConnections).where(eq(dbConnections.name, next.name)).get();
      if (clash) {
        return reply.code(409).send({ error: 'a connection with this name already exists' });
      }
    }

    try {
      await app.dbAdmin.testConnection({
        engine: next.engine,
        url: adminUrl(next.engine, next.host, next.port, next.adminUsername, password),
        tls: next.tls,
      });
    } catch (err) {
      return reply.code(502).send({ error: 'could not connect with these credentials', detail: connectionErrorMessage(err) });
    }

    app.db
      .update(dbConnections)
      .set({ ...next, adminPasswordEncrypted: app.secretBox.encrypt(password) })
      .where(eq(dbConnections.id, row.id))
      .run();

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'dbconnection.update',
      targetType: 'dbconnection',
      targetName: next.name,
      meta: { host: next.host, port: next.port, passwordChanged: bodyParsed.data.adminPassword !== undefined },
    });

    return reply.code(204).send();
  });

  /**
   * Unregisters a connection. Refused while Shipway still has databases on it: forgetting the
   * credentials would strand those databases — no way to drop them, and no way to hand their
   * host/port to a project again. The count is reported so the answer is actionable.
   *
   * Nothing on the remote server is touched either way; this removes Shipway's record of how to
   * reach it, and the databases themselves have to go first.
   */
  app.delete('/api/db-connections/:id', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'connection not found' });
    }

    const row = app.db.select().from(dbConnections).where(eq(dbConnections.id, paramsParsed.data.id)).get();
    if (!row) {
      return reply.code(404).send({ error: 'connection not found' });
    }

    const attached = app.db.select({ id: databases.id }).from(databases).where(eq(databases.connectionId, row.id)).all();
    if (attached.length > 0) {
      return reply.code(409).send({
        error: `this connection still has ${String(attached.length)} ${attached.length === 1 ? 'database' : 'databases'} on it — drop them first`,
      });
    }

    app.db.delete(dbConnections).where(eq(dbConnections.id, row.id)).run();

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'dbconnection.delete',
      targetType: 'dbconnection',
      targetName: row.name,
      meta: { engine: row.engine, host: row.host },
    });

    return reply.code(204).send();
  });
}
