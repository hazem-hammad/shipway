/**
 * Settings > GitHub: create/configure the GitHub App and check its install status
 * (server/src/routes/github.ts). The manifest auto-submit flow is identical to the setup wizard's
 * step 4 — both now share `submitManifestForm` from lib/github.ts (task-25 controller ruling) so
 * they can't drift. `?created=1` lands here from the manifest callback's redirect
 * (`/settings/github?created=1`, see github.ts).
 */
import { type FormEvent, useState } from 'react';
import { useSearch } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  fetchGithubManifest,
  putGithubApp,
  resolveGithubInstallation,
  type GithubStatus,
  type ManualGithubAppBody,
} from '../../api';
import { submitManifestForm } from '../../lib/github';
import { useGithubStatus } from '../../hooks';
import { BerthLight, Button, Field, Input, Skeleton, Textarea } from '../../components/ui';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function GithubSection() {
  const statusQuery = useGithubStatus();
  const search = useSearch();
  const created = new URLSearchParams(search).get('created') === '1';

  return (
    <div className="flex flex-col gap-4">
      {created && (
        <p role="status" className="text-sm text-go">
          GitHub App created.
        </p>
      )}

      {statusQuery.isPending ? (
        <Skeleton className="h-32 w-full max-w-[640px]" />
      ) : statusQuery.isError || !statusQuery.data ? (
        <p role="alert" className="text-sm text-stop">
          Could not load GitHub App status.
        </p>
      ) : (
        <GithubStatusView status={statusQuery.data} />
      )}
    </div>
  );
}

function GithubStatusView({ status }: { status: GithubStatus }) {
  if (!status.configured) {
    return <NotConfigured />;
  }
  if (!status.installed) {
    return <NotInstalled appSlug={status.appSlug} />;
  }
  return <Installed appSlug={status.appSlug} />;
}

function Installed({ appSlug }: { appSlug: string | null }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-panel/40 px-4 py-3">
      <BerthLight status="go" />
      <span className="text-sm font-medium text-ink">Connected as {appSlug ?? 'unknown app'}</span>
    </div>
  );
}

function NotInstalled({ appSlug }: { appSlug: string | null }) {
  const queryClient = useQueryClient();
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDetect() {
    setError(null);
    setDetecting(true);
    try {
      await resolveGithubInstallation();
      await queryClient.invalidateQueries({ queryKey: ['github-status'] });
    } catch (err) {
      setError(errorMessage(err, 'Could not detect the installation. Try again.'));
    } finally {
      setDetecting(false);
    }
  }

  return (
    <div className="flex max-w-[640px] flex-col gap-3">
      <p className="text-sm text-ink-soft">The GitHub App is created but not installed on any account or organization yet.</p>
      {appSlug && (
        <a
          href={`https://github.com/apps/${appSlug}/installations/new`}
          target="_blank"
          rel="noreferrer noopener"
          className="w-fit text-sm font-medium text-accent underline decoration-line underline-offset-2 hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Install the app on GitHub
        </a>
      )}
      {error && (
        <p role="alert" className="text-sm text-stop">
          {error}
        </p>
      )}
      <div>
        <Button variant="secondary" onClick={() => void handleDetect()} loading={detecting}>
          Detect installation
        </Button>
      </div>
    </div>
  );
}

function NotConfigured() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    setError(null);
    setCreating(true);
    try {
      const { postUrl, manifestJson } = await fetchGithubManifest(window.location.origin);
      submitManifestForm(postUrl, manifestJson);
      // The browser navigates to github.com from here; nothing left to do client-side.
    } catch (err) {
      setError(errorMessage(err, 'Could not start GitHub App creation. Try again.'));
      setCreating(false);
    }
  }

  return (
    <div className="flex max-w-[640px] flex-col gap-4">
      <p className="text-sm text-ink-soft">
        Shipway deploys from GitHub through a GitHub App scoped to the repositories you choose. Creating one takes you to
        GitHub and back.
      </p>
      {error && (
        <p role="alert" className="text-sm text-stop">
          {error}
        </p>
      )}
      <div>
        <Button onClick={() => void handleCreate()} loading={creating}>
          Create GitHub App
        </Button>
      </div>

      <details className="rounded-lg border border-line bg-panel/40 px-4 py-3">
        <summary className="cursor-pointer rounded text-sm font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          Configure manually
        </summary>
        <ManualAppForm />
      </details>
    </div>
  );
}

function ManualAppForm() {
  const queryClient = useQueryClient();
  const [appId, setAppId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      const body: ManualGithubAppBody = { appId: Number(appId), privateKey, webhookSecret };
      await putGithubApp(body);
      await queryClient.invalidateQueries({ queryKey: ['github-status'] });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err, 'Could not save the GitHub App. Try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="mt-4 flex flex-col gap-4" noValidate>
      <Field label="App ID">
        <Input mono required type="number" value={appId} onChange={(event) => setAppId(event.target.value)} />
      </Field>
      <Field label="Private key" hint="PEM-encoded, as downloaded from GitHub.">
        <Textarea mono required rows={8} spellCheck={false} value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} />
      </Field>
      <Field label="Webhook secret">
        <Input mono required type="password" value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-stop">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" loading={submitting}>
          Save
        </Button>
        {saved && <span className="text-sm text-go">Saved.</span>}
      </div>
    </form>
  );
}
