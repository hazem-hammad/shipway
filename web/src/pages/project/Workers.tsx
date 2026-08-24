/**
 * Workers tab: background job/queue processes, each backed by N systemd instance units (see
 * server/src/services/workers.ts's `applyWorker`/`workerInstances`). Every mutation here is inline
 * (add row, edit row, typed-free delete confirm) — no modals, per DESIGN.md. "View logs" expands a
 * static readonly dump from `GET /api/workers/:id/logs` (journalctl tail across every instance);
 * it's fetched once per open, not streamed, so a simple dark mono panel is used instead of
 * LogTerminal's live auto-scroll machinery (task-25 controller ruling).
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
import { BerthLight, Button, EmptyState, Field, Input, PageHeader, Skeleton, type BerthStatus } from '../../components/ui';

const INSTANCE_BERTH: Record<WorkerInstance['status'], BerthStatus> = {
  active: 'go',
  failed: 'stop',
  inactive: 'unknown',
  unknown: 'unknown',
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
      <PageHeader
        title="Workers"
        actions={
          !adding && (
            <Button onClick={() => setAdding(true)} className="px-2.5 py-1.5 text-xs">
              Add worker
            </Button>
          )
        }
      />

      {adding && <AddWorkerForm projectId={projectId} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />}

      {workersQuery.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : workersQuery.isError ? (
        <p role="alert" className="text-sm text-stop">
          Could not load workers.
        </p>
      ) : workersQuery.data.length === 0 && !adding ? (
        <EmptyState message="No workers. Add one to run queue consumers or background jobs." />
      ) : (
        <div className="flex flex-col gap-3">
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
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="mb-4 flex flex-col gap-4 rounded-lg border border-line bg-panel/40 p-4"
      noValidate
    >
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Name" hint="lowercase, digits, hyphens">
          <Input mono required autoFocus value={name} onChange={(event) => setName(event.target.value)} className="w-40" />
        </Field>
        <Field label="Command">
          <Input mono required value={command} onChange={(event) => setCommand(event.target.value)} className="w-80" />
        </Field>
        <Field label="Processes">
          <ProcessesStepper value={processes} onChange={setProcesses} />
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-sm text-stop">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" loading={submitting} className="px-2.5 py-1 text-xs">
          Add worker
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting} className="px-2.5 py-1 text-xs">
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ProcessesStepper({ value, onChange, disabled }: { value: number; onChange: (next: number) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label="Decrease processes"
        disabled={disabled || value <= 1}
        onClick={() => onChange(Math.max(1, value - 1))}
        className="grid h-8 w-8 place-items-center rounded-md border border-line bg-paper text-sm text-ink transition-colors duration-150 ease-out hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        −
      </button>
      <span className="w-6 text-center font-mono text-sm text-ink">{value}</span>
      <button
        type="button"
        aria-label="Increase processes"
        disabled={disabled || value >= 8}
        onClick={() => onChange(Math.min(8, value + 1))}
        className="grid h-8 w-8 place-items-center rounded-md border border-line bg-paper text-sm text-ink transition-colors duration-150 ease-out hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        +
      </button>
    </div>
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
    <div className="rounded-lg border border-line bg-paper p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-sm font-medium text-ink">{worker.name}</p>
          <p className="max-w-md truncate font-mono text-xs text-ink-soft" title={worker.command}>
            {worker.command}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            className="px-2.5 py-1 text-xs"
            loading={actionBusy === 'start'}
            disabled={actionBusy !== null}
            onClick={() => void handleAction('start')}
          >
            Start
          </Button>
          <Button
            variant="secondary"
            className="px-2.5 py-1 text-xs"
            loading={actionBusy === 'stop'}
            disabled={actionBusy !== null}
            onClick={() => void handleAction('stop')}
          >
            Stop
          </Button>
          <Button
            variant="secondary"
            className="px-2.5 py-1 text-xs"
            loading={actionBusy === 'restart'}
            disabled={actionBusy !== null}
            onClick={() => void handleAction('restart')}
          >
            Restart
          </Button>
        </div>
      </div>

      {worker.instances.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {worker.instances.map((instance) => (
            <span key={instance.unit} className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
              <BerthLight status={INSTANCE_BERTH[instance.status]} />
              <span className="font-mono">@{instanceNumber(instance.unit)}</span>
              <span>{instance.status}</span>
            </span>
          ))}
        </div>
      )}

      {actionError && (
        <p role="alert" className="mt-2 text-xs text-stop">
          {actionError}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
        <button
          type="button"
          onClick={() => setEditing((open) => !open)}
          className="rounded text-xs font-medium text-accent underline decoration-line underline-offset-2 hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {editing ? 'Cancel edit' : 'Edit'}
        </button>
        <button
          type="button"
          onClick={() => setConfirmingDelete((open) => !open)}
          className="rounded text-xs font-medium text-stop underline decoration-line underline-offset-2 hover:text-stop/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={() => void toggleLogs()}
          className="rounded text-xs font-medium text-ink-soft underline decoration-line underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {logsOpen ? 'Hide logs' : 'View logs'}
        </button>
      </div>

      {editing && (
        <EditWorkerForm
          projectId={projectId}
          worker={worker}
          onDone={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      )}

      {confirmingDelete && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-stop/30 bg-stop/5 px-4 py-3">
          <p className="text-sm text-ink">
            Delete worker <span className="font-mono">{worker.name}</span>? This stops every instance.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" className="px-2.5 py-1 text-xs" loading={deleting} onClick={() => void handleDelete()}>
              Confirm
            </Button>
          </div>
          {deleteError && (
            <p role="alert" className="w-full text-xs text-stop">
              {deleteError}
            </p>
          )}
        </div>
      )}

      {logsOpen && (
        <div className="mt-3">
          {logsLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : logsError ? (
            <p role="alert" className="text-xs text-stop">
              {logsError}
            </p>
          ) : (
            <WorkerLogPanel content={logsContent ?? ''} />
          )}
        </div>
      )}
    </div>
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
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="mt-3 flex flex-col gap-4 rounded-md border border-line bg-panel/40 p-4"
      noValidate
    >
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Command">
          <Input mono required value={command} onChange={(event) => setCommand(event.target.value)} className="w-80" />
        </Field>
        <Field label="Processes">
          <ProcessesStepper value={processes} onChange={setProcesses} />
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-sm text-stop">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" loading={saving} className="px-2.5 py-1 text-xs">
          Save
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving} className="px-2.5 py-1 text-xs">
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A compact, static (non-streaming) reading of the term panel styling, for a journalctl tail. */
function WorkerLogPanel({ content }: { content: string }) {
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  return (
    <div
      role="log"
      aria-label="Worker log"
      className="max-h-72 overflow-y-auto rounded-md bg-term px-4 py-3 font-mono text-[13px] leading-[1.6] text-term-text"
    >
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
