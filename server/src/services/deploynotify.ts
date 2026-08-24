/**
 * The deploy-terminal notify hook wired into `PipelineDeps.notify` (see `app.ts`): preserves v1's
 * legacy webhook behavior exactly (per-project `notifyWebhookUrl` override, else the global
 * `notify_webhook_url` setting, gated by `notify_on_success` for success only — failures always
 * send) AND additionally — always, independent of that gate, since Task 4's bus events are additive
 * — emits the matching `notifybus` event: `deploy_succeeded`, `deploy_rolled_back` (when the pipeline
 * reports the failure rolled the release back), or `deploy_failed`.
 *
 * `notifyDeployCanceled` covers the one terminal deploy status the pipeline's own `notify` hook is
 * deliberately never called for (see `deploy/pipeline.ts` — cancellation skips the legacy webhook
 * entirely, unchanged v1 behavior): `app.ts`'s queue wrapper calls this directly once `runDeploy`
 * returns `'canceled'`.
 */
import { eq } from 'drizzle-orm';
import type { ShipwayDb } from '../db/index.js';
import { deployments, projects } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import { EVENTS, emitEvent, type NotifyEvent } from './notifybus.js';
import { sendDeployNotification } from './notify.js';

export interface DeployNotifyPayload {
  /** Project slug, as passed by the pipeline. */
  project: string;
  status: 'success' | 'failed';
  deploymentId: number;
  /** Commit message on success, or a stage-failure summary on failure. */
  message: string;
  /** Set by `deploy/pipeline.ts`'s `handlePostActivateFailure` when a post-activate failure (health
   * check, restart, or worker restart) successfully rolled the release back to the previous one. */
  rolledBack?: boolean;
}

/** 7-char short sha (git's default abbreviation length), or `''` if `sha` is null/unset. */
function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}

/** `[<project slug>] deploy #<id> <sha-short?> <detail>` per spec — `detail` is the commit message
 * on success, a stage-failure summary on failure, or a fixed string for a cancellation. */
function busMessage(projectSlug: string, deploymentId: number, commitSha: string | null | undefined, detail: string): string {
  const sha = shortSha(commitSha);
  return `[${projectSlug}] deploy #${String(deploymentId)}${sha ? ` ${sha}` : ''} ${detail}`;
}

export async function notifyDeployTerminal(db: ShipwayDb, fetchImpl: typeof fetch, p: DeployNotifyPayload): Promise<void> {
  const deploymentRow = db
    .select({ projectId: deployments.projectId, commitSha: deployments.commitSha })
    .from(deployments)
    .where(eq(deployments.id, p.deploymentId))
    .get();

  // Legacy per-project/global webhook: unchanged v1 gating — every failure sends, a success only
  // sends once `notify_on_success` is explicitly true.
  const sendsLegacyWebhook = p.status !== 'success' || getSetting<boolean>(db, 'notify_on_success') === true;
  if (sendsLegacyWebhook) {
    const projectRow = deploymentRow
      ? db.select({ notifyWebhookUrl: projects.notifyWebhookUrl }).from(projects).where(eq(projects.id, deploymentRow.projectId)).get()
      : undefined;
    const webhookUrl = projectRow?.notifyWebhookUrl ?? getSetting<string>(db, 'notify_webhook_url');
    if (webhookUrl) {
      await sendDeployNotification(fetchImpl, webhookUrl, p);
    }
  }

  // Bus event: additive, always emitted regardless of notify_on_success — reaches only channels
  // that are themselves subscribed to the event (see emitEvent).
  const event: NotifyEvent = p.status === 'success' ? 'deploy_succeeded' : p.rolledBack ? 'deploy_rolled_back' : 'deploy_failed';
  const message = busMessage(p.project, p.deploymentId, deploymentRow?.commitSha, p.message);
  await emitEvent(db, event, { title: EVENTS[event].label, message }, fetchImpl);
}

export async function notifyDeployCanceled(db: ShipwayDb, fetchImpl: typeof fetch, deploymentId: number): Promise<void> {
  const row = db
    .select({ slug: projects.slug, commitSha: deployments.commitSha })
    .from(deployments)
    .innerJoin(projects, eq(deployments.projectId, projects.id))
    .where(eq(deployments.id, deploymentId))
    .get();
  if (!row) return;

  const message = busMessage(row.slug, deploymentId, row.commitSha, 'deploy canceled');
  await emitEvent(db, 'deploy_canceled', { title: EVENTS.deploy_canceled.label, message }, fetchImpl);
}
