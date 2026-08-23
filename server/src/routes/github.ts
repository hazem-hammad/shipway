import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSetting, setSetting } from '../db/settings.js';
import { exchangeManifestCode, type GithubAppConfig } from '../services/github.js';

const GITHUB_APP_SETTING_KEY = 'github_app';
const NOT_CONFIGURED = { error: 'github app not configured' };
const NOT_INSTALLED = { error: 'github app not installed' };

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

const callbackQuerySchema = z.object({ code: z.string().min(1) });

const branchesQuerySchema = z.object({ repo: z.string().regex(/^[^/]+\/[^/]+$/, 'expected owner/repo') });

/**
 * Registers the GitHub App setup/status/data routes. Everything here lives under `/api/github/`
 * except `/api/setup/github/callback`, which GitHub redirects the *browser* to at the end of the
 * manifest flow — it can't be expected to carry a session cookie, so it's registered under
 * `/api/setup/` instead, which `buildApp`'s guard already exempts (see `PUBLIC_API_PREFIXES`).
 * `opts.fetchImpl` is threaded down from `buildApp` for the manifest-conversion exchange; tests
 * inject a stub there to avoid the network.
 */
export async function githubRoutes(app: FastifyInstance, opts: { fetchImpl?: typeof fetch } = {}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  app.get('/api/github/status', async () => {
    const cfg = getSetting<GithubAppConfig>(app.db, GITHUB_APP_SETTING_KEY);
    return buildStatus(cfg);
  });

  app.get('/api/github/manifest', async (request, reply) => {
    const parsed = manifestQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request' });
    }
    const { baseUrl } = parsed.data;

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

    return { postUrl: 'https://github.com/settings/apps/new', manifestJson: JSON.stringify(manifest) };
  });

  // Guard-exempt: see doc comment above.
  app.get('/api/setup/github/callback', async (request, reply) => {
    const parsed = callbackQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request' });
    }

    let conversion;
    try {
      conversion = await exchangeManifestCode(parsed.data.code, fetchImpl);
    } catch {
      return reply.code(502).send({ error: 'github manifest exchange failed' });
    }

    const next: GithubAppConfig = {
      appId: conversion.appId,
      privateKey: conversion.privateKey,
      webhookSecret: conversion.webhookSecret,
      slug: conversion.slug,
    };
    setSetting(app.db, GITHUB_APP_SETTING_KEY, next);

    return reply.redirect('/settings/github?created=1');
  });

  app.put('/api/github/app', async (request, reply) => {
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

    return buildStatus(next);
  });

  app.post('/api/github/resolve-installation', async (request, reply) => {
    const cfg = getSetting<GithubAppConfig>(app.db, GITHUB_APP_SETTING_KEY);
    const service = app.github();
    if (!cfg || !service) {
      return reply.code(503).send(NOT_CONFIGURED);
    }

    const installationId = await service.resolveInstallationId();
    setSetting(app.db, GITHUB_APP_SETTING_KEY, { ...cfg, installationId });

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

    const service = app.github();
    if (!service) {
      return reply.code(503).send(NOT_CONFIGURED);
    }
    return service.listRepos();
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

    const service = app.github();
    if (!service) {
      return reply.code(503).send(NOT_CONFIGURED);
    }
    return service.listBranches(parsed.data.repo);
  });
}
