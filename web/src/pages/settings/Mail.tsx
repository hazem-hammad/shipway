/**
 * Settings > Mail (server/src/routes/mail.ts, plan Task 3): the SMTP settings Shipway itself uses
 * to send invites and deploy/service notifications, entirely separate from a project's own SMTP tab
 * (`pages/project/Smtp.tsx`, which only configures what a deployed project writes into its own
 * `.env`). The server never echoes a saved password back in full (`GET` masks it as "•••1234"), so
 * an untouched password field on save means "keep the current password" — same convention as
 * `settings/Cloudflare.tsx`'s token handling.
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Mail as MailIcon } from 'lucide-react';
import { ApiError, putMailConfig, testMailConfig, type MailConfig, type MailConfigUpdate, type MailDriver } from '../../api';
import { useMailConfig } from '../../hooks';
import { Badge, Button, Card, CardHeader, Field, ICON_STROKE, Input, Skeleton, Toggle } from '../../components/ui';

const DRIVER_OPTIONS: { value: MailDriver; label: string; blurb: string }[] = [
  { value: 'none', label: 'None', blurb: 'Mail sending is disabled.' },
  { value: 'mailpit', label: 'Mailpit', blurb: 'The local catch-all. Nothing leaves the server.' },
  { value: 'smtp', label: 'SMTP', blurb: 'Send through your own SMTP server.' },
];

export default function MailSection() {
  const mailQuery = useMailConfig();

  return (
    <Card>
      <CardHeader
        icon={<MailIcon size={20} strokeWidth={ICON_STROKE} />}
        title="Mail"
        description="How Shipway sends invites and notifications. This is separate from a project's own SMTP settings."
      />

      <div className="mt-5">
        {mailQuery.isPending ? (
          <Skeleton className="h-80 w-full max-w-[640px]" />
        ) : mailQuery.isError || !mailQuery.data ? (
          <p role="alert" className="text-sm text-danger">
            Could not load mail settings.
          </p>
        ) : (
          <MailForm config={mailQuery.data} />
        )}
      </div>
    </Card>
  );
}

function MailForm({ config }: { config: MailConfig }) {
  const queryClient = useQueryClient();

  const [driver, setDriver] = useState<MailDriver>(config.driver);
  const [host, setHost] = useState(config.host);
  const [port, setPort] = useState(String(config.port));
  const [secure, setSecure] = useState(config.secure);
  const [username, setUsername] = useState(config.username ?? '');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState(config.fromAddress);
  const [fromName, setFromName] = useState(config.fromName ?? '');

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  function markDirty() {
    setDirty(true);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: MailConfigUpdate = { driver };
      if (driver === 'smtp') {
        body.host = host.trim();
        body.port = Number(port);
        body.secure = secure;
        if (username.trim() !== '') body.username = username.trim();
        if (password.trim() !== '') body.password = password;
        body.fromAddress = fromAddress.trim();
        if (fromName.trim() !== '') body.fromName = fromName.trim();
      }
      const updated = await putMailConfig(body);
      queryClient.setQueryData(['mail-config'], updated);
      setDirty(false);
      setPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save mail settings. Try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testMailConfig(testTo.trim()));
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof ApiError ? err.message : 'Could not reach the server. Try again.' });
    } finally {
      setTesting(false);
    }
  }

  const canSubmit = dirty && !saving && (driver !== 'smtp' || (host.trim() !== '' && port.trim() !== '' && fromAddress.trim() !== ''));
  const canTest = testTo.trim() !== '' && !testing && !dirty;

  return (
    <div className="flex max-w-[640px] flex-col gap-8">
      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-5" noValidate>
        <div role="radiogroup" aria-label="Mail driver" className="flex flex-col gap-2">
          {DRIVER_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`flex items-start gap-3 rounded-xl border px-4 py-3.5 transition-colors duration-150 ease-out ${
                driver === option.value ? 'border-focus bg-surface-2' : 'border-line bg-surface hover:bg-surface-2'
              }`}
            >
              <input
                type="radio"
                name="mail-driver"
                value={option.value}
                checked={driver === option.value}
                onChange={() => {
                  setDriver(option.value);
                  markDirty();
                }}
                className="mt-1 h-4 w-4 accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              />
              <span>
                <span className="block text-base font-semibold text-ink">{option.label}</span>
                <span className="block text-sm text-soft">{option.blurb}</span>
              </span>
            </label>
          ))}
        </div>

        {driver === 'mailpit' && <p className="rounded-xl bg-surface-2 px-4 py-3 font-mono text-sm text-soft">127.0.0.1:1025, no authentication.</p>}

        {driver === 'smtp' && (
          <div className="flex flex-col gap-4 rounded-xl bg-surface-2 p-4">
            <Field label="Host">
              <Input
                mono
                required
                value={host}
                onChange={(event) => {
                  setHost(event.target.value);
                  markDirty();
                }}
              />
            </Field>
            <Field label="Port">
              <Input
                mono
                required
                type="number"
                value={port}
                onChange={(event) => {
                  setPort(event.target.value);
                  markDirty();
                }}
              />
            </Field>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-ink">Use TLS</span>
              <Toggle
                checked={secure}
                onChange={(next) => {
                  setSecure(next);
                  markDirty();
                }}
                aria-label="Use TLS"
              />
            </div>
            <Field label="Username" hint="Optional.">
              <Input
                mono
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  markDirty();
                }}
              />
            </Field>
            <Field label="Password" hint="Leave blank to keep the current password.">
              <Input
                mono
                type="password"
                placeholder={config.password ?? undefined}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  markDirty();
                }}
              />
            </Field>
            <Field label="From address">
              <Input
                mono
                required
                type="email"
                value={fromAddress}
                onChange={(event) => {
                  setFromAddress(event.target.value);
                  markDirty();
                }}
              />
            </Field>
            <Field label="From name" hint="Optional.">
              <Input
                mono
                value={fromName}
                onChange={(event) => {
                  setFromName(event.target.value);
                  markDirty();
                }}
              />
            </Field>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div>
          <Button type="submit" loading={saving} disabled={!canSubmit}>
            Save
          </Button>
        </div>
      </form>

      <div className="flex flex-col gap-3 border-t border-line pt-6">
        <p className="text-sm font-medium text-ink">Send test email</p>
        <form onSubmit={(event) => void handleTest(event)} className="flex flex-wrap items-center gap-3">
          <Input mono type="email" required placeholder="you@example.com" value={testTo} onChange={(event) => setTestTo(event.target.value)} className="max-w-[280px]" />
          <Button type="submit" variant="secondary" loading={testing} disabled={!canTest}>
            Send test email
          </Button>
          {testResult?.ok && <Badge tone="ok">Test email sent</Badge>}
          {testResult && !testResult.ok && (
            <span role="alert" className="text-sm text-danger">
              {testResult.error ?? 'Could not send the test email.'}
            </span>
          )}
        </form>
        {dirty && <p className="text-[13px] text-soft">Save your changes before sending a test email.</p>}
      </div>
    </div>
  );
}
