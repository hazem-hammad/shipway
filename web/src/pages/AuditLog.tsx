/**
 * Audit log (route `/audit`, server/src/routes/audit.ts, Task 5): every mutating action recorded in
 * this workspace, filterable by category tab, free-text search, actor, and time range, with cursor
 * pagination ("Load more"). Right rail: admin-gated recording toggle + retention window
 * (`GET`/`PUT /api/audit/config`).
 *
 * `ACTION_SENTENCES` below has one entry per action string any `recordAudit` call site in the server
 * currently emits (see `server/src/routes/audit.ts`'s own module doc comment for the authoritative
 * namespace list this must stay in sync with). An action introduced later without an entry here still
 * renders — `actionSentence` falls back to the raw "<actor> <action> <target>" form — it just won't
 * read as a proper sentence until this map is extended.
 */
import { type ComponentType, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Bell,
  ClipboardList,
  Database as DatabaseIcon,
  FolderGit2,
  GitBranch,
  KeyRound,
  Rocket,
  Search,
  Settings as SettingsIcon,
  Users as UsersIcon,
} from 'lucide-react';
import { ApiError, fetchAudit, putAuditConfig, type AuditCategory, type AuditConfig, type AuditEvent } from '../api';
import { useAuditConfig, useIsAdmin, useUsers } from '../hooks';
import { Button, Card, CardHeader, Chip, EmptyState, ICON_STROKE, IconChip, Input, PageHeader, PageWithRail, Select, Skeleton, Tabs, Toggle } from '../components/ui';
import { formatRelativeTime } from '../lib/format';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const CATEGORY_TABS: { id: AuditCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'deployments', label: 'Deployments' },
  { id: 'projects', label: 'Projects' },
  { id: 'databases', label: 'Databases' },
  { id: 'team', label: 'Team' },
  { id: 'settings', label: 'Settings' },
];

const TIME_PRESETS = [
  { id: 'all', label: 'All time' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
] as const;
type TimePreset = (typeof TIME_PRESETS)[number]['id'];
const PRESET_MS: Record<Exclude<TimePreset, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const EMPTY_COUNTS: Record<AuditCategory, number> = { all: 0, deployments: 0, projects: 0, databases: 0, team: 0, settings: 0 };

// ---------------------------------------------------------------------------
// Category icon chips — keyed by the action's namespace (token before the first '.').
// ---------------------------------------------------------------------------

const NAMESPACE_ICON: Record<string, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  deploy: Rocket,
  project: FolderGit2,
  cron: FolderGit2,
  worker: FolderGit2,
  database: DatabaseIcon,
  user: UsersIcon,
  settings: SettingsIcon,
  audit: SettingsIcon,
  service: Activity,
  notification: Bell,
  auth: KeyRound,
  github: GitBranch,
};

function iconForAction(action: string): ComponentType<{ size?: number; strokeWidth?: number }> {
  const namespace = action.split('.')[0] ?? action;
  return NAMESPACE_ICON[namespace] ?? Activity;
}

// ---------------------------------------------------------------------------
// "<actor> <humanized action> <target>" sentences.
// ---------------------------------------------------------------------------

function humanizeEventKey(key: string): string {
  return key.replace(/_/g, ' ');
}

function metaObj(meta: unknown): Record<string, unknown> {
  return meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
}

function metaStr(meta: unknown, key: string): string | undefined {
  const value = metaObj(meta)[key];
  return typeof value === 'string' ? value : undefined;
}

const ACTION_SENTENCES: Record<string, (row: AuditEvent) => string> = {
  'audit.config': (row) => `${row.actorName} changed the audit log settings`,
  'auth.login_failed': (row) => `${row.actorName} failed to sign in`,
  'cron.create': (row) => `${row.actorName} created a cron job on ${metaStr(row.meta, 'project') ?? 'a project'}`,
  'cron.update': (row) => `${row.actorName} updated a cron job on ${metaStr(row.meta, 'project') ?? 'a project'}`,
  'cron.delete': (row) => `${row.actorName} deleted a cron job on ${metaStr(row.meta, 'project') ?? 'a project'}`,
  'database.create': (row) => `${row.actorName} created database ${row.targetName}`,
  'database.drop': (row) => `${row.actorName} dropped database ${row.targetName}`,
  'database.inject': (row) => `${row.actorName} added database ${row.targetName} to a project's environment`,
  'deploy.trigger': (row) => `${row.actorName} triggered a deploy of ${row.targetName}`,
  'deploy.rollback': (row) => `${row.actorName} rolled back ${row.targetName}`,
  'deploy.cancel': (row) => `${row.actorName} canceled a deploy of ${row.targetName}`,
  'github.configure': (row) => `${row.actorName} configured the GitHub App`,
  'notification.channel.create': (row) => `${row.actorName} added notification channel ${row.targetName}`,
  'notification.channel.update': (row) => `${row.actorName} updated notification channel ${row.targetName}`,
  'notification.channel.delete': (row) => `${row.actorName} removed notification channel ${row.targetName}`,
  'notification.migrated': (row) => `${row.actorName} migrated the legacy webhook to a notification channel`,
  'notification.subscribe': (row) => `${row.actorName} subscribed a channel to ${humanizeEventKey(row.targetName.split(':')[0] ?? row.targetName)} notifications`,
  'notification.unsubscribe': (row) => `${row.actorName} unsubscribed a channel from ${humanizeEventKey(row.targetName.split(':')[0] ?? row.targetName)} notifications`,
  'project.create': (row) => `${row.actorName} created project ${row.targetName}`,
  'project.update': (row) => `${row.actorName} updated project ${row.targetName}`,
  'project.scripts.update': (row) => `${row.actorName} updated the deploy scripts for ${row.targetName}`,
  'project.delete': (row) => `${row.actorName} deleted project ${row.targetName}`,
  'project.env.update': (row) => `${row.actorName} updated the environment variables for ${row.targetName}`,
  'project.smtp.update': (row) => `${row.actorName} updated the email settings for ${row.targetName}`,
  'settings.update': (row) => `${row.actorName} updated the workspace settings`,
  'user.create': (row) => `${row.actorName} created user ${row.targetName}`,
  'user.invite': (row) => `${row.actorName} invited ${row.targetName}`,
  'user.reinvite': (row) => `${row.actorName} resent the invite to ${row.targetName}`,
  'user.accept_invite': (row) => `${row.actorName} joined the workspace`,
  'user.role_change': (row) => {
    const from = metaStr(row.meta, 'from');
    const to = metaStr(row.meta, 'to');
    return from && to ? `${row.actorName} changed the role of ${row.targetName} from ${from} to ${to}` : `${row.actorName} changed the role of ${row.targetName}`;
  },
  'user.delete': (row) => `${row.actorName} removed ${row.targetName} from the team`,
  'worker.create': (row) => `${row.actorName} created worker ${row.targetName}`,
  'worker.update': (row) => `${row.actorName} updated worker ${row.targetName}`,
  'worker.delete': (row) => `${row.actorName} deleted worker ${row.targetName}`,
  'worker.action': (row) => {
    const action = metaStr(row.meta, 'action');
    const verb = action === 'start' ? 'started' : action === 'stop' ? 'stopped' : action === 'restart' ? 'restarted' : 'ran an action on';
    return `${row.actorName} ${verb} worker ${row.targetName}`;
  },
  'service.down': (row) => `${row.actorName} detected ${row.targetName} is down`,
  'service.recovered': (row) => `${row.actorName} detected ${row.targetName} recovered`,
};

function actionSentence(row: AuditEvent): string {
  const sentence = ACTION_SENTENCES[row.action];
  return sentence ? sentence(row) : `${row.actorName} ${row.action} ${row.targetName}`;
}

/** Small mono chips under the sentence. `meta: {keys: [...]}` (every settings-shaped action) shows
 * just the changed key NAMES, never values (some hold config, never secrets, but staying consistent
 * with the server's own "never a value" convention for this shape). Any other meta object renders as
 * `key: value` chips. */
function metaChips(row: AuditEvent): string[] {
  const obj = metaObj(row.meta);
  const keys = obj.keys;
  if (Array.isArray(keys) && keys.every((key) => typeof key === 'string')) {
    return keys;
  }
  return Object.entries(obj)
    .filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object')
    .map(([key, value]) => `${key}: ${String(value)}`);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AuditLogPage() {
  const [category, setCategory] = useState<AuditCategory>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [actorId, setActorId] = useState('');
  const [timePreset, setTimePreset] = useState<TimePreset>('all');

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [counts, setCounts] = useState<Record<AuditCategory, number>>(EMPTY_COUNTS);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce the free-text search 300ms before it drives a fetch.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Computed once per preset change (not on every render) — a session-scoped "now", not a ticking one.
  const since = useMemo(() => (timePreset === 'all' ? undefined : Date.now() - PRESET_MS[timePreset]), [timePreset]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAudit({ category, q: debouncedSearch || undefined, actorId: actorId ? Number(actorId) : undefined, since })
      .then((result) => {
        if (cancelled) return;
        setEvents(result.events);
        setCounts(result.counts);
        setNextCursor(result.nextCursor);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err, 'Could not load the audit log.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [category, debouncedSearch, actorId, since]);

  async function loadMore() {
    if (nextCursor === null) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await fetchAudit({
        category,
        q: debouncedSearch || undefined,
        actorId: actorId ? Number(actorId) : undefined,
        since,
        cursor: nextCursor,
      });
      setEvents((prev) => [...prev, ...result.events]);
      setCounts(result.counts);
      setNextCursor(result.nextCursor);
    } catch (err) {
      setError(errorMessage(err, 'Could not load more entries.'));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div>
      <PageHeader title="Audit log" subtitle="Everything that happened in this workspace, who did it, and when" />

      <PageWithRail rail={<RecordActivityCard />}>
        <Tabs tabs={CATEGORY_TABS.map((tab) => ({ id: tab.id, label: tab.label, count: counts[tab.id] }))} value={category} onChange={(id) => setCategory(id as AuditCategory)} />

        <div className="flex flex-wrap items-center gap-3">
          <span className="relative block min-w-[220px] flex-1">
            <Search size={16} strokeWidth={ICON_STROKE} aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-icon" />
            <Input type="search" placeholder="Search" aria-label="Search the audit log" value={search} onChange={(event) => setSearch(event.target.value)} className="pl-10" />
          </span>
          <ActorSelect value={actorId} onChange={setActorId} />
          <Select aria-label="Time range" value={timePreset} onChange={(event) => setTimePreset(event.target.value as TimePreset)} className="w-44">
            {TIME_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </Select>
        </div>

        <Card>
          {loading ? (
            <AuditSkeletonRows />
          ) : error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : events.length === 0 ? (
            <EmptyState message="Nothing has been recorded yet." />
          ) : (
            <>
              <div className="divide-y divide-line">
                {events.map((event) => (
                  <AuditRow key={event.id} event={event} />
                ))}
              </div>
              {nextCursor !== null && (
                <div className="mt-4 flex justify-center">
                  <Button variant="outline" loading={loadingMore} onClick={() => void loadMore()}>
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>
      </PageWithRail>
    </div>
  );
}

function ActorSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const usersQuery = useUsers();
  return (
    <Select aria-label="Actor" value={value} onChange={(event) => onChange(event.target.value)} className="w-44">
      <option value="">Anyone</option>
      {(usersQuery.data ?? []).map((user) => (
        <option key={user.id} value={user.id}>
          {user.name || user.email}
        </option>
      ))}
    </Select>
  );
}

function AuditRow({ event }: { event: AuditEvent }) {
  const Icon = iconForAction(event.action);
  const chips = metaChips(event);

  return (
    <div className="flex items-start gap-3 py-3">
      <IconChip size={36}>
        <Icon size={18} strokeWidth={ICON_STROKE} />
      </IconChip>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">{actionSentence(event)}</p>
        {chips.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {chips.map((chip) => (
              <Chip key={chip}>{chip}</Chip>
            ))}
          </div>
        )}
      </div>
      <span className="shrink-0 text-xs text-soft">{formatRelativeTime(event.createdAt)}</span>
    </div>
  );
}

function AuditSkeletonRows() {
  return (
    <div className="divide-y divide-line">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-center gap-3 py-3">
          <Skeleton className="h-9 w-9 rounded-xl" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right rail — record-activity toggle + retention (admin-gated).
// ---------------------------------------------------------------------------

function RecordActivityCard() {
  const configQuery = useAuditConfig();
  const queryClient = useQueryClient();
  const isAdmin = useIsAdmin();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabledTitle = isAdmin ? undefined : 'Requires admin';

  async function update(body: Partial<AuditConfig>) {
    setError(null);
    setSaving(true);
    try {
      const updated = await putAuditConfig(body);
      queryClient.setQueryData(['audit-config'], updated);
    } catch (err) {
      setError(errorMessage(err, 'Could not save. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader icon={<ClipboardList size={20} strokeWidth={ICON_STROKE} />} title="Record activity" />
      <div className="mt-4 flex flex-col gap-4">
        {configQuery.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : configQuery.isError || !configQuery.data ? (
          <p role="alert" className="text-sm text-danger">
            Could not load audit settings.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-soft">Keep a record of every change made in this workspace.</p>
              <span title={disabledTitle}>
                <Toggle checked={configQuery.data.enabled} onChange={(next) => void update({ enabled: next })} disabled={!isAdmin || saving} aria-label="Record activity" />
              </span>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-ink">Keep entries for</span>
              <Select
                value={String(configQuery.data.retentionDays)}
                disabled={!isAdmin || saving}
                title={disabledTitle}
                onChange={(event) => void update({ retentionDays: Number(event.target.value) as AuditConfig['retentionDays'] })}
              >
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">365 days</option>
              </Select>
              <span className="text-[13px] text-soft">Older entries are deleted automatically.</span>
            </label>

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
