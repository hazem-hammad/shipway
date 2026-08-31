/**
 * `services/deploynotify.ts` is the exact function wired into `PipelineDeps.notify` (app.ts): it
 * preserves v1's legacy webhook behavior (per-project `notifyWebhookUrl` override / global
 * `notify_webhook_url` fallback, gated by `notify_on_success`) AND additionally — always, regardless
 * of that gate — emails the deploying project's own notification recipients (`services/notifybus.ts`)
 * for the matching event. `notifyDeployCanceled` covers the one terminal status the pipeline's own
 * `notify` hook never calls (cancellation).
 *
 * Tested directly against a real (tmp) db, a fake fetch (legacy webhook) and a fake mail transport
 * (project notifications), independent of the full pipeline/app — see server/src/app.ts for the thin
 * wiring that calls these.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { deployments, projectNotificationEvents, projectNotificationRecipients, projects } from '../src/db/schema.js';
import { SecretBox } from '../src/lib/secretbox.js';
import { saveMailConfig, type MailTransport } from '../src/services/mailer.js';
import { setSetting } from '../src/db/settings.js';
import { notifyDeployCanceled, notifyDeployTerminal } from '../src/services/deploynotify.js';

function tmpDb(): ShipwayDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-deploynotify-test-'));
  return openDb(path.join(dir, 'shipway.db'));
}

function insertProject(db: ShipwayDb, slug: string, notifyWebhookUrl: string | null = null): number {
  db.insert(projects)
    .values({ name: slug, slug, repo: `acme/${slug}`, branch: 'main', type: 'static', notifyWebhookUrl })
    .run();
  const row = db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get();
  if (!row) throw new Error('failed to insert test project');
  return row.id;
}

function insertDeployment(db: ShipwayDb, projectId: number, commitSha: string | null = null, commitMessage: string | null = null): number {
  db.insert(deployments).values({ projectId, status: 'running', trigger: 'push', commitSha, commitMessage }).run();
  const rows = db.select({ id: deployments.id }).from(deployments).where(eq(deployments.projectId, projectId)).all();
  const last = rows[rows.length - 1];
  if (!last) throw new Error('failed to insert test deployment');
  return last.id;
}

/** Gives `projectId` a recipient list and an event subscription, and configures instance mail so the
 * notification can actually be delivered. Returns the `SecretBox` the mail config was written with
 * (both `notifyDeploy*` functions need it) plus a recording transport factory. */
function setUpNotifications(
  db: ShipwayDb,
  projectId: number,
  events: string[],
  emails: string[] = ['ops@example.com'],
): { secretBox: SecretBox; factory: () => MailTransport; sent: SentMail[] } {
  for (const email of emails) {
    db.insert(projectNotificationRecipients).values({ projectId, email }).run();
  }
  for (const event of events) {
    db.insert(projectNotificationEvents).values({ projectId, event }).run();
  }

  const secretBox = SecretBox.load(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-deploynotify-key-')), 'secret.key'));
  saveMailConfig(db, secretBox, { driver: 'smtp', host: 'smtp.example.com', port: 587, secure: false, fromAddress: 'shipway@example.com' });

  const sent: SentMail[] = [];
  const transport: MailTransport = {
    sendMail(options) {
      sent.push({ to: options.to, subject: options.subject, text: options.text, html: options.html });
      return Promise.resolve({});
    },
  };
  return { secretBox, factory: () => transport, sent };
}

interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string | undefined;
}

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: input.toString(), init });
    return Promise.resolve({ ok: true, status: 200 } as Response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function bodyText(call: RecordedCall | undefined): string {
  const body = JSON.parse((call?.init?.body as string) ?? '{}') as { text?: string; content?: string };
  return body.text ?? body.content ?? '';
}

describe('notifyDeployTerminal — legacy webhook (unchanged v1 behavior)', () => {
  it('sends the global notify_webhook_url on failure regardless of notify_on_success', async () => {
    const db = tmpDb();
    setSetting(db, 'notify_webhook_url', 'https://hooks.slack.com/services/global');
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const { fetchImpl, calls } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'failed', deploymentId, message: 'build failed' });

    const legacyCall = calls.find((c) => c.url === 'https://hooks.slack.com/services/global');
    expect(legacyCall).toBeDefined();
    expect(bodyText(legacyCall)).toContain('build failed');
  });

  it('skips the legacy send on success unless notify_on_success is explicitly true', async () => {
    const db = tmpDb();
    setSetting(db, 'notify_webhook_url', 'https://hooks.slack.com/services/global');
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const { fetchImpl, calls } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'success', deploymentId, message: 'deployed cleanly' });

    expect(calls.some((c) => c.url === 'https://hooks.slack.com/services/global')).toBe(false);
  });

  it('sends on success once notify_on_success is true', async () => {
    const db = tmpDb();
    setSetting(db, 'notify_webhook_url', 'https://hooks.slack.com/services/global');
    setSetting(db, 'notify_on_success', true);
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const { fetchImpl, calls } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'success', deploymentId, message: 'deployed cleanly' });

    expect(calls.some((c) => c.url === 'https://hooks.slack.com/services/global')).toBe(true);
  });

  it("prefers the project's own notifyWebhookUrl override over the global setting", async () => {
    const db = tmpDb();
    setSetting(db, 'notify_webhook_url', 'https://hooks.slack.com/services/global');
    const projectId = insertProject(db, 'shop', 'https://hooks.slack.com/services/project-override');
    const deploymentId = insertDeployment(db, projectId);
    const { fetchImpl, calls } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'failed', deploymentId, message: 'build failed' });

    expect(calls.some((c) => c.url === 'https://hooks.slack.com/services/project-override')).toBe(true);
    expect(calls.some((c) => c.url === 'https://hooks.slack.com/services/global')).toBe(false);
  });

  it('does not send any legacy webhook when neither the project nor the global setting has one configured', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const { fetchImpl, calls } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'failed', deploymentId, message: 'build failed' });

    expect(calls).toHaveLength(0);
  });
});

describe('notifyDeployTerminal — project notifications (additive, no notify_on_success coupling)', () => {
  it('emails the project\'s recipients on deploy_succeeded even when notify_on_success is not set (legacy webhook skipped)', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const { secretBox, factory, sent } = setUpNotifications(db, projectId, ['deploy_succeeded']);
    const { fetchImpl, calls } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'success', deploymentId, message: 'deployed cleanly' }, secretBox, factory);

    expect(calls).toHaveLength(0); // notify_on_success unset — the legacy webhook stays silent
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('ops@example.com');
    expect(sent[0]?.subject).toBe('[shop] Deploy succeeded (#' + String(deploymentId) + ')');
    expect(sent[0]?.text).toContain('deployed cleanly');
  });

  it('emits deploy_failed for a plain failure (rolledBack not set)', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const { secretBox, factory, sent } = setUpNotifications(db, projectId, ['deploy_failed', 'deploy_rolled_back']);
    const { fetchImpl } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'failed', deploymentId, message: 'build failed' }, secretBox, factory);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('Deploy failed');
    // A failure summary is NOT the commit message: it belongs in its own block.
    expect(sent[0]?.text).toContain('What went wrong');
    expect(sent[0]?.text).toContain('build failed');
  });

  it('emits deploy_rolled_back instead of deploy_failed when rolledBack is true', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const { secretBox, factory, sent } = setUpNotifications(db, projectId, ['deploy_failed', 'deploy_rolled_back']);
    const { fetchImpl } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'failed', deploymentId, message: 'health check failed', rolledBack: true }, secretBox, factory);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('Deploy rolled back');
  });

  it('goes only to the deploying project\'s recipients, never another project\'s', async () => {
    const db = tmpDb();
    const shop = insertProject(db, 'shop');
    const blog = insertProject(db, 'blog');
    const deploymentId = insertDeployment(db, shop);
    const { secretBox, factory, sent } = setUpNotifications(db, shop, ['deploy_failed'], ['shop@example.com']);
    // The other project is configured identically and must stay untouched.
    db.insert(projectNotificationRecipients).values({ projectId: blog, email: 'blog@example.com' }).run();
    db.insert(projectNotificationEvents).values({ projectId: blog, event: 'deploy_failed' }).run();
    const { fetchImpl } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'failed', deploymentId, message: 'build failed' }, secretBox, factory);

    expect(sent.map((m) => m.to)).toEqual(['shop@example.com']);
  });

  it('carries the project, deployment number and short sha into the email', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId, 'abcdef1234567890');
    const { secretBox, factory, sent } = setUpNotifications(db, projectId, ['deploy_succeeded']);
    const { fetchImpl } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'success', deploymentId, message: 'first commit' }, secretBox, factory);

    expect(sent[0]?.text).toContain('shop');
    expect(sent[0]?.text).toContain(`#${String(deploymentId)}`);
    expect(sent[0]?.text).toContain('abcdef1');
    expect(sent[0]?.text).not.toContain('abcdef1234567890'); // abbreviated, not the full sha
  });

  it('omits the commit line entirely when the deployment has no sha', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId, null);
    const { secretBox, factory, sent } = setUpNotifications(db, projectId, ['deploy_succeeded']);
    const { fetchImpl } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'success', deploymentId, message: 'first commit' }, secretBox, factory);

    expect(sent[0]?.text).not.toContain('Commit:');
  });

  it('highlights the stored commit message, preferring it over the payload message', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId, 'abcdef1234567890', 'Add checkout summary');
    const { secretBox, factory, sent } = setUpNotifications(db, projectId, ['deploy_failed']);
    const { fetchImpl } = fakeFetch();

    // A FAILED deploy still shows what was being deployed — that's usually the first question.
    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'failed', deploymentId, message: 'npm run build exited 1' }, secretBox, factory);

    expect(sent[0]?.text).toContain('Commit message:');
    expect(sent[0]?.text).toContain('Add checkout summary');
    expect(sent[0]?.text).toContain('npm run build exited 1');
  });

  it('links to the deploy log when a base domain is configured, and omits the link when not', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const { secretBox, factory, sent } = setUpNotifications(db, projectId, ['deploy_succeeded']);
    const { fetchImpl } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'success', deploymentId, message: 'x' }, secretBox, factory);
    expect(sent[0]?.text).not.toContain('https://');

    setSetting(db, 'base_domain', 'example.com');
    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'success', deploymentId, message: 'x' }, secretBox, factory);
    expect(sent[1]?.text).toContain(`https://ship.example.com/projects/${String(projectId)}/deployments/${String(deploymentId)}`);
  });

  it('a failed notification send does not throw and does not prevent the legacy webhook from having been sent', async () => {
    const db = tmpDb();
    setSetting(db, 'notify_webhook_url', 'https://hooks.slack.com/services/legacy-still-works');
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const { secretBox } = setUpNotifications(db, projectId, ['deploy_failed']);
    const failing: MailTransport = { sendMail: () => Promise.reject(new Error('smtp down')) };
    const { fetchImpl, calls } = fakeFetch();

    await expect(
      notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'failed', deploymentId, message: 'build failed' }, secretBox, () => failing),
    ).resolves.toMatchObject({ status: 'failed' });

    expect(calls.some((c) => c.url === 'https://hooks.slack.com/services/legacy-still-works')).toBe(true);
  });
});

describe('notifyDeployCanceled', () => {
  it('emails deploy_canceled with the project slug + deployment id in the message', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const { secretBox, factory, sent } = setUpNotifications(db, projectId, ['deploy_canceled']);

    await notifyDeployCanceled(db, deploymentId, secretBox, factory);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe(`[shop] Deploy canceled (#${String(deploymentId)})`);
    expect(sent[0]?.text).toContain('shop');
    expect(sent[0]?.text).toContain(`#${String(deploymentId)}`);
  });

  it('is a silent no-op for an unknown deployment id', async () => {
    const db = tmpDb();

    await expect(notifyDeployCanceled(db, 999999)).resolves.toMatchObject({ status: 'skipped' });
  });
});
