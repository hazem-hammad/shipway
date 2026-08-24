/**
 * Settings tab: the project's PATCHable fields (task-24 controller ruling). Save is disabled until
 * dirty; a 502 from the server (config refresh failed after a runtime/publicDir/startCmd change)
 * renders the same calm {step, detail} panel as the project-creation flow.
 */
import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, patchProject, type PatchProjectBody, type Project } from '../../api';
import { useProject } from '../../hooks';
import { Button, Field, Input, Select, Skeleton } from '../../components/ui';

const PHP_VERSIONS = ['8.1', '8.2', '8.3', '8.4'];
const NODE_VERSIONS = ['18', '20', '22'];
const DEFAULT_PHP_VERSION = '8.3';
const DEFAULT_NODE_VERSION = '22';

const RUNTIME_HINT = 'Changing this updates the server config immediately.';

export default function SettingsTab({ projectId }: { projectId: number }) {
  const projectQuery = useProject(projectId);

  if (projectQuery.isPending) {
    return (
      <div className="flex max-w-[640px] flex-col gap-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (projectQuery.isError || !projectQuery.data) {
    return (
      <p role="alert" className="text-sm text-stop">
        Could not load project settings.
      </p>
    );
  }

  return <SettingsForm key={projectQuery.data.id} project={projectQuery.data} />;
}

function SettingsForm({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const isNodeLike = project.type === 'node' || project.type === 'nextjs';

  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.branch);
  const [phpVersion, setPhpVersion] = useState(project.phpVersion ?? DEFAULT_PHP_VERSION);
  const [nodeVersion, setNodeVersion] = useState(project.nodeVersion ?? DEFAULT_NODE_VERSION);
  const [publicDir, setPublicDir] = useState(project.publicDir ?? '');
  const [installCmd, setInstallCmd] = useState(project.installCmd ?? '');
  const [buildCmd, setBuildCmd] = useState(project.buildCmd ?? '');
  const [startCmd, setStartCmd] = useState(project.startCmd ?? '');
  const [healthCheckPath, setHealthCheckPath] = useState(project.healthCheckPath ?? '');
  const [autoDeploy, setAutoDeploy] = useState(project.autoDeploy);
  const [notifyWebhookUrl, setNotifyWebhookUrl] = useState(project.notifyWebhookUrl ?? '');

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [provisionError, setProvisionError] = useState<{ step: string; detail: string } | null>(null);

  function change<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
      setSaveError(null);
      setProvisionError(null);
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    setProvisionError(null);

    const body: PatchProjectBody = {
      name,
      branch,
      publicDir,
      installCmd,
      buildCmd,
      healthCheckPath: healthCheckPath.trim() === '' ? null : healthCheckPath.trim(),
      autoDeploy,
      notifyWebhookUrl: notifyWebhookUrl.trim() === '' ? null : notifyWebhookUrl.trim(),
      ...(project.type === 'php' ? { phpVersion } : {}),
      ...(isNodeLike ? { nodeVersion, startCmd } : {}),
    };

    try {
      await patchProject(project.id, body);
      await queryClient.invalidateQueries({ queryKey: ['project', project.id] });
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      setDirty(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        const payload = err.body as { step?: string; detail?: string } | undefined;
        setProvisionError({ step: payload?.step ?? 'unknown', detail: payload?.detail ?? err.message });
      } else {
        setSaveError(err instanceof ApiError ? err.message : 'Could not save settings. Try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex max-w-[640px] flex-col gap-6" noValidate>
      <Field label="Name">
        <Input required value={name} onChange={(event) => change(setName)(event.target.value)} />
      </Field>

      <Field label="Branch">
        <Input mono required value={branch} onChange={(event) => change(setBranch)(event.target.value)} />
      </Field>

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

      <Field label="Public directory" hint={RUNTIME_HINT}>
        <Input mono value={publicDir} onChange={(event) => change(setPublicDir)(event.target.value)} />
      </Field>

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

      <Field label="Health check path" hint="Checked after each deploy before the release goes live. Optional.">
        <Input mono placeholder="/up" value={healthCheckPath} onChange={(event) => change(setHealthCheckPath)(event.target.value)} />
      </Field>

      <Field label="Deploy notification webhook" hint="POSTed to on every deploy result. Optional.">
        <Input
          mono
          type="url"
          placeholder="https://"
          value={notifyWebhookUrl}
          onChange={(event) => change(setNotifyWebhookUrl)(event.target.value)}
        />
      </Field>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={autoDeploy}
          onChange={(event) => change(setAutoDeploy)(event.target.checked)}
          className="h-4 w-4 rounded border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          style={{ accentColor: 'var(--color-accent)' }}
        />
        Deploy automatically on push
      </label>

      {saveError && (
        <p role="alert" className="text-sm text-stop">
          {saveError}
        </p>
      )}

      {provisionError && (
        <div className="rounded-lg border border-stop/30 bg-stop/5 px-4 py-3">
          <p className="text-sm font-medium text-stop">Config refresh failed at {provisionError.step}</p>
          <p className="mt-1 text-sm text-ink-soft">{provisionError.detail}</p>
        </div>
      )}

      <div>
        <Button type="submit" loading={saving} disabled={!dirty || saving}>
          Save settings
        </Button>
      </div>
    </form>
  );
}
