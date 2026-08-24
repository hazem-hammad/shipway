import { type FormEvent, useState } from 'react';
import { useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, fetchGithubManifest, putSettings, setupAdmin, verifyCloudflare, type Me } from '../api';
import { submitManifestForm } from '../lib/github';
import { BerthLight, Button, Field, Input, Panel, ProgressRail } from '../components/ui';

const STEP_LABELS = ['Admin', 'Server', 'Cloudflare', 'GitHub'];

/**
 * The first-run setup flow: create the admin account, then three optional-but-recommended
 * configuration steps, shown as inline progressive panels (never modals). Only step 1 is gated by
 * the server (`GET /api/setup/status`'s `needsSetup` flips false the moment an admin exists) — the
 * rest is this component's own local progression, so a page reload mid-wizard drops back to the
 * normal dashboard rather than resuming; that's an acceptable trade for keeping the server's
 * "setup" concept to the one thing it actually gates.
 */
export default function SetupWizard() {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [step, setStep] = useState(1);
  const [adminEmail, setAdminEmail] = useState('');
  const [serverSummary, setServerSummary] = useState('');
  const [cloudflareSummary, setCloudflareSummary] = useState('');

  function finish() {
    // The server only tracks "does an admin exist" as `needsSetup` — that's already false since
    // step 1, but the query cache is holding the value fetched before this wizard mounted.
    // Refreshing it before navigating away is what lets the app shell's routing gate move past
    // `/setup` instead of bouncing back to it.
    void queryClient.invalidateQueries({ queryKey: ['setup-status'] }).then(() => {
      navigate('/projects');
    });
  }

  return (
    <div className="mx-auto max-w-[640px] px-4 py-12">
      <p className="mb-1 text-center text-lg font-semibold text-ink">Shipway</p>
      <p className="mb-8 text-center text-sm text-ink-soft">Let&rsquo;s get your server set up.</p>

      <ProgressRail steps={STEP_LABELS} currentIndex={step - 1} />

      <div className="flex flex-col gap-4">
        {step === 1 ? (
          <AdminStep
            onDone={(me) => {
              queryClient.setQueryData(['me'], me);
              setAdminEmail(me.email);
              setStep(2);
            }}
          />
        ) : (
          <DoneRow label="Admin account created" detail={adminEmail} />
        )}

        {step === 2 && (
          <ServerSettingsStep
            onDone={(baseDomain, serverIp) => {
              setServerSummary(`${baseDomain} · ${serverIp}`);
              setStep(3);
            }}
          />
        )}
        {step > 2 && <DoneRow label="Server settings saved" detail={serverSummary} mono />}

        {step === 3 && (
          <CloudflareStep
            onDone={(summary) => {
              setCloudflareSummary(summary);
              setStep(4);
            }}
          />
        )}
        {step > 3 && <DoneRow label="Cloudflare connected" detail={cloudflareSummary} mono />}

        {step === 4 && <GithubStep onSkip={finish} />}
      </div>
    </div>
  );
}

function DoneRow({ label, detail, mono = false }: { label: string; detail: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-panel/40 px-4 py-3">
      <BerthLight status="go" />
      <span className="text-sm font-medium text-ink">{label}</span>
      {detail && <span className={`truncate text-sm text-ink-soft ${mono ? 'font-mono' : ''}`}>{detail}</span>}
    </div>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
}

// ---- Step 1: admin account ----

function AdminStep({ onDone }: { onDone: (me: Me) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const me = await setupAdmin({ name, email, password });
      onDone(me);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel>
      <h2 className="mb-1 text-base font-semibold text-ink">Create the admin account</h2>
      <p className="mb-4 text-sm text-ink-soft">This is the first user. Add teammates later from Settings.</p>
      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
        <Field label="Name">
          <Input required autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input type="password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-stop">
            {error}
          </p>
        )}
        <Button type="submit" loading={submitting} className="self-start">
          Create account
        </Button>
      </form>
    </Panel>
  );
}

// ---- Step 2: server settings ----

function ServerSettingsStep({ onDone }: { onDone: (baseDomain: string, serverIp: string) => void }) {
  const [baseDomain, setBaseDomain] = useState('');
  const [serverIp, setServerIp] = useState('');
  const [acmeEmail, setAcmeEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const domain = baseDomain.trim();
    const ip = serverIp.trim();
    const email = acmeEmail.trim();
    const missing = [
      !domain && 'Base domain',
      !ip && 'Server IP',
      !email && 'ACME email',
    ].filter((label): label is string => Boolean(label));
    if (missing.length > 0) {
      setError(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required.`);
      return;
    }
    setSubmitting(true);
    try {
      await putSettings({ base_domain: domain, server_ip: ip, acme_email: email });
      onDone(domain, ip);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel>
      <h2 className="mb-1 text-base font-semibold text-ink">Server settings</h2>
      <p className="mb-4 text-sm text-ink-soft">Where deployed apps live and who issues their TLS certificates.</p>
      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
        <Field label="Base domain" hint="Projects deploy to <slug>.<this domain>.">
          <Input
            mono
            required
            autoFocus
            placeholder="e.g. apps.example.com"
            value={baseDomain}
            onChange={(event) => setBaseDomain(event.target.value)}
          />
        </Field>
        <Field label="Server IP" hint="The public IPv4 address this server is reachable at.">
          <Input mono required placeholder="e.g. 203.0.113.10" value={serverIp} onChange={(event) => setServerIp(event.target.value)} />
        </Field>
        <Field label="ACME email" hint="Used for Let's Encrypt certificate notices.">
          <Input type="email" required value={acmeEmail} onChange={(event) => setAcmeEmail(event.target.value)} />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-stop">
            {error}
          </p>
        )}
        <Button type="submit" loading={submitting} className="self-start">
          Save and continue
        </Button>
      </form>
    </Panel>
  );
}

// ---- Step 3: cloudflare ----

function CloudflareStep({ onDone }: { onDone: (summary: string) => void }) {
  const [token, setToken] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    setTestResult(null);
    try {
      await putSettings({ cloudflare_token: token, cloudflare_zone_id: zoneId });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
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

  return (
    <Panel>
      <h2 className="mb-1 text-base font-semibold text-ink">Cloudflare</h2>
      <p className="mb-4 text-sm text-ink-soft">Shipway creates the DNS record for each project&rsquo;s subdomain.</p>
      <form onSubmit={(event) => void handleSave(event)} className="flex flex-col gap-4" noValidate>
        <Field label="API token" hint="A scoped token with DNS edit access to your zone.">
          <Input
            mono
            type="password"
            required
            autoFocus
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setSaved(false);
            }}
          />
        </Field>
        <Field label="Zone ID">
          <Input
            mono
            required
            value={zoneId}
            onChange={(event) => {
              setZoneId(event.target.value);
              setSaved(false);
            }}
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-stop">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" loading={saving}>
            Save
          </Button>
          <Button type="button" variant="secondary" onClick={() => void handleTest()} loading={testing} disabled={!saved}>
            Test connection
          </Button>
          {testResult === 'ok' && <span className="text-sm text-go">Connected.</span>}
          {testResult === 'fail' && <span className="text-sm text-stop">Could not verify the token.</span>}
        </div>
      </form>
      {saved && (
        <Button variant="secondary" className="mt-4" onClick={() => onDone(`zone ${zoneId}`)}>
          Continue
        </Button>
      )}
    </Panel>
  );
}

// ---- Step 4: github app ----

function GithubStep({ onSkip }: { onSkip: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    setError(null);
    setCreating(true);
    try {
      const { postUrl, manifestJson } = await fetchGithubManifest(window.location.origin);
      submitManifestForm(postUrl, manifestJson);
      // The browser navigates to github.com from here; nothing left to do client-side.
    } catch (err) {
      setError(errorMessage(err));
      setCreating(false);
    }
  }

  return (
    <Panel>
      <h2 className="mb-1 text-base font-semibold text-ink">GitHub App</h2>
      <p className="mb-4 text-sm text-ink-soft">
        Shipway deploys from GitHub through a GitHub App scoped to the repositories you choose. Creating one takes you to
        GitHub and back.
      </p>
      {error && (
        <p role="alert" className="mb-4 text-sm text-stop">
          {error}
        </p>
      )}
      <div className="flex items-center gap-4">
        <Button onClick={() => void handleCreate()} loading={creating}>
          Create GitHub App on GitHub
        </Button>
        <button
          type="button"
          onClick={onSkip}
          className="rounded text-sm font-medium text-ink-soft underline decoration-line underline-offset-2 transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          I&rsquo;ll do this later
        </button>
      </div>
    </Panel>
  );
}
