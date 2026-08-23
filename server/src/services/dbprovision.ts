/**
 * Provisions/deprovisions per-project MySQL and Postgres databases on the host, using admin
 * credentials stored in settings (`mysql_admin_url` / `postgres_admin_url`, written by the install
 * bootstrap — see Task 26). `DbAdmin` is the seam: routes depend on the interface, tests inject a
 * fake that just records calls, and `makeDbAdmin` builds the real mysql2/pg-backed implementation.
 */
import { Client as PgClient } from 'pg';
import { createConnection as createMysqlConnection } from 'mysql2/promise';

export type DbEngine = 'mysql' | 'postgres';

export interface DbAdmin {
  createDatabase(engine: DbEngine, name: string, user: string, password: string): Promise<void>;
  dropDatabase(engine: DbEngine, name: string, user: string): Promise<void>;
}

/**
 * Database/role/user name shape. Also doubles as SQL identifier safety: every name interpolated
 * into a `CREATE`/`DROP` statement below is re-checked against this before being wrapped in
 * backticks/double-quotes, so nothing outside `[a-z0-9_]` (starting with a letter) ever reaches raw
 * SQL text.
 */
export const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,31}$/;

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

export interface DbAdminSettings {
  mysqlUrl?: string;
  postgresUrl?: string;
}

/**
 * Real `DbAdmin`, backed by `mysql2/promise` (mysql) and `pg` (postgres) using admin connection
 * URLs read fresh on every call via `getSettings` (so a credential change doesn't require a
 * restart). Each call opens its own connection and always closes it in `finally`, whether the
 * statements succeeded or not.
 */
class RealDbAdmin implements DbAdmin {
  constructor(private readonly getSettings: () => DbAdminSettings) {}

  async createDatabase(engine: DbEngine, name: string, user: string, password: string): Promise<void> {
    assertIdentifier(name, 'database name');
    assertIdentifier(user, 'database user');

    if (engine === 'mysql') {
      await this.mysqlCreate(name, user, password);
    } else {
      await this.postgresCreate(name, user, password);
    }
  }

  async dropDatabase(engine: DbEngine, name: string, user: string): Promise<void> {
    assertIdentifier(name, 'database name');
    assertIdentifier(user, 'database user');

    if (engine === 'mysql') {
      await this.mysqlDrop(name, user);
    } else {
      await this.postgresDrop(name, user);
    }
  }

  private mysqlAdminUrl(): string {
    const url = this.getSettings().mysqlUrl;
    if (!url) {
      throw new Error('mysql admin credentials not configured');
    }
    return url;
  }

  private postgresAdminUrl(): string {
    const url = this.getSettings().postgresUrl;
    if (!url) {
      throw new Error('postgres admin credentials not configured');
    }
    return url;
  }

  private async mysqlCreate(name: string, user: string, password: string): Promise<void> {
    const conn = await createMysqlConnection(this.mysqlAdminUrl());
    try {
      const pw = escapeMysqlLiteral(password);
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
      await conn.query(`CREATE USER '${user}'@'%' IDENTIFIED BY '${pw}'`);
      await conn.query(`GRANT ALL ON \`${name}\`.* TO '${user}'@'%'`);
      await conn.query('FLUSH PRIVILEGES');
    } finally {
      await conn.end();
    }
  }

  private async mysqlDrop(name: string, user: string): Promise<void> {
    const conn = await createMysqlConnection(this.mysqlAdminUrl());
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await conn.query(`DROP USER IF EXISTS '${user}'@'%'`);
    } finally {
      await conn.end();
    }
  }

  private async postgresCreate(name: string, user: string, password: string): Promise<void> {
    const client = new PgClient({ connectionString: this.postgresAdminUrl() });
    await client.connect();
    try {
      const pw = escapePgLiteral(password);
      await client.query(`CREATE ROLE "${user}" LOGIN PASSWORD '${pw}'`);
      await client.query(`CREATE DATABASE "${name}" OWNER "${user}"`);
    } finally {
      await client.end();
    }
  }

  private async postgresDrop(name: string, user: string): Promise<void> {
    const client = new PgClient({ connectionString: this.postgresAdminUrl() });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS "${name}"`);
      await client.query(`DROP ROLE IF EXISTS "${user}"`);
    } finally {
      await client.end();
    }
  }
}

/**
 * Builds the real `DbAdmin`. `getSettings` is called fresh on every `createDatabase`/
 * `dropDatabase` call (not cached here), so it should read straight from settings (e.g.
 * `getSetting(db, 'mysql_admin_url')` / `getSetting(db, 'postgres_admin_url')`). Constructing the
 * returned `DbAdmin` never itself opens a connection — nothing happens on the network until a
 * method is actually called.
 */
export function makeDbAdmin(getSettings: () => DbAdminSettings): DbAdmin {
  return new RealDbAdmin(getSettings);
}

/** A provisioned database's identifying fields, as needed to render connection env vars. */
export interface DbConnectionInfo {
  name: string;
  username: string;
  password: string;
}

/**
 * Renders the Laravel-convention `DB_*` env vars for connecting to a provisioned database.
 * `DB_CONNECTION` uses Laravel's driver names (`mysql` / `pgsql`, not `postgres`); host is always
 * `127.0.0.1` since Shipway only provisions databases on the local host.
 */
export function connectionEnv(engine: DbEngine, db: DbConnectionInfo): Record<string, string> {
  return {
    DB_CONNECTION: engine === 'mysql' ? 'mysql' : 'pgsql',
    DB_HOST: '127.0.0.1',
    DB_PORT: engine === 'mysql' ? '3306' : '5432',
    DB_DATABASE: db.name,
    DB_USERNAME: db.username,
    DB_PASSWORD: db.password,
  };
}
