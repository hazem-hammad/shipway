/**
 * Settings tab: sectioned cards (DESIGN.md's card-header pattern), each saved independently — Save
 * stays disabled until that card's own fields are dirty. A 502 from the server (config refresh
 * failed after a runtime/publicDir/startCmd change) renders a calm neutral panel scoped to whichever
 * card triggered it.
 *
 * Every card but Notifications PATCHes the project row itself; Notifications has its own endpoint
 * (`/api/projects/:id/notifications`) and its own query, since recipients and event opt-ins live in
 * their own tables. Notifications are a per-project feature — there is no instance-wide notification
 * settings page any more.
 */
import { type FormEvent, type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Bell, Copy, Globe, HeartPulse, Lock, Plus, Settings as SettingsIcon, Terminal, X } from 'lucide-react';
import {
  ApiError,
  cloneProject,
  patchProject,
  putProjectNotifications,
  testProjectNotifications,
  updateProjectSubdomain,
  type DatabaseListItem,
  type NotifyEvent,
  type PatchProjectBody,
  type Project,
  type ProjectNotifications,
  type SubdomainUpdateResponse,
} from '../../api';
import { useDatabases, useIsAdmin, useProject, useProjectNotifications, useSettings } from '../../hooks';
import { Badge, Button, Card, CardHeader, Checkbox, Chip, Field, ICON_STROKE, Input, ReadOnlyNotice, Select, Skeleton, Toggle } from '../../components/ui';
import { slugify, SLUG_RE } from '../../lib/slug';
import { projectHost } from '../../../../server/src/lib/domain.js';
import { IDENTIFIER_RE, isReservedDbName } from '../../../../server/src/services/dbconn.js';

const PHP_VERSIONS = ['8.1', '8.2', '8.3', '8.4'];
const NODE_VERSIONS = ['18', '20', '22'];
const DEFAULT_PHP_VERSION = '8.3';
const DEFAULT_NODE_VERSION = '22';

const RUNTIME_HINT = 'Changing this updates the server config immediately.';

interface ProvisionError {
  step: string;
  detail: string;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function SettingsTab({ projectId }: { projectId: number }) {
  const projectQuery = useProject(projectId);
  const queryClient = useQueryClient();

  if (projectQuery.isPending) {
    return (
      <div className="flex flex-col gap-5">
        <Skeleton className="h-52 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
        <Skeleton className="h-56 w-full rounded-2xl" />
      </div>
    );
  }
  if (projectQuery.isError || !projectQuery.data) {
    return (
      <p role="alert" className="text-sm text-danger">
        Could not load project settings.
      </p>
    );
  }

  const project = projectQuery.data;

  async function handleSaved() {
    await queryClient.invalidateQueries({ queryKey: ['project', project.id] });
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
  }

  return (
    <div className="flex flex-col gap-5">
      <GeneralCard key={`general-${String(project.id)}`} project={project} onSaved={() => void handleSaved()} />
      <DomainCard key={`domain-${String(project.id)}`} project={project} onSaved={() => void handleSaved()} />
      <BuildRuntimeCard key={`build-${String(project.id)}`} project={project} onSaved={() => void handleSaved()} />
      <HealthDeploysCard key={`health-${String(project.id)}`} project={project} onSaved={() => void handleSaved()} />
      <NotificationsCard key={`notifications-${String(project.id)}`} projectId={project.id} />
      <PasswordProtectionCard key={`auth-${String(project.id)}`} project={project} onSaved={() => void handleSaved()} />
      <CloneCard key={`clone-${String(project.id)}`} project={project} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications — who gets emailed about this project's deploys, and about what.
// ---------------------------------------------------------------------------

function NotificationsCard({ projectId }: { projectId: number }) {
  const query = useProjectNotifications(projectId);

  return (
    <Card>
      <CardHeader
        icon={<Bell size={20} strokeWidth={ICON_STROKE} />}
        title="Notifications"
        description="Email addresses that hear about this project's deploys."
      />
      <div className="mt-5">
        {query.isPending ? (
          <Skeleton className="h-64 w-full max-w-[560px]" />
        ) : query.isError || !query.data ? (
          <p role="alert" className="text-sm text-danger">
            Could not load notification settings.
          </p>
        ) : (
          <NotificationsForm projectId={projectId} config={query.data} />
        )}
      </div>
    </Card>
  );
}

function NotificationsForm({ projectId, config }: { projectId: number; config: ProjectNotifications }) {
  const queryClient = useQueryClient();

  // An always-present trailing blank row is what makes "add another" work without a separate empty
  // state: the list is never zero-length in the UI, and blanks are dropped on save.
  const [recipients, setRecipients] = useState<string[]>(config.recipients.length > 0 ? config.recipients : ['']);
  const [events, setEvents] = useState<Set<NotifyEvent>>(new Set(config.events.filter((e) => e.enabled).map((e) => e.event)));

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  function markDirty() {
    setDirty(true);
    setError(null);
    setTestResult(null);
  }

  function updateRecipient(index: number, value: string) {
    setRecipients((current) => current.map((email, i) => (i === index ? value : email)));
    markDirty();
  }

  function removeRecipient(index: number) {
    setRecipients((current) => {
      const next = current.filter((_, i) => i !== index);
      return next.length > 0 ? next : [''];
    });
    markDirty();
  }

  function toggleEvent(event: NotifyEvent, enabled: boolean) {
    setEvents((current) => {
      const next = new Set(current);
      if (enabled) next.add(event);
      else next.delete(event);
      return next;
    });
    markDirty();
  }

  async function handleSubmit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updated = await putProjectNotifications(projectId, {
        recipients: recipients.map((email) => email.trim()).filter((email) => email !== ''),
        events: [...events],
      });
      queryClient.setQueryData(['project-notifications', projectId], updated);
      // Re-seed from the server's normalized answer (trimmed, lowercased, deduped), so what's on
      // screen after a save is exactly what's stored.
      setRecipients(updated.recipients.length > 0 ? updated.recipients : ['']);
      setEvents(new Set(updated.events.filter((e) => e.enabled).map((e) => e.event)));
      setDirty(false);
    } catch (err) {
      setError(errorMessage(err, 'Could not save notification settings. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testProjectNotifications(projectId));
    } catch (err) {
      setTestResult({ ok: false, error: errorMessage(err, 'Could not reach the server. Try again.') });
    } finally {
      setTesting(false);
    }
  }

  const savedRecipientCount = config.recipients.length;
  const canTest = !testing && !dirty && savedRecipientCount > 0;

  return (
    <div className="flex max-w-[560px] flex-col gap-6">
      {!config.mailConfigured && (
        <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-soft">
          Instance mail isn&apos;t configured yet, so nothing will actually be sent. Set it up in Settings &gt; Mail.
        </p>
      )}

      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-5" noValidate>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-ink">Recipients</span>
          {recipients.map((email, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                mono
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => updateRecipient(index, event.target.value)}
                className="flex-1"
                aria-label={`Recipient ${String(index + 1)}`}
              />
              <button
                type="button"
                onClick={() => removeRecipient(index)}
                aria-label={`Remove recipient ${String(index + 1)}`}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-soft transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <X size={16} strokeWidth={ICON_STROKE} />
              </button>
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setRecipients((current) => [...current, '']);
                markDirty();
              }}
            >
              <Plus size={15} strokeWidth={ICON_STROKE} />
              Add email
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          <span className="text-sm font-medium text-ink">Send an email when</span>
          {config.events.map((meta) => (
            <Checkbox key={meta.event} checked={events.has(meta.event)} onChange={(next) => toggleEvent(meta.event, next)} label={meta.label} />
          ))}
        </div>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={saving} disabled={!dirty || saving}>
            Save
          </Button>
          <Button type="button" variant="secondary" loading={testing} disabled={!canTest} onClick={() => void handleTest()}>
            Send test email
          </Button>
          {testResult?.ok && <Badge tone="ok">Test email sent</Badge>}
          {testResult && !testResult.ok && (
            <span role="alert" className="text-sm text-danger">
              {testResult.error ?? 'Could not send the test email.'}
            </span>
          )}
        </div>
        {dirty && savedRecipientCount > 0 && <p className="text-[13px] text-soft">Save your changes before sending a test email.</p>}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared save row — error / 502 panel + the card's own Save button.
// ---------------------------------------------------------------------------

function SaveRow({
  saving,
  dirty,
  error,
  provisionError,
}: {
  saving: boolean;
  dirty: boolean;
  error: string | null;
  provisionError: ProvisionError | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {provisionError && (
        <div className="rounded-xl bg-surface-2 px-4 py-3">
          <p className="text-sm font-medium text-danger">Config refresh failed at {provisionError.step}</p>
          <p className="mt-1 text-sm text-soft">{provisionError.detail}</p>
        </div>
      )}
      <div>
        <Button type="submit" loading={saving} disabled={!dirty || saving}>
          Save
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// General — name, branch.
// ---------------------------------------------------------------------------

function GeneralCard({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.branch);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provisionError, setProvisionError] = useState<ProvisionError | null>(null);

  function change<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
      setError(null);
      setProvisionError(null);
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setProvisionError(null);
    try {
      await patchProject(project.id, { name, branch });
      onSaved();
      setDirty(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        const payload = err.body as { step?: string; detail?: string } | undefined;
        setProvisionError({ step: payload?.step ?? 'unknown', detail: payload?.detail ?? err.message });
      } else {
        setError(errorMessage(err, 'Could not save settings. Try again.'));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader icon={<SettingsIcon size={20} strokeWidth={ICON_STROKE} />} title="General" description="Name and the branch Shipway deploys." />
      <form onSubmit={(event) => void handleSubmit(event)} className="mt-5 flex max-w-[560px] flex-col gap-4" noValidate>
        <Field label="Name">
          <Input required value={name} onChange={(event) => change(setName)(event.target.value)} />
        </Field>
        <Field label="Branch">
          <Input mono required value={branch} onChange={(event) => change(setBranch)(event.target.value)} />
        </Field>
        <SaveRow saving={saving} dirty={dirty} error={error} provisionError={provisionError} />
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Domain — the subdomain this project is served at, and moving it.
// ---------------------------------------------------------------------------

/**
 * Changes where the project answers: its DNS `A` record, its nginx `server_name`, and the domain
 * wherever it appears in the project's env all move together (`PATCH /api/projects/:id/subdomain`).
 *
 * Its own card rather than a field in General for two reasons. It is admin-only where General is
 * not, and it is the one setting here whose save breaks every existing link to the site — so what
 * is about to happen is spelled out before the button, and what DID happen is reported after it
 * instead of the card silently going clean. The project's slug is deliberately NOT what changes:
 * it stays the internal name of the app directory, the units and the logs.
 */
function DomainCard({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const settingsQuery = useSettings();
  const baseDomain = settingsQuery.data?.base_domain ?? null;
  const canEdit = useIsAdmin();

  const current = projectHost(project);
  const [subdomain, setSubdomain] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provisionError, setProvisionError] = useState<ProvisionError | null>(null);
  const [result, setResult] = useState<SubdomainUpdateResponse | null>(null);

  const trimmed = subdomain.trim();
  const changed = trimmed !== current;
  const valid = SLUG_RE.test(trimmed);
  const shapeError = trimmed !== '' && !valid ? 'Lowercase letters, numbers and hyphens only.' : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setProvisionError(null);
    setResult(null);
    try {
      // `null` when it is being moved back to the slug — the server stores the default rather than a
      // redundant copy of the slug, and sends back the row it settled on either way.
      const response = await updateProjectSubdomain(project.id, trimmed === project.slug ? null : trimmed);
      setResult(response);
      setSubdomain(projectHost(response.project));
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        const payload = err.body as { step?: string; detail?: string } | undefined;
        setProvisionError({ step: payload?.step ?? 'unknown', detail: payload?.detail ?? err.message });
      } else {
        setError(errorMessage(err, 'Could not move the project. Try again.'));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        icon={<Globe size={20} strokeWidth={ICON_STROKE} />}
        title="Domain"
        description="The subdomain this project is served at. Changing it moves the DNS record and the nginx config."
      />

      <form onSubmit={(event) => void handleSubmit(event)} className="mt-5 flex max-w-[560px] flex-col gap-4" noValidate>
        <Field
          label="Subdomain"
          hint={baseDomain ? (valid ? `${trimmed}.${baseDomain}` : `<subdomain>.${baseDomain}`) : 'Set a base domain in Settings > General first.'}
          error={shapeError ?? undefined}
        >
          <Input mono required disabled={!canEdit} value={subdomain} onChange={(event) => setSubdomain(event.target.value)} />
        </Field>

        {changed && valid && (
          <div className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-soft">
            <p className="text-ink">Saving will:</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              <li className="flex gap-2">
                <span aria-hidden>&bull;</span>
                <span>
                  Point {baseDomain ? <Chip>{`${trimmed}.${baseDomain}`}</Chip> : <span className="text-ink">the new subdomain</span>} at this server and
                  remove the record for {baseDomain ? <Chip>{`${current}.${baseDomain}`}</Chip> : <span className="text-ink">the old one</span>}
                </span>
              </li>
              <li className="flex gap-2">
                <span aria-hidden>&bull;</span>
                <span>Rewrite the old domain wherever it appears in this project&rsquo;s environment variables, and restart what is running</span>
              </li>
              <li className="flex gap-2">
                <span aria-hidden>&bull;</span>
                <span>
                  Break every existing link to the old address. The project&rsquo;s name on this server &mdash; <Chip>{project.slug}</Chip> &mdash; does
                  not change.
                </span>
              </li>
            </ul>
          </div>
        )}

        {result && <MoveSummary result={result} />}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {provisionError && (
          <div className="rounded-xl bg-surface-2 px-4 py-3">
            <p className="text-sm font-medium text-danger">Move failed at {provisionError.step}</p>
            <p className="mt-1 text-sm text-soft">{provisionError.detail}</p>
            <p className="mt-1 text-sm text-soft">The project is still on its old subdomain &mdash; nothing was changed.</p>
          </div>
        )}

        {canEdit ? (
          <div>
            <Button type="submit" loading={saving} disabled={!changed || !valid || saving}>
              Move project
            </Button>
          </div>
        ) : (
          <ReadOnlyNotice can="change a project's subdomain" />
        )}
      </form>
    </Card>
  );
}

/** What the move actually did on the host — reported rather than assumed, because two parts of it
 *  are conditional: DNS is skipped entirely when Cloudflare isn't configured, and the env rewrite
 *  only happens when the old domain was in there. */
function MoveSummary({ result }: { result: SubdomainUpdateResponse }) {
  const { move } = result;
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-surface-2 px-4 py-3 text-sm text-soft">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="ok">Moved</Badge>
        <span>
          Now serving <Chip>{move.domain}</Chip>
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        <li className="flex gap-2">
          <span aria-hidden>&bull;</span>
          <span>
            {!move.dnsAttempted
              ? 'DNS was skipped — no Cloudflare credentials are configured, so point the record at this server yourself.'
              : move.created
                ? `DNS record created${move.oldRecordRemoved ? `, and the one for ${move.previousDomain} removed` : ''}.`
                : `A DNS record for ${move.domain} already existed${move.oldRecordRemoved ? `, and the one for ${move.previousDomain} was removed` : ''}.`}
          </span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden>&bull;</span>
          <span>
            {result.envRewritten
              ? result.envApplied
                ? 'The domain was updated in the environment variables and pushed to the running release.'
                : 'The domain was updated in the environment variables; it reaches the app on the next deploy.'
              : 'The old domain did not appear in the environment variables, so nothing there changed.'}
          </span>
        </li>
      </ul>
      {move.staleRecordWarning && (
        <p role="alert" className="text-danger">
          {move.staleRecordWarning}
        </p>
      )}
      <p>DNS can take a few minutes to propagate.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Build & runtime — runtime version, install/build/start commands, publicDir.
// ---------------------------------------------------------------------------

function BuildRuntimeCard({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const isNodeLike = project.type === 'node' || project.type === 'nextjs';
  const showPublicDir = project.type === 'php' || project.type === 'static';

  const [phpVersion, setPhpVersion] = useState(project.phpVersion ?? DEFAULT_PHP_VERSION);
  const [nodeVersion, setNodeVersion] = useState(project.nodeVersion ?? DEFAULT_NODE_VERSION);
  const [publicDir, setPublicDir] = useState(project.publicDir ?? '');
  const [installCmd, setInstallCmd] = useState(project.installCmd ?? '');
  const [buildCmd, setBuildCmd] = useState(project.buildCmd ?? '');
  const [startCmd, setStartCmd] = useState(project.startCmd ?? '');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provisionError, setProvisionError] = useState<ProvisionError | null>(null);

  function change<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
      setError(null);
      setProvisionError(null);
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setProvisionError(null);

    const body: PatchProjectBody = {
      installCmd,
      buildCmd,
      ...(showPublicDir ? { publicDir } : {}),
      ...(project.type === 'php' ? { phpVersion } : {}),
      ...(isNodeLike ? { nodeVersion, startCmd } : {}),
    };

    try {
      await patchProject(project.id, body);
      onSaved();
      setDirty(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        const payload = err.body as { step?: string; detail?: string } | undefined;
        setProvisionError({ step: payload?.step ?? 'unknown', detail: payload?.detail ?? err.message });
      } else {
        setError(errorMessage(err, 'Could not save settings. Try again.'));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        icon={<Terminal size={20} strokeWidth={ICON_STROKE} />}
        title="Build & runtime"
        description="Runtime version and the commands that install, build, and start this project."
      />
      <form onSubmit={(event) => void handleSubmit(event)} className="mt-5 flex max-w-[560px] flex-col gap-4" noValidate>
        {project.type === 'php' && (
          <Field label="PHP version" hint={RUNTIME_HINT}>
            <Select mono value={phpVersion} onChange={(event) => change(setPhpVersion)(event.target.value)}>
              {PHP_VERSIONS.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {isNodeLike && (
          <Field label="Node version" hint={RUNTIME_HINT}>
            <Select mono value={nodeVersion} onChange={(event) => change(setNodeVersion)(event.target.value)}>
              {NODE_VERSIONS.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="Install command">
          <Input mono value={installCmd} onChange={(event) => change(setInstallCmd)(event.target.value)} />
        </Field>

        <Field label="Build command">
          <Input mono value={buildCmd} onChange={(event) => change(setBuildCmd)(event.target.value)} />
        </Field>

        {isNodeLike && (
          <Field label="Start command">
            <Input mono value={startCmd} onChange={(event) => change(setStartCmd)(event.target.value)} />
          </Field>
        )}

        {showPublicDir && (
          <Field label="Public directory" hint={RUNTIME_HINT}>
            <Input mono value={publicDir} onChange={(event) => change(setPublicDir)(event.target.value)} />
          </Field>
        )}

        <SaveRow saving={saving} dirty={dirty} error={error} provisionError={provisionError} />
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Health & deploys — health check path, auto-deploy, notification webhook.
// ---------------------------------------------------------------------------

function HealthDeploysCard({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [healthCheckPath, setHealthCheckPath] = useState(project.healthCheckPath ?? '');
  const [autoDeploy, setAutoDeploy] = useState(project.autoDeploy);
  const [notifyWebhookUrl, setNotifyWebhookUrl] = useState(project.notifyWebhookUrl ?? '');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provisionError, setProvisionError] = useState<ProvisionError | null>(null);

  function change<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
      setError(null);
      setProvisionError(null);
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setProvisionError(null);

    const body: PatchProjectBody = {
      healthCheckPath: healthCheckPath.trim() === '' ? null : healthCheckPath.trim(),
      autoDeploy,
      notifyWebhookUrl: notifyWebhookUrl.trim() === '' ? null : notifyWebhookUrl.trim(),
    };

    try {
      await patchProject(project.id, body);
      onSaved();
      setDirty(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        const payload = err.body as { step?: string; detail?: string } | undefined;
        setProvisionError({ step: payload?.step ?? 'unknown', detail: payload?.detail ?? err.message });
      } else {
        setError(errorMessage(err, 'Could not save settings. Try again.'));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader icon={<HeartPulse size={20} strokeWidth={ICON_STROKE} />} title="Health & deploys" description="What happens after a build finishes." />
      <form onSubmit={(event) => void handleSubmit(event)} className="mt-5 flex max-w-[560px] flex-col gap-5" noValidate>
        <Field label="Health check path" hint="Checked after each deploy before the release goes live. Optional.">
          <Input mono placeholder="/up" value={healthCheckPath} onChange={(event) => change(setHealthCheckPath)(event.target.value)} />
        </Field>

        <ToggleRow
          label="Deploy automatically on push"
          description="Runs a deploy whenever the tracked branch receives a push."
          checked={autoDeploy}
          onChange={change(setAutoDeploy)}
        />

        <Field label="Deploy notification webhook" hint="POSTed to on every deploy result. Optional.">
          <Input
            mono
            type="url"
            placeholder="https://"
            value={notifyWebhookUrl}
            onChange={(event) => change(setNotifyWebhookUrl)(event.target.value)}
          />
        </Field>

        <SaveRow saving={saving} dirty={dirty} error={error} provisionError={provisionError} />
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Password protection — nginx basic auth in front of the project's public site.
// ---------------------------------------------------------------------------

function PasswordProtectionCard({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [authEnabled, setAuthEnabled] = useState(project.authEnabled);
  const [authUser, setAuthUser] = useState(project.authUser ?? '');
  const [authPassword, setAuthPassword] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provisionError, setProvisionError] = useState<ProvisionError | null>(null);

  function change<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
      setError(null);
      setProvisionError(null);
    };
  }

  // Enabling with nothing to enforce is rejected by the API (it would render an auth_basic_user_file
  // that doesn't exist); surface it here so Save isn't the thing that tells you.
  const needsPassword = authEnabled && !project.authPasswordSet && authPassword === '';
  const needsUser = authEnabled && authUser.trim() === '';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setProvisionError(null);

    const body: PatchProjectBody = {
      authEnabled,
      ...(authUser.trim() === '' ? {} : { authUser: authUser.trim() }),
      // Omitted when blank, so saving other changes doesn't clear an existing password.
      ...(authPassword === '' ? {} : { authPassword }),
    };

    try {
      await patchProject(project.id, body);
      onSaved();
      setDirty(false);
      setAuthPassword('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        const payload = err.body as { step?: string; detail?: string } | undefined;
        setProvisionError({ step: payload?.step ?? 'unknown', detail: payload?.detail ?? err.message });
      } else {
        setError(errorMessage(err, 'Could not save settings. Try again.'));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        icon={<Lock size={20} strokeWidth={ICON_STROKE} />}
        title="Password protection"
        description="Puts an HTTP basic auth prompt in front of the whole site. Gates who can reach it — it does not stop someone who has signed in from viewing the page source."
      />
      <form onSubmit={(event) => void handleSubmit(event)} className="mt-5 flex max-w-[560px] flex-col gap-5" noValidate>
        <ToggleRow
          label="Require a password"
          description="Every request to this project's domain must authenticate."
          checked={authEnabled}
          onChange={change(setAuthEnabled)}
        />

        {authEnabled && (
          <>
            <Field label="Username" error={needsUser ? 'Required.' : undefined}>
              <Input
                mono
                value={authUser}
                onChange={(event) => change(setAuthUser)(event.target.value)}
                placeholder="client"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>

            <Field
              label="Password"
              error={needsPassword ? 'Required — no password is stored yet.' : undefined}
              hint={project.authPasswordSet ? 'A password is set. Type a new one to replace it, or leave blank to keep it.' : 'Stored as a hash; it cannot be shown again afterwards.'}
            >
              <Input
                mono
                type="password"
                value={authPassword}
                onChange={(event) => change(setAuthPassword)(event.target.value)}
                placeholder={project.authPasswordSet ? '••••••••  (unchanged)' : ''}
                autoComplete="new-password"
              />
            </Field>
          </>
        )}

        <SaveRow saving={saving} dirty={dirty && !needsPassword && !needsUser} error={error} provisionError={provisionError} />
      </form>
    </Card>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-surface-2 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="mt-0.5 text-[13px] text-soft">{description}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} aria-label={label} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clone — a second copy of this project, on its own subdomain, with its own data.
// ---------------------------------------------------------------------------

/**
 * A database name suggested from the new subdomain: hyphens aren't legal in either engine's
 * unquoted identifiers, so they become underscores, and the result is trimmed to the 32 characters
 * `IDENTIFIER_RE` allows. Same rule as New Project's `dbNameFromSlug`.
 */
function suggestDbName(slug: string, index: number): string {
  const base = slug.replace(/-/g, '_').replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, '');
  const suffix = index === 0 ? '_db' : `_db${String(index + 1)}`;
  return `${base.slice(0, 32 - suffix.length)}${suffix}`;
}

/** Mirrors the server's own refusal, at the point the user can still fix the typo. */
function dbNameError(name: string): string | null {
  if (name === '') return 'Give the copy a name.';
  if (!IDENTIFIER_RE.test(name)) {
    return 'Lowercase letters, numbers, and underscores only, starting with a letter. Up to 32 characters.';
  }
  if (isReservedDbName(name)) {
    return `"${name}" is a system database name on MySQL or PostgreSQL. Pick another name.`;
  }
  return null;
}

/**
 * Clone project: asks for the new subdomain and a name for each copied database, then hands both to
 * `POST /api/projects/:id/clone`.
 *
 * The card states the blast radius the way the Danger tab does, but inverted — what WILL come across
 * and what won't — because the surprising part of a clone isn't what it copies, it's what it
 * doesn't: no deploy history, and a subdomain that serves nothing until the clone is deployed. The
 * databases are itemized by name for the same reason they are on delete: a copy of a production
 * database is the part of this action with real weight, and the names are what make it concrete.
 *
 * Deliberately NOT a typed confirmation: cloning creates, it never destroys, and PRODUCT.md reserves
 * that friction for the blast radius that deserves it.
 */
function CloneCard({ project }: { project: Project }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const settingsQuery = useSettings();
  const databasesQuery = useDatabases();

  const linkedDatabases = databasesQuery.data?.filter((database) => database.projectId === project.id) ?? [];
  const baseDomain = settingsQuery.data?.base_domain ?? null;

  const [name, setName] = useState(`${project.name} copy`);
  const [slug, setSlug] = useState(`${project.slug}-copy`);
  // Keyed by source database id, so a name the user typed survives the list reloading underneath it.
  const [dbNames, setDbNames] = useState<Record<number, string>>({});
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function nameFor(database: DatabaseListItem, index: number): string {
    return dbNames[database.id] ?? suggestDbName(slug, index);
  }

  const slugError = slug !== '' && !SLUG_RE.test(slug) ? 'Lowercase letters, numbers, and hyphens only. No leading or trailing hyphen.' : null;
  const dbErrors = linkedDatabases.map((database, index) => dbNameError(nameFor(database, index)));
  const canClone = SLUG_RE.test(slug) && name.trim() !== '' && dbErrors.every((issue) => issue === null) && !cloning;

  async function handleClone(event: FormEvent) {
    event.preventDefault();
    if (!canClone) return;
    setError(null);
    setCloning(true);
    try {
      const clone = await cloneProject(project.id, {
        name: name.trim(),
        slug,
        databases: linkedDatabases.map((database, index) => ({ sourceId: database.id, name: nameFor(database, index) })),
      });
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      await queryClient.invalidateQueries({ queryKey: ['databases'] });
      // Straight to the clone's own page: it exists, and the next thing anyone does with it is
      // deploy it, which is a button on the header of the page this lands on.
      navigate(`~/projects/${String(clone.id)}`);
    } catch (err) {
      setError(err instanceof ApiError ? cloneErrorMessage(err) : 'Could not clone the project. Try again.');
      setCloning(false);
    }
  }

  return (
    <Card>
      <CardHeader
        icon={<Copy size={20} strokeWidth={ICON_STROKE} />}
        title="Clone project"
        description="Creates a second project with these settings, on a new subdomain, with its own copy of the data."
      />

      <form onSubmit={(event) => void handleClone(event)} className="mt-5 flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Project name">
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (slug === `${project.slug}-copy`) setSlug(slugify(event.target.value));
              }}
            />
          </Field>
          <Field
            label="Subdomain"
            hint={baseDomain && SLUG_RE.test(slug) ? `${slug}.${baseDomain}` : undefined}
            error={slugError ?? undefined}
          >
            <Input mono value={slug} onChange={(event) => setSlug(event.target.value)} />
          </Field>
        </div>

        {linkedDatabases.length > 0 && (
          <div className="flex flex-col gap-4 rounded-xl bg-surface-2 p-4">
            <p className="text-sm text-soft">
              {linkedDatabases.length === 1 ? 'The linked database is copied' : `All ${String(linkedDatabases.length)} linked databases are copied`} in
              full &mdash; schema and rows &mdash; onto the same server. Name the {linkedDatabases.length === 1 ? 'copy' : 'copies'}:
            </p>
            {linkedDatabases.map((database, index) => (
              <Field
                key={database.id}
                label={`Copy of ${database.name}`}
                hint={`${database.engine === 'mysql' ? 'MySQL' : 'PostgreSQL'} · ${database.connectionName ?? 'unknown server'}`}
                error={dbErrors[index] ?? undefined}
              >
                <Input
                  mono
                  value={nameFor(database, index)}
                  onChange={(event) => setDbNames((prev) => ({ ...prev, [database.id]: event.target.value }))}
                />
              </Field>
            ))}
          </div>
        )}

        <div className="text-sm text-soft">
          <p className="text-ink">The clone gets:</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            <li className="flex gap-2">
              <span aria-hidden>&bull;</span>
              <span>
                The same repo, branch, build commands, deploy scripts, workers, cron entries and email settings
                {project.authEnabled ? ', including its password protection' : ''}
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden>&bull;</span>
              <span>
                A copy of the environment variables, with <Chip>DB_*</Chip> and the project&rsquo;s own domain rewritten to point at the clone
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden>&bull;</span>
              <span>Whatever is in the shared directory &mdash; uploads and storage</span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden>&bull;</span>
              <span className="text-faint">
                No deploy history and no releases: the new subdomain serves nothing until you deploy it
              </span>
            </li>
          </ul>
        </div>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div>
          <Button type="submit" variant="secondary" loading={cloning} disabled={!canClone}>
            Clone project
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * A clone failure in the user's terms. A 502 carries the step it died at (`server`'s
 * `CloneError.step`) and the engine's own words, which for a copy that failed is the useful half —
 * and worth saying plainly that nothing was left behind, since the alternative someone will assume
 * is a half-made project sitting on their server.
 */
function cloneErrorMessage(err: ApiError): string {
  const body = err.body as { step?: string; detail?: string } | undefined;
  if (err.status === 502 && body?.detail) {
    return body.step === 'copy'
      ? `The database copy failed: ${body.detail}. Nothing was created — the clone was removed.`
      : `Setting up the clone failed at ${body.step ?? 'an unknown step'}: ${body.detail}. Nothing was left behind.`;
  }
  return err.message;
}
