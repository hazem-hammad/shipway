/**
 * Workers tab: background job/queue processes, each backed by N systemd instance units (see
 * server/src/services/workers.ts's `applyWorker`/`workerInstances`). Every mutation here is inline
 * (add card, edit row, delete confirm) — no modals, per DESIGN.md. "View logs" expands a static
 * readonly dump from `GET /api/workers/:id/logs` (journalctl tail across every instance); it's
 * fetched once per open, not streamed, so a simple fixed-term mono panel is used instead of
 * LogTerminal's live auto-scroll machinery.
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Play, Plus, RotateCcw, Square } from 'lucide-react';
import {
  ApiError,
  createWorker,
  deleteWorker,
  fetchWorkerLogs,
  patchWorker,
  runWorkerAction,
  type WorkerAction,
  type WorkerInstance,
  type WorkerListItem,
} from '../../api';
import { useWorkers } from '../../hooks';
import { Button, Card, CardHeader, EmptyState, Field, ICON_STROKE, Input, Skeleton, StatusDot, type StatusDotStatus } from '../../components/ui';

const INSTANCE_DOT: Record<WorkerInstance['status'], StatusDotStatus> = {
  active: 'ok',
  failed: 'danger',
  inactive: 'idle',
  unknown: 'idle',
};

const INSTANCE_NUMBER_RE = /@(\d+)\.service$/;

function instanceNumber(unit: string): string {
  return INSTANCE_NUMBER_RE.exec(unit)?.[1] ?? '?';
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function WorkersTab({ projectId }: { projectId: number }) {
  const workersQuery = useWorkers(projectId);
  const [adding, setAdding] = useState(false);

  return (
    <div>
      {adding ? (
        <AddWorkerForm projectId={projectId} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
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

function AddWorkerForm({ projectId, onDone, onCancel }: { projectId: number; onDone: () => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [processes, setProcesses] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createWorker(projectId, { name, command, processes });
      await queryClient.invalidateQueries({ queryKey: ['workers', projectId] });
      onDone();
    } catch (err) {
      setError(errorMessage(err, 'Could not add the worker. Try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mb-5">
      <CardHeader icon={<Plus size={20} strokeWidth={ICON_STROKE} />} title="Add worker" description="Runs as N systemd instances behind this project's env." />
      <form onSubmit={(event) => void handleSubmit(event)} className="mt-4 flex flex-col gap-4" noValidate>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Name" hint="lowercase, digits, hyphens">
            <Input mono required autoFocus value={name} onChange={(event) => setName(event.target.value)} className="w-44" />
          </Field>
          <Field label="Command">
            <Input mono required value={command} onChange={(event) => setCommand(event.target.value)} className="w-80" />
          </Field>
          <Field label="Processes">
            <ProcessesStepper value={processes} onChange={setProcesses} />
          </Field>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" loading={submitting}>
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

      {editing && (
        <EditWorkerForm projectId={projectId} worker={worker} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
      )}

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
  const [command, setCommand] = useState(worker.command);
  const [processes, setProcesses] = useState(worker.processes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await patchWorker(worker.id, { command, processes });
      await queryClient.invalidateQueries({ queryKey: ['workers', projectId] });
      onDone();
    } catch (err) {
      setError(errorMessage(err, 'Could not save the worker. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="mt-4 flex flex-col gap-4 rounded-xl bg-surface-2 p-4" noValidate>
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Command">
          <Input mono required value={command} onChange={(event) => setCommand(event.target.value)} className="w-80" />
        </Field>
        <Field label="Processes">
          <ProcessesStepper value={processes} onChange={setProcesses} />
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" loading={saving}>
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
