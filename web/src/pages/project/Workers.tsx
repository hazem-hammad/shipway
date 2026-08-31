/**
 * Workers tab: background job/queue processes, each backed by N systemd instance units (see
 * server/src/services/workers.ts's `applyWorker`/`workerInstances`). Every mutation here is inline
 * (add card, edit row, delete confirm) — no modals, per DESIGN.md. "View logs" expands a static
 * readonly dump from `GET /api/workers/:id/logs` (journalctl tail across every instance); it's
 * fetched once per open, not streamed, so a simple fixed-term mono panel is used instead of
 * LogTerminal's live auto-scroll machinery.
 *
 * The form covers the whole unit, not just the command: process count, whether the worker comes back
 * after a reboot, its restart policy and delay, and how long it gets to finish the job in hand on
 * shutdown. The last one is the least discoverable and the most costly to get wrong — too short and
 * every deploy kills an in-flight job — so it is a labelled field rather than an implicit systemd
 * default. Restart behavior sits under "Advanced" so the common path stays three fields.
 *
 * A stack-aware preset picker (`lib/workerPresets.ts`) fills all of it in for the usual cases —
 * Laravel queue/Horizon, a Node worker script — since the tuned numbers that go with each command
 * are exactly what's hard to remember.
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, LoaderCircle, Play, Plus, Power, RotateCcw, Square } from 'lucide-react';
import {
  ApiError,
  createWorker,
  deleteWorker,
  fetchWorkerLogs,
  patchWorker,
  runWorkerAction,
  type Project,
  type WorkerAction,
  type WorkerInstance,
  type WorkerListItem,
  type WorkerRestartPolicy,
} from '../../api';
import { useProject, useWorkers } from '../../hooks';
import { Badge, Button, Card, CardHeader, EmptyState, Field, ICON_STROKE, Input, Select, Skeleton, StatusDot, Toggle, type StatusDotStatus } from '../../components/ui';
import { CUSTOM_PRESET, presetsForType, uniqueWorkerName, type WorkerPreset } from '../../lib/workerPresets';

const INSTANCE_DOT: Record<WorkerInstance['status'], StatusDotStatus> = {
  active: 'ok',
  failed: 'danger',
  inactive: 'idle',
  unknown: 'idle',
};

const INSTANCE_NUMBER_RE = /@(\d+)\.service$/;

const RESTART_POLICY_OPTIONS: { value: WorkerRestartPolicy; label: string }[] = [
  { value: 'always', label: 'Always — restart whenever it exits' },
  { value: 'on-failure', label: 'On failure — only after a non-zero exit' },
  { value: 'no', label: 'Never — leave it stopped' },
];

function instanceNumber(unit: string): string {
  return INSTANCE_NUMBER_RE.exec(unit)?.[1] ?? '?';
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** The editable shape of a worker, shared by the add and edit forms. */
interface WorkerFormState {
  name: string;
  command: string;
  processes: number;
  autoStart: boolean;
  restartPolicy: WorkerRestartPolicy;
  restartSec: number;
  stopTimeoutSec: number;
}

function stateFromPreset(preset: WorkerPreset, takenNames: string[]): WorkerFormState {
  return {
    name: uniqueWorkerName(preset.name, takenNames),
    command: preset.command,
    processes: preset.processes,
    autoStart: preset.autoStart,
    restartPolicy: preset.restartPolicy,
    restartSec: preset.restartSec,
    stopTimeoutSec: preset.stopTimeoutSec,
  };
}

function stateFromWorker(worker: WorkerListItem): WorkerFormState {
  return {
    name: worker.name,
    command: worker.command,
    processes: worker.processes,
    autoStart: worker.autoStart,
    restartPolicy: worker.restartPolicy,
    restartSec: worker.restartSec,
    stopTimeoutSec: worker.stopTimeoutSec,
  };
}

export default function WorkersTab({ projectId }: { projectId: number }) {
  const workersQuery = useWorkers(projectId);
  const projectQuery = useProject(projectId);
  const [adding, setAdding] = useState(false);

  const takenNames = workersQuery.data?.map((worker) => worker.name) ?? [];

  return (
    <div>
      {adding ? (
        <AddWorkerCard
          projectId={projectId}
          project={projectQuery.data}
          takenNames={takenNames}
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className="mb-5 flex justify-end">
          <Button onClick={() => setAdding(true)}>
            <Plus size={16} strokeWidth={2} aria-hidden />
            Add worker
          </Button>
        </div>
      )}

      {workersQuery.isPending ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-32 w-full rounded-2xl" />
          <Skeleton className="h-32 w-full rounded-2xl" />
        </div>
      ) : workersQuery.isError ? (
        <p role="alert" className="text-sm text-danger">
          Could not load workers.
        </p>
      ) : workersQuery.data.length === 0 && !adding ? (
        <EmptyState message="No workers. Add one to run queue consumers or background jobs." />
      ) : (
        <div className="flex flex-col gap-4">
          {workersQuery.data.map((worker) => (
            <WorkerCard key={worker.id} projectId={projectId} worker={worker} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

function AddWorkerCard({
  projectId,
  project,
  takenNames,
  onDone,
  onCancel,
}: {
  projectId: number;
  project: Project | undefined;
  takenNames: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const presets = presetsForType(project?.type);
  const [presetId, setPresetId] = useState(presets[0]?.id ?? CUSTOM_PRESET.id);
  const [state, setState] = useState<WorkerFormState>(() => stateFromPreset(presets[0] ?? CUSTOM_PRESET, takenNames));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPreset = presets.find((preset) => preset.id === presetId) ?? CUSTOM_PRESET;

  function applyPreset(id: string) {
    setPresetId(id);
    const preset = presets.find((p) => p.id === id) ?? CUSTOM_PRESET;
    // Replaces the whole form, not just the command: the point of a preset is the process count and
    // the shutdown grace period that go WITH that command.
    setState(stateFromPreset(preset, takenNames));
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createWorker(projectId, state);
      await queryClient.invalidateQueries({ queryKey: ['workers', projectId] });
      onDone();
    } catch (err) {
      setError(errorMessage(err, 'Could not add the worker. Try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = !submitting && state.name.trim() !== '' && state.command.trim() !== '';

  return (
    <Card className="mb-5">
      <CardHeader icon={<Plus size={20} strokeWidth={ICON_STROKE} />} title="Add worker" description="Runs as N systemd instances behind this project's env." />
      <form onSubmit={(event) => void handleSubmit(event)} className="mt-4 flex flex-col gap-5" noValidate>
        <Field label="Start from" hint={selectedPreset.description}>
          <Select value={presetId} onChange={(event) => applyPreset(event.target.value)} className="w-full max-w-[420px]">
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </Select>
        </Field>

        <WorkerFields state={state} onChange={setState} showName />

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button type="submit" loading={submitting} disabled={!canSubmit}>
            Add worker
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared fields
// ---------------------------------------------------------------------------

/** The worker's editable settings. `showName` is false when editing, since the name is fixed once a
 * worker exists (it's baked into the systemd unit names). */
function WorkerFields({ state, onChange, showName = false }: { state: WorkerFormState; onChange: (next: WorkerFormState) => void; showName?: boolean }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function set<K extends keyof WorkerFormState>(key: K, value: WorkerFormState[K]) {
    onChange({ ...state, [key]: value });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start gap-4">
        {showName && (
          <Field label="Name" hint="Lowercase letters, digits and hyphens.">
            <Input mono required value={state.name} onChange={(event) => set('name', event.target.value)} className="w-44" />
          </Field>
        )}
        <Field label="Command" hint="Runs from the current release, with the project's .env loaded.">
          <Input mono required value={state.command} onChange={(event) => set('command', event.target.value)} className="w-full min-w-[280px] max-w-[420px]" />
        </Field>
        <Field label="Processes" hint="Copies to run in parallel.">
          <ProcessesStepper value={state.processes} onChange={(value) => set('processes', value)} />
        </Field>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-xl bg-surface-2 px-4 py-3">
        <span>
          <span className="flex items-center gap-2 text-sm font-medium text-ink">
            <Power size={15} strokeWidth={ICON_STROKE} aria-hidden />
            Start automatically after a reboot
          </span>
          <span className="mt-0.5 block text-[13px] text-soft">Turn this off to keep the worker running now but not bring it back when the server restarts.</span>
        </span>
        <Toggle checked={state.autoStart} onChange={(next) => set('autoStart', next)} aria-label="Start automatically after a reboot" />
      </div>

      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          className="inline-flex items-center gap-1 text-sm font-medium text-ink transition-colors duration-150 ease-out hover:text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {advancedOpen ? <ChevronDown size={15} strokeWidth={ICON_STROKE} aria-hidden /> : <ChevronRight size={15} strokeWidth={ICON_STROKE} aria-hidden />}
          Restart and shutdown
        </button>

        {advancedOpen && (
          <div className="mt-3 flex flex-col gap-4 rounded-xl bg-surface-2 p-4">
            <Field label="When the worker exits">
              <Select value={state.restartPolicy} onChange={(event) => set('restartPolicy', event.target.value as WorkerRestartPolicy)} className="w-full max-w-[360px]">
                {RESTART_POLICY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex flex-wrap items-start gap-4">
              <Field label="Wait before restarting" hint="Seconds.">
                <Input
                  mono
                  type="number"
                  min={1}
                  max={300}
                  value={String(state.restartSec)}
                  onChange={(event) => set('restartSec', Number(event.target.value))}
                  className="w-28"
                  disabled={state.restartPolicy === 'no'}
                />
              </Field>
              <Field label="Grace period on shutdown" hint="Seconds to finish the current job before it's killed.">
                <Input
                  mono
                  type="number"
                  min={1}
                  max={1800}
                  value={String(state.stopTimeoutSec)}
                  onChange={(event) => set('stopTimeoutSec', Number(event.target.value))}
                  className="w-28"
                />
              </Field>
            </div>
            <p className="text-[13px] text-soft">
              A queue worker is usually mid-job when a deploy restarts it. The grace period is how long it gets to finish that job before it&rsquo;s killed.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ProcessesStepper({ value, onChange, disabled }: { value: number; onChange: (next: number) => void; disabled?: boolean }) {
  return (
    <div className="flex h-11 items-center gap-2">
      <button
        type="button"
        aria-label="Decrease processes"
        disabled={disabled || value <= 1}
        onClick={() => onChange(Math.max(1, value - 1))}
        className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-surface text-base text-ink transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-45"
      >
        &minus;
      </button>
      <span className="w-6 text-center font-mono text-sm text-ink">{value}</span>
      <button
        type="button"
        aria-label="Increase processes"
        disabled={disabled || value >= 8}
        onClick={() => onChange(Math.min(8, value + 1))}
        className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-surface text-base text-ink transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-45"
      >
        +
      </button>
    </div>
  );
}

function IconActionButton({
  icon,
  label,
  onClick,
  loading,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-surface text-icon transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-45"
    >
      {loading ? <LoaderCircle size={15} strokeWidth={2} className="animate-spin" aria-hidden /> : icon}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Worker card
// ---------------------------------------------------------------------------

function WorkerCard({ projectId, worker }: { projectId: number; worker: WorkerListItem }) {
  const queryClient = useQueryClient();
  const [actionBusy, setActionBusy] = useState<WorkerAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsContent, setLogsContent] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  async function handleAction(action: WorkerAction) {
    setActionError(null);
    setActionBusy(action);
    try {
      await runWorkerAction(worker.id, action);
      await queryClient.invalidateQueries({ queryKey: ['workers', projectId] });
    } catch (err) {
      setActionError(errorMessage(err, `Could not ${action} the worker.`));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleDelete() {
    setDeleteError(null);
    setDeleting(true);
    try {
      await deleteWorker(worker.id);
      await queryClient.invalidateQueries({ queryKey: ['workers', projectId] });
    } catch (err) {
      setDeleteError(errorMessage(err, 'Could not delete the worker. Try again.'));
      setDeleting(false);
    }
  }

  async function toggleLogs() {
    if (logsOpen) {
      setLogsOpen(false);
      return;
    }
    setLogsOpen(true);
    setLogsError(null);
    setLogsLoading(true);
    try {
      const { content } = await fetchWorkerLogs(worker.id);
      setLogsContent(content);
    } catch (err) {
      setLogsError(errorMessage(err, 'Could not load logs.'));
    } finally {
      setLogsLoading(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-base font-semibold text-ink">{worker.name}</p>
          <p className="mt-0.5 max-w-md truncate font-mono text-sm text-soft" title={worker.command}>
            {worker.command}
          </p>
          {/* The settings that decide how this worker behaves, visible without opening the editor —
              "why did that job die on deploy" is answered by the grace period, not the command. */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge>{worker.processes === 1 ? '1 process' : `${String(worker.processes)} processes`}</Badge>
            {worker.autoStart ? <Badge>Starts on boot</Badge> : <Badge tone="danger">Not on boot</Badge>}
            <Badge>Restart: {worker.restartPolicy}</Badge>
            <Badge>{String(worker.stopTimeoutSec)}s grace</Badge>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IconActionButton icon={<Play size={15} strokeWidth={ICON_STROKE} />} label="Start" loading={actionBusy === 'start'} disabled={actionBusy !== null} onClick={() => void handleAction('start')} />
          <IconActionButton icon={<Square size={15} strokeWidth={ICON_STROKE} />} label="Stop" loading={actionBusy === 'stop'} disabled={actionBusy !== null} onClick={() => void handleAction('stop')} />
          <IconActionButton icon={<RotateCcw size={15} strokeWidth={ICON_STROKE} />} label="Restart" loading={actionBusy === 'restart'} disabled={actionBusy !== null} onClick={() => void handleAction('restart')} />
          <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          <Button variant="outline" size="sm" onClick={() => setEditing((open) => !open)}>
            {editing ? 'Cancel' : 'Edit'}
          </Button>
          <Button variant="danger" size="sm" onClick={() => setConfirmingDelete((open) => !open)}>
            Delete
          </Button>
        </div>
      </div>

      {worker.instances.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 border-t border-line pt-3">
          {worker.instances.map((instance) => (
            <span key={instance.unit} className="inline-flex items-center gap-1.5 text-sm text-soft">
              <StatusDot status={INSTANCE_DOT[instance.status]} />
              <span className="font-mono">@{instanceNumber(instance.unit)}</span>
              <span>{instance.status}</span>
            </span>
          ))}
        </div>
      )}

      {actionError && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {actionError}
        </p>
      )}

      <button
        type="button"
        onClick={() => void toggleLogs()}
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-link transition-colors duration-150 ease-out hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {logsOpen ? 'Hide logs' : 'View logs'}
      </button>

      {editing && <EditWorkerForm projectId={projectId} worker={worker} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />}

      {confirmingDelete && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface-2 px-4 py-3">
          <p className="text-sm text-ink">
            Delete worker <span className="font-mono">{worker.name}</span>? This stops every instance.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" loading={deleting} onClick={() => void handleDelete()}>
              Confirm
            </Button>
          </div>
          {deleteError && (
            <p role="alert" className="w-full text-xs text-danger">
              {deleteError}
            </p>
          )}
        </div>
      )}

      {logsOpen && (
        <div className="mt-4">
          {logsLoading ? (
            <Skeleton className="h-40 w-full rounded-xl" />
          ) : logsError ? (
            <p role="alert" className="text-xs text-danger">
              {logsError}
            </p>
          ) : (
            <WorkerLogPanel content={logsContent ?? ''} />
          )}
        </div>
      )}
    </Card>
  );
}

function EditWorkerForm({
  projectId,
  worker,
  onDone,
  onCancel,
}: {
  projectId: number;
  worker: WorkerListItem;
  onDone: () => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<WorkerFormState>(() => stateFromWorker(worker));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // `name` is deliberately not sent: it's part of the systemd unit names, so renaming would mean
      // tearing down and recreating the units rather than patching a row.
      await patchWorker(worker.id, {
        command: state.command,
        processes: state.processes,
        autoStart: state.autoStart,
        restartPolicy: state.restartPolicy,
        restartSec: state.restartSec,
        stopTimeoutSec: state.stopTimeoutSec,
      });
      await queryClient.invalidateQueries({ queryKey: ['workers', projectId] });
      onDone();
    } catch (err) {
      setError(errorMessage(err, 'Could not save the worker. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="mt-4 flex flex-col gap-5 rounded-xl bg-surface-2 p-4" noValidate>
      <WorkerFields state={state} onChange={setState} />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" loading={saving} disabled={state.command.trim() === ''}>
          Save
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A compact, static (non-streaming) reading of the terminal's fixed dark tokens, for a journalctl tail. */
function WorkerLogPanel({ content }: { content: string }) {
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  return (
    <div role="log" aria-label="Worker log" className="max-h-72 overflow-y-auto rounded-xl bg-term px-4 py-3 font-mono text-[13px] leading-[1.6] text-term-text">
      {lines.length === 0 ? (
        <p className="text-term-text/45">No log output yet.</p>
      ) : (
        lines.map((line, index) => (
          <div key={index} className="whitespace-pre-wrap break-all">
            {line === '' ? ' ' : line}
          </div>
        ))
      )}
    </div>
  );
}
