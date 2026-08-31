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
import { randomBytes } from 'node:crypto';
import { execa } from 'execa';
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
  /**
   * Replays the SQL dump at `sqlPath` into `database` on `target`. Unlike every other method here,
   * the credentials in `target.url` are expected to be the *database's own* user rather than the
   * server admin (see `routes/databases.ts`) — a Postgres dump restored by the admin role would
   * leave every table owned by that role and unreadable to the app, and on MySQL the app user's
   * grants are the right blast radius for someone else's dump either way.
   *
   * Shells out to the engine's own client (`mysql` / `psql`) rather than replaying the file through
   * the driver: a real dump is not a list of statements a driver can take. mysqldump emits
   * `DELIMITER` around triggers and routines, and pg_dump emits `COPY ... FROM stdin` followed by
   * raw rows and a `\.` terminator — both are client-side directives that the wire protocol has no
   * idea about, so the driver route works on toy files and fails on the dumps people actually have.
   */
  importSql(target: DbAdminTarget, database: string, sqlPath: string): Promise<void>;
  /**
   * Writes a plain-SQL dump of `database` on `target` to `sqlPath`, in the form `importSql` reads
   * back — the two are a matched pair, and cloning a project is the one caller that uses both.
   *
   * Like `importSql`, `target.url` carries the DATABASE'S OWN user rather than the server admin:
   * the dump is of one database's contents, and the user that owns them is the one guaranteed to be
   * able to read all of them. Nothing about the source database's NAME is written into the dump
   * (no `CREATE DATABASE`, no `USE`), which is what lets the result be restored into a database
   * called something else — the whole point here, since a clone's database has a new name.
   */
  dumpSql(target: DbAdminTarget, database: string, sqlPath: string): Promise<void>;
}

/** Chars used for generated database passwords: letters + digits only (safe to embed unquoted in
 *  most contexts, and matches the brief's `[A-Za-z0-9]` spec). */
const PASSWORD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PASSWORD_LENGTH = 24;

/**
 * A random `PASSWORD_LENGTH`-char password from `PASSWORD_CHARS`, using `randomBytes` for entropy.
 * Lives here rather than in the create-database route because a database's password is generated in
 * two places now — creating one, and cloning a project's — and the two must not drift.
 */
export function generateDbPassword(): string {
  const bytes = randomBytes(PASSWORD_LENGTH);
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    out += PASSWORD_CHARS[bytes[i]! % PASSWORD_CHARS.length];
  }
  return out;
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
  /** Runs the `mysql`/`psql` client for `importSql`. Defaults to the real `execa`; tests inject a
   * stub to assert on the exact command and environment without a database anywhere in sight. */
  run?: typeof execa;
}

/**
 * How long a dump or an import is given before its client is killed. A database big enough to
 * outlast this is one to move from a shell, not from a browser tab that nginx will have given up on
 * long before (see `setup/templates/nginx-dashboard.conf`'s `proxy_read_timeout`).
 */
const IMPORT_TIMEOUT_MS = 10 * 60 * 1000;

/** The pieces of a `mysql://` / `postgres://` URL the CLI clients take as separate flags. */
interface UrlParts {
  host: string;
  port: string;
  username: string;
  password: string;
}

/** `decodeURIComponent` that yields the raw value rather than throwing on a stray `%` — a local
 * admin URL is assembled by `install.sh` without encoding, so its password may not be valid
 * percent-encoding at all. */
function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Splits a connection URL into the flags a CLI client wants. The counterpart of
 * `services/dbconnections.ts`'s `adminUrl`, which percent-encodes the credentials on the way in. */
function urlParts(url: string, engine: DbEngine): UrlParts {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? String(engine === 'mysql' ? 3306 : 5432) : parsed.port,
    username: decodeUrlPart(parsed.username),
    password: decodeUrlPart(parsed.password),
  };
}

/** The last `count` non-blank lines of `text` — a client's error output ends with the part that
 * says what actually went wrong, and a 50MB dump can produce a lot of preamble before it. */
function lastLines(text: string, count: number): string {
  const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
  return lines.slice(-count).join('\n');
}

/**
 * Turns a failed client run into an error worth showing someone. A missing binary is called out by
 * name — that is an install problem, not a problem with their dump — and everything else is
 * reported as the client's own last words, which for both engines name the offending line number.
 */
function importFailure(bin: string, err: unknown): Error {
  if ((err as { code?: unknown }).code === 'ENOENT') {
    return new Error(`the ${bin} client is not installed on this server, so the dump cannot be imported`);
  }
  if ((err as { timedOut?: unknown }).timedOut === true) {
    return new Error(`${bin} import timed out after ${String(IMPORT_TIMEOUT_MS / 60000)} minutes`);
  }
  const stderr = (err as { stderr?: unknown }).stderr;
  const detail = typeof stderr === 'string' && stderr.trim() !== '' ? lastLines(stderr, 3) : err instanceof Error ? err.message : String(err);
  return new Error(`${bin} import failed: ${detail}`);
}

/** {@link importFailure}'s counterpart for the dump half — same three cases, read from the other end. */
function dumpFailure(bin: string, err: unknown): Error {
  if ((err as { code?: unknown }).code === 'ENOENT') {
    return new Error(`the ${bin} client is not installed on this server, so the database cannot be copied`);
  }
  if ((err as { timedOut?: unknown }).timedOut === true) {
    return new Error(`${bin} timed out after ${String(IMPORT_TIMEOUT_MS / 60000)} minutes`);
  }
  const stderr = (err as { stderr?: unknown }).stderr;
  const detail = typeof stderr === 'string' && stderr.trim() !== '' ? lastLines(stderr, 3) : err instanceof Error ? err.message : String(err);
  return new Error(`${bin} failed: ${detail}`);
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
  private readonly run: typeof execa;

  constructor(deps: DbAdminDeps = {}) {
    this.connectMysql = deps.connectMysql ?? defaultConnectMysql;
    this.connectPg = deps.connectPg ?? defaultConnectPg;
    this.run = deps.run ?? execa;
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

  async importSql(target: DbAdminTarget, database: string, sqlPath: string): Promise<void> {
    assertIdentifier(database, 'database name');
    const parts = urlParts(target.url, target.engine);
    if (target.engine === 'mysql') {
      await this.mysqlImport(target, database, sqlPath, parts);
    } else {
      await this.postgresImport(target, database, sqlPath, parts);
    }
  }

  async dumpSql(target: DbAdminTarget, database: string, sqlPath: string): Promise<void> {
    assertIdentifier(database, 'database name');
    const parts = urlParts(target.url, target.engine);
    if (target.engine === 'mysql') {
      await this.mysqlDump(target, database, sqlPath, parts);
    } else {
      await this.postgresDump(target, database, sqlPath, parts);
    }
  }

  private async mysqlDump(target: DbAdminTarget, database: string, sqlPath: string, parts: UrlParts): Promise<void> {
    // The database is named as a bare argument rather than via `--databases`, which is what keeps
    // `CREATE DATABASE`/`USE` out of the output — see `dumpSql`'s contract. `--no-tablespaces`
    // matters because the dump runs as the database's own user, and the tablespace query mysqldump
    // otherwise issues needs the global PROCESS privilege that user has no reason to hold.
    const args = [
      '--protocol=TCP',
      `--host=${parts.host}`,
      `--port=${parts.port}`,
      `--user=${parts.username}`,
      '--single-transaction',
      '--quick',
      '--no-tablespaces',
      '--routines',
      '--triggers',
      '--default-character-set=utf8mb4',
      ...(target.tls === true ? ['--ssl-mode=REQUIRED'] : []),
      database,
    ];
    try {
      await this.run('mysqldump', args, {
        env: { MYSQL_PWD: parts.password },
        stdout: { file: sqlPath },
        timeout: IMPORT_TIMEOUT_MS,
      });
    } catch (err) {
      throw dumpFailure('mysqldump', err);
    }
  }

  private async postgresDump(target: DbAdminTarget, database: string, sqlPath: string, parts: UrlParts): Promise<void> {
    // `--no-owner`/`--no-acl` because the restore runs as a DIFFERENT role than the dump: the clone's
    // own user owns its database, and replaying `ALTER TABLE ... OWNER TO <source user>` would either
    // fail outright or hand the copy back to the project it was copied from.
    const args = [
      `--host=${parts.host}`,
      `--port=${parts.port}`,
      `--username=${parts.username}`,
      `--dbname=${database}`,
      '--no-password',
      '--no-owner',
      '--no-acl',
      '--format=plain',
      `--file=${sqlPath}`,
    ];
    try {
      await this.run('pg_dump', args, {
        env: { PGPASSWORD: parts.password, ...(target.tls === true ? { PGSSLMODE: 'require' } : {}) },
        stdin: 'ignore',
        timeout: IMPORT_TIMEOUT_MS,
      });
    } catch (err) {
      throw dumpFailure('pg_dump', err);
    }
  }

  private async mysqlImport(target: DbAdminTarget, database: string, sqlPath: string, parts: UrlParts): Promise<void> {
    // `--protocol=TCP` because the endpoint really is a TCP one: pointed at 127.0.0.1 the client
    // would otherwise quietly switch to the unix socket, where the credentials that work over the
    // network may not apply. `--ssl-mode=REQUIRED` encrypts without demanding a locally-trusted CA,
    // matching `DbAdminTarget.tls`'s documented trade.
    const args = [
      '--protocol=TCP',
      `--host=${parts.host}`,
      `--port=${parts.port}`,
      `--user=${parts.username}`,
      `--database=${database}`,
      '--default-character-set=utf8mb4',
      ...(target.tls === true ? ['--ssl-mode=REQUIRED'] : []),
    ];
    try {
      // The password goes through the environment, never argv: a command line is world-readable in
      // `ps` on a host that has other people's app processes on it.
      await this.run('mysql', args, {
        env: { MYSQL_PWD: parts.password },
        stdin: { file: sqlPath },
        timeout: IMPORT_TIMEOUT_MS,
      });
    } catch (err) {
      throw importFailure('mysql', err);
    }
  }

  private async postgresImport(target: DbAdminTarget, database: string, sqlPath: string, parts: UrlParts): Promise<void> {
    // ON_ERROR_STOP is what makes this an import rather than a best-effort sprinkle: without it psql
    // reports every failed statement and still exits 0, so a half-restored database would be
    // reported as a success. `--no-password` keeps a bad password a fast error instead of a client
    // sitting on a prompt no one can see until the timeout.
    const args = [
      `--host=${parts.host}`,
      `--port=${parts.port}`,
      `--username=${parts.username}`,
      `--dbname=${database}`,
      '--no-password',
      '--quiet',
      '--set=ON_ERROR_STOP=1',
      `--file=${sqlPath}`,
    ];
    try {
      await this.run('psql', args, {
        env: { PGPASSWORD: parts.password, ...(target.tls === true ? { PGSSLMODE: 'require' } : {}) },
        stdin: 'ignore',
        timeout: IMPORT_TIMEOUT_MS,
      });
    } catch (err) {
      throw importFailure('psql', err);
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
