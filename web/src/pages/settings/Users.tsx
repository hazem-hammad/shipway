/**
 * Settings > Users: the team member list (server/src/routes/users.ts). Add is an inline form, not
 * a modal; delete is an inline confirm. The signed-in user's own row can't be deleted — the route
 * itself 403s on self-delete, but the button is disabled up front with an explanatory title rather
 * than letting the user hit that error (task-25 controller ruling).
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, createUser, deleteUser, type User } from '../../api';
import { useMe, useUsers } from '../../hooks';
import { Button, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { formatRelativeTime } from '../../lib/format';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const TABLE_COLUMN_COUNT = 4;

export default function UsersSection() {
  const usersQuery = useUsers();
  const meQuery = useMe();
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Users</h2>
        {!adding && (
          <Button onClick={() => setAdding(true)} className="px-2.5 py-1.5 text-xs">
            Add user
          </Button>
        )}
      </div>

      {adding && <AddUserForm onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />}

      {usersQuery.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : usersQuery.isError ? (
        <p role="alert" className="text-sm text-stop">
          Could not load users.
        </p>
      ) : usersQuery.data.length === 0 && !adding ? (
        <EmptyState message="No users yet." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[480px] border-collapse text-left text-sm">
            <thead className="bg-panel text-xs font-medium text-ink-soft">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Email
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Created
                </th>
                <th scope="col" className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {usersQuery.data.map((user) => (
                <UserRow key={user.id} user={user} isSelf={meQuery.data?.id === user.id} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddUserForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createUser({ name, email, password });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      onDone();
    } catch (err) {
      setError(errorMessage(err, 'Could not add the user. Try again.'));
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
        <Field label="Name">
          <Input required autoFocus value={name} onChange={(event) => setName(event.target.value)} className="w-48" />
        </Field>
        <Field label="Email">
          <Input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="w-56" />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input type="password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} className="w-48" />
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-sm text-stop">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" loading={submitting} className="px-2.5 py-1 text-xs">
          Add user
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting} className="px-2.5 py-1 text-xs">
          Cancel
        </Button>
      </div>
    </form>
  );
}

function UserRow({ user, isSelf }: { user: User; isSelf: boolean }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setError(null);
    setDeleting(true);
    try {
      await deleteUser(user.id);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the user. Try again.'));
      setDeleting(false);
    }
  }

  return (
    <>
      <tr className="h-11">
        <td className="px-4 py-3 text-ink">{user.name}</td>
        <td className="px-4 py-3 font-mono text-xs text-ink-soft">{user.email}</td>
        <td className="px-4 py-3 text-ink-soft">{formatRelativeTime(user.createdAt)}</td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={() => setConfirming((open) => !open)}
            disabled={isSelf}
            title={isSelf ? 'You cannot delete your own account' : undefined}
            className="rounded text-xs font-medium text-stop underline decoration-line underline-offset-2 hover:text-stop/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:text-ink-soft disabled:no-underline disabled:hover:text-ink-soft"
          >
            Delete
          </button>
        </td>
      </tr>
      {confirming && (
        <tr>
          <td colSpan={TABLE_COLUMN_COUNT} className="border-t border-line bg-stop/5 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink">
                Delete user <span className="font-mono">{user.email}</span>?
              </p>
              <div className="flex items-center gap-2">
                <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setConfirming(false)} disabled={deleting}>
                  Cancel
                </Button>
                <Button variant="destructive" className="px-2.5 py-1 text-xs" loading={deleting} onClick={() => void handleDelete()}>
                  Confirm
                </Button>
              </div>
            </div>
            {error && (
              <p role="alert" className="mt-2 text-xs text-stop">
                {error}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
