/**
 * Settings > Cloudflare: the DNS credentials Shipway uses to create each project's subdomain
 * record. Same shape as the setup wizard's Cloudflare step, but persistent — the token is never
 * echoed back in full (`GET /api/settings` masks it as "•••1234"), so a blank token field on save
 * means "keep the current token" (settings.ts's PUT handler already treats a masked echo the same
 * way; leaving the field blank is simpler still, since nothing masked is ever sent back to submit).
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Cloud } from 'lucide-react';
import { ApiError, putSettings, verifyCloudflare, type Settings, type SettingsUpdate } from '../../api';
import { useSettings } from '../../hooks';
import { Badge, Button, Card, CardHeader, Field, ICON_STROKE, Input, Skeleton } from '../../components/ui';

export default function CloudflareSection() {
  const settingsQuery = useSettings();

  return (
    <Card>
      <CardHeader
        icon={<Cloud size={20} strokeWidth={ICON_STROKE} />}
        title="Cloudflare"
        description="Lets Shipway create DNS records for project subdomains."
      />

      <div className="mt-5">
        {settingsQuery.isPending ? (
          <Skeleton className="h-48 w-full max-w-[640px]" />
        ) : settingsQuery.isError || !settingsQuery.data ? (
          <p role="alert" className="text-sm text-danger">
            Could not load settings.
          </p>
        ) : (
          <CloudflareForm settings={settingsQuery.data} />
        )}
      </div>
    </Card>
  );
}

function CloudflareForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const configured = settings.cloudflare_token !== null;

  const [token, setToken] = useState('');
  const [zoneId, setZoneId] = useState(settings.cloudflare_zone_id ?? '');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null);

  function markDirty() {
    setDirty(true);
    setSaved(false);
    setTestResult(null);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: SettingsUpdate = {};
      if (zoneId.trim() !== '') body.cloudflare_zone_id = zoneId.trim();
      if (token.trim() !== '') body.cloudflare_token = token.trim();
      await putSettings(body);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      setDirty(false);
      setSaved(true);
      setToken('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save Cloudflare settings. Try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await verifyCloudflare();
      setTestResult(result.ok ? 'ok' : 'fail');
    } catch {
      setTestResult('fail');
    } finally {
      setTesting(false);
    }
  }

  const canTest = (configured || saved) && !testing;

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex max-w-[640px] flex-col gap-6" noValidate>
      <Field label="API token" hint="A scoped token with DNS edit access to your zone. Leave blank to keep the current token.">
        <Input
          mono
          type="password"
          placeholder={settings.cloudflare_token ?? undefined}
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
            markDirty();
          }}
        />
      </Field>
      <Field label="Zone ID">
        <Input
          mono
          value={zoneId}
          onChange={(event) => {
            setZoneId(event.target.value);
            markDirty();
          }}
        />
      </Field>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={saving} disabled={!dirty || saving}>
          Save
        </Button>
        <Button type="button" variant="secondary" onClick={() => void handleTest()} loading={testing} disabled={!canTest}>
          Test connection
        </Button>
        {testResult === 'ok' && <Badge tone="ok">Connected</Badge>}
        {testResult === 'fail' && (
          <span role="alert" className="text-sm text-danger">
            Could not verify the token.
          </span>
        )}
      </div>
    </form>
  );
}
