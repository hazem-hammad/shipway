/**
 * Settings > General: the server's base domain, IP, and ACME email — the same three fields the
 * setup wizard's step 2 collects, editable afterwards. Dirty-save, same pattern as the project
 * Settings tab.
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, putSettings, type Settings } from '../../api';
import { useSettings } from '../../hooks';
import { Button, Field, Input, Skeleton } from '../../components/ui';

export default function GeneralSection() {
  const settingsQuery = useSettings();

  if (settingsQuery.isPending) {
    return (
      <div className="flex max-w-[640px] flex-col gap-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <p role="alert" className="text-sm text-stop">
        Could not load settings.
      </p>
    );
  }

  return <GeneralForm settings={settingsQuery.data} />;
}

function GeneralForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
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
    setSaving(true);
    setError(null);
    try {
      await putSettings({ base_domain: baseDomain, server_ip: serverIp, acme_email: acmeEmail });
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
        <Input mono required value={baseDomain} onChange={(event) => change(setBaseDomain)(event.target.value)} />
      </Field>
      <Field label="Server IP" hint="The public IPv4 address this server is reachable at.">
        <Input mono required value={serverIp} onChange={(event) => change(setServerIp)(event.target.value)} />
      </Field>
      <Field label="ACME email" hint="Used for Let's Encrypt certificate notices.">
        <Input type="email" required value={acmeEmail} onChange={(event) => change(setAcmeEmail)(event.target.value)} />
      </Field>

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
