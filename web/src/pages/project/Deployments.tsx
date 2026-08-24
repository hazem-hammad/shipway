/**
 * Deployments tab (route "/", nested under ProjectLayout): the deploy history table plus the
 * Deploy button in the tab's own page-title row (DESIGN.md: "page title row (title + primary
 * action right-aligned)", same button as the Projects table's row action). Rollback uses an inline
 * confirm row expansion, never a modal (DESIGN.md bans modals).
 */
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  cancelDeployment,
  deployProject,
  isPendingDeploymentStatus,
  rollbackProject,
  type Deployment,
} from '../../api';
import { useDeployments } from '../../hooks';
import { StatusBadge } from '../../components/StatusBadge';
import { DurationText } from '../../components/Duration';
import { Button, Chip, EmptyState, PageHeader, Skeleton } from '../../components/ui';
import { formatRelativeTime, shortSha } from '../../lib/format';

const TABLE_COLUMN_COUNT = 7;

export default function DeploymentsTab({ projectId }: { projectId: number }) {
  const deploymentsQuery = useDeployments(projectId);
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  async function handleDeploy() {
    setDeployError(null);
    setDeploying(true);
    try {
      const { deploymentId } = await deployProject(projectId);
      await queryClient.invalidateQueries({ queryKey: ['deployments', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/deployments/${String(deploymentId)}`);
    } catch (err) {
      setDeployError(err instanceof ApiError ? err.message : 'Could not queue the deploy. Try again.');
    } finally {
      setDeploying(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Deployments"
        actions={
          <Button loading={deploying} onClick={() => void handleDeploy()}>
            Deploy
          </Button>
        }
      />

      {deployError && (
        <p role="alert" className="mb-4 text-sm text-stop">
          {deployError}
        </p>
      )}

      {deploymentsQuery.isPending ? (
        <TableSkeleton />
      ) : deploymentsQuery.isError ? (
        <p role="alert" className="text-sm text-stop">
          Could not load deployments.
        </p>
      ) : deploymentsQuery.data.length === 0 ? (
        <EmptyState message="No deployments yet. Deploy to see it stream here." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[880px] border-collapse text-left text-sm">
            <thead className="bg-panel text-xs font-medium text-ink-soft">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Trigger
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Commit
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Message
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Duration
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Started
                </th>
                <th scope="col" className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {deploymentsQuery.data.map((deployment) => (
                <DeploymentRow
                  key={deployment.id}
                  projectId={projectId}
                  deployment={deployment}
                  confirmingRollback={confirmingId === deployment.id}
                  onToggleRollback={() => setConfirmingId((current) => (current === deployment.id ? null : deployment.id))}
                  onRolledBack={(newId) => {
                    setConfirmingId(null);
                    navigate(`/deployments/${String(newId)}`);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
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
  onRolledBack: (deploymentId: number) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const pending = isPendingDeploymentStatus(deployment.status);
  const canRollback = deployment.status === 'success' && deployment.releasePath !== null;

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
      const { deploymentId } = await rollbackProject(projectId, deployment.releasePath);
      await queryClient.invalidateQueries({ queryKey: ['deployments', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      onRolledBack(deploymentId);
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : 'Could not roll back. Try again.');
      setBusy(false);
    }
  }

  return (
    <>
      <tr className="h-11">
        <td className="px-4 py-3">
          <StatusBadge status={deployment.status} />
        </td>
        <td className="px-4 py-3 text-ink-soft">{deployment.trigger}</td>
        <td className="px-4 py-3">
          {deployment.commitSha ? <Chip>{shortSha(deployment.commitSha)}</Chip> : <span className="text-ink-soft">not set</span>}
        </td>
        <td className="max-w-[280px] truncate px-4 py-3 text-ink-soft" title={deployment.commitMessage ?? undefined}>
          {deployment.commitMessage ?? 'not set'}
        </td>
        <td className="px-4 py-3">
          <DurationText deployment={deployment} />
        </td>
        <td className="px-4 py-3 text-ink-soft">{deployment.startedAt !== null ? formatRelativeTime(deployment.startedAt) : 'queued'}</td>
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-2">
            <Link
              href={`/deployments/${String(deployment.id)}`}
              className="rounded text-xs font-medium text-accent underline decoration-line underline-offset-2 hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              View log
            </Link>
            {pending && (
              <Button variant="destructive" className="px-2.5 py-1 text-xs" loading={busy} onClick={() => void handleCancel()}>
                Cancel
              </Button>
            )}
            {canRollback && (
              <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={onToggleRollback} disabled={busy}>
                Roll back
              </Button>
            )}
          </div>
        </td>
      </tr>
      {confirmingRollback && (
        <tr>
          <td colSpan={TABLE_COLUMN_COUNT} className="border-t border-line bg-panel/60 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink">
                Roll back to release <Chip>{releaseBasename(deployment.releasePath)}</Chip>? This restarts the app on that release.
              </p>
              <div className="flex items-center gap-2">
                <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={onToggleRollback} disabled={busy}>
                  Cancel
                </Button>
                <Button className="px-2.5 py-1 text-xs" loading={busy} onClick={() => void handleRollback()}>
                  Confirm
                </Button>
              </div>
            </div>
            {rowError && (
              <p role="alert" className="mt-2 text-xs text-stop">
                {rowError}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function releaseBasename(releasePath: string | null): string {
  if (!releasePath) return 'unknown';
  const segments = releasePath.split('/');
  return segments[segments.length - 1] || releasePath;
}

function TableSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="bg-panel px-4 py-3">
        <Skeleton className="h-3 w-32" />
      </div>
      <div className="divide-y divide-line">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex h-11 items-center gap-6 px-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
