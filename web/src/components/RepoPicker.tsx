/**
 * Repository + branch pickers for `ProjectNew`. If the GitHub App isn't installed yet, this renders
 * an inline notice pointing at `/settings/github` instead (never a modal — DESIGN.md bans them).
 * Once installed, it's a client-side-filterable list of repos, then a branch select that preselects
 * the chosen repo's default branch.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useGithubBranches, useGithubRepos, useGithubStatus } from '../hooks';
import { Input, Select, Skeleton } from './ui';

export interface RepoPickerValue {
  repo: string;
  branch: string;
}

export interface RepoPickerProps {
  value: RepoPickerValue | null;
  onChange: (value: RepoPickerValue | null) => void;
}

export function RepoPicker({ value, onChange }: RepoPickerProps) {
  const status = useGithubStatus();
  const [search, setSearch] = useState('');

  const reposQuery = useGithubRepos(status.data?.installed === true);
  const branchesQuery = useGithubBranches(value?.repo ?? null);

  const filteredRepos = useMemo(() => {
    const repos = reposQuery.data ?? [];
    const query = search.trim().toLowerCase();
    return query === '' ? repos : repos.filter((repo) => repo.fullName.toLowerCase().includes(query));
  }, [reposQuery.data, search]);

  if (status.isPending) {
    return <Skeleton className="h-10 w-full" />;
  }

  if (!status.data?.installed) {
    return (
      <div className="rounded-md border border-dashed border-line bg-panel/50 px-4 py-3 text-sm text-ink-soft">
        {status.data?.configured
          ? "The GitHub App is configured but isn't installed on any repositories yet."
          : 'Connect a GitHub App to select a repository.'}{' '}
        <Link
          href="/settings/github"
          className="font-medium text-accent underline decoration-line underline-offset-2 hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Set up GitHub
        </Link>
      </div>
    );
  }

  function selectRepo(fullName: string) {
    const repo = reposQuery.data?.find((candidate) => candidate.fullName === fullName);
    if (!repo) return;
    onChange({ repo: repo.fullName, branch: repo.defaultBranch });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">Repository</span>
        <Input
          type="search"
          mono
          placeholder="Search repositories"
          aria-label="Search repositories"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {reposQuery.isPending ? (
          <Skeleton className="h-28 w-full" />
        ) : reposQuery.isError ? (
          <p role="alert" className="text-xs text-stop">
            Could not load repositories.
          </p>
        ) : (
          <Select
            mono
            aria-label="Repository"
            size={Math.min(6, Math.max(3, filteredRepos.length || 1))}
            value={value?.repo ?? ''}
            onChange={(event) => selectRepo(event.target.value)}
          >
            <option value="" disabled>
              {filteredRepos.length === 0 ? 'No repositories match.' : 'Select a repository'}
            </option>
            {filteredRepos.map((repo) => (
              <option key={repo.fullName} value={repo.fullName}>
                {repo.fullName}
                {repo.private ? ' (private)' : ''}
              </option>
            ))}
          </Select>
        )}
      </div>

      {value?.repo && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">Branch</span>
          {branchesQuery.isPending ? (
            <Skeleton className="h-10 w-full" />
          ) : branchesQuery.isError ? (
            <p role="alert" className="text-xs text-stop">
              Could not load branches.
            </p>
          ) : (
            <Select
              mono
              aria-label="Branch"
              value={value.branch}
              onChange={(event) => onChange({ repo: value.repo, branch: event.target.value })}
            >
              {(branchesQuery.data?.includes(value.branch) ? branchesQuery.data : [value.branch, ...(branchesQuery.data ?? [])]).map(
                (branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ),
              )}
            </Select>
          )}
        </div>
      )}
    </div>
  );
}
