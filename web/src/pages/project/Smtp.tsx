/**
 * SMTP tab: mailpit (default) / custom / none, per the task-24 controller ruling. The server never
 * returns a saved custom config back to the client (`toPublicProject` strips `smtpConfigEncrypted`
 * — see server/src/routes/projects.ts), so switching into "custom" always starts from blank fields;
 * saving replaces the whole stored config.
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, putProjectSmtp, type Project } from '../../api';
import { useProject, useSettings } from '../../hooks';
import { Button, Field, Input, Skeleton } from '../../components/ui';

type SmtpMode = 'mailpit' | 'custom' | 'none';

const SMTP_OPTIONS: { value: SmtpMode; label: string; blurb: string }[] = [
  { value: 'mailpit', label: 'Mailpit', blurb: 'Local catch-all. Nothing leaves the server.' },
  { value: 'custom', label: 'Custom', blurb: 'Your own SMTP server.' },
  { value: 'none', label: 'None', blurb: 'Mail sending is disabled.' },
];

export default function SmtpTab({ projectId }: { projectId: number }) {
  const projectQuery = useProject(projectId);
  const settingsQuery = useSettings();

  if (projectQuery.isPending) {
    return <Skeleton className="h-64 w-full max-w-[640px]" />;
  }
  if (projectQuery.isError || !projectQuery.data) {
    return (
      <p role="alert" className="text-sm text-stop">
        Could not load SMTP settings.
      </p>
    );
  }

  return <SmtpForm key={projectQuery.data.id} project={projectQuery.data} baseDomain={settingsQuery.data?.base_domain ?? null} />;
}

function SmtpForm({ project, baseDomain }: { project: Project; baseDomain: string | null }) {
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<SmtpMode>(project.smtpMode);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [encryption, setEncryption] = useState('tls');

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function markDirty() {
    setDirty(true);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await putProjectSmtp(project.id, {
        mode,
        ...(mode === 'custom'
          ? {
              config: {
                host,
                port: Number(port),
                username: username.trim() === '' ? undefined : username,
                password: password.trim() === '' ? undefined : password,
                fromAddress: fromAddress.trim() === '' ? undefined : fromAddress,
                encryption: encryption.trim() === '' ? undefined : encryption,
              },
            }
          : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ['project', project.id] });
      await queryClient.invalidateQueries({ queryKey: ['project-env-preview', project.id] });
      setDirty(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save SMTP settings. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = dirty && !saving && (mode !== 'custom' || (host.trim() !== '' && port.trim() !== ''));

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex max-w-[640px] flex-col gap-6" noValidate>
      <div role="radiogroup" aria-label="SMTP mode" className="flex flex-col gap-2">
        {SMTP_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`flex items-start gap-2 rounded-md border px-3 py-2.5 transition-colors duration-150 ease-out ${
              mode === option.value ? 'border-accent bg-accent-soft' : 'border-line bg-paper hover:bg-panel'
            }`}
          >
            <input
              type="radio"
              name="smtp-mode"
              value={option.value}
              checked={mode === option.value}
              onChange={() => {
                setMode(option.value);
                markDirty();
              }}
              className="mt-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              style={{ accentColor: 'var(--color-accent)' }}
            />
            <span>
              <span className="block text-sm font-medium text-ink">{option.label}</span>
              <span className="block text-xs text-ink-soft">{option.blurb}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === 'mailpit' && (
        <p className="font-mono text-xs text-ink-soft">127.0.0.1:1025{baseDomain ? `, view at mail.${baseDomain}` : ''}</p>
      )}

      {mode === 'custom' && (
        <div className="flex flex-col gap-4">
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
          <Field label="Password" hint="Optional.">
            <Input
              mono
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                markDirty();
              }}
            />
          </Field>
          <Field label="From address" hint="Optional.">
            <Input
              mono
              type="email"
              value={fromAddress}
              onChange={(event) => {
                setFromAddress(event.target.value);
                markDirty();
              }}
            />
          </Field>
          <Field label="Encryption" hint="tls, ssl, or leave empty for none.">
            <Input
              mono
              value={encryption}
              onChange={(event) => {
                setEncryption(event.target.value);
                markDirty();
              }}
            />
          </Field>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-stop">
          {error}
        </p>
      )}

      <div>
        <Button type="submit" loading={saving} disabled={!canSubmit}>
          Save SMTP
        </Button>
      </div>
    </form>
  );
}
