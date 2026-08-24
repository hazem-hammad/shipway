/**
 * A deployment's duration: `finishedAt - startedAt` once terminal, or a ticking live elapsed time
 * while running (task-24 controller ruling — used by both the Deployments table and the
 * DeploymentLog status header).
 */
import { useEffect, useState } from 'react';
import type { Deployment } from '../api';
import { formatDuration } from '../lib/format';

export interface DurationTextProps {
  deployment: Pick<Deployment, 'status' | 'startedAt' | 'finishedAt'>;
}

export function DurationText({ deployment }: DurationTextProps) {
  if (deployment.status === 'running' && deployment.startedAt !== null) {
    return <LiveDuration startedAt={deployment.startedAt} />;
  }
  if (deployment.startedAt !== null && deployment.finishedAt !== null) {
    return <span className="font-mono text-xs text-soft">{formatDuration(deployment.finishedAt - deployment.startedAt)}</span>;
  }
  return <span className="text-xs text-soft">not started</span>;
}

function LiveDuration({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return <span className="font-mono text-xs text-soft">{formatDuration(now - startedAt)}</span>;
}
