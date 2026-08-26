import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deployments, projects } from '../db/schema.js';
import { buildEnvFile, buildManagedVars, type SmtpConfig } from '../deploy/envfile.js';
import {
  LARAVEL_BUILD_CMD,
  LARAVEL_INSTALL_CMD,
  LARAVEL_POST_DEPLOY_SCRIPT,
  LARAVEL_PRE_DEPLOY_SCRIPT,
} from '../deploy/laravel.js';
import { requireRole } from '../lib/authz.js';
import { getActor, recordAudit } from '../services/audit.js';
import {
  ProvisionError,
  deprovisionProject,
  provisionProject,
  refreshProjectConfig,
  type DnsOutcome,
  type ProvisionDeps,
} from '../services/provisioner.js';
import { allocatePort } from '../system/ports.js';
import { SLUG_RE, isValidPublicDir } from '../system/templates.js';
import { hashAuthPassword, isValidAuthUser } from '../system/htpasswd.js';

type ProjectRow = typeof projects.$inferSelect;
type ProjectType = ProjectRow['type'];

/** `owner/name`, mirroring the shape GitHub App installs surface repos in. */
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** An http(s) git URL (Task 8's Git-URL project source): `https?://` scheme, no whitespace or
 * newlines anywhere in it (`\S` already excludes both), capped at 500 chars below. Credentials
 * embedded in the URL (`https://user:token@host/...`) are deliberately allowed — that's the whole
 * point for private repos without a GitHub App. */
const REPO_URL_RE = /^https?:\/\/\S+$/;
const repoUrlSchema = z.string().max(500).regex(REPO_URL_RE, 'expected an http(s) git URL');

/** PHP versions the host has installed side-by-side (ondrej/php) and grants sudoers reloads for. */
const PHP_VERSION_ENUM = z.enum(['8.1', '8.2', '8.3', '8.4']);
/** Node versions the host has installed (via nvm/system) for `node`/`nextjs` projects. */
const NODE_VERSION_ENUM = z.enum(['18', '20', '22']);

/**
 * Slugs Shipway's own vhosts/DNS records occupy (`setup/install.sh`'s `shipway-dashboard`/
 * `shipway-mailpit` vhosts, and the `ship.`/`mail.` DNS `A` records it creates) — all of which
 * pass `SLUG_RE` and would otherwise let a project silently clobber (or, on delete, tear down) part
 * of the tool itself. `deploy`, `www`, and `api` are reserved too: `deploy` was this same
 * subdomain's name before the dashboard moved to `ship.<base-domain>`, kept reserved so an existing
 * install's old bookmarks/links don't get silently repurposed by a new project, and `www`/`api` are
 * the most likely accidental collisions with a future Shipway-owned subdomain.
 */
export const RESERVED_SLUGS = ['dashboard', 'mailpit', 'ship', 'deploy', 'mail', 'www', 'api'] as const;

/** `publicDir` is a release-relative sub-path interpolated into the nginx vhost's `root` directive
 * (see `system/templates.ts`'s `renderNginxVhost`) — validated here so a value that could escape the
 * release directory (`..` segments, a leading `/`, etc.) is rejected with a 400 before it ever
 * reaches provisioning; `renderNginxVhost` asserts the same rule again itself, as defense in depth. */
const publicDirSchema = z.string().refine(isValidPublicDir, { message: 'invalid publicDir' });

const projectIdParamsSchema = z.object({ id: z.coerce.number().int() });

// `repo` (GitHub App source, "owner/name") and `repoUrl` (Task 8's Git-URL source, any http(s) git
// URL) are mutually exclusive project sources: exactly one is required, enforced by the `.refine`
// below rather than a zod union so a bad request always 400s with one consistent shape instead of
// zod's noisier union error. A repoUrl project skips any GitHub-App requirement entirely — nothing
// downstream of this schema ever demands `github_app` be configured to create one.
const createProjectSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().regex(SLUG_RE),
    repo: z.string().regex(REPO_RE).optional(),
    repoUrl: repoUrlSchema.optional(),
    branch: z.string().min(1),
    type: z.enum(['php', 'node', 'nextjs', 'static']),
    phpVersion: PHP_VERSION_ENUM.optional(),
    nodeVersion: NODE_VERSION_ENUM.optional(),
    publicDir: publicDirSchema.optional(),
    installCmd: z.string().optional(),
    buildCmd: z.string().optional(),
    startCmd: z.string().optional(),
    preDeployScript: z.string().optional(),
    postDeployScript: z.string().optional(),
    sharedPaths: z.array(z.string()).optional(),
    healthCheckPath: z.string().nullable().optional(),
    autoDeploy: z.boolean().optional(),
    notifyWebhookUrl: z.string().optional(),
  })
  .refine((data) => (data.repo !== undefined) !== (data.repoUrl !== undefined), {
    message: 'exactly one of "repo" or "repoUrl" is required',
    path: ['repo'],
  });

/** slug/repo/type are immutable — checked against the raw body before this schema even runs. */
const patchProjectSchema = z
  .object({
    name: z.string().min(1),
    branch: z.string().min(1),
    phpVersion: PHP_VERSION_ENUM,
    nodeVersion: NODE_VERSION_ENUM,
    publicDir: publicDirSchema,
    installCmd: z.string(),
    buildCmd: z.string(),
    startCmd: z.string(),
    preDeployScript: z.string().nullable(),
    postDeployScript: z.string().nullable(),
    sharedPaths: z.array(z.string()),
    healthCheckPath: z.string().nullable(),
    autoDeploy: z.boolean(),
    notifyWebhookUrl: z.string().nullable(),
    authEnabled: z.boolean(),
    authUser: z.string().refine(isValidAuthUser, { message: 'invalid authUser' }),
    /** Write-only: hashed into `authHash` and never stored or returned in plaintext. */
    authPassword: z.string().min(1),
  })
  .partial();

const IMMUTABLE_PATCH_FIELDS = ['slug', 'repo', 'type'] as const;

/** Fields whose change requires re-rendering/reinstalling the vhost and (node/nextjs) app unit. */
const REFRESH_TRIGGER_FIELDS = ['phpVersion', 'publicDir', 'startCmd', 'nodeVersion', 'authEnabled', 'authUser', 'authPassword'] as const;

/** `PATCH /api/projects/:id` handles both general settings and the pre/post-deploy scripts (there's
 * no separate scripts sub-route) — this picks the more specific `project.scripts.update` audit
 * action when every changed field is one of the two script fields, and the general
 * `project.update` otherwise. */
const SCRIPT_ONLY_PATCH_FIELDS = new Set(['preDeployScript', 'postDeployScript']);
function projectPatchAuditAction(changedFields: string[]): string {
  if (changedFields.length > 0 && changedFields.every((field) => SCRIPT_ONLY_PATCH_FIELDS.has(field))) {
    return 'project.scripts.update';
  }
  return 'project.update';
}

const deleteProjectBodySchema = z.object({ confirmName: z.string() });

const envPutSchema = z.object({ content: z.string() });

const smtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int(),
  username: z.string().optional(),
  password: z.string().optional(),
  fromAddress: z.string().optional(),
  encryption: z.string().optional(),
});

const smtpPutSchema = z.object({
  mode: z.enum(['mailpit', 'custom', 'none']),
  config: smtpConfigSchema.optional(),
});

interface ProjectDefaults {
  installCmd: string;
  buildCmd: string;
  startCmd: string | null;
  publicDir: string;
  sharedPaths: string[];
  phpVersion: string | null;
  nodeVersion: string | null;
  /** Prefilled pre/post-deploy scripts, or `null` for "leave empty" (every type but php). */
  preDeployScript: string | null;
  postDeployScript: string | null;
}

function defaultsForType(type: ProjectType): ProjectDefaults {
  switch (type) {
    // A php project is assumed to be Laravel until told otherwise: the install/build commands and
    // the pre/post-deploy scripts come from `deploy/laravel.ts`, the same source New Project shows
    // (and lets the user edit) before creating it. Non-Laravel PHP just clears the fields.
    case 'php':
      return {
        installCmd: LARAVEL_INSTALL_CMD,
        buildCmd: LARAVEL_BUILD_CMD,
        startCmd: null,
        publicDir: 'public',
        sharedPaths: ['storage', 'uploads'],
        phpVersion: '8.3',
        nodeVersion: null,
        preDeployScript: LARAVEL_PRE_DEPLOY_SCRIPT,
        postDeployScript: LARAVEL_POST_DEPLOY_SCRIPT,
      };
    case 'node':
    case 'nextjs':
      return {
        installCmd: 'npm ci',
        buildCmd: 'npm run build',
        startCmd: 'npm start',
        publicDir: '',
        sharedPaths: [],
        phpVersion: null,
        nodeVersion: '22',
        preDeployScript: null,
        postDeployScript: null,
      };
    case 'static':
      return {
        installCmd: '',
        buildCmd: '',
        startCmd: null,
        publicDir: '',
        sharedPaths: [],
        phpVersion: null,
        nodeVersion: null,
        preDeployScript: null,
        postDeployScript: null,
      };
  }
}

/**
 * Never leaks the encrypted env/SMTP blobs — or the basic-auth password hash — to API clients.
 * `authEnabled`/`authUser` are safe to expose (the UI needs them to render current state);
 * `authHash` is not, so the client is told *whether* a password is set via `authPasswordSet`
 * instead of being handed the hash to crack offline.
 */
function toPublicProject(
  project: ProjectRow,
): Omit<ProjectRow, 'envEncrypted' | 'smtpConfigEncrypted' | 'authHash'> & { authPasswordSet: boolean } {
  const { envEncrypted, smtpConfigEncrypted, authHash, ...rest } = project;
  return { ...rest, authPasswordSet: !!authHash };
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Registers `/api/projects` CRUD plus the env/SMTP sub-resources. All routes here sit under the
 * global session guard in `buildApp`.
 */
export async function projectRoutes(app: FastifyInstance): Promise<void> {
  function deps(): ProvisionDeps {
    return { db: app.db, cfg: app.cfg, sysops: app.sysops, dns: app.dns() };
  }

  app.get('/api/projects', async () => {
    const all = app.db.select().from(projects).all();

    return all.map((project) => {
      const lastDeployment =
        app.db
          .select({ status: deployments.status, finishedAt: deployments.finishedAt, commitSha: deployments.commitSha })
          .from(deployments)
          .where(eq(deployments.projectId, project.id))
          .orderBy(desc(deployments.id))
          .limit(1)
          .get() ?? null;

      return { ...toPublicProject(project), lastDeployment };
    });
  });

  app.post('/api/projects', async (request, reply) => {
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const body = parsed.data;

    if ((RESERVED_SLUGS as readonly string[]).includes(body.slug)) {
      return reply.code(409).send({ error: 'this name is reserved' });
    }

    const existing = app.db.select({ id: projects.id }).from(projects).where(eq(projects.slug, body.slug)).get();
    if (existing) {
      return reply.code(409).send({ error: 'slug already in use' });
    }

    const defaults = defaultsForType(body.type);
    const isNodeLike = body.type === 'node' || body.type === 'nextjs';

    let port: number | null = null;
    if (isNodeLike) {
      const usedPorts = app.db
        .select({ port: projects.port })
        .from(projects)
        .all()
        .map((row) => row.port)
        .filter((p): p is number => p !== null);
      port = allocatePort(usedPorts);
    }

    // Exactly one of repo/repoUrl passed the schema's `.refine` above. The `repo` column is
    // NOT NULL, so a repoUrl project stores '' there rather than null — webhooks.ts's push matcher
    // requires an exact, non-empty `full_name` match, so an empty `repo` can never be matched by a
    // real (or malformed) GitHub push payload.
    const usingRepoUrl = body.repoUrl !== undefined;

    app.db
      .insert(projects)
      .values({
        name: body.name,
        slug: body.slug,
        repo: usingRepoUrl ? '' : (body.repo ?? ''),
        repoUrl: usingRepoUrl ? body.repoUrl! : null,
        branch: body.branch,
        type: body.type,
        phpVersion: body.phpVersion ?? defaults.phpVersion,
        nodeVersion: body.nodeVersion ?? defaults.nodeVersion,
        publicDir: body.publicDir ?? defaults.publicDir,
        port,
        installCmd: body.installCmd ?? defaults.installCmd,
        buildCmd: body.buildCmd ?? defaults.buildCmd,
        startCmd: body.startCmd ?? defaults.startCmd,
        preDeployScript: body.preDeployScript ?? defaults.preDeployScript,
        postDeployScript: body.postDeployScript ?? defaults.postDeployScript,
        sharedPaths: body.sharedPaths ?? defaults.sharedPaths,
        healthCheckPath: body.healthCheckPath ?? null,
        autoDeploy: body.autoDeploy ?? true,
        smtpMode: 'mailpit',
        notifyWebhookUrl: body.notifyWebhookUrl ?? null,
      })
      .run();

    const created = app.db.select().from(projects).where(eq(projects.slug, body.slug)).get();
    if (!created) {
      return reply.code(500).send({ error: 'failed to create project' });
    }

    let dnsOutcome: DnsOutcome;
    try {
      dnsOutcome = await provisionProject(deps(), created.id);
    } catch (err) {
      // Provisioning can fail partway through (e.g. after the DNS record and vhost are already
      // live, but before the app unit installs) — deprovisionProject tears down whatever got as far
      // as being created (best-effort, safe to call at any failure point) and deletes the row itself,
      // rather than orphaning DNS records / directories / a live vhost behind a deleted-looking row.
      await deprovisionProject(deps(), created.id);
      const step = err instanceof ProvisionError ? err.step : 'unknown';
      return reply.code(502).send({ error: 'provisioning failed', step, detail: toErrorMessage(err) });
    }

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'project.create', targetType: 'project', targetName: created.slug, meta: { type: created.type } });

    // `dns` surfaces the DNS-step outcome (plan Task 5 / spec §3 "New Project DNS") so the UI can
    // show whether a record was created, already existed, or was skipped entirely — a DNS failure
    // still throws above (502) exactly as before, so this field is only ever present on a 201.
    return reply.code(201).send({ ...toPublicProject(created), dns: dnsOutcome });
  });

  app.get('/api/projects/:id', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const project = app.db.select().from(projects).where(eq(projects.id, paramsParsed.data.id)).get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    return toPublicProject(project);
  });

  app.patch('/api/projects/:id', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const { id } = paramsParsed.data;

    const rawBody = request.body;
    if (typeof rawBody !== 'object' || rawBody === null) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    for (const field of IMMUTABLE_PATCH_FIELDS) {
      if (field in rawBody) {
        return reply.code(400).send({ error: `"${field}" is immutable` });
      }
    }

    const parsed = patchProjectSchema.safeParse(rawBody);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    // Full row (not just `{id}`): refreshProjectConfig needs the pre-update snapshot to re-render
    // the previous vhost content, so a failed nginx -t after this update can restore it rather than
    // deleting a previously-working vhost (see provisioner.ts's writeVhost doc comment).
    const existing = app.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'project not found' });
    }

    // `authPassword` is not a column: hash it here and persist `authHash` instead, so the plaintext
    // never reaches the database (or the audit log's changed-field list, which uses these keys).
    const { authPassword, ...columnPatch } = parsed.data;
    const patch: Record<string, unknown> = { ...columnPatch };
    if (authPassword !== undefined) {
      try {
        patch.authHash = await hashAuthPassword(authPassword);
      } catch (err) {
        request.log.error(err, 'failed to hash project basic-auth password');
        return reply.code(500).send({ error: 'failed to set password' });
      }
    }

    // Turning auth on with no credentials to enforce would render an `auth_basic_user_file` that
    // doesn't exist — nginx accepts that at config-test time and then 500s every request. Reject it
    // here instead, accounting for values already stored on the row.
    const willEnable = patch.authEnabled === undefined ? existing.authEnabled : patch.authEnabled === true;
    if (willEnable) {
      const user = patch.authUser === undefined ? existing.authUser : (patch.authUser as string);
      const hasHash = patch.authHash !== undefined || !!existing.authHash;
      if (!user || !hasHash) {
        return reply.code(400).send({ error: 'authEnabled requires authUser and a password' });
      }
    }

    if (Object.keys(patch).length > 0) {
      app.db.update(projects).set(patch).where(eq(projects.id, id)).run();
    }

    const updated = app.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!updated) {
      return reply.code(500).send({ error: 'failed to update project' });
    }

    const needsRefresh = REFRESH_TRIGGER_FIELDS.some((field) => field in parsed.data);
    if (needsRefresh) {
      try {
        await refreshProjectConfig(deps(), id, existing);
      } catch (err) {
        const step = err instanceof ProvisionError ? err.step : 'unknown';
        return reply.code(502).send({ error: 'config refresh failed', step, detail: toErrorMessage(err) });
      }
    }

    if (Object.keys(parsed.data).length > 0) {
      const actor = getActor(app.db, request.session.get('userId'));
      const action = projectPatchAuditAction(Object.keys(parsed.data));
      recordAudit(app.db, { ...actor, action, targetType: 'project', targetName: updated.slug });
    }

    return toPublicProject(updated);
  });

  app.delete('/api/projects/:id', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const { id } = paramsParsed.data;

    const bodyParsed = deleteProjectBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const project = app.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    if (bodyParsed.data.confirmName !== project.slug) {
      return reply.code(400).send({ error: 'confirmName does not match the project slug' });
    }

    await deprovisionProject(deps(), id);

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'project.delete', targetType: 'project', targetName: project.slug });

    return reply.code(204).send();
  });

  app.get('/api/projects/:id/env', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const project = app.db
      .select({ envEncrypted: projects.envEncrypted })
      .from(projects)
      .where(eq(projects.id, paramsParsed.data.id))
      .get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const content = project.envEncrypted ? app.secretBox.decrypt(project.envEncrypted) : '';
    return { content };
  });

  app.put('/api/projects/:id/env', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const { id } = paramsParsed.data;

    const parsed = envPutSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const existing = app.db.select({ id: projects.id, slug: projects.slug }).from(projects).where(eq(projects.id, id)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const envEncrypted = app.secretBox.encrypt(parsed.data.content);
    app.db.update(projects).set({ envEncrypted }).where(eq(projects.id, id)).run();

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'project.env.update', targetType: 'project', targetName: existing.slug });

    return reply.code(204).send();
  });

  // Read-only preview of what Shipway will append to this project's .env on the next deploy —
  // the same managed block writeReleaseEnv (deploy/pipeline.ts) writes, computed the same way, but
  // against an empty userEnv so only the managed block itself comes back (task 24, EnvEditor tab).
  app.get('/api/projects/:id/env/preview', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const project = app.db.select().from(projects).where(eq(projects.id, paramsParsed.data.id)).get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const smtpConfig = project.smtpConfigEncrypted
      ? (JSON.parse(app.secretBox.decrypt(project.smtpConfigEncrypted)) as SmtpConfig)
      : undefined;
    const managed = buildManagedVars({ smtpMode: project.smtpMode, smtpConfig });
    const content = buildEnvFile('', managed);

    return { content };
  });

  app.put('/api/projects/:id/smtp', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const { id } = paramsParsed.data;

    const parsed = smtpPutSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const { mode, config } = parsed.data;

    if (mode === 'custom' && !config) {
      return reply.code(400).send({ error: 'config is required when mode is "custom"' });
    }

    const existing = app.db.select({ id: projects.id, slug: projects.slug }).from(projects).where(eq(projects.id, id)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const smtpConfigEncrypted = mode === 'custom' && config ? app.secretBox.encrypt(JSON.stringify(config)) : null;

    app.db.update(projects).set({ smtpMode: mode, smtpConfigEncrypted }).where(eq(projects.id, id)).run();

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'project.smtp.update', targetType: 'project', targetName: existing.slug, meta: { mode } });

    return reply.code(204).send();
  });
}
