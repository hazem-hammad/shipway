/**
 * Settings > General: the server's base domain, IP, and ACME email — the same three fields the
 * setup wizard's step 2 collects, editable afterwards. Dirty-save, same pattern as the project
 * Settings tab.
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Settings as SettingsIcon } from 'lucide-react';
import { ApiError, putSettings, type Settings } from '../../api';
import { useIsAdmin, useSettings } from '../../hooks';
import { Button, Card, CardHeader, Field, ICON_STROKE, Input, ReadOnlyNotice, Skeleton } from '../../components/ui';

export default function GeneralSection() {
  const settingsQuery = useSettings();

  return (
    <Card>
      <CardHeader
        icon={<SettingsIcon size={20} strokeWidth={ICON_STROKE} />}
        title="General"
        description="Domain and network configuration for this server."
      />

      <div className="mt-5">
        {settingsQuery.isPending ? (
          <div className="flex max-w-[640px] flex-col gap-4">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : settingsQuery.isError || !settingsQuery.data ? (
          <p role="alert" className="text-sm text-danger">
            Could not load settings.
          </p>
        ) : (
          <GeneralForm settings={settingsQuery.data} />
        )}
      </div>
    </Card>
  );
}

function GeneralForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  // `false` while the session's role is still loading, so the fields never flash editable for a
  // member who is about to be told they aren't (see `useIsAdmin`).
  const canEdit = useIsAdmin();
  const [baseDomain, setBaseDomain] = useState(settings.base_domain ?? '');
  const [serverIp, setServerIp] = useState(settings.server_ip ?? '');
  const [acmeEmail, setAcmeEmail] = useState(settings.acme_email ?? '');
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
    setError(null);
    const missing = [
      !baseDomain.trim() && 'Base domain',
      !serverIp.trim() && 'Server IP',
      !acmeEmail.trim() && 'ACME email',
    ].filter((label): label is string => Boolean(label));
    if (missing.length > 0) {
      setError(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required.`);
      return;
    }
    setSaving(true);
    try {
      await putSettings({ base_domain: baseDomain.trim(), server_ip: serverIp.trim(), acme_email: acmeEmail.trim() });
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      setDirty(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save settings. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex max-w-[640px] flex-col gap-6" noValidate>
      <Field label="Base domain" hint="Projects deploy to <slug>.<this domain>.">
        <Input mono required disabled={!canEdit} value={baseDomain} onChange={(event) => change(setBaseDomain)(event.target.value)} />
      </Field>
      <Field label="Server IP" hint="The public IPv4 address this server is reachable at.">
        <Input mono required disabled={!canEdit} value={serverIp} onChange={(event) => change(setServerIp)(event.target.value)} />
      </Field>
      <Field label="ACME email" hint="Used for Let's Encrypt certificate notices.">
        <Input type="email" required disabled={!canEdit} value={acmeEmail} onChange={(event) => change(setAcmeEmail)(event.target.value)} />
      </Field>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div>
        {canEdit ? (
          <Button type="submit" loading={saving} disabled={!dirty || saving}>
            Save
          </Button>
        ) : (
          <ReadOnlyNotice can="change the server's domain settings" />
        )}
      </div>
    </form>
  );
}
