/**
 * Settings tab: three sectioned cards (DESIGN.md's card-header pattern), each PATCHable and saved
 * independently — Save stays disabled until that card's own fields are dirty. A 502 from the server
 * (config refresh failed after a runtime/publicDir/startCmd change) renders a calm neutral panel
 * scoped to whichever card triggered it.
 */
import { type FormEvent, type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HeartPulse, Lock, Settings as SettingsIcon, Terminal } from 'lucide-react';
import { ApiError, patchProject, type PatchProjectBody, type Project } from '../../api';
import { useProject } from '../../hooks';
import { Button, Card, CardHeader, Field, ICON_STROKE, Input, Select, Skeleton, Toggle } from '../../components/ui';

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
      <BuildRuntimeCard key={`build-${String(project.id)}`} project={project} onSaved={() => void handleSaved()} />
      <HealthDeploysCard key={`health-${String(project.id)}`} project={project} onSaved={() => void handleSaved()} />
      <PasswordProtectionCard key={`auth-${String(project.id)}`} project={project} onSaved={() => void handleSaved()} />
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
