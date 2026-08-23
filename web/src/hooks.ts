import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  apiFetch,
  fetchDeployment,
  fetchDeployments,
  fetchGithubBranches,
  fetchGithubRepos,
  fetchGithubStatus,
  fetchMe,
  fetchProject,
  fetchProjectEnv,
  fetchProjectEnvPreview,
  fetchProjects,
  fetchSettings,
  fetchSetupStatus,
  isPendingDeploymentStatus,
  type Deployment,
  type GithubRepo,
  type GithubStatus,
  type Me,
  type Project,
  type ProjectListItem,
  type Settings,
  type SetupStatus,
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
