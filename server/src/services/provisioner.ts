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
import { projects } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import type { SysOps } from '../sysops/types.js';
import { assertSlug, renderAppUnit, renderNginxVhost, unitNames } from '../system/templates.js';
import type { DnsClient } from './cloudflare.js';

export interface ProvisionDeps {
  db: ShipwayDb;
  cfg: Config;
  sysops: SysOps;
  dns: DnsClient | null;
}

type ProjectRow = typeof projects.$inferSelect;

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
 * Renders and installs the nginx vhost to both `sites-available` and `sites-enabled`, runs
 * `nginx -t`, and reloads nginx. On a failed test, removes both files (never leaves nginx pointed at
 * a config it hasn't validated) and throws a `ProvisionError` (step `'nginx-test'`) carrying the raw
 * `nginx -t` output.
 */
async function writeVhost(deps: ProvisionDeps, project: ProjectRow, domain: string, certName: string): Promise<void> {
  const content = renderNginxVhost({
    slug: project.slug,
    domain,
    type: project.type,
    appsDir: deps.cfg.appsDir,
    publicDir: project.publicDir ?? '',
    phpVersion: project.phpVersion ?? undefined,
    port: project.port ?? undefined,
    certName,
  });

  const availablePath = vhostAvailablePath(project.slug);
  const enabledPath = vhostEnabledPath(project.slug);

  await deps.sysops.installFile(availablePath, content);
  await deps.sysops.installFile(enabledPath, content);

  const test = await deps.sysops.nginxTest();
  if (!test.ok) {
    await deps.sysops.removeFile(availablePath);
    await deps.sysops.removeFile(enabledPath);
    throw new ProvisionError('nginx-test', `nginx config test failed: ${test.output}`, test.output);
  }

  await deps.sysops.reloadNginx();
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
 * for cleanup (the `POST /api/projects` route deletes the just-inserted row on failure).
 */
export async function provisionProject(deps: ProvisionDeps, projectId: number): Promise<void> {
  const project = getProjectOrThrow(deps.db, projectId);
  assertSlug(project.slug);

  const { baseDomain, serverIp } = requireDomainSettings(deps.db);
  const domain = `${project.slug}.${baseDomain}`;

  if (deps.dns) {
    try {
      const existing = await deps.dns.findARecord(domain);
      if (!existing) {
        await deps.dns.createARecord(domain, serverIp);
      }
    } catch (err) {
      throw new ProvisionError('dns', `DNS record creation failed for ${domain}: ${errMessage(err)}`);
    }
  }

  try {
    fs.mkdirSync(path.join(deps.cfg.appsDir, project.slug, 'releases'), { recursive: true });
    fs.mkdirSync(path.join(deps.cfg.appsDir, project.slug, 'shared'), { recursive: true });
    fs.mkdirSync(path.join(deps.cfg.logsDir, project.slug), { recursive: true });
  } catch (err) {
    throw new ProvisionError('mkdirs', `Failed to create app directories for ${project.slug}: ${errMessage(err)}`);
  }

  await writeVhost(deps, project, domain, baseDomain);

  if (isNodeLike(project.type)) {
    await writeAppUnit(deps, project);
    await deps.sysops.unitAction('enable', unitNames.app(project.slug));
  }
}

/**
 * Re-renders and reinstalls the on-host config for a project whose settings changed in a way that
 * affects the vhost (`phpVersion`, `publicDir`) or the app unit (`startCmd`, `nodeVersion`): the
 * nginx vhost (with `nginx -t` + reload, same rollback-on-failure behavior as `provisionProject`),
 * and — for node/nextjs — the app unit + `daemon-reload`. Does not touch DNS, directories, or the
 * unit's enabled state.
 */
export async function refreshProjectConfig(deps: ProvisionDeps, projectId: number): Promise<void> {
  const project = getProjectOrThrow(deps.db, projectId);
  const baseDomain = requireBaseDomain(deps.db);
  const domain = `${project.slug}.${baseDomain}`;

  await writeVhost(deps, project, domain, baseDomain);

  if (isNodeLike(project.type)) {
    await writeAppUnit(deps, project);
  }
}

/**
 * Best-effort teardown of everything `provisionProject` may have created, then deletes the project
 * row (its `deployments` rows cascade via the FK). Each step is attempted independently — a failure
 * in one (e.g. nginx already reloaded out from under us) does not stop the rest from running, so a
 * partially-broken host state never blocks the user from deleting the project. Silently returns if
 * the project no longer exists.
 */
export async function deprovisionProject(deps: ProvisionDeps, projectId: number): Promise<void> {
  const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return;
  }

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

  await attempt(() => deps.sysops.removeFile(vhostAvailablePath(project.slug)));
  await attempt(() => deps.sysops.removeFile(vhostEnabledPath(project.slug)));
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
}
