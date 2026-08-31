/**
 * The deploy notification email template (`services/notifyemail.ts`): subject and plain-text body.
 * Pure and synchronous, so it's tested directly with no db, app or transport.
 *
 * Two properties matter most: a failure must be distinguishable from a success at a glance, and the
 * commit message must be present and clearly labelled rather than buried.
 */
import { describe, expect, it } from 'vitest';
import { buildDeployEmail, buildTestNotificationEmail, type DeployEmailInput } from '../src/services/notifyemail.js';

function input(overrides: Partial<DeployEmailInput> = {}): DeployEmailInput {
  return {
    event: 'deploy_succeeded',
    projectId: 7,
    projectSlug: 'shop',
    deploymentId: 42,
    commitSha: 'abcdef1234567890',
    commitMessage: 'Add checkout summary to the order confirmation page',
    detail: null,
    baseDomain: 'example.com',
    ...overrides,
  };
}

describe('subject', () => {
  it('leads with the project, then the outcome and deployment number', () => {
    expect(buildDeployEmail(input()).subject).toBe('[shop] Deploy succeeded (#42)');
    expect(buildDeployEmail(input({ event: 'deploy_failed' })).subject).toBe('[shop] Deploy failed (#42)');
    expect(buildDeployEmail(input({ event: 'deploy_rolled_back' })).subject).toBe('[shop] Deploy rolled back (#42)');
    expect(buildDeployEmail(input({ event: 'deploy_canceled' })).subject).toBe('[shop] Deploy canceled (#42)');
  });

  it('names the project, so an inbox holding several projects stays readable', () => {
    for (const projectSlug of ['shop', 'congora-design', 'mizwaj-test']) {
      expect(buildDeployEmail(input({ projectSlug })).subject, projectSlug).toContain(projectSlug);
    }
    expect(buildTestNotificationEmail('congora-design', 7, 'example.com').subject).toBe('[congora-design] Test notification');
  });

  it('differs between a success and a failure, so an inbox list distinguishes them', () => {
    expect(buildDeployEmail(input({ event: 'deploy_succeeded' })).subject).not.toBe(buildDeployEmail(input({ event: 'deploy_failed' })).subject);
  });

  it('identifies one specific deploy, since deployment ids are globally unique', () => {
    expect(buildDeployEmail(input({ deploymentId: 43 })).subject).not.toBe(buildDeployEmail(input({ deploymentId: 42 })).subject);
  });

  it('uses no em dash, per the copy rules', () => {
    for (const event of ['deploy_succeeded', 'deploy_failed', 'deploy_canceled', 'deploy_rolled_back'] as const) {
      expect(buildDeployEmail(input({ event })).subject).not.toContain('—');
    }
  });
});

describe('plain-text only', () => {
  /**
   * REGRESSION GUARD. The HTML version was reverted deliberately — strict corporate filters score
   * HTML mail harder, and this notification has nothing to gain from styling. Reintroducing an HTML
   * part should be a decision, not a drive-by.
   */
  it('produces a subject and a text body, and nothing else', () => {
    expect(Object.keys(buildDeployEmail(input())).sort()).toEqual(['subject', 'text']);
    expect(Object.keys(buildTestNotificationEmail('shop', 7, 'example.com')).sort()).toEqual(['subject', 'text']);
  });

  it('carries no markup in the body', () => {
    const { text } = buildDeployEmail(input({ event: 'deploy_failed', detail: 'npm run build exited 1' }));
    expect(text).not.toContain('<');
    expect(text).not.toContain('style=');
  });
});

describe('outcome', () => {
  it('marks each outcome distinctly on the first line', () => {
    expect(buildDeployEmail(input({ event: 'deploy_succeeded' })).text.startsWith('[OK] Deploy succeeded')).toBe(true);
    expect(buildDeployEmail(input({ event: 'deploy_failed' })).text.startsWith('[FAILED] Deploy failed')).toBe(true);
    expect(buildDeployEmail(input({ event: 'deploy_rolled_back' })).text.startsWith('[ROLLED BACK] Deploy rolled back')).toBe(true);
    expect(buildDeployEmail(input({ event: 'deploy_canceled' })).text.startsWith('[CANCELED] Deploy canceled')).toBe(true);
  });
});

describe('project and deployment', () => {
  it('states both in the body as well as the subject', () => {
    const { text } = buildDeployEmail(input({ projectSlug: 'congora-design', deploymentId: 128 }));
    expect(text).toContain('Project:    congora-design');
    expect(text).toContain('Deployment: #128');
  });

  it('abbreviates the commit sha to 7 characters', () => {
    const { text } = buildDeployEmail(input({ commitSha: 'abcdef1234567890' }));
    expect(text).toContain('Commit:     abcdef1');
    expect(text).not.toContain('abcdef1234567890');
  });

  it('omits the commit line when the deployment has no sha', () => {
    expect(buildDeployEmail(input({ commitSha: null })).text).not.toContain('Commit:');
  });
});

describe('commit message', () => {
  it('appears in its own labelled block', () => {
    const { text } = buildDeployEmail(input());
    expect(text).toContain('Commit message:');
    expect(text).toContain('  Add checkout summary to the order confirmation page');
  });

  it('is shown for a FAILED deploy too — what was being deployed is the first question', () => {
    const { text } = buildDeployEmail(input({ event: 'deploy_failed', detail: 'npm run build exited 1' }));
    expect(text).toContain('Add checkout summary to the order confirmation page');
    expect(text).toContain('npm run build exited 1');
  });

  it('keeps a multi-line commit message readable, with blank lines genuinely blank', () => {
    const { text } = buildDeployEmail(input({ commitMessage: 'Fix the cart total\n\nThe VAT line was applied twice.' }));
    expect(text).toContain('  Fix the cart total\n\n  The VAT line');
  });

  it('omits the block entirely when there is no commit message', () => {
    expect(buildDeployEmail(input({ commitMessage: null })).text).not.toContain('Commit message:');
    expect(buildDeployEmail(input({ commitMessage: '   \n  ' })).text).not.toContain('Commit message:');
  });
});

describe('failure detail', () => {
  it('is labelled "What went wrong" for a failure and kept separate from the commit message', () => {
    const { text } = buildDeployEmail(input({ event: 'deploy_failed', detail: 'npm run build exited 1' }));
    expect(text).toContain('What went wrong:');
    expect(text).toContain('  npm run build exited 1');
  });

  it('is labelled "Details" on a success, where it is not a failure at all', () => {
    expect(buildDeployEmail(input({ event: 'deploy_succeeded', detail: 'nothing to migrate' })).text).toContain('Details:');
  });

  it('is absent when there is nothing to explain', () => {
    expect(buildDeployEmail(input({ event: 'deploy_canceled', detail: null })).text).not.toContain('What went wrong');
  });
});

describe('deploy log link', () => {
  it('points at the deployment on the dashboard subdomain when a base domain is configured', () => {
    expect(buildDeployEmail(input({ baseDomain: 'example.com' })).text).toContain('https://ship.example.com/projects/7/deployments/42');
  });

  it('omits the link rather than inventing a host when no base domain is set', () => {
    for (const baseDomain of [null, '', '   ']) {
      expect(buildDeployEmail(input({ baseDomain })).text).not.toContain('https://');
    }
  });
});

describe('buildTestNotificationEmail', () => {
  it('is clearly marked as a test, and shows what a real deploy email looks like', () => {
    const email = buildTestNotificationEmail('shop', 7, 'example.com');
    expect(email.subject).toBe('[shop] Test notification');
    expect(email.text).toContain('test notification');
    expect(email.text).toContain('Commit message:');
    expect(email.text).toContain('https://ship.example.com/projects/7/deployments/1');
  });
});
