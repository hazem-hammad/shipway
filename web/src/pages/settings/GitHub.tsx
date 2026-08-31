/**
 * Settings > GitHub: create/configure the GitHub App and check its install status
 * (server/src/routes/github.ts). The manifest auto-submit flow is identical to the setup wizard's
 * step 4 — both share `submitManifestForm` from lib/github.ts so they can't drift. `?created=1`
 * lands here from the manifest callback's redirect (`/settings/github?created=1`, see github.ts).
 *
 * Restyled to the reference anatomy (DESIGN.md Cards / Buttons): a connected-app row with an
 * "Used for deploys" badge once installed, a plain install link + secondary "Detect installation"
 * while configured-but-not-installed, and "Create GitHub App" + a manual-fallback `<details>` while
 * unconfigured.
 */
import { type FormEvent, useState } from 'react';
import { useSearch } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, GitBranch } from 'lucide-react';
import {
  ApiError,
  fetchGithubManifest,
  putGithubApp,
  resolveGithubInstallation,
  type GithubInstallation,
  type GithubStatus,
  type ManualGithubAppBody,
} from '../../api';
import { submitManifestForm } from '../../lib/github';
import { useGithubStatus, useIsAdmin } from '../../hooks';
import {
  Badge,
  Button,
  buttonClasses,
  Card,
  CardHeader,
  Field,
  ICON_STROKE,
  IconChip,
  Input,
  ReadOnlyNotice,
  Skeleton,
  Textarea,
} from '../../components/ui';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const DESCRIPTION: Record<'not-configured' | 'not-installed' | 'installed', string> = {
  'not-configured': 'Shipway deploys from GitHub through a GitHub App scoped to the repositories you choose.',
  'not-installed': 'The app is created. Install it on an account or organization to start deploying from it.',
  installed: 'Shipway deploys from any repository this app is installed on.',
};

function stateFor(status: GithubStatus | undefined): 'not-configured' | 'not-installed' | 'installed' | null {
  if (!status) return null;
  if (!status.configured) return 'not-configured';
  if (!status.installed) return 'not-installed';
  return 'installed';
}

export default function GithubSection() {
  const statusQuery = useGithubStatus();
  const search = useSearch();
  const created = new URLSearchParams(search).get('created') === '1';
  const state = stateFor(statusQuery.data);

  return (
    <Card>
      <CardHeader
        icon={<GitBranch size={20} strokeWidth={ICON_STROKE} />}
        title="GitHub"
        description={state ? DESCRIPTION[state] : 'Shipway deploys from GitHub through a GitHub App.'}
      />

      <div className="mt-5">
        {created && (
          <p role="status" className="mb-4 text-sm text-ok">
            GitHub App created.
          </p>
        )}

        {statusQuery.isPending ? (
          <Skeleton className="h-16 w-full max-w-[640px]" />
        ) : statusQuery.isError || !statusQuery.data ? (
          <p role="alert" className="text-sm text-danger">
            Could not load GitHub App status.
          </p>
        ) : (
          <GithubStatusView status={statusQuery.data} />
        )}
      </div>
    </Card>
  );
}

function GithubStatusView({ status }: { status: GithubStatus }) {
  const canEdit = useIsAdmin();

  // Gated at the top rather than control-by-control, because every branch below is setup machinery:
  // creating the app, installing it, re-detecting the installation, entering credentials by hand.
  // None of it does anything for a member, and all of it 403s. What IS worth showing them is the
  // answer to "can this instance deploy from GitHub at all", which is what their own New Project
  // form depends on — so that state is rendered, and nothing else.
  if (!canEdit) {
    return <GithubStatusReadOnly status={status} />;
  }

  if (!status.configured) {
    return <NotConfigured />;
  }
  if (!status.installed) {
    return <NotInstalled appSlug={status.appSlug} />;
  }
  return <Installed appSlug={status.appSlug} />;
}

/** The member's view of Settings > GitHub: connection state, no setup actions. */
function GithubStatusReadOnly({ status }: { status: GithubStatus }) {
  const connected = status.configured && status.installed;

  return (
    <div className="flex max-w-[640px] flex-col gap-4">
      <div className="flex items-center gap-3.5 rounded-xl bg-surface-2 px-4 py-3.5">
        <IconChip>
          <GitBranch size={20} strokeWidth={ICON_STROKE} />
        </IconChip>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-ink">
            {connected ? `@${status.appSlug ?? 'unknown app'}` : 'Not connected'}
          </div>
          <div className="text-sm text-soft">
            {connected
              ? 'Shipway GitHub App'
              : status.configured
                ? 'The app is created but not installed on an account yet.'
                : 'No GitHub App is configured for this instance.'}
          </div>
        </div>
        {connected && (
          <Badge tone="ok" className="shrink-0">
            Used for deploys
          </Badge>
        )}
      </div>

      <ReadOnlyNotice can="change the GitHub connection" />
    </div>
  );
}

function Installed({ appSlug }: { appSlug: string | null }) {
  return (
    <div className="flex max-w-[640px] flex-col gap-4">
      <div className="flex items-center gap-3.5 rounded-xl bg-surface-2 px-4 py-3.5">
        <IconChip>
          <GitBranch size={20} strokeWidth={ICON_STROKE} />
        </IconChip>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-ink">@{appSlug ?? 'unknown app'}</div>
          <div className="text-sm text-soft">Shipway GitHub App</div>
        </div>
        <Badge tone="ok" className="shrink-0">
          Used for deploys
        </Badge>
      </div>

      {appSlug && (
        <a href={`https://github.com/apps/${appSlug}`} target="_blank" rel="noreferrer noopener" className={buttonClasses('secondary', 'md', 'w-fit')}>
          Manage on GitHub
          <ExternalLink size={16} strokeWidth={ICON_STROKE} aria-hidden />
        </a>
      )}

      <InstallationBinder label="Re-detect installation" />
    </div>
  );
}

/**
 * "Which account does Shipway deploy from?" — the detect button plus, when the app turns out to be
 * installed on several accounts, the picker to choose between them.
 *
 * Rendered in both the not-installed and installed states on purpose: re-pointing an already-bound
 * app is a real operation (moving from a personal installation to an organization one, say), and
 * the stored installationId goes stale the moment that old installation is removed on GitHub.
 */
function InstallationBinder({ label }: { label: string }) {
  const queryClient = useQueryClient();
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Populated only when the server reports several installations (409): the app is installed on
  // more than one account, so which one Shipway deploys from has to be an explicit choice.
  const [choices, setChoices] = useState<GithubInstallation[] | null>(null);

  async function bind(installationId?: number) {
    setError(null);
    setDetecting(true);
    try {
      await resolveGithubInstallation(installationId);
      setChoices(null);
      await queryClient.invalidateQueries({ queryKey: ['github-status'] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { installations?: GithubInstallation[] } | undefined;
        setChoices(body?.installations ?? []);
      } else {
        setError(errorMessage(err, 'Could not detect the installation. Try again.'));
      }
    } finally {
      setDetecting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {choices && (
        <div className="flex flex-col gap-2 rounded-xl bg-surface-2 px-4 py-3.5">
          <p className="text-sm text-soft">
            This app is installed on more than one account. Choose which one Shipway should deploy from.
          </p>
          {choices.map((inst) => (
            <div key={inst.id} className="flex items-center gap-3">
              <div className="min-w-0 flex-1 truncate text-sm text-ink">
                {inst.account ?? `installation ${String(inst.id)}`}
                <span className="text-soft">
                  {inst.accountType ? ` · ${inst.accountType}` : ''}
                  {inst.repositorySelection === 'selected' ? ' · selected repos' : ''}
                </span>
              </div>
              <Button variant="secondary" onClick={() => void bind(inst.id)} loading={detecting}>
                Use this
              </Button>
            </div>
          ))}
        </div>
      )}

      <div>
        <Button variant="secondary" onClick={() => void bind()} loading={detecting}>
          {label}
        </Button>
      </div>
    </div>
  );
}

function NotInstalled({ appSlug }: { appSlug: string | null }) {
  return (
    <div className="flex max-w-[640px] flex-col gap-3">
      {appSlug && (
        <a
          href={`https://github.com/apps/${appSlug}/installations/new`}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          Install the app on GitHub
          <ExternalLink size={13} strokeWidth={ICON_STROKE} aria-hidden />
        </a>
      )}
      <InstallationBinder label="Detect installation" />
    </div>
  );
}

function NotConfigured() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [org, setOrg] = useState('');

  async function handleCreate() {
    setError(null);
    setCreating(true);
    try {
      const { postUrl, manifestJson } = await fetchGithubManifest(window.location.origin, org.trim() || undefined);
      submitManifestForm(postUrl, manifestJson);
      // The browser navigates to github.com from here; nothing left to do client-side.
    } catch (err) {
      setError(errorMessage(err, 'Could not start GitHub App creation. Try again.'));
      setCreating(false);
    }
  }

  return (
    <div className="flex max-w-[640px] flex-col gap-4">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Field
        label="Organization (optional)"
        hint="Leave blank to create the app under your own GitHub account. An app owned by a personal account can only be installed on that account, so enter your org's login here to deploy org repositories."
      >
        <Input value={org} onChange={(event) => setOrg(event.target.value)} placeholder="my-org" autoComplete="off" spellCheck={false} />
      </Field>

      <div>
        <Button onClick={() => void handleCreate()} loading={creating}>
          Create GitHub App
        </Button>
      </div>

      <details className="rounded-xl bg-surface-2 px-4 py-3.5">
        <summary className="cursor-pointer rounded text-sm font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
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
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" loading={submitting}>
          Save
        </Button>
        {saved && <span className="text-sm text-ok">Saved.</span>}
      </div>
    </form>
  );
}
