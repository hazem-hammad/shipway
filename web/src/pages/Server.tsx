/**
 * Server page: host resource usage + shared service status (server/src/routes/server.ts's
 * `GET /api/server/stats`, backed by services/stats.ts's `getStats`). Polls every 10s
 * (`useServerStats`). Meters are DELIBERATELY not hero-metric cards per the task-25 controller
 * ruling — label left, thin bar center, value right in mono — this is a glance-at-a-glance ops
 * page, not a dashboard trying to impress.
 */
import { BerthLight, PageHeader, Skeleton, type BerthStatus } from '../components/ui';
import { useServerStats } from '../hooks';
import type { ServerStats } from '../api';

const UNIT_BERTH: Record<ServerStats['services'][number]['status'], BerthStatus> = {
  active: 'go',
  failed: 'stop',
  inactive: 'unknown',
  unknown: 'unknown',
};

function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${String(Math.round(mb))} MB`;
}

function formatGb(gb: number): string {
  return `${gb.toFixed(1)} GB`;
}

export default function ServerPage() {
  const statsQuery = useServerStats();

  return (
    <div>
      <PageHeader title="Server" />

      {statsQuery.isPending ? (
        <ServerSkeleton />
      ) : statsQuery.isError || !statsQuery.data ? (
        <p role="alert" className="text-sm text-stop">
          Could not load server stats.
        </p>
      ) : (
        <ServerStatsView stats={statsQuery.data} />
      )}
    </div>
  );
}

function ServerStatsView({ stats }: { stats: ServerStats }) {
  const cpuFraction = stats.cpu.cores > 0 ? Math.min(1, stats.cpu.load1 / stats.cpu.cores) : 0;
  const memFraction = stats.mem.totalMb > 0 ? Math.min(1, stats.mem.usedMb / stats.mem.totalMb) : 0;
  const diskFraction = stats.disk.totalGb > 0 ? Math.min(1, stats.disk.usedGb / stats.disk.totalGb) : 0;

  return (
    <div>
      <div className="flex max-w-[720px] flex-col gap-4">
        <MeterBar
          label="CPU"
          fraction={cpuFraction}
          valueText={`${stats.cpu.load1.toFixed(2)} load / ${String(stats.cpu.cores)} cores`}
        />
        <MeterBar label="Memory" fraction={memFraction} valueText={`${formatMb(stats.mem.usedMb)} / ${formatMb(stats.mem.totalMb)}`} />
        <MeterBar label="Disk" fraction={diskFraction} valueText={`${formatGb(stats.disk.usedGb)} / ${formatGb(stats.disk.totalGb)}`} />
      </div>

      <h2 className="mt-8 mb-3 text-sm font-semibold text-ink">Services</h2>
      <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
        {stats.services.map((service) => (
          <div key={service.unit} className="flex items-center gap-2 text-sm">
            <BerthLight status={UNIT_BERTH[service.status]} />
            <span className="text-ink">{service.name}</span>
            <span className="font-mono text-xs text-ink-soft">{service.unit}</span>
          </div>
        ))}
      </div>

      <p className="mt-8 font-mono text-xs text-ink-soft">Shipway v{stats.shipwayVersion}</p>
    </div>
  );
}

function MeterBar({ label, fraction, valueText }: { label: string; fraction: number; valueText: string }) {
  return (
    <div className="flex items-center gap-4">
      <span className="w-16 shrink-0 text-sm font-medium text-ink">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel">
        <div className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out" style={{ width: `${String(fraction * 100)}%` }} />
      </div>
      <span className="w-40 shrink-0 text-right font-mono text-xs text-ink-soft">{valueText}</span>
    </div>
  );
}

function ServerSkeleton() {
  return (
    <div>
      <div className="flex max-w-[720px] flex-col gap-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
      <div className="mt-8 grid gap-x-8 gap-y-2 sm:grid-cols-2">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-5 w-full" />
        ))}
      </div>
    </div>
  );
}
