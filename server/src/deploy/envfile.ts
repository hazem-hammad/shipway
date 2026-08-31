/**
 * Pure string logic for the project `.env` Shipway writes on each deploy:
 * the user-edited env text plus a "managed block" of SMTP vars (and later,
 * injected DB creds) that Shipway owns and regenerates every run.
 *
 * Nothing here touches the filesystem — callers read the current `.env`
 * text, pass it through `buildEnvFile`, and write the result back via
 * `SysOps.installFile`.
 */
import { isValidSesRegion, SES_SMTP_ENCRYPTION, SES_SMTP_PORT, sesSmtpHost } from '../lib/ses.js';

/** SMTP connection details for `smtpMode: 'custom'`. */
export interface SmtpConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  fromAddress?: string;
  encryption?: string;
}

/**
 * Connection details for `smtpMode: 'ses'`. No host or port: those are DERIVED from `region`
 * (`lib/ses.ts`), so a project's stored config can never point the app at a host that isn't SES.
 * The credentials are the SES *SMTP* username/password minted in the SES console — not a raw AWS
 * access key/secret, which SMTP auth rejects. `fromAddress` must be an identity verified in SES,
 * which is why it's required here where `SmtpConfig` leaves it optional.
 */
export interface SesSmtpConfig {
  region: string;
  username: string;
  password: string;
  fromAddress: string;
}

export interface BuildManagedVarsInput {
  smtpMode: 'mailpit' | 'custom' | 'ses' | 'none';
  /** Required for `smtpMode: 'custom'`, ignored otherwise. */
  smtpConfig?: SmtpConfig;
  /** Required for `smtpMode: 'ses'`, ignored otherwise. */
  sesConfig?: SesSmtpConfig;
  /**
   * Absolute path of the SQLite file a database-less Laravel project falls back to, or `undefined`
   * when the project has a real database (or isn't php at all).
   *
   * Managed rather than written into the env template because the path depends on the host's apps
   * directory, which the browser-rendered template can't know — and because it must follow the
   * project if that directory ever changes. Like every managed var, a user-defined `DB_DATABASE`
   * suppresses it, so attaching a real database later just works.
   */
  sqliteDatabasePath?: string;
}

/** SMTP + injected DB creds, already resolved. */
export interface ManagedVars {
  vars: Record<string, string>;
}

/**
 * Where a database-less Laravel project's SQLite file lives: the project's SHARED directory, not the
 * release. Releases are rotated and deleted, so a file under `current/database/` would take the
 * project's data with it on the next deploy or prune.
 */
export function sqlitePath(appsDir: string, slug: string): string {
  return `${appsDir}/${slug}/shared/database.sqlite`;
}

const MARKER_START = '# >>> shipway managed — do not edit below >>>';
const MARKER_END = '# <<< shipway managed <<<';

/**
 * Resolves the managed env vars Shipway owns for a project's mail setup.
 *
 * - `mailpit` → points the app at the local mailpit SMTP catcher.
 * - `custom` → maps `smtpConfig` onto `MAIL_*` (omitting keys whose source
 *   field is `undefined`) plus `SMTP_HOST`/`SMTP_PORT` aliases. Throws if
 *   `smtpConfig` is missing.
 * - `ses` → the same `MAIL_*` shape, but host/port/encryption are derived from
 *   the region rather than supplied, so the app can only ever be pointed at a
 *   real SES endpoint. Throws if `sesConfig` is missing or its region is
 *   malformed — writing a bogus host into a project's `.env` would fail at
 *   send time, far from the cause.
 * - `none` → no managed vars at all.
 */
export function buildManagedVars(p: BuildManagedVarsInput): Record<string, string> {
  return { ...smtpManagedVars(p), ...sqliteManagedVars(p.sqliteDatabasePath) };
}

/**
 * The SQLite fallback pair. `DB_CONNECTION` is managed alongside the path deliberately: writing a
 * path that only means anything under the sqlite driver, while leaving the driver to whatever
 * `config/database.php` defaults to, is incoherent — it works on a Laravel version that defaults to
 * sqlite and silently doesn't on one that defaults to mysql. Managing both also fixes projects
 * created before this existed, whose stored env has no `DB_CONNECTION` at all.
 *
 * Both are ordinary managed vars, so a user-defined `DB_CONNECTION` (a project pointed at a real
 * database) suppresses them exactly as it suppresses any other.
 */
function sqliteManagedVars(sqliteDatabasePath: string | undefined): Record<string, string> {
  if (sqliteDatabasePath === undefined) return {};
  return { DB_CONNECTION: 'sqlite', DB_DATABASE: sqliteDatabasePath };
}

/** The `MAIL_*`/`SMTP_*` half of the managed block, by smtp mode. */
function smtpManagedVars(p: BuildManagedVarsInput): Record<string, string> {
  switch (p.smtpMode) {
    case 'mailpit':
      return {
        MAIL_MAILER: 'smtp',
        MAIL_HOST: '127.0.0.1',
        MAIL_PORT: '1025',
        MAIL_ENCRYPTION: 'null',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: '1025',
      };

    case 'custom': {
      if (!p.smtpConfig) {
        throw new Error('smtpConfig is required when smtpMode is "custom"');
      }
      const { host, port, username, password, fromAddress, encryption } = p.smtpConfig;

      const vars: Record<string, string> = {
        MAIL_MAILER: 'smtp',
        MAIL_HOST: host,
        MAIL_PORT: String(port),
      };
      if (username !== undefined) vars.MAIL_USERNAME = username;
      if (password !== undefined) vars.MAIL_PASSWORD = password;
      if (fromAddress !== undefined) vars.MAIL_FROM_ADDRESS = fromAddress;
      if (encryption !== undefined) vars.MAIL_ENCRYPTION = encryption;
      vars.SMTP_HOST = host;
      vars.SMTP_PORT = String(port);

      return vars;
    }

    case 'ses': {
      if (!p.sesConfig) {
        throw new Error('sesConfig is required when smtpMode is "ses"');
      }
      const { region, username, password, fromAddress } = p.sesConfig;
      if (!isValidSesRegion(region)) {
        throw new Error(`"${region}" is not a valid AWS region`);
      }

      const host = sesSmtpHost(region);
      const port = String(SES_SMTP_PORT);

      return {
        MAIL_MAILER: 'smtp',
        MAIL_HOST: host,
        MAIL_PORT: port,
        MAIL_USERNAME: username,
        MAIL_PASSWORD: password,
        MAIL_FROM_ADDRESS: fromAddress,
        MAIL_ENCRYPTION: SES_SMTP_ENCRYPTION,
        SMTP_HOST: host,
        SMTP_PORT: port,
      };
    }

    case 'none':
      return {};
  }
}

/** Matches a `KEY=` assignment line; leading whitespace allowed, comments never match. */
const USER_KEY_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Removes an existing managed block (delimiters inclusive) from `text`, if present. */
function stripManagedBlock(text: string): string {
  const lines = text.split('\n');
  const startIdx = lines.indexOf(MARKER_START);
  if (startIdx === -1) {
    return text;
  }
  const endIdx = lines.indexOf(MARKER_END, startIdx);
  if (endIdx === -1) {
    return text;
  }

  // Also drop the one optional blank line immediately preceding the block.
  const removeFrom = startIdx > 0 && lines[startIdx - 1] === '' ? startIdx - 1 : startIdx;

  return [...lines.slice(0, removeFrom), ...lines.slice(endIdx + 1)].join('\n');
}

/** Collects the set of keys the user already assigns in `text` (comments ignored). */
function parseUserKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const m = USER_KEY_RE.exec(line);
    if (m) {
      keys.add(m[1] as string);
    }
  }
  return keys;
}

/**
 * `KEY=value`, quoting `value` when it contains a space, `#`, `"`, or `\`. Quoted values have
 * backslashes and double quotes escaped (`\\` and `\"`) so the emitted line round-trips through any
 * shell-style `.env` parser (e.g. a password containing `"` or `\`).
 */
function formatAssignment(key: string, value: string): string {
  const needsQuotes = /[ #"\\]/.test(value);
  if (!needsQuotes) {
    return `${key}=${value}`;
  }
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${key}="${escaped}"`;
}

function renderManagedBlock(entries: Array<[string, string]>): string {
  const body = entries.map(([key, value]) => formatAssignment(key, value));
  return [MARKER_START, ...body, MARKER_END].join('\n');
}

function ensureTrailingNewline(text: string): string {
  if (text === '') {
    return '';
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Builds the full `.env` text: `userEnv` verbatim, with any existing
 * managed block stripped first (idempotency), followed by a fresh managed
 * block for the `managed` vars the user hasn't already defined themselves
 * (user wins). If no managed keys survive, `userEnv` is returned unchanged
 * — no empty block is ever emitted. The result always ends in exactly one
 * trailing newline; user text is otherwise byte-preserved.
 */
export function buildEnvFile(userEnv: string, managed: Record<string, string>): string {
  const stripped = stripManagedBlock(userEnv);
  const userKeys = parseUserKeys(stripped);

  const survivingEntries = Object.entries(managed).filter(([key]) => !userKeys.has(key));

  if (survivingEntries.length === 0) {
    return ensureTrailingNewline(stripped);
  }

  const block = renderManagedBlock(survivingEntries);
  const base = stripped.replace(/\n+$/, '');
  const combined = base === '' ? block : `${base}\n\n${block}`;

  return ensureTrailingNewline(combined);
}
