/**
 * A deployment's berth light plus its status word — the compact "how did the last deploy go" unit
 * used in the projects table (DESIGN.md: "berth light ... last deploy (status + relative time +
 * sha)") and reusable later for deployment rows, which get the same treatment per the Signature
 * section ("Used identically in: ... projects table, deployment rows, ...").
 */
import type { DeploymentStatus } from '../api';
import { BerthLight, type BerthStatus } from './ui';

const BERTH_BY_STATUS: Record<DeploymentStatus, BerthStatus> = {
  queued: 'hold',
  running: 'hold',
  success: 'go',
  failed: 'stop',
  rolled_back: 'go',
  canceled: 'unknown',
};

const LABEL_BY_STATUS: Record<DeploymentStatus, string> = {
  queued: 'queued',
  running: 'running',
  success: 'success',
  failed: 'failed',
  rolled_back: 'rolled back',
  canceled: 'canceled',
};

export interface StatusBadgeProps {
  /** `null` renders as "never deployed" in gray — a project with no deployments yet. */
  status: DeploymentStatus | null;
  className?: string;
}

export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  const berth = status ? BERTH_BY_STATUS[status] : 'unknown';
  const label = status ? LABEL_BY_STATUS[status] : 'never deployed';

  return (
    <span className={`inline-flex items-center gap-2 text-sm text-ink ${className}`}>
      <BerthLight status={berth} />
      {label}
    </span>
  );
}
