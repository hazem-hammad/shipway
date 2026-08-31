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
import { databases, projects, workers } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import type { SecretBox } from '../lib/secretbox.js';
import type { SysOps } from '../sysops/types.js';
import { assertSlug, htpasswdPath, renderAppUnit, renderDefaultVhost, renderNginxVhost, unitNames } from '../system/templates.js';
import { renderHtpasswd } from '../system/htpasswd.js';
import type { DnsClient } from './cloudflare.js';
import { projectDomain } from '../lib/domain.js';
import { syncCrontab } from './cron.js';
import { isReservedDbName } from './dbconn.js';
import { connectionForDatabase } from './dbconnections.js';
import type { DbAdmin } from './dbprovision.js';
import { removeWorker } from './workers.js';

export interface ProvisionDeps {
  db: ShipwayDb;
  cfg: Config;
  sysops: SysOps;
  dns: DnsClient | null;
  /** Needed only by `deprovisionProject`, to DROP the project's databases rather than merely losing
   * the rows to the FK cascade. Optional so `provisionProject` and its tests, which never touch a
   * database engine, don't have to supply one — but the delete route always does. */
  dbAdmin?: DbAdmin;
  /** Decrypts a db connection's stored admin password (`connectionForDatabase`). Required alongside
   * `dbAdmin`; without it a drop can't authenticate and is skipped. */
  secretBox?: SecretBox;
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
/**
 * Installs (or refreshes) the catch-all HTTPS vhost — see `renderDefaultVhost` for why it has to
 * exist. Called at boot rather than only from `install.sh`, so an install that predates the
 * catch-all gets it on the next restart instead of needing a manual step.
 *
 * Never throws: a host with no `base_domain` yet (a fresh install before setup) or an `nginx -t`
 * failure caused by something else entirely must not stop Shipway from booting. On a failed test the
 * files are removed again, so nginx is never left holding a config it hasn't validated. Returns what
 * happened, for the caller to log.
 */
export async function ensureDefaultVhost(deps: ProvisionDeps): Promise<{ ok: boolean; detail: string }> {
  const baseDomain = getSetting<string>(deps.db, 'base_domain');
  if (!baseDomain) {
    return { ok: false, detail: 'skipped: base_domain is not configured yet' };
  }

  const availablePath = vhostAvailablePath('default');
  const enabledPath = vhostEnabledPath('default');

  try {
    const content = renderDefaultVhost(baseDomain);
    await deps.sysops.installFile(availablePath, content);
    await deps.sysops.installFile(enabledPath, content);

    const test = await deps.sysops.nginxTest();
    if (!test.ok) {
      // Most likely another `default_server` on 443 already exists (a hand-edited config). Back out
      // rather than leaving nginx unable to reload for every later project change.
      await deps.sysops.removeFile(availablePath);
      await deps.sysops.removeFile(enabledPath);
      return { ok: false, detail: `nginx test failed, catch-all not installed: ${test.output}` };
    }

    await deps.sysops.reloadNginx();
    return { ok: true, detail: `catch-all vhost installed for *.${baseDomain}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function provisionProject(deps: ProvisionDeps, projectId: number): Promise<DnsOutcome> {
  const project = getProjectOrThrow(deps.db, projectId);
  assertSlug(project.slug);

  const { baseDomain, serverIp } = requireDomainSettings(deps.db);
  const domain = projectDomain(project, baseDomain);

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
  const domain = projectDomain(project, baseDomain);

  const previousContent = renderVhostContent(deps, previous, domain, baseDomain);
  await writeVhost(deps, project, domain, baseDomain, previousContent);

  if (isNodeLike(project.type)) {
    await writeAppUnit(deps, project);
  }
}

/**
 * What {@link changeProjectSubdomain} did, so the route can report it and audit it. A DNS failure
 * never reaches this shape — it throws a `ProvisionError` instead — with one exception: deleting the
 * OLD record is best-effort (`staleRecordWarning`), because the project is already live and correct
 * on its new domain by then and failing the whole move over a leftover record would be the worse
 * outcome. The leftover is named rather than swallowed so someone can remove it by hand.
 */
export interface SubdomainMoveResult {
  /** The domain the project answers on now. */
  domain: string;
  /** The domain it answered on before. */
  previousDomain: string;
  /** `false` only when no DNS client is configured at all — both record steps were skipped. */
  dnsAttempted: boolean;
  /** Whether the new `A` record was created here, as opposed to already existing. */
  created: boolean;
  /** Whether the old `A` record was found and deleted. */
  oldRecordRemoved: boolean;
  /** Set only when the new domain is live but the old record could not be cleaned up. */
  staleRecordWarning?: string;
}

/**
 * Moves an already-provisioned project to the subdomain now on its row: points a DNS `A` record at
 * this server for the new domain, re-renders the nginx vhost under the new `server_name`, and
 * removes the old `A` record.
 *
 * `previous` must be the row as it stood BEFORE the caller wrote the new `subdomain` — same contract
 * as {@link refreshProjectConfig}, and needed for two things here: re-rendering the currently
 * installed vhost content (so a failed `nginx -t` restores the working site rather than deleting
 * it), and knowing which old record to delete.
 *
 * Ordered DNS-then-nginx so that each failure leaves the project exactly where it started:
 *  - DNS fails: nothing has been touched yet; throws step `'dns'`.
 *  - `nginx -t` fails: `writeVhost` has already restored the previous vhost, and the new `A` record
 *    is deleted again here — but only when this call created it, so a record that was already there
 *    (pointing at something else the user set up) is never destroyed. Throws step `'nginx-test'`.
 * In both cases the caller is responsible for putting the `subdomain` column back.
 *
 * Nothing named after the slug moves: the vhost file, unit names, `apps/<slug>` and the htpasswd
 * file all keep the names they had (see `lib/domain.ts` for why the two names are separate), so
 * there is no on-disk rename to fail halfway through.
 */
export async function changeProjectSubdomain(
  deps: ProvisionDeps,
  projectId: number,
  previous: ProjectRow,
): Promise<SubdomainMoveResult> {
  const project = getProjectOrThrow(deps.db, projectId);
  assertSlug(project.slug);

  const { baseDomain, serverIp } = requireDomainSettings(deps.db);
  const domain = projectDomain(project, baseDomain);
  const previousDomain = projectDomain(previous, baseDomain);

  const dnsOutcome = await resolveDnsOutcome(deps.dns, domain, serverIp);
  if (dnsOutcome.error) {
    throw new ProvisionError('dns', `DNS record creation failed for ${domain}: ${dnsOutcome.error}`);
  }

  const previousContent = renderVhostContent(deps, previous, previousDomain, baseDomain);
  try {
    await writeVhost(deps, project, domain, baseDomain, previousContent);
  } catch (err) {
    if (dnsOutcome.created && deps.dns) {
      // Best-effort: the throw below is the outcome that matters, and a failure to undo the record
      // must not replace the real error (the nginx output) with a DNS one.
      try {
        await deps.dns.deleteARecord(domain);
      } catch {
        /* leaves a record pointing here for a domain nginx does not serve — harmless */
      }
    }
    throw err;
  }

  let oldRecordRemoved = false;
  let staleRecordWarning: string | undefined;
  // The `previousDomain !== domain` guard is not decoration: without it a no-op "move" would delete
  // the record it had just confirmed.
  if (deps.dns && previousDomain !== domain) {
    try {
      if (await deps.dns.findARecord(previousDomain)) {
        await deps.dns.deleteARecord(previousDomain);
        oldRecordRemoved = true;
      }
    } catch (err) {
      staleRecordWarning = `${previousDomain} still has a DNS record pointing at this server: ${errMessage(err)}`;
    }
  }

  return {
    domain,
    previousDomain,
    dnsAttempted: dnsOutcome.attempted,
    created: dnsOutcome.created,
    oldRecordRemoved,
    ...(staleRecordWarning ? { staleRecordWarning } : {}),
  };
}

/** What `deprovisionProject` managed to tear down on the database side, so the caller can record it
 * in the audit trail and tell the user which databases (if any) it could not drop. */
export interface DeprovisionResult {
  databasesDropped: string[];
  databasesFailed: { name: string; reason: string }[];
}

/**
 * Best-effort teardown of everything `provisionProject` may have created, then deletes the project
 * row (its `deployments`/`cron_jobs` rows cascade via the FK) and resyncs the host crontab so any
 * cron entries belonging to the now-deleted project are removed rather than left orphaned. Each step
 * is attempted independently — a failure in one (e.g. nginx already reloaded out from under us) does
 * not stop the rest from running, so a partially-broken host state never blocks the user from
 * deleting the project. Silently returns if the project no longer exists.
 */
export async function deprovisionProject(deps: ProvisionDeps, projectId: number): Promise<DeprovisionResult> {
  const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return { databasesDropped: [], databasesFailed: [] };
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
      const domain = projectDomain(project, baseDomain);
      await attempt(() => deps.dns!.deleteARecord(domain));
    }
  }

  // The project's databases. Without this they were only ever lost to the `databases.project_id` FK
  // cascade below — the ROW vanished while the actual MySQL/Postgres database and its user stayed on
  // the engine forever, invisible to Shipway and impossible to recreate under the same name.
  //
  // Best-effort like every other teardown step: a database on an unreachable server, or one whose
  // connection has no stored admin credentials, must not strand the rest of the deletion. Anything
  // that couldn't be dropped is reported back so the caller can record it.
  const dbResult = await dropProjectDatabases(deps, projectId);

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

  return dbResult;
}

/**
 * Drops every database belonging to `projectId` on whatever server each one lives on, returning the
 * names dropped and the ones that couldn't be. Never throws.
 *
 * A `keepDatabase` drop (a reserved/system name, which can only come from a row predating the
 * create-time guard) removes the user and the record but leaves the database itself, exactly as
 * `DELETE /api/databases/:id` does — dropping it for real would take out the engine's own schema.
 */
async function dropProjectDatabases(deps: ProvisionDeps, projectId: number): Promise<DeprovisionResult> {
  const rows = deps.db.select().from(databases).where(eq(databases.projectId, projectId)).all();
  if (rows.length === 0) return { databasesDropped: [], databasesFailed: [] };

  // Without both, there is no way to authenticate a drop; say so rather than silently orphaning.
  if (!deps.dbAdmin || !deps.secretBox) {
    return { databasesDropped: [], databasesFailed: rows.map((row) => ({ name: row.name, reason: 'no database admin available' })) };
  }

  const dropped: string[] = [];
  const failed: { name: string; reason: string }[] = [];

  for (const row of rows) {
    const connection = connectionForDatabase(deps.db, deps.secretBox, row);
    if (!connection) {
      failed.push({ name: row.name, reason: `no admin credentials for the ${row.engine} server it lives on` });
      continue;
    }
    try {
      await deps.dbAdmin.dropDatabase(connection.target, row.name, row.username, { keepDatabase: isReservedDbName(row.name) });
      dropped.push(row.name);
    } catch (err) {
      failed.push({ name: row.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { databasesDropped: dropped, databasesFailed: failed };
}
