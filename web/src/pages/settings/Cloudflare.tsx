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
import { ApiError, putSettings, verifyCloudflare, type CloudflareVerifyResult, type Settings, type SettingsUpdate } from '../../api';
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

  const [token, setToken] = useState('');
  const [zoneId, setZoneId] = useState(settings.cloudflare_zone_id ?? '');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  // Full verify result (not just a boolean) so the UI can show WHY a check failed — not
  // configured, an invalid token, or an error — instead of one generic failure message. Cleared
  // on every edit (see `markDirty`) so a stale "Connected" badge can never survive a field change.
  const [testResult, setTestResult] = useState<CloudflareVerifyResult | null>(null);

  function markDirty() {
    setDirty(true);
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
      setTestResult(await verifyCloudflare());
    } catch (err) {
      setTestResult({ ok: false, reason: 'error', message: err instanceof ApiError ? err.message : 'Could not reach the server. Try again.' });
    } finally {
      setTesting(false);
    }
  }

  // Always clickable (while not already testing) — the route itself is honest about an
  // unconfigured/blank state now, so there's no need to gate the button on `configured`/`saved`
  // the way the previous (dishonest) version did.
  const canTest = !testing;

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

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={saving} disabled={!dirty || saving}>
            Save
          </Button>
          <Button type="button" variant="secondary" onClick={() => void handleTest()} loading={testing} disabled={!canTest}>
            Test connection
          </Button>
          {/* Four honest states, driven entirely by the last verify result's `reason` — never
              inferred from credentials merely being present (that was the bug: dev mode used to
              report "Connected" unconditionally). Cleared to unknown on any field edit above.
              invalid_token/error both render the same danger Badge (matching New Project's Domain
              card, DESIGN.md's Badges/chips section) with the specific reason as an explanatory
              line beneath, rather than plain alert text with no badge at all. */}
          {testResult?.reason === 'ok' && <Badge tone="ok">Connected</Badge>}
          {testResult?.reason === 'not_configured' && <Badge tone="neutral">Not configured</Badge>}
          {(testResult?.reason === 'invalid_token' || testResult?.reason === 'error') && <Badge tone="danger">Not connected</Badge>}
        </div>
        {testResult?.reason === 'invalid_token' && (
          <p role="alert" className="text-sm text-danger">
            Cloudflare rejected this token. Check it hasn&rsquo;t expired or been revoked.
          </p>
        )}
        {testResult?.reason === 'error' && (
          <p role="alert" className="text-sm text-danger">
            {testResult.message ?? 'Could not reach Cloudflare. Try again.'}
          </p>
        )}
      </div>
    </form>
  );
}
