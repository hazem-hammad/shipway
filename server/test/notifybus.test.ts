/**
 * Project deploy notifications (`services/notifybus.ts`): `EVENTS`/`DEFAULT_SUBSCRIBED_EVENTS` (the
 * four deploy events a project can subscribe to and the set a new project starts with) and
 * `emitProjectEvent`, which emails a project's recipients when — and only when — that project is
 * subscribed to the event being emitted.
 *
 * The instance-wide channel bus this replaced is gone, along with webhook/Teams delivery and the
 * host-wide `service_down`/`service_recovered` events (see the module doc comment).
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, type ShipwayDb } from '../src/db/index.js';
import { projectNotificationEvents, projectNotificationRecipients, projects } from '../src/db/schema.js';
import { SecretBox } from '../src/lib/secretbox.js';
import { saveMailConfig, type MailTransport } from '../src/services/mailer.js';
import {
  DEFAULT_SUBSCRIBED_EVENTS,
  EVENTS,
  EVENT_KEYS,
  describeOutcome,
  emitProjectEvent,
  getProjectRecipients,
  getProjectSubscribedEvents,
  type NotifyEvent,
} from '../src/services/notifybus.js';

interface Fixtures {
  db: ShipwayDb;
  secretBox: SecretBox;
}

function tmpFixtures(): Fixtures {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipway-notifybus-test-'));
  return { db: openDb(path.join(dir, 'shipway.db')), secretBox: SecretBox.load(path.join(dir, 'secret.key')) };
}

function insertProject(db: ShipwayDb, slug: string): number {
  db.insert(projects).values({ name: slug, slug, repo: `acme/${slug}`, branch: 'main', type: 'static' }).run();
  const row = db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get();
  if (!row) throw new Error('failed to insert test project');
  return row.id;
}

function addRecipients(db: ShipwayDb, projectId: number, emails: string[]): void {
  for (const email of emails) {
    db.insert(projectNotificationRecipients).values({ projectId, email }).run();
  }
}

function subscribe(db: ShipwayDb, projectId: number, events: NotifyEvent[]): void {
  for (const event of events) {
    db.insert(projectNotificationEvents).values({ projectId, event }).run();
  }
}

/** Configures a usable instance mail config, so the only thing under test is the bus's own logic. */
function configureMail(fx: Fixtures): void {
  saveMailConfig(fx.db, fx.secretBox, { driver: 'smtp', host: 'smtp.example.com', port: 587, secure: false, fromAddress: 'shipway@example.com' });
}

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

/** A `MailTransport` factory recording every send, optionally failing for chosen addresses. */
function fakeMail(failFor: string[] = []): { factory: () => MailTransport; sent: SentMail[] } {
  const sent: SentMail[] = [];
  const transport: MailTransport = {
    sendMail(options) {
      if (failFor.includes(options.to)) return Promise.reject(new Error('mailbox unavailable'));
      sent.push({ to: options.to, subject: options.subject, text: options.text });
      return Promise.resolve({});
    },
  };
  return { factory: () => transport, sent };
}

describe('EVENTS', () => {
  it('covers exactly the four deploy events — the host-wide service events are gone', () => {
    expect(EVENT_KEYS).toEqual(['deploy_failed', 'deploy_succeeded', 'deploy_canceled', 'deploy_rolled_back']);
    expect(Object.keys(EVENTS)).not.toContain('service_down');
    expect(Object.keys(EVENTS)).not.toContain('service_recovered');
  });

  it('gives every event a label and a description for the project Notifications card', () => {
    for (const event of EVENT_KEYS) {
      expect(EVENTS[event].label.length).toBeGreaterThan(0);
      expect(EVENTS[event].description.length).toBeGreaterThan(0);
    }
  });

  it('defaults a new project to every event except a successful deploy', () => {
    expect(DEFAULT_SUBSCRIBED_EVENTS).toEqual(['deploy_failed', 'deploy_canceled', 'deploy_rolled_back']);
    expect(DEFAULT_SUBSCRIBED_EVENTS).not.toContain('deploy_succeeded');
  });
});

describe('getProjectRecipients / getProjectSubscribedEvents', () => {
  it('are empty for a project with nothing configured', () => {
    const fx = tmpFixtures();
    const projectId = insertProject(fx.db, 'shop');
    expect(getProjectRecipients(fx.db, projectId)).toEqual([]);
    expect(getProjectSubscribedEvents(fx.db, projectId)).toEqual([]);
  });

  it('are scoped per project — one project\'s config never leaks into another\'s', () => {
    const fx = tmpFixtures();
    const shop = insertProject(fx.db, 'shop');
    const blog = insertProject(fx.db, 'blog');
    addRecipients(fx.db, shop, ['shop@example.com']);
    subscribe(fx.db, shop, ['deploy_failed']);

    expect(getProjectRecipients(fx.db, blog)).toEqual([]);
    expect(getProjectSubscribedEvents(fx.db, blog)).toEqual([]);
    expect(getProjectRecipients(fx.db, shop)).toEqual(['shop@example.com']);
  });

  it('ignores a stored event row that is no longer a known event', () => {
    const fx = tmpFixtures();
    const projectId = insertProject(fx.db, 'shop');
    // A row left behind by one of the removed service events.
    fx.db.insert(projectNotificationEvents).values({ projectId, event: 'service_down' }).run();
    subscribe(fx.db, projectId, ['deploy_failed']);

    expect(getProjectSubscribedEvents(fx.db, projectId)).toEqual(['deploy_failed']);
  });

  it('drops a project\'s recipients and events when the project is deleted (FK cascade)', () => {
    const fx = tmpFixtures();
    const projectId = insertProject(fx.db, 'shop');
    addRecipients(fx.db, projectId, ['ops@example.com']);
    subscribe(fx.db, projectId, ['deploy_failed']);

    fx.db.delete(projects).where(eq(projects.id, projectId)).run();

    expect(fx.db.select().from(projectNotificationRecipients).all()).toHaveLength(0);
    expect(fx.db.select().from(projectNotificationEvents).all()).toHaveLength(0);
  });
});

describe('emitProjectEvent outcomes', () => {
  it('reports how many recipients it emailed', async () => {
    const fx = tmpFixtures();
    configureMail(fx);
    const projectId = insertProject(fx.db, 'shop');
    addRecipients(fx.db, projectId, ['a@example.com', 'b@example.com']);
    subscribe(fx.db, projectId, ['deploy_failed']);
    const { factory } = fakeMail();

    const outcome = await emitProjectEvent(fx.db, projectId, 'deploy_failed', { subject: 's', text: 't' }, fx.secretBox, factory);

    expect(outcome).toEqual({ status: 'sent', recipients: 2, messageIds: [] });
    expect(describeOutcome(outcome)).toBe('notification: emailed 2 recipients');
  });

  it('says WHY it skipped, distinguishing every reason', async () => {
    const fx = tmpFixtures();
    const projectId = insertProject(fx.db, 'shop');

    // Not subscribed.
    let outcome = await emitProjectEvent(fx.db, projectId, 'deploy_failed', { subject: 's', text: 't' }, fx.secretBox);
    expect(outcome).toEqual({ status: 'skipped', reason: 'project is not subscribed to deploy_failed' });

    // Subscribed, but nobody to email.
    subscribe(fx.db, projectId, ['deploy_failed']);
    outcome = await emitProjectEvent(fx.db, projectId, 'deploy_failed', { subject: 's', text: 't' }, fx.secretBox);
    expect(outcome).toEqual({ status: 'skipped', reason: 'no recipients configured for this project' });

    // Recipients, but instance mail was never set up.
    addRecipients(fx.db, projectId, ['a@example.com']);
    outcome = await emitProjectEvent(fx.db, projectId, 'deploy_failed', { subject: 's', text: 't' }, fx.secretBox);
    expect(outcome).toEqual({ status: 'skipped', reason: 'instance mail is not configured' });
    expect(describeOutcome(outcome)).toBe('notification: skipped (instance mail is not configured)');
  });

  it('reports a partial failure with the count that still went out', async () => {
    const fx = tmpFixtures();
    configureMail(fx);
    const projectId = insertProject(fx.db, 'shop');
    addRecipients(fx.db, projectId, ['broken@example.com', 'ok@example.com']);
    subscribe(fx.db, projectId, ['deploy_failed']);
    const { factory } = fakeMail(['broken@example.com']);

    const outcome = await emitProjectEvent(fx.db, projectId, 'deploy_failed', { subject: 's', text: 't' }, fx.secretBox, factory);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.sent).toBe(1);
      expect(outcome.failed).toBe(1);
      expect(outcome.error).toContain('mailbox unavailable');
      expect(describeOutcome(outcome)).toBe(`notification: 1 of 2 failed (${outcome.error})`);
    }
  });

  it('phrases a single recipient in the singular', () => {
    expect(describeOutcome({ status: 'sent', recipients: 1, messageIds: [] })).toBe('notification: emailed 1 recipient');
  });

  it('carries the provider message ids into the summary, so a send can be traced', async () => {
    const fx = tmpFixtures();
    configureMail(fx);
    const projectId = insertProject(fx.db, 'shop');
    addRecipients(fx.db, projectId, ['a@example.com']);
    subscribe(fx.db, projectId, ['deploy_failed']);

    // A transport answering the way SES does: `250 Ok <id>`.
    const transport: MailTransport = { sendMail: () => Promise.resolve({ response: '250 Ok 010701a04a9459d1-abc-000000' }) };

    const outcome = await emitProjectEvent(fx.db, projectId, 'deploy_failed', { subject: 's', text: 't' }, fx.secretBox, () => transport);

    expect(outcome).toEqual({ status: 'sent', recipients: 1, messageIds: ['010701a04a9459d1-abc-000000'] });
    expect(describeOutcome(outcome)).toBe('notification: emailed 1 recipient (010701a04a9459d1-abc-000000)');
  });
});

describe('emitProjectEvent', () => {
  it('emails every recipient of a subscribed project, with the payload as subject/body', async () => {
    const fx = tmpFixtures();
    configureMail(fx);
    const projectId = insertProject(fx.db, 'shop');
    addRecipients(fx.db, projectId, ['ops@example.com', 'dev@example.com']);
    subscribe(fx.db, projectId, ['deploy_failed']);
    const { factory, sent } = fakeMail();

    await emitProjectEvent(fx.db, projectId, 'deploy_failed', { subject: 'Deploy failed', text: '[shop] deploy #1 build failed' }, fx.secretBox, factory);

    expect(sent.map((m) => m.to).sort()).toEqual(['dev@example.com', 'ops@example.com']);
    expect(sent[0]?.subject).toBe('Deploy failed');
    expect(sent[0]?.text).toBe('[shop] deploy #1 build failed');
  });

  it('sends nothing when the project is not subscribed to that event', async () => {
    const fx = tmpFixtures();
    configureMail(fx);
    const projectId = insertProject(fx.db, 'shop');
    addRecipients(fx.db, projectId, ['ops@example.com']);
    subscribe(fx.db, projectId, ['deploy_failed']);
    const { factory, sent } = fakeMail();

    await emitProjectEvent(fx.db, projectId, 'deploy_succeeded', { subject: 'Deploy succeeded', text: 'ok' }, fx.secretBox, factory);

    expect(sent).toHaveLength(0);
  });

  it('sends nothing when a subscribed project has no recipients', async () => {
    const fx = tmpFixtures();
    configureMail(fx);
    const projectId = insertProject(fx.db, 'shop');
    subscribe(fx.db, projectId, ['deploy_failed']);
    const { factory, sent } = fakeMail();

    await emitProjectEvent(fx.db, projectId, 'deploy_failed', { subject: 'Deploy failed', text: 'x' }, fx.secretBox, factory);

    expect(sent).toHaveLength(0);
  });

  it('never notifies a different project\'s recipients', async () => {
    const fx = tmpFixtures();
    configureMail(fx);
    const shop = insertProject(fx.db, 'shop');
    const blog = insertProject(fx.db, 'blog');
    addRecipients(fx.db, shop, ['shop@example.com']);
    addRecipients(fx.db, blog, ['blog@example.com']);
    subscribe(fx.db, shop, ['deploy_failed']);
    subscribe(fx.db, blog, ['deploy_failed']);
    const { factory, sent } = fakeMail();

    await emitProjectEvent(fx.db, shop, 'deploy_failed', { subject: 'Deploy failed', text: 'x' }, fx.secretBox, factory);

    expect(sent.map((m) => m.to)).toEqual(['shop@example.com']);
  });

  it('resolves without throwing (and sends nothing) when instance mail is not configured', async () => {
    const fx = tmpFixtures(); // deliberately no configureMail
    const projectId = insertProject(fx.db, 'shop');
    addRecipients(fx.db, projectId, ['ops@example.com']);
    subscribe(fx.db, projectId, ['deploy_failed']);
    const { factory, sent } = fakeMail();

    await expect(
      emitProjectEvent(fx.db, projectId, 'deploy_failed', { subject: 'Deploy failed', text: 'x' }, fx.secretBox, factory),
    ).resolves.toMatchObject({ status: 'skipped' });
    expect(sent).toHaveLength(0);
  });

  it('resolves without throwing when no secretBox is available to read the mail config', async () => {
    const fx = tmpFixtures();
    configureMail(fx);
    const projectId = insertProject(fx.db, 'shop');
    addRecipients(fx.db, projectId, ['ops@example.com']);
    subscribe(fx.db, projectId, ['deploy_failed']);

    await expect(emitProjectEvent(fx.db, projectId, 'deploy_failed', { subject: 'Deploy failed', text: 'x' }, undefined)).resolves.toMatchObject({
      status: 'skipped',
    });
  });

  it('one failing recipient never stops the others from being delivered', async () => {
    const fx = tmpFixtures();
    configureMail(fx);
    const projectId = insertProject(fx.db, 'shop');
    addRecipients(fx.db, projectId, ['broken@example.com', 'ops@example.com']);
    subscribe(fx.db, projectId, ['deploy_failed']);
    const { factory, sent } = fakeMail(['broken@example.com']);

    await expect(
      emitProjectEvent(fx.db, projectId, 'deploy_failed', { subject: 'Deploy failed', text: 'x' }, fx.secretBox, factory),
    ).resolves.toMatchObject({ status: 'failed', sent: 1, failed: 1 });

    expect(sent.map((m) => m.to)).toEqual(['ops@example.com']);
  });

  it('does not stall on a hanging recipient: the overall await stays bounded by the injected cap', async () => {
    const fx = tmpFixtures();
    configureMail(fx);
    const projectId = insertProject(fx.db, 'shop');
    addRecipients(fx.db, projectId, ['blackhole@example.com']);
    subscribe(fx.db, projectId, ['deploy_failed']);
    // A transport that never settles — only the injected timeout can end this.
    const hanging: MailTransport = { sendMail: () => new Promise(() => undefined) };

    const start = Date.now();
    await expect(
      emitProjectEvent(fx.db, projectId, 'deploy_failed', { subject: 'Deploy failed', text: 'x' }, fx.secretBox, () => hanging, 50),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
