/**
 * Materializes (and un-materializes) a project on the host: DNS, on-disk
 * directories, the nginx vhost, and — for node/nextjs — the systemd app
 * unit. Nothing here decides *when* to provision; routes call
 * `provisionProject`/`deprovisionProject`/`refreshProjectConfig` at the
 * right points in the project lifecycle.
 */
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config.js';
import type { ShipwayDb } from '../db/index.js';
import { projects, workers } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import type { SysOps } from '../sysops/types.js';
import { assertSlug, htpasswdPath, renderAppUnit, renderNginxVhost, unitNames } from '../system/templates.js';
import { renderHtpasswd } from '../system/htpasswd.js';
import type { DnsClient } from './cloudflare.js';
import { syncCrontab } from './cron.js';
import { removeWorker } from './workers.js';

export interface ProvisionDeps {
  db: ShipwayDb;
  cfg: Config;
  sysops: SysOps;
  dns: DnsClient | null;
}

/**
 * What happened during a project's DNS step (plan Task 5 / spec §3 "New Project DNS") — reported
 * back to callers instead of only a throw/silent-success. `attempted` is `false` only when
 * `deps.dns` is `null` (no DNS client configured at all, e.g. dev mode with no credentials); when
 * it's `true`, exactly one of `created`/`existed` is `true` (a matching `A` record either already
 * existed, find-first, or was just created). `error` is set only by {@link resolveDnsOutcome} for
 * a caller that wants the failure captured rather than thrown — `provisionProject` itself does NOT
 * return an outcome with `error` set: it still throws a `ProvisionError` on a DNS failure exactly
 * as before (see its doc comment), preserving today's provisioning failure semantics unchanged.
 */
export interface DnsOutcome {
  attempted: boolean;
  created: boolean;
  existed: boolean;
  error?: string;
}

export type ProjectRow = typeof projects.$inferSelect;

/**
 * Thrown by any provisioning step. `step` identifies which stage failed
 * (`'settings' | 'dns' | 'mkdirs' | 'nginx-test' | 'app-unit' | 'lookup'`)
 * so callers (the API route) can report it; `output` carries the raw
 * `nginx -t` output for the `'nginx-test'` step specifically.
 */
export class ProvisionError extends Error {
  constructor(
    public readonly step: string,
    message: string,
    public readonly output?: string,
  ) {
    super(message);
    this.name = 'ProvisionError';
  }
}

/** Directory DevSysOps/RealSysOps installFile targets for the vhost's sites-available half. */
function vhostAvailablePath(slug: string): string {
  return `/etc/nginx/sites-available/shipway-${slug}.conf`;
}

function vhostEnabledPath(slug: string): string {
  return `/etc/nginx/sites-enabled/shipway-${slug}.conf`;
}

function appUnitPath(slug: string): string {
  return `/etc/systemd/system/${unitNames.app(slug)}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNodeLike(type: ProjectRow['type']): type is 'node' | 'nextjs' {
  return type === 'node' || type === 'nextjs';
}

function getProjectOrThrow(db: ShipwayDb, projectId: number): ProjectRow {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    throw new ProvisionError('lookup', `Project ${String(projectId)} not found`);
  }
  return project;
}

/**
 * The directory a project's node/nextjs `startCmd` should have on `PATH` to find its `node`/`npm`
 * binaries. In dev mode there's no `/opt/node/<version>` install tree, so we point at whatever
 * `node` is already running Shipway itself; outside dev mode, at the version-pinned install dir the
 * setup script provisions.
 */
export function nodeBinDir(cfg: Config, nodeVersion: string): string {
  if (cfg.devMode) {
    return path.dirname(process.execPath);
  }
  return `/opt/node/${nodeVersion}/bin`;
}

/**
 * The directory a php project's install/build/pre-post-deploy scripts and worker commands should
 * have on `PATH` to find a `php` binary pinned to the project's version. `setup/install.sh` creates
 * `/opt/php/<version>/bin/php` as a symlink to `/usr/bin/php<version>` for every PHP version it
 * installs, so a project's `composer install`/`artisan`/etc. that just invokes bare `php` — same as
 * the spec's Laravel-style commands — resolves to the right version instead of whatever `php`
 * ondrej's PPA currently makes the default.
 *
 * Unlike {@link nodeBinDir}, this does NOT branch on `cfg.devMode`: in dev there's no
 * `/opt/php/<version>` install tree, but that's fine — prepending a directory that doesn't exist to
 * `PATH` is a no-op, so lookups simply fall through to whatever `php` is already on the developer's
 * machine, matching dev's existing "use what's installed" expectations.
 */
export function phpBinDir(phpVersion: string): string {
  return `/opt/php/${phpVersion}/bin`;
}

/**
 * Reads `base_domain`/`server_ip` from settings, throwing a `ProvisionError` (step `'settings'`) if
 * either is unset — provisioning can't proceed without them.
 */
function requireDomainSettings(db: ShipwayDb): { baseDomain: string; serverIp: string } {
  const baseDomain = getSetting<string>(db, 'base_domain');
  const serverIp = getSetting<string>(db, 'server_ip');
  if (!baseDomain || !serverIp) {
    throw new ProvisionError('settings', 'base_domain and server_ip settings must be configured before provisioning');
  }
  return { baseDomain, serverIp };
}

function requireBaseDomain(db: ShipwayDb): string {
  const baseDomain = getSetting<string>(db, 'base_domain');
  if (!baseDomain) {
    throw new ProvisionError('settings', 'base_domain setting must be configured');
  }
  return baseDomain;
}

/**
 * True only when basic auth is both switched on and actually usable — an `authEnabled` row with no
 * user/hash yet would otherwise render an `auth_basic_user_file` pointing at a file that doesn't
 * exist, which nginx accepts at config-test time and then 500s on every request.
 */
function authIsActive(project: ProjectRow): boolean {
  return project.authEnabled && !!project.authUser && !!project.authHash;
}

/**
 * Writes (or removes) a project's `auth_basic_user_file` so it matches the row. Runs before the
 * vhost is installed, so the file a newly-auth-enabled vhost references already exists by the time
 * nginx reloads.
 */
async function syncHtpasswd(deps: ProvisionDeps, project: ProjectRow): Promise<void> {
  const dest = htpasswdPath(project.slug);
  if (authIsActive(project)) {
    await deps.sysops.installFile(dest, renderHtpasswd(project.authUser!, project.authHash!));
  } else {
    await deps.sysops.removeFile(dest);
  }
}

/** Pure render of a project's vhost content — no filesystem/sysops interaction. */
function renderVhostContent(deps: ProvisionDeps, project: ProjectRow, domain: string, certName: string): string {
  return renderNginxVhost({
    slug: project.slug,
    domain,
    type: project.type,
    appsDir: deps.cfg.appsDir,
    publicDir: project.publicDir ?? '',
    phpVersion: project.phpVersion ?? undefined,
    port: project.port ?? undefined,
    certName,
    authEnabled: authIsActive(project),
  });
}

/**
 * Renders and installs the nginx vhost to both `sites-available` and `sites-enabled`, runs
 * `nginx -t`, and reloads nginx.
 *
 * `nginx -t` validates the *entire* nginx config, not just this vhost, so it can fail for reasons
 * unrelated to this project. On a failed test:
 * - `previousContent === null` (fresh provisioning — nothing was there before): removes both files,
 *   so nginx is never left pointed at a config it hasn't validated.
 * - `previousContent` set (refreshing an already-provisioned project): RESTORES both files to
 *   `previousContent` instead of removing them, so a working site is never taken offline by an
 *   unrelated config error surfaced during an unrelated refresh.
 *
 * Either way, throws a `ProvisionError` (step `'nginx-test'`) carrying the raw `nginx -t` output.
 */
async function writeVhost(
  deps: ProvisionDeps,
  project: ProjectRow,
  domain: string,
  certName: string,
  previousContent: string | null,
): Promise<void> {
  await syncHtpasswd(deps, project);

  const content = renderVhostContent(deps, project, domain, certName);

  const availablePath = vhostAvailablePath(project.slug);
  const enabledPath = vhostEnabledPath(project.slug);

  await deps.sysops.installFile(availablePath, content);
  await deps.sysops.installFile(enabledPath, content);

  const test = await deps.sysops.nginxTest();
  if (!test.ok) {
    if (previousContent === null) {
      await deps.sysops.removeFile(availablePath);
      await deps.sysops.removeFile(enabledPath);
    } else {
      await deps.sysops.installFile(availablePath, previousContent);
      await deps.sysops.installFile(enabledPath, previousContent);
    }
    throw new ProvisionError('nginx-test', `nginx config test failed: ${test.output}`, test.output);
  }

  await deps.sysops.reloadNginx();
}

/**
 * Runs the find-then-create DNS step for `domain` and reports what happened rather than only
 * throwing: `{attempted: false}` when `dns` is `null` (step skipped entirely); otherwise finds the
 * existing `A` record first (the real Cloudflare client isn't idempotent on repeat
 * `createARecord`) and either reports `existed` or creates one and reports `created`. A thrown
 * error from the DNS client is CAUGHT here and captured into `error` rather than re-thrown — this
 * is what makes every branch (including failure) directly testable as data. `provisionProject`
 * calls this and then layers its own throw for the 'dns' step on top when `error` is set, so its
 * external failure behavior is unchanged from before this outcome reporting existed.
 */
export async function resolveDnsOutcome(dns: DnsClient | null, domain: string, serverIp: string): Promise<DnsOutcome> {
  if (!dns) {
    return { attempted: false, created: false, existed: false };
  }
  try {
    const existing = await dns.findARecord(domain);
    if (existing) {
      return { attempted: true, created: false, existed: true };
    }
    await dns.createARecord(domain, serverIp);
    return { attempted: true, created: true, existed: false };
  } catch (err) {
    return { attempted: true, created: false, existed: false, error: errMessage(err) };
  }
}

/** Renders and installs the `shipway-app-<slug>.service` unit, then `daemon-reload`s. */
async function writeAppUnit(deps: ProvisionDeps, project: ProjectRow): Promise<void> {
  if (project.port === null) {
    throw new ProvisionError('app-unit', `Project "${project.slug}" (${project.type}) has no allocated port`);
  }
  const nodeVersion = project.nodeVersion ?? '22';
  const content = renderAppUnit({
    slug: project.slug,
    appsDir: deps.cfg.appsDir,
    nodeBin: nodeBinDir(deps.cfg, nodeVersion),
    startCmd: project.startCmd ?? 'npm start',
    port: project.port,
  });

  await deps.sysops.installFile(appUnitPath(project.slug), content);
  await deps.sysops.daemonReload();
}

/**
 * Materializes a project on the host, in order:
 *
 * 1. Look up the project row and validate its slug.
 * 2. DNS — find-first, create the `A` record only if absent (the real Cloudflare client isn't
 *    idempotent on repeat `createARecord`). Skipped entirely when `deps.dns` is `null`.
 * 3. Create `apps/<slug>/{releases,shared}` and `logs/<slug>`.
 * 4. Render + install the nginx vhost to both `sites-available` and `sites-enabled`, `nginx -t`
 *    (rolling back the files on failure), then reload nginx.
 * 5. node/nextjs only: render + install the app unit, `daemon-reload`, then `enable` it.
 *
 * Any step failing throws a `ProvisionError` identifying which step failed; callers are responsible
 * for cleanup (the `POST /api/projects` route deletes the just-inserted row on failure). On
 * success, resolves to the {@link DnsOutcome} from step 2 — the caller's own record of what
 * happened to DNS (skipped / created / already existed) — so a route can report it without
 * changing anything about when provisioning itself fails (a DNS failure still throws here, exactly
 * as before; only the success outcome is new).
 */
export async function provisionProject(deps: ProvisionDeps, projectId: number): Promise<DnsOutcome> {
  const project = getProjectOrThrow(deps.db, projectId);
  assertSlug(project.slug);

  const { baseDomain, serverIp } = requireDomainSettings(deps.db);
  const domain = `${project.slug}.${baseDomain}`;

  const dnsOutcome = await resolveDnsOutcome(deps.dns, domain, serverIp);
  if (dnsOutcome.error) {
    throw new ProvisionError('dns', `DNS record creation failed for ${domain}: ${dnsOutcome.error}`);
  }

  try {
    fs.mkdirSync(path.join(deps.cfg.appsDir, project.slug, 'releases'), { recursive: true });
    fs.mkdirSync(path.join(deps.cfg.appsDir, project.slug, 'shared'), { recursive: true });
    fs.mkdirSync(path.join(deps.cfg.logsDir, project.slug), { recursive: true });
  } catch (err) {
    throw new ProvisionError('mkdirs', `Failed to create app directories for ${project.slug}: ${errMessage(err)}`);
  }

  // Fresh provisioning: nothing valid was there before, so a failed `nginx -t` removes the files
  // rather than restoring anything (there's nothing to restore).
  await writeVhost(deps, project, domain, baseDomain, null);

  if (isNodeLike(project.type)) {
    await writeAppUnit(deps, project);
    await deps.sysops.unitAction('enable', unitNames.app(project.slug));
  }

  return dnsOutcome;
}

/**
 * Re-renders and reinstalls the on-host config for a project whose settings changed in a way that
 * affects the vhost (`phpVersion`, `publicDir`) or the app unit (`startCmd`, `nodeVersion`): the
 * nginx vhost (with `nginx -t` + reload), and — for node/nextjs — the app unit + `daemon-reload`.
 * Does not touch DNS, directories, or the unit's enabled state.
 *
 * `previous` must be the project row as it stood *before* the caller applied the change (e.g. the
 * row a `PATCH` handler read prior to its `UPDATE`) — it's used to re-render the previous vhost
 * content, so that if the new config fails `nginx -t`, `writeVhost` can restore the site to exactly
 * what was working before instead of deleting it (see `writeVhost`'s doc comment).
 */
export async function refreshProjectConfig(deps: ProvisionDeps, projectId: number, previous: ProjectRow): Promise<void> {
  const project = getProjectOrThrow(deps.db, projectId);
  const baseDomain = requireBaseDomain(deps.db);
  const domain = `${project.slug}.${baseDomain}`;

  const previousContent = renderVhostContent(deps, previous, domain, baseDomain);
  await writeVhost(deps, project, domain, baseDomain, previousContent);

  if (isNodeLike(project.type)) {
    await writeAppUnit(deps, project);
  }
}

/**
 * Best-effort teardown of everything `provisionProject` may have created, then deletes the project
 * row (its `deployments`/`cron_jobs` rows cascade via the FK) and resyncs the host crontab so any
 * cron entries belonging to the now-deleted project are removed rather than left orphaned. Each step
 * is attempted independently — a failure in one (e.g. nginx already reloaded out from under us) does
 * not stop the rest from running, so a partially-broken host state never blocks the user from
 * deleting the project. Silently returns if the project no longer exists.
 */
export async function deprovisionProject(deps: ProvisionDeps, projectId: number): Promise<void> {
  const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return;
  }
  // Validate before constructing any path from `project.slug` (all the paths below interpolate it
  // directly) — the same defense-in-depth invariant `provisionProject` enforces on the way in.
  assertSlug(project.slug);

  async function attempt(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch {
      // Best-effort: individual step failures must not block the rest of teardown.
    }
  }

  if (isNodeLike(project.type)) {
    const unit = unitNames.app(project.slug);
    await attempt(() => deps.sysops.unitAction('stop', unit));
    await attempt(() => deps.sysops.unitAction('disable', unit));
    await attempt(() => deps.sysops.removeFile(appUnitPath(project.slug)));
  }

  // Workers (any project type can have them, not just node/nextjs — see workers.ts) each install
  // their own template unit + running instances; tear those down too, or they're left running
  // (restart-looping forever against a `WorkingDirectory` that's about to be deleted) and orphaned
  // on the host after the project row — and its `workers` rows, which cascade away — are gone.
  const workerRows = deps.db.select().from(workers).where(eq(workers.projectId, projectId)).all();
  for (const worker of workerRows) {
    await attempt(() => removeWorker({ sysops: deps.sysops, cfg: deps.cfg }, project, worker));
  }

  await attempt(() => deps.sysops.removeFile(vhostAvailablePath(project.slug)));
  await attempt(() => deps.sysops.removeFile(vhostEnabledPath(project.slug)));
  await attempt(() => deps.sysops.removeFile(htpasswdPath(project.slug)));
  await attempt(() => deps.sysops.reloadNginx());

  if (deps.dns) {
    const baseDomain = getSetting<string>(deps.db, 'base_domain');
    if (baseDomain) {
      const domain = `${project.slug}.${baseDomain}`;
      await attempt(() => deps.dns!.deleteARecord(domain));
    }
  }

  await attempt(() => {
    fs.rmSync(path.join(deps.cfg.appsDir, project.slug), { recursive: true, force: true });
    return Promise.resolve();
  });
  await attempt(() => {
    fs.rmSync(path.join(deps.cfg.logsDir, project.slug), { recursive: true, force: true });
    return Promise.resolve();
  });

  deps.db.delete(projects).where(eq(projects.id, projectId)).run();

  // `cron_jobs` rows for this project just cascaded away with the delete above; resync the host
  // crontab (best-effort, like every other step here) so its entries don't linger orphaned.
  await attempt(() => syncCrontab(deps));
}
