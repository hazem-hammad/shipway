/**
 * The Projects list (route `/projects`).
 *
 * Built as a real `<table>` rather than the hairline row-list the rest of the app uses, because
 * this page answers questions *across* projects — which one deployed last, which are on a branch
 * that isn't main, which runtime a thing is — and comparing values down a column is what a table is
 * for. DESIGN.md has carried a `table header` type style (12px/500 uppercase `--text-soft`) since
 * v2 with nothing using it; this is that. Everything else stays inside the system: hairline row
 * separators, 56px rows, `--surface-2` hover, right-aligned meta, ghosted chevron.
 *
 * Real table markup, not a grid of divs, so the column headers are announced as headers and every
 * cell is associated with one. That costs the stretched whole-row link the old list used — a `<tr>`
 * is a poor positioning container — so the project name is the primary link instead, with the
 * trailing chevron as a second, larger target.
 *
 * Above it sits the find-things pattern from the Audit log (DESIGN.md §Audit log): status tabs with
 * count pills, then search and runtime filters. Sorting lives in the column headers, where a table
 * puts it. All of it is filtered client-side: `GET /api/projects` returns the whole list in one
 * unpaginated response, so narrowing it is a property of this view, not a new query.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, ArrowUp, ExternalLink, GitBranch, Plus, Search } from 'lucide-react';
import { ApiError, deployProject, type DeploymentStatus, type LastDeployment, type ProjectListItem, type ProjectType } from '../api';
import { useProjects, useSettings } from '../hooks';
import { formatRelativeTime, shortSha } from '../lib/format';
import { projectDomain } from '../../../server/src/lib/domain.js';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  Chip,
  EmptyState,
  ICON_STROKE,
  Input,
  PageHeader,
  Select,
  Skeleton,
  StatusDot,
  Tabs,
  type StatusDotStatus,
} from '../components/ui';

const PROJECT_TYPE_LABEL: Record<ProjectType, string> = {
  php: 'PHP',
  node: 'Node',
  nextjs: 'Next.js',
  static: 'Static',
};

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
  success: 'Deployed',
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

// ---------------------------------------------------------------------------
// View state
//
// Filters and sort live in the query string, not in component state: a narrowed list is then a link
// someone can send ("the failing ones"), it survives a reload and the Back button, and there is one
// source of truth to render from instead of two that can disagree.
// ---------------------------------------------------------------------------

/**
 * Which bucket a project falls in, by the outcome of its most recent deploy. Exhaustive on purpose:
 * every project lands in exactly one, so the tab counts add up to the total and nothing can be
 * invisible under every tab but All.
 *
 * `canceled` shares 'idle' with never-deployed — both mean the last attempt left nothing new
 * standing. That is not the same as never-deployed (an earlier release may still be serving), but
 * `lastDeployment` is the only history this endpoint returns, so a finer split would be a guess
 * dressed as a fact.
 */
type StatusBucket = 'live' | 'building' | 'failed' | 'idle';
type StatusFilter = StatusBucket | 'all';
type TypeFilter = ProjectType | 'all';
type SortKey = 'name' | 'type' | 'deployed' | 'created';
type SortDir = 'asc' | 'desc';

interface View {
  q: string;
  status: StatusFilter;
  type: TypeFilter;
  sort: SortKey;
  dir: SortDir;
}

const DEFAULT_VIEW: View = { q: '', status: 'all', type: 'all', sort: 'deployed', dir: 'desc' };

const STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'building', label: 'Building' },
  { id: 'failed', label: 'Failed' },
  { id: 'idle', label: 'Idle' },
];

// Deliberately terse: this control sits in a fixed, narrow slot beside the search box, and a
// `<select>` shows the *selected* label — so the longest one sets how wide it has to be. The
// column it filters is headed "Runtime" and the control carries an aria-label, so "All" is not
// ambiguous in context.
const TYPE_OPTIONS: { id: TypeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'php', label: 'PHP' },
  { id: 'node', label: 'Node' },
  { id: 'nextjs', label: 'Next.js' },
  { id: 'static', label: 'Static' },
];

/**
 * The table's columns, in render order. `sort` marks a column as clickable to sort by, and
 * `defaultDir` is the direction that column opens in — newest-first for dates, A-to-Z for text,
 * because that is the answer each one is usually being asked for.
 *
 * `hideBelow` drops a column on narrow viewports rather than letting the table scroll sideways:
 * project and last-deploy are the two that always earn their width.
 */
interface Column {
  id: string;
  label: string;
  sort?: SortKey;
  defaultDir?: SortDir;
  /** Tailwind responsive prefix at which this column appears; absent means always. */
  showFrom?: 'md' | 'lg' | 'xl';
  align?: 'right';
}

const COLUMNS: Column[] = [
  { id: 'project', label: 'Project', sort: 'name', defaultDir: 'asc' },
  { id: 'branch', label: 'Branch', showFrom: 'lg' },
  { id: 'runtime', label: 'Runtime', sort: 'type', defaultDir: 'asc', showFrom: 'md' },
  { id: 'deploy', label: 'Last deploy', sort: 'deployed', defaultDir: 'desc' },
  { id: 'created', label: 'Created', sort: 'created', defaultDir: 'desc', showFrom: 'xl' },
  { id: 'actions', label: '', align: 'right' },
];

/** `hidden md:table-cell` and friends — kept here so the header and body cells can never disagree
 * about which column is visible at which width. */
function columnVisibility(column: Column): string {
  if (!column.showFrom) return '';
  return { md: 'hidden md:table-cell', lg: 'hidden lg:table-cell', xl: 'hidden xl:table-cell' }[column.showFrom];
}

function isStatusFilter(value: string): value is StatusFilter {
  return STATUS_TABS.some((tab) => tab.id === value);
}

function isTypeFilter(value: string): value is TypeFilter {
  return TYPE_OPTIONS.some((option) => option.id === value);
}

function isSortKey(value: string): value is SortKey {
  return COLUMNS.some((column) => column.sort === value);
}

/** Reads the view out of the query string, falling back to the default for anything absent or
 * unrecognized — a hand-edited or stale URL sorts oddly at worst, never breaks the page. */
function parseView(search: string): View {
  const params = new URLSearchParams(search);
  const status = params.get('status') ?? '';
  const type = params.get('type') ?? '';
  const sort = params.get('sort') ?? '';
  const dir = params.get('dir') ?? '';
  return {
    q: params.get('q') ?? '',
    status: isStatusFilter(status) ? status : DEFAULT_VIEW.status,
    type: isTypeFilter(type) ? type : DEFAULT_VIEW.type,
    sort: isSortKey(sort) ? sort : DEFAULT_VIEW.sort,
    dir: dir === 'asc' || dir === 'desc' ? dir : DEFAULT_VIEW.dir,
  };
}

/**
 * The query string for `view`, omitting anything at its default so an untouched page keeps a clean
 * `/projects` URL. `deleted` (the post-delete confirmation) rides along because it belongs to the
 * navigation that landed here, not to the view.
 */
function viewToSearch(view: View, deletedSlug: string | null): string {
  const params = new URLSearchParams();
  if (deletedSlug !== null) params.set('deleted', deletedSlug);
  if (view.q !== '') params.set('q', view.q);
  if (view.status !== DEFAULT_VIEW.status) params.set('status', view.status);
  if (view.type !== DEFAULT_VIEW.type) params.set('type', view.type);
  if (view.sort !== DEFAULT_VIEW.sort || view.dir !== DEFAULT_VIEW.dir) {
    params.set('sort', view.sort);
    params.set('dir', view.dir);
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/** True when rows are being *hidden* — sorting reorders without hiding anything, so it doesn't
 * count toward "n of m" or arm the Clear button. */
function viewNarrows(view: View): boolean {
  return view.q !== DEFAULT_VIEW.q || view.status !== DEFAULT_VIEW.status || view.type !== DEFAULT_VIEW.type;
}

function statusBucket(project: ProjectListItem): StatusBucket {
  const last = project.lastDeployment;
  if (!last) return 'idle';
  switch (last.status) {
    case 'queued':
    case 'running':
      return 'building';
    case 'failed':
      return 'failed';
    // A rolled-back deploy left the previous release serving, so the site is up — the same reading
    // `DOT_STATUS_BY_DEPLOY` takes when it shows that row green.
    case 'success':
    case 'rolled_back':
      return 'live';
    case 'canceled':
      return 'idle';
  }
}

/** Everything a project can be found by: what it is called, where it is served, which branch ships,
 * and where the code comes from. */
function searchHaystack(project: ProjectListItem): string {
  return [project.name, project.slug, project.branch, project.repo, project.repoUrl ?? ''].join(' ').toLowerCase();
}

function sortProjects(rows: ProjectListItem[], sort: SortKey, dir: SortDir): ProjectListItem[] {
  const sign = dir === 'asc' ? 1 : -1;
  // A copy, because the array handed in belongs to the query cache.
  return [...rows].sort((a, b) => {
    switch (sort) {
      case 'name':
        return sign * a.name.localeCompare(b.name);
      case 'type':
        return sign * PROJECT_TYPE_LABEL[a.type].localeCompare(PROJECT_TYPE_LABEL[b.type]) || a.name.localeCompare(b.name);
      case 'created':
        return sign * (a.createdAt - b.createdAt);
      case 'deployed': {
        const at = a.lastDeployment?.finishedAt ?? null;
        const bt = b.lastDeployment?.finishedAt ?? null;
        // Never-deployed rows have no date to be ordered by, so they sit at the bottom in *both*
        // directions rather than flooding the top the moment the sort is flipped.
        if (at === null && bt === null) return a.name.localeCompare(b.name);
        if (at === null) return 1;
        if (bt === null) return -1;
        return sign * (at - bt);
      }
    }
  });
}

function applyView(projects: ProjectListItem[], view: View): ProjectListItem[] {
  const needle = view.q.trim().toLowerCase();
  const matched = projects.filter((project) => {
    if (view.status !== 'all' && statusBucket(project) !== view.status) return false;
    if (view.type !== 'all' && project.type !== view.type) return false;
    if (needle !== '' && !searchHaystack(project).includes(needle)) return false;
    return true;
  });
  return sortProjects(matched, view.sort, view.dir);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProjectsPage() {
  const projectsQuery = useProjects();
  const settingsQuery = useSettings();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const search = useSearch();
  const [deployingId, setDeployingId] = useState<number | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const baseDomain = settingsQuery.data?.base_domain ?? null;
  const deletedSlug = new URLSearchParams(search).get('deleted');
  const view = parseView(search);

  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const visible = useMemo(
    () => applyView(projects, view),
    [projects, view.q, view.status, view.type, view.sort, view.dir],
  );

  // Counts describe the whole list, not the filtered one — a tab has to say how much is behind it,
  // including the tab you are not currently standing on.
  const counts = useMemo(() => {
    const byBucket: Record<StatusBucket, number> = { live: 0, building: 0, failed: 0, idle: 0 };
    for (const project of projects) byBucket[statusBucket(project)] += 1;
    return { all: projects.length, ...byBucket };
  }, [projects]);

  function setView(next: Partial<View>): void {
    // `replace` so typing in the search box doesn't bury the previous page under one history entry
    // per keystroke; Back still leaves the list rather than undoing a search one letter at a time.
    navigate(`/projects${viewToSearch({ ...view, ...next }, deletedSlug)}`, { replace: true });
  }

  /** Clicking the column already sorted by flips its direction; any other column opens in the
   * direction that column is usually wanted in. */
  function toggleSort(column: Column): void {
    if (!column.sort) return;
    const sameColumn = view.sort === column.sort;
    setView({
      sort: column.sort,
      dir: sameColumn ? (view.dir === 'asc' ? 'desc' : 'asc') : (column.defaultDir ?? 'asc'),
    });
  }

  // `/` focuses search from anywhere on the page, the convention every list-with-a-search-box uses.
  // Ignored while typing elsewhere or while a modifier is held, so it never eats a keystroke meant
  // for something else.
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

  async function handleDeploy(project: ProjectListItem) {
    setDeployError(null);
    setDeployingId(project.id);
    try {
      const { deploymentId } = await deployProject(project.id);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/projects/${String(project.id)}/deployments/${String(deploymentId)}`);
    } catch (err) {
      setDeployError(err instanceof ApiError ? err.message : 'Could not queue the deploy. Try again.');
    } finally {
      setDeployingId(null);
    }
  }

  // The controls are only worth their space once there is something to narrow — a first project
  // shouldn't arrive behind a search box that can only ever find it.
  const showControls = projects.length > 1;

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Everything Shipway deploys from your repositories"
        actions={
          <ButtonLink href="/projects/new" variant="primary">
            <Plus size={18} strokeWidth={2} aria-hidden />
            New project
          </ButtonLink>
        }
      />

      {deletedSlug && (
        <p role="status" className="mb-4 flex items-center gap-2 text-sm text-ok">
          Project <Chip>{deletedSlug}</Chip> deleted.
        </p>
      )}

      {deployError && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {deployError}
        </p>
      )}

      {projectsQuery.isPending ? (
        <ProjectsTableShell>
          <ProjectsSkeletonRows />
        </ProjectsTableShell>
      ) : projectsQuery.isError ? (
        <p role="alert" className="text-sm text-danger">
          Could not load projects.
        </p>
      ) : projects.length === 0 ? (
        <ProjectsEmptyState />
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
                    {visible.length} of {projects.length}
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

              <div className="flex items-center gap-2">
                <span className="relative block min-w-0 flex-1">
                  <Search
                    size={16}
                    strokeWidth={ICON_STROKE}
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-icon"
                  />
                  <Input
                    ref={searchRef}
                    type="search"
                    placeholder="Search projects, domains, branches"
                    aria-label="Search projects by name, subdomain, branch, or repository"
                    value={view.q}
                    onChange={(event) => {
                      setView({ q: event.target.value });
                    }}
                    onKeyDown={(event) => {
                      // Escape clears rather than merely blurring, which is what an empty box is for.
                      if (event.key === 'Escape' && view.q !== '') {
                        event.preventDefault();
                        setView({ q: '' });
                      }
                    }}
                    className="pl-10"
                  />
                </span>

                {/* 128px: the field reserves 50px for its padding and chevron, leaving ~78px for
                    the widest label ("Next.js", ~60px at 16px) — narrow, without risking a clip. */}
                <div className="w-32 shrink-0">
                  <Select
                    aria-label="Filter by runtime"
                    value={view.type}
                    onChange={(event) => {
                      setView({ type: event.target.value as TypeFilter });
                    }}
                  >
                    {TYPE_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            </>
          )}

          {visible.length === 0 ? (
            <EmptyState
              title="No matching projects"
              message="Nothing here matches the current search and filters."
              action={{
                label: 'Clear filters',
                onClick: () => {
                  setView(DEFAULT_VIEW);
                },
              }}
            />
          ) : (
            <ProjectsTableShell sort={view.sort} dir={view.dir} onSort={toggleSort}>
              {visible.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  baseDomain={baseDomain}
                  deploying={deployingId === project.id}
                  onDeploy={() => void handleDeploy(project)}
                />
              ))}
            </ProjectsTableShell>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/**
 * The card, the `<table>`, and its header row — shared by the real list and the loading skeleton so
 * the two can't drift into different column sets. `onSort` absent (the skeleton) renders the
 * headers as plain labels rather than dead buttons.
 *
 * `p-0` on the card because the rows carry their own horizontal padding: a table's hairlines have
 * to reach the card's edges to read as row separators rather than as underlines floating in the
 * middle of it.
 */
function ProjectsTableShell({
  sort,
  dir,
  onSort,
  children,
}: {
  sort?: SortKey;
  dir?: SortDir;
  onSort?: (column: Column) => void;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            {COLUMNS.map((column) => {
              const active = onSort !== undefined && column.sort !== undefined && column.sort === sort;
              return (
                <th
                  key={column.id}
                  scope="col"
                  // `aria-sort` on the header is how a screen reader announces which column the
                  // table is ordered by, and which way.
                  aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={`px-4 py-2.5 text-xs font-medium tracking-wide text-soft uppercase ${
                    column.align === 'right' ? 'text-right' : ''
                  } ${columnVisibility(column)}`}
                >
                  {column.sort && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(column)}
                      className="inline-flex items-center gap-1 rounded text-xs font-medium tracking-wide uppercase transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      {column.label}
                      {active ? (
                        dir === 'asc' ? (
                          <ArrowUp size={12} strokeWidth={2} aria-hidden />
                        ) : (
                          <ArrowDown size={12} strokeWidth={2} aria-hidden />
                        )
                      ) : (
                        // A placeholder of the arrow's own width, so the label doesn't shift
                        // sideways the moment a column becomes the sorted one.
                        <span className="w-3" aria-hidden />
                      )}
                    </button>
                  ) : (
                    <span className={column.align === 'right' ? 'sr-only' : undefined}>{column.label || 'Actions'}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </Card>
  );
}

/**
 * One project. The name is the primary link rather than a stretched overlay across the row: a
 * `<tr>` is not a dependable positioning container, and a real link keeps cmd-click, middle-click
 * and Enter working without a hand-rolled key handler. The trailing chevron is the same
 * destination, as a second target for anyone aiming at the end of the row.
 */
function ProjectRow({
  project,
  baseDomain,
  deploying,
  onDeploy,
}: {
  project: ProjectListItem;
  baseDomain: string | null;
  deploying: boolean;
  onDeploy: () => void;
}) {
  const dotStatus: StatusDotStatus = project.lastDeployment ? DOT_STATUS_BY_DEPLOY[project.lastDeployment.status] : 'idle';
  const href = `/projects/${String(project.id)}`;

  return (
    <tr className="group h-14 transition-colors duration-150 ease-out hover:bg-surface-2">
      <td className="px-4">
        <div className="flex items-center gap-3">
          <StatusDot status={dotStatus} />
          <div className="min-w-0">
            <Link
              href={href}
              className="block truncate text-base font-semibold text-ink transition-colors duration-150 ease-out hover:text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {project.name}
            </Link>
            {baseDomain ? (
              <a
                href={`https://${projectDomain(project, baseDomain)}`}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-0.5 inline-flex w-fit max-w-full items-center gap-1 font-mono text-xs text-soft transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span className="truncate">
                  {projectDomain(project, baseDomain)}
                </span>
                <ExternalLink size={11} strokeWidth={ICON_STROKE} aria-hidden className="shrink-0" />
              </a>
            ) : (
              <span className="mt-0.5 block truncate font-mono text-xs text-soft">{project.slug}</span>
            )}
          </div>
        </div>
      </td>

      <td className="hidden px-4 lg:table-cell">
        <span className="inline-flex max-w-[12rem] items-center gap-1.5 font-mono text-sm text-soft">
          <GitBranch size={14} strokeWidth={ICON_STROKE} aria-hidden className="shrink-0" />
          <span className="truncate">{project.branch}</span>
        </span>
      </td>

      <td className="hidden px-4 md:table-cell">
        <Badge>{PROJECT_TYPE_LABEL[project.type]}</Badge>
      </td>

      <td className="px-4">
        <LastDeployCell lastDeployment={project.lastDeployment} />
      </td>

      <td className="hidden px-4 text-sm text-soft xl:table-cell">{formatRelativeTime(project.createdAt)}</td>

      <td className="px-4">
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" loading={deploying} onClick={() => onDeploy()}>
            Deploy
          </Button>
          <Link
            href={href}
            aria-label={`Open ${project.name}`}
            className="rounded text-icon opacity-60 transition-opacity duration-150 ease-out group-hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <ArrowRight size={18} strokeWidth={ICON_STROKE} aria-hidden />
          </Link>
        </div>
      </td>
    </tr>
  );
}

function LastDeployCell({ lastDeployment }: { lastDeployment: LastDeployment | null }) {
  if (!lastDeployment) {
    return <span className="text-sm text-soft">Never deployed</span>;
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className={`text-sm font-medium ${DEPLOY_STATUS_TEXT_CLASS[lastDeployment.status]}`}>
        {DEPLOY_STATUS_LABEL[lastDeployment.status]}
      </span>
      <span className="flex items-center gap-1.5 text-xs text-soft">
        {lastDeployment.finishedAt !== null && <span>{formatRelativeTime(lastDeployment.finishedAt)}</span>}
        {lastDeployment.commitSha && <Chip>{shortSha(lastDeployment.commitSha)}</Chip>}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state — the same CTA pair as Home's "Launch your first project".
// ---------------------------------------------------------------------------

function ProjectsEmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-line bg-surface px-8 py-14 text-center">
      <h2 className="text-2xl font-semibold text-ink">Launch your first project</h2>
      <p className="max-w-md text-lg text-soft">
        Connect a repository and Shipway builds it, ships it, and hands you a live URL in minutes.
      </p>
      <div className="mt-4 flex items-center gap-2.5">
        <ButtonLink href="/projects/new" variant="primary">
          Create project
        </ButtonLink>
        <ButtonLink href="/projects/new" variant="secondary">
          Import from GitHub
        </ButtonLink>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton — the same columns as the real table, so the layout doesn't jump when it fills.
// ---------------------------------------------------------------------------

function ProjectsSkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3, 4].map((row) => (
        <tr key={row} className="h-14">
          <td className="px-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-2 w-2 rounded-full" />
              <div>
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-1.5 h-3 w-28" />
              </div>
            </div>
          </td>
          <td className="hidden px-4 lg:table-cell">
            <Skeleton className="h-4 w-20" />
          </td>
          <td className="hidden px-4 md:table-cell">
            <Skeleton className="h-6 w-14 rounded-full" />
          </td>
          <td className="px-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-1.5 h-3 w-24" />
          </td>
          <td className="hidden px-4 xl:table-cell">
            <Skeleton className="h-4 w-16" />
          </td>
          <td className="px-4">
            <div className="flex justify-end">
              <Skeleton className="h-8 w-16 rounded-xl" />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}
