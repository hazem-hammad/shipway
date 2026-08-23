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

export interface CreateProjectBody {
  name: string;
  slug: string;
  repo: string;
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

export function deployProject(id: number): Promise<{ deploymentId: number }> {
  return apiFetch<{ deploymentId: number }>(`/api/projects/${String(id)}/deploy`, { method: 'POST' });
}
