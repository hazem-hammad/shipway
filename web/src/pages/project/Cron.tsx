/**
 * Cron tab: scheduled commands synced to the host crontab (server/src/routes/cron.ts's
 * `syncCrontab`). A delete that 502s (crontab sync failed) still removes the DB row server-side —
 * see cron.ts's DELETE handler — so the row disappears from the list either way; the sync failure
 * is then surfaced as a page-level notice rather than a row-level one, since the row itself is gone
 * by the time the error resolves.
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { ApiError, createCronJob, deleteCronJob, patchCronJob, type CronJob } from '../../api';
import { useCronJobs, useProject } from '../../hooks';
import { Button, Card, Chip, EmptyState, Field, Input, Skeleton } from '../../components/ui';

const SCHEDULE_HINT = 'e.g. * * * * * (every minute), */5 * * * * (every 5 min), 0 0 * * * (daily at midnight)';

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
      {adding ? (
        <AddCronForm projectId={projectId} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
      ) : (
        <div className="mb-5 flex justify-end">
          <Button onClick={() => setAdding(true)}>
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
      ) : cronQuery.isError ? (
        <p role="alert" className="text-sm text-danger">
          Could not load cron jobs.
        </p>
      ) : cronQuery.data.length === 0 && !adding ? (
        <EmptyState message="No cron jobs. Add one to run a command on a schedule." />
      ) : (
        <Card>
          <div className="flex flex-col divide-y divide-line">
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
          </div>
        </Card>
      )}

      {projectQuery.data?.type === 'php' && (
        <p className="mt-4 text-sm text-soft">This project&rsquo;s PHP commands run with its configured PHP version automatically.</p>
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
    <Card className="mb-5">
      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-wrap items-start gap-4">
          <Field label="Schedule" hint={SCHEDULE_HINT} error={scheduleError ?? undefined}>
            <Input mono required autoFocus placeholder="* * * * *" value={schedule} onChange={(event) => setSchedule(event.target.value)} className="w-56" />
          </Field>
          <Field label="Command" error={commandError ?? undefined}>
            <Input mono required value={command} onChange={(event) => setCommand(event.target.value)} className="w-80" />
          </Field>
        </div>
        {formError && (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" loading={submitting}>
            Add cron job
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
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
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-4 px-2 py-3">
        <Chip>{cron.schedule}</Chip>
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-soft" title={cron.command}>
          {cron.command}
        </span>
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
        <div className="mx-2 mb-3 rounded-xl bg-surface-2 px-4 py-3">
          <EditCronForm projectId={projectId} cron={cron} onDone={onToggleEdit} onCancel={onToggleEdit} />
        </div>
      )}

      {confirmingDelete && (
        <div className="mx-2 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface-2 px-4 py-3">
          <p className="text-sm text-ink">
            Delete cron job <Chip>{cron.schedule}</Chip>?
          </p>
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
        <p role="alert" className="text-sm text-danger">
          {formError}
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

function CronSkeletonRows() {
  return (
    <div className="flex flex-col divide-y divide-line">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex h-14 items-center gap-4 px-2">
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
    </div>
  );
}
