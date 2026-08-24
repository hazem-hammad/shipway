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

// ---- Team (users, invites, roles) ----

export type UserStatus = 'active' | 'invited';

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  /** `null` for an active user; epoch ms for a still-pending invite. */
  inviteExpiresAt: number | null;
  createdAt: number;
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
}

/** Shared response shape for both `POST /api/users/invite` and `POST /api/users/:id/reinvite` —
 * `inviteUrl` (`/invite/<token>`) is the only place the token is ever returned; it can't be
 * retrieved again later, only regenerated via reinvite. */
export interface InviteResult {
  id: number;
  email: string;
  role: InvitableRole;
  inviteUrl: string;
  expiresAt: number;
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

export function deleteUser(id: number): Promise<void> {
  return apiFetch<void>(`/api/users/${String(id)}`, { method: 'DELETE' });
}

// ---- Notifications (delivery channels + event matrix) ----

export type NotifyEvent = 'deploy_failed' | 'deploy_succeeded' | 'deploy_canceled' | 'deploy_rolled_back' | 'service_down' | 'service_recovered';
export type NotifyEventCategory = 'deployment' | 'services';

export interface NotificationChannel {
  id: number;
  name: string;
  url: string;
}

export interface NotificationEventMeta {
  event: NotifyEvent;
  label: string;
  description: string;
  category: NotifyEventCategory;
}

export interface NotificationSubscription {
  event: string;
  channelId: number;
}

export interface NotificationsMatrix {
  channels: NotificationChannel[];
  events: NotificationEventMeta[];
  subscriptions: NotificationSubscription[];
}

export interface CreateChannelBody {
  name: string;
  url: string;
}

export function fetchNotifications(): Promise<NotificationsMatrix> {
  return apiFetch<NotificationsMatrix>('/api/notifications');
}

export function createChannel(body: CreateChannelBody): Promise<NotificationChannel> {
  return apiFetch<NotificationChannel>('/api/notifications/channels', { method: 'POST', body });
}

export function deleteChannel(id: number): Promise<void> {
  return apiFetch<void>(`/api/notifications/channels/${String(id)}`, { method: 'DELETE' });
}

export function testChannel(id: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/notifications/channels/${String(id)}/test`, { method: 'POST' });
}

export interface PutSubscriptionBody {
  event: string;
  channelId: number;
  enabled: boolean;
}

export function putSubscription(body: PutSubscriptionBody): Promise<PutSubscriptionBody> {
  return apiFetch<PutSubscriptionBody>('/api/notifications/subscriptions', { method: 'PUT', body });
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

export function resolveGithubInstallation(): Promise<{ installationId: number }> {
  return apiFetch<{ installationId: number }>('/api/github/resolve-installation', { method: 'POST' });
}
