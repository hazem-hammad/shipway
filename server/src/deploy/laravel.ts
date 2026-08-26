/**
 * The PHP/Laravel starting point Shipway hands a brand-new project: a `.env` that boots on the
 * first request, and the deploy commands that belong with it.
 *
 * Why this exists: a freshly imported Laravel repo has no `.env` (it's gitignored), and Laravel's
 * response to a missing `APP_KEY` — or a `SESSION_DRIVER`/`CACHE_STORE` pointing at a service that
 * isn't there — is a bare 500 with nothing in the browser to explain it. So New Project offers a
 * complete env up front, already pointed at this server's redis and mailpit, and the user edits it
 * before the first deploy rather than debugging a white page after it.
 *
 * Everything here is pure string logic with no filesystem or network access — the web dashboard
 * imports this file directly by relative path (the arrangement `envparse.ts` documents under Ruling
 * 1), so New Project can render the same env text the server would, live, as the user types.
 * `buildPhpEnv` deliberately takes an `appKey` rather than generating one: a template that
 * regenerated its key on every keystroke would hand the user a different key than the one they
 * were looking at. Callers generate once (`generateAppKey`) and pass it in.
 *
 * Two decisions worth knowing about, both in service of "no 500 on the first request":
 *
 *  - Drivers degrade to what's actually running. `QUEUE_CONNECTION` is `redis` only when this
 *    server has redis (`redis_info`), else `sync`; `CACHE_STORE` is `database` only when the
 *    project is getting a database (whose `cache` table `php artisan migrate` creates), else
 *    `file`. `SESSION_DRIVER` is always `file` — the one driver that needs nothing at all.
 *  - `APP_ENV=local` / `APP_DEBUG=true`, matching what this dashboard is for (intcore's testing
 *    server): a stack trace in the browser beats a blank 500. The template says so in a comment,
 *    so nobody ships it to production by accident.
 */
import { serializeEnv, type EnvExtra, type EnvRow, formatEnvAssignment } from './envparse.js';
import { connectionEnv, dbPort, type DbConnectionInfo, type DbEngine } from '../services/dbconn.js';

/** This server's redis, as stored in the `redis_info` setting by the install bootstrap. */
export interface RedisTarget {
  host: string;
  port: number;
  password?: string | null;
}

/** This server's mailpit SMTP catch-all, as stored in the `mailpit_info` setting. */
export interface MailTarget {
  host: string;
  port: number;
}

/** The database this project connects to, whose credentials go straight into the env. */
export interface DbTarget extends DbConnectionInfo {
  engine: DbEngine;
  /**
   * False when the project is being pointed at a database that already exists rather than one
   * created with it — the vars are identical either way, so this only changes the comment above the
   * block. Defaults to true.
   */
  provisioned?: boolean;
  /**
   * Where the app dials. Defaults to this host, which is where a database lives unless it was
   * created on a registered external connection (an RDS instance and friends).
   */
  host?: string;
  port?: number;
}

export interface PhpEnvInput {
  /** `APP_NAME` — the project's display name. */
  appName: string;
  /** `APP_URL` — the project's full `https://<slug>.<base-domain>` URL. */
  appUrl: string;
  /** `APP_KEY`, already generated (see `generateAppKey`). */
  appKey: string;
  /** `MAIL_FROM_ADDRESS`'s domain, i.e. the instance base domain. Falls back to `example.com`. */
  baseDomain?: string;
  /** Redis on this host, or `null` when the server has none — the queue then runs `sync`. */
  redis?: RedisTarget | null;
  /** Mailpit on this host, or `null` — mail then goes to the log instead of SMTP. */
  mail?: MailTarget | null;
  /** The database being created with the project, or `null` for no `DB_*` block. */
  db?: DbTarget | null;
}

/** One line of the template: a `KEY=value` assignment, or verbatim text (a comment or a blank). */
type Entry = { kind: 'var'; key: string; value: string } | { kind: 'text'; line: string };

function v(key: string, value: string): Entry {
  return { kind: 'var', key, value };
}

function text(line = ''): Entry {
  return { kind: 'text', line };
}

/**
 * Renders `entries` into `.env` text through `serializeEnv`, so every value is quoted by exactly
 * the same rules the Environment editor's Table mode reads and writes with — the template is
 * guaranteed to round-trip through that editor without a single byte changing.
 */
function render(entries: Entry[]): string {
  const rows: EnvRow[] = [];
  const extras: EnvExtra[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind === 'text') {
      extras.push({ index, line: entry.line });
    } else {
      rows.push({ key: entry.key, value: entry.value });
    }
  });
  return serializeEnv(rows, extras);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (with padding) of `bytes`. Hand-rolled so this module needs neither node's
 *  `Buffer` nor the browser's `btoa` — it runs in both. */
function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Laravel's `APP_KEY` length for the default `aes-256-cbc` cipher. */
const APP_KEY_BYTES = 32;

/**
 * A fresh `base64:`-prefixed 32-byte `APP_KEY`, byte-identical in shape to what
 * `php artisan key:generate` produces. Randomness comes from the platform CSPRNG
 * (`crypto.getRandomValues`, present in both node and the browser); `random` is injectable so a
 * test can pin the bytes.
 */
export function generateAppKey(
  random: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => globalThis.crypto.getRandomValues(bytes),
): string {
  const bytes = new Uint8Array(APP_KEY_BYTES);
  random(bytes);
  return `base64:${toBase64(bytes)}`;
}

/**
 * The complete default `.env` for a new Laravel project on this server: app identity, logging,
 * the `DB_*` block when a database is being created with it, file-backed sessions, this host's
 * redis, and mailpit as the mail transport. See the module doc comment for the two judgment calls
 * (driver degradation, and `local`/debug defaults).
 */
export function buildPhpEnv(input: PhpEnvInput): string {
  const { appName, appUrl, appKey, redis, mail, db } = input;
  const baseDomain = input.baseDomain && input.baseDomain !== '' ? input.baseDomain : 'example.com';

  const entries: Entry[] = [
    text('# Shipway wrote these defaults for a Laravel app. Edit anything before the first deploy.'),
    text('# APP_DEBUG shows stack traces in the browser — turn it off (and APP_ENV=production) if'),
    text('# this project is ever reachable by someone who should not see them.'),
    v('APP_NAME', appName),
    v('APP_ENV', 'local'),
    v('APP_KEY', appKey),
    v('APP_DEBUG', 'true'),
    v('APP_URL', appUrl),
    text(),
    v('APP_LOCALE', 'en'),
    v('APP_FALLBACK_LOCALE', 'en'),
    v('APP_FAKER_LOCALE', 'en_US'),
    text(),
    v('APP_MAINTENANCE_DRIVER', 'file'),
    v('BCRYPT_ROUNDS', '12'),
    text(),
    v('LOG_CHANNEL', 'stack'),
    v('LOG_STACK', 'single'),
    v('LOG_DEPRECATIONS_CHANNEL', 'null'),
    v('LOG_LEVEL', 'debug'),
    text(),
    ...dbEntries(db ?? null),
    text(),
    text('# File-backed sessions need nothing else running, so the app boots even if redis or the'),
    text('# database is unavailable. Switch to redis/database once you know they are healthy.'),
    v('SESSION_DRIVER', 'file'),
    v('SESSION_LIFETIME', '120'),
    v('SESSION_ENCRYPT', 'false'),
    v('SESSION_PATH', '/'),
    v('SESSION_DOMAIN', 'null'),
    text(),
    v('BROADCAST_CONNECTION', 'log'),
    v('FILESYSTEM_DISK', 'local'),
    ...queueAndCacheEntries(redis ?? null, db ?? null),
    text('# CACHE_PREFIX='),
    text(),
    v('MEMCACHED_HOST', '127.0.0.1'),
    text(),
    ...redisEntries(redis ?? null),
    text(),
    ...mailEntries(mail ?? null, baseDomain),
  ];

  return render(entries);
}

/** The `DB_*` block for a database created with the project, or a note explaining its absence. */
function dbEntries(db: DbTarget | null): Entry[] {
  if (!db) {
    return [
      text('# No database was created with this project. Create one on the Databases page and use'),
      text('# "Add to project env" to have its DB_* credentials written in here.'),
    ];
  }

  const endpoint = db.host === undefined ? undefined : { host: db.host, port: db.port ?? dbPort(db.engine) };
  const vars = connectionEnv(db.engine, db, endpoint);
  // Says where as well as what, since "the existing database" is no longer necessarily on this box.
  const where = endpoint === undefined || endpoint.host === '127.0.0.1' ? 'on this server' : `at ${endpoint.host}`;
  const header =
    db.provisioned === false
      ? `# The existing ${db.engine} database "${db.name}" ${where}. Shipway fills in DB_PASSWORD when the project is created.`
      : `# Provisioned by Shipway with this project (${db.engine} ${where}).`;
  return [text(header), ...Object.entries(vars).map(([key, value]) => v(key, value))];
}

/**
 * `QUEUE_CONNECTION` + `CACHE_STORE`, each pointed only at something that will actually answer:
 * redis for the queue when this host has redis (`sync` otherwise — jobs run inline, no worker
 * needed), and the database cache only when there's a database whose `cache` table the build's
 * `php artisan migrate` will create (`file` otherwise).
 */
function queueAndCacheEntries(redis: RedisTarget | null, db: DbTarget | null): Entry[] {
  return [
    v('QUEUE_CONNECTION', redis ? 'redis' : 'sync'),
    v('CACHE_STORE', db ? 'database' : 'file'),
  ];
}

function redisEntries(redis: RedisTarget | null): Entry[] {
  const header = redis
    ? text("# This server's redis. Queue workers and any redis cache/session driver use it.")
    : text('# No redis is configured on this server, so the queue runs sync. These are placeholders.');
  return [
    header,
    v('REDIS_CLIENT', 'phpredis'),
    v('REDIS_HOST', redis?.host ?? '127.0.0.1'),
    // `null` (the literal string) is Laravel's own convention for "no password" in .env.
    v('REDIS_PASSWORD', redis?.password ? redis.password : 'null'),
    v('REDIS_PORT', String(redis?.port ?? 6379)),
  ];
}

/**
 * Mailpit as the transport when this host has it — every message the app sends lands in the
 * dashboard's shared inbox instead of a real recipient's. Without mailpit, mail goes to the log,
 * which is the only other option that can't fail at runtime.
 */
function mailEntries(mail: MailTarget | null, baseDomain: string): Entry[] {
  if (!mail) {
    return [
      text('# No mailpit on this server, so mail is written to the log instead of being sent.'),
      v('MAIL_MAILER', 'log'),
      v('MAIL_FROM_ADDRESS', `hello@${baseDomain}`),
      v('MAIL_FROM_NAME', '${APP_NAME}'),
    ];
  }

  return [
    text("# Mailpit, this server's catch-all inbox: nothing leaves the machine, and every message"),
    text('# the app sends is readable from the dashboard.'),
    v('MAIL_MAILER', 'smtp'),
    v('MAIL_SCHEME', 'null'),
    v('MAIL_HOST', mail.host),
    v('MAIL_PORT', String(mail.port)),
    v('MAIL_USERNAME', 'null'),
    v('MAIL_PASSWORD', 'null'),
    v('MAIL_FROM_ADDRESS', `hello@${baseDomain}`),
    v('MAIL_FROM_NAME', '${APP_NAME}'),
  ];
}

/** Matches a given key's assignment line: `KEY=`, leading whitespace allowed, comments never match. */
function assignmentLineRe(key: string): RegExp {
  return new RegExp(`^\\s*${key}\\s*=`);
}

/**
 * Sets each of `vars` in `text`, rewriting the first line that already assigns that key and
 * appending the rest at the end. Every other line — comments, blanks, other keys, and anything the
 * Table editor wouldn't touch — is left byte-for-byte alone.
 *
 * This is what fills in a database password that didn't exist yet when the user was looking at the
 * env: New Project renders the `DB_*` block from the name and engine they chose, then the database
 * is actually provisioned (which is when its generated password first exists), and this writes that
 * password into whatever they ended up submitting — whether they kept the block, edited it, moved
 * it, or deleted it entirely (in which case it's appended back).
 */
export function upsertEnvVars(envText: string, vars: Record<string, string>): string {
  const lines = envText.split('\n');
  const appended: string[] = [];

  for (const [key, value] of Object.entries(vars)) {
    const line = formatEnvAssignment(key, value);
    const idx = lines.findIndex((existing) => assignmentLineRe(key).test(existing));
    if (idx === -1) {
      appended.push(line);
    } else {
      lines[idx] = line;
    }
  }

  if (appended.length === 0) {
    return lines.join('\n');
  }

  // Drop trailing blank lines before appending so the new block doesn't float away from the file,
  // then keep one blank line as a separator.
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines.pop();
  }
  const separator = lines.length === 0 ? [] : [''];
  return [...lines, ...separator, ...appended].join('\n');
}

// ---------------------------------------------------------------------------
// Deploy commands
// ---------------------------------------------------------------------------

/** `installCmd` for a PHP project: composer, without dev dependencies. */
export const LARAVEL_INSTALL_CMD = 'composer install --no-dev --optimize-autoloader --no-interaction';

/**
 * `buildCmd` for a PHP project — runs after composer install and before the release goes live, so
 * a failure here fails the deploy without ever serving the broken release.
 *
 * `config:clear` first, deliberately: a `bootstrap/cache/config.php` accidentally committed to the
 * repo would otherwise shadow the `.env` Shipway just wrote (a stale database host in a cached
 * config is a 500 with no obvious cause). Only these two steps run pre-activation — route/view
 * caching lives in the post-deploy script, where `route:cache` failing on a closure-based route
 * can't take the deploy down with it.
 */
export const LARAVEL_BUILD_CMD = 'php artisan config:clear && php artisan migrate --force';

/**
 * `preDeployScript` for a PHP project. Documentation only, by design: this stage runs before
 * `composer install`, so there is no `vendor/` and no artisan yet, and the storage directories
 * Laravel needs are already seeded from the repo by the pipeline's shared-path step (see
 * `linkSharedPaths`). Prefilling it says where the artisan steps actually live instead of leaving
 * an empty box that invites putting them here.
 */
export const LARAVEL_PRE_DEPLOY_SCRIPT = `# Runs after the code is exported and .env is written, but BEFORE "composer install" —
# there is no vendor/ yet, so artisan cannot run here.
#
# Laravel's artisan steps belong in the build command (migrate) and the post-deploy
# script (storage:link, queue:restart, db:seed). Use this stage for anything that has to
# happen before dependencies are installed.
`;

/**
 * `postDeployScript` for a PHP project — runs once the release is live and has passed its health
 * check, where a non-zero exit is reported but does not roll the release back.
 *
 * `storage:link` is here rather than in the build because it's idempotent and non-fatal;
 * `queue:restart` tells any running worker to pick up the new release. Seeding and full
 * `optimize` caching are left commented out: `db:seed` is not something to re-run on every deploy,
 * and `route:cache` (inside `optimize`) fails outright on a closure-based route.
 */
export const LARAVEL_POST_DEPLOY_SCRIPT = `# Runs once the release is live and healthy. A failure here does not roll it back.
php artisan storage:link --force
php artisan queue:restart

# Uncomment when you need them:
# php artisan db:seed --force
# php artisan optimize                     # caches config/routes/views
# php artisan migrate:fresh --seed --force # DESTRUCTIVE: drops every table first
`;
