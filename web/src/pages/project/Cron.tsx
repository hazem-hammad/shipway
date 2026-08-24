/**
 * Cron tab: scheduled commands synced to the host crontab (server/src/routes/cron.ts's
 * `syncCrontab`). A delete that 502s (crontab sync failed) still removes the DB row server-side —
 * see cron.ts's DELETE handler — so the row disappears from the list either way; the sync failure
 * is then surfaced as a page-level notice rather than a row-level one, since the row itself is gone
 * by the time the error resolves (task-25 controller ruling).
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, createCronJob, deleteCronJob, patchCronJob, type CronJob } from '../../api';
import { useCronJobs, useProject } from '../../hooks';
import { Button, Chip, EmptyState, Field, Input, PageHeader, Skeleton } from '../../components/ui';

const SCHEDULE_HINT = 'e.g. * * * * * (every minute), */5 * * * * (every 5 min), 0 0 * * * (daily at midnight)';

const TABLE_COLUMN_COUNT = 3;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function CronTab({ projectId }: { projectId: number }) {
  const cronQuery = useCronJobs(projectId);
  const projectQuery = useProject(projectId);
  const [adding, setAdding] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  return (
    <div>
      <PageHeader
        title="Cron"
        actions={
          !adding && (
            <Button onClick={() => setAdding(true)} className="px-2.5 py-1.5 text-xs">
              Add cron job
            </Button>
          )
        }
      />

      {deleteNotice && (
        <p role="alert" className="mb-4 text-sm text-stop">
          {deleteNotice}
        </p>
      )}

      {adding && (
        <AddCronForm
          projectId={projectId}
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      )}

      {cronQuery.isPending ? (
        <TableSkeleton />
      ) : cronQuery.isError ? (
        <p role="alert" className="text-sm text-stop">
          Could not load cron jobs.
        </p>
      ) : cronQuery.data.length === 0 && !adding ? (
        <EmptyState message="No cron jobs. Add one to run a command on a schedule." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[560px] border-collapse text-left text-sm">
            <thead className="bg-panel text-xs font-medium text-ink-soft">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Schedule
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Command
                </th>
                <th scope="col" className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {cronQuery.data.map((cron) => (
                <CronRow
                  key={cron.id}
                  projectId={projectId}
                  cron={cron}
                  editing={editingId === cron.id}
                  onToggleEdit={() => setEditingId((current) => (current === cron.id ? null : cron.id))}
                  onDeleted={(message) => {
                    setEditingId(null);
                    setDeleteNotice(message);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {projectQuery.data?.type === 'php' && (
        <p className="mt-4 text-xs text-ink-soft">This project&rsquo;s PHP commands run with its configured PHP version automatically.</p>
      )}
    </div>
  );
}

function AddCronForm({ projectId, onDone, onCancel }: { projectId: number; onDone: () => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const [schedule, setSchedule] = useState('');
  const [command, setCommand] = useState('');
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setScheduleError(null);
    setCommandError(null);
    setFormError(null);
    try {
      await createCronJob(projectId, { schedule, command });
      await queryClient.invalidateQueries({ queryKey: ['cron', projectId] });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.message === 'invalid cron expression') {
        setScheduleError(err.message);
      } else if (err instanceof ApiError && err.message === 'invalid command') {
        setCommandError(err.message);
      } else {
        setFormError(errorMessage(err, 'Could not add the cron job. Try again.'));
      }
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
      <div className="flex flex-wrap items-start gap-4">
        <Field label="Schedule" hint={SCHEDULE_HINT} error={scheduleError ?? undefined}>
          <Input
            mono
            required
            autoFocus
            placeholder="* * * * *"
            value={schedule}
            onChange={(event) => setSchedule(event.target.value)}
            className="w-56"
          />
        </Field>
        <Field label="Command" error={commandError ?? undefined}>
          <Input mono required value={command} onChange={(event) => setCommand(event.target.value)} className="w-80" />
        </Field>
      </div>
      {formError && (
        <p role="alert" className="text-sm text-stop">
          {formError}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" loading={submitting} className="px-2.5 py-1 text-xs">
          Add cron job
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting} className="px-2.5 py-1 text-xs">
          Cancel
        </Button>
      </div>
    </form>
  );
}

function CronRow({
  projectId,
  cron,
  editing,
  onToggleEdit,
  onDeleted,
}: {
  projectId: number;
  cron: CronJob;
  editing: boolean;
  onToggleEdit: () => void;
  onDeleted: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    <>
      <tr className="h-11">
        <td className="px-4 py-3">
          <Chip>{cron.schedule}</Chip>
        </td>
        <td className="max-w-[360px] truncate px-4 py-3 font-mono text-xs text-ink-soft" title={cron.command}>
          {cron.command}
        </td>
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onToggleEdit}
              className="rounded text-xs font-medium text-accent underline decoration-line underline-offset-2 hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {editing ? 'Cancel' : 'Edit'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete((open) => !open)}
              className="rounded text-xs font-medium text-stop underline decoration-line underline-offset-2 hover:text-stop/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Delete
            </button>
          </div>
        </td>
      </tr>

      {editing && (
        <tr>
          <td colSpan={TABLE_COLUMN_COUNT} className="border-t border-line bg-panel/60 px-4 py-3">
            <EditCronForm projectId={projectId} cron={cron} onDone={onToggleEdit} onCancel={onToggleEdit} />
          </td>
        </tr>
      )}

      {confirmingDelete && (
        <tr>
          <td colSpan={TABLE_COLUMN_COUNT} className="border-t border-line bg-stop/5 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink">
                Delete cron job <Chip>{cron.schedule}</Chip>?
              </p>
              <div className="flex items-center gap-2">
                <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                  Cancel
                </Button>
                <Button variant="destructive" className="px-2.5 py-1 text-xs" loading={deleting} onClick={() => void handleDelete()}>
                  Confirm
                </Button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function EditCronForm({
  projectId,
  cron,
  onDone,
  onCancel,
}: {
  projectId: number;
  cron: CronJob;
  onDone: () => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [schedule, setSchedule] = useState(cron.schedule);
  const [command, setCommand] = useState(cron.command);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setScheduleError(null);
    setCommandError(null);
    setFormError(null);
    try {
      await patchCronJob(cron.id, { schedule, command });
      await queryClient.invalidateQueries({ queryKey: ['cron', projectId] });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.message === 'invalid cron expression') {
        setScheduleError(err.message);
      } else if (err instanceof ApiError && err.message === 'invalid command') {
        setCommandError(err.message);
      } else {
        setFormError(errorMessage(err, 'Could not save the cron job. Try again.'));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-wrap items-start gap-4">
        <Field label="Schedule" hint={SCHEDULE_HINT} error={scheduleError ?? undefined}>
          <Input mono required value={schedule} onChange={(event) => setSchedule(event.target.value)} className="w-56" />
        </Field>
        <Field label="Command" error={commandError ?? undefined}>
          <Input mono required value={command} onChange={(event) => setCommand(event.target.value)} className="w-80" />
        </Field>
      </div>
      {formError && (
        <p role="alert" className="text-sm text-stop">
          {formError}
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

function TableSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="bg-panel px-4 py-3">
        <Skeleton className="h-3 w-32" />
      </div>
      <div className="divide-y divide-line">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex h-11 items-center gap-6 px-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}
