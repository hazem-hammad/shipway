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

export interface Me {
  id: number;
  name: string;
  email: string;
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

export interface CloudflareVerifyResult {
  ok: boolean;
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

// ---- GitHub App ----

export function fetchGithubManifest(baseUrl: string): Promise<GithubManifest> {
  return apiFetch<GithubManifest>(`/api/github/manifest?baseUrl=${encodeURIComponent(baseUrl)}`);
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
  smtpMode: 'mailpit' | 'custom' | 'none';
  notifyWebhookUrl: string | null;
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
  healthCheckPath?: string | null;
  autoDeploy?: boolean;
}

export function fetchProjects(): Promise<ProjectListItem[]> {
  return apiFetch<ProjectListItem[]>('/api/projects');
}

export function createProject(body: CreateProjectBody): Promise<Project> {
  return apiFetch<Project>('/api/projects', { method: 'POST', body });
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
}

export function patchProject(id: number, body: PatchProjectBody): Promise<Project> {
  return apiFetch<Project>(`/api/projects/${String(id)}`, { method: 'PATCH', body });
}

export function deleteProject(id: number, confirmName: string): Promise<void> {
  return apiFetch<void>(`/api/projects/${String(id)}`, { method: 'DELETE', body: { confirmName } });
}

export function fetchProjectEnv(id: number): Promise<{ content: string }> {
  return apiFetch<{ content: string }>(`/api/projects/${String(id)}/env`);
}

export function putProjectEnv(id: number, content: string): Promise<void> {
  return apiFetch<void>(`/api/projects/${String(id)}/env`, { method: 'PUT', body: { content } });
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

export interface SmtpPutBody {
  mode: 'mailpit' | 'custom' | 'none';
  config?: SmtpConfig;
}

export function putProjectSmtp(id: number, body: SmtpPutBody): Promise<void> {
  return apiFetch<void>(`/api/projects/${String(id)}/smtp`, { method: 'PUT', body });
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
  commitSha: string | null;
  commitMessage: string | null;
  releasePath: string | null;
  logPath: string | null;
  startedAt: number | null;
  finishedAt: number | null;
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

export interface Worker {
  id: number;
  projectId: number;
  name: string;
  command: string;
  processes: number;
  statusCached: string | null;
}

export interface WorkerListItem extends Worker {
  instances: WorkerInstance[];
}

export interface CreateWorkerBody {
  name: string;
  command: string;
  processes: number;
}

export interface PatchWorkerBody {
  command?: string;
  processes?: number;
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

export function fetchCronJobs(projectId: number): Promise<CronJob[]> {
  return apiFetch<CronJob[]>(`/api/projects/${String(projectId)}/cron`);
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

// ---- Databases ----

export type DbEngine = 'mysql' | 'postgres';

export interface DatabaseListItem {
  id: number;
  projectId: number | null;
  engine: DbEngine;
  name: string;
  username: string;
  createdAt: number;
  projectName: string | null;
}

export interface CreateDatabaseBody {
  engine: DbEngine;
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
}

export interface DatabaseCredentials {
  username: string;
  password: string;
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

export function injectDatabase(id: number, projectId: number): Promise<void> {
  return apiFetch<void>(`/api/databases/${String(id)}/inject`, { method: 'POST', body: { projectId } });
}

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

// ---- Users ----

export interface User {
  id: number;
  name: string;
  email: string;
  createdAt: number;
}

export interface CreateUserBody {
  name: string;
  email: string;
  password: string;
}

export function fetchUsers(): Promise<User[]> {
  return apiFetch<User[]>('/api/users');
}

export function createUser(body: CreateUserBody): Promise<User> {
  return apiFetch<User>('/api/users', { method: 'POST', body });
}

export function deleteUser(id: number): Promise<void> {
  return apiFetch<void>(`/api/users/${String(id)}`, { method: 'DELETE' });
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

export function resolveGithubInstallation(): Promise<{ installationId: number }> {
  return apiFetch<{ installationId: number }>('/api/github/resolve-installation', { method: 'POST' });
}
