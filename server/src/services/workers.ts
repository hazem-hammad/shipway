/**
 * Materializes (and un-materializes) a project's background workers on the host: renders and
 * installs the `shipway-worker-<slug>-<name>@.service` template unit, then enables + starts the
 * `processes` instances it should be running. Nothing here decides *when* to apply — routes call
 * `applyWorker`/`removeWorker` at the right points in the worker's lifecycle (create/update/delete).
 */
import type { Config } from '../config.js';
import type { projects, workers } from '../db/schema.js';
import { nodeBinDir, phpBinDir } from './provisioner.js';
import type { SysOps } from '../sysops/types.js';
import { renderWorkerUnit, unitNames } from '../system/templates.js';

type ProjectRow = typeof projects.$inferSelect;
type WorkerRow = typeof workers.$inferSelect;

export interface WorkerDeps {
  sysops: SysOps;
  cfg: Config;
}

function isNodeLike(type: ProjectRow['type']): type is 'node' | 'nextjs' {
  return type === 'node' || type === 'nextjs';
}

/** `nodeBinDir` for node/nextjs projects, `phpBinDir` (the version-pinned `php` shim) for php
 * projects with a `phpVersion` set, else `/usr/bin` (static projects have no worker binary to pin). */
function pathPrefixFor(cfg: Config, project: ProjectRow): string {
  if (isNodeLike(project.type)) {
    return nodeBinDir(cfg, project.nodeVersion ?? '22');
  }
  if (project.type === 'php' && project.phpVersion) {
    return phpBinDir(project.phpVersion);
  }
  return '/usr/bin';
}

function unitPath(slug: string, name: string): string {
  return `/etc/systemd/system/${unitNames.worker(slug, name)}`;
}

/** Builds the instance unit names `shipway-worker-<slug>-<name>@1.service` .. `@processes.service`. */
export function workerInstances(slug: string, name: string, processes: number): string[] {
  const template = unitNames.worker(slug, name); // validates slug/name; e.g. '...@.service'
  const base = template.slice(0, -'.service'.length); // '...@'
  const instances: string[] = [];
  for (let i = 1; i <= processes; i++) {
    instances.push(`${base}${String(i)}.service`);
  }
  return instances;
}

/**
 * Renders + installs the worker's template unit, `daemon-reload`s, then enables (or disables, per
 * `worker.autoStart`) and starts each instance `1..worker.processes`, in order.
 *
 * When `previousProcesses` is given and greater than `worker.processes` (a scale-down), also stops
 * + disables every instance from `worker.processes + 1` through `previousProcesses` — the instances
 * that used to run but no longer should.
 */
export async function applyWorker(deps: WorkerDeps, project: ProjectRow, worker: WorkerRow, previousProcesses?: number): Promise<void> {
  const content = renderWorkerUnit({
    slug: project.slug,
    name: worker.name,
    appsDir: deps.cfg.appsDir,
    command: worker.command,
    pathPrefix: pathPrefixFor(deps.cfg, project),
    restartPolicy: worker.restartPolicy,
    restartSec: worker.restartSec,
    stopTimeoutSec: worker.stopTimeoutSec,
  });

  await deps.sysops.installFile(unitPath(project.slug, worker.name), content);
  await deps.sysops.daemonReload();

  for (const unit of workerInstances(project.slug, worker.name, worker.processes)) {
    // `enable` and `start` answer different questions: enable is "come back after a reboot", start is
    // "run now". A worker with autoStart off still runs immediately — it just isn't wired into the
    // boot target. `disable` is issued explicitly rather than skipped, so turning autoStart OFF on an
    // existing worker actually removes the symlink instead of leaving the old one in place.
    await deps.sysops.unitAction(worker.autoStart ? 'enable' : 'disable', unit);
    await deps.sysops.unitAction('start', unit);
  }

  if (previousProcesses !== undefined && previousProcesses > worker.processes) {
    const removedInstances = workerInstances(project.slug, worker.name, previousProcesses).slice(worker.processes);
    for (const unit of removedInstances) {
      await deps.sysops.unitAction('stop', unit);
      await deps.sysops.unitAction('disable', unit);
    }
  }
}

/** Stops + disables every running instance, removes the template unit, then `daemon-reload`s. */
export async function removeWorker(deps: WorkerDeps, project: ProjectRow, worker: WorkerRow): Promise<void> {
  for (const unit of workerInstances(project.slug, worker.name, worker.processes)) {
    await deps.sysops.unitAction('stop', unit);
    await deps.sysops.unitAction('disable', unit);
  }
  await deps.sysops.removeFile(unitPath(project.slug, worker.name));
  await deps.sysops.daemonReload();
}
