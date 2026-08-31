/**
 * Cron tab: scheduled commands synced to the host crontab (server/src/routes/cron.ts's
 * `syncCrontab`).
 *
 * The schedule is built rather than typed. A preset picker (every N minutes / hourly / daily /
 * weekly / monthly / custom) drives contextual controls, and the raw expression is shown as output
 * — readable, copyable, and still directly editable under "Custom cron" for anything the presets
 * can't express. Every schedule, in the form and in the list, is accompanied by a plain-English
 * description and its next runs, computed in the HOST's timezone (`web/src/lib/cron.ts`); a cron
 * expression that nobody can read at a glance is how a job ends up running at the wrong time for
 * months without anyone noticing.
 *
 * A delete that 502s (crontab sync failed) still removes the DB row server-side — see cron.ts's
 * DELETE handler — so the row disappears from the list either way; the sync failure is then surfaced
 * as a page-level notice rather than a row-level one, since the row itself is gone by the time the
 * error resolves.
 */
import { type FormEvent, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Clock, FolderOpen, Plus, ScrollText } from 'lucide-react';
import { ApiError, createCronJob, deleteCronJob, patchCronJob, type CronJob, type CronJobsResponse, type Project } from '../../api';
import { useCronJobs, useProject } from '../../hooks';
import { Badge, Button, Card, Chip, EmptyState, Field, ICON_STROKE, Input, Select, Skeleton } from '../../components/ui';
import {
  cronToParts,
  describeCron,
  formatWallClock,
  isValidCron,
  MINUTE_INTERVALS,
  nextRuns,
  nowInTimezone,
  partsToCron,
  WEEKDAY_NAMES,
  type ScheduleParts,
} from '../../lib/cron';

/** How many upcoming runs the form and each row preview. Three is enough to make an interval
 * obvious ("14:35, 14:40, 14:45") without turning into a wall of times. */
const PREVIEW_RUNS = 3;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Ready-made commands offered per project type, so the common cases are one click instead of
 * remembered syntax. Deliberately short: a menu long enough to need scanning is no faster than
 * typing. `php ` prefixes are rewritten to the project's PHP version server-side
 * (`routes/cron.ts`'s `rewritePhpCommand`), which `CommandField` previews.
 */
const COMMAND_TEMPLATES: Record<string, { label: string; command: string }[]> = {
  php: [
    { label: 'Laravel scheduler', command: 'php artisan schedule:run' },
    { label: 'Clear expired password reset tokens', command: 'php artisan auth:clear-resets' },
    { label: 'Prune old queue batches', command: 'php artisan queue:prune-batches --hours=48' },
    { label: 'Clear the cache', command: 'php artisan cache:clear' },
  ],
  node: [
    { label: 'Run an npm script', command: 'npm run cron' },
    { label: 'Run a Node script', command: 'node scripts/cron.js' },
  ],
  nextjs: [
    { label: 'Run an npm script', command: 'npm run cron' },
    { label: 'Run a Node script', command: 'node scripts/cron.js' },
  ],
  static: [{ label: 'Run a shell script', command: './scripts/cron.sh' }],
};

const PRESET_OPTIONS: { value: ScheduleParts['preset']; label: string }[] = [
  { value: 'minutes', label: 'Every few minutes' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'custom', label: 'Custom cron' },
];

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MINUTES = Array.from({ length: 60 }, (_, minute) => minute);
/** 1-28 only: the 29th, 30th and 31st silently skip months, which is a scheduling surprise rather
 * than a feature. Anyone who genuinely wants "the 31st" can still say so under Custom cron. */
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export default function CronTab({ projectId }: { projectId: number }) {
  const cronQuery = useCronJobs(projectId);
  const projectQuery = useProject(projectId);
  const [adding, setAdding] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  const data = cronQuery.data;

  return (
    <div>
      {adding && data ? (
        <CronForm
          projectId={projectId}
          project={projectQuery.data}
          context={data}
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className="mb-5 flex justify-end">
          <Button onClick={() => setAdding(true)} disabled={!data}>
            <Plus size={16} strokeWidth={2} aria-hidden />
            Add cron job
          </Button>
        </div>
      )}

      {deleteNotice && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {deleteNotice}
        </p>
      )}

      {cronQuery.isPending ? (
        <Card>
          <CronSkeletonRows />
        </Card>
      ) : cronQuery.isError || !data ? (
        <p role="alert" className="text-sm text-danger">
          Could not load cron jobs.
        </p>
      ) : data.jobs.length === 0 ? (
        adding ? null : <EmptyState message="No cron jobs. Add one to run a command on a schedule." />
      ) : (
        <Card>
          <div className="flex flex-col divide-y divide-line">
            {data.jobs.map((cron) => (
              <CronRow
                key={cron.id}
                projectId={projectId}
                project={projectQuery.data}
                context={data}
                cron={cron}
                editing={editingId === cron.id}
                onToggleEdit={() => setEditingId((current) => (current === cron.id ? null : cron.id))}
                onDeleted={(message) => {
                  setEditingId(null);
                  setDeleteNotice(message);
                }}
              />
            ))}
          </div>
        </Card>
      )}

      {data && (
        <div className="mt-4 flex flex-col gap-1.5 text-[13px] text-soft">
          <span className="flex items-center gap-2">
            <FolderOpen size={14} strokeWidth={ICON_STROKE} aria-hidden />
            Commands run in <code className="font-mono">{data.workingDir}</code>
          </span>
          <span className="flex items-center gap-2">
            <Clock size={14} strokeWidth={ICON_STROKE} aria-hidden />
            Schedules use the server clock ({data.timezone})
          </span>
          {projectQuery.data?.type === 'php' && <span className="pl-6">PHP commands run with this project&rsquo;s configured PHP version automatically.</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule builder
// ---------------------------------------------------------------------------

/**
 * The preset picker and its contextual controls. Owns no expression of its own — `parts` in,
 * `onChange` out — so the form above it holds one source of truth and can validate/preview the
 * single expression `partsToCron` derives.
 */
function ScheduleBuilder({ parts, onChange, error }: { parts: ScheduleParts; onChange: (next: ScheduleParts) => void; error: string | null }) {
  function set<K extends keyof ScheduleParts>(key: K, value: ScheduleParts[K]) {
    onChange({ ...parts, [key]: value });
  }

  function changePreset(preset: ScheduleParts['preset']) {
    // Carry the current expression into the custom field when switching to it, so "Custom cron" is
    // a starting point to edit rather than an empty box.
    onChange({ ...parts, preset, custom: preset === 'custom' ? partsToCron(parts) : parts.custom });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-4">
        <Field label="Runs">
          <Select value={parts.preset} onChange={(event) => changePreset(event.target.value as ScheduleParts['preset'])} className="w-52">
            {PRESET_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        {parts.preset === 'minutes' && (
          <Field label="Interval">
            <Select value={String(parts.everyMinutes)} onChange={(event) => set('everyMinutes', Number(event.target.value))} className="w-44">
              {MINUTE_INTERVALS.map((interval) => (
                <option key={interval} value={interval}>
                  {interval === 1 ? 'Every minute' : `Every ${String(interval)} minutes`}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {parts.preset === 'weekly' && (
          <Field label="Day">
            <Select value={String(parts.weekday)} onChange={(event) => set('weekday', Number(event.target.value))} className="w-40">
              {WEEKDAY_NAMES.map((name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {parts.preset === 'monthly' && (
          <Field label="Day of month">
            <Select value={String(parts.dayOfMonth)} onChange={(event) => set('dayOfMonth', Number(event.target.value))} className="w-40">
              {MONTH_DAYS.map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {(parts.preset === 'daily' || parts.preset === 'weekly' || parts.preset === 'monthly') && (
          <Field label="Time">
            <div className="flex items-center gap-1.5">
              <Select mono value={String(parts.hour)} onChange={(event) => set('hour', Number(event.target.value))} className="w-20" aria-label="Hour">
                {HOURS.map((hour) => (
                  <option key={hour} value={hour}>
                    {pad2(hour)}
                  </option>
                ))}
              </Select>
              <span className="font-mono text-sm text-soft">:</span>
              <Select mono value={String(parts.minute)} onChange={(event) => set('minute', Number(event.target.value))} className="w-20" aria-label="Minute">
                {MINUTES.map((minute) => (
                  <option key={minute} value={minute}>
                    {pad2(minute)}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
        )}

        {parts.preset === 'hourly' && (
          <Field label="At minute" hint="Past every hour.">
            <Select mono value={String(parts.minute)} onChange={(event) => set('minute', Number(event.target.value))} className="w-24">
              {MINUTES.map((minute) => (
                <option key={minute} value={minute}>
                  :{pad2(minute)}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {parts.preset === 'custom' && (
        <Field
          label="Cron expression"
          hint="Five fields: minute hour day-of-month month day-of-week. Aliases like @daily and @reboot work too."
          error={error ?? undefined}
        >
          <Input mono required placeholder="*/5 * * * *" value={parts.custom} onChange={(event) => set('custom', event.target.value)} className="w-72" />
        </Field>
      )}
    </div>
  );
}

/**
 * What the current expression means and when it will actually fire. This is the payoff of the whole
 * tab: an expression restated in words, plus real upcoming times so a mistake ("I meant 3am, not
 * 3pm") is visible before Save rather than tomorrow morning.
 */
function SchedulePreview({ expression, timezone }: { expression: string; timezone: string }) {
  const description = describeCron(expression);

  // Recomputed whenever the expression changes; `nowInTimezone()` reads the clock at that moment,
  // which is as fresh as this preview needs to be (nobody edits a schedule for an hour).
  const upcoming = useMemo(() => {
    if (!description) return [];
    const today = nowInTimezone(timezone);
    return nextRuns(expression, today, PREVIEW_RUNS).map((run) => formatWallClock(run, today));
  }, [expression, timezone, description]);

  if (!description) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-4 py-3 text-sm text-danger">
        <AlertCircle size={15} strokeWidth={ICON_STROKE} aria-hidden />
        Not a valid cron expression.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-surface-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-base font-semibold text-ink">{description}</span>
        <Chip>{expression}</Chip>
      </div>
      {upcoming.length > 0 ? (
        <span className="text-[13px] text-soft">Next: {upcoming.join(' · ')}</span>
      ) : (
        <span className="text-[13px] text-soft">Runs when the server boots.</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Command field
// ---------------------------------------------------------------------------

/** The command input plus a template picker for the project's type, and a preview of the PHP-version
 * rewrite the server applies so it isn't a surprise after saving. */
function CommandField({ project, value, onChange, error }: { project: Project | undefined; value: string; onChange: (next: string) => void; error: string | null }) {
  const templates = project ? (COMMAND_TEMPLATES[project.type] ?? []) : [];
  const matched = templates.find((template) => template.command === value);

  // Mirrors `rewritePhpCommand` in server/src/routes/cron.ts — exactly `php ` at the start, nothing
  // else. Kept narrow on purpose: promising a rewrite the server won't perform is worse than saying
  // nothing.
  const rewritten = project?.type === 'php' && project.phpVersion && value.startsWith('php ') ? `php${project.phpVersion} ${value.slice(4)}` : null;

  return (
    <div className="flex flex-col gap-3">
      {templates.length > 0 && (
        <Field label="Common commands">
          <Select
            value={matched ? matched.command : ''}
            onChange={(event) => {
              if (event.target.value !== '') onChange(event.target.value);
            }}
            className="w-full max-w-[420px]"
          >
            <option value="">Choose a command…</option>
            {templates.map((template) => (
              <option key={template.command} value={template.command}>
                {template.label}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field label="Command" hint="Runs from the project's current release directory." error={error ?? undefined}>
        <Input mono required value={value} onChange={(event) => onChange(event.target.value)} className="w-full max-w-[420px]" />
      </Field>

      {rewritten && <p className="text-[13px] text-soft">Runs as <code className="font-mono text-ink">{rewritten}</code></p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / edit form
// ---------------------------------------------------------------------------

/** One form for both adding and editing — `cron` present means edit. They differed only in their
 * submit call and button labels, and keeping two copies is how the builder ends up improved in one
 * of them and not the other. */
function CronForm({
  projectId,
  project,
  context,
  cron,
  onDone,
  onCancel,
  compact = false,
}: {
  projectId: number;
  project: Project | undefined;
  context: CronJobsResponse;
  cron?: CronJob;
  onDone: () => void;
  onCancel: () => void;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const [parts, setParts] = useState<ScheduleParts>(() => cronToParts(cron?.schedule ?? '0 3 * * *'));
  const [command, setCommand] = useState(cron?.command ?? '');
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const schedule = partsToCron(parts);
  const scheduleValid = isValidCron(schedule);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setScheduleError(null);
    setCommandError(null);
    setFormError(null);
    try {
      if (cron) {
        await patchCronJob(cron.id, { schedule, command });
      } else {
        await createCronJob(projectId, { schedule, command });
      }
      await queryClient.invalidateQueries({ queryKey: ['cron', projectId] });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.message === 'invalid cron expression') {
        setScheduleError(err.message);
      } else if (err instanceof ApiError && err.message === 'invalid command') {
        setCommandError(err.message);
      } else {
        setFormError(errorMessage(err, `Could not ${cron ? 'save' : 'add'} the cron job. Try again.`));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const body = (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-5" noValidate>
      <ScheduleBuilder parts={parts} onChange={setParts} error={scheduleError} />
      <SchedulePreview expression={schedule} timezone={context.timezone} />
      <CommandField project={project} value={command} onChange={setCommand} error={commandError} />

      {formError && (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size={compact ? 'sm' : 'md'} loading={submitting} disabled={!scheduleValid || command.trim() === ''}>
          {cron ? 'Save' : 'Add cron job'}
        </Button>
        <Button type="button" variant="outline" size={compact ? 'sm' : 'md'} onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );

  return compact ? body : <Card className="mb-5">{body}</Card>;
}

// ---------------------------------------------------------------------------
// List row
// ---------------------------------------------------------------------------

function CronRow({
  projectId,
  project,
  context,
  cron,
  editing,
  onToggleEdit,
  onDeleted,
}: {
  projectId: number;
  project: Project | undefined;
  context: CronJobsResponse;
  cron: CronJob;
  editing: boolean;
  onToggleEdit: () => void;
  onDeleted: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const description = describeCron(cron.schedule);
  const nextRun = useMemo(() => {
    const today = nowInTimezone(context.timezone);
    const [first] = nextRuns(cron.schedule, today, 1);
    return first ? formatWallClock(first, today) : null;
  }, [cron.schedule, context.timezone]);

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteCronJob(cron.id);
      await queryClient.invalidateQueries({ queryKey: ['cron', projectId] });
    } catch (err) {
      // The row is removed server-side even on a 502 here (crontab sync failure) — refresh the list
      // either way, then hand the sync failure up as a page-level notice since this row is gone.
      await queryClient.invalidateQueries({ queryKey: ['cron', projectId] });
      onDeleted(errorMessage(err, 'Could not delete the cron job.'));
      return;
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-start gap-4 px-2 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            {/* The sentence leads, the expression follows it — an expression alone is the thing
                nobody reads correctly under time pressure. */}
            <span className="text-[15px] font-semibold text-ink">{description ?? 'Unrecognized schedule'}</span>
            <Chip>{cron.schedule}</Chip>
            {!description && <Badge tone="danger">Invalid</Badge>}
          </div>
          <p className="mt-1 truncate font-mono text-sm text-soft" title={cron.command}>
            {cron.command}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-soft">
            {nextRun && (
              <span className="flex items-center gap-1.5">
                <Clock size={13} strokeWidth={ICON_STROKE} aria-hidden />
                Next: {nextRun}
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <ScrollText size={13} strokeWidth={ICON_STROKE} aria-hidden />
              <code className="font-mono">
                {context.logDir}/cron-{cron.id}.log
              </code>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onToggleEdit}>
            {editing ? 'Cancel' : 'Edit'}
          </Button>
          <Button variant="danger" size="sm" onClick={() => setConfirmingDelete((open) => !open)}>
            Delete
          </Button>
        </div>
      </div>

      {editing && (
        <div className="mx-2 mb-3 rounded-xl bg-surface-2 px-4 py-4">
          <CronForm compact projectId={projectId} project={project} context={context} cron={cron} onDone={onToggleEdit} onCancel={onToggleEdit} />
        </div>
      )}

      {confirmingDelete && (
        <div className="mx-2 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface-2 px-4 py-3">
          <p className="text-sm text-ink">Delete {description ? `"${description}"` : 'this cron job'}?</p>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" loading={deleting} onClick={() => void handleDelete()}>
              Confirm
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CronSkeletonRows() {
  return (
    <div className="flex flex-col divide-y divide-line">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex flex-col gap-2 px-2 py-3.5">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-4 w-80" />
        </div>
      ))}
    </div>
  );
}
