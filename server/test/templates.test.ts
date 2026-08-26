import { describe, expect, it } from 'vitest';
import {
  SLUG_RE,
  assertSlug,
  assertPublicDir,
  isValidPublicDir,
  unitNames,
  renderNginxVhost,
  renderAppUnit,
  renderWorkerUnit,
  renderCrontabSection,
  mergeCrontab,
} from '../src/system/templates.js';
import type { VhostInput, AppUnitInput, WorkerUnitInput, CronLine } from '../src/system/templates.js';

const MARKER_START = '# >>> shipway managed >>>';
const MARKER_END = '# <<< shipway managed <<<';

describe('SLUG_RE / assertSlug', () => {
  it.each(['a', 'ab', 'a-b', 'my-app-123', 'a'.repeat(40), 'a' + '-'.repeat(38) + 'b'])(
    'accepts %s',
    (slug) => {
      expect(SLUG_RE.test(slug)).toBe(true);
      expect(() => assertSlug(slug)).not.toThrow();
    },
  );

  it.each(['', 'UPPER', 'a b', '-x', 'a'.repeat(41)])('rejects %s', (slug) => {
    expect(SLUG_RE.test(slug)).toBe(false);
    expect(() => assertSlug(slug)).toThrow();
  });

  it('throws an Error with the offending value quoted', () => {
    expect(() => assertSlug('Bad Slug')).toThrow('"Bad Slug"');
  });
});

describe('unitNames', () => {
  it('app(slug) builds the app unit name', () => {
    expect(unitNames.app('myapp')).toBe('shipway-app-myapp.service');
  });

  it('app(slug) validates the slug first', () => {
    expect(() => unitNames.app('UPPER')).toThrow();
    expect(() => unitNames.app('')).toThrow();
  });

  it('worker(slug, name) builds the template unit name', () => {
    expect(unitNames.worker('myapp', 'queue')).toBe('shipway-worker-myapp-queue@.service');
  });

  it('worker(slug, name) validates the slug', () => {
    expect(() => unitNames.worker('UPPER', 'queue')).toThrow();
  });

  it('worker(slug, name) validates the worker name', () => {
    expect(() => unitNames.worker('myapp', 'UPPER')).toThrow();
    expect(() => unitNames.worker('myapp', '')).toThrow();
    expect(() => unitNames.worker('myapp', 'a b')).toThrow();
    expect(() => unitNames.worker('myapp', 'x'.repeat(32))).toThrow();
  });
});

describe('isValidPublicDir / assertPublicDir', () => {
  it.each(['', 'public', 'dist', 'a/b/c', 'a-b_c.d', 'a'.repeat(60)])('accepts %s', (value) => {
    expect(isValidPublicDir(value)).toBe(true);
    expect(() => assertPublicDir(value)).not.toThrow();
  });

  it.each([
    '../etc',
    'public/../../etc',
    '..',
    '/etc',
    '/etc/passwd',
    'a b',
    'public;\n    location /x { alias /var/lib/shipway/; }',
    'public;rm -rf /',
    '.hidden',
  ])('rejects %s', (value) => {
    expect(isValidPublicDir(value)).toBe(false);
    expect(() => assertPublicDir(value)).toThrow();
  });

  it('throws an Error with the offending value quoted', () => {
    expect(() => assertPublicDir('../x')).toThrow('"../x"');
  });
});

describe('renderNginxVhost — shared across all vhost types', () => {
  const base: VhostInput = {
    slug: 'blog',
    domain: 'blog.intcore.dev',
    type: 'static',
    appsDir: '/var/deploy/apps',
    publicDir: 'dist',
    certName: 'intcore.dev',
  };

  it('emits the https server block with ssl + http2', () => {
    const out = renderNginxVhost(base);
    expect(out).toContain('listen 443 ssl http2;');
    expect(out).toContain('server_name blog.intcore.dev;');
  });

  it('emits ssl_certificate paths from certName', () => {
    const out = renderNginxVhost(base);
    expect(out).toContain('ssl_certificate /etc/letsencrypt/live/intcore.dev/fullchain.pem;');
    expect(out).toContain('ssl_certificate_key /etc/letsencrypt/live/intcore.dev/privkey.pem;');
  });

  it('emits a port-80 redirect server block', () => {
    const out = renderNginxVhost(base);
    expect(out).toContain('listen 80;');
    expect(out).toContain('return 301 https://$host$request_uri;');
  });

  it('emits client_max_body_size 100m', () => {
    expect(renderNginxVhost(base)).toContain('client_max_body_size 100m;');
  });

  it('emits access_log and error_log named by slug', () => {
    const out = renderNginxVhost(base);
    expect(out).toContain('access_log /var/log/nginx/shipway-blog.access.log;');
    expect(out).toContain('error_log /var/log/nginx/shipway-blog.error.log;');
  });

  it('validates the slug first', () => {
    expect(() => renderNginxVhost({ ...base, slug: 'UPPER' })).toThrow();
  });

  it('validates the domain', () => {
    expect(() => renderNginxVhost({ ...base, domain: 'not a domain!' })).toThrow();
  });

  it('validates certName', () => {
    expect(() => renderNginxVhost({ ...base, certName: 'not a cert!' })).toThrow();
  });

  it.each(['../etc', '/etc', 'public/../../etc', 'a b', 'public;rm -rf /'])(
    'validates publicDir — rejects %s (config injection / path traversal)',
    (publicDir) => {
      expect(() => renderNginxVhost({ ...base, publicDir })).toThrow();
    },
  );
});

describe('renderNginxVhost — php', () => {
  const input: VhostInput = {
    slug: 'shop',
    domain: 'shop.intcore.dev',
    type: 'php',
    appsDir: '/var/deploy/apps',
    publicDir: 'public',
    phpVersion: '8.3',
    certName: 'intcore.dev',
  };

  it('sets root to <appsDir>/<slug>/current/<publicDir>', () => {
    expect(renderNginxVhost(input)).toContain('root /var/deploy/apps/shop/current/public;');
  });

  it('sets root with no trailing segment when publicDir is empty', () => {
    const out = renderNginxVhost({ ...input, publicDir: '' });
    expect(out).toContain('root /var/deploy/apps/shop/current;');
    expect(out).not.toContain('/current/;');
  });

  it('uses the Laravel-style index + try_files at the server level', () => {
    const out = renderNginxVhost(input);
    expect(out).toContain('index index.php');
    expect(out).toContain('try_files $uri $uri/ /index.php?$query_string;');
  });

  it('routes .php requests to the versioned php-fpm socket', () => {
    const out = renderNginxVhost(input);
    expect(out).toContain('location ~ \\.php$ {');
    expect(out).toContain('fastcgi_pass unix:/run/php/php8.3-fpm.sock;');
  });

  it('sets fastcgi_index, include fastcgi_params, and $realpath_root-based params', () => {
    const out = renderNginxVhost(input);
    expect(out).toContain('fastcgi_index index.php;');
    expect(out).toContain('include fastcgi_params;');
    expect(out).toContain('fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;');
    expect(out).toContain('fastcgi_param DOCUMENT_ROOT $realpath_root;');
  });

  it('requires a valid phpVersion', () => {
    expect(() => renderNginxVhost({ ...input, phpVersion: undefined })).toThrow();
    expect(() => renderNginxVhost({ ...input, phpVersion: '' })).toThrow();
    expect(() => renderNginxVhost({ ...input, phpVersion: '8.3; rm -rf /' })).toThrow();
  });

  it('denies dotfile requests (.env, .git, etc.) except /.well-known/, before the other locations', () => {
    const out = renderNginxVhost(input);
    expect(out).toContain('location ~ /\\.(?!well-known) {');
    expect(out).toContain('deny all;');
    expect(out.indexOf('location ~ /\\.(?!well-known)')).toBeLessThan(out.indexOf('location ~ \\.php$'));
  });
});

describe('renderNginxVhost — node / nextjs', () => {
  const input: VhostInput = {
    slug: 'api',
    domain: 'api.intcore.dev',
    type: 'node',
    appsDir: '/var/deploy/apps',
    publicDir: '',
    port: 3007,
    certName: 'intcore.dev',
  };

  it.each(['node', 'nextjs'] as const)('proxies to 127.0.0.1:<port> for type=%s', (type) => {
    const out = renderNginxVhost({ ...input, type });
    expect(out).toContain('location / {');
    expect(out).toContain('proxy_pass http://127.0.0.1:3007;');
  });

  it('sets websocket-upgrade and forwarding headers', () => {
    const out = renderNginxVhost(input);
    expect(out).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(out).toContain('proxy_set_header Connection "upgrade";');
    expect(out).toContain('proxy_set_header Host $host;');
    expect(out).toContain('proxy_http_version 1.1;');
    expect(out).toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
    expect(out).toContain('proxy_set_header X-Forwarded-Proto $scheme;');
    expect(out).toContain('proxy_read_timeout 120s;');
  });

  it.each([0, -1, 1.5, 65536, Number.NaN])('rejects an invalid port %s', (port) => {
    expect(() => renderNginxVhost({ ...input, port })).toThrow();
  });

  it('requires a port', () => {
    expect(() => renderNginxVhost({ ...input, port: undefined })).toThrow();
  });
});

describe('renderNginxVhost — static', () => {
  const input: VhostInput = {
    slug: 'docs',
    domain: 'docs.intcore.dev',
    type: 'static',
    appsDir: '/var/deploy/apps',
    publicDir: 'dist',
    certName: 'intcore.dev',
  };

  it('sets root to <appsDir>/<slug>/current/<publicDir>', () => {
    expect(renderNginxVhost(input)).toContain('root /var/deploy/apps/docs/current/dist;');
  });

  it('falls back to /index.html for client-side routing', () => {
    expect(renderNginxVhost(input)).toContain('try_files $uri $uri/ /index.html;');
  });

  it('denies dotfile requests (.env, .git, etc.) except /.well-known/, before the other locations', () => {
    const out = renderNginxVhost(input);
    expect(out).toContain('location ~ /\\.(?!well-known) {');
    expect(out).toContain('deny all;');
    expect(out.indexOf('location ~ /\\.(?!well-known)')).toBeLessThan(out.indexOf('location / {'));
  });
});

describe('renderAppUnit', () => {
  const input: AppUnitInput = {
    slug: 'api',
    appsDir: '/var/deploy/apps',
    nodeBin: '/opt/node/22/bin',
    startCmd: 'node server.js',
    port: 3007,
  };

  it('emits the required [Service] fields', () => {
    const out = renderAppUnit(input);
    expect(out).toContain('User=deployer');
    expect(out).toContain('WorkingDirectory=/var/deploy/apps/api/current');
    expect(out).toContain('Environment=PORT=3007');
    expect(out).toContain('EnvironmentFile=-/var/deploy/apps/api/shared/.env');
    expect(out).toContain(
      "ExecStart=/bin/bash -lc 'export PATH=/opt/node/22/bin:$PATH && exec node server.js'",
    );
    expect(out).toContain('Restart=always');
    expect(out).toContain('RestartSec=3');
  });

  it('emits [Install] WantedBy=multi-user.target', () => {
    const out = renderAppUnit(input);
    expect(out).toContain('[Install]');
    expect(out).toContain('WantedBy=multi-user.target');
  });

  it('validates the slug', () => {
    expect(() => renderAppUnit({ ...input, slug: 'UPPER' })).toThrow();
  });

  it.each([0, -1, 1.5, 65536, Number.NaN])('rejects an invalid port %s', (port) => {
    expect(() => renderAppUnit({ ...input, port })).toThrow();
  });

  it('rejects a startCmd containing a newline', () => {
    expect(() => renderAppUnit({ ...input, startCmd: 'node server.js\nrm -rf /' })).toThrow();
  });

  it('rejects a startCmd containing a carriage return', () => {
    expect(() => renderAppUnit({ ...input, startCmd: 'node server.js\r\nrm -rf /' })).toThrow();
  });
});

describe('renderWorkerUnit', () => {
  const input: WorkerUnitInput = {
    slug: 'shop',
    name: 'queue',
    appsDir: '/var/deploy/apps',
    command: 'php8.3 artisan queue:work --tries=3',
    pathPrefix: '/opt/node/22/bin',
  };

  it('emits the same [Service] shape as the app unit, without a port', () => {
    const out = renderWorkerUnit(input);
    expect(out).toContain('User=deployer');
    expect(out).toContain('WorkingDirectory=/var/deploy/apps/shop/current');
    expect(out).toContain('EnvironmentFile=-/var/deploy/apps/shop/shared/.env');
    expect(out).toContain(
      "ExecStart=/bin/bash -lc 'export PATH=/opt/node/22/bin:$PATH && exec php8.3 artisan queue:work --tries=3'",
    );
    expect(out).toContain('Restart=always');
    expect(out).toContain('RestartSec=3');
    expect(out).toContain('[Install]');
    expect(out).toContain('WantedBy=multi-user.target');
    expect(out).not.toContain('Environment=PORT=');
  });

  it('validates the slug', () => {
    expect(() => renderWorkerUnit({ ...input, slug: 'UPPER' })).toThrow();
  });

  it('validates the worker name', () => {
    expect(() => renderWorkerUnit({ ...input, name: 'UPPER NAME' })).toThrow();
  });

  it('rejects a command containing a newline', () => {
    expect(() => renderWorkerUnit({ ...input, command: 'queue:work\nrm -rf /' })).toThrow();
  });
});

describe('renderCrontabSection', () => {
  it('returns "" for an empty array (no markers)', () => {
    expect(renderCrontabSection([])).toBe('');
  });

  it('formats a single line between the managed markers', () => {
    const lines: CronLine[] = [
      {
        id: 1,
        slug: 'blog',
        appsDir: '/var/deploy/apps',
        logsDir: '/var/deploy/logs',
        schedule: '* * * * *',
        command: 'php artisan schedule:run',
      },
    ];
    const out = renderCrontabSection(lines);
    expect(out).toBe(
      [
        MARKER_START,
        '* * * * * cd /var/deploy/apps/blog/current && php artisan schedule:run >> /var/deploy/logs/blog/cron-1.log 2>&1',
        MARKER_END,
      ].join('\n'),
    );
  });

  it('formats multiple lines, one per CronLine, in order', () => {
    const lines: CronLine[] = [
      {
        id: 1,
        slug: 'blog',
        appsDir: '/var/deploy/apps',
        logsDir: '/var/deploy/logs',
        schedule: '* * * * *',
        command: 'php artisan schedule:run',
      },
      {
        id: 2,
        slug: 'shop',
        appsDir: '/var/deploy/apps',
        logsDir: '/var/deploy/logs',
        schedule: '0 3 * * *',
        command: 'php artisan backup:run',
      },
    ];
    const out = renderCrontabSection(lines);
    const body = out.split('\n');
    expect(body[0]).toBe(MARKER_START);
    expect(body[1]).toBe(
      '* * * * * cd /var/deploy/apps/blog/current && php artisan schedule:run >> /var/deploy/logs/blog/cron-1.log 2>&1',
    );
    expect(body[2]).toBe(
      '0 3 * * * cd /var/deploy/apps/shop/current && php artisan backup:run >> /var/deploy/logs/shop/cron-2.log 2>&1',
    );
    expect(body[3]).toBe(MARKER_END);
  });

  it('validates the slug of every line', () => {
    const lines: CronLine[] = [
      {
        id: 1,
        slug: 'UPPER',
        appsDir: '/var/deploy/apps',
        logsDir: '/var/deploy/logs',
        schedule: '* * * * *',
        command: 'true',
      },
    ];
    expect(() => renderCrontabSection(lines)).toThrow();
  });

  it('rejects a schedule containing a newline', () => {
    const lines: CronLine[] = [
      {
        id: 1,
        slug: 'blog',
        appsDir: '/var/deploy/apps',
        logsDir: '/var/deploy/logs',
        schedule: '* * * * *\n* * * * *',
        command: 'true',
      },
    ];
    expect(() => renderCrontabSection(lines)).toThrow();
  });

  it('rejects a command containing a newline', () => {
    const lines: CronLine[] = [
      {
        id: 1,
        slug: 'blog',
        appsDir: '/var/deploy/apps',
        logsDir: '/var/deploy/logs',
        schedule: '* * * * *',
        command: 'true\nrm -rf /',
      },
    ];
    expect(() => renderCrontabSection(lines)).toThrow();
  });

  it('escapes literal % in the command as \\%, since crontab treats an unescaped % as a newline/stdin separator', () => {
    const lines: CronLine[] = [
      {
        id: 1,
        slug: 'blog',
        appsDir: '/var/deploy/apps',
        logsDir: '/var/deploy/logs',
        schedule: '* * * * *',
        command: 'date +%Y%m%d',
      },
    ];
    const out = renderCrontabSection(lines);
    expect(out).toBe(
      [
        MARKER_START,
        '* * * * * cd /var/deploy/apps/blog/current && date +\\%Y\\%m\\%d >> /var/deploy/logs/blog/cron-1.log 2>&1',
        MARKER_END,
      ].join('\n'),
    );
  });
});

describe('mergeCrontab', () => {
  const section = [
    MARKER_START,
    '* * * * * cd /var/deploy/apps/blog/current && php artisan schedule:run >> /var/deploy/logs/blog/cron-1.log 2>&1',
    MARKER_END,
  ].join('\n');

  it('appends the managed block when none exists, preserving prior user lines', () => {
    const existing = '0 3 * * * /usr/bin/system-backup.sh\n';
    const merged = mergeCrontab(existing, section);

    expect(merged).toContain('0 3 * * * /usr/bin/system-backup.sh');
    expect(merged).toContain(section);
    expect(merged.indexOf('0 3 * * * /usr/bin/system-backup.sh')).toBeLessThan(
      merged.indexOf(MARKER_START),
    );
  });

  it('replaces an existing managed block, preserving unrelated user cron lines before and after it', () => {
    const oldSection = [
      MARKER_START,
      '* * * * * cd /var/deploy/apps/old/current && old-cmd >> /var/deploy/logs/old/cron-9.log 2>&1',
      MARKER_END,
    ].join('\n');
    const existing = [
      '# my personal jobs',
      '0 3 * * * /usr/bin/system-backup.sh',
      '',
      oldSection,
      '',
      '@reboot /usr/bin/notify-me.sh',
    ].join('\n');

    const merged = mergeCrontab(existing, section);

    expect(merged).toContain('# my personal jobs');
    expect(merged).toContain('0 3 * * * /usr/bin/system-backup.sh');
    expect(merged).toContain('@reboot /usr/bin/notify-me.sh');
    expect(merged).toContain(section);
    expect(merged).not.toContain('old-cmd');
    expect(merged.indexOf('0 3 * * * /usr/bin/system-backup.sh')).toBeLessThan(
      merged.indexOf(MARKER_START),
    );
    expect(merged.indexOf(MARKER_END)).toBeLessThan(merged.indexOf('@reboot'));
  });

  it('removes the managed block when section is empty, preserving unrelated user lines', () => {
    const existing = [
      '0 3 * * * /usr/bin/system-backup.sh',
      '',
      section,
      '',
      '@reboot /usr/bin/notify-me.sh',
    ].join('\n');

    const merged = mergeCrontab(existing, '');

    expect(merged).toContain('0 3 * * * /usr/bin/system-backup.sh');
    expect(merged).toContain('@reboot /usr/bin/notify-me.sh');
    expect(merged).not.toContain(MARKER_START);
    expect(merged).not.toContain(MARKER_END);
  });

  it('is a no-op when section is empty and no managed block exists', () => {
    const existing = '0 3 * * * /usr/bin/system-backup.sh\n';
    expect(mergeCrontab(existing, '')).toBe(existing);
  });

  it('handles an empty existing crontab', () => {
    expect(mergeCrontab('', section)).toBe(section + '\n');
    expect(mergeCrontab('', '')).toBe('');
  });

  it('is idempotent — merging the same section twice yields the same result', () => {
    const existing = '0 3 * * * /usr/bin/system-backup.sh\n';
    const once = mergeCrontab(existing, section);
    const twice = mergeCrontab(once, section);
    expect(twice).toBe(once);
  });
});
