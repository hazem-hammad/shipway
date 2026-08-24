/**
 * Settings > Team (server/src/routes/users.ts + the public `/api/invite/:token` lifecycle, Task 3):
 * an "Invite member" card — always visible to admin+, hidden for a plain member since the base
 * invite gate is admin+ — above "Pending invites (n)" and "Active members (n)" list cards.
 *
 * Permission gating here is deliberately coarse (admin+ sees the controls, member sees plain
 * labels) rather than replicating every one of `routes/users.ts`'s finer rules (e.g. an admin can't
 * touch another admin; only the owner can). Any control an admin CAN see but isn't actually
 * permitted to use still hits the API and 403s — handled calmly with an inline message, never a
 * crash — per the task brief's "surface 403s calmly" ruling.
 *
 * The invite token itself is only ever returned once, at creation (`inviteUrl` on the invite/
 * reinvite response) — there's no "view the link again" for an already-issued invite, only
 * "Regenerate link" (`POST /api/users/:id/reinvite`), which rotates the token and returns a fresh
 * one-time link.
 */
import { type FormEvent, type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, RefreshCw, Shield, UserPlus, Users as UsersIcon } from 'lucide-react';
import {
  ApiError,
  changeUserRole,
  deleteUser,
  inviteUser,
  reinviteUser,
  type InvitableRole,
  type InviteResult,
  type User,
} from '../../api';
import { useIsOwner, useMe, useUsers } from '../../hooks';
import { Avatar, Button, Card, CardHeader, Field, ICON_STROKE, Input, Select, Skeleton } from '../../components/ui';
import { formatRelativeTime } from '../../lib/format';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function TeamSection() {
  const usersQuery = useUsers();
  const meQuery = useMe();
  const canManage = meQuery.data?.role === 'admin' || meQuery.data?.role === 'owner';

  const pending = (usersQuery.data ?? []).filter((user) => user.status === 'invited');
  const active = (usersQuery.data ?? []).filter((user) => user.status === 'active');

  return (
    <div className="flex flex-col gap-5">
      {canManage && <InviteCard />}

      {usersQuery.isPending ? (
        <Card>
          <TeamSkeletonRows />
        </Card>
      ) : usersQuery.isError ? (
        <p role="alert" className="text-sm text-danger">
          Could not load the team.
        </p>
      ) : (
        <>
          {pending.length > 0 && (
            <Card>
              <CardHeader icon={<UserPlus size={20} strokeWidth={ICON_STROKE} />} title={`Pending invites (${String(pending.length)})`} />
              <div className="mt-4 divide-y divide-line">
                {pending.map((user) => (
                  <PendingInviteRow key={user.id} user={user} canManage={canManage} />
                ))}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader icon={<UsersIcon size={20} strokeWidth={ICON_STROKE} />} title={`Active members (${String(active.length)})`} />
            <div className="mt-4 divide-y divide-line">
              {active.map((user) => (
                <ActiveMemberRow key={user.id} user={user} isSelf={meQuery.data?.id === user.id} canManage={canManage} />
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function InviteCard() {
  const queryClient = useQueryClient();
  const isOwner = useIsOwner();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitableRole>('member');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);

  function reset() {
    setResult(null);
    setEmail('');
    setRole('member');
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const created = await inviteUser({ email, role });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      setResult(created);
    } catch (err) {
      setError(errorMessage(err, 'Could not send the invite. Try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader icon={<UserPlus size={20} strokeWidth={ICON_STROKE} />} title="Invite member" description="Send an email invite to join this workspace." />
      <div className="mt-5">
        {result ? (
          <div className="max-w-[560px]">
            <p className="text-sm text-ink">Invite sent to {result.email}.</p>
            <div className="mt-2">
              <CopyLinkRow inviteUrl={result.inviteUrl} />
            </div>
            <p className="mt-2 text-[13px] text-soft">Share this link. It expires in 7 days.</p>
            <div className="mt-4">
              <Button variant="outline" onClick={reset}>
                Invite another
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={(event) => void handleSubmit(event)} className="flex max-w-[560px] flex-col gap-4" noValidate>
            <Field label="Email">
              <Input type="email" required autoFocus value={email} onChange={(event) => setEmail(event.target.value)} />
            </Field>

            <div role="radiogroup" aria-label="Role" className="flex flex-col gap-3 sm:flex-row">
              <RoleCard
                icon={<UsersIcon size={18} strokeWidth={ICON_STROKE} />}
                label="Member"
                description="Read and write to all projects."
                selected={role === 'member'}
                onSelect={() => setRole('member')}
              />
              <RoleCard
                icon={<Shield size={18} strokeWidth={ICON_STROKE} />}
                label="Admin"
                description="Everything Member can do, plus manage team and settings."
                selected={role === 'admin'}
                disabled={!isOwner}
                title={isOwner ? undefined : 'Only the owner can invite admins'}
                onSelect={() => setRole('admin')}
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}

            <div className="flex items-center gap-2">
              <Button type="submit" loading={submitting} disabled={email.trim() === ''}>
                Send invite
              </Button>
              <Button type="button" variant="outline" onClick={reset} disabled={submitting}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

function RoleCard({
  icon,
  label,
  description,
  selected,
  disabled,
  title,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
}) {
  return (
    <label
      title={title}
      className={`flex flex-1 items-start gap-3 rounded-xl border px-4 py-3.5 transition-colors duration-150 ease-out ${
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'
      } ${selected && !disabled ? 'border-focus bg-surface-2' : 'border-line bg-surface hover:bg-surface-2'}`}
    >
      <input type="radio" name="invite-role" checked={selected} disabled={disabled} onChange={onSelect} className="sr-only" />
      <span aria-hidden className="mt-0.5 shrink-0 text-icon">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span className="block text-[13px] text-soft">{description}</span>
      </span>
    </label>
  );
}

/** Full absolute link (not just the `/invite/<token>` path) — this is what gets shared to another
 * browser/device, so it needs the origin. */
function CopyLinkRow({ inviteUrl }: { inviteUrl: string }) {
  const [copied, setCopied] = useState(false);
  const fullUrl = `${window.location.origin}${inviteUrl}`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable or denied — the link is still visible to copy by hand.
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-4 py-3">
      <span className="min-w-0 truncate font-mono text-sm text-ink">{fullUrl}</span>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-soft transition-colors duration-150 ease-out hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {copied ? <Check size={14} strokeWidth={ICON_STROKE} aria-hidden /> : <Copy size={14} strokeWidth={ICON_STROKE} aria-hidden />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function PendingInviteRow({ user, canManage }: { user: User; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [regenerated, setRegenerated] = useState<InviteResult | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRegenerate() {
    setError(null);
    setRegenerating(true);
    try {
      const result = await reinviteUser(user.id);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      setRegenerated(result);
    } catch (err) {
      setError(errorMessage(err, 'Could not regenerate the invite link. Try again.'));
    } finally {
      setRegenerating(false);
    }
  }

  async function handleRemove() {
    setError(null);
    setRemoving(true);
    try {
      await deleteUser(user.id);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (err) {
      setError(errorMessage(err, 'Could not remove the invite. Try again.'));
      setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col py-1">
      <div className="flex h-14 items-center gap-3">
        <Avatar name={user.email} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">{user.email}</div>
          <div className="text-xs text-soft">Expires {user.inviteExpiresAt !== null ? formatRelativeTime(user.inviteExpiresAt) : 'soon'}</div>
        </div>
        <span className="shrink-0 text-xs font-semibold tracking-wide text-soft uppercase">{user.role}</span>
        {canManage && (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" loading={regenerating} onClick={() => void handleRegenerate()}>
              <RefreshCw size={14} strokeWidth={ICON_STROKE} aria-hidden />
              Regenerate link
            </Button>
            <button
              type="button"
              onClick={() => setConfirmingRemove((open) => !open)}
              className="rounded px-1 text-sm font-medium text-danger transition-colors duration-150 ease-out hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Remove
            </button>
          </div>
        )}
      </div>

      {regenerated && (
        <div className="mb-3 max-w-[560px] rounded-xl bg-surface-2 p-3">
          <CopyLinkRow inviteUrl={regenerated.inviteUrl} />
          <p className="mt-2 text-[13px] text-soft">Share this link. It expires in 7 days.</p>
        </div>
      )}

      {error && (
        <p role="alert" className="mb-2 text-sm text-danger">
          {error}
        </p>
      )}

      {confirmingRemove && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-4 py-3">
          <p className="text-sm text-ink">
            Remove the invite for <span className="font-mono">{user.email}</span>?
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmingRemove(false)} disabled={removing}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" loading={removing} onClick={() => void handleRemove()}>
              Confirm
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveMemberRow({ user, isSelf, canManage }: { user: User; isSelf: boolean; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [changingRole, setChangingRole] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRoleChange(next: InvitableRole) {
    setError(null);
    setChangingRole(true);
    try {
      await changeUserRole(user.id, next);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (err) {
      setError(errorMessage(err, 'Could not change the role. Try again.'));
    } finally {
      setChangingRole(false);
    }
  }

  async function handleRemove() {
    setError(null);
    setRemoving(true);
    try {
      await deleteUser(user.id);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (err) {
      setError(errorMessage(err, 'Could not remove the member. Try again.'));
      setRemoving(false);
    }
  }

  const showControls = canManage && user.role !== 'owner';

  return (
    <div className="flex flex-col py-1">
      <div className="flex h-14 items-center gap-3">
        <Avatar name={user.name} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">
            {user.name}
            {isSelf && <span className="ml-1.5 text-soft">(you)</span>}
          </div>
          <div className="truncate text-xs text-soft">{user.email}</div>
        </div>

        {showControls ? (
          <div className="flex shrink-0 items-center gap-2">
            <Select
              aria-label={`Role for ${user.email}`}
              value={user.role === 'admin' ? 'admin' : 'member'}
              disabled={changingRole}
              onChange={(event) => void handleRoleChange(event.target.value as InvitableRole)}
              className="w-32"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
            <button
              type="button"
              onClick={() => setConfirmingRemove((open) => !open)}
              disabled={isSelf}
              title={isSelf ? 'You cannot remove your own account' : undefined}
              className="rounded px-1 text-sm font-medium text-danger transition-colors duration-150 ease-out hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-soft disabled:hover:bg-transparent"
            >
              Remove
            </button>
          </div>
        ) : (
          <span className="shrink-0 text-xs font-semibold tracking-wide text-soft uppercase">{user.role}</span>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-2 text-sm text-danger">
          {error}
        </p>
      )}

      {confirmingRemove && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-4 py-3">
          <p className="text-sm text-ink">
            Remove <span className="font-mono">{user.email}</span> from the team?
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmingRemove(false)} disabled={removing}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" loading={removing} onClick={() => void handleRemove()}>
              Confirm
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TeamSkeletonRows() {
  return (
    <div className="flex flex-col gap-4">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex h-14 items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-1.5 h-3 w-28" />
          </div>
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
