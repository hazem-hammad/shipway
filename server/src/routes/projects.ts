import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cronJobs, deployments, projectNotificationEvents, projects, workers } from '../db/schema.js';
import { sqliteFallbackPath } from '../services/envapply.js';
import { DEFAULT_SUBSCRIBED_EVENTS } from '../services/notifybus.js';
import { rewritePhpCommand } from './cron.js';
import { syncCrontab } from '../services/cron.js';
import { applyWorker } from '../services/workers.js';
import { buildEnvFile, buildManagedVars, type SesSmtpConfig, type SmtpConfig } from '../deploy/envfile.js';
import { isValidSesRegion } from '../lib/ses.js';
import {
  LARAVEL_BUILD_CMD,
  LARAVEL_INSTALL_CMD,
  LARAVEL_POST_DEPLOY_SCRIPT,
  LARAVEL_PRE_DEPLOY_SCRIPT,
  LARAVEL_DEFAULT_CRON,
  LARAVEL_DEFAULT_WORKER,
} from '../deploy/laravel.js';
import { NODE_BUILD_CMD, NODE_INSTALL_CMD, NODE_START_CMD } from '../deploy/node.js';
import { requireRole } from '../lib/authz.js';
import { projectDomain, projectHost } from '../lib/domain.js';
import { accessibleProjectIds, grantProjectAccess } from '../lib/projectaccess.js';
import { getActor, recordAudit } from '../services/audit.js';
import { applyEnvToRunning } from '../services/envapply.js';
import {
  ProvisionError,
  changeProjectSubdomain,
  deprovisionProject,
  provisionProject,
  refreshProjectConfig,
  type DnsOutcome,
  type ProvisionDeps,
} from '../services/provisioner.js';
import { CloneError, cloneProject, rewriteEnvDomain, type CloneDeps } from '../services/projectclone.js';
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
 * the most likely accidental collisions with a future Shipway-owned subdomain. `default` is reserved
 * because Shipway's own catch-all vhost is installed as `shipway-default.conf` — a project with that
 * slug would render to the same filename and overwrite it (or remove it on delete), restoring the
 * very fallback bug the catch-all exists to fix.
 */
export const RESERVED_SLUGS = ['dashboard', 'mailpit', 'ship', 'deploy', 'mail', 'www', 'api', 'default'] as const;

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

/**
 * `PATCH /api/projects/:id/subdomain`. `subdomain` is the new host label, or `null` to move the
 * project back to its slug. The two are the same request as far as the handler is concerned — `null`
 * and a value equal to the slug both normalize to a stored `NULL` (see the route).
 */
const subdomainSchema = z.object({ subdomain: z.string().regex(SLUG_RE).nullable() });

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

/**
 * `POST /api/projects/:id/clone`. `databases` names a copy for each of the source's databases that
 * should come across — the dashboard sends one entry per linked database, and an empty (or absent)
 * list clones the project without any data. Nothing else is accepted: a clone is a copy of the
 * source's settings, so offering to change them here would just be New Project with extra steps.
 */
const cloneProjectSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(SLUG_RE),
  databases: z.array(z.object({ sourceId: z.number().int(), name: z.string().min(1) })).optional(),
});

/** Maps a `CloneError`'s step onto a status code: the caller's mistakes are 4xx, the host's are 502. */
const CLONE_ERROR_STATUS: Record<CloneError['step'], number> = {
  source: 404,
  slug: 409,
  database: 409,
  provision: 502,
  copy: 502,
};

const envPutSchema = z.object({ content: z.string() });

const smtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int(),
  username: z.string().optional(),
  password: z.string().optional(),
  fromAddress: z.string().optional(),
  encryption: z.string().optional(),
});

/** `ses` mode's stored config. Host/port are absent by design — `deploy/envfile.ts` derives them
 * from the region — and every remaining field is required, since SES SMTP always authenticates and
 * always needs a verified from-address. */
const sesConfigSchema = z.object({
  region: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  fromAddress: z.string().min(1),
});

const smtpPutSchema = z.object({
  mode: z.enum(['mailpit', 'custom', 'ses', 'none']),
  /** Validated per mode in the handler (`smtpConfigSchema` for `custom`, `sesConfigSchema` for
   * `ses`), since the two modes take entirely different fields. */
  config: z.unknown().optional(),
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
        installCmd: NODE_INSTALL_CMD,
        buildCmd: NODE_BUILD_CMD,
        startCmd: NODE_START_CMD,
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
/**
 * Gives a newly created Laravel project the two things it needs to actually run background work: the
 * every-minute `schedule:run` cron (without which nothing in `$schedule` ever fires) and a queue
 * worker. Both are ordinary rows the user can edit or delete afterwards — this only removes the step
 * of knowing they were required.
 *
 * Scoped to `type: 'php'`, following the same assumption the rest of project creation already makes:
 * a php project is Laravel until told otherwise (see `defaultsForType`).
 *
 * NEVER throws. The project itself is already provisioned and useful by this point, so a crontab or
 * systemd failure must not turn a successful creation into a 502. On failure the seeded row is
 * removed again, so the database never claims a cron/worker that isn't actually installed on the
 * host — the same reconcile-then-continue rule the cron and worker routes follow.
 */
async function seedLaravelDefaults(app: FastifyInstance, project: ProjectRow): Promise<void> {
  if (project.type !== 'php') return;

  try {
    app.db.insert(cronJobs).values({ projectId: project.id, schedule: LARAVEL_DEFAULT_CRON.schedule, command: rewritePhpCommand(project, LARAVEL_DEFAULT_CRON.command) }).run();
    await syncCrontab({ db: app.db, sysops: app.sysops, cfg: app.cfg });
  } catch (err) {
    app.db.delete(cronJobs).where(eq(cronJobs.projectId, project.id)).run();
    console.error(`shipway: could not seed the Laravel scheduler cron for ${project.slug}: ${toErrorMessage(err)}`);
  }

  try {
    app.db.insert(workers).values({ projectId: project.id, ...LARAVEL_DEFAULT_WORKER }).run();
    const created = app.db.select().from(workers).where(and(eq(workers.projectId, project.id), eq(workers.name, LARAVEL_DEFAULT_WORKER.name))).get();
    if (created) {
      await applyWorker({ sysops: app.sysops, cfg: app.cfg }, project, created);
    }
  } catch (err) {
    app.db.delete(workers).where(and(eq(workers.projectId, project.id), eq(workers.name, LARAVEL_DEFAULT_WORKER.name))).run();
    console.error(`shipway: could not seed the Laravel queue worker for ${project.slug}: ${toErrorMessage(err)}`);
  }
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  function deps(): ProvisionDeps {
    // `dbAdmin`/`secretBox` are what let `deprovisionProject` actually DROP a deleted project's
    // databases instead of leaving them orphaned on the engine when the rows cascade away.
    return { db: app.db, cfg: app.cfg, sysops: app.sysops, dns: app.dns(), dbAdmin: app.dbAdmin, secretBox: app.secretBox };
  }

  /** The same dependencies, with `dbAdmin`/`secretBox` narrowed to required — cloning cannot degrade
   *  to "skip the databases" the way a delete can. */
  function cloneDeps(): CloneDeps {
    return { db: app.db, cfg: app.cfg, sysops: app.sysops, dns: app.dns(), dbAdmin: app.dbAdmin, secretBox: app.secretBox };
  }

  app.get('/api/projects', async (request) => {
    // A scoped member's Projects page shows only what they were granted (see
    // `lib/projectaccess.ts`); `null` means unscoped, in which case nothing is filtered out.
    const allowed = accessibleProjectIds(app.db, request.session.get('userId'));
    const all = app.db
      .select()
      .from(projects)
      .all()
      .filter((project) => allowed === null || allowed.has(project.id));

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

    // Seed the project's deploy-notification opt-in (services/notifybus.ts). Seeded ONCE, here, so
    // that unchecking every box in the project's Notifications card is a durable choice rather than
    // something a read-time default would quietly undo. No recipients are seeded, so a new project
    // still emails nobody until someone adds an address.
    app.db
      .insert(projectNotificationEvents)
      .values(DEFAULT_SUBSCRIBED_EVENTS.map((event) => ({ projectId: created.id, event })))
      .onConflictDoNothing()
      .run();

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

    // After provisioning, so a project that fails to provision (and is torn down again) never leaves
    // a crontab line or a systemd unit behind.
    await seedLaravelDefaults(app, created);

    // A scoped member who creates a project is granted it immediately — otherwise the very next
    // request for the project they just made would 404 on them. A no-op for anyone unscoped.
    grantProjectAccess(app.db, request.session.get('userId'), created.id);

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'project.create', targetType: 'project', targetName: created.slug, meta: { type: created.type } });

    // `dns` surfaces the DNS-step outcome (plan Task 5 / spec §3 "New Project DNS") so the UI can
    // show whether a record was created, already existed, or was skipped entirely — a DNS failure
    // still throws above (502) exactly as before, so this field is only ever present on a 201.
    return reply.code(201).send({ ...toPublicProject(created), dns: dnsOutcome });
  });

  /**
   * Clones a project onto a new subdomain, with its own copy of each database the caller names — see
   * `services/projectclone.ts` for what is carried across and why a failure removes the whole clone
   * rather than leaving half of one.
   *
   * No role gate beyond the session, matching `POST /api/projects`: this creates a project, and
   * anyone who can sign in can already create one. The source has to be one the caller can see,
   * though — cloning would otherwise be a way to read the env, mail config and data of a project
   * their access was deliberately scoped away from.
   */
  app.post('/api/projects/:id/clone', async (request, reply) => {
    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const parsed = cloneProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const body = parsed.data;

    const source = app.db.select({ id: projects.id, slug: projects.slug }).from(projects).where(eq(projects.id, paramsParsed.data.id)).get();
    if (!source) {
      return reply.code(404).send({ error: 'project not found' });
    }

    if ((RESERVED_SLUGS as readonly string[]).includes(body.slug)) {
      return reply.code(409).send({ error: 'this name is reserved' });
    }

    let result;
    try {
      result = await cloneProject(cloneDeps(), source.id, { name: body.name, slug: body.slug, databases: body.databases ?? [] });
    } catch (err) {
      if (err instanceof CloneError) {
        const status = CLONE_ERROR_STATUS[err.step];
        // 4xx says what to fix in one sentence; 502 keeps the step, matching how a failed create
        // reports its provisioning stage.
        return status === 502
          ? reply.code(502).send({ error: 'clone failed', step: err.step, detail: err.message })
          : reply.code(status).send({ error: err.message });
      }
      throw err;
    }

    // Same reason as `POST /api/projects`: a scoped member who clones a project must be able to see
    // what they just made.
    grantProjectAccess(app.db, request.session.get('userId'), result.project.id);

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'project.clone',
      targetType: 'project',
      targetName: result.project.slug,
      meta: { source: source.slug, databases: result.databases.map((database) => database.name) },
    });

    return reply.code(201).send({
      ...toPublicProject(result.project),
      dns: result.dns,
      databases: result.databases,
      workers: result.workers,
      cronJobs: result.cronJobs,
      sharedFilesCopied: result.sharedFilesCopied,
    });
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

    // Not immutable — it has its own route, because writing this column alone would leave the row
    // claiming a domain that neither Cloudflare nor nginx has heard of.
    if ('subdomain' in rawBody) {
      return reply.code(400).send({ error: 'use PATCH /api/projects/:id/subdomain to move a project' });
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

  /**
   * Moves a project to a different subdomain: `<new>.<base-domain>` gets an `A` record pointing at
   * this server, the nginx vhost is re-rendered under the new `server_name`, the old `A` record is
   * removed, and every mention of the old domain in the project's env is repointed at the new one.
   * `subdomain: null` moves it back to its slug.
   *
   * The project's SLUG is untouched — `apps/<slug>`, its units, its vhost filename and its logs keep
   * the names they have. Only the address changes (see `lib/domain.ts`).
   *
   * Admin-only, like deleting a project: it changes the URL the site is reachable at, which breaks
   * every existing link to it, so it is not something a scoped member should be able to do to a
   * project they merely have access to.
   *
   * The column is written first and rolled back if the host work fails, so the row never claims a
   * domain that isn't actually being served.
   */
  app.patch('/api/projects/:id/subdomain', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const paramsParsed = projectIdParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const { id } = paramsParsed.data;

    const parsed = subdomainSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const existing = app.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'project not found' });
    }

    // A subdomain equal to the slug IS the default, so it is stored as NULL rather than as a
    // redundant copy — otherwise "move back to the slug" would leave the column pinned to a value
    // that only coincidentally matches.
    const requested = parsed.data.subdomain;
    const subdomain = requested === null || requested === existing.slug ? null : requested;
    const host = subdomain ?? existing.slug;

    if (host === projectHost(existing)) {
      return reply.code(400).send({ error: 'this project already uses that subdomain' });
    }
    if ((RESERVED_SLUGS as readonly string[]).includes(host)) {
      return reply.code(409).send({ error: 'this name is reserved' });
    }
    // Compared against every other project's EFFECTIVE host, not just its slug: a project that has
    // itself been moved has freed its slug, and is occupying its subdomain instead.
    const taken = app.db
      .select({ id: projects.id, slug: projects.slug, subdomain: projects.subdomain })
      .from(projects)
      .all()
      .some((other) => other.id !== id && projectHost(other) === host);
    if (taken) {
      return reply.code(409).send({ error: 'subdomain already in use' });
    }

    app.db.update(projects).set({ subdomain }).where(eq(projects.id, id)).run();

    let move;
    try {
      move = await changeProjectSubdomain(deps(), id, existing);
    } catch (err) {
      // Nothing on the host moved (see `changeProjectSubdomain` — every failure path restores what
      // it touched), so the row must go back too rather than advertising a domain nginx never
      // learned about.
      app.db.update(projects).set({ subdomain: existing.subdomain }).where(eq(projects.id, id)).run();
      const step = err instanceof ProvisionError ? err.step : 'unknown';
      return reply.code(502).send({ error: 'could not move the project', step, detail: toErrorMessage(err) });
    }

    // The env is where the old domain actually hurts: APP_URL, SESSION_DOMAIN, SANCTUM_STATEFUL_
    // DOMAINS and any hard-coded link keep pointing at an address that no longer resolves, so the
    // app would go on generating dead links from a subdomain change that "worked". Same substring
    // rewrite a clone does, applied to the stored env and then pushed to the running release.
    let envRewritten = false;
    let envApplied = false;
    const currentEnv = existing.envEncrypted ? app.secretBox.decrypt(existing.envEncrypted) : '';
    const rewritten = rewriteEnvDomain(currentEnv, move.previousDomain, move.domain);
    if (rewritten !== currentEnv) {
      envRewritten = true;
      app.db.update(projects).set({ envEncrypted: app.secretBox.encrypt(rewritten) }).where(eq(projects.id, id)).run();
      const project = app.db.select().from(projects).where(eq(projects.id, id)).get();
      envApplied = project ? (await applyEnvToRunning(app, project)).applied : false;
    }

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'project.subdomain.update',
      targetType: 'project',
      targetName: existing.slug,
      meta: {
        from: move.previousDomain,
        to: move.domain,
        envRewritten,
        ...(move.staleRecordWarning ? { staleRecordWarning: move.staleRecordWarning } : {}),
      },
    });

    const updated = app.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!updated) {
      return reply.code(500).send({ error: 'failed to update project' });
    }
    return { project: toPublicProject(updated), move, envRewritten, envApplied };
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

    const result = await deprovisionProject(deps(), id);

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'project.delete',
      targetType: 'project',
      targetName: project.slug,
      // Which databases went with it — and which couldn't be dropped, since those are left on the
      // engine and someone has to know to clean them up by hand.
      meta: {
        ...(result.databasesDropped.length > 0 ? { databasesDropped: result.databasesDropped } : {}),
        ...(result.databasesFailed.length > 0 ? { databasesFailed: result.databasesFailed.map((f) => f.name) } : {}),
      },
    });

    // 204 even when a drop failed: the project itself IS gone, so reporting failure would be wrong.
    // The response body names anything left behind instead.
    if (result.databasesFailed.length > 0) {
      return reply.code(200).send({ databasesFailed: result.databasesFailed });
    }
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

    // Storing it is only half the job. Until this call existed, saving env here changed a row in
    // Shipway's own database and nothing on the machine: `shared/.env` was written by the deploy
    // pipeline alone, so a user who edited QUEUE_CONNECTION and pressed Save watched the app go on
    // using the old value with no indication that anything was outstanding. `applyEnvToRunning`
    // rewrites that file against the release already live and restarts what holds the old
    // environment. It never throws — see its doc comment for the two cases it declines, and why a
    // failed restart is reported rather than raised.
    const project = app.db.select().from(projects).where(eq(projects.id, id)).get();
    const applied = project ? await applyEnvToRunning(app, project) : { applied: false, workersRestarted: 0 };

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'project.env.update',
      targetType: 'project',
      targetName: existing.slug,
      meta: { applied: applied.applied, ...(applied.reason ? { reason: applied.reason } : {}) },
    });

    // 200 with a body rather than the 204 this used to send: whether the change is live is the
    // first thing the person who pressed Save needs to know, and it is not knowable from the
    // status code.
    return reply.code(200).send(applied);
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

    // One encrypted blob holds whichever mode's config was saved, so it's decoded once and handed to
    // the field that matches the CURRENT mode — a leftover blob from a previous mode is ignored
    // rather than misread as the other shape.
    const decoded = project.smtpConfigEncrypted ? (JSON.parse(app.secretBox.decrypt(project.smtpConfigEncrypted)) as unknown) : undefined;
    const managed = buildManagedVars({
      smtpMode: project.smtpMode,
      smtpConfig: project.smtpMode === 'custom' ? (decoded as SmtpConfig | undefined) : undefined,
      sesConfig: project.smtpMode === 'ses' ? (decoded as SesSmtpConfig | undefined) : undefined,
      // Same source of truth as the deploy path, so the preview shows the SQLite fallback a
      // database-less Laravel project will actually get rather than omitting it.
      sqliteDatabasePath: sqliteFallbackPath({ cfg: app.cfg, db: app.db }, project),
    });
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

    // Both credential-bearing modes store their config in the same encrypted blob, but they accept
    // different fields, so each is validated against its own schema rather than a merged, looser one.
    let storedConfig: SmtpConfig | SesSmtpConfig | null = null;
    if (mode === 'custom') {
      const configParsed = smtpConfigSchema.safeParse(config);
      if (!configParsed.success) {
        return reply.code(400).send({ error: 'config is required when mode is "custom"' });
      }
      storedConfig = configParsed.data;
    } else if (mode === 'ses') {
      const configParsed = sesConfigSchema.safeParse(config);
      if (!configParsed.success) {
        return reply.code(400).send({ error: 'ses mode requires region, username, password and fromAddress' });
      }
      // Checked against the region SHAPE, not merely for presence — it becomes part of the SES SMTP
      // hostname written into the project's .env (see `lib/ses.ts`).
      if (!isValidSesRegion(configParsed.data.region.trim())) {
        return reply.code(400).send({ error: `"${configParsed.data.region}" is not a valid AWS region` });
      }
      storedConfig = { ...configParsed.data, region: configParsed.data.region.trim() };
    }

    const existing = app.db.select({ id: projects.id, slug: projects.slug }).from(projects).where(eq(projects.id, id)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const smtpConfigEncrypted = storedConfig ? app.secretBox.encrypt(JSON.stringify(storedConfig)) : null;

    app.db.update(projects).set({ smtpMode: mode, smtpConfigEncrypted }).where(eq(projects.id, id)).run();

    // The SMTP mode IS env: it renders the managed `MAIL_*`/`SMTP_*` block at the bottom of the
    // project's .env (see `deploy/envfile.ts`'s `buildManagedVars`). Same treatment as the
    // Environment tab, for the same reason — otherwise switching a project from Mailpit to real SES
    // leaves it quietly delivering to Mailpit until someone deploys.
    const project = app.db.select().from(projects).where(eq(projects.id, id)).get();
    const applied = project ? await applyEnvToRunning(app, project) : { applied: false, workersRestarted: 0 };

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'project.smtp.update',
      targetType: 'project',
      targetName: existing.slug,
      meta: { mode, applied: applied.applied, ...(applied.reason ? { reason: applied.reason } : {}) },
    });

    return reply.code(200).send(applied);
  });
}
