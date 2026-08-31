/**
 * Keeps pgAdmin's saved server list in step with the Postgres databases Shipway provisioned on this
 * host, so the dashboard's **Manage** link lands somewhere useful.
 *
 * pgAdmin, unlike phpMyAdmin, has no way to be pointed at a database from a URL: it browses servers
 * a user has saved in it, and nothing in its request handling reads a database name off the query
 * string. The nearest thing to "open this database" is therefore to make sure the server is already
 * there and already connectable when the user arrives — registered under the Shipway group, and
 * with its password in a passfile pgAdmin reads for itself, so opening it prompts for nothing. The
 * registration is done by the root helper (`setup/pgadmin-sync-servers.py`); this module only
 * decides what the list should contain and hands it over.
 *
 * Only databases on THIS host are included: pgAdmin is installed and configured here, and a
 * database on a registered external connection is managed with whatever that provider gives you
 * (the same rule the dashboard applies when it decides whether to show Manage at all).
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { databases, users } from '../db/schema.js';
import { accessibleProjectIds } from '../lib/projectaccess.js';
import { connectionForDatabase, fallbackEndpoint } from './dbconnections.js';

/** One entry of the sync payload — a pgAdmin server pointed at exactly one Shipway database. */
interface PgAdminServerSpec {
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

/**
 * The full list of Shipway-managed pgAdmin servers, as the JSON the root helper reads on stdin.
 * Rendered from scratch every time rather than diffed: the helper replaces the whole Shipway group,
 * so a payload that is complete is also self-healing — a sync that failed earlier, or a database
 * created before this ever ran, is corrected by the next one.
 *
 * The user list rides along because pgAdmin registers servers per account, and it only learns of an
 * account when that person first opens the console — which would be one visit too late for the
 * servers to be there when they arrive. Sending the roster lets the helper create those accounts up
 * front, exactly as pgAdmin's own webserver login would have.
 */
export function pgAdminPayload(app: FastifyInstance): string {
  const rows = app.db
    .select()
    .from(databases)
    .where(and(eq(databases.engine, 'postgres'), isNull(databases.connectionId)))
    .all();

  const servers: PgAdminServerSpec[] = rows.map((row) => {
    const endpoint = connectionForDatabase(app.db, app.secretBox, row)?.endpoint ?? fallbackEndpoint(row.engine);
    return {
      name: row.name,
      host: endpoint.host,
      port: endpoint.port,
      database: row.name,
      username: row.username,
      password: app.secretBox.decrypt(row.passwordEncrypted),
    };
  });

  const roster = app.db.select({ id: users.id, email: users.email }).from(users).all();

  /**
   * Per-project access (`lib/projectaccess.ts`) applied to the console. Without this, a member
   * scoped to one project would still find every Postgres database on the host saved in their
   * pgAdmin account — with its password already in their passfile — which is a straight bypass of
   * the scope the Databases page enforces.
   *
   * Only SCOPED users appear here; everyone else is absent and gets the full `servers` list, so the
   * payload is empty on an instance that has never scoped anyone. ADDITIVE on purpose: a helper
   * that predates this key (`setup/pgadmin-sync-servers.py` is only installed by `install.sh`, not
   * by a deploy) ignores it and behaves exactly as it does today rather than breaking.
   *
   * Keyed by server name, which is the database name — the sync only ever covers databases on this
   * host, where a Postgres database name is unique by definition.
   */
  const serversByUser: Record<string, string[]> = {};
  for (const user of roster) {
    const allowed = accessibleProjectIds(app.db, user.id);
    if (allowed === null) continue;
    serversByUser[user.email] = rows.filter((row) => row.projectId !== null && allowed.has(row.projectId)).map((row) => row.name);
  }

  return JSON.stringify({ users: roster.map((user) => user.email), servers, serversByUser });
}

/**
 * Pushes the current list to pgAdmin. Never throws and never blocks the caller's own result: a
 * database that was really created has been created whether or not pgAdmin heard about it, and
 * failing the request over a console convenience would be the wrong trade. Failures are logged, and
 * the next sync (any create or drop, or the next restart) rebuilds the list in full.
 */
export async function syncPgAdminServers(app: FastifyInstance): Promise<void> {
  try {
    await app.sysops.syncPgAdminServers(pgAdminPayload(app));
  } catch (err) {
    app.log.error({ err }, 'pgAdmin server sync failed');
  }
}
