/**
 * The global Deployments page (route `/deployments`, DESIGN.md's Tables & lists + spec's "global
 * deployments"): recent deployments across every project, newest first, via `GET /api/deployments`
 * (Task 5). One card of hairline-separated 56px rows, composed entirely from `components/ui.tsx`
 * primitives, matching Projects.tsx's row anatomy and Home.tsx's (Task 6) compositional style. Each
 * row's primary navigation is a real stretched `<Link>` to that deployment's log on its owning
 * project (see DeploymentRow's doc comment).
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight } from 'lucide-react';
import type { DeploymentStatus, GlobalDeployment } from '../api';
import { useGlobalDeployments } from '../hooks';
import { formatDuration, formatRelativeTime, shortSha } from '../lib/format';
import { Badge, ButtonLink, Card, Chip, ICON_STROKE, PageHeader, Skeleton, StatusDot, type StatusDotStatus } from '../components/ui';

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

const TRIGGER_LABEL: Record<GlobalDeployment['trigger'], string> = {
  push: 'push',
  manual: 'manual',
  rollback: 'rollback',
};

export default function DeploymentsPage() {
  const deploymentsQuery = useGlobalDeployments();

  return (
    <div>
      <PageHeader title="Deployments" subtitle="Recent activity across all projects" />

      {deploymentsQuery.isPending ? (
        <Card>
          <DeploymentsSkeletonRows />
        </Card>
      ) : deploymentsQuery.isError ? (
        <p role="alert" className="text-sm text-danger">
          Could not load deployments.
        </p>
      ) : deploymentsQuery.data.length === 0 ? (
        <DeploymentsEmptyState />
      ) : (
        <Card>
          <div className="divide-y divide-line">
            {deploymentsQuery.data.map((deployment) => (
              <DeploymentRow key={deployment.id} deployment={deployment} />
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
 * `<Link>` (absolutely positioned, filling the row, `z-0`) so the whole row is keyboard- and
 * screen-reader-native (Enter activates it, cmd/ctrl-click opens a new tab) without a hand-rolled
 * `role="link"` + `onKeyDown` shim. Nothing else in this row is independently interactive, so
 * nothing needs to sit above it in the stacking order — see ProjectRow in Projects.tsx for the
 * same pattern with a secondary interactive element layered on top.
 */
function DeploymentRow({ deployment }: { deployment: GlobalDeployment }) {
  const dotStatus = DOT_STATUS_BY_DEPLOY[deployment.status];
  const href = `/projects/${String(deployment.projectId)}/deployments/${String(deployment.id)}`;

  return (
    <div className="group relative flex h-14 items-center gap-4 rounded-xl px-2 transition-colors duration-150 ease-out hover:bg-surface-2">
      <Link
        href={href}
        aria-label={`Open deployment for ${deployment.projectName}, ${DEPLOY_STATUS_LABEL[deployment.status]}`}
        className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      />

      <div className="flex w-24 shrink-0 items-center gap-2">
        <StatusDot status={dotStatus} />
        <span className={`text-sm font-medium ${DEPLOY_STATUS_TEXT_CLASS[deployment.status]}`}>
          {DEPLOY_STATUS_LABEL[deployment.status]}
        </span>
      </div>

      <div className="w-44 shrink-0">
        <div className="truncate text-lg font-semibold text-ink">{deployment.projectName}</div>
        <div className="truncate font-mono text-sm text-soft">{deployment.projectSlug}</div>
      </div>

      <Badge className="shrink-0">{TRIGGER_LABEL[deployment.trigger]}</Badge>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        {deployment.commitSha && <Chip>{shortSha(deployment.commitSha)}</Chip>}
        <span className="min-w-0 flex-1 truncate text-sm text-soft" title={deployment.commitMessage ?? undefined}>
          {deployment.commitMessage ?? 'no commit message'}
        </span>
      </div>

      <div className="hidden w-16 shrink-0 text-right sm:block">
        <DeploymentDuration deployment={deployment} />
      </div>

      <div className="hidden w-28 shrink-0 text-right text-xs text-soft md:block">
        {deployment.startedAt !== null ? formatRelativeTime(deployment.startedAt) : 'queued'}
      </div>

      <ArrowRight
        size={18}
        strokeWidth={ICON_STROKE}
        aria-hidden
        className="shrink-0 text-icon opacity-60 transition-opacity duration-150 ease-out group-hover:opacity-100"
      />
    </div>
  );
}

/** `finishedAt - startedAt` once terminal, or a ticking live elapsed time while running. */
function DeploymentDuration({ deployment }: { deployment: Pick<GlobalDeployment, 'status' | 'startedAt' | 'finishedAt'> }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deployment.status !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deployment.status]);

  if (deployment.status === 'running' && deployment.startedAt !== null) {
    return <span className="font-mono text-xs text-soft">{formatDuration(now - deployment.startedAt)}</span>;
  }
  if (deployment.startedAt !== null && deployment.finishedAt !== null) {
    return <span className="font-mono text-xs text-soft">{formatDuration(deployment.finishedAt - deployment.startedAt)}</span>;
  }
  return <span className="text-xs text-soft">not started</span>;
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
// Loading skeleton.
// ---------------------------------------------------------------------------

function DeploymentsSkeletonRows() {
  return (
    <div className="divide-y divide-line">
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex h-14 items-center gap-4 px-2">
          <div className="flex w-24 shrink-0 items-center gap-2">
            <Skeleton className="h-2 w-2 rounded-full" />
            <Skeleton className="h-4 w-14" />
          </div>
          <div className="w-44 shrink-0">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-1.5 h-3 w-20" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-4 w-12 sm:block" />
        </div>
      ))}
    </div>
  );
}
