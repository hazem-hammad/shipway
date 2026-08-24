/**
 * A single deployment's log (route `/projects/:id/deployments/:deployId`, nested under
 * ProjectLayout) — the hero surface of the product (PRODUCT.md, strategic principle 1). While the
 * deployment is queued/running it tails `/api/deployments/:id/logs/stream` over a WebSocket;
 * once terminal, it fetches the full log once via `GET .../log` and stops. See LogTerminal for the
 * terminal panel's own rendering/auto-scroll rules and its fixed dark tokens (DESIGN.md).
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowLeft } from 'lucide-react';
import {
  ApiError,
  cancelDeployment,
  fetchDeploymentLog,
  isPendingDeploymentStatus,
  type Deployment,
  type DeploymentStatus,
} from '../../api';
import { useDeployment } from '../../hooks';
import { DurationText } from '../../components/Duration';
import { LogTerminal } from '../../components/LogTerminal';
import { Badge, Button, Card, Chip, ICON_STROKE, Skeleton, StatusDot, type StatusDotStatus } from '../../components/ui';
import { shortSha } from '../../lib/format';

export interface DeploymentLogProps {
  deploymentId: number;
}

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
  // Optimistic: flips true the instant Cancel is clicked, before the request even lands. Stays
  // true until either the server confirms it (deployment.cancelRequested, once the poll picks it
  // up) or the deployment goes terminal (the button/hint disappear entirely) — reset only on a
  // failed request, so the user can retry.
  const [cancelClicked, setCancelClicked] = useState(false);
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
    setCancelClicked(true);
    try {
      await cancelDeployment(deploymentId);
      await deploymentQuery.refetch();
    } catch (err) {
      setCancelError(err instanceof ApiError ? err.message : 'Could not cancel the deploy.');
      setCancelClicked(false);
    }
  }

  // Gated on the status being pending too: once the row goes terminal, `cancelClicked` may not have
  // been reset yet (nothing resets it on success) — without this it would show a stuck "canceling…"
  // hint/button forever.
  const canceling = isPendingDeploymentStatus(status) && (cancelClicked || (deploymentQuery.data?.cancelRequested ?? false));

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-soft transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <ArrowLeft size={16} strokeWidth={ICON_STROKE} aria-hidden />
        Deployments
      </Link>

      {deploymentQuery.isPending ? (
        <Skeleton className="h-16 w-full rounded-2xl" />
      ) : deploymentQuery.isError || !deploymentQuery.data ? (
        <p role="alert" className="text-sm text-danger">
          Could not load this deployment.
        </p>
      ) : (
        <DeploymentHeader deployment={deploymentQuery.data} canceling={canceling} onCancel={() => void handleCancel()} />
      )}

      {cancelError && (
        <p role="alert" className="text-sm text-danger">
          {cancelError}
        </p>
      )}

      <LogTerminal text={logText} className="overflow-hidden rounded-2xl" />
    </div>
  );
}

function DeploymentHeader({
  deployment,
  canceling,
  onCancel,
}: {
  deployment: Deployment;
  canceling: boolean;
  onCancel: () => void;
}) {
  // "Cancel button when running" (ruling) — read loosely as "still in flight", so a queued
  // deployment (not yet running) can also be canceled, matching the Deployments tab's own rule.
  const inFlight = isPendingDeploymentStatus(deployment.status);
  const dotStatus = DOT_STATUS_BY_DEPLOY[deployment.status];

  return (
    <Card className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusDot status={dotStatus} />
        <span className={`text-base font-semibold ${DEPLOY_STATUS_TEXT_CLASS[deployment.status]}`}>
          {DEPLOY_STATUS_LABEL[deployment.status]}
        </span>
        {canceling && <span className="text-sm text-soft">canceling…</span>}
        {deployment.commitSha && <Chip>{shortSha(deployment.commitSha)}</Chip>}
        <Badge>{TRIGGER_LABEL[deployment.trigger]}</Badge>
        <DurationText deployment={deployment} />
      </div>
      {inFlight && (
        <Button variant="danger" size="sm" loading={canceling} disabled={canceling} onClick={onCancel}>
          {canceling ? 'Canceling…' : 'Cancel'}
        </Button>
      )}
    </Card>
  );
}
