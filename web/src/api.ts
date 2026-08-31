/**
 * Thrown by `apiFetch` for any non-2xx response. `message` is taken from the response body's
 * `error` field when present (every route in `server/src/routes` responds `{ error: string }` on
 * failure), falling back to the status text.
 */
export class ApiError extends Error {
  readonly status: number;
  /** The full parsed JSON error body, when present — e.g. a 502's `{ error, step, detail }`. */
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/**
 * Thin wrapper around `fetch` for `/api/*` calls. In dev, Vite proxies `/api` to the server
 * (see `vite.config.ts`); in production the server serves both the API and the built SPA from the
 * same origin — either way this is a same-origin call, but `credentials: 'include'` is set
 * explicitly anyway so the session cookie always rides along.
 *
 * JSON-encodes `opts.body` when present. Resolves to `undefined` for a 204 or a non-JSON body.
 */
export async function apiFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  const { body, headers, ...rest } = opts;

  const response = await fetch(path, {
    ...rest,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  return readResponse<T>(response);
}

/**
 * Turns a finished response into its parsed body, or into an `ApiError` carrying whatever the
 * server said went wrong. Shared with the raw-body uploads below (`importDatabaseSql`), which send
 * something other than JSON but read their answer exactly the same way.
 */
async function readResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload: unknown = contentType.includes('application/json') ? await response.json().catch(() => undefined) : undefined;

  if (!response.ok) {
    const message =
      payload !== null && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : response.statusText || `request failed with status ${String(response.status)}`;
    throw new ApiError(response.status, message, payload);
  }

  return payload as T;
}

// ---- Shared response shapes ----

/** Server-enforced team roles (`server/src/lib/authz.ts`): member < admin < owner. */
export type Role = 'member' | 'admin' | 'owner';

export interface Me {
  id: number;
  name: string;
  email: string;
  role: Role;
}

export interface SetupStatus {
  needsSetup: boolean;
}

export interface Settings {
  base_domain: string | null;
  server_ip: string | null;
  acme_email: string | null;
  cloudflare_token: string | null;
  cloudflare_zone_id: string | null;
  notify_webhook_url: string | null;
  notify_on_success: boolean | null;
  github_app: { configured: boolean };
}

export interface SettingsUpdate {
  base_domain?: string;
  server_ip?: string;
  acme_email?: string;
  cloudflare_token?: string;
  cloudflare_zone_id?: string;
  notify_webhook_url?: string;
  notify_on_success?: boolean;
}

/**
 * `GET /api/cloudflare/verify`'s response shape (plan Task 1 / spec §3 "Cloudflare verify"). `ok`
 * is `true` only after a real, successful Cloudflare API round-trip — never inferred from
 * credentials merely being present. `reason` always says why: `'not_configured'` when no usable
 * token/zone id is stored, `'invalid_token'` when Cloudflare rejected the token,
 * `'error'` for anything else (with a sanitized `message`, never the token itself), and `'ok'` on
 * success.
 */
export interface CloudflareVerifyResult {
  ok: boolean;
  reason: 'ok' | 'not_configured' | 'invalid_token' | 'error';
  message?: string;
}

export interface GithubManifest {
  postUrl: string;
  manifestJson: string;
}

export interface GithubStatus {
  configured: boolean;
  installed: boolean;
  appSlug: string | null;
}

// ---- Auth / setup ----

export function fetchSetupStatus(): Promise<SetupStatus> {
  return apiFetch<SetupStatus>('/api/setup/status');
}

export function setupAdmin(body: { name: string; email: string; password: string }): Promise<Me> {
  return apiFetch<Me>('/api/setup/admin', { method: 'POST', body });
}

export function fetchMe(): Promise<Me> {
  return apiFetch<Me>('/api/auth/me');
}

export function login(body: { email: string; password: string }): Promise<Me> {
  return apiFetch<Me>('/api/auth/login', { method: 'POST', body });
}

export function logout(): Promise<void> {
  return apiFetch<void>('/api/auth/logout', { method: 'POST' });
}

// ---- Settings ----

export function fetchSettings(): Promise<Settings> {
  return apiFetch<Settings>('/api/settings');
}

export function putSettings(body: SettingsUpdate): Promise<Settings> {
  return apiFetch<Settings>('/api/settings', { method: 'PUT', body });
}

export function verifyCloudflare(): Promise<CloudflareVerifyResult> {
  return apiFetch<CloudflareVerifyResult>('/api/cloudflare/verify');
}

// ---- Instance mail ----

/** The SMTP settings Shipway itself uses for invites/notifications (`server/src/services/mailer.ts`,
 * plan Task 3) — entirely separate from a project's own SMTP tab (`putProjectSmtp` below).
 * `ses` is Amazon SES's SMTP interface: same transport as `smtp`, but the admin supplies a region
 * plus SES SMTP credentials and the server derives host/port/TLS. */
export type MailDriver = 'none' | 'mailpit' | 'smtp' | 'ses';

export interface MailConfig {
  driver: MailDriver;
  /** For `ses`, DERIVED by the server from `region` (`email-smtp.<region>.amazonaws.com`) rather
   * than anything the form sent — display it, never submit it back. */
  host: string;
  port: number;
  secure: boolean;
  /** The AWS region for `driver: 'ses'`; `null` for every other driver. */
  region: string | null;
  /** Masked as "•••1234" when a password is set, `null` otherwise — same convention as
   * `Settings.cloudflare_token`. */
  username: string | null;
  password: string | null;
  fromAddress: string;
  fromName: string | null;
  /** `false` only for `driver: 'none'`. */
  configured: boolean;
}

export interface MailConfigUpdate {
  driver: MailDriver;
  host?: string;
  port?: number;
  secure?: boolean;
  /** Required for `driver: 'ses'` (and ignored otherwise) — the server rejects anything that isn't a
   * well-formed AWS region code, since it lands in the SMTP hostname. */
  region?: string;
  username?: string;
  /** Omit to keep the current password; a masked echo also keeps it; `''` clears it. */
  password?: string;
  fromAddress?: string;
  fromName?: string;
}

export function fetchMailConfig(): Promise<MailConfig> {
  return apiFetch<MailConfig>('/api/settings/mail');
}

export function putMailConfig(body: MailConfigUpdate): Promise<MailConfig> {
  return apiFetch<MailConfig>('/api/settings/mail', { method: 'PUT', body });
}

export function testMailConfig(to: string): Promise<{ ok: boolean; error?: string }> {
  return apiFetch<{ ok: boolean; error?: string }>('/api/settings/mail/test', { method: 'POST', body: { to } });
}

// ---- GitHub App ----

/**
 * `org` is optional: omitting it creates a GitHub App owned by the signed-in *user*, which (because
 * the manifest is private) can then only be installed on that user account. Passing an org login
 * creates the app under the organization instead, so it can be installed on the org's repos.
 */
export function fetchGithubManifest(baseUrl: string, org?: string): Promise<GithubManifest> {
  const params = new URLSearchParams({ baseUrl });
  if (org) params.set('org', org);
  return apiFetch<GithubManifest>(`/api/github/manifest?${params.toString()}`);
}

export interface GithubInstallation {
  id: number;
  account: string | null;
  accountType: string | null;
  repositorySelection: string | null;
}

export function fetchGithubInstallations(): Promise<{ installations: GithubInstallation[] }> {
  return apiFetch<{ installations: GithubInstallation[] }>('/api/github/installations');
}

export function fetchGithubStatus(): Promise<GithubStatus> {
  return apiFetch<GithubStatus>('/api/github/status');
}

export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export function fetchGithubRepos(): Promise<GithubRepo[]> {
  return apiFetch<GithubRepo[]>('/api/github/repos');
}

export function fetchGithubBranches(repo: string): Promise<string[]> {
  return apiFetch<string[]>(`/api/github/branches?repo=${encodeURIComponent(repo)}`);
}

/**
 * Top-level directories committed to `repo` at `branch` — suggestions for a project's public
 * directory. Only reflects what is in git, so a build-generated web root won't be listed.
 */
export function fetchGithubDirs(repo: string, branch: string): Promise<string[]> {
  return apiFetch<string[]>(`/api/github/dirs?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`);
}

// ---- Git URL (non-GitHub sources) ----

export interface GitRemoteBranches {
  branches: string[];
  /** The branch the remote's HEAD points at, when it reported one — the one to preselect. */
  defaultBranch: string | null;
}

/** Branches of any http(s) git URL, via `git ls-remote` server-side (nothing is cloned). */
export function fetchGitBranches(url: string): Promise<GitRemoteBranches> {
  return apiFetch<GitRemoteBranches>(`/api/git/branches?url=${encodeURIComponent(url)}`);
}

// ---- Projects ----

export type ProjectType = 'php' | 'node' | 'nextjs' | 'static';

export type DeploymentStatus = 'queued' | 'running' | 'success' | 'failed' | 'rolled_back' | 'canceled';

/** Whether a deployment's status means it's still in flight (queued or actively running). */
export function isPendingDeploymentStatus(status: DeploymentStatus | null | undefined): boolean {
  return status === 'queued' || status === 'running';
}

export interface Project {
  id: number;
  name: string;
  slug: string;
  /** The host label the project is served at when it differs from `slug`; `null` means "same as the
   * slug". Read it through `projectHost`/`projectDomain` (`server/src/lib/domain.ts`) rather than
   * branching on it at each call site. */
  subdomain: string | null;
  repo: string;
  /** Task 8's Git-URL project source: any http(s) git URL, set instead of `repo` (which is `''`
   * for a repoUrl project — the column itself is NOT NULL). Null for GitHub-App-sourced projects. */
  repoUrl: string | null;
  branch: string;
  type: ProjectType;
  phpVersion: string | null;
  nodeVersion: string | null;
  publicDir: string | null;
  port: number | null;
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string | null;
  preDeployScript: string | null;
  postDeployScript: string | null;
  sharedPaths: string[];
  healthCheckPath: string | null;
  autoDeploy: boolean;
  smtpMode: ProjectSmtpMode;
  notifyWebhookUrl: string | null;
  /** HTTP basic auth on the public site. The password hash is never sent to the client —
   * `authPasswordSet` reports only whether one is stored. */
  authEnabled: boolean;
  authUser: string | null;
  authPasswordSet: boolean;
  createdAt: number;
}

export interface LastDeployment {
  status: DeploymentStatus;
  finishedAt: number | null;
  commitSha: string | null;
}

export interface ProjectListItem extends Project {
  lastDeployment: LastDeployment | null;
}

/** Exactly one of `repo` / `repoUrl` must be set — enforced server-side (400 otherwise). */
export interface CreateProjectBody {
  name: string;
  slug: string;
  repo?: string;
  repoUrl?: string;
  branch: string;
  type: ProjectType;
  phpVersion?: string;
  nodeVersion?: string;
  publicDir?: string;
  installCmd?: string;
  buildCmd?: string;
  startCmd?: string;
  /** Omitted entirely to accept the server's per-type default (Laravel's, for php). */
  preDeployScript?: string;
  postDeployScript?: string;
  healthCheckPath?: string | null;
  autoDeploy?: boolean;
}

/**
 * What happened during a project's DNS step (`server/src/services/provisioner.ts`'s
 * `resolveDnsOutcome`, plan Task 5 / spec §3 "New Project DNS"): `attempted` is `false` only when
 * no DNS client was configured at all (the step was skipped entirely); otherwise exactly one of
 * `created`/`existed` is `true`. A DNS failure never reaches this shape — it fails project creation
 * outright (502) instead, so `dns` is only ever present on a successful 201.
 */
export interface DnsOutcome {
  attempted: boolean;
  created: boolean;
  existed: boolean;
  error?: string;
}

export interface CreateProjectResponse extends Project {
  dns: DnsOutcome;
}

export function fetchProjects(): Promise<ProjectListItem[]> {
  return apiFetch<ProjectListItem[]>('/api/projects');
}

export function createProject(body: CreateProjectBody): Promise<CreateProjectResponse> {
  return apiFetch<CreateProjectResponse>('/api/projects', { method: 'POST', body });
}

export function fetchProject(id: number): Promise<Project> {
  return apiFetch<Project>(`/api/projects/${String(id)}`);
}

/** Every field `PATCH /api/projects/:id` accepts (slug/repo/type are immutable, so absent here). */
export interface PatchProjectBody {
  name?: string;
  branch?: string;
  phpVersion?: string;
  nodeVersion?: string;
  publicDir?: string;
  installCmd?: string;
  buildCmd?: string;
  startCmd?: string;
  preDeployScript?: string | null;
  postDeployScript?: string | null;
  sharedPaths?: string[];
  healthCheckPath?: string | null;
  autoDeploy?: boolean;
  notifyWebhookUrl?: string | null;
  authEnabled?: boolean;
  authUser?: string;
  /** Write-only. Omit to leave an already-stored password unchanged. */
  authPassword?: string;
}

export function patchProject(id: number, body: PatchProjectBody): Promise<Project> {
  return apiFetch<Project>(`/api/projects/${String(id)}`, { method: 'PATCH', body });
}

/** What moving a project to another subdomain did on the host — the DNS side of
 * `PATCH /api/projects/:id/subdomain`. */
export interface SubdomainMove {
  domain: string;
  previousDomain: string;
  /** `false` when Cloudflare isn't configured: nginx moved, but no record was touched. */
  dnsAttempted: boolean;
  /** Whether the new `A` record was created, as opposed to already existing. */
  created: boolean;
  oldRecordRemoved: boolean;
  /** Set when the project is live on its new domain but the OLD record could not be removed. */
  staleRecordWarning?: string;
}

export interface SubdomainUpdateResponse {
  project: Project;
  move: SubdomainMove;
  /** Whether the old domain appeared in the project's env and was repointed at the new one. */
  envRewritten: boolean;
  /** Whether that rewritten env reached the running release (false when nothing is deployed yet). */
  envApplied: boolean;
}

/**
 * Moves the project to `subdomain` — DNS record, nginx vhost and the domain in its env all follow.
 * `null` moves it back to its slug. The slug itself never changes.
 */
export function updateProjectSubdomain(id: number, subdomain: string | null): Promise<SubdomainUpdateResponse> {
  return apiFetch<SubdomainUpdateResponse>(`/api/projects/${String(id)}/subdomain`, { method: 'PATCH', body: { subdomain } });
}

/** A database the project owned that could NOT be dropped — it is still on the engine and needs
 * cleaning up by hand. The project itself is gone either way. */
export interface UndroppedDatabase {
  name: string;
  reason: string;
}

/** Resolves once the project is gone. `databasesFailed` is present only when a linked database
 * couldn't be dropped (an unreachable server, missing admin credentials); the deletion still
 * succeeded. */
export function deleteProject(id: number, confirmName: string): Promise<{ databasesFailed?: UndroppedDatabase[] } | void> {
  return apiFetch<{ databasesFailed?: UndroppedDatabase[] } | void>(`/api/projects/${String(id)}`, { method: 'DELETE', body: { confirmName } });
}

/** One database copied by a clone: which of the source's it came from, and what the copy is called. */
export interface ClonedDatabase {
  sourceName: string;
  name: string;
  engine: DbEngine;
  connectionName: string;
  /** True for the one whose credentials were written into the clone's `DB_*` vars. */
  usedInEnv: boolean;
}

export interface CloneProjectBody {
  name: string;
  slug: string;
  /** One entry per database of the source's to copy. Omit or pass `[]` to clone without any data. */
  databases?: { sourceId: number; name: string }[];
}

/** The new project, plus a summary of what came across with it. */
export interface CloneProjectResponse extends Project {
  dns: DnsOutcome;
  databases: ClonedDatabase[];
  workers: number;
  cronJobs: number;
  /** `null` when the source had no `shared/` files to copy; `false` when the copy was attempted and
   *  failed (the clone is still fine — its uploads directory is just empty). */
  sharedFilesCopied: boolean | null;
}

export function cloneProject(id: number, body: CloneProjectBody): Promise<CloneProjectResponse> {
  return apiFetch<CloneProjectResponse>(`/api/projects/${String(id)}/clone`, { method: 'POST', body });
}

export function fetchProjectEnv(id: number): Promise<{ content: string }> {
  return apiFetch<{ content: string }>(`/api/projects/${String(id)}/env`);
}

/**
 * What `PUT /api/projects/:id/env` reports back: whether the saved env actually reached the running
 * release, or only Shipway's database. Storing always succeeds; applying is what can be declined.
 */
export interface EnvApplyResult {
  applied: boolean;
  reason?: 'never-deployed' | 'deploy-in-flight';
  /** Worker instances restarted so they pick up the new environment. */
  workersRestarted: number;
  /** The file was written but a reload/restart failed; the env is on disk for the next restart. */
  restartError?: string;
}

export function putProjectEnv(id: number, content: string): Promise<EnvApplyResult> {
  return apiFetch<EnvApplyResult>(`/api/projects/${String(id)}/env`, { method: 'PUT', body: { content } });
}

/** `content` is the rendered managed block only (task 24: `GET /api/projects/:id/env/preview`). */
export function fetchProjectEnvPreview(id: number): Promise<{ content: string }> {
  return apiFetch<{ content: string }>(`/api/projects/${String(id)}/env/preview`);
}

export interface SmtpConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  fromAddress?: string;
  encryption?: string;
}

/** `mode: 'ses'`'s config. No host or port: the server derives them from the region, so nothing here
 * can point the project's mail at a host that isn't SES. The credentials are the SES *SMTP*
 * username/password from the SES console, not an AWS access key pair. */
export interface SesSmtpConfig {
  region: string;
  username: string;
  password: string;
  /** Must be an address or domain verified in SES. */
  fromAddress: string;
}

export type ProjectSmtpMode = 'mailpit' | 'custom' | 'ses' | 'none';

export interface SmtpPutBody {
  mode: ProjectSmtpMode;
  /** `SmtpConfig` for `custom`, `SesSmtpConfig` for `ses`, omitted for `mailpit`/`none`. */
  config?: SmtpConfig | SesSmtpConfig;
}

export function putProjectSmtp(id: number, body: SmtpPutBody): Promise<EnvApplyResult> {
  return apiFetch<EnvApplyResult>(`/api/projects/${String(id)}/smtp`, { method: 'PUT', body });
}

export function deployProject(id: number): Promise<{ deploymentId: number }> {
  return apiFetch<{ deploymentId: number }>(`/api/projects/${String(id)}/deploy`, { method: 'POST' });
}

// ---- Deployments ----

export interface Deployment {
  id: number;
  projectId: number;
  status: DeploymentStatus;
  trigger: 'push' | 'manual' | 'rollback';
  /** The branch this deployment built from, captured when it was queued — not the project's current
   * branch, which may since have changed. Null for rows predating the column, and for a rollback
   * whose release can no longer be attributed to one. */
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  releasePath: string | null;
  logPath: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** `true` only while the deploy is actually running and a cancel has already been requested for
   * it but hasn't taken effect yet (in-memory queue state) — always `false` once terminal. Drives
   * the "Canceling…" hint alongside the optimistic local state set the moment Cancel is clicked. */
  cancelRequested: boolean;
}

/** `GET /api/projects/:id/deployments` — newest first, capped at 50 server-side. */
export function fetchDeployments(projectId: number): Promise<Deployment[]> {
  return apiFetch<Deployment[]>(`/api/projects/${String(projectId)}/deployments`);
}

export function fetchDeployment(id: number): Promise<Deployment> {
  return apiFetch<Deployment>(`/api/deployments/${String(id)}`);
}

export function cancelDeployment(id: number): Promise<void> {
  return apiFetch<void>(`/api/deployments/${String(id)}/cancel`, { method: 'POST' });
}

export function rollbackProject(id: number, releasePath: string): Promise<{ deploymentId: number }> {
  return apiFetch<{ deploymentId: number }>(`/api/projects/${String(id)}/rollback`, {
    method: 'POST',
    body: { releasePath },
  });
}

export function fetchDeploymentLog(id: number): Promise<{ content: string }> {
  return apiFetch<{ content: string }>(`/api/deployments/${String(id)}/log`);
}

/** A row of `GET /api/deployments` (Task 5's global list, Task 7's Deployments page): a deployment
 * joined with its owning project's name/slug. */
export interface GlobalDeployment {
  id: number;
  projectId: number;
  projectName: string;
  projectSlug: string;
  status: DeploymentStatus;
  trigger: 'push' | 'manual' | 'rollback';
  /** The branch this deployment built from, captured when it was queued — not the project's current
   * branch, which may since have changed. Null for rows predating the column, and for a rollback
   * whose release can no longer be attributed to one. */
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

/** `GET /api/deployments` — recent deployments across every project, newest first; capped at 50
 * server-side unless `limit` is given (server max 100). */
export function fetchGlobalDeployments(limit?: number): Promise<GlobalDeployment[]> {
  const query = limit !== undefined ? `?limit=${String(limit)}` : '';
  return apiFetch<GlobalDeployment[]>(`/api/deployments${query}`);
}

// ---- Overview (Home dashboard) ----

export interface OverviewRecentProject {
  id: number;
  name: string;
  slug: string;
  type: ProjectType;
  lastDeployment: { status: DeploymentStatus; finishedAt: number | null } | null;
}

export interface Overview {
  user: { name: string };
  projects: number;
  deployments: number;
  /** Human-readable names of any system units currently down (e.g. "Nginx"); `[]` when healthy. */
  servicesDown: string[];
  recentProjects: OverviewRecentProject[];
}

export function fetchOverview(): Promise<Overview> {
  return apiFetch<Overview>('/api/overview');
}

// ---- Workers ----

export interface WorkerInstance {
  unit: string;
  status: 'active' | 'inactive' | 'failed' | 'unknown';
}

/** `Restart=` in the worker's systemd unit. `no` still lets you start it by hand; it just won't come
 * back on its own after exiting. */
export type WorkerRestartPolicy = 'always' | 'on-failure' | 'no';

export interface Worker {
  id: number;
  projectId: number;
  name: string;
  command: string;
  processes: number;
  /** Whether the instances are enabled in systemd, i.e. started again after a server reboot. A
   * worker with this off still runs now — it just isn't wired into the boot target. */
  autoStart: boolean;
  restartPolicy: WorkerRestartPolicy;
  /** `RestartSec=` — seconds to wait before restarting a worker that exited. */
  restartSec: number;
  /** `TimeoutStopSec=` — seconds a worker gets to finish its current job after SIGTERM before
   * systemd kills it. The setting that decides whether a deploy loses an in-flight job. */
  stopTimeoutSec: number;
  statusCached: string | null;
}

export interface WorkerListItem extends Worker {
  instances: WorkerInstance[];
}

export interface CreateWorkerBody {
  name: string;
  command: string;
  processes: number;
  /** All optional — omitting one takes the server's default, which is the behavior workers had
   * before these were configurable. */
  autoStart?: boolean;
  restartPolicy?: WorkerRestartPolicy;
  restartSec?: number;
  stopTimeoutSec?: number;
}

export interface PatchWorkerBody {
  command?: string;
  processes?: number;
  autoStart?: boolean;
  restartPolicy?: WorkerRestartPolicy;
  restartSec?: number;
  stopTimeoutSec?: number;
}

export type WorkerAction = 'start' | 'stop' | 'restart';

export function fetchWorkers(projectId: number): Promise<WorkerListItem[]> {
  return apiFetch<WorkerListItem[]>(`/api/projects/${String(projectId)}/workers`);
}

export function createWorker(projectId: number, body: CreateWorkerBody): Promise<Worker> {
  return apiFetch<Worker>(`/api/projects/${String(projectId)}/workers`, { method: 'POST', body });
}

export function patchWorker(id: number, body: PatchWorkerBody): Promise<Worker> {
  return apiFetch<Worker>(`/api/workers/${String(id)}`, { method: 'PATCH', body });
}

export function deleteWorker(id: number): Promise<void> {
  return apiFetch<void>(`/api/workers/${String(id)}`, { method: 'DELETE' });
}

export function runWorkerAction(id: number, action: WorkerAction): Promise<void> {
  return apiFetch<void>(`/api/workers/${String(id)}/${action}`, { method: 'POST' });
}

export function fetchWorkerLogs(id: number): Promise<{ content: string }> {
  return apiFetch<{ content: string }>(`/api/workers/${String(id)}/logs`);
}

// ---- Cron ----

export interface CronJob {
  id: number;
  projectId: number;
  schedule: string;
  command: string;
}

export interface CreateCronBody {
  schedule: string;
  command: string;
}

export interface PatchCronBody {
  schedule?: string;
  command?: string;
}

/** The project's cron jobs plus the context needed to explain them rather than just echo the
 * expression back — see the `GET` handler in `server/src/routes/cron.ts`. */
export interface CronJobsResponse {
  jobs: CronJob[];
  /** The HOST's IANA timezone. Cron fires on the server's clock, so next-run times are computed
   * against this rather than the viewer's browser timezone. */
  timezone: string;
  /** The directory each job's command runs in (`<appsDir>/<slug>/current`). */
  workingDir: string;
  /** Where each job's output goes; the per-job file is `<logDir>/cron-<id>.log`. */
  logDir: string;
}

export function fetchCronJobs(projectId: number): Promise<CronJobsResponse> {
  return apiFetch<CronJobsResponse>(`/api/projects/${String(projectId)}/cron`);
}

export function createCronJob(projectId: number, body: CreateCronBody): Promise<CronJob> {
  return apiFetch<CronJob>(`/api/projects/${String(projectId)}/cron`, { method: 'POST', body });
}

export function patchCronJob(id: number, body: PatchCronBody): Promise<CronJob> {
  return apiFetch<CronJob>(`/api/cron/${String(id)}`, { method: 'PATCH', body });
}

export function deleteCronJob(id: number): Promise<void> {
  return apiFetch<void>(`/api/cron/${String(id)}`, { method: 'DELETE' });
}

// ---- Database connections ----

export type DbEngine = 'mysql' | 'postgres';

/**
 * A database server a database can live on: one of the engines running on the Shipway host
 * (`kind: 'local'`, no credentials of its own — the installer's) or a registered external one
 * (`kind: 'external'`, an RDS instance and friends). `key` is what every other call identifies a
 * connection by.
 */
export interface DbConnection {
  key: string;
  kind: 'local' | 'external';
  /** `db_connections.id`; null for one of the host's own engines. */
  id: number | null;
  name: string;
  engine: DbEngine;
  host: string;
  port: number;
  tls: boolean;
  /** The admin user Shipway provisions as. Null for a host engine, whose credentials came from the installer. */
  adminUsername: string | null;
  createdAt: number | null;
  databaseCount: number;
}

export interface DbConnectionBody {
  name: string;
  engine: DbEngine;
  host: string;
  port?: number;
  adminUsername: string;
  adminPassword: string;
  tls?: boolean;
}

export function fetchDbConnections(): Promise<DbConnection[]> {
  return apiFetch<DbConnection[]>('/api/db-connections');
}

export function createDbConnection(body: DbConnectionBody): Promise<DbConnection> {
  return apiFetch<DbConnection>('/api/db-connections', { method: 'POST', body });
}

export function updateDbConnection(id: number, body: Partial<DbConnectionBody>): Promise<void> {
  return apiFetch<void>(`/api/db-connections/${String(id)}`, { method: 'PATCH', body });
}

export function deleteDbConnection(id: number): Promise<void> {
  return apiFetch<void>(`/api/db-connections/${String(id)}`, { method: 'DELETE' });
}

/** Tries credentials without storing them. Resolves either way — `ok: false` is a server that
 * answered and refused, which is a successful test of a wrong password. */
export function testDbConnection(body: Omit<DbConnectionBody, 'name'>): Promise<{ ok: boolean; detail?: string }> {
  return apiFetch<{ ok: boolean; detail?: string }>('/api/db-connections/test', { method: 'POST', body });
}

// ---- Databases ----

export interface DatabaseListItem {
  id: number;
  projectId: number | null;
  connectionId: number | null;
  engine: DbEngine;
  name: string;
  username: string;
  createdAt: number;
  projectName: string | null;
  /** The connection this database lives on, and where an app reaches it. */
  connectionKey: string;
  /** Null only if that connection has gone missing under the database. */
  connectionName: string | null;
  host: string;
  port: number;
}

export interface CreateDatabaseBody {
  /** The connection to create on (`local:mysql`, `external:7`). */
  connection?: string;
  /** Accepted on its own to mean the host's engine — what this call meant before connections existed. */
  engine?: DbEngine;
  name: string;
  projectId?: number;
}

/** The one-time response from `POST /api/databases` — the only place the plaintext password appears. */
export interface DatabaseCreated {
  id: number;
  engine: DbEngine;
  name: string;
  username: string;
  password: string;
  connectionKey: string;
  connectionName: string;
  host: string;
  port: number;
}

/** What the dashboard uses from `GET /api/databases/:id/credentials`. The response also repeats
 *  the database's `name` and `engine`, which only the phpMyAdmin signon shim needs (it has nothing
 *  but an id to go on) — see `lib/database.ts`'s `consoleUrl`. */
export interface DatabaseCredentials {
  username: string;
  password: string;
  host: string;
  port: number;
  env: Record<string, string>;
}

export function fetchDatabases(): Promise<DatabaseListItem[]> {
  return apiFetch<DatabaseListItem[]>('/api/databases');
}

export function createDatabase(body: CreateDatabaseBody): Promise<DatabaseCreated> {
  return apiFetch<DatabaseCreated>('/api/databases', { method: 'POST', body });
}

export function fetchDatabaseCredentials(id: number): Promise<DatabaseCredentials> {
  return apiFetch<DatabaseCredentials>(`/api/databases/${String(id)}/credentials`);
}

export function deleteDatabase(id: number, confirmName: string): Promise<void> {
  return apiFetch<void>(`/api/databases/${String(id)}`, { method: 'DELETE', body: { confirmName } });
}

export function injectDatabase(id: number, projectId: number): Promise<EnvApplyResult> {
  return apiFetch<EnvApplyResult>(`/api/databases/${String(id)}/inject`, { method: 'POST', body: { projectId } });
}

/**
 * Uploads a SQL dump and replays it into database `id`. The file is the request body itself rather
 * than a multipart field — there is exactly one thing being sent, and handing `fetch` the `File`
 * lets the browser stream it off disk instead of reading a 90MB dump into a tab's memory first.
 */
export async function importDatabaseSql(id: number, file: File): Promise<{ bytes: number }> {
  const response = await fetch(`/api/databases/${String(id)}/import`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': SQL_CONTENT_TYPE },
    body: file,
  });
  return readResponse<{ bytes: number }>(response);
}

/** What `importDatabaseSql` posts as, matching the raw content-type parser `routes/databases.ts`
 * registers. A `.sql` file's own `file.type` is unreliable (often empty, sometimes `text/plain`),
 * so the type is stated here rather than taken from the picker. */
const SQL_CONTENT_TYPE = 'application/sql';

/** Largest dump the server will accept (`MAX_IMPORT_BYTES` in `routes/databases.ts`), so the
 * dashboard can say so before spending minutes uploading one it will refuse. */
export const MAX_SQL_IMPORT_BYTES = 100 * 1024 * 1024;

export interface RedisInfo {
  host: string;
  port: number;
  password?: string;
}

export interface MailpitInfo {
  smtpHost: string;
  smtpPort: number;
  webUrl: string;
  /** Basic-auth credentials for the mailpit web UI, when the server was provisioned with them. */
  username?: string;
  webPassword?: string;
}

export interface ServicesInfo {
  redis: RedisInfo | null;
  mailpit: MailpitInfo | null;
  /** Engines with admin credentials configured on the host — the only ones a database can be created on. */
  databaseEngines: Record<DbEngine, boolean>;
}

export function fetchServicesInfo(): Promise<ServicesInfo> {
  return apiFetch<ServicesInfo>('/api/services/info');
}

// ---- Server ----

export interface ServerStats {
  cpu: { cores: number; load1: number };
  mem: { totalMb: number; usedMb: number };
  disk: { totalGb: number; usedGb: number; mount: string };
  services: { name: string; unit: string; status: 'active' | 'inactive' | 'failed' | 'unknown' }[];
  shipwayVersion: string;
}

export function fetchServerStats(): Promise<ServerStats> {
  return apiFetch<ServerStats>('/api/server/stats');
}

// ---- Team (users, invites, roles) ----

export type UserStatus = 'active' | 'invited';

/**
 * Which projects a user can reach (`server/src/lib/projectaccess.ts`). `'all'` is every project,
 * present and future; `'selected'` is exactly the ids in `projectIds`. Admins and the owner are
 * always `'all'` — the server reports their EFFECTIVE access, so a scope can never be shown for
 * someone who reaches everything by role anyway.
 */
export type ProjectAccessMode = 'all' | 'selected';

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  /** `null` for an active user; epoch ms for a still-pending invite. */
  inviteExpiresAt: number | null;
  createdAt: number;
  projectAccess: ProjectAccessMode;
  /** The granted project ids — always `[]` when `projectAccess` is `'all'`. */
  projectIds: number[];
}

export interface CreateUserBody {
  name: string;
  email: string;
  password: string;
}

/** Only `member`/`admin` are invitable — the owner role is a permanent singleton. */
export type InvitableRole = 'member' | 'admin';

export interface InviteUserBody {
  email: string;
  role: InvitableRole;
  /** Omit for `'all'` — the server defaults to it. Ignored by the server for an `admin` invite,
   * who reaches every project by role. */
  projectAccess?: ProjectAccessMode;
  /** Only meaningful with `projectAccess: 'selected'`. */
  projectIds?: number[];
}

/** Shared response shape for both `POST /api/users/invite` and `POST /api/users/:id/reinvite` —
 * `inviteUrl` (`/invite/<token>`) is the only place the token is ever returned; it can't be
 * retrieved again later, only regenerated via reinvite. `emailed` (Task 7) reports whether the
 * invite link was also sent by email through instance mail: `false` with no `emailError` means mail
 * isn't configured (the link is the only path, as it always was); `false` with `emailError` means a
 * send was attempted and failed (sanitized message, safe to show). Either way `inviteUrl` is always
 * present — email is additive, never the only path to the invite. */
export interface InviteResult {
  id: number;
  email: string;
  role: InvitableRole;
  /** The scope the invite actually granted — echoed back so the UI confirms what was sent rather
   * than what was asked for (they differ for an admin invite, which is always `'all'`). */
  projectAccess: ProjectAccessMode;
  projectIds: number[];
  inviteUrl: string;
  expiresAt: number;
  emailed: boolean;
  emailError?: string;
}

export interface InvitePreview {
  email: string;
  valid: boolean;
}

export interface AcceptInviteBody {
  name: string;
  password: string;
}

export function fetchUsers(): Promise<User[]> {
  return apiFetch<User[]>('/api/users');
}

export function createUser(body: CreateUserBody): Promise<User> {
  return apiFetch<User>('/api/users', { method: 'POST', body });
}

export function inviteUser(body: InviteUserBody): Promise<InviteResult> {
  return apiFetch<InviteResult>('/api/users/invite', { method: 'POST', body });
}

export function reinviteUser(id: number): Promise<InviteResult> {
  return apiFetch<InviteResult>(`/api/users/${String(id)}/reinvite`, { method: 'POST' });
}

export function fetchInvite(token: string): Promise<InvitePreview> {
  return apiFetch<InvitePreview>(`/api/invite/${token}`);
}

export function acceptInvite(token: string, body: AcceptInviteBody): Promise<Me> {
  return apiFetch<Me>(`/api/invite/${token}`, { method: 'POST', body });
}

export function changeUserRole(id: number, role: InvitableRole): Promise<User> {
  return apiFetch<User>(`/api/users/${String(id)}/role`, { method: 'PATCH', body: { role } });
}

/** Replaces a user's project scope (`PUT /api/users/:id/projects`). The grants are a SET: passing
 * `[]` with `'selected'` really does mean "no projects". Admin+ to call; owner to target an admin. */
export function setUserProjects(id: number, projectAccess: ProjectAccessMode, projectIds: number[]): Promise<User> {
  return apiFetch<User>(`/api/users/${String(id)}/projects`, { method: 'PUT', body: { projectAccess, projectIds } });
}

export function deleteUser(id: number): Promise<void> {
  return apiFetch<void>(`/api/users/${String(id)}`, { method: 'DELETE' });
}

// ---- Project notifications (per-project email recipients) ----

/** The four deploy events a project can email its recipients about. Notifications are a PER-PROJECT
 * feature: the instance-wide delivery-channel API is gone, and with it webhook/Teams delivery and
 * the host-wide `service_down`/`service_recovered` events (those transitions still appear in the
 * Audit Log). See `server/src/services/notifybus.ts`. */
export type NotifyEvent = 'deploy_failed' | 'deploy_succeeded' | 'deploy_canceled' | 'deploy_rolled_back';

export interface ProjectNotificationEvent {
  event: NotifyEvent;
  label: string;
  description: string;
  enabled: boolean;
}

export interface ProjectNotifications {
  /** Recipient addresses in the order they were added. */
  recipients: string[];
  /** Every known event, each flagged with whether this project is subscribed to it. */
  events: ProjectNotificationEvent[];
  /** Whether instance mail (Settings > Mail) is configured. `false` means nothing will actually be
   * delivered no matter what's saved here. */
  mailConfigured: boolean;
}

/** Replace-all: whatever is sent becomes the project's complete recipient list and event set. */
export interface ProjectNotificationsUpdate {
  recipients: string[];
  events: NotifyEvent[];
}

export function fetchProjectNotifications(projectId: number): Promise<ProjectNotifications> {
  return apiFetch<ProjectNotifications>(`/api/projects/${String(projectId)}/notifications`);
}

export function putProjectNotifications(projectId: number, body: ProjectNotificationsUpdate): Promise<ProjectNotifications> {
  return apiFetch<ProjectNotifications>(`/api/projects/${String(projectId)}/notifications`, { method: 'PUT', body });
}

/** Sends a real test email to every recipient on the project's list. `error` carries the mailer's
 * own message when the send fails, or a reason the send never happened (no recipients, instance mail
 * unconfigured). */
export function testProjectNotifications(projectId: number): Promise<{ ok: boolean; error?: string }> {
  return apiFetch<{ ok: boolean; error?: string }>(`/api/projects/${String(projectId)}/notifications/test`, { method: 'POST' });
}

// ---- Audit log ----

export type AuditCategory = 'all' | 'deployments' | 'projects' | 'databases' | 'team' | 'settings';

export interface AuditEvent {
  id: number;
  actorId: number | null;
  actorName: string;
  action: string;
  targetType: string;
  targetName: string;
  meta: unknown;
  createdAt: number;
}

export interface AuditListParams {
  category?: AuditCategory;
  q?: string;
  actorId?: number;
  since?: number;
  cursor?: number;
  limit?: number;
}

export interface AuditListResult {
  events: AuditEvent[];
  nextCursor: number | null;
  counts: Record<AuditCategory, number>;
}

export function fetchAudit(params: AuditListParams = {}): Promise<AuditListResult> {
  const query = new URLSearchParams();
  if (params.category) query.set('category', params.category);
  if (params.q) query.set('q', params.q);
  if (params.actorId !== undefined) query.set('actorId', String(params.actorId));
  if (params.since !== undefined) query.set('since', String(params.since));
  if (params.cursor !== undefined) query.set('cursor', String(params.cursor));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const qs = query.toString();
  return apiFetch<AuditListResult>(`/api/audit${qs ? `?${qs}` : ''}`);
}

export interface AuditConfig {
  enabled: boolean;
  retentionDays: 30 | 90 | 365;
}

export function fetchAuditConfig(): Promise<AuditConfig> {
  return apiFetch<AuditConfig>('/api/audit/config');
}

export function putAuditConfig(body: Partial<AuditConfig>): Promise<AuditConfig> {
  return apiFetch<AuditConfig>('/api/audit/config', { method: 'PUT', body });
}

// ---- GitHub App (settings management) ----

export interface ManualGithubAppBody {
  appId: number;
  privateKey: string;
  webhookSecret: string;
}

export function putGithubApp(body: ManualGithubAppBody): Promise<GithubStatus> {
  return apiFetch<GithubStatus>('/api/github/app', { method: 'PUT', body });
}

/**
 * With no `installationId` the server auto-detects, but only when the app has exactly one
 * installation — otherwise it 409s with `{ error: 'multiple installations', installations }` so the
 * caller can ask which account to deploy from rather than binding to an arbitrary one.
 */
export function resolveGithubInstallation(installationId?: number): Promise<{ installationId: number }> {
  return apiFetch<{ installationId: number }>('/api/github/resolve-installation', {
    method: 'POST',
    ...(installationId === undefined ? {} : { body: { installationId } }),
  });
}
