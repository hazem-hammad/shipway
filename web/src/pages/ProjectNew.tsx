/**
 * The project creation form (route `/projects/new`) — a real page, not a modal (DESIGN.md bans
 * modals). Submitting creates the project, immediately queues its first deploy, then navigates to
 * the project's page. The server only provisions on `POST /api/projects`; kicking off the deploy is
 * this page's job (see the controller ruling in the task brief).
 */
import { type FormEvent, useState } from 'react';
import { useLocation, Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, createProject, deployProject, type CreateProjectBody, type ProjectType } from '../api';
import { RepoPicker, type RepoPickerValue } from '../components/RepoPicker';
import { Button, Field, Input, PageHeader, Select } from '../components/ui';
import { slugify, SLUG_RE } from '../lib/slug';

interface TypeOption {
  value: ProjectType;
  label: string;
  blurb: string;
}

const TYPE_OPTIONS: TypeOption[] = [
  { value: 'php', label: 'PHP', blurb: 'composer install · public/' },
  { value: 'node', label: 'Node', blurb: 'npm ci · npm run build · npm start' },
  { value: 'nextjs', label: 'Next.js', blurb: 'npm ci · npm run build · npm start' },
  { value: 'static', label: 'Static', blurb: 'no build step' },
];

interface TypeDefaults {
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  publicDir: string;
}

/** Mirrors `defaultsForType` in `server/src/routes/projects.ts`, for display purposes only. */
const TYPE_DEFAULTS: Record<ProjectType, TypeDefaults> = {
  php: { installCmd: 'composer install --no-dev --optimize-autoloader --no-interaction', buildCmd: '', startCmd: '', publicDir: 'public' },
  node: { installCmd: 'npm ci', buildCmd: 'npm run build', startCmd: 'npm start', publicDir: '' },
  nextjs: { installCmd: 'npm ci', buildCmd: 'npm run build', startCmd: 'npm start', publicDir: '' },
  static: { installCmd: '', buildCmd: '', startCmd: '', publicDir: '' },
};

const PHP_VERSIONS = ['8.1', '8.2', '8.3', '8.4'];
const NODE_VERSIONS = ['18', '20', '22'];

interface ProvisionError {
  step: string;
  detail: string;
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
}

export default function ProjectNewPage() {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const [type, setType] = useState<ProjectType>('php');
  const [phpVersion, setPhpVersion] = useState('8.3');
  const [nodeVersion, setNodeVersion] = useState('22');
  const [repo, setRepo] = useState<RepoPickerValue | null>(null);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugConflict, setSlugConflict] = useState(false);

  const [publicDir, setPublicDir] = useState(TYPE_DEFAULTS.php.publicDir);
  const [installCmd, setInstallCmd] = useState(TYPE_DEFAULTS.php.installCmd);
  const [buildCmd, setBuildCmd] = useState(TYPE_DEFAULTS.php.buildCmd);
  const [startCmd, setStartCmd] = useState(TYPE_DEFAULTS.php.startCmd);
  const [healthCheckPath, setHealthCheckPath] = useState('');
  const [autoDeploy, setAutoDeploy] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [provisionError, setProvisionError] = useState<ProvisionError | null>(null);

  const isNodeLike = type === 'node' || type === 'nextjs';

  function handleTypeChange(next: ProjectType) {
    setType(next);
    const defaults = TYPE_DEFAULTS[next];
    setPublicDir(defaults.publicDir);
    setInstallCmd(defaults.installCmd);
    setBuildCmd(defaults.buildCmd);
    setStartCmd(defaults.startCmd);
  }

  function handleNameChange(value: string) {
    setName(value);
    if (!slugTouched) {
      setSlug(slugify(value));
      setSlugConflict(false);
    }
  }

  function handleSlugChange(value: string) {
    setSlugTouched(true);
    setSlug(value);
    setSlugConflict(false);
  }

  const slugFormatError =
    slug !== '' && !SLUG_RE.test(slug) ? 'Lowercase letters, numbers, and hyphens only. No leading or trailing hyphen.' : null;
  const slugError = slugConflict ? 'This slug is already in use.' : (slugFormatError ?? undefined);

  const canSubmit = name.trim() !== '' && slug !== '' && SLUG_RE.test(slug) && repo !== null && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || !repo) return;

    setFormError(null);
    setProvisionError(null);
    setSlugConflict(false);
    setSubmitting(true);

    const body: CreateProjectBody = {
      name,
      slug,
      repo: repo.repo,
      branch: repo.branch,
      type,
      publicDir,
      installCmd,
      buildCmd,
      healthCheckPath: healthCheckPath.trim() === '' ? null : healthCheckPath.trim(),
      autoDeploy,
      ...(type === 'php' ? { phpVersion } : {}),
      ...(isNodeLike ? { nodeVersion, startCmd } : {}),
    };

    try {
      const project = await createProject(body);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });

      // Best-effort: the project exists either way — if kicking off the first deploy fails, the
      // user can still deploy manually from the project page.
      try {
        await deployProject(project.id);
      } catch {
        // ignored — see comment above.
      }

      navigate(`/projects/${String(project.id)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSlugConflict(true);
      } else if (err instanceof ApiError && err.status === 502) {
        const payload = err.body as { step?: string; detail?: string } | undefined;
        setProvisionError({ step: payload?.step ?? 'unknown', detail: payload?.detail ?? err.message });
      } else {
        setFormError(errorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-[640px]">
      <PageHeader title="New project" />

      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-6" noValidate>
        <div>
          <span className="mb-2 block text-sm font-medium text-ink">Type</span>
          <div role="radiogroup" aria-label="Project type" className="grid grid-cols-2 gap-2">
            {TYPE_OPTIONS.map((option) => {
              const selected = type === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => handleTypeChange(option.value)}
                  className={`flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    selected ? 'border-accent bg-accent-soft' : 'border-line bg-paper hover:bg-panel'
                  }`}
                >
                  <span className="text-sm font-medium text-ink">{option.label}</span>
                  <span className="font-mono text-xs text-ink-soft">{option.blurb}</span>
                </button>
              );
            })}
          </div>
        </div>

        {type === 'php' && (
          <Field label="PHP version">
            <Select mono value={phpVersion} onChange={(event) => setPhpVersion(event.target.value)}>
              {PHP_VERSIONS.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {isNodeLike && (
          <Field label="Node version">
            <Select mono value={nodeVersion} onChange={(event) => setNodeVersion(event.target.value)}>
              {NODE_VERSIONS.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <div>
          <span className="mb-2 block text-sm font-medium text-ink">Repository</span>
          <RepoPicker value={repo} onChange={setRepo} />
        </div>

        <Field label="Name">
          <Input required autoFocus value={name} onChange={(event) => handleNameChange(event.target.value)} />
        </Field>

        <Field label="Slug" hint="Lowercase letters, numbers, and hyphens." error={slugError}>
          <Input mono required value={slug} onChange={(event) => handleSlugChange(event.target.value)} />
        </Field>

        <details className="rounded-md border border-line px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-ink">Advanced</summary>
          <div className="mt-4 flex flex-col gap-4">
            <Field label="Public directory" hint="Relative to the release root. Leave empty to serve the root.">
              <Input mono value={publicDir} onChange={(event) => setPublicDir(event.target.value)} />
            </Field>
            <Field label="Install command">
              <Input mono value={installCmd} onChange={(event) => setInstallCmd(event.target.value)} />
            </Field>
            <Field label="Build command">
              <Input mono value={buildCmd} onChange={(event) => setBuildCmd(event.target.value)} />
            </Field>
            {isNodeLike && (
              <Field label="Start command">
                <Input mono value={startCmd} onChange={(event) => setStartCmd(event.target.value)} />
              </Field>
            )}
            <Field label="Health check path" hint="Checked after each deploy before the release goes live. Optional.">
              <Input mono placeholder="/up" value={healthCheckPath} onChange={(event) => setHealthCheckPath(event.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={autoDeploy}
                onChange={(event) => setAutoDeploy(event.target.checked)}
                className="h-4 w-4 rounded border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                style={{ accentColor: 'var(--color-accent)' }}
              />
              Deploy automatically on push
            </label>
          </div>
        </details>

        {formError && (
          <p role="alert" className="text-sm text-stop">
            {formError}
          </p>
        )}

        {provisionError && (
          <div className="rounded-lg border border-stop/30 bg-stop/5 px-4 py-3">
            <p className="text-sm font-medium text-stop">Provisioning failed at {provisionError.step}</p>
            <p className="mt-1 text-sm text-ink-soft">{provisionError.detail}</p>
          </div>
        )}

        <div className="flex items-center gap-4">
          <Button type="submit" loading={submitting} disabled={!canSubmit}>
            Create project
          </Button>
          <Link
            href="/projects"
            className="rounded text-sm font-medium text-ink-soft underline decoration-line underline-offset-2 transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
