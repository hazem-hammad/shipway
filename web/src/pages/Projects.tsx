/**
 * The Projects list (route `/projects`, DESIGN.md's Tables & lists): one card of hairline-separated
 * 56px rows — status dot, name + subdomain link, type badge, last-deploy meta, a row Deploy button,
 * and a ghosted chevron — composed entirely from `components/ui.tsx` primitives, matching Home.tsx's
 * (Task 6) compositional style. The row's primary navigation is a real stretched `<Link>` layered
 * behind the row's content; the subdomain link and the Deploy button are independently interactive
 * elements raised above it (see ProjectRow's doc comment).
 */
import { useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ExternalLink, Plus } from 'lucide-react';
import { ApiError, deployProject, type DeploymentStatus, type LastDeployment, type ProjectListItem, type ProjectType } from '../api';
import { useProjects, useSettings } from '../hooks';
import { formatRelativeTime, shortSha } from '../lib/format';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  Chip,
  ICON_STROKE,
  PageHeader,
  Skeleton,
  StatusDot,
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
  queued: 'queued',
  running: 'running',
  success: 'success',
  failed: 'failed',
  rolled_back: 'rolled back',
  canceled: 'canceled',
};

const DEPLOY_STATUS_TEXT_CLASS: Record<DeploymentStatus, string> = {
  queued: 'text-warn',
  running: 'text-warn',
  success: 'text-ok',
  failed: 'text-danger',
  rolled_back: 'text-ok',
  canceled: 'text-soft',
};

export default function ProjectsPage() {
  const projectsQuery = useProjects();
  const settingsQuery = useSettings();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const search = useSearch();
  const [deployingId, setDeployingId] = useState<number | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);

  const baseDomain = settingsQuery.data?.base_domain ?? null;
  const deletedSlug = new URLSearchParams(search).get('deleted');

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
        <Card>
          <ProjectsSkeletonRows />
        </Card>
      ) : projectsQuery.isError ? (
        <p role="alert" className="text-sm text-danger">
          Could not load projects.
        </p>
      ) : projectsQuery.data.length === 0 ? (
        <ProjectsEmptyState />
      ) : (
        <Card>
          <div className="divide-y divide-line">
            {projectsQuery.data.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                baseDomain={baseDomain}
                deploying={deployingId === project.id}
                onDeploy={() => void handleDeploy(project)}
              />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

/**
 * The row is a relative container with the primary navigation rendered as a real, stretched
 * `<Link>` (absolutely positioned, filling the row, `z-0`) instead of a hand-rolled
 * `role="link"` + `onKeyDown` div — that gives the row native keyboard behavior (Enter
 * activates it) and lets cmd/ctrl-click open it in a new tab, which the old click-handler
 * pattern couldn't. The subdomain link and the Deploy button are genuinely independent
 * interactive elements, so they're lifted above the stretched link with `relative z-10`
 * instead of the old `stopPropagation` dance.
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
    <div className="group relative flex h-14 items-center gap-4 rounded-xl px-2 transition-colors duration-150 ease-out hover:bg-surface-2">
      <Link
        href={href}
        aria-label={`Open ${project.name}`}
        className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      />

      <StatusDot status={dotStatus} />

      <div className="min-w-0 flex-1">
        <div className="truncate text-lg font-semibold text-ink">{project.name}</div>
        {baseDomain ? (
          <a
            href={`https://${project.slug}.${baseDomain}`}
            target="_blank"
            rel="noreferrer noopener"
            className="relative z-10 mt-0.5 inline-flex w-fit items-center gap-1 font-mono text-sm text-soft transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {project.slug}.{baseDomain}
            <ExternalLink size={12} strokeWidth={ICON_STROKE} aria-hidden />
          </a>
        ) : (
          <span className="mt-0.5 block font-mono text-sm text-soft">{project.slug}</span>
        )}
      </div>

      <Badge className="shrink-0">{PROJECT_TYPE_LABEL[project.type]}</Badge>

      <div className="hidden w-36 shrink-0 flex-col items-end gap-0.5 sm:flex">
        <LastDeployMeta lastDeployment={project.lastDeployment} />
      </div>

      <Button
        variant="secondary"
        size="sm"
        loading={deploying}
        className="relative z-10"
        onClick={() => onDeploy()}
      >
        Deploy
      </Button>

      <ArrowRight
        size={18}
        strokeWidth={ICON_STROKE}
        aria-hidden
        className="shrink-0 text-icon opacity-60 transition-opacity duration-150 ease-out group-hover:opacity-100"
      />
    </div>
  );
}

function LastDeployMeta({ lastDeployment }: { lastDeployment: LastDeployment | null }) {
  if (!lastDeployment) {
    return <span className="text-sm text-soft">Not deployed yet</span>;
  }

  return (
    <>
      <span className={`text-sm font-medium ${DEPLOY_STATUS_TEXT_CLASS[lastDeployment.status]}`}>
        {DEPLOY_STATUS_LABEL[lastDeployment.status]}
      </span>
      <span className="flex items-center gap-1.5 text-xs text-soft">
        {lastDeployment.finishedAt !== null && <span>{formatRelativeTime(lastDeployment.finishedAt)}</span>}
        {lastDeployment.commitSha && <Chip>{shortSha(lastDeployment.commitSha)}</Chip>}
      </span>
    </>
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
// Loading skeleton.
// ---------------------------------------------------------------------------

function ProjectsSkeletonRows() {
  return (
    <div className="divide-y divide-line">
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex h-14 items-center gap-4 px-2">
          <Skeleton className="h-2 w-2 rounded-full" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-1.5 h-3 w-28" />
          </div>
          <Skeleton className="h-6 w-14 rounded-full" />
          <Skeleton className="hidden h-8 w-24 sm:block" />
          <Skeleton className="h-8 w-16 rounded-xl" />
        </div>
      ))}
    </div>
  );
}
