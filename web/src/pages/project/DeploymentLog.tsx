/**
 * A single deployment's log (route `/projects/:id/deployments/:deployId`, nested under
 * ProjectLayout) — the hero surface of the product (PRODUCT.md, strategic principle 1). While the
 * deployment is queued/running it tails `/api/deployments/:id/logs/stream` over a WebSocket;
 * once terminal, it fetches the full log once via `GET .../log` and stops. See LogTerminal for the
 * terminal panel's own rendering/auto-scroll rules.
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ApiError, cancelDeployment, fetchDeploymentLog, isPendingDeploymentStatus, type Deployment } from '../../api';
import { useDeployment } from '../../hooks';
import { StatusBadge } from '../../components/StatusBadge';
import { DurationText } from '../../components/Duration';
import { LogTerminal } from '../../components/LogTerminal';
import { Button, Chip, Skeleton } from '../../components/ui';
import { shortSha } from '../../lib/format';

export interface DeploymentLogProps {
  deploymentId: number;
}

/**
 * Appends one WebSocket chunk to the accumulated log text. The initial backlog chunk (the log
 * file's full contents so far) already ends in `\n`; each subsequent chunk is a single live line
 * with no trailing newline (see DeployLogger.line) — normalize both to exactly one `\n` per chunk
 * so the result always splits cleanly into lines.
 */
function appendChunk(prev: string, chunk: string): string {
  return prev + (chunk.endsWith('\n') ? chunk : `${chunk}\n`);
}

export default function DeploymentLogPage({ deploymentId }: DeploymentLogProps) {
  const deploymentQuery = useDeployment(deploymentId);
  const [logText, setLogText] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const status = deploymentQuery.data?.status;

  // Terminal deployments: fetch the finished log once. Non-terminal: tail it live over a socket,
  // and refetch the status snapshot when the socket closes (task-24 ruling) — the outer
  // `useDeployment` poll picks up any status the close itself didn't yet reflect.
  useEffect(() => {
    if (!status) return;

    if (!isPendingDeploymentStatus(status)) {
      let cancelled = false;
      void fetchDeploymentLog(deploymentId).then((res) => {
        if (!cancelled) setLogText(res.content);
      });
      return () => {
        cancelled = true;
      };
    }

    setLogText('');
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/api/deployments/${String(deploymentId)}/logs/stream`);

    socket.onmessage = (event) => {
      setLogText((prev) => appendChunk(prev, String(event.data)));
    };
    socket.onclose = () => {
      void deploymentQuery.refetch();
    };

    return () => {
      socket.close();
    };
    // deploymentQuery.refetch intentionally excluded: TanStack Query returns a stable function
    // reference for a given query key, and including it would re-run this effect on every render.
  }, [deploymentId, status]);

  async function handleCancel() {
    setCancelError(null);
    setCancelling(true);
    try {
      await cancelDeployment(deploymentId);
      await deploymentQuery.refetch();
    } catch (err) {
      setCancelError(err instanceof ApiError ? err.message : 'Could not cancel the deploy.');
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/"
        className="w-fit text-xs font-medium text-ink-soft underline decoration-line underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Deployments
      </Link>

      {deploymentQuery.isPending ? (
        <Skeleton className="h-12 w-full max-w-2xl" />
      ) : deploymentQuery.isError || !deploymentQuery.data ? (
        <p role="alert" className="text-sm text-stop">
          Could not load this deployment.
        </p>
      ) : (
        <DeploymentHeader deployment={deploymentQuery.data} cancelling={cancelling} onCancel={() => void handleCancel()} />
      )}

      {cancelError && (
        <p role="alert" className="text-sm text-stop">
          {cancelError}
        </p>
      )}

      <LogTerminal text={logText} />
    </div>
  );
}

function DeploymentHeader({
  deployment,
  cancelling,
  onCancel,
}: {
  deployment: Deployment;
  cancelling: boolean;
  onCancel: () => void;
}) {
  // "Cancel button when running" (ruling) — read loosely as "still in flight", so a queued
  // deployment (not yet running) can also be canceled, matching the Deployments tab's own rule.
  const inFlight = isPendingDeploymentStatus(deployment.status);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-paper px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={deployment.status} />
        <span className="text-xs text-ink-soft">{deployment.trigger}</span>
        {deployment.commitSha && <Chip>{shortSha(deployment.commitSha)}</Chip>}
        <DurationText deployment={deployment} />
      </div>
      {inFlight && (
        <Button variant="destructive" className="px-2.5 py-1 text-xs" loading={cancelling} onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}
