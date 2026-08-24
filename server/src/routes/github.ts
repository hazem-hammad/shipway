import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSetting, setSetting } from '../db/settings.js';
import { requireRole } from '../lib/authz.js';
import { getActor, recordAudit } from '../services/audit.js';
import { exchangeManifestCode, GitHubService, type GithubAppConfig } from '../services/github.js';

const GITHUB_APP_SETTING_KEY = 'github_app';
const NOT_CONFIGURED = { error: 'github app not configured' };
const NOT_INSTALLED = { error: 'github app not installed' };

/** How long a manifest-flow CSRF state nonce stays valid before `GET .../callback` rejects it. */
const DEFAULT_STATE_TTL_MS = 15 * 60 * 1000;

interface GithubStatus {
  configured: boolean;
  installed: boolean;
  appSlug: string | null;
}

function buildStatus(cfg: GithubAppConfig | null): GithubStatus {
  return {
    configured: cfg !== null,
    installed: cfg?.installationId !== undefined,
    appSlug: cfg?.slug ?? null,
  };
}

const manifestQuerySchema = z.object({ baseUrl: z.string().url() });

const manualAppSchema = z.object({
  appId: z.coerce.number().int(),
  privateKey: z.string().min(1),
  webhookSecret: z.string().min(1),
});

// `state` is intentionally optional at the schema level (rather than required) so a missing state
// falls through to the explicit `consumeState` check below and 403s as "invalid state" rather than
// 400ing as a generic bad request — see the CSRF note on the callback route.
const callbackQuerySchema = z.object({ code: z.string().min(1), state: z.string().optional() });

const branchesQuerySchema = z.object({ repo: z.string().regex(/^[^/]+\/[^/]+$/, 'expected owner/repo') });

/**
 * Registers the GitHub App setup/status/data routes. Everything here lives under `/api/github/`
 * except `/api/setup/github/callback`, which GitHub redirects the *browser* to at the end of the
 * manifest flow — it can't be expected to carry a session cookie, so it's registered under
 * `/api/setup/` instead, which `buildApp`'s guard already exempts (see `PUBLIC_API_PREFIXES`).
 * `opts.fetchImpl` is threaded down from `buildApp` for the manifest-conversion exchange; tests
 * inject a stub there to avoid the network. `opts.stateTtlMs` overrides `DEFAULT_STATE_TTL_MS` for
 * tests that need to exercise state expiry without a real 15-minute wait.
 */
export async function githubRoutes(
  app: FastifyInstance,
  opts: { fetchImpl?: typeof fetch; stateTtlMs?: number } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stateTtlMs = opts.stateTtlMs ?? DEFAULT_STATE_TTL_MS;

  // CSRF protection for the manifest flow: `GET /api/github/manifest` (authed) mints a single-use
  // state nonce that GitHub echoes back as a `?state=` query param on the redirect to
  // `/api/setup/github/callback` (which is guard-exempt and otherwise unauthenticated — anyone who
  // knows our callback URL could otherwise register their own GitHub App and have GitHub redirect
  // here with a `code`, clobbering our stored `github_app` setting with attacker-known credentials).
  // In-memory and scoped to this plugin registration (one Map per `buildApp()` call), matching the
  // login rate-limiter pattern in `routes/auth.ts`.
  const pendingStates = new Map<string, number>(); // state -> expiresAt (ms since epoch)

  function issueState(): string {
    const state = randomBytes(16).toString('hex');
    pendingStates.set(state, Date.now() + stateTtlMs);
    return state;
  }

  /** Single-use: deletes `state` from the store regardless of outcome, so it can never be replayed. */
  function consumeState(state: string | undefined): boolean {
    if (!state) return false;
    const expiresAt = pendingStates.get(state);
    pendingStates.delete(state);
    return expiresAt !== undefined && Date.now() <= expiresAt;
  }

  app.get('/api/github/status', async () => {
    const cfg = getSetting<GithubAppConfig>(app.db, GITHUB_APP_SETTING_KEY);
    return buildStatus(cfg);
  });

  app.get('/api/github/manifest', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsed = manifestQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request' });
    }
    const { baseUrl } = parsed.data;

    const state = issueState();
    const suffix = randomBytes(2).toString('hex');
    const manifest = {
      name: `shipway-${suffix}`,
      url: baseUrl,
      hook_attributes: { url: `${baseUrl}/api/webhooks/github` },
      redirect_url: `${baseUrl}/api/setup/github/callback`,
      public: false,
      default_permissions: { contents: 'read', metadata: 'read' },
      default_events: ['push'],
    };

    return {
      postUrl: `https://github.com/settings/apps/new?state=${state}`,
      manifestJson: JSON.stringify(manifest),
    };
  });

  // Guard-exempt: see doc comment above. Validates `state` before doing anything else — a
  // missing/unknown/expired/already-used state 403s without ever calling exchangeManifestCode.
  app.get('/api/setup/github/callback', async (request, reply) => {
    const parsed = callbackQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request' });
    }

    if (!consumeState(parsed.data.state)) {
      return reply.code(403).send({ error: 'invalid state' });
    }

    let conversion;
    try {
      conversion = await exchangeManifestCode(parsed.data.code, fetchImpl);
    } catch {
      return reply.code(502).send({ error: 'github manifest exchange failed' });
    }

    // Full overwrite, including any previously-stored installationId/slug: the validated state
    // nonce proves an authenticated admin initiated this flow just now, so a fresh app replacing
    // whatever was configured before is the intended outcome, not data loss to guard against.
    const next: GithubAppConfig = {
      appId: conversion.appId,
      privateKey: conversion.privateKey,
      webhookSecret: conversion.webhookSecret,
      slug: conversion.slug,
    };
    setSetting(app.db, GITHUB_APP_SETTING_KEY, next);
    recordAudit(app.db, { actorId: null, actorName: 'github', action: 'github.configure', targetType: 'settings', targetName: 'github_app' });

    return reply.redirect('/settings/github?created=1');
  });

  app.put('/api/github/app', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsed = manualAppSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const existing = getSetting<GithubAppConfig>(app.db, GITHUB_APP_SETTING_KEY);
    const next: GithubAppConfig = {
      appId: parsed.data.appId,
      privateKey: parsed.data.privateKey,
      webhookSecret: parsed.data.webhookSecret,
      installationId: existing?.installationId,
      slug: existing?.slug,
    };
    setSetting(app.db, GITHUB_APP_SETTING_KEY, next);

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'github.configure', targetType: 'settings', targetName: 'github_app' });

    return buildStatus(next);
  });

  app.post('/api/github/resolve-installation', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const cfg = getSetting<GithubAppConfig>(app.db, GITHUB_APP_SETTING_KEY);
    if (!cfg) {
      return reply.code(503).send(NOT_CONFIGURED);
    }

    let installationId: number;
    try {
      installationId = await new GitHubService(cfg).resolveInstallationId();
    } catch (err) {
      request.log.error(err, 'failed to resolve github app installation');
      return reply.code(502).send({ error: 'failed to resolve installation' });
    }
    setSetting(app.db, GITHUB_APP_SETTING_KEY, { ...cfg, installationId });

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'github.configure', targetType: 'settings', targetName: 'github_app', meta: { installationId } });

    return { installationId };
  });

  app.get('/api/github/repos', async (request, reply) => {
    const cfg = getSetting<GithubAppConfig>(app.db, GITHUB_APP_SETTING_KEY);
    if (!cfg) {
      return reply.code(503).send(NOT_CONFIGURED);
    }
    if (cfg.installationId === undefined) {
      return reply.code(503).send(NOT_INSTALLED);
    }

    return new GitHubService(cfg).listRepos();
  });

  app.get('/api/github/branches', async (request, reply) => {
    const cfg = getSetting<GithubAppConfig>(app.db, GITHUB_APP_SETTING_KEY);
    if (!cfg) {
      return reply.code(503).send(NOT_CONFIGURED);
    }
    if (cfg.installationId === undefined) {
      return reply.code(503).send(NOT_INSTALLED);
    }

    const parsed = branchesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request' });
    }

    return new GitHubService(cfg).listBranches(parsed.data.repo);
  });
}
