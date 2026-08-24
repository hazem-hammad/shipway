/**
 * Deployments tab (route "/", nested under ProjectLayout): the deploy history, rows built the same
 * way as the global Deployments page (DESIGN.md's Tables & lists) — one Card of hairline-separated
 * rows. The Deploy button itself lives in ProjectLayout's header card now, not here. Rollback uses
 * an inline `--surface-2` confirm-row expansion, never a modal (DESIGN.md bans modals).
 */
import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import {
  ApiError,
  cancelDeployment,
  isPendingDeploymentStatus,
  rollbackProject,
  type Deployment,
  type DeploymentStatus,
} from '../../api';
import { useDeployments } from '../../hooks';
import { DurationText } from '../../components/Duration';
import { Button, Card, Chip, EmptyState, ICON_STROKE, Skeleton, StatusDot, type StatusDotStatus } from '../../components/ui';
import { formatRelativeTime, shortSha } from '../../lib/format';

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

const TRIGGER_LABEL: Record<Deployment['trigger'], string> = {
  push: 'push',
  manual: 'manual',
  rollback: 'rollback',
};

export default function DeploymentsTab({ projectId }: { projectId: number }) {
  const deploymentsQuery = useDeployments(projectId);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  return (
    <div>
      {deploymentsQuery.isPending ? (
        <Card>
          <DeploymentsSkeletonRows />
        </Card>
      ) : deploymentsQuery.isError ? (
        <p role="alert" className="text-sm text-danger">
          Could not load deployments.
        </p>
      ) : deploymentsQuery.data.length === 0 ? (
        <EmptyState message="No deployments yet. Hit Deploy above to see it stream here." />
      ) : (
        <Card>
          <div className="flex flex-col divide-y divide-line">
            {deploymentsQuery.data.map((deployment) => (
              <DeploymentRow
                key={deployment.id}
                projectId={projectId}
                deployment={deployment}
                confirmingRollback={confirmingId === deployment.id}
                onToggleRollback={() => setConfirmingId((current) => (current === deployment.id ? null : deployment.id))}
                onRolledBack={() => setConfirmingId(null)}
              />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function DeploymentRow({
  projectId,
  deployment,
  confirmingRollback,
  onToggleRollback,
  onRolledBack,
}: {
  projectId: number;
  deployment: Deployment;
  confirmingRollback: boolean;
  onToggleRollback: () => void;
  onRolledBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const pending = isPendingDeploymentStatus(deployment.status);
  const canRollback = deployment.status === 'success' && deployment.releasePath !== null;
  const dotStatus = DOT_STATUS_BY_DEPLOY[deployment.status];

  async function handleCancel() {
    setRowError(null);
    setBusy(true);
    try {
      await cancelDeployment(deployment.id);
      await queryClient.invalidateQueries({ queryKey: ['deployments', projectId] });
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : 'Could not cancel the deploy.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRollback() {
    if (!deployment.releasePath) return;
    setRowError(null);
    setBusy(true);
    try {
      await rollbackProject(projectId, deployment.releasePath);
      await queryClient.invalidateQueries({ queryKey: ['deployments', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      onRolledBack();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : 'Could not roll back. Try again.');
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-4 px-2 py-3">
        <div className="flex w-28 shrink-0 items-center gap-2">
          <StatusDot status={dotStatus} />
          <span className={`text-sm font-medium ${DEPLOY_STATUS_TEXT_CLASS[deployment.status]}`}>
            {DEPLOY_STATUS_LABEL[deployment.status]}
          </span>
        </div>

        <Chip>{TRIGGER_LABEL[deployment.trigger]}</Chip>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          {deployment.commitSha && <Chip>{shortSha(deployment.commitSha)}</Chip>}
          <span className="min-w-0 flex-1 truncate text-sm text-soft" title={deployment.commitMessage ?? undefined}>
            {deployment.commitMessage ?? 'no commit message'}
          </span>
        </div>

        <div className="hidden w-16 shrink-0 text-right sm:block">
          <DurationText deployment={deployment} />
        </div>

        <div className="hidden w-28 shrink-0 text-right text-xs text-soft md:block">
          {deployment.startedAt !== null ? formatRelativeTime(deployment.startedAt) : 'queued'}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Link
            href={`/deployments/${String(deployment.id)}`}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-ink transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            View log
            <ArrowRight size={14} strokeWidth={ICON_STROKE} aria-hidden />
          </Link>
          {pending && (
            <Button variant="danger" size="sm" loading={busy} onClick={() => void handleCancel()}>
              Cancel
            </Button>
          )}
          {canRollback && (
            <Button variant="secondary" size="sm" onClick={onToggleRollback} disabled={busy}>
              Roll back
            </Button>
          )}
        </div>
      </div>

      {confirmingRollback && (
        <div className="mx-2 mb-3 flex flex-col gap-2 rounded-xl bg-surface-2 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink">
              Roll back to release <Chip>{releaseBasename(deployment.releasePath)}</Chip>? This restarts the app on that release.
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={onToggleRollback} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" loading={busy} onClick={() => void handleRollback()}>
                Confirm
              </Button>
            </div>
          </div>
          {rowError && (
            <p role="alert" className="text-xs text-danger">
              {rowError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function releaseBasename(releasePath: string | null): string {
  if (!releasePath) return 'unknown';
  const segments = releasePath.split('/');
  return segments[segments.length - 1] || releasePath;
}

function DeploymentsSkeletonRows() {
  return (
    <div className="flex flex-col divide-y divide-line">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex h-14 items-center gap-4 px-2">
          <div className="flex w-28 shrink-0 items-center gap-2">
            <Skeleton className="h-2 w-2 rounded-full" />
            <Skeleton className="h-4 w-14" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-4 w-12 sm:block" />
        </div>
      ))}
    </div>
  );
}
