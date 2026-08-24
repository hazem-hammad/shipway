/**
 * Settings > Notifications: the server-wide deploy notification webhook (distinct from a project's
 * own per-project webhook on its Settings tab). `notify_webhook_url` has no "clear" affordance in
 * `PUT /api/settings` (the field is `z.string().min(1)`, not nullable — see settings.ts), so a
 * blank field is simply left out of the save body rather than sent as an invalid empty string.
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, putSettings, type Settings, type SettingsUpdate } from '../../api';
import { useSettings } from '../../hooks';
import { Button, Field, Input, Skeleton } from '../../components/ui';

export default function NotificationsSection() {
  const settingsQuery = useSettings();

  if (settingsQuery.isPending) {
    return <Skeleton className="h-32 w-full max-w-[640px]" />;
  }
  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <p role="alert" className="text-sm text-stop">
        Could not load settings.
      </p>
    );
  }

  return <NotificationsForm settings={settingsQuery.data} />;
}

function NotificationsForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const [webhookUrl, setWebhookUrl] = useState(settings.notify_webhook_url ?? '');
  const [onSuccess, setOnSuccess] = useState(settings.notify_on_success ?? false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function change<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
      setError(null);
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: SettingsUpdate = { notify_on_success: onSuccess };
      if (webhookUrl.trim() !== '') body.notify_webhook_url = webhookUrl.trim();
      await putSettings(body);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      setDirty(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save notification settings. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex max-w-[640px] flex-col gap-6" noValidate>
      <Field
        label="Webhook URL"
        hint="Supports a Slack-compatible incoming webhook, a Discord webhook URL, or a Telegram Bot sendMessage URL."
      >
        <Input mono type="url" placeholder="https://" value={webhookUrl} onChange={(event) => change(setWebhookUrl)(event.target.value)} />
      </Field>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={onSuccess}
          onChange={(event) => change(setOnSuccess)(event.target.checked)}
          className="h-4 w-4 rounded border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          style={{ accentColor: 'var(--color-accent)' }}
        />
        Notify on successful deploys too, not just failures
      </label>

      {error && (
        <p role="alert" className="text-sm text-stop">
          {error}
        </p>
      )}

      <div>
        <Button type="submit" loading={saving} disabled={!dirty || saving}>
          Save
        </Button>
      </div>
    </form>
  );
}
