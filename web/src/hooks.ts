import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  apiFetch,
  fetchAuditConfig,
  fetchCronJobs,
  fetchDatabases,
  fetchDbConnections,
  fetchDeployment,
  fetchDeployments,
  fetchGitBranches,
  fetchGithubBranches,
  fetchGithubDirs,
  fetchGithubRepos,
  fetchGithubStatus,
  fetchGlobalDeployments,
  fetchInvite,
  fetchMailConfig,
  fetchMe,
  fetchProjectNotifications,
  fetchOverview,
  fetchProject,
  fetchProjectEnv,
  fetchProjectEnvPreview,
  fetchProjects,
  fetchServerStats,
  fetchServicesInfo,
  fetchSettings,
  fetchSetupStatus,
  fetchUsers,
  fetchWorkers,
  isPendingDeploymentStatus,
  verifyCloudflare,
  type AuditConfig,
  type CloudflareVerifyResult,
  type CronJobsResponse,
  type DatabaseListItem,
  type DbConnection,
  type Deployment,
  type GitRemoteBranches,
  type GithubRepo,
  type GithubStatus,
  type GlobalDeployment,
  type InvitePreview,
  type MailConfig,
  type Me,
  type ProjectNotifications,
  type Overview,
  type Project,
  type ProjectListItem,
  type Role,
  type ServerStats,
  type ServicesInfo,
  type Settings,
  type SetupStatus,
  type User,
  type WorkerListItem,
} from './api';

/** `member < admin < owner`, mirroring `server/src/lib/authz.ts`'s `roleAtLeast` — the web app never
 * enforces anything (every gate is server-side, and a 403 is always handled calmly), this is purely
 * for deciding what controls to *show*. */
const ROLE_RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export function roleAtLeast(role: Role | undefined, min: Role): boolean {
  return role !== undefined && ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * Whether an admin account exists yet. `retry: false` — an error here (network, 5xx) should
 * surface immediately rather than spend seconds retrying before the shell can render anything.
 */
export function useSetupStatus(): UseQueryResult<SetupStatus> {
  return useQuery({ queryKey: ['setup-status'], queryFn: fetchSetupStatus, retry: false });
}

/** The current session's user, or an error (typically a 401) when there isn't one. */
export function useMe(): UseQueryResult<Me> {
  return useQuery({ queryKey: ['me'], queryFn: fetchMe, retry: false });
}

/** `true` once the session user's role has loaded and is admin or owner. `false` (not `undefined`)
 * while pending, so an admin-only control defaults to hidden/disabled rather than flashing visible. */
export function useIsAdmin(): boolean {
  const me = useMe();
  return roleAtLeast(me.data?.role, 'admin');
}

export function useIsOwner(): boolean {
  const me = useMe();
  return roleAtLeast(me.data?.role, 'owner');
}

/** Public invite preview (`GET /api/invite/:token`) for the unauthenticated accept page. */
export function useInvitePreview(token: string): UseQueryResult<InvitePreview> {
  return useQuery({ queryKey: ['invite', token], queryFn: () => fetchInvite(token), retry: false });
}

/** Home dashboard summary (`GET /api/overview`); refreshed every 30s per the task-6 ruling. */
export function useOverview(): UseQueryResult<Overview> {
  return useQuery({ queryKey: ['overview'], queryFn: fetchOverview, refetchInterval: 30_000 });
}

/**
 * Server reachability for the sidebar's berth light (DESIGN.md: "sidebar wordmark (server
 * reachable)"). Public route, polled lightly — a missed beat isn't urgent for an internal tool.
 */
export function useServerHealth(): UseQueryResult<{ status: string }> {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<{ status: string }>('/api/health'),
    retry: false,
    refetchInterval: 30_000,
  });
}

/** Base domain, ACME email, etc. — used to render each project's `<slug>.<base_domain>` link. */
export function useSettings(): UseQueryResult<Settings> {
  return useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
}

/**
 * The projects table (DESIGN.md). Polls every 10s while any row's last deployment is queued or
 * running, and stops once everything has settled — see `isPendingDeploymentStatus`.
 */
export function useProjects(): UseQueryResult<ProjectListItem[]> {
  return useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    refetchInterval: (query) =>
      query.state.data?.some((project) => isPendingDeploymentStatus(project.lastDeployment?.status)) ? 10_000 : false,
  });
}

/**
 * The global Deployments page's list (`GET /api/deployments`, Task 5/7).
 *
 * Two speeds, because the page has two jobs. While something is queued or running it is a live
 * view of work in flight — a deploy moves through resolve/build/activate in seconds, so a 10s poll
 * showed a stage that had already finished — hence 2s. With everything settled it is a history
 * list that only changes when someone pushes, so it drops to 30s.
 *
 * `refetchOnWindowFocus` covers the case polling can't: a tab left in the background for an hour
 * shows the truth the moment it is looked at again, rather than up to 30s later.
 */
export function useGlobalDeployments(): UseQueryResult<GlobalDeployment[]> {
  return useQuery({
    queryKey: ['deployments-global'],
    queryFn: () => fetchGlobalDeployments(),
    refetchInterval: (query) => (query.state.data?.some((d) => isPendingDeploymentStatus(d.status)) ? 2_000 : 30_000),
    refetchOnWindowFocus: true,
  });
}

export function useGithubStatus(): UseQueryResult<GithubStatus> {
  return useQuery({ queryKey: ['github-status'], queryFn: fetchGithubStatus });
}

/**
 * Live Cloudflare connection status (`GET /api/cloudflare/verify`) — used by New Project's Domain
 * card (plan Task 5) to show whether the DNS record it describes will actually be created, and by
 * Settings > Cloudflare's own "Test connection" flow. No `refetchInterval`: a stale answer isn't
 * dangerous (the create route still enforces reality), and re-checking is cheap via `refetch()`.
 */
export function useCloudflareVerify(): UseQueryResult<CloudflareVerifyResult> {
  return useQuery({ queryKey: ['cloudflare-verify'], queryFn: verifyCloudflare });
}

/** Repos accessible to the installed GitHub App. Only meaningful once the app is installed. */
export function useGithubRepos(enabled: boolean): UseQueryResult<GithubRepo[]> {
  return useQuery({ queryKey: ['github-repos'], queryFn: fetchGithubRepos, enabled });
}

export function useGithubBranches(repo: string | null): UseQueryResult<string[]> {
  return useQuery({
    queryKey: ['github-branches', repo],
    queryFn: () => fetchGithubBranches(repo ?? ''),
    enabled: repo !== null,
  });
}

/**
 * Branches of a pasted git URL (`git ls-remote` server-side), so a non-GitHub source gets the same
 * branch dropdown a GitHub repo does. Never retried: a failure here is usually a wrong URL or
 * missing credentials, and hammering an unreachable remote three times just makes the form feel
 * stuck — the field falls back to free text instead.
 */
export function useGitBranches(url: string | null): UseQueryResult<GitRemoteBranches> {
  return useQuery({
    queryKey: ['git-branches', url],
    queryFn: () => fetchGitBranches(url ?? ''),
    enabled: url !== null && url !== '',
    retry: false,
  });
}

/** Top-level directories of a GitHub repo at a branch — public-directory suggestions. */
export function useGithubDirs(repo: string | null, branch: string | null): UseQueryResult<string[]> {
  return useQuery({
    queryKey: ['github-dirs', repo, branch],
    queryFn: () => fetchGithubDirs(repo ?? '', branch ?? ''),
    enabled: repo !== null && branch !== null && branch !== '',
  });
}

// ---- Project detail ----

export function useProject(id: number): UseQueryResult<Project> {
  return useQuery({ queryKey: ['project', id], queryFn: () => fetchProject(id) });
}

export function useProjectEnv(id: number): UseQueryResult<{ content: string }> {
  return useQuery({ queryKey: ['project-env', id], queryFn: () => fetchProjectEnv(id) });
}

/** The read-only managed-block preview (task 24's new `env/preview` route). */
export function useProjectEnvPreview(id: number): UseQueryResult<{ content: string }> {
  return useQuery({ queryKey: ['project-env-preview', id], queryFn: () => fetchProjectEnvPreview(id) });
}

/**
 * A project's deployment history (Deployments tab). Polls every 3s while any row is queued/running,
 * else every 15s per the task-24 controller ruling.
 */
export function useDeployments(projectId: number): UseQueryResult<Deployment[]> {
  return useQuery({
    queryKey: ['deployments', projectId],
    queryFn: () => fetchDeployments(projectId),
    refetchInterval: (query) => (query.state.data?.some((d) => isPendingDeploymentStatus(d.status)) ? 3_000 : 15_000),
  });
}

/** A single deployment's status (DeploymentLog header). Polls every 3s while queued/running. */
export function useDeployment(id: number): UseQueryResult<Deployment> {
  return useQuery({
    queryKey: ['deployment', id],
    queryFn: () => fetchDeployment(id),
    refetchInterval: (query) => (isPendingDeploymentStatus(query.state.data?.status) ? 3_000 : false),
  });
}

/** A project's workers, with each row's live systemd instance statuses (Workers tab). */
export function useWorkers(projectId: number): UseQueryResult<WorkerListItem[]> {
  return useQuery({ queryKey: ['workers', projectId], queryFn: () => fetchWorkers(projectId) });
}

/** A project's cron jobs (Cron tab), plus the host timezone and paths the tab explains them with. */
export function useCronJobs(projectId: number): UseQueryResult<CronJobsResponse> {
  return useQuery({ queryKey: ['cron', projectId], queryFn: () => fetchCronJobs(projectId) });
}

// ---- Databases page ----

export function useDatabases(): UseQueryResult<DatabaseListItem[]> {
  return useQuery({ queryKey: ['databases'], queryFn: fetchDatabases });
}

/** The database servers a database can be created on — the host's own engines plus every registered
 * external one. Feeds both the Databases page's connection list and the new-project picker. */
export function useDbConnections(): UseQueryResult<DbConnection[]> {
  return useQuery({ queryKey: ['db-connections'], queryFn: fetchDbConnections });
}

/** Redis/Mailpit connection info for the info panels at the bottom of the Databases page. */
export function useServicesInfo(): UseQueryResult<ServicesInfo> {
  return useQuery({ queryKey: ['services-info'], queryFn: fetchServicesInfo });
}

// ---- Server page ----

/** Host resource usage + shared service status (DESIGN.md/task-25 ruling: polls every 10s). */
export function useServerStats(): UseQueryResult<ServerStats> {
  return useQuery({ queryKey: ['server-stats'], queryFn: fetchServerStats, refetchInterval: 10_000 });
}

// ---- Settings > Mail ----

/** Instance mail config (`server/src/routes/mail.ts`); member-readable, same as `useSettings`. */
export function useMailConfig(): UseQueryResult<MailConfig> {
  return useQuery({ queryKey: ['mail-config'], queryFn: fetchMailConfig });
}

// ---- Settings > Team ----

export function useUsers(): UseQueryResult<User[]> {
  return useQuery({ queryKey: ['users'], queryFn: fetchUsers });
}

// ---- Project > Settings > Notifications ----

/** Keyed per project, so switching projects never shows the previous one's recipient list. */
export function useProjectNotifications(projectId: number): UseQueryResult<ProjectNotifications> {
  return useQuery({ queryKey: ['project-notifications', projectId], queryFn: () => fetchProjectNotifications(projectId) });
}

// ---- Audit log ----

export function useAuditConfig(): UseQueryResult<AuditConfig> {
  return useQuery({ queryKey: ['audit-config'], queryFn: fetchAuditConfig });
}
