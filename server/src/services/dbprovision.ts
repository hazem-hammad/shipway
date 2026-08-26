/**
 * Provisions/deprovisions MySQL and Postgres databases on a *target* — a database server plus the
 * admin credentials to act on it, resolved by `services/dbconnections.ts` from either this host's
 * own engines (settings' `mysql_admin_url` / `postgres_admin_url`, written by the install
 * bootstrap) or a registered external connection.
 *
 * `DbAdmin` is the seam: routes depend on the interface, tests inject a fake that just records
 * calls, and `makeDbAdmin` builds the real mysql2/pg-backed implementation. Nothing here reads
 * settings or the database — a target arrives fully formed, which is what lets the same two SQL
 * paths serve a local socket and an RDS instance without knowing the difference.
 */
import { Client as PgClient } from 'pg';
import { createConnection as createMysqlConnection } from 'mysql2/promise';
import { IDENTIFIER_RE, type DbEngine } from './dbconn.js';

// The pure half of this module's vocabulary — engine names, the identifier shape, and the `DB_*`
// vars an app connects with — lives in `dbconn.ts`, which imports no drivers so the env template
// and the web dashboard can share it (see that file's doc comment). Re-exported here so existing
// importers of this module are unaffected.
export {
  IDENTIFIER_RE,
  RESERVED_DB_NAMES,
  connectionEnv,
  connectionKey,
  databaseConnectionKey,
  dbConnectionName,
  dbPort,
  isReservedDbName,
  localEndpoint,
  parseConnectionKey,
  type DbConnectionInfo,
  type DbConnectionRef,
  type DbEndpoint,
  type DbEngine,
} from './dbconn.js';

/**
 * A database server to act on, with the admin credentials to do it. Built by
 * `services/dbconnections.ts` — never assembled here, so this module has exactly one way to reach a
 * server whether it is on localhost or across the internet.
 */
export interface DbAdminTarget {
  engine: DbEngine;
  /** Admin connection URL (`mysql://user:pass@host:port` / `postgres://user:pass@host:port`). */
  url: string;
  /**
   * Connect over TLS without demanding a locally-trusted CA. Managed instances present their own
   * CA, so verifying it would fail on a stock host; the alternative is not connecting at all. The
   * password still never crosses the wire in the clear, which is the property that matters here.
   */
  tls?: boolean;
}

export interface DbAdmin {
  createDatabase(target: DbAdminTarget, name: string, user: string, password: string): Promise<void>;
  /**
   * Drops `name` and `user`. With `opts.keepDatabase`, the user is dropped but the database itself
   * is left alone — the caller's escape hatch for cleaning up a record whose name turned out to be
   * a system database (see `isReservedDbName`), where issuing the `DROP DATABASE` would wreck the
   * server rather than tidy up a project.
   */
  dropDatabase(target: DbAdminTarget, name: string, user: string, opts?: { keepDatabase?: boolean }): Promise<void>;
  /**
   * Opens an admin connection and runs `SELECT 1`, then closes it. What "Test connection" on the
   * Databases page calls, and what a new connection is checked with before it is ever stored —
   * credentials that don't work are worth refusing at the point someone can still fix the typo.
   */
  testConnection(target: DbAdminTarget): Promise<void>;
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`Invalid ${label}: "${value}"`);
  }
}

/** Escapes a literal for interpolation inside a single-quoted MySQL string (backslash + quote). */
function escapeMysqlLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Escapes a literal for interpolation inside a single-quoted Postgres string (quote doubling). */
function escapePgLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * The slice of a database connection this module uses — `mysql2`'s connection and `pg`'s `Client`
 * both already satisfy it. It exists so tests can record the exact SQL each path issues: the
 * statements *are* the logic here (the `GRANT` in `postgresCreate` is the whole difference between
 * a working Postgres database and `must be able to SET ROLE`), and nothing else in the suite can
 * see them.
 */
export interface SqlConnection {
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
}

export interface DbAdminDeps {
  /** Opens an admin connection to mysql. Defaults to `mysql2/promise`'s `createConnection`. */
  connectMysql?: (url: string, tls: boolean) => Promise<SqlConnection>;
  /** Opens (and connects) an admin `pg` client. Defaults to a real `pg.Client`. */
  connectPg?: (url: string, tls: boolean) => Promise<SqlConnection>;
}

async function defaultConnectMysql(url: string, tls: boolean): Promise<SqlConnection> {
  // Two calls rather than one with a union argument: `createConnection`'s string and options
  // overloads don't unify, and the options form needs the URL under `uri`.
  if (tls) {
    return createMysqlConnection({ uri: url, ssl: { rejectUnauthorized: false } });
  }
  return createMysqlConnection(url);
}

async function defaultConnectPg(url: string, tls: boolean): Promise<SqlConnection> {
  const client = new PgClient({ connectionString: url, ...(tls ? { ssl: { rejectUnauthorized: false } } : {}) });
  await client.connect();
  return client;
}

/**
 * Best-effort undo of a half-made database or role. Never throws: the caller is already on its way
 * to reporting the original failure, which is the one worth surfacing — a cleanup that fails too
 * must not replace it with a more confusing message.
 */
async function rollback(conn: SqlConnection, sql: string): Promise<void> {
  try {
    await conn.query(sql);
  } catch {
    // Swallowed deliberately; see above.
  }
}

/**
 * Real `DbAdmin`, backed by `mysql2/promise` (mysql) and `pg` (postgres). Each call opens its own
 * connection to the target it was handed and always closes it in `finally`, whether the statements
 * succeeded or not — nothing is pooled or cached, so a credential change takes effect on the next
 * call with no restart.
 */
class RealDbAdmin implements DbAdmin {
  private readonly connectMysql: (url: string, tls: boolean) => Promise<SqlConnection>;
  private readonly connectPg: (url: string, tls: boolean) => Promise<SqlConnection>;

  constructor(deps: DbAdminDeps = {}) {
    this.connectMysql = deps.connectMysql ?? defaultConnectMysql;
    this.connectPg = deps.connectPg ?? defaultConnectPg;
  }

  async createDatabase(target: DbAdminTarget, name: string, user: string, password: string): Promise<void> {
    assertIdentifier(name, 'database name');
    assertIdentifier(user, 'database user');

    if (target.engine === 'mysql') {
      await this.mysqlCreate(target, name, user, password);
    } else {
      await this.postgresCreate(target, name, user, password);
    }
  }

  async dropDatabase(target: DbAdminTarget, name: string, user: string, opts?: { keepDatabase?: boolean }): Promise<void> {
    assertIdentifier(name, 'database name');
    assertIdentifier(user, 'database user');

    if (target.engine === 'mysql') {
      await this.mysqlDrop(target, name, user, opts?.keepDatabase === true);
    } else {
      await this.postgresDrop(target, name, user, opts?.keepDatabase === true);
    }
  }

  async testConnection(target: DbAdminTarget): Promise<void> {
    const conn = await this.connect(target);
    try {
      await conn.query('SELECT 1');
    } finally {
      await conn.end();
    }
  }

  private async connect(target: DbAdminTarget): Promise<SqlConnection> {
    const tls = target.tls === true;
    return target.engine === 'mysql' ? this.connectMysql(target.url, tls) : this.connectPg(target.url, tls);
  }

  private async mysqlCreate(target: DbAdminTarget, name: string, user: string, password: string): Promise<void> {
    const conn = await this.connect(target);
    try {
      const pw = escapeMysqlLiteral(password);
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
      try {
        await conn.query(`CREATE USER '${user}'@'%' IDENTIFIED BY '${pw}'`);
        await conn.query(`GRANT ALL ON \`${name}\`.* TO '${user}'@'%'`);
        await conn.query('FLUSH PRIVILEGES');
      } catch (err) {
        // Nothing half-made is left behind. This method throws before any row is inserted, so a
        // database created here without its user would be invisible to the dashboard while still
        // occupying the name — and the obvious next move, retrying with the same name, would then
        // fail forever. See `postgresCreate` for the same trap, which a real install fell into.
        await rollback(conn, `DROP DATABASE IF EXISTS \`${name}\``);
        throw err;
      }
    } finally {
      await conn.end();
    }
  }

  private async mysqlDrop(target: DbAdminTarget, name: string, user: string, keepDatabase: boolean): Promise<void> {
    const conn = await this.connect(target);
    try {
      if (!keepDatabase) {
        await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
      }
      await conn.query(`DROP USER IF EXISTS '${user}'@'%'`);
    } finally {
      await conn.end();
    }
  }

  private async postgresCreate(target: DbAdminTarget, name: string, user: string, password: string): Promise<void> {
    const client = await this.connect(target);
    try {
      const pw = escapePgLiteral(password);
      await client.query(`CREATE ROLE "${user}" LOGIN PASSWORD '${pw}'`);
      try {
        // PostgreSQL 16 (what Ubuntu 24.04 ships) requires the creator to be able to SET ROLE to a
        // database's owner. A CREATEROLE admin is auto-granted membership in roles it creates, but
        // with `set_option = false`, so `CREATE DATABASE ... OWNER` below fails with
        // `42501: must be able to SET ROLE "<user>"` — which surfaced as a blanket "database
        // provisioning failed" for every Postgres database. An explicit GRANT adds a membership row
        // that does carry SET.
        //
        // Written without `WITH SET TRUE` deliberately: that spelling is PG16+ only and would be a
        // syntax error on 15 and earlier, whereas the plain form grants SET on 16 and is valid
        // everywhere. `DROP ROLE` in postgresDrop still works with this membership in place.
        await client.query(`GRANT "${user}" TO CURRENT_USER`);
        await client.query(`CREATE DATABASE "${name}" OWNER "${user}"`);
      } catch (err) {
        // Without this, a failed create leaves the role behind and every retry with the same name
        // dies at `CREATE ROLE` ("role already exists") — one bad attempt turning a name into one
        // the dashboard can never use again. That is exactly what happened on this install while
        // the SET ROLE bug above was live: three 502s, three orphaned roles.
        await rollback(client, `DROP ROLE IF EXISTS "${user}"`);
        throw err;
      }
    } finally {
      await client.end();
    }
  }

  private async postgresDrop(target: DbAdminTarget, name: string, user: string, keepDatabase: boolean): Promise<void> {
    const client = await this.connect(target);
    try {
      if (!keepDatabase) {
        await client.query(`DROP DATABASE IF EXISTS "${name}"`);
      }
      await client.query(`DROP ROLE IF EXISTS "${user}"`);
    } finally {
      await client.end();
    }
  }
}

/**
 * Builds the real `DbAdmin`. Constructing it never opens a connection — nothing happens on the
 * network until a method is called with a target, and each call connects and disconnects on its own.
 */
export function makeDbAdmin(deps: DbAdminDeps = {}): DbAdmin {
  return new RealDbAdmin(deps);
}
