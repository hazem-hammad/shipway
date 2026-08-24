/**
 * Settings > Notifications (server/src/routes/notifications.ts, Task 4): "Delivery channels" — named
 * webhook/Teams/email targets — and "What to be notified about", the per-event subscription matrix.
 *
 * A channel's `type` picks how it's delivered: `'webhook'` (Slack-compatible/Discord/Telegram,
 * auto-detected server-side by URL), `'teams'` (Microsoft Teams MessageCard — also auto-detected
 * from a webhook.office.com/logic.azure.com `url`, but an explicit `type: 'teams'` channel always
 * gets Teams formatting), or `'email'` (routes through instance mail to a `target` address instead
 * of a URL, and requires mail to already be configured in Settings > Mail).
 *
 * The matrix has no per-channel checkbox grid (that doesn't scale past 2-3 channels and reads as a
 * spreadsheet); instead each event row is collapsed to a "n channels" chip + a master Toggle, and
 * expands (chevron) to an inline checkbox per channel. The Toggle is a shortcut, not a separate piece
 * of state: switching it ON while zero channels are subscribed subscribes ALL of them; switching it
 * OFF unsubscribes all. There's deliberately no "channelId per event" popover — DESIGN.md bans
 * modals/popovers where inline/progressive works.
 */
import { type FormEvent, type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Check, ChevronDown, Mail as MailIcon, MessageSquare, Plus, Webhook } from 'lucide-react';
import {
  ApiError,
  createChannel,
  deleteChannel,
  putSubscription,
  testChannel,
  type NotificationChannel,
  type NotificationChannelType,
  type NotificationEventMeta,
  type NotificationsMatrix,
  type NotifyEventCategory,
} from '../../api';
import { useMailConfig, useNotifications } from '../../hooks';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, Field, ICON_STROKE, Input, Skeleton, Tabs, Toggle } from '../../components/ui';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const CHANNEL_TYPE_LABEL: Record<NotificationChannelType, string> = {
  webhook: 'Webhook',
  teams: 'Microsoft Teams',
  email: 'Email',
};

const CHANNEL_TYPE_OPTIONS: { value: NotificationChannelType; label: string; blurb: string; icon: ReactNode }[] = [
  { value: 'webhook', label: 'Webhook', blurb: 'Slack, Discord, Telegram, or any Slack-compatible URL.', icon: <Webhook size={18} strokeWidth={ICON_STROKE} aria-hidden /> },
  { value: 'teams', label: 'Microsoft Teams', blurb: 'A Teams channel connector webhook.', icon: <MessageSquare size={18} strokeWidth={ICON_STROKE} aria-hidden /> },
  { value: 'email', label: 'Email', blurb: 'Sent through instance mail to one address.', icon: <MailIcon size={18} strokeWidth={ICON_STROKE} aria-hidden /> },
];

const CATEGORY_TABS: { id: 'all' | NotifyEventCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'deployment', label: 'Deployment' },
  { id: 'services', label: 'Services' },
];

export default function NotificationsSection() {
  const notificationsQuery = useNotifications();

  return (
    <div className="flex flex-col gap-5">
      <DeliveryChannelsCard channels={notificationsQuery.data?.channels} isPending={notificationsQuery.isPending} isError={notificationsQuery.isError} />

      <Card>
        <CardHeader icon={<Bell size={20} strokeWidth={ICON_STROKE} />} title="What to be notified about" description="Pick which events go to which channels." />

        <div className="mt-5">
          {notificationsQuery.isPending ? (
            <MatrixSkeleton />
          ) : notificationsQuery.isError || !notificationsQuery.data ? (
            <p role="alert" className="text-sm text-danger">
              Could not load the notification matrix.
            </p>
          ) : notificationsQuery.data.channels.length === 0 ? (
            <EmptyState message="No channels yet. Add one to start receiving notifications." />
          ) : (
            <MatrixView matrix={notificationsQuery.data} />
          )}
        </div>
      </Card>
    </div>
  );
}

function MatrixView({ matrix }: { matrix: NotificationsMatrix }) {
  const [category, setCategory] = useState<'all' | NotifyEventCategory>('all');

  const tabs = CATEGORY_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    count: tab.id === 'all' ? matrix.events.length : matrix.events.filter((event) => event.category === tab.id).length,
  }));

  const visibleEvents = matrix.events.filter((event) => category === 'all' || event.category === category);

  return (
    <>
      <Tabs tabs={tabs} value={category} onChange={(id) => setCategory(id as 'all' | NotifyEventCategory)} />
      <div className="mt-4 divide-y divide-line">
        {visibleEvents.map((event) => (
          <EventRow key={event.event} event={event} channels={matrix.channels} subscribedChannelIds={subscribedChannelIds(matrix, event.event)} />
        ))}
      </div>
    </>
  );
}

function subscribedChannelIds(matrix: NotificationsMatrix, event: string): number[] {
  return matrix.subscriptions.filter((sub) => sub.event === event).map((sub) => sub.channelId);
}

// ---------------------------------------------------------------------------
// Delivery channels
// ---------------------------------------------------------------------------

function DeliveryChannelsCard({ channels, isPending, isError }: { channels: NotificationChannel[] | undefined; isPending: boolean; isError: boolean }) {
  const [adding, setAdding] = useState(false);

  return (
    <Card>
      <CardHeader
        icon={<Bell size={20} strokeWidth={ICON_STROKE} />}
        title="Delivery channels"
        description="Webhook, Teams, and email targets deploy and service events can be sent to."
        action={
          !adding && (
            <Button variant="outline" onClick={() => setAdding(true)}>
              <Plus size={16} strokeWidth={2} aria-hidden />
              Add channel
            </Button>
          )
        }
      />

      <div className="mt-5 flex flex-col gap-3">
        {adding && <AddChannelForm onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />}

        {isPending ? (
          <ChannelsSkeleton />
        ) : isError ? (
          <p role="alert" className="text-sm text-danger">
            Could not load delivery channels.
          </p>
        ) : channels && channels.length > 0 ? (
          <div className="divide-y divide-line">
            {channels.map((channel) => (
              <ChannelRow key={channel.id} channel={channel} />
            ))}
          </div>
        ) : adding ? null : (
          <EmptyState message="No channels yet. Add one to start receiving notifications." />
        )}
      </div>
    </Card>
  );
}

function AddChannelForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const mailQuery = useMailConfig();
  const mailConfigured = mailQuery.data?.configured ?? false;

  const [name, setName] = useState('');
  const [type, setType] = useState<NotificationChannelType>('webhook');
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createChannel(type === 'email' ? { name, type, target } : { name, type, url });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('A channel with this name already exists.');
      } else {
        setError(errorMessage(err, 'Could not add the channel. Try again.'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const emailBlocked = type === 'email' && !mailConfigured;
  const canSubmit = name.trim() !== '' && (type === 'email' ? target.trim() !== '' && mailConfigured : url.trim() !== '');

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex max-w-[560px] flex-col gap-4 rounded-xl bg-surface-2 p-4" noValidate>
      <Field label="Name">
        <Input required autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      </Field>

      <div role="radiogroup" aria-label="Channel type" className="flex flex-col gap-2">
        {CHANNEL_TYPE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors duration-150 ease-out ${
              type === option.value ? 'border-focus bg-surface' : 'border-line bg-surface hover:bg-surface-3'
            }`}
          >
            <input
              type="radio"
              name="channel-type"
              value={option.value}
              checked={type === option.value}
              onChange={() => {
                setType(option.value);
                setError(null);
              }}
              className="mt-1 h-4 w-4 accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
            <span className="mt-0.5 shrink-0 text-icon">{option.icon}</span>
            <span>
              <span className="block text-sm font-semibold text-ink">{option.label}</span>
              <span className="block text-[13px] text-soft">{option.blurb}</span>
            </span>
          </label>
        ))}
      </div>

      {type !== 'email' ? (
        <Field label="Webhook URL" hint={type === 'teams' ? 'Incoming Webhook URL from the Teams channel connector.' : 'Slack-compatible, Discord, or Telegram sendMessage URL.'}>
          <Input mono type="url" required placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} />
        </Field>
      ) : (
        <Field
          label="Email address"
          hint={
            mailQuery.isPending
              ? undefined
              : mailConfigured
                ? undefined
                : 'Instance mail is not configured yet. Set it up in Settings > Mail first.'
          }
        >
          <Input mono type="email" required placeholder="you@example.com" value={target} onChange={(event) => setTarget(event.target.value)} />
        </Field>
      )}

      {emailBlocked && !mailQuery.isPending && (
        <p className="text-[13px] text-soft">
          The Add button stays disabled until instance mail is configured. See{' '}
          <a href="/settings/mail" className="font-medium text-ink underline underline-offset-2">
            Settings &gt; Mail
          </a>
          .
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" loading={submitting} disabled={!canSubmit || submitting}>
          Add channel
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ChannelRow({ channel }: { channel: NotificationChannel }) {
  const queryClient = useQueryClient();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const destination = channel.type === 'email' ? channel.target : channel.url;

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const { ok, error: sendError } = await testChannel(channel.id);
      setTestResult(ok ? 'ok' : 'fail');
      if (!ok && sendError) setTestError(sendError);
    } catch {
      setTestResult('fail');
    } finally {
      setTesting(false);
      setTimeout(() => {
        setTestResult(null);
        setTestError(null);
      }, 3000);
    }
  }

  async function handleDelete() {
    setError(null);
    setDeleting(true);
    try {
      await deleteChannel(channel.id);
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the channel. Try again.'));
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col py-1">
      <div className="flex h-14 items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink">{channel.name}</span>
            <Badge>{CHANNEL_TYPE_LABEL[channel.type]}</Badge>
          </div>
          <div className="truncate font-mono text-xs text-soft">{destination}</div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {testResult === 'ok' && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-ok">
              <Check size={13} strokeWidth={ICON_STROKE} aria-hidden /> Sent
            </span>
          )}
          {testResult === 'fail' && (
            <span className="text-xs font-medium text-danger" title={testError ?? undefined}>
              Failed
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing}
            className="rounded px-1 text-sm font-medium text-soft transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-45"
          >
            {testing ? 'Sending…' : 'Send test'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete((open) => !open)}
            className="rounded px-1 text-sm font-medium text-danger transition-colors duration-150 ease-out hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Delete
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-2 text-sm text-danger">
          {error}
        </p>
      )}

      {confirmingDelete && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-4 py-3">
          <p className="text-sm text-ink">
            Delete channel <span className="font-mono">{channel.name}</span>? This removes it from every event it&rsquo;s subscribed to.
          </p>
          <div className="flex items-center gap-2">
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

function ChannelsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {[0, 1].map((row) => (
        <div key={row} className="flex h-14 items-center gap-3">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-1.5 h-3 w-56" />
          </div>
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event matrix rows
// ---------------------------------------------------------------------------

function EventRow({ event, channels, subscribedChannelIds }: { event: NotificationEventMeta; channels: NotificationChannel[]; subscribedChannelIds: number[] }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subscribedCount = subscribedChannelIds.length;

  async function setChannelSubscribed(channelId: number, enabled: boolean) {
    setError(null);
    try {
      await putSubscription({ event: event.event, channelId, enabled });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    } catch (err) {
      setError(errorMessage(err, 'Could not update the subscription. Try again.'));
    }
  }

  async function handleToggle(next: boolean) {
    setError(null);
    setBusy(true);
    try {
      if (next) {
        // Zero channels subscribed and switched ON: subscribe every channel (the toggle's
        // shortcut behavior — see the module doc comment).
        await Promise.all(channels.map((channel) => putSubscription({ event: event.event, channelId: channel.id, enabled: true })));
      } else {
        await Promise.all(subscribedChannelIds.map((channelId) => putSubscription({ event: event.event, channelId, enabled: false })));
      }
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    } catch (err) {
      setError(errorMessage(err, 'Could not update the subscription. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col py-2.5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-start gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ChevronDown size={16} strokeWidth={ICON_STROKE} aria-hidden className={`mt-1 shrink-0 text-icon transition-transform duration-150 ease-out ${expanded ? 'rotate-180' : ''}`} />
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold text-ink">{event.label}</span>
            <span className="block text-[13px] text-soft">{event.description}</span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-soft transition-colors duration-150 ease-out hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {subscribedCount} {subscribedCount === 1 ? 'channel' : 'channels'}
          </button>
          <Toggle checked={subscribedCount > 0} onChange={(next) => void handleToggle(next)} disabled={busy} aria-label={`Notify on ${event.label}`} />
        </div>
      </div>

      {expanded && (
        <div className="mt-3 ml-6 flex flex-col gap-2 rounded-xl bg-surface-2 p-3">
          {channels.map((channel) => (
            <Checkbox
              key={channel.id}
              checked={subscribedChannelIds.includes(channel.id)}
              onChange={(checked) => void setChannelSubscribed(channel.id, checked)}
              label={<span className="text-sm">{channel.name}</span>}
            />
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 ml-6 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function MatrixSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-9 w-64 rounded-full" />
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-1.5 h-3 w-64" />
            </div>
            <Skeleton className="h-6 w-11 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
