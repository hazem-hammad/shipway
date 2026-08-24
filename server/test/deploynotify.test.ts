/**
 * `services/deploynotify.ts` is the exact function wired into `PipelineDeps.notify` (app.ts): it
 * preserves v1's legacy webhook behavior (per-project `notifyWebhookUrl` override / global
 * `notify_webhook_url` fallback, gated by `notify_on_success`) AND additionally — always, regardless
 * of that gate — emits the matching Task 4 bus event. `notifyDeployCanceled` covers the one terminal
 * status the pipeline's own `notify` hook never calls (cancellation).
 *
 * Tested directly against a real (tmp) db + a fake fetch, independent of the full pipeline/app —
 * see server/src/app.ts for the thin wiring that calls these.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { deployments, notificationChannels, notificationSubscriptions, projects } from '../src/db/schema.js';
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

function insertDeployment(db: ShipwayDb, projectId: number, commitSha: string | null = null): number {
  db.insert(deployments).values({ projectId, status: 'running', trigger: 'push', commitSha }).run();
  const rows = db.select({ id: deployments.id }).from(deployments).where(eq(deployments.projectId, projectId)).all();
  const last = rows[rows.length - 1];
  if (!last) throw new Error('failed to insert test deployment');
  return last.id;
}

function insertChannel(db: ShipwayDb, name: string, url: string): number {
  db.insert(notificationChannels).values({ name, url }).run();
  const row = db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.name, name)).get();
  if (!row) throw new Error('failed to insert test channel');
  return row.id;
}

function subscribeAll(db: ShipwayDb, channelId: number, events: string[]): void {
  for (const event of events) {
    db.insert(notificationSubscriptions).values({ event, channelId }).run();
  }
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

describe('notifyDeployTerminal — bus events (additive, no notify_on_success coupling)', () => {
  it('emits deploy_succeeded to a subscribed channel even when notify_on_success is not set (legacy send skipped)', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const channelId = insertChannel(db, 'bus-channel', 'https://hooks.slack.com/services/bus');
    subscribeAll(db, channelId, ['deploy_succeeded']);
    const { fetchImpl, calls } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'success', deploymentId, message: 'deployed cleanly' });

    const busCall = calls.find((c) => c.url === 'https://hooks.slack.com/services/bus');
    expect(busCall).toBeDefined();
    expect(bodyText(busCall)).toContain('Deploy succeeded');
    expect(bodyText(busCall)).toContain('deployed cleanly');
  });

  it('emits deploy_failed for a plain failure (rolledBack not set)', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const channelId = insertChannel(db, 'failed-channel', 'https://hooks.slack.com/services/failed');
    subscribeAll(db, channelId, ['deploy_failed', 'deploy_rolled_back']);
    const { fetchImpl, calls } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'failed', deploymentId, message: 'build failed' });

    expect(bodyText(calls[0])).toContain('Deploy failed');
    expect(bodyText(calls[0])).not.toContain('Deploy rolled back');
  });

  it('emits deploy_rolled_back instead of deploy_failed when rolledBack is true', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const channelId = insertChannel(db, 'rollback-channel', 'https://hooks.slack.com/services/rollback');
    subscribeAll(db, channelId, ['deploy_failed', 'deploy_rolled_back']);
    const { fetchImpl, calls } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'failed', deploymentId, message: 'health check failed', rolledBack: true });

    expect(bodyText(calls[0])).toContain('Deploy rolled back');
  });

  it('formats the bus message as "[slug] deploy #id <sha> detail", short sha included when the deployment has one', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId, 'abcdef1234567890');
    const channelId = insertChannel(db, 'fmt-channel', 'https://hooks.slack.com/services/fmt');
    subscribeAll(db, channelId, ['deploy_succeeded']);
    const { fetchImpl, calls } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'success', deploymentId, message: 'first commit' });

    const text = bodyText(calls[0]);
    expect(text).toContain(`[shop] deploy #${String(deploymentId)} abcdef1`);
    expect(text).toContain('first commit');
  });

  it('omits the sha segment when the deployment has none', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId, null);
    const channelId = insertChannel(db, 'nosha-channel', 'https://hooks.slack.com/services/nosha');
    subscribeAll(db, channelId, ['deploy_succeeded']);
    const { fetchImpl, calls } = fakeFetch();

    await notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'success', deploymentId, message: 'first commit' });

    expect(bodyText(calls[0])).toContain(`[shop] deploy #${String(deploymentId)} first commit`);
  });

  it('a bus delivery failure does not throw and does not prevent the legacy webhook from having been sent', async () => {
    const db = tmpDb();
    setSetting(db, 'notify_webhook_url', 'https://hooks.slack.com/services/legacy-still-works');
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const channelId = insertChannel(db, 'flaky-bus-channel', 'https://hooks.slack.com/services/flaky-bus');
    subscribeAll(db, channelId, ['deploy_failed']);

    const calls: RecordedCall[] = [];
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, init });
      if (url.includes('flaky-bus')) return Promise.reject(new Error('network down'));
      return Promise.resolve({ ok: true, status: 200 } as Response);
    }) as typeof fetch;

    await expect(
      notifyDeployTerminal(db, fetchImpl, { project: 'shop', status: 'failed', deploymentId, message: 'build failed' }),
    ).resolves.toBeUndefined();

    expect(calls.some((c) => c.url === 'https://hooks.slack.com/services/legacy-still-works')).toBe(true);
  });
});

describe('notifyDeployCanceled', () => {
  it('emits deploy_canceled with the project slug + deployment id in the message', async () => {
    const db = tmpDb();
    const projectId = insertProject(db, 'shop');
    const deploymentId = insertDeployment(db, projectId);
    const channelId = insertChannel(db, 'cancel-channel', 'https://hooks.slack.com/services/cancel');
    subscribeAll(db, channelId, ['deploy_canceled']);
    const { fetchImpl, calls } = fakeFetch();

    await notifyDeployCanceled(db, fetchImpl, deploymentId);

    expect(calls).toHaveLength(1);
    const text = bodyText(calls[0]);
    expect(text).toContain('Deploy canceled');
    expect(text).toContain(`[shop] deploy #${String(deploymentId)}`);
  });

  it('is a silent no-op for an unknown deployment id', async () => {
    const db = tmpDb();
    const { fetchImpl, calls } = fakeFetch();

    await expect(notifyDeployCanceled(db, fetchImpl, 999999)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
