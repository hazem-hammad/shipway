/**
 * The plain-text template for a project's deploy notification emails (`services/notifybus.ts`
 * delivers what this builds; `services/deploynotify.ts` supplies the facts).
 *
 * Text only, deliberately. An HTML version existed and was reverted: strict corporate filters score
 * HTML mail harder than plain text, and a deploy notification has nothing to gain from styling that
 * a well-shaped text body can't carry. What the layout does carry is a hierarchy — the OUTCOME
 * first, as a marker a reader can scan a mailbox for, then the project, then the COMMIT MESSAGE in
 * its own labelled block, since that's the thing anyone actually opens the mail to see.
 *
 * Pure and synchronous — no db, no network — so a caller's only failure mode is the send itself.
 */
import type { NotifyEvent } from './notifybus.js';

/** Leads the body and distinguishes the outcome at a glance, including in a mailbox search. */
const EVENT_MARKERS: Record<NotifyEvent, { label: string; marker: string }> = {
  deploy_succeeded: { label: 'Deploy succeeded', marker: '[OK]' },
  deploy_failed: { label: 'Deploy failed', marker: '[FAILED]' },
  deploy_rolled_back: { label: 'Deploy rolled back', marker: '[ROLLED BACK]' },
  deploy_canceled: { label: 'Deploy canceled', marker: '[CANCELED]' },
};

export interface DeployEmailInput {
  event: NotifyEvent;
  projectId: number;
  /** The project's slug — leads the subject and appears in the body. */
  projectSlug: string;
  deploymentId: number;
  commitSha: string | null;
  /** The deployed commit's message — the body's focal point when there is one. */
  commitMessage: string | null;
  /** A stage-failure summary for a failed/rolled-back deploy; `null` when there's nothing to add
   * beyond the outcome itself. */
  detail: string | null;
  /** The `base_domain` setting, or `null` when the instance hasn't configured one — with no domain
   * the email omits its deploy-log link rather than inventing a host. */
  baseDomain: string | null;
}

export interface EmailContent {
  subject: string;
  text: string;
}

/** 7-char short sha (git's default abbreviation), or `null` when the deployment has no commit. */
function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

/** The dashboard URL for one deployment's log, or `null` without a configured base domain. `ship.`
 * is Shipway's own dashboard subdomain — same hardcoded convention as `mailer.ts`'s
 * `buildInviteEmail` and `setup/install.sh`'s vhost provisioning. */
function deployLogUrl(baseDomain: string | null, projectId: number, deploymentId: number): string | null {
  const domain = baseDomain?.trim();
  if (!domain) return null;
  return `https://ship.${domain}/projects/${String(projectId)}/deployments/${String(deploymentId)}`;
}

/** Indents a block, leaving blank lines genuinely blank rather than turning the paragraph breaks in
 * a multi-line commit message into lines of trailing whitespace. */
function indent(block: string): string[] {
  return block.split('\n').map((line) => (line.trim() === '' ? '' : `  ${line}`));
}

/**
 * Builds the deploy notification email: subject and plain-text body.
 *
 * The subject leads with the project because an inbox is skimmed by subject and "which project" is
 * the question a reader asks before "what happened". The deployment id is globally unique
 * (`deployments.id` is a single autoincrement across all projects), so the subject identifies one
 * specific deploy. No em dashes, per DESIGN.md's copy rules.
 */
export function buildDeployEmail(input: DeployEmailInput): EmailContent {
  const { label, marker } = EVENT_MARKERS[input.event];
  const sha = shortSha(input.commitSha);
  const url = deployLogUrl(input.baseDomain, input.projectId, input.deploymentId);
  const commitMessage = input.commitMessage?.trim() ?? '';
  const detail = input.detail?.trim() ?? '';

  const subject = `[${input.projectSlug}] ${label} (#${String(input.deploymentId)})`;

  const lines = [`${marker} ${label}`, '', `Project:    ${input.projectSlug}`, `Deployment: #${String(input.deploymentId)}`];
  if (sha) lines.push(`Commit:     ${sha}`);

  if (commitMessage !== '') {
    lines.push('', 'Commit message:', ...indent(commitMessage));
  }
  if (detail !== '') {
    lines.push('', `${input.event === 'deploy_succeeded' ? 'Details' : 'What went wrong'}:`, ...indent(detail));
  }
  if (url) lines.push('', `View the deploy log: ${url}`);

  lines.push('', "Sent by Shipway because your address is on this project's notification list (Project > Settings > Notifications).");

  return { subject, text: lines.join('\n') };
}

/**
 * The "Send test email" content (`POST /api/projects/:id/notifications/test`). Built from the SAME
 * template as a real notification, with sample values, so what an admin sees in the test is exactly
 * what a real deploy will look like. The subject is marked so nobody mistakes it for a real deploy.
 */
export function buildTestNotificationEmail(projectSlug: string, projectId: number, baseDomain: string | null): EmailContent {
  const base = buildDeployEmail({
    event: 'deploy_succeeded',
    projectId,
    projectSlug,
    deploymentId: 1,
    commitSha: 'a1b2c3d4e5f60718',
    commitMessage: 'Add checkout summary to the order confirmation page',
    detail: null,
    baseDomain,
  });

  return {
    subject: `[${projectSlug}] Test notification`,
    text: ['This is a test notification from Shipway. A real deploy email looks like this:', '', base.text].join('\n'),
  };
}
