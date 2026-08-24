/**
 * Settings > Instance: host resource usage + shared service status. Moved here from the standalone
 * Server page (Task 10 — the v2 sidebar has no Server item; this is the section's new home). Polls
 * every 10s (`useServerStats`). Meters are deliberately not hero-metric cards, carried forward from
 * the original Server page's ruling: label left, thin bar center, value right in mono — this is a
 * glance-at-a-glance ops view, not a dashboard trying to impress.
 */
import { Cpu, Server } from 'lucide-react';
import { Card, CardHeader, ICON_STROKE, Skeleton, StatusDot, type StatusDotStatus } from '../../components/ui';
import { useServerStats } from '../../hooks';
import type { ServerStats } from '../../api';

const UNIT_STATUS: Record<ServerStats['services'][number]['status'], StatusDotStatus> = {
  active: 'ok',
  failed: 'danger',
  inactive: 'idle',
  unknown: 'idle',
};

function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${String(Math.round(mb))} MB`;
}

function formatGb(gb: number): string {
  return `${gb.toFixed(1)} GB`;
}

export default function InstanceSection() {
  const statsQuery = useServerStats();

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader icon={<Cpu size={20} strokeWidth={ICON_STROKE} />} title="Resources" description="Live host usage, refreshed every 10 seconds." />
        <div className="mt-5">
          {statsQuery.isPending ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ) : statsQuery.isError || !statsQuery.data ? (
            <p role="alert" className="text-sm text-danger">
              Could not load server stats.
            </p>
          ) : (
            <ResourcesView stats={statsQuery.data} />
          )}
        </div>
      </Card>

      <Card>
        <CardHeader icon={<Server size={20} strokeWidth={ICON_STROKE} />} title="Services" description="Systemd units Shipway depends on." />
        <div className="mt-5">
          {statsQuery.isPending ? (
            <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((row) => (
                <Skeleton key={row} className="h-5 w-full" />
              ))}
            </div>
          ) : statsQuery.isError || !statsQuery.data ? (
            <p role="alert" className="text-sm text-danger">
              Could not load service status.
            </p>
          ) : (
            <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              {statsQuery.data.services.map((service) => (
                <div key={service.unit} className="flex items-center gap-2.5">
                  <StatusDot status={UNIT_STATUS[service.status]} />
                  <span className="text-base text-ink">{service.name}</span>
                  <span className="font-mono text-xs text-soft">{service.unit}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {statsQuery.data && <p className="font-mono text-xs text-soft">Shipway v{statsQuery.data.shipwayVersion}</p>}
    </div>
  );
}

function ResourcesView({ stats }: { stats: ServerStats }) {
  const cpuFraction = stats.cpu.cores > 0 ? Math.min(1, stats.cpu.load1 / stats.cpu.cores) : 0;
  const memFraction = stats.mem.totalMb > 0 ? Math.min(1, stats.mem.usedMb / stats.mem.totalMb) : 0;
  const diskFraction = stats.disk.totalGb > 0 ? Math.min(1, stats.disk.usedGb / stats.disk.totalGb) : 0;

  return (
    <div className="flex flex-col gap-4">
      <MeterRow label="CPU" fraction={cpuFraction} valueText={`${stats.cpu.load1.toFixed(2)} load / ${String(stats.cpu.cores)} cores`} />
      <MeterRow label="Memory" fraction={memFraction} valueText={`${formatMb(stats.mem.usedMb)} / ${formatMb(stats.mem.totalMb)}`} />
      <MeterRow label="Disk" fraction={diskFraction} valueText={`${formatGb(stats.disk.usedGb)} / ${formatGb(stats.disk.totalGb)}`} />
    </div>
  );
}

function MeterRow({ label, fraction, valueText }: { label: string; fraction: number; valueText: string }) {
  return (
    <div className="flex items-center gap-4">
      <span className="w-16 shrink-0 text-sm font-medium text-ink">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out" style={{ width: `${String(fraction * 100)}%` }} />
      </div>
      <span className="w-44 shrink-0 text-right font-mono text-xs text-soft">{valueText}</span>
    </div>
  );
}
