import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  apiFetch,
  fetchCronJobs,
  fetchDatabases,
  fetchDeployment,
  fetchDeployments,
  fetchGithubBranches,
  fetchGithubRepos,
  fetchGithubStatus,
  fetchGlobalDeployments,
  fetchMe,
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
  type CronJob,
  type DatabaseListItem,
  type Deployment,
  type GithubRepo,
  type GithubStatus,
  type GlobalDeployment,
  type Me,
  type Overview,
  type Project,
  type ProjectListItem,
  type ServerStats,
  type ServicesInfo,
  type Settings,
  type SetupStatus,
  type User,
  type WorkerListItem,
} from './api';

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
 * The global Deployments page's list (`GET /api/deployments`, Task 5/7). Polls every 10s while any
 * row is queued/running, else every 30s.
 */
export function useGlobalDeployments(): UseQueryResult<GlobalDeployment[]> {
  return useQuery({
    queryKey: ['deployments-global'],
    queryFn: () => fetchGlobalDeployments(),
    refetchInterval: (query) => (query.state.data?.some((d) => isPendingDeploymentStatus(d.status)) ? 10_000 : 30_000),
  });
}

export function useGithubStatus(): UseQueryResult<GithubStatus> {
  return useQuery({ queryKey: ['github-status'], queryFn: fetchGithubStatus });
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

/** A project's cron jobs (Cron tab). */
export function useCronJobs(projectId: number): UseQueryResult<CronJob[]> {
  return useQuery({ queryKey: ['cron', projectId], queryFn: () => fetchCronJobs(projectId) });
}

// ---- Databases page ----

export function useDatabases(): UseQueryResult<DatabaseListItem[]> {
  return useQuery({ queryKey: ['databases'], queryFn: fetchDatabases });
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

// ---- Settings > Users ----

export function useUsers(): UseQueryResult<User[]> {
  return useQuery({ queryKey: ['users'], queryFn: fetchUsers });
}
