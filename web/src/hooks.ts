import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  apiFetch,
  fetchGithubBranches,
  fetchGithubRepos,
  fetchGithubStatus,
  fetchMe,
  fetchProjects,
  fetchSettings,
  fetchSetupStatus,
  isPendingDeploymentStatus,
  type GithubRepo,
  type GithubStatus,
  type Me,
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
