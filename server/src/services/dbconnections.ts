/**
 * The one place that knows a database server can be either of this host's own engines or a
 * registered external one, and flattens that into a single list everything else works from.
 *
 * The host's engines are not rows in `db_connections`: they come from the admin URLs `install.sh`
 * writes into settings (`mysql_admin_url` / `postgres_admin_url`). Migrating those live secrets
 * into the table would buy nothing — every consumer wants a resolved connection, not a storage
 * location — so the split is absorbed here and nowhere else. `resolveConnection` is what routes
 * call; `DbAdminTarget` is what comes out and goes straight to `dbprovision.ts`.
 */
import { eq } from 'drizzle-orm';
import type { ShipwayDb } from '../db/index.js';
import { dbConnections } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import type { SecretBox } from '../lib/secretbox.js';
import {
  connectionKey,
  dbPort,
  localEndpoint,
  parseConnectionKey,
  type DbAdminTarget,
  type DbConnectionRef,
  type DbEndpoint,
  type DbEngine,
} from './dbprovision.js';

/** A database server, resolved: how it is displayed, where apps reach it, and how Shipway acts on it. */
export interface ResolvedConnection {
  /** Stable string id (`local:mysql`, `external:7`) — what the API and the dashboard pass around. */
  key: string;
  kind: 'local' | 'external';
  /** `db_connections.id`, or null for one of this host's engines. This is what a database row stores. */
  id: number | null;
  name: string;
  engine: DbEngine;
  /** Where an app connects — becomes `DB_HOST`/`DB_PORT`. */
  endpoint: DbEndpoint;
  /** Admin credentials, for provisioning. Never leaves the server. */
  target: DbAdminTarget;
}

/** The connection as the API describes it: everything but the admin credentials. */
export interface ConnectionSummary {
  key: string;
  kind: 'local' | 'external';
  id: number | null;
  name: string;
  engine: DbEngine;
  host: string;
  port: number;
  tls: boolean;
}

export function toSummary(connection: ResolvedConnection): ConnectionSummary {
  return {
    key: connection.key,
    kind: connection.kind,
    id: connection.id,
    name: connection.name,
    engine: connection.engine,
    host: connection.endpoint.host,
    port: connection.endpoint.port,
    tls: connection.target.tls === true,
  };
}

const LOCAL_ADMIN_SETTING: Record<DbEngine, 'mysql_admin_url' | 'postgres_admin_url'> = {
  mysql: 'mysql_admin_url',
  postgres: 'postgres_admin_url',
};

const LOCAL_NAME: Record<DbEngine, string> = {
  mysql: 'MySQL on this server',
  postgres: 'PostgreSQL on this server',
};

/**
 * Builds an admin URL from parts. The password is percent-encoded: a `@`, `/` or `#` in an admin
 * password would otherwise be read as URL structure and the connection would fail somewhere
 * confusing (or, worse, connect somewhere else). Managed instances hand out exactly such passwords.
 */
export function adminUrl(engine: DbEngine, host: string, port: number, username: string, password: string): string {
  const scheme = engine === 'mysql' ? 'mysql' : 'postgres';
  const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  return `${scheme}://${auth}@${host}:${String(port)}`;
}

/** One of this host's engines, or null when the installer never configured admin credentials for it. */
function localConnection(db: ShipwayDb, engine: DbEngine): ResolvedConnection | null {
  const url = getSetting<string>(db, LOCAL_ADMIN_SETTING[engine]);
  if (!url) return null;
  return {
    key: connectionKey({ kind: 'local', engine }),
    kind: 'local',
    id: null,
    name: LOCAL_NAME[engine],
    engine,
    endpoint: localEndpoint(engine),
    target: { engine, url },
  };
}

function externalConnection(row: typeof dbConnections.$inferSelect, secretBox: SecretBox): ResolvedConnection {
  const password = secretBox.decrypt(row.adminPasswordEncrypted);
  return {
    key: connectionKey({ kind: 'external', id: row.id }),
    kind: 'external',
    id: row.id,
    name: row.name,
    engine: row.engine,
    endpoint: { host: row.host, port: row.port },
    target: { engine: row.engine, url: adminUrl(row.engine, row.host, row.port, row.adminUsername, password), tls: row.tls },
  };
}

/**
 * Every connection a database can be put on, host engines first. An engine with no admin URL is
 * left out rather than listed as broken: it cannot take a database, so offering it only converts a
 * clear absence into a 502 later.
 */
export function listConnections(db: ShipwayDb, secretBox: SecretBox): ResolvedConnection[] {
  const local = (['mysql', 'postgres'] as const).map((engine) => localConnection(db, engine)).filter((row) => row !== null);
  const external = db.select().from(dbConnections).all().map((row) => externalConnection(row, secretBox));
  return [...local, ...external];
}

/** Resolves a `connectionKey`. Null for an unparseable key, an unregistered id, or a host engine
 * with no admin credentials — all of which are "there is no such connection" to a caller. */
export function resolveConnection(db: ShipwayDb, secretBox: SecretBox, key: string): ResolvedConnection | null {
  const ref = parseConnectionKey(key);
  if (ref === null) return null;
  return resolveRef(db, secretBox, ref);
}

export function resolveRef(db: ShipwayDb, secretBox: SecretBox, ref: DbConnectionRef): ResolvedConnection | null {
  if (ref.kind === 'local') return localConnection(db, ref.engine);
  const row = db.select().from(dbConnections).where(eq(dbConnections.id, ref.id)).get();
  return row ? externalConnection(row, secretBox) : null;
}

/**
 * The connection a stored database lives on. A null `connectionId` means one of this host's engines
 * — every database provisioned before connections existed, and every one provisioned locally since.
 */
export function connectionForDatabase(
  db: ShipwayDb,
  secretBox: SecretBox,
  row: { engine: DbEngine; connectionId: number | null },
): ResolvedConnection | null {
  return resolveRef(db, secretBox, row.connectionId === null ? { kind: 'local', engine: row.engine } : { kind: 'external', id: row.connectionId });
}

/**
 * The endpoint to render `DB_*` vars against when the connection can't be resolved — a database
 * whose external connection was deleted out from under it, which `onDelete: 'restrict'` prevents,
 * or a host engine whose admin URL was removed after the fact. The credentials in the env are still
 * the database's real ones; only the host/port are a best guess, and the host's own engine is the
 * only guess worth making.
 */
export function fallbackEndpoint(engine: DbEngine): DbEndpoint {
  return { host: '127.0.0.1', port: dbPort(engine) };
}
