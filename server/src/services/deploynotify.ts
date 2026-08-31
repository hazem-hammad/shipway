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
import type { SecretBox } from '../lib/secretbox.js';
import { emitProjectEvent, type NotifyEvent, type NotifyOutcome } from './notifybus.js';
import { buildDeployEmail } from './notifyemail.js';
import type { TransportFactory } from './mailer.js';
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

export async function notifyDeployTerminal(
  db: ShipwayDb,
  fetchImpl: typeof fetch,
  p: DeployNotifyPayload,
  secretBox?: SecretBox,
  /** Test-only override for the mail transport the project notification is delivered through,
   * mirroring `services/mailer.ts`'s `sendMail`. Production wiring (`app.ts`) never passes it. */
  mailTransportFactory?: TransportFactory,
): Promise<NotifyOutcome> {
  const deploymentRow = db
    .select({ projectId: deployments.projectId, commitSha: deployments.commitSha, commitMessage: deployments.commitMessage })
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

  // Project notification: additive, always emitted regardless of notify_on_success — it reaches only
  // the recipients of THIS deployment's project, and only when that project subscribes to the event
  // (see emitProjectEvent). Without a deployment row there's no project to notify, so it's skipped
  // rather than guessed at — the legacy webhook above has already had its turn either way.
  if (!deploymentRow) return { status: 'skipped', reason: `deployment ${String(p.deploymentId)} not found` };
  const event: NotifyEvent = p.status === 'success' ? 'deploy_succeeded' : p.rolledBack ? 'deploy_rolled_back' : 'deploy_failed';

  // `p.message` means different things by status (see `DeployNotifyPayload`): on success it IS the
  // commit message, on failure it's a stage-failure summary. The email keeps those in separate
  // slots — a highlighted commit block and a "what went wrong" block — so split them here rather
  // than letting the template guess. The stored `commitMessage` is preferred for the commit block
  // (it's the real one either way); `p.message` only fills in when a successful deploy has no stored
  // message, which is how a manually triggered deploy with no commit metadata can arrive.
  const isSuccess = p.status === 'success';
  const commitMessage = deploymentRow.commitMessage ?? (isSuccess ? p.message : null);
  const email = buildDeployEmail({
    event,
    projectId: deploymentRow.projectId,
    projectSlug: p.project,
    deploymentId: p.deploymentId,
    commitSha: deploymentRow.commitSha,
    commitMessage,
    detail: isSuccess ? null : p.message,
    baseDomain: getSetting<string>(db, 'base_domain') ?? null,
  });

  return emitProjectEvent(db, deploymentRow.projectId, event, email, secretBox, mailTransportFactory);
}

export async function notifyDeployCanceled(
  db: ShipwayDb,
  deploymentId: number,
  secretBox?: SecretBox,
  /** Test-only, same as `notifyDeployTerminal`'s. */
  mailTransportFactory?: TransportFactory,
): Promise<NotifyOutcome> {
  const row = db
    .select({ projectId: projects.id, slug: projects.slug, commitSha: deployments.commitSha, commitMessage: deployments.commitMessage })
    .from(deployments)
    .innerJoin(projects, eq(deployments.projectId, projects.id))
    .where(eq(deployments.id, deploymentId))
    .get();
  if (!row) return { status: 'skipped', reason: `deployment ${String(deploymentId)} not found` };

  const email = buildDeployEmail({
    event: 'deploy_canceled',
    projectId: row.projectId,
    projectSlug: row.slug,
    deploymentId,
    commitSha: row.commitSha,
    commitMessage: row.commitMessage,
    // A cancellation has nothing to explain beyond the status pill itself — it was deliberate.
    detail: null,
    baseDomain: getSetting<string>(db, 'base_domain') ?? null,
  });

  return emitProjectEvent(db, row.projectId, 'deploy_canceled', email, secretBox, mailTransportFactory);
}
