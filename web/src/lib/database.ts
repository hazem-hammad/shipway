/**
 * Presentation helpers for provisioned databases, shared by the Databases page and a project's own
 * Database tab so both name an engine and link to its console the same way.
 */
import type { DatabaseListItem, DbEngine, ProjectType } from '../api';

/**
 * The project types a database is offered to: the ones with server-side code that could open a
 * connection. A `static` project has no server to open one from, and `nextjs` is excluded by the
 * same decision that hides its Database tab (`HIDDEN_TABS`, pages/project/ProjectLayout.tsx).
 *
 * One definition, three surfaces — the New Project form, the Databases page's two project pickers,
 * and the project tab strip — so the answer can't drift between where a database is offered and
 * where it can then be managed.
 */
export const DB_CAPABLE_TYPES: readonly ProjectType[] = ['php', 'node'];

export function isDbCapable(type: ProjectType): boolean {
  return DB_CAPABLE_TYPES.includes(type);
}

export const ENGINE_LABEL: Record<DbEngine, string> = {
  mysql: 'MySQL',
  postgres: 'Postgres',
};

/**
 * The console for a database's engine: phpMyAdmin for MySQL, pgAdmin for PostgreSQL. Both are
 * served under paths on the dashboard host, so the browser already carries the Shipway session
 * that nginx checks before letting the request through — no second password to open them.
 *
 * MySQL goes through `/db/signon.php` rather than straight to phpMyAdmin: that shim (installed by
 * `setup/install.sh`, gated by the same session check) reads this database's credentials from the
 * API and hands them to phpMyAdmin's signon auth, so the link lands *inside* the database with no
 * login form. pgAdmin has no equivalent — it works from saved server connections and offers no way
 * to select one from a URL — so Postgres opens it at its root, where the server for this database
 * is already registered and connectable (see `services/pgadmin.ts`).
 */
export function consoleUrl(baseDomain: string, database: Pick<DatabaseListItem, 'id' | 'engine' | 'name'>): string {
  const base = `https://ship.${baseDomain}/db`;
  if (database.engine === 'mysql') {
    return `${base}/signon.php?id=${String(database.id)}`;
  }
  return `${base}/pgadmin/`;
}

/** What the Manage link promises for each engine — see `consoleUrl` for why they differ. */
export function consoleTitle(engine: DbEngine): string {
  return engine === 'mysql'
    ? 'Opens phpMyAdmin signed in to this database'
    : 'Opens pgAdmin, where this database’s server is already registered';
}

/**
 * phpMyAdmin and pgAdmin are installed on this host and configured against its own engines, so the
 * Manage link only means anything for a database that lives here. A database on a registered
 * external server is managed with whatever that provider gives you.
 */
export function hasConsole(database: Pick<DatabaseListItem, 'connectionId'>): boolean {
  return database.connectionId === null;
}
