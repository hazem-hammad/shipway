/**
 * The global Deployments page (route `/deployments`): recent deployments across every project,
 * newest first, from `GET /api/deployments`.
 *
 * Built as a real `<table>`, matching the Projects list — this page is read down its columns
 * ("which of these failed", "which took four minutes"), which is what a table is for. Same system
 * pieces otherwise: hairline row separators, 56px rows, `--surface-2` hover, the 12px uppercase
 * table header DESIGN.md defines.
 *
 * **Live.** Two things keep it current, because they answer different failure modes:
 *
 *   * `useGlobalDeployments` polls every 2s while anything is queued or running and drops to 30s
 *     once everything has settled, so a deploy's status arrives without a refresh and an idle tab
 *     isn't hammering the server for a list that cannot change.
 *   * Elapsed times tick locally, once a second. A poll every 2s would otherwise make a running
 *     deploy's timer jump in 2s steps, which reads as a stuck page rather than a live one — the
 *     clock is the one thing the client can be authoritative about between polls.
 *
 * Deliberately not sorted by column, unlike the Projects table: the server returns a capped window
 * of the most recent deployments, so re-sorting it would silently reorder *that window* while
 * looking like it had sorted everything. Chronological is the only honest order for a truncated
 * list, and the cap is stated under the table rather than hidden.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Search } from 'lucide-react';
import { ApiError, cancelDeployment, isPendingDeploymentStatus, type DeploymentStatus, type GlobalDeployment } from '../api';
import { useGlobalDeployments } from '../hooks';
import { formatDuration, formatRelativeTime, shortSha } from '../lib/format';
import {
  Badge,
  BranchLabel,
  Button,
  ButtonLink,
  Card,
  Chip,
  EmptyState,
  ICON_STROKE,
  Input,
  PageHeader,
  Skeleton,
  StatusDot,
  Tabs,
  type StatusDotStatus,
} from '../components/ui';

const DOT_STATUS_BY_DEPLOY: Record<DeploymentStatus, StatusDotStatus> = {
  queued: 'warn',
  running: 'warn',
  success: 'ok',
  failed: 'danger',
  rolled_back: 'ok',
  canceled: 'idle',
};

const DEPLOY_STATUS_LABEL: Record<DeploymentStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  success: 'Succeeded',
  failed: 'Failed',
  rolled_back: 'Rolled back',
  canceled: 'Canceled',
};

const DEPLOY_STATUS_TEXT_CLASS: Record<DeploymentStatus, string> = {
  queued: 'text-warn',
  running: 'text-warn',
  success: 'text-ink',
  failed: 'text-danger',
  rolled_back: 'text-warn',
  canceled: 'text-soft',
};

const TRIGGER_LABEL: Record<GlobalDeployment['trigger'], string> = {
  push: 'Push',
  manual: 'Manual',
  rollback: 'Rollback',
};

/** The server's own cap on `GET /api/deployments` when no `limit` is passed. Stated under the table
 * rather than left as a silent truncation. */
const SERVER_LIMIT = 50;

// ---------------------------------------------------------------------------
// View state — in the query string, so a filtered list is a link and survives a reload.
// ---------------------------------------------------------------------------

/**
 * Exhaustive over `DeploymentStatus`, so the tab counts add up to the total and no deployment can
 * be invisible under every tab but All. `rolled_back` sits with the failures: a rollback is the
 * *recovery*, which means the deploy it replaced did not work.
 */
type StatusBucket = 'active' | 'succeeded' | 'failed' | 'canceled';
type StatusFilter = StatusBucket | 'all';

interface View {
  q: string;
  status: StatusFilter;
}

const DEFAULT_VIEW: View = { q: '', status: 'all' };

const STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'In flight' },
  { id: 'succeeded', label: 'Succeeded' },
  { id: 'failed', label: 'Failed' },
  { id: 'canceled', label: 'Canceled' },
];

function statusBucket(status: DeploymentStatus): StatusBucket {
  switch (status) {
    case 'queued':
    case 'running':
      return 'active';
    case 'success':
      return 'succeeded';
    case 'failed':
    case 'rolled_back':
      return 'failed';
    case 'canceled':
      return 'canceled';
  }
}

function isStatusFilter(value: string): value is StatusFilter {
  return STATUS_TABS.some((tab) => tab.id === value);
}

function parseView(search: string): View {
  const params = new URLSearchParams(search);
  const status = params.get('status') ?? '';
  return { q: params.get('q') ?? '', status: isStatusFilter(status) ? status : DEFAULT_VIEW.status };
}

function viewToSearch(view: View): string {
  const params = new URLSearchParams();
  if (view.q !== '') params.set('q', view.q);
  if (view.status !== DEFAULT_VIEW.status) params.set('status', view.status);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

function viewNarrows(view: View): boolean {
  return view.q !== DEFAULT_VIEW.q || view.status !== DEFAULT_VIEW.status;
}

/** What a deployment can be found by: which project it belongs to, and what it shipped. */
function searchHaystack(deployment: GlobalDeployment): string {
  return [deployment.projectName, deployment.projectSlug, deployment.commitSha ?? '', deployment.commitMessage ?? '']
    .join(' ')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DeploymentsPage() {
  const deploymentsQuery = useGlobalDeployments();
  const [, navigate] = useLocation();
  const search = useSearch();
  const searchRef = useRef<HTMLInputElement>(null);

  const view = parseView(search);
  const deployments = useMemo(() => deploymentsQuery.data ?? [], [deploymentsQuery.data]);

  const visible = useMemo(() => {
    const needle = view.q.trim().toLowerCase();
    return deployments.filter((deployment) => {
      if (view.status !== 'all' && statusBucket(deployment.status) !== view.status) return false;
      if (needle !== '' && !searchHaystack(deployment).includes(needle)) return false;
      return true;
    });
  }, [deployments, view.q, view.status]);

  const counts = useMemo(() => {
    const byBucket: Record<StatusBucket, number> = { active: 0, succeeded: 0, failed: 0, canceled: 0 };
    for (const deployment of deployments) byBucket[statusBucket(deployment.status)] += 1;
    return { all: deployments.length, ...byBucket };
  }, [deployments]);

  const inFlight = counts.active;

  function setView(next: Partial<View>): void {
    navigate(`/deployments${viewToSearch({ ...view, ...next })}`, { replace: true });
  }

  // `/` focuses search, as on the Projects list. Ignored while typing elsewhere or with a modifier
  // held, so it never eats a keystroke meant for something else.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement;
      const typing =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (typing) return;
      event.preventDefault();
      searchRef.current?.focus();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const showControls = deployments.length > 1;

  return (
    <div>
      <PageHeader
        title="Deployments"
        subtitle="Recent activity across all projects"
        actions={<LiveIndicator inFlight={inFlight} updatedAt={deploymentsQuery.dataUpdatedAt} fetching={deploymentsQuery.isFetching} />}
      />

      {deploymentsQuery.isPending ? (
        <DeploymentsTableShell>
          <DeploymentsSkeletonRows />
        </DeploymentsTableShell>
      ) : deploymentsQuery.isError ? (
        <p role="alert" className="text-sm text-danger">
          Could not load deployments.
        </p>
      ) : deployments.length === 0 ? (
        <DeploymentsEmptyState />
      ) : (
        <div className="flex flex-col gap-4">
          {showControls && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Tabs
                  tabs={STATUS_TABS.map((tab) => ({ id: tab.id, label: tab.label, count: counts[tab.id] }))}
                  value={view.status}
                  onChange={(id) => {
                    setView({ status: id as StatusFilter });
                  }}
                />

                {viewNarrows(view) && (
                  <p role="status" className="flex items-center gap-2 text-sm text-soft">
                    {visible.length} of {deployments.length}
                    <button
                      type="button"
                      onClick={() => {
                        setView(DEFAULT_VIEW);
                      }}
                      className="rounded font-medium text-link transition-colors duration-150 ease-out hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      Clear
                    </button>
                  </p>
                )}
              </div>

              <span className="relative block">
                <Search
                  size={16}
                  strokeWidth={ICON_STROKE}
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-icon"
                />
                <Input
                  ref={searchRef}
                  type="search"
                  placeholder="Search by project, commit, or message"
                  aria-label="Search deployments by project, commit SHA, or commit message"
                  value={view.q}
                  onChange={(event) => {
                    setView({ q: event.target.value });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && view.q !== '') {
                      event.preventDefault();
                      setView({ q: '' });
                    }
                  }}
                  className="pl-10"
                />
              </span>
            </>
          )}

          {visible.length === 0 ? (
            <EmptyState
              title="No matching deployments"
              message="Nothing here matches the current search and filters."
              action={{
                label: 'Clear filters',
                onClick: () => {
                  setView(DEFAULT_VIEW);
                },
              }}
            />
          ) : (
            <>
              <DeploymentsTableShell>
                {visible.map((deployment) => (
                  <DeploymentRow key={deployment.id} deployment={deployment} />
                ))}
              </DeploymentsTableShell>

              {deployments.length >= SERVER_LIMIT && (
                <p className="text-[13px] text-soft">
                  Showing the {SERVER_LIMIT} most recent deployments. Older ones are on each project&rsquo;s own
                  Deployments tab.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Says whether the page is currently watching something happen. Only claims "live" when there is
 * genuinely work in flight — a green light over a settled list would be decoration, and would make
 * the one case where it means something unreadable.
 *
 * When nothing is in flight it reports when the list was last refreshed instead, so a stale-looking
 * page can be told apart from a page that is simply up to date.
 */
function LiveIndicator({ inFlight, updatedAt, fetching }: { inFlight: number; updatedAt: number; fetching: boolean }) {
  // Re-renders on its own clock so "updated 40s ago" ages between polls, which on a settled list is
  // 30s apart.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setTick((value) => value + 1);
    }, 5_000);
    return () => {
      clearInterval(id);
    };
  }, []);

  if (inFlight > 0) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1.5 text-sm font-medium text-ink">
        <StatusDot status="warn" pulse />
        {inFlight} in flight
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2 text-sm text-soft">
      {fetching && <StatusDot status="idle" pulse />}
      {updatedAt === 0 ? 'Not loaded yet' : `Updated ${formatRelativeTime(updatedAt)}`}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/** The card, table and header row — shared with the loading skeleton so the two can't drift into
 * different column sets. `p-0` because a table's hairlines have to reach the card's edges. */
function DeploymentsTableShell({ children }: { children: ReactNode }) {
  return (
    <Card className="overflow-hidden p-0">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="px-4 py-2.5 text-xs font-medium tracking-wide text-soft uppercase">
              Project
            </th>
            <th scope="col" className="px-4 py-2.5 text-xs font-medium tracking-wide text-soft uppercase">
              Status
            </th>
            <th scope="col" className="hidden px-4 py-2.5 text-xs font-medium tracking-wide text-soft uppercase md:table-cell">
              Trigger
            </th>
            <th scope="col" className="hidden px-4 py-2.5 text-xs font-medium tracking-wide text-soft uppercase md:table-cell">
              Branch
            </th>
            <th scope="col" className="hidden px-4 py-2.5 text-xs font-medium tracking-wide text-soft uppercase lg:table-cell">
              Commit
            </th>
            <th scope="col" className="px-4 py-2.5 text-xs font-medium tracking-wide text-soft uppercase">
              Duration
            </th>
            <th scope="col" className="hidden px-4 py-2.5 text-xs font-medium tracking-wide text-soft uppercase sm:table-cell">
              Started
            </th>
            <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium tracking-wide text-soft uppercase">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </Card>
  );
}

function DeploymentRow({ deployment }: { deployment: GlobalDeployment }) {
  const href = `/projects/${String(deployment.projectId)}/deployments/${String(deployment.id)}`;
  const active = isPendingDeploymentStatus(deployment.status);

  return (
    <tr className="group h-14 transition-colors duration-150 ease-out hover:bg-surface-2">
      <td className="px-4">
        <Link
          href={`/projects/${String(deployment.projectId)}`}
          className="block truncate text-base font-semibold text-ink transition-colors duration-150 ease-out hover:text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {deployment.projectName}
        </Link>
        <span className="block truncate font-mono text-xs text-soft">{deployment.projectSlug}</span>
      </td>

      <td className="px-4">
        <span className="inline-flex items-center gap-2">
          {/* Pulses only while something is actually happening — `StatusDot` pulses `warn` by
              default, which is exactly queued and running. */}
          <StatusDot status={DOT_STATUS_BY_DEPLOY[deployment.status]} />
          <span className={`text-sm font-medium ${DEPLOY_STATUS_TEXT_CLASS[deployment.status]}`}>
            {DEPLOY_STATUS_LABEL[deployment.status]}
          </span>
        </span>
      </td>

      <td className="hidden px-4 md:table-cell">
        <Badge>{TRIGGER_LABEL[deployment.trigger]}</Badge>
      </td>

      <td className="hidden px-4 md:table-cell">
        <BranchLabel branch={deployment.branch} className="max-w-[12rem]" />
      </td>

      <td className="hidden max-w-[24rem] px-4 lg:table-cell">
        <span className="flex min-w-0 items-center gap-2">
          {deployment.commitSha && <Chip>{shortSha(deployment.commitSha)}</Chip>}
          <span className="truncate text-sm text-soft" title={deployment.commitMessage ?? undefined}>
            {deployment.commitMessage ?? 'no commit message'}
          </span>
        </span>
      </td>

      <td className="px-4">
        <DeploymentDuration deployment={deployment} />
      </td>

      <td className="hidden px-4 text-sm text-soft sm:table-cell">
        {deployment.startedAt !== null ? formatRelativeTime(deployment.startedAt) : 'not started'}
      </td>

      <td className="px-4">
        <div className="flex items-center justify-end gap-2">
          {active && <CancelButton deploymentId={deployment.id} />}
          <Link
            href={href}
            aria-label={`Open the deploy log for ${deployment.projectName}`}
            className="rounded text-icon opacity-60 transition-opacity duration-150 ease-out group-hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <ArrowRight size={18} strokeWidth={ICON_STROKE} aria-hidden />
          </Link>
        </div>
      </td>
    </tr>
  );
}

/**
 * Cancels a queued or running deploy from the list, without a trip to its log page.
 *
 * Stays in its "Canceling…" state rather than resetting: `POST /cancel` returns 202 (the queue has
 * been *asked* to stop), and for a running deploy the pipeline then unwinds. The next poll — 2s
 * away, since something is in flight — replaces the row with its terminal status, which is what
 * ends this button's life. Re-enabling in the meantime would just invite a second click that does
 * nothing.
 */
function CancelButton({ deploymentId }: { deploymentId: number }) {
  const queryClient = useQueryClient();
  const [clicked, setClicked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCancel() {
    setClicked(true);
    setError(null);
    try {
      await cancelDeployment(deploymentId);
      await queryClient.invalidateQueries({ queryKey: ['deployments-global'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel.');
      setClicked(false);
    }
  }

  if (error) {
    return (
      <span role="alert" className="text-xs text-danger">
        {error}
      </span>
    );
  }

  return (
    <Button variant="outline" size="sm" disabled={clicked} onClick={() => void handleCancel()}>
      {clicked ? 'Canceling…' : 'Cancel'}
    </Button>
  );
}

/**
 * `finishedAt - startedAt` once terminal, or a live elapsed time while the deploy is in flight.
 *
 * Ticks locally every second for both queued and running: how long something has been *waiting* is
 * as much a live number as how long it has been building, and a queue that is stuck is exactly what
 * a growing wait time reveals.
 */
function DeploymentDuration({ deployment }: { deployment: Pick<GlobalDeployment, 'status' | 'startedAt' | 'finishedAt'> }) {
  const live = isPendingDeploymentStatus(deployment.status);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [live]);

  if (deployment.status === 'running' && deployment.startedAt !== null) {
    return <span className="font-mono text-sm text-ink tabular-nums">{formatDuration(now - deployment.startedAt)}</span>;
  }
  if (deployment.status === 'queued') {
    return <span className="text-sm text-soft">Waiting…</span>;
  }
  if (deployment.startedAt !== null && deployment.finishedAt !== null) {
    return <span className="font-mono text-sm text-soft tabular-nums">{formatDuration(deployment.finishedAt - deployment.startedAt)}</span>;
  }
  return <span className="text-sm text-soft">&mdash;</span>;
}

// ---------------------------------------------------------------------------
// Empty state.
// ---------------------------------------------------------------------------

function DeploymentsEmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-line bg-surface px-8 py-14 text-center">
      <p className="max-w-md text-lg text-soft">No deployments yet. Deploy a project to see activity here.</p>
      <ButtonLink href="/projects" variant="secondary">
        View projects
      </ButtonLink>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton — the same columns as the real table, so nothing jumps when it fills.
// ---------------------------------------------------------------------------

function DeploymentsSkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3, 4].map((row) => (
        <tr key={row} className="h-14">
          <td className="px-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-1.5 h-3 w-20" />
          </td>
          <td className="px-4">
            <div className="flex items-center gap-2">
              <Skeleton className="h-2 w-2 rounded-full" />
              <Skeleton className="h-4 w-16" />
            </div>
          </td>
          <td className="hidden px-4 md:table-cell">
            <Skeleton className="h-6 w-16 rounded-full" />
          </td>
          <td className="hidden px-4 md:table-cell">
            <Skeleton className="h-4 w-20" />
          </td>
          <td className="hidden px-4 lg:table-cell">
            <Skeleton className="h-4 w-48" />
          </td>
          <td className="px-4">
            <Skeleton className="h-4 w-12" />
          </td>
          <td className="hidden px-4 sm:table-cell">
            <Skeleton className="h-4 w-16" />
          </td>
          <td className="px-4">
            <div className="flex justify-end">
              <Skeleton className="h-5 w-5 rounded" />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}
