/**
 * SMTP tab: mailpit (default) / custom / Amazon SES / none, as radio-cards. The server never returns
 * a saved config back to the client (`toPublicProject` strips `smtpConfigEncrypted` — see
 * server/src/routes/projects.ts), so switching into "custom" or "SES" always starts from blank
 * fields; saving replaces the whole stored config.
 *
 * SES is the same SMTP transport as "custom" with the endpoint derived instead of typed: the form
 * asks for a region plus SES SMTP credentials, and the server turns that into
 * `MAIL_HOST=email-smtp.<region>.amazonaws.com`, port 587, `MAIL_ENCRYPTION=tls` in the project's
 * `.env` (see `server/src/deploy/envfile.ts`). No host field is offered, so a project's mail can
 * never be pointed at a host that isn't SES.
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { ApiError, putProjectSmtp, type Project, type ProjectSmtpMode } from '../../api';
import { useProject, useSettings } from '../../hooks';
import { Button, Card, CardHeader, Field, ICON_STROKE, Input, Select, Skeleton } from '../../components/ui';
import { SES_DEFAULT_REGION, SES_REGIONS, SES_SMTP_PORT, sesSmtpHost } from '../../lib/ses';
import { SMTP_OPTIONS } from '../../lib/smtp';

type SmtpMode = ProjectSmtpMode;

export default function SmtpTab({ projectId }: { projectId: number }) {
  const projectQuery = useProject(projectId);
  const settingsQuery = useSettings();

  if (projectQuery.isPending) {
    return <Skeleton className="h-80 w-full rounded-2xl" />;
  }
  if (projectQuery.isError || !projectQuery.data) {
    return (
      <p role="alert" className="text-sm text-danger">
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
  const [region, setRegion] = useState(SES_DEFAULT_REGION);

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
        // SES sends no host/port/encryption: the server derives all three from the region.
        ...(mode === 'ses' ? { config: { region: region.trim(), username: username.trim(), password, fromAddress: fromAddress.trim() } } : {}),
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

  const customComplete = host.trim() !== '' && port.trim() !== '';
  // Every SES field is required — SES SMTP always authenticates, and the from-address has to be an
  // identity verified in SES for a send to be accepted at all.
  const sesComplete = region.trim() !== '' && username.trim() !== '' && password.trim() !== '' && fromAddress.trim() !== '';
  const canSubmit = dirty && !saving && (mode === 'custom' ? customComplete : mode === 'ses' ? sesComplete : true);

  return (
    <Card>
      <CardHeader icon={<Mail size={20} strokeWidth={ICON_STROKE} />} title="SMTP" description="How this project sends mail." />

      <form onSubmit={(event) => void handleSubmit(event)} className="mt-5 flex max-w-[640px] flex-col gap-5" noValidate>
        <div role="radiogroup" aria-label="SMTP mode" className="flex flex-col gap-2">
          {SMTP_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`flex items-start gap-3 rounded-xl border px-4 py-3.5 transition-colors duration-150 ease-out ${
                mode === option.value ? 'border-focus bg-surface-2' : 'border-line bg-surface hover:bg-surface-2'
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
                className="mt-1 h-4 w-4 accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              />
              <span>
                <span className="block text-base font-semibold text-ink">{option.label}</span>
                <span className="block text-sm text-soft">{option.blurb}</span>
              </span>
            </label>
          ))}
        </div>

        {mode === 'mailpit' && (
          <p className="rounded-xl bg-surface-2 px-4 py-3 font-mono text-sm text-soft">
            127.0.0.1:1025{baseDomain ? `, view at mail.${baseDomain}` : ''}
          </p>
        )}

        {mode === 'custom' && (
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

        {mode === 'ses' && (
          <div className="flex flex-col gap-4 rounded-xl bg-surface-2 p-4">
            <Field label="Region" hint="The AWS region your SES identity is verified in.">
              <Select
                mono
                required
                value={region}
                onChange={(event) => {
                  setRegion(event.target.value);
                  markDirty();
                }}
              >
                {/* A region saved before it was added here (or set via the API) still renders as the
                    selected option rather than silently snapping to another region. */}
                {!SES_REGIONS.includes(region) && region.trim() !== '' && <option value={region}>{region}</option>}
                {SES_REGIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="SMTP username"
              hint="From SES > SMTP settings > Create SMTP credentials. Not an AWS access key ID — SMTP auth rejects those."
            >
              <Input
                mono
                required
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  markDirty();
                }}
              />
            </Field>
            <Field label="SMTP password" hint="Shown only once by AWS when the credentials are created.">
              <Input
                mono
                required
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  markDirty();
                }}
              />
            </Field>
            <Field label="From address" hint="Must be an address or domain you've verified in SES.">
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
            <p className="font-mono text-[13px] text-soft">
              {region.trim() === '' ? 'Pick a region to see the endpoint.' : `${sesSmtpHost(region)}:${String(SES_SMTP_PORT)} (STARTTLS)`}
            </p>
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
    </Card>
  );
}
