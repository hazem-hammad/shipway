import { describe, expect, it } from 'vitest';
import {
  LARAVEL_BUILD_CMD,
  LARAVEL_INSTALL_CMD,
  LARAVEL_POST_DEPLOY_SCRIPT,
  LARAVEL_PRE_DEPLOY_SCRIPT,
  buildPhpEnv,
  generateAppKey,
  upsertEnvVars,
  type PhpEnvInput,
} from '../src/deploy/laravel.js';
import { parseEnv, serializeEnv } from '../src/deploy/envparse.js';
import { buildEnvFile, buildManagedVars } from '../src/deploy/envfile.js';

/** Reads a single key's value out of rendered env text (rows only, so comments never match). */
function valueOf(env: string, key: string): string | undefined {
  return parseEnv(env).rows.find((row) => row.key === key)?.value;
}

const FULL: PhpEnvInput = {
  appName: 'Tools Portal',
  appUrl: 'https://tools.apps.example.com',
  appKey: 'base64:0000000000000000000000000000000000000000000=',
  baseDomain: 'apps.example.com',
  redis: { host: '10.0.0.5', port: 6380, password: 'r3dis' },
  smtpMode: 'mailpit',
  // What buildManagedVars('mailpit') owns — the template must write none of these itself.
  managedMailKeys: ['MAIL_MAILER', 'MAIL_HOST', 'MAIL_PORT', 'MAIL_ENCRYPTION', 'SMTP_HOST', 'SMTP_PORT'],
  db: { engine: 'mysql', name: 'tools', username: 'tools', password: 'Sup3rSecret' },
};

describe('generateAppKey', () => {
  it('produces a base64: prefixed 32-byte key, the same shape as artisan key:generate', () => {
    const key = generateAppKey();

    expect(key.startsWith('base64:')).toBe(true);
    const decoded = Buffer.from(key.slice('base64:'.length), 'base64');
    expect(decoded).toHaveLength(32);
  });

  it('encodes the bytes it is given (injected randomness, standard base64 with padding)', () => {
    const key = generateAppKey((bytes) => bytes.fill(0));

    // 32 bytes -> 10 full base64 groups (40 chars) + a 2-byte tail (3 chars + one '=' pad).
    expect(key).toBe(`base64:${'A'.repeat(43)}=`);
  });

  it('returns a different key on each call', () => {
    expect(generateAppKey()).not.toBe(generateAppKey());
  });
});

describe('buildPhpEnv', () => {
  it('sets the app identity from the project, quoting a name that needs it', () => {
    const env = buildPhpEnv(FULL);

    expect(env).toContain('APP_NAME="Tools Portal"');
    expect(valueOf(env, 'APP_NAME')).toBe('Tools Portal');
    expect(valueOf(env, 'APP_URL')).toBe('https://tools.apps.example.com');
    expect(valueOf(env, 'APP_KEY')).toBe(FULL.appKey);
  });

  it('includes every variable a fresh Laravel app needs to boot', () => {
    const keys = new Set(parseEnv(buildPhpEnv(FULL)).rows.map((row) => row.key));

    for (const key of [
      'APP_NAME',
      'APP_ENV',
      'APP_KEY',
      'APP_DEBUG',
      'APP_URL',
      'APP_LOCALE',
      'APP_FALLBACK_LOCALE',
      'APP_FAKER_LOCALE',
      'APP_MAINTENANCE_DRIVER',
      'BCRYPT_ROUNDS',
      'LOG_CHANNEL',
      'LOG_STACK',
      'LOG_DEPRECATIONS_CHANNEL',
      'LOG_LEVEL',
      'SESSION_DRIVER',
      'SESSION_LIFETIME',
      'SESSION_ENCRYPT',
      'SESSION_PATH',
      'SESSION_DOMAIN',
      'BROADCAST_CONNECTION',
      'FILESYSTEM_DISK',
      'QUEUE_CONNECTION',
      'CACHE_STORE',
      'MEMCACHED_HOST',
      'REDIS_CLIENT',
      'REDIS_HOST',
      'REDIS_PASSWORD',
      'REDIS_PORT',
      'MAIL_FROM_ADDRESS',
      'MAIL_FROM_NAME',
    ]) {
      expect(keys, `missing ${key}`).toContain(key);
    }
  });

  it('points redis at this host and runs the queue on it', () => {
    const env = buildPhpEnv(FULL);

    expect(valueOf(env, 'REDIS_HOST')).toBe('10.0.0.5');
    expect(valueOf(env, 'REDIS_PORT')).toBe('6380');
    expect(valueOf(env, 'REDIS_PASSWORD')).toBe('r3dis');
    expect(valueOf(env, 'REDIS_CLIENT')).toBe('phpredis');
    expect(valueOf(env, 'QUEUE_CONNECTION')).toBe('redis');
  });

  it("writes Laravel's literal `null` for a redis with no password", () => {
    const env = buildPhpEnv({ ...FULL, redis: { host: '127.0.0.1', port: 6379 } });

    expect(valueOf(env, 'REDIS_PASSWORD')).toBe('null');
  });

  it('leaves the mail transport to the managed block and writes only who mail is from', () => {
    const env = buildPhpEnv(FULL);

    // Not an omission: a key the template writes is a USER key, and buildEnvFile drops managed vars
    // for keys the user already defines. Writing MAIL_HOST here would pin the project to whatever
    // service was chosen at creation forever.
    for (const key of ['MAIL_MAILER', 'MAIL_HOST', 'MAIL_PORT', 'MAIL_USERNAME', 'MAIL_PASSWORD']) {
      expect(valueOf(env, key), `${key} must come from the managed block`).toBeUndefined();
    }
    expect(valueOf(env, 'MAIL_FROM_ADDRESS')).toBe('hello@apps.example.com');
    // Laravel's own dotenv interpolation, deliberately left unquoted so it still interpolates.
    expect(valueOf(env, 'MAIL_FROM_NAME')).toBe('${APP_NAME}');
  });

  it('yields to the service that supplies its own from-address', () => {
    const env = buildPhpEnv({ ...FULL, smtpMode: 'ses', managedMailKeys: ['MAIL_MAILER', 'MAIL_HOST', 'MAIL_FROM_ADDRESS'] });

    expect(valueOf(env, 'MAIL_FROM_ADDRESS')).toBeUndefined();
    expect(valueOf(env, 'MAIL_FROM_NAME')).toBe('${APP_NAME}');
  });

  /**
   * The regression this whole split exists for. Before it, the template wrote Mailpit's MAIL_HOST
   * as a user key, so `buildEnvFile` dropped the managed MAIL_HOST and a project switched to SES
   * carried on delivering to Mailpit — the SMTP tab looked like it worked and did nothing.
   */
  it('lets the chosen email service actually reach the rendered .env', () => {
    const sesConfig = { region: 'eu-west-1', username: 'AKIAsmtp', password: 'ses-secret', fromAddress: 'hi@example.com' };
    const managed = buildManagedVars({ smtpMode: 'ses', sesConfig });
    const template = buildPhpEnv({ ...FULL, smtpMode: 'ses', managedMailKeys: Object.keys(managed) });

    const rendered = buildEnvFile(template, managed);

    expect(valueOf(rendered, 'MAIL_HOST')).toBe('email-smtp.eu-west-1.amazonaws.com');
    expect(valueOf(rendered, 'MAIL_PORT')).toBe('587');
    expect(valueOf(rendered, 'MAIL_FROM_ADDRESS')).toBe('hi@example.com');
    expect(rendered).not.toContain('1025');
  });

  it('injects the provisioned database credentials as DB_*', () => {
    const env = buildPhpEnv(FULL);

    expect(valueOf(env, 'DB_CONNECTION')).toBe('mysql');
    expect(valueOf(env, 'DB_HOST')).toBe('127.0.0.1');
    expect(valueOf(env, 'DB_PORT')).toBe('3306');
    expect(valueOf(env, 'DB_DATABASE')).toBe('tools');
    expect(valueOf(env, 'DB_USERNAME')).toBe('tools');
    expect(valueOf(env, 'DB_PASSWORD')).toBe('Sup3rSecret');
  });

  it('points DB_HOST at the connection the database lives on, not always at this host', () => {
    const env = buildPhpEnv({ ...FULL, db: { ...FULL.db!, host: 'shop.abc123.eu-west-1.rds.amazonaws.com', port: 3307 } });

    expect(valueOf(env, 'DB_HOST')).toBe('shop.abc123.eu-west-1.rds.amazonaws.com');
    expect(valueOf(env, 'DB_PORT')).toBe('3307');
    // The comment above the block names where it went, so the env is self-explaining.
    expect(env).toContain('at shop.abc123.eu-west-1.rds.amazonaws.com');
  });

  it('falls back to the engine default port when a connection host is given without one', () => {
    const env = buildPhpEnv({ ...FULL, db: { ...FULL.db!, host: 'db.internal' } });

    expect(valueOf(env, 'DB_HOST')).toBe('db.internal');
    expect(valueOf(env, 'DB_PORT')).toBe('3306');
  });

  it('marks a pre-existing database as such, since its password is filled in later', () => {
    const env = buildPhpEnv({ ...FULL, db: { ...FULL.db!, password: '', provisioned: false } });

    expect(env).toContain('# The existing mysql database "tools" on this server.');
    expect(valueOf(env, 'DB_DATABASE')).toBe('tools');
    expect(valueOf(env, 'DB_PASSWORD')).toBe('');
    // Still counts as "has a database", so the cache can use it.
    expect(valueOf(env, 'CACHE_STORE')).toBe('database');
  });

  it("uses Laravel's pgsql driver name (not `postgres`) and port for a postgres database", () => {
    const env = buildPhpEnv({ ...FULL, db: { engine: 'postgres', name: 'tools', username: 'tools', password: 'pw' } });

    expect(valueOf(env, 'DB_CONNECTION')).toBe('pgsql');
    expect(valueOf(env, 'DB_PORT')).toBe('5432');
  });

  // The whole point of the template: every driver it names has to be answerable on this host, or
  // the app 500s on the first request instead of booting.
  describe('driver degradation when a service is missing', () => {
    it('runs the queue sync when the server has no redis', () => {
      const env = buildPhpEnv({ ...FULL, redis: null });

      expect(valueOf(env, 'QUEUE_CONNECTION')).toBe('sync');
      // Still emits the block, as placeholders, so switching to redis later is a value edit.
      expect(valueOf(env, 'REDIS_HOST')).toBe('127.0.0.1');
      expect(valueOf(env, 'REDIS_PORT')).toBe('6379');
    });

    it('logs mail when no email service is selected', () => {
      const env = buildPhpEnv({ ...FULL, smtpMode: 'none', managedMailKeys: [] });

      // 'none' has no managed block at all, so the template states the mailer itself rather than
      // letting the app fall through to whatever config/mail.php defaults to.
      expect(valueOf(env, 'MAIL_MAILER')).toBe('log');
      expect(valueOf(env, 'MAIL_HOST')).toBeUndefined();
    });

    it('falls back to SQLite when no database is being created, so the first deploy still migrates', () => {
      const env = buildPhpEnv({ ...FULL, db: null });

      expect(valueOf(env, 'CACHE_STORE')).toBe('file');
      // Without this, `php artisan migrate --force` in the build command runs against whatever
      // config/database.php defaults to and fails the project's very first deploy.
      expect(valueOf(env, 'DB_CONNECTION')).toBe('sqlite');
      expect(valueOf(env, 'DB_PASSWORD')).toBeUndefined();
      expect(env).toContain('SQLite');
    });

    it('leaves DB_DATABASE to the managed block, since the template cannot know the host apps dir', () => {
      // The template is rendered in the BROWSER on the New Project page, where `appsDir` is unknown.
      // `deploy/envfile.ts` supplies the absolute path on every deploy instead.
      expect(valueOf(buildPhpEnv({ ...FULL, db: null }), 'DB_DATABASE')).toBeUndefined();
    });

    it('caches to the database only when there is one (its cache table comes from migrate)', () => {
      expect(valueOf(buildPhpEnv(FULL), 'CACHE_STORE')).toBe('database');
    });

    it('always uses file sessions, which need nothing running at all', () => {
      expect(valueOf(buildPhpEnv({ ...FULL, redis: null, db: null }), 'SESSION_DRIVER')).toBe('file');
    });

    it('falls back to example.com for the from-address when no base domain is set yet', () => {
      expect(valueOf(buildPhpEnv({ ...FULL, baseDomain: '' }), 'MAIL_FROM_ADDRESS')).toBe('hello@example.com');
    });
  });

  // The Environment editor's Table mode is the first thing that touches this text (in New Project,
  // before the project even exists). A template line the parser refused to treat as a row — or
  // re-quoted on the way back out — would show up as an un-editable "kept as written" line, or
  // change bytes on a save the user never made.
  it('round-trips through the Table editor byte-for-byte, with every assignment editable', () => {
    for (const input of [FULL, { ...FULL, db: null, redis: null, mail: null }]) {
      const env = buildPhpEnv(input);
      const parsed = parseEnv(env);

      expect(serializeEnv(parsed.rows, parsed.extras)).toBe(env);
      // Every non-comment, non-blank line became an editable row.
      const assignments = env.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
      expect(parsed.rows).toHaveLength(assignments.length);
    }
  });
});

describe('upsertEnvVars', () => {
  it('rewrites an existing assignment in place, leaving every other line untouched', () => {
    const before = ['# a comment', 'APP_NAME=Old', '', 'DB_PASSWORD=', 'LOG_LEVEL=debug'].join('\n');

    const after = upsertEnvVars(before, { DB_PASSWORD: 'generated' });

    expect(after).toBe(['# a comment', 'APP_NAME=Old', '', 'DB_PASSWORD=generated', 'LOG_LEVEL=debug'].join('\n'));
  });

  it('appends a key the text does not define yet, after one blank separator', () => {
    const after = upsertEnvVars('APP_NAME=App', { DB_DATABASE: 'tools' });

    expect(after).toBe('APP_NAME=App\n\nDB_DATABASE=tools');
  });

  it('appends into empty text without a leading blank line', () => {
    expect(upsertEnvVars('', { DB_DATABASE: 'tools' })).toBe('DB_DATABASE=tools');
  });

  it('quotes a value that needs it, the same way the Table editor would', () => {
    const after = upsertEnvVars('DB_PASSWORD=x', { DB_PASSWORD: 'pw with "quotes"' });

    expect(after).toBe('DB_PASSWORD="pw with \\"quotes\\""');
    expect(valueOf(after, 'DB_PASSWORD')).toBe('pw with "quotes"');
  });

  it('never rewrites a commented-out line that happens to mention the key', () => {
    const before = '# DB_PASSWORD=leave-me\nDB_PASSWORD=real';

    expect(upsertEnvVars(before, { DB_PASSWORD: 'new' })).toBe('# DB_PASSWORD=leave-me\nDB_PASSWORD=new');
  });

  it('only replaces the first assignment of a duplicated key (the one a reader would edit)', () => {
    const before = 'DB_HOST=first\nDB_HOST=second';

    expect(upsertEnvVars(before, { DB_HOST: 'new' })).toBe('DB_HOST=new\nDB_HOST=second');
  });

  it('sets several keys in one pass, mixing rewrites and appends', () => {
    const after = upsertEnvVars('DB_DATABASE=tools\n', {
      DB_DATABASE: 'renamed',
      DB_USERNAME: 'tools',
      DB_PASSWORD: 'pw',
    });

    expect(after).toBe('DB_DATABASE=renamed\n\nDB_USERNAME=tools\nDB_PASSWORD=pw');
  });
});

describe('Laravel deploy commands', () => {
  it('installs dependencies without dev packages', () => {
    expect(LARAVEL_INSTALL_CMD).toContain('composer install');
    expect(LARAVEL_INSTALL_CMD).toContain('--no-dev');
  });

  it('clears a stale committed config cache before migrating, pre-activation', () => {
    expect(LARAVEL_BUILD_CMD).toBe('php artisan config:clear && php artisan migrate --force');
  });

  it('keeps artisan out of the pre-deploy stage, which runs before composer install', () => {
    // Comments only — vendor/ (and therefore artisan) does not exist at this point.
    const commands = LARAVEL_PRE_DEPLOY_SCRIPT.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
    expect(commands).toEqual([]);
  });

  it('links storage and restarts workers post-deploy, with seeding left commented out', () => {
    const active = LARAVEL_POST_DEPLOY_SCRIPT.split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    expect(active).toEqual(['php artisan storage:link --force', 'php artisan queue:restart']);
    // Destructive or route-cache-dependent steps are offered, but never run unattended.
    expect(LARAVEL_POST_DEPLOY_SCRIPT).toContain('# php artisan db:seed --force');
    expect(LARAVEL_POST_DEPLOY_SCRIPT).toContain('# php artisan optimize');
  });
});
