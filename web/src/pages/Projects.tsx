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
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ExternalLink, Folder as FolderIcon, FolderPlus, GitBranch, Plus, Search } from 'lucide-react';
import {
  ApiError,
  createFolder,
  deleteFolder,
  deployProject,
  patchProject,
  renameFolder,
  type DeploymentStatus,
  type Folder,
  type LastDeployment,
  type ProjectListItem,
  type ProjectType,
} from '../api';
import { useFolders, useIsAdmin, useProjects, useSettings } from '../hooks';
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
  IconChip,
  Input,
  PageHeader,
  SectionLabel,
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
  /**
   * The open folder's slug, `''` for the top level. In the query string with the rest of the view
   * because it is the same kind of thing — a link that opens the page already narrowed — but it is
   * NAVIGATION rather than a filter: it doesn't count toward `viewNarrows`, and Clear leaves it
   * alone, because clearing filters inside a folder should not also throw you out of the folder.
   */
  folder: string;
}

const DEFAULT_VIEW: View = { q: '', status: 'all', type: 'all', sort: 'deployed', dir: 'desc', folder: '' };

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
  { id: 'folder', label: 'Folder', showFrom: 'lg' },
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
    folder: params.get('folder') ?? '',
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
  if (view.folder !== '') params.set('folder', view.folder);
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
  const foldersQuery = useFolders();
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const search = useSearch();
  const [deployingId, setDeployingId] = useState<number | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Folder editing state. All of it is transient UI — the folders themselves live in the query
  // cache — so it is plain `useState` rather than anything in the URL.
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingFolder, setRenamingFolder] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmingFolderDelete, setConfirmingFolderDelete] = useState(false);

  const baseDomain = settingsQuery.data?.base_domain ?? null;
  const deletedSlug = new URLSearchParams(search).get('deleted');
  const view = parseView(search);

  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const folders = useMemo(() => foldersQuery.data ?? [], [foldersQuery.data]);

  const activeFolder = folders.find((folder) => folder.slug === view.folder) ?? null;
  /** `?folder=` names something that isn't there — deleted, or a bad link. Only once the list has
   * actually loaded, so the real folder view doesn't flash "not found" on the way in. */
  const folderMissing = view.folder !== '' && activeFolder === null && foldersQuery.isSuccess;

  /**
   * A search at the top level looks through EVERYTHING, folders included: a box that says "search
   * projects" and then silently omits the ones that happen to be filed away is a box that lies.
   * Inside a folder the search stays inside it, which is what the folder was opened for.
   */
  const searchingAll = activeFolder === null && view.q.trim() !== '';

  /**
   * Which projects this page is about right now. The top level lists the UNGROUPED ones under the
   * folder cards — a foldered project is represented by its card, and listing it twice would make
   * the counts on the page disagree with each other.
   */
  const scope = useMemo(() => {
    if (activeFolder !== null) return projects.filter((project) => project.folderId === activeFolder.id);
    if (searchingAll) return projects;
    return projects.filter((project) => project.folderId === null);
  }, [projects, activeFolder, searchingAll]);

  const visible = useMemo(
    () => applyView(scope, view),
    [scope, view.q, view.status, view.type, view.sort, view.dir],
  );

  // Counts describe the whole scope, not the filtered one — a tab has to say how much is behind it,
  // including the tab you are not currently standing on.
  const counts = useMemo(() => {
    const byBucket: Record<StatusBucket, number> = { live: 0, building: 0, failed: 0, idle: 0 };
    for (const project of scope) byBucket[statusBucket(project)] += 1;
    return { all: scope.length, ...byBucket };
  }, [scope]);

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

  /** Every folder mutation ends the same way: both lists are stale (a project's `folderId` and a
   * folder's `projectCount` are two views of one fact), so both are refetched together. */
  async function refreshFolders(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['projects'] }),
      queryClient.invalidateQueries({ queryKey: ['folders'] }),
    ]);
  }

  function folderErrorMessage(err: unknown, fallback: string): string {
    return err instanceof ApiError ? err.message : fallback;
  }

  async function handleCreateFolder(): Promise<void> {
    const name = newFolderName.trim();
    if (name === '') return;
    setFolderError(null);
    setFolderBusy(true);
    try {
      const created = await createFolder(name);
      await refreshFolders();
      setCreatingFolder(false);
      setNewFolderName('');
      // Straight into the new folder: it is empty, and the next thing anyone wants is to put
      // something in it.
      setView({ folder: created.slug });
    } catch (err) {
      setFolderError(folderErrorMessage(err, 'Could not create the folder.'));
    } finally {
      setFolderBusy(false);
    }
  }

  async function handleRenameFolder(folder: Folder): Promise<void> {
    const name = renameDraft.trim();
    if (name === '' || name === folder.name) {
      setRenamingFolder(false);
      return;
    }
    setFolderError(null);
    setFolderBusy(true);
    try {
      await renameFolder(folder.id, name);
      await refreshFolders();
      setRenamingFolder(false);
    } catch (err) {
      setFolderError(folderErrorMessage(err, 'Could not rename the folder.'));
    } finally {
      setFolderBusy(false);
    }
  }

  async function handleDeleteFolder(folder: Folder): Promise<void> {
    setFolderError(null);
    setFolderBusy(true);
    try {
      await deleteFolder(folder.id);
      await refreshFolders();
      setConfirmingFolderDelete(false);
      setView({ folder: '' });
    } catch (err) {
      setFolderError(folderErrorMessage(err, 'Could not delete the folder.'));
    } finally {
      setFolderBusy(false);
    }
  }

  async function handleMoveProject(project: ProjectListItem, folderId: number | null): Promise<void> {
    setFolderError(null);
    setFolderBusy(true);
    try {
      await patchProject(project.id, { folderId });
      await refreshFolders();
    } catch (err) {
      setFolderError(folderErrorMessage(err, `Could not move ${project.name}.`));
    } finally {
      setFolderBusy(false);
    }
  }

  /** Clearing filters must not also close the folder — see `View.folder`. */
  function clearFilters(): void {
    setView({ ...DEFAULT_VIEW, folder: view.folder });
  }

  // The controls are only worth their space once there is something to narrow — a first project
  // shouldn't arrive behind a search box that can only ever find it.
  //
  // At the top level that test is against EVERY project, not just the ungrouped ones: with one
  // project loose and five filed away, a scope-only test would take the search box away precisely
  // when it is the only way to reach the other five without opening folders one at a time.
  const showControls = scope.length > 1 || (activeFolder === null && projects.length > 1);

  /** Cards belong to the top level only: inside a folder the page is already about one of them. */
  const showFolderGrid = activeFolder === null && !searchingAll && (folders.length > 0 || creatingFolder);

  const newProjectButton = (
    <ButtonLink href="/projects/new" variant="primary">
      <Plus size={18} strokeWidth={2} aria-hidden />
      New project
    </ButtonLink>
  );

  return (
    <div>
      {activeFolder !== null ? (
        <FolderHeader
          folder={activeFolder}
          projectCount={scope.length}
          canManage={isAdmin}
          busy={folderBusy}
          renaming={renamingFolder}
          renameDraft={renameDraft}
          confirmingDelete={confirmingFolderDelete}
          onRenameStart={() => {
            setRenameDraft(activeFolder.name);
            setRenamingFolder(true);
          }}
          onRenameDraftChange={setRenameDraft}
          onRenameCancel={() => {
            setRenamingFolder(false);
          }}
          onRenameSubmit={() => void handleRenameFolder(activeFolder)}
          onDeleteRequest={() => {
            setConfirmingFolderDelete(true);
          }}
          onDeleteCancel={() => {
            setConfirmingFolderDelete(false);
          }}
          onDeleteConfirm={() => void handleDeleteFolder(activeFolder)}
          actions={newProjectButton}
        />
      ) : (
        <PageHeader
          title="Projects"
          subtitle="Everything Shipway deploys from your repositories"
          actions={
            <>
              {isAdmin && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setNewFolderName('');
                    setCreatingFolder(true);
                  }}
                >
                  <FolderPlus size={18} strokeWidth={2} aria-hidden />
                  New folder
                </Button>
              )}
              {newProjectButton}
            </>
          }
        />
      )}

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

      {folderError && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {folderError}
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
      ) : folderMissing ? (
        <EmptyState
          title="That folder is gone"
          message="It may have been deleted. The projects that were in it are safe — they are back in the ungrouped list."
          action={{
            label: 'All projects',
            onClick: () => {
              setView({ folder: '' });
            },
          }}
        />
      ) : projects.length === 0 ? (
        <ProjectsEmptyState />
      ) : (
        <div className="flex flex-col gap-4">
          {showFolderGrid && (
            <FolderGrid
              folders={folders}
              projects={projects}
              creating={creatingFolder}
              draft={newFolderName}
              busy={folderBusy}
              onDraftChange={setNewFolderName}
              onSubmit={() => void handleCreateFolder()}
              onCancel={() => {
                setCreatingFolder(false);
                setNewFolderName('');
              }}
            />
          )}

          {showFolderGrid && (
            <SectionLabel className="mt-2">Ungrouped{scope.length > 0 ? ` · ${String(scope.length)}` : ''}</SectionLabel>
          )}

          {searchingAll && (
            <p role="status" className="text-sm text-soft">
              Searching every project, folders included.
            </p>
          )}

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
                    {visible.length} of {scope.length}
                    <button
                      type="button"
                      onClick={clearFilters}
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
            viewNarrows(view) ? (
              <EmptyState
                title="No matching projects"
                message="Nothing here matches the current search and filters."
                action={{ label: 'Clear filters', onClick: clearFilters }}
              />
            ) : activeFolder !== null ? (
              <EmptyState
                title={`Nothing in ${activeFolder.name} yet`}
                message="Put a project in this folder with the Folder column on the projects list, or create one straight into it."
                action={{
                  label: 'All projects',
                  onClick: () => {
                    setView({ folder: '' });
                  },
                }}
              />
            ) : (
              <EmptyState
                title="Everything is in a folder"
                message="No ungrouped projects left — open a folder above to see what is in it."
              />
            )
          ) : (
            <ProjectsTableShell sort={view.sort} dir={view.dir} onSort={toggleSort}>
              {visible.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  baseDomain={baseDomain}
                  folders={folders}
                  folderBusy={folderBusy}
                  deploying={deployingId === project.id}
                  onDeploy={() => void handleDeploy(project)}
                  onMove={(folderId) => void handleMoveProject(project, folderId)}
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
  folders,
  folderBusy,
  deploying,
  onDeploy,
  onMove,
}: {
  project: ProjectListItem;
  baseDomain: string | null;
  folders: Folder[];
  folderBusy: boolean;
  deploying: boolean;
  onDeploy: () => void;
  onMove: (folderId: number | null) => void;
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

      {/* Filing a project is a one-control job, so it is the control itself in the cell rather than
          a label you have to click through to a menu to change. A native select: the list is short,
          and it comes with keyboard and touch behaviour that a hand-rolled menu would have to
          reimplement. */}
      <td className="hidden px-4 lg:table-cell">
        <div className="w-40">
          <Select
            aria-label={`Folder for ${project.name}`}
            value={project.folderId === null ? '' : String(project.folderId)}
            disabled={folderBusy}
            onChange={(event) => {
              const next = event.target.value;
              onMove(next === '' ? null : Number(next));
            }}
            className="h-9 py-0 text-sm"
          >
            <option value="">No folder</option>
            {folders.map((folder) => (
              <option key={folder.id} value={String(folder.id)}>
                {folder.name}
              </option>
            ))}
          </Select>
        </div>
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

// ---------------------------------------------------------------------------
// Folders
//
// A folder is one product — "brandspace" is a backend, a dashboard and a marketing site, three
// repos with three subdomains that the flat list could only ever show as three unrelated rows.
// The cards are the top level of the page and each one opens to `?folder=<slug>`, so a folder is a
// link someone can send, and the table underneath keeps doing what it did for what is left over.
// ---------------------------------------------------------------------------

/** The card grid, plus the new-folder card when one is being made. */
function FolderGrid({
  folders,
  projects,
  creating,
  draft,
  busy,
  onDraftChange,
  onSubmit,
  onCancel,
}: {
  folders: Folder[];
  projects: ProjectListItem[];
  creating: boolean;
  draft: string;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {folders.map((folder) => (
        <FolderCard key={folder.id} folder={folder} projects={projects.filter((project) => project.folderId === folder.id)} />
      ))}
      {creating && <NewFolderCard draft={draft} busy={busy} onDraftChange={onDraftChange} onSubmit={onSubmit} onCancel={onCancel} />}
    </div>
  );
}

/**
 * One folder. The dots are the same `StatusDot` the rows use, one per project, so a folder reports
 * the health of what is inside it at a glance — which is the question a product-level card is
 * actually being asked. Capped at eight with a `+n`, because past that the dots stop being
 * countable and start being texture.
 */
function FolderCard({ folder, projects }: { folder: Folder; projects: ProjectListItem[] }) {
  const shown = projects.slice(0, 8);
  const overflow = projects.length - shown.length;
  const lastDeployedAt = projects.reduce<number | null>((latest, project) => {
    const at = project.lastDeployment?.finishedAt ?? null;
    if (at === null) return latest;
    return latest === null || at > latest ? at : latest;
  }, null);

  return (
    <Link
      href={`/projects?folder=${encodeURIComponent(folder.slug)}`}
      className="group block rounded-xl border border-line bg-surface p-4 transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconChip size={36}>
            <FolderIcon size={18} strokeWidth={ICON_STROKE} />
          </IconChip>
          <div className="min-w-0">
            <span className="block truncate text-base font-semibold text-ink transition-colors duration-150 ease-out group-hover:text-link">
              {folder.name}
            </span>
            <span className="block text-xs text-soft">
              {projects.length} {projects.length === 1 ? 'project' : 'projects'}
            </span>
          </div>
        </div>
        <ArrowRight
          size={18}
          strokeWidth={ICON_STROKE}
          aria-hidden
          className="mt-1 shrink-0 text-icon opacity-60 transition-opacity duration-150 ease-out group-hover:opacity-100"
        />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5">
          {shown.map((project) => (
            <StatusDot
              key={project.id}
              status={project.lastDeployment ? DOT_STATUS_BY_DEPLOY[project.lastDeployment.status] : 'idle'}
              label={project.name}
            />
          ))}
          {overflow > 0 && <span className="text-xs text-soft">+{overflow}</span>}
          {projects.length === 0 && <span className="text-xs text-soft">Empty</span>}
        </span>
        {lastDeployedAt !== null && <span className="text-xs text-soft">{formatRelativeTime(lastDeployedAt)}</span>}
      </div>
    </Link>
  );
}

/** The new-folder card: the same footprint as a real one, so the grid doesn't reflow when it
 * appears. Submitting on Enter and cancelling on Escape, because it is one field. */
function NewFolderCard({
  draft,
  busy,
  onDraftChange,
  onSubmit,
  onCancel,
}: {
  draft: string;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="rounded-xl border border-line border-dashed bg-surface p-4"
    >
      <label className="block text-xs font-medium tracking-wide text-soft uppercase" htmlFor="new-folder-name">
        New folder
      </label>
      <Input
        id="new-folder-name"
        autoFocus
        required
        maxLength={60}
        value={draft}
        placeholder="Brandspace"
        onChange={(event) => {
          onDraftChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        className="mt-2"
      />
      <div className="mt-3 flex items-center gap-2">
        <Button type="submit" size="sm" loading={busy} disabled={draft.trim() === ''}>
          Create
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The page header when a folder is open. Its own component rather than `PageHeader` because the
 * title has to become an input while renaming, and because the way back out belongs above the
 * title where a breadcrumb goes.
 *
 * Deleting is a two-click confirm rather than a typed one (the pattern `Danger.tsx` uses for a
 * project): a folder holds no data of its own and its projects survive it, so the cost of an
 * accidental click is re-making a folder, not losing anything.
 */
function FolderHeader({
  folder,
  projectCount,
  canManage,
  busy,
  renaming,
  renameDraft,
  confirmingDelete,
  onRenameStart,
  onRenameDraftChange,
  onRenameCancel,
  onRenameSubmit,
  onDeleteRequest,
  onDeleteCancel,
  onDeleteConfirm,
  actions,
}: {
  folder: Folder;
  projectCount: number;
  canManage: boolean;
  busy: boolean;
  renaming: boolean;
  renameDraft: string;
  confirmingDelete: boolean;
  onRenameStart: () => void;
  onRenameDraftChange: (value: string) => void;
  onRenameCancel: () => void;
  onRenameSubmit: () => void;
  onDeleteRequest: () => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: () => void;
  actions: ReactNode;
}) {
  return (
    <div className="mb-8">
      <Link
        href="/projects"
        className="inline-flex items-center gap-1.5 rounded text-sm text-soft transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <ArrowLeft size={14} strokeWidth={ICON_STROKE} aria-hidden />
        All projects
      </Link>

      <div className="mt-2 flex items-start justify-between gap-4">
        <div className="min-w-0">
          {renaming ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onRenameSubmit();
              }}
              className="flex flex-wrap items-center gap-2"
            >
              <Input
                autoFocus
                required
                maxLength={60}
                aria-label="Folder name"
                value={renameDraft}
                onChange={(event) => {
                  onRenameDraftChange(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    onRenameCancel();
                  }
                }}
                className="w-64"
              />
              <Button type="submit" size="sm" loading={busy}>
                Save
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={onRenameCancel}>
                Cancel
              </Button>
            </form>
          ) : (
            <h1 className="truncate text-3xl font-semibold text-ink">{folder.name}</h1>
          )}
          <p className="mt-1 text-lg text-soft">
            {projectCount} {projectCount === 1 ? 'project' : 'projects'} in this folder
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canManage &&
            !renaming &&
            (confirmingDelete ? (
              <>
                <Button variant="danger" size="sm" loading={busy} onClick={onDeleteConfirm}>
                  Delete folder
                </Button>
                <Button variant="outline" size="sm" onClick={onDeleteCancel}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" size="sm" onClick={onRenameStart}>
                  Rename
                </Button>
                <Button variant="outline" size="sm" onClick={onDeleteRequest}>
                  Delete
                </Button>
              </>
            ))}
          {actions}
        </div>
      </div>

      {confirmingDelete && (
        <p role="status" className="mt-3 text-sm text-soft">
          The {projectCount} {projectCount === 1 ? 'project' : 'projects'} in this folder will go back to ungrouped. Nothing is deleted.
        </p>
      )}
    </div>
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
