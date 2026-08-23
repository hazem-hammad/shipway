import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch, fetchMe, fetchSetupStatus, type Me, type SetupStatus } from './api';

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
