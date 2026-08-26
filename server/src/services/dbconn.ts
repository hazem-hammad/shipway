/**
 * Pure database naming + connection-env knowledge, with no driver imports of its own.
 *
 * Split out of `dbprovision.ts` (which pulls in `pg` and `mysql2`) so the three other places that
 * need to know what a provisioned database is *called* and how an app connects to it can share one
 * definition instead of re-deriving it: the deploy-time env template (`deploy/laravel.ts`), the
 * database routes, and the web dashboard — which imports this file directly by relative path, the
 * same arrangement `deploy/envparse.ts` documents (Ruling 1). `dbprovision.ts` re-exports every
 * symbol here, so existing `from '../services/dbprovision.js'` imports keep working unchanged.
 */

export type DbEngine = 'mysql' | 'postgres';

/**
 * Database/role/user name shape. Also doubles as SQL identifier safety: every name interpolated
 * into a `CREATE`/`DROP` statement in `dbprovision.ts` is re-checked against this before being
 * wrapped in backticks/double-quotes, so nothing outside `[a-z0-9_]` (starting with a letter) ever
 * reaches raw SQL text.
 */
export const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Names that are a *system* database on one of the two engines, and so must never be created or
 * dropped as if they were a project's own. `CREATE DATABASE IF NOT EXISTS \`mysql\`` silently
 * succeeds as a no-op and then `GRANT ALL ON \`mysql\`.*` hands a project full read/write on
 * MySQL's user and grant tables; `DROP DATABASE mysql` destroys the server. The `pg_` prefix covers
 * postgres's reserved namespace (`pg_catalog`, `pg_toast`, …) as a family rather than by name.
 *
 * Checked for both engines regardless of which one is being used: nobody needs a project database
 * called `information_schema`, and a name that is dangerous on either engine is not worth allowing
 * on the other.
 */
export const RESERVED_DB_NAMES = [
  'mysql',
  'information_schema',
  'performance_schema',
  'sys',
  'postgres',
  'template0',
  'template1',
] as const;

export function isReservedDbName(name: string): boolean {
  return (RESERVED_DB_NAMES as readonly string[]).includes(name) || name.startsWith('pg_');
}

/** A provisioned database's identifying fields, as needed to render connection env vars. */
export interface DbConnectionInfo {
  name: string;
  username: string;
  password: string;
}

/** The default port each engine listens on. */
export function dbPort(engine: DbEngine): number {
  return engine === 'mysql' ? 3306 : 5432;
}

/** Where an app reaches a database: the host and port its `DB_HOST`/`DB_PORT` point at. */
export interface DbEndpoint {
  host: string;
  port: number;
}

/**
 * The two kinds of database server a database can live on: one of the engines running on this host
 * (the only kind there was before connections existed, still identified by its engine alone), or a
 * registered external server — an RDS instance, a managed Postgres, another box — by row id.
 *
 * `key` is the stable string form both the API and the dashboard pass around, so neither has to
 * carry a kind and an id as two fields that could disagree.
 */
export type DbConnectionRef = { kind: 'local'; engine: DbEngine } | { kind: 'external'; id: number };

export function connectionKey(ref: DbConnectionRef): string {
  return ref.kind === 'local' ? `local:${ref.engine}` : `external:${String(ref.id)}`;
}

/** Parses a `connectionKey`. Returns null for anything else, so a bad value from a client is a 400
 * rather than a lookup against nonsense. */
export function parseConnectionKey(key: string): DbConnectionRef | null {
  if (key === 'local:mysql') return { kind: 'local', engine: 'mysql' };
  if (key === 'local:postgres') return { kind: 'local', engine: 'postgres' };
  const external = /^external:([1-9][0-9]*)$/.exec(key);
  if (external) return { kind: 'external', id: Number(external[1]) };
  return null;
}

/** The key for a stored database row, whose `connectionId` is null when it lives on this host. */
export function databaseConnectionKey(row: { engine: DbEngine; connectionId: number | null }): string {
  return connectionKey(row.connectionId === null ? { kind: 'local', engine: row.engine } : { kind: 'external', id: row.connectionId });
}

/** Where the host's own engines listen. Databases on them predate connections and are stored with a
 * null `connectionId`, so this is the endpoint they resolve to. */
export function localEndpoint(engine: DbEngine): DbEndpoint {
  return { host: '127.0.0.1', port: dbPort(engine) };
}

/** Laravel's driver name for an engine (`pgsql`, not `postgres`) — the value `DB_CONNECTION` takes. */
export function dbConnectionName(engine: DbEngine): string {
  return engine === 'mysql' ? 'mysql' : 'pgsql';
}

/**
 * Renders the Laravel-convention `DB_*` env vars for connecting to a database. `DB_CONNECTION` uses
 * Laravel's driver names (`mysql` / `pgsql`, not `postgres`). `endpoint` is where the app dials —
 * defaulting to this host, which is where every database lived before external connections existed
 * and where a null `connectionId` still means.
 */
export function connectionEnv(engine: DbEngine, db: DbConnectionInfo, endpoint: DbEndpoint = localEndpoint(engine)): Record<string, string> {
  return {
    DB_CONNECTION: dbConnectionName(engine),
    DB_HOST: endpoint.host,
    DB_PORT: String(endpoint.port),
    DB_DATABASE: db.name,
    DB_USERNAME: db.username,
    DB_PASSWORD: db.password,
  };
}
