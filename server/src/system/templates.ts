/**
 * Pure string-rendering templates for the config Shipway writes to the
 * host: nginx vhosts, systemd units, and the managed crontab block.
 *
 * Nothing in this module touches the filesystem — callers pass the
 * rendered string to `SysOps.installFile` / `SysOps.writeCrontab`. Every
 * render function validates its identifier-shaped inputs (slug, worker
 * name, domain, cert name, php version, port) before interpolating them,
 * since these strings end up in privileged config files and unit names.
 * `startCmd` / worker `command` / cron `schedule` are trusted admin input
 * but are still checked for newlines so they can't break unit-file or
 * crontab line structure.
 */

/** Project slugs: lowercase alphanumeric + hyphens, 1-40 chars, no leading/trailing hyphen. */
export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** Throws if `slug` doesn't match {@link SLUG_RE}. */
export function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid slug: "${slug}"`);
  }
}

const WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

function assertWorkerName(name: string): void {
  if (!WORKER_NAME_RE.test(name)) {
    throw new Error(`Invalid worker name: "${name}"`);
  }
}

const HOSTNAME_RE = /^[a-z0-9.-]+$/i;

function assertHostname(value: string, label: string): void {
  if (!HOSTNAME_RE.test(value)) {
    throw new Error(`Invalid ${label}: "${value}"`);
  }
}

function assertPort(port: number, label = 'port'): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: ${String(port)}`);
  }
}

/**
 * Release-relative sub-path used as the nginx vhost's web root (appended to
 * `<appsDir>/<slug>/current/`). `''` means the release root itself (see
 * {@link releaseRoot}). Must start with an alphanumeric char (so an absolute path or a path made
 * entirely of `.`/`..` can never match) and must not contain a literal `..` path segment — either
 * would let the rendered `root` directive escape the release directory.
 */
export const PUBLIC_DIR_RE = /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/;

/** True for `''` or a value matching {@link PUBLIC_DIR_RE} with no `..` path segment. */
export function isValidPublicDir(value: string): boolean {
  if (value === '') {
    return true;
  }
  if (!PUBLIC_DIR_RE.test(value)) {
    return false;
  }
  return !value.split('/').some((segment) => segment === '..');
}

/** Throws if `value` isn't a valid `publicDir` per {@link isValidPublicDir}. */
export function assertPublicDir(value: string): void {
  if (!isValidPublicDir(value)) {
    throw new Error(`Invalid publicDir: "${value}"`);
  }
}

const PHP_VERSION_RE = /^8\.[0-9]+$/;

function assertPhpVersion(version: string | undefined): asserts version is string {
  if (version === undefined || !PHP_VERSION_RE.test(version)) {
    throw new Error(`Invalid PHP version: ${String(version)}`);
  }
}

function assertNoNewlines(value: string, label: string): void {
  if (/[\n\r]/.test(value)) {
    throw new Error(`Invalid ${label}: must not contain newlines`);
  }
}

function assertCronId(id: number): void {
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`Invalid cron id: ${String(id)}`);
  }
}

/** Builds the systemd unit names Shipway installs for a project. */
export const unitNames = {
  /** `shipway-app-<slug>.service` */
  app(slug: string): string {
    assertSlug(slug);
    return `shipway-app-${slug}.service`;
  },
  /** `shipway-worker-<slug>-<name>@.service` — a template unit; instances are `...@N.service`. */
  worker(slug: string, name: string): string {
    assertSlug(slug);
    assertWorkerName(name);
    return `shipway-worker-${slug}-${name}@.service`;
  },
};

// ---------------------------------------------------------------------------
// nginx vhosts
// ---------------------------------------------------------------------------

export interface VhostInput {
  slug: string;
  domain: string; // myapp.intcore.dev
  type: 'php' | 'node' | 'nextjs' | 'static';
  appsDir: string;
  publicDir: string; // '' -> root of release
  phpVersion?: string;
  port?: number;
  certName: string; // e.g. 'intcore.dev' -> /etc/letsencrypt/live/<certName>/
  /** When true, the https server block gets `auth_basic` pointed at this project's htpasswd file. */
  authEnabled?: boolean;
}

/**
 * Path of a project's `auth_basic_user_file`. Must stay in sync with `HTPASSWD_DEST_RE` in
 * setup/shipway-sysops — that whitelist is what allows Shipway (as `deployer`) to write here at all.
 */
export function htpasswdPath(slug: string): string {
  assertSlug(slug);
  return `/etc/nginx/shipway-auth/shipway-${slug}.htpasswd`;
}

function releaseRoot(appsDir: string, slug: string, publicDir: string): string {
  const current = `${appsDir}/${slug}/current`;
  return publicDir === '' ? current : `${current}/${publicDir}`;
}

/**
 * Denies any dotfile request (`.env`, `.git/...`, etc.) except the `/.well-known/` ACME-challenge
 * path certbot's HTTP-01 flow needs — placed before every other `location` block so it always wins.
 * Without this, a project's `publicDir` set to `''` (the web root = the release root, where the
 * pipeline symlinks `.env`) would serve `.env` — SMTP creds and any injected `DB_PASSWORD` included
 * — straight over HTTP.
 */
const DOTFILE_DENY_LOCATION = [`    location ~ /\\.(?!well-known) {`, `        deny all;`, `    }`].join('\n');

function phpBody(root: string, phpVersion: string): string {
  return [
    `    root ${root};`,
    `    index index.php index.html;`,
    ``,
    DOTFILE_DENY_LOCATION,
    ``,
    `    try_files $uri $uri/ /index.php?$query_string;`,
    ``,
    `    location ~ \\.php$ {`,
    `        fastcgi_pass unix:/run/php/php${phpVersion}-fpm.sock;`,
    `        fastcgi_index index.php;`,
    `        include fastcgi_params;`,
    `        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;`,
    `        fastcgi_param DOCUMENT_ROOT $realpath_root;`,
    `    }`,
  ].join('\n');
}

function proxyBody(port: number): string {
  return [
    `    location / {`,
    `        proxy_pass http://127.0.0.1:${port};`,
    `        proxy_set_header Upgrade $http_upgrade;`,
    `        proxy_set_header Connection "upgrade";`,
    `        proxy_set_header Host $host;`,
    `        proxy_http_version 1.1;`,
    `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `        proxy_set_header X-Forwarded-Proto $scheme;`,
    `        proxy_read_timeout 120s;`,
    `    }`,
  ].join('\n');
}

function staticBody(root: string): string {
  return [
    `    root ${root};`,
    `    index index.html;`,
    ``,
    DOTFILE_DENY_LOCATION,
    ``,
    `    location / {`,
    `        try_files $uri $uri/ /index.html;`,
    `    }`,
  ].join('\n');
}

function vhostBody(i: VhostInput, root: string): string {
  switch (i.type) {
    case 'php':
      assertPhpVersion(i.phpVersion);
      return phpBody(root, i.phpVersion);
    case 'node':
    case 'nextjs':
      if (i.port === undefined) {
        throw new Error(`Missing port for ${i.type} vhost`);
      }
      assertPort(i.port);
      return proxyBody(i.port);
    case 'static':
      return staticBody(root);
  }
}

/** Renders a full nginx vhost (HTTP redirect + HTTPS server block) for one project. */
export function renderNginxVhost(i: VhostInput): string {
  assertSlug(i.slug);
  assertHostname(i.domain, 'domain');
  assertHostname(i.certName, 'certName');
  // Defense in depth: the API route schemas already validate `publicDir` (see
  // routes/projects.ts's `publicDirSchema`), but this renderer asserts it again itself, the same
  // way it asserts slug/domain/certName, so nothing that reaches this function unvalidated can ever
  // produce a config-injecting/path-escaping `root` directive.
  assertPublicDir(i.publicDir);

  const root = releaseRoot(i.appsDir, i.slug, i.publicDir);
  const body = vhostBody(i, root);

  return [
    `server {`,
    `    listen 80;`,
    `    server_name ${i.domain};`,
    `    return 301 https://$host$request_uri;`,
    `}`,
    ``,
    `server {`,
    `    listen 443 ssl http2;`,
    `    server_name ${i.domain};`,
    ``,
    `    ssl_certificate /etc/letsencrypt/live/${i.certName}/fullchain.pem;`,
    `    ssl_certificate_key /etc/letsencrypt/live/${i.certName}/privkey.pem;`,
    ``,
    `    client_max_body_size 100m;`,
    ``,
    `    access_log /var/log/nginx/shipway-${i.slug}.access.log;`,
    `    error_log /var/log/nginx/shipway-${i.slug}.error.log;`,
    ``,
    // Placed on the server block (not a single location) so it covers every request to this vhost
    // — including the try_files fallback and any asset path — rather than leaving holes.
    ...(i.authEnabled
      ? [`    auth_basic "Restricted";`, `    auth_basic_user_file ${htpasswdPath(i.slug)};`, ``]
      : []),
    body,
    `}`,
    ``,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// systemd units
// ---------------------------------------------------------------------------

export interface AppUnitInput {
  slug: string;
  appsDir: string;
  nodeBin: string; // /opt/node/22/bin
  startCmd: string;
  port: number;
}

/** Renders the `shipway-app-<slug>.service` unit. */
export function renderAppUnit(i: AppUnitInput): string {
  assertSlug(i.slug);
  assertPort(i.port);
  assertNoNewlines(i.startCmd, 'startCmd');

  return [
    `[Unit]`,
    `Description=Shipway app: ${i.slug}`,
    `After=network.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `User=deployer`,
    `WorkingDirectory=${i.appsDir}/${i.slug}/current`,
    `Environment=PORT=${i.port}`,
    `EnvironmentFile=-${i.appsDir}/${i.slug}/shared/.env`,
    `ExecStart=/bin/bash -lc 'export PATH=${i.nodeBin}:$PATH && exec ${i.startCmd}'`,
    `Restart=always`,
    `RestartSec=3`,
    ``,
    `[Install]`,
    `WantedBy=multi-user.target`,
    ``,
  ].join('\n');
}

export interface WorkerUnitInput {
  slug: string;
  name: string;
  appsDir: string;
  command: string;
  pathPrefix: string; // PATH=<prefix>:/usr/bin:/bin
}

/** Renders the `shipway-worker-<slug>-<name>@.service` template unit. */
export function renderWorkerUnit(i: WorkerUnitInput): string {
  assertSlug(i.slug);
  assertWorkerName(i.name);
  assertNoNewlines(i.command, 'command');

  return [
    `[Unit]`,
    `Description=Shipway worker: ${i.slug} ${i.name} (%i)`,
    `After=network.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `User=deployer`,
    `WorkingDirectory=${i.appsDir}/${i.slug}/current`,
    `EnvironmentFile=-${i.appsDir}/${i.slug}/shared/.env`,
    `ExecStart=/bin/bash -lc 'export PATH=${i.pathPrefix}:$PATH && exec ${i.command}'`,
    `Restart=always`,
    `RestartSec=3`,
    ``,
    `[Install]`,
    `WantedBy=multi-user.target`,
    ``,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// crontab
// ---------------------------------------------------------------------------

export interface CronLine {
  id: number;
  slug: string;
  appsDir: string;
  logsDir: string;
  schedule: string;
  command: string;
}

const MARKER_START = '# >>> shipway managed >>>';
const MARKER_END = '# <<< shipway managed <<<';

/**
 * A real crontab treats an unescaped `%` in a command as a newline — everything after it becomes
 * stdin for the command instead of part of the command line — so every literal `%` must be escaped
 * as `\%` when rendering. The DB always stores the command unescaped (as the user wrote it); this
 * escaping happens only here, at render time.
 */
function escapeCronPercent(command: string): string {
  return command.replace(/%/g, '\\%');
}

function renderCronLine(line: CronLine): string {
  assertSlug(line.slug);
  assertCronId(line.id);
  assertNoNewlines(line.schedule, 'schedule');
  assertNoNewlines(line.command, 'command');
  return `${line.schedule} cd ${line.appsDir}/${line.slug}/current && ${escapeCronPercent(line.command)} >> ${line.logsDir}/${line.slug}/cron-${line.id}.log 2>&1`;
}

/**
 * Renders the managed crontab block for `lines`, delimited by the
 * `# >>> shipway managed >>>` / `# <<< shipway managed <<<` markers.
 * Returns `''` (no markers at all) when `lines` is empty.
 */
export function renderCrontabSection(lines: CronLine[]): string {
  if (lines.length === 0) {
    return '';
  }
  const body = lines.map(renderCronLine);
  return [MARKER_START, ...body, MARKER_END].join('\n');
}

function normalizeLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  return text.replace(/\n+$/, '').split('\n');
}

function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line === '' && out[out.length - 1] === '') {
      continue;
    }
    out.push(line);
  }
  while (out[0] === '') {
    out.shift();
  }
  while (out[out.length - 1] === '') {
    out.pop();
  }
  return out;
}

/**
 * Replaces (or removes, if `section` is `''`) the managed block inside
 * `existing`, or appends it when no managed block is present. Unrelated
 * user lines — before and after the block — are preserved. The result
 * always ends with exactly one trailing newline, unless empty.
 */
export function mergeCrontab(existing: string, section: string): string {
  const lines = normalizeLines(existing);
  const sectionLines = section === '' ? [] : normalizeLines(section);

  const startIdx = lines.indexOf(MARKER_START);
  const endIdx = startIdx === -1 ? -1 : lines.indexOf(MARKER_END, startIdx);

  let resultLines: string[];
  if (startIdx !== -1 && endIdx !== -1) {
    resultLines = [...lines.slice(0, startIdx), ...sectionLines, ...lines.slice(endIdx + 1)];
  } else if (sectionLines.length > 0) {
    resultLines = lines.length > 0 ? [...lines, '', ...sectionLines] : sectionLines;
  } else {
    resultLines = lines;
  }

  resultLines = collapseBlankRuns(resultLines);

  if (resultLines.length === 0) {
    return '';
  }
  return resultLines.join('\n') + '\n';
}
