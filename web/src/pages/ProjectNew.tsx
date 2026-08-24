/**
 * New Project (route `/projects/new`) — an OpenShip-adapted two-step flow, entirely component
 * state (no sub-route/query-string for the step): pick a source (a GitHub App repo, or paste any
 * git URL), then configure the framework/runtime/deploy settings and hit Deploy.
 *
 * The server only provisions on `POST /api/projects`; this page's job (per the controller ruling
 * carried over from the v1 page) is to also set the env (if any was pasted) and kick off the first
 * deploy, then land the user on that deployment's live log.
 */
import { type FormEvent, useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Braces,
  ChevronDown,
  GitBranch,
  Globe,
  HeartPulse,
  Link2,
  Lock,
  Rocket,
  Search,
  Tag,
  Terminal,
  Zap,
} from 'lucide-react';
import {
  ApiError,
  createProject,
  deployProject,
  putProjectEnv,
  type CloudflareVerifyResult,
  type CreateProjectBody,
  type DnsOutcome,
  type GithubRepo,
  type ProjectType,
} from '../api';
import { useCloudflareVerify, useGithubBranches, useGithubRepos, useGithubStatus, useSettings } from '../hooks';
import { NextjsIcon, NodeIcon, PhpIcon, StaticIcon, type BrandIconProps } from '../components/BrandIcons';
import {
  Badge,
  type BadgeTone,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  Checkbox,
  Field,
  ICON_STROKE,
  IconChip,
  Input,
  PageHeader,
  PageWithRail,
  Select,
  Skeleton,
  Tabs,
  Textarea,
} from '../components/ui';
import { slugify, SLUG_RE } from '../lib/slug';

// ---------------------------------------------------------------------------
// Source (step 1) — a project's git origin: a GitHub App repo, or any git URL.
// ---------------------------------------------------------------------------

type Source = { kind: 'github'; repo: string; branch: string } | { kind: 'url'; repoUrl: string; branch: string };

/** Mirrors `REPO_URL_RE` in `server/src/routes/projects.ts` — client-side only, the server always
 * re-validates. */
const REPO_URL_RE = /^https?:\/\/\S+$/;

function isValidRepoUrl(url: string): boolean {
  return url.length > 0 && url.length <= 500 && REPO_URL_RE.test(url);
}

function sourceLabel(source: Source): string {
  return source.kind === 'github' ? source.repo : source.repoUrl;
}

/** A first-guess project name from the source, used to prefill Name/Slug once, at selection time,
 * only when the user hasn't already typed one. */
function suggestedNameFor(source: Source): string {
  if (source.kind === 'github') {
    return source.repo.split('/')[1] ?? source.repo;
  }
  try {
    const path = new URL(source.repoUrl).pathname;
    const last = path.split('/').filter(Boolean).pop() ?? '';
    return last.replace(/\.git$/, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Framework tiles + per-type defaults (mirrors `defaultsForType` in
// `server/src/routes/projects.ts`, for display/prefill purposes only).
// ---------------------------------------------------------------------------

interface TypeOption {
  value: ProjectType;
  label: string;
  blurb: string;
  Icon: (props: BrandIconProps) => React.JSX.Element;
}

const TYPE_OPTIONS: TypeOption[] = [
  { value: 'php', label: 'PHP', blurb: 'Laravel, Symfony, WordPress', Icon: PhpIcon },
  { value: 'node', label: 'Node.js', blurb: 'Express, Fastify, custom servers', Icon: NodeIcon },
  { value: 'nextjs', label: 'Next.js', blurb: 'React apps with SSR', Icon: NextjsIcon },
  { value: 'static', label: 'Static', blurb: 'Plain HTML, or a pre-built site', Icon: StaticIcon },
];

const TYPE_LABEL: Record<ProjectType, string> = { php: 'PHP', node: 'Node.js', nextjs: 'Next.js', static: 'Static' };

interface TypeDefaults {
  installCmd: string;
  buildCmd: string;
  startCmd: string;
}

const TYPE_DEFAULTS: Record<ProjectType, TypeDefaults> = {
  php: { installCmd: 'composer install --no-dev --optimize-autoloader --no-interaction', buildCmd: '', startCmd: '' },
  node: { installCmd: 'npm ci', buildCmd: 'npm run build', startCmd: 'npm start' },
  nextjs: { installCmd: 'npm ci', buildCmd: 'npm run build', startCmd: 'npm start' },
  static: { installCmd: '', buildCmd: '', startCmd: '' },
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long the Domain card's DNS result row stays visible before this page navigates away —
 * long enough to actually read a short line, short enough not to feel like a stall. */
const DNS_RESULT_DISPLAY_MS = 900;

// ---------------------------------------------------------------------------
// Domain card readiness — the create route can only make good on the DNS record it shows when
// BOTH the server IP is configured (needed as the record's content) AND Cloudflare is actually
// connected (needed to create it). Either gap means "create anyway" must be explicitly checked.
// ---------------------------------------------------------------------------

interface CloudflareStatus {
  pending: boolean;
  ready: boolean;
  tone: BadgeTone;
  label: string;
}

function cloudflareStatus(data: CloudflareVerifyResult | undefined, isPending: boolean, isError: boolean): CloudflareStatus {
  if (isPending) {
    return { pending: true, ready: false, tone: 'neutral', label: 'Checking Cloudflare…' };
  }
  if (isError || !data) {
    return { pending: false, ready: false, tone: 'danger', label: 'Cloudflare error' };
  }
  switch (data.reason) {
    case 'ok':
      return { pending: false, ready: true, tone: 'ok', label: 'Cloudflare connected' };
    case 'not_configured':
      return { pending: false, ready: false, tone: 'neutral', label: 'Cloudflare not configured' };
    default:
      return { pending: false, ready: false, tone: 'danger', label: 'Cloudflare error' };
  }
}

function dnsResultLine(outcome: DnsOutcome): string {
  if (outcome.error) return outcome.error;
  if (outcome.created) return 'DNS record created.';
  if (outcome.existed) return 'DNS record already existed.';
  return 'No DNS record was created.';
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProjectNewPage() {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const settingsQuery = useSettings();
  const cloudflareQuery = useCloudflareVerify();

  const [step, setStep] = useState<'source' | 'configure'>('source');
  const [sourceTab, setSourceTab] = useState<'github' | 'url'>('github');
  const [source, setSource] = useState<Source | null>(null);

  const [type, setType] = useState<ProjectType>('php');
  const [phpVersion, setPhpVersion] = useState('8.3');
  const [nodeVersion, setNodeVersion] = useState('22');
  const [installCmd, setInstallCmd] = useState(TYPE_DEFAULTS.php.installCmd);
  const [buildCmd, setBuildCmd] = useState(TYPE_DEFAULTS.php.buildCmd);
  const [startCmd, setStartCmd] = useState(TYPE_DEFAULTS.php.startCmd);
  const [healthCheckPath, setHealthCheckPath] = useState('');
  const [envContent, setEnvContent] = useState('');

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugApiError, setSlugApiError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [provisionError, setProvisionError] = useState<ProvisionError | null>(null);

  // "Create anyway without a DNS record" — required only while dnsReady is false (spec §3 "New
  // Project DNS"); cleared to false whenever the underlying gap changes so a stale ack from a
  // previous, different reason can never silently carry over.
  const [createAnyway, setCreateAnyway] = useState(false);
  // Set right after a successful create, briefly, so the Domain card can show what actually
  // happened to DNS before this page navigates to the deployment log (see handleDeploy).
  const [dnsResult, setDnsResult] = useState<DnsOutcome | null>(null);

  const isNodeLike = type === 'node' || type === 'nextjs';
  const baseDomain = settingsQuery.data?.base_domain ?? 'your-domain';
  const serverIp = settingsQuery.data?.server_ip ?? null;
  const settingsSettled = !settingsQuery.isPending;
  const serverIpMissing = settingsSettled && serverIp === null;
  const cfStatus = cloudflareStatus(cloudflareQuery.data, cloudflareQuery.isPending, cloudflareQuery.isError);
  const dnsReady = settingsSettled && !serverIpMissing && cfStatus.ready;

  function handleTypeChange(next: ProjectType) {
    setType(next);
    const defaults = TYPE_DEFAULTS[next];
    setInstallCmd(defaults.installCmd);
    setBuildCmd(defaults.buildCmd);
    setStartCmd(defaults.startCmd);
  }

  function handleNameChange(value: string) {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
    setSlugApiError(null);
  }

  function handleSlugChange(value: string) {
    setSlugTouched(true);
    setSlug(value);
    setSlugApiError(null);
  }

  /** Advances to step 2, prefilling Name/Slug from the source only the first time (the user hasn't
   * typed a name yet). */
  function selectSource(next: Source) {
    setSource(next);
    if (name.trim() === '') {
      const suggestion = suggestedNameFor(next);
      setName(suggestion);
      if (!slugTouched) setSlug(slugify(suggestion));
    }
    setStep('configure');
  }

  const slugFormatError =
    slug !== '' && !SLUG_RE.test(slug) ? 'Lowercase letters, numbers, and hyphens only. No leading or trailing hyphen.' : null;
  const slugError = slugApiError ?? slugFormatError ?? undefined;

  const branch = source?.branch ?? '';
  const canSubmit =
    source !== null &&
    name.trim() !== '' &&
    slug !== '' &&
    SLUG_RE.test(slug) &&
    branch.trim() !== '' &&
    !submitting &&
    (dnsReady || createAnyway);

  function setBranch(next: string) {
    if (!source) return;
    setSource({ ...source, branch: next });
  }

  async function handleDeploy(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || !source) return;

    setFormError(null);
    setProvisionError(null);
    setSlugApiError(null);
    setDnsResult(null);
    setSubmitting(true);

    const body: CreateProjectBody = {
      name,
      slug,
      branch: source.branch,
      type,
      ...(source.kind === 'github' ? { repo: source.repo } : { repoUrl: source.repoUrl }),
      installCmd,
      buildCmd,
      healthCheckPath: healthCheckPath.trim() === '' ? null : healthCheckPath.trim(),
      ...(type === 'php' ? { phpVersion } : {}),
      ...(isNodeLike ? { nodeVersion, startCmd } : {}),
    };

    try {
      const project = await createProject(body);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      await queryClient.invalidateQueries({ queryKey: ['overview'] });

      // Surface the DNS outcome in the Domain card for a short beat before navigating away — the
      // simpler of the two approaches the plan allows (the alternative, passing the outcome
      // through to the deployment log page, has nowhere to land: wouter's `navigate` carries no
      // location state, and coupling the deployment log — a surface other work on this project
      // owns — to a one-time "how did project creation's DNS step go" payload would outlive its
      // usefulness the moment the user leaves this page anyway).
      setDnsResult(project.dns);
      await sleep(DNS_RESULT_DISPLAY_MS);

      // Env is set post-create (PUT), before the first deploy, only when something was pasted.
      if (envContent.trim() !== '') {
        try {
          await putProjectEnv(project.id, envContent);
        } catch {
          // Best-effort — the project exists either way; env can still be set from its page.
        }
      }

      try {
        const { deploymentId } = await deployProject(project.id);
        navigate(`/projects/${String(project.id)}/deployments/${String(deploymentId)}`);
      } catch {
        // Best-effort, matching the create-then-deploy split above — land on the project instead.
        navigate(`/projects/${String(project.id)}`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSlugApiError(err.message === 'this name is reserved' ? 'This name is reserved.' : 'This slug is already in use.');
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

  if (step === 'source') {
    return (
      <div>
        <PageHeader title="New Project" subtitle="Import a repository or paste a URL" />
        <SourceStep tab={sourceTab} onTabChange={setSourceTab} onSelect={selectSource} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Configure" subtitle="Framework, runtime, and deploy settings." />
      <form onSubmit={(event) => void handleDeploy(event)} noValidate>
        <SourceChip source={source} onChange={() => setStep('source')} />

        <PageWithRail
          className="mt-5"
          rail={
            <ConfigureRail
              source={source}
              onBranchChange={setBranch}
              slug={slug}
              baseDomain={baseDomain}
              serverIp={serverIp}
              serverIpMissing={serverIpMissing}
              settingsSettled={settingsSettled}
              cloudflare={cfStatus}
              dnsReady={dnsReady}
              createAnyway={createAnyway}
              onCreateAnywayChange={setCreateAnyway}
              dnsResult={dnsResult}
              type={type}
              buildCmd={buildCmd}
              submitting={submitting}
              canSubmit={canSubmit}
              formError={formError}
              provisionError={provisionError}
            />
          }
        >
          <FrameworkTiles type={type} onChange={handleTypeChange} />

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
            <Field label="Node.js version">
              <Select mono value={nodeVersion} onChange={(event) => setNodeVersion(event.target.value)}>
                {NODE_VERSIONS.map((version) => (
                  <option key={version} value={version}>
                    {version}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <DeployConfigDetails
            installCmd={installCmd}
            buildCmd={buildCmd}
            startCmd={startCmd}
            isNodeLike={isNodeLike}
            onInstallCmd={setInstallCmd}
            onBuildCmd={setBuildCmd}
            onStartCmd={setStartCmd}
          />

          <EnvVarsCard value={envContent} onChange={setEnvContent} />

          <HealthCheckCard value={healthCheckPath} onChange={setHealthCheckPath} />

          <ProjectNameCard name={name} slug={slug} slugError={slugError} onNameChange={handleNameChange} onSlugChange={handleSlugChange} />
        </PageWithRail>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — source
// ---------------------------------------------------------------------------

function SourceStep({
  tab,
  onTabChange,
  onSelect,
}: {
  tab: 'github' | 'url';
  onTabChange: (tab: 'github' | 'url') => void;
  onSelect: (source: Source) => void;
}) {
  return (
    <div>
      <div role="tablist" className="mb-5 flex items-center gap-1.5">
        <SourcePill active={tab === 'github'} icon={<GitBranch size={16} strokeWidth={ICON_STROKE} />} label="GitHub" onClick={() => onTabChange('github')} />
        <SourcePill active={tab === 'url'} icon={<Link2 size={16} strokeWidth={ICON_STROKE} />} label="Git URL" onClick={() => onTabChange('url')} />
      </div>

      {tab === 'github' ? <GithubSourceTab onSelect={onSelect} /> : <GitUrlSourceTab onSelect={onSelect} />}
    </div>
  );
}

function SourcePill({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex h-9 items-center gap-2 rounded-full px-4 text-base font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        active ? 'bg-surface-3 text-ink' : 'text-soft hover:bg-surface-2 hover:text-ink'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ---- GitHub tab ----

function GithubSourceTab({ onSelect }: { onSelect: (source: Source) => void }) {
  const statusQuery = useGithubStatus();
  const installed = statusQuery.data?.installed === true;
  const reposQuery = useGithubRepos(installed);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'public' | 'private'>('all');

  const repos = reposQuery.data ?? [];
  const total = repos.length;
  const publicCount = repos.filter((r) => !r.private).length;
  const privateCount = repos.filter((r) => r.private).length;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return repos
      .filter((r) => (filter === 'all' ? true : filter === 'private' ? r.private : !r.private))
      .filter((r) => (query === '' ? true : r.fullName.toLowerCase().includes(query)));
  }, [repos, search, filter]);

  return (
    <PageWithRail
      rail={
        <>
          <Card>
            <CardHeader
              icon={<GitBranch size={20} strokeWidth={ICON_STROKE} />}
              title="Shipway GitHub App"
              description={statusQuery.data ? undefined : 'Checking connection…'}
              action={
                statusQuery.data ? (
                  installed ? (
                    <Badge tone="ok">Connected</Badge>
                  ) : (
                    <Badge>Not connected</Badge>
                  )
                ) : undefined
              }
            />
            {statusQuery.data && !installed && (
              <Link href="/settings/github" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-link hover:underline">
                Connect GitHub →
              </Link>
            )}
          </Card>

          <Card>
            <CardHeader title="Overview" description={`${String(total)} ${total === 1 ? 'repository' : 'repositories'}`} />
            <div className="mt-4 flex flex-col gap-0.5">
              <OverviewRow label="Total" value={total} />
              <OverviewRow label="Public" value={publicCount} />
              <OverviewRow label="Private" value={privateCount} />
            </div>
          </Card>

          <div className="rounded-2xl border border-line bg-surface-2 p-5">
            <IconChip tone="orange" size={36}>
              <Zap size={18} strokeWidth={ICON_STROKE} />
            </IconChip>
            <p className="mt-3 text-sm text-ink">
              Select any repository to deploy it instantly. Configure automatic deployments on every push.
            </p>
          </div>
        </>
      }
    >
      <Card>
        {statusQuery.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : !installed ? (
          <NotInstalledNotice configured={statusQuery.data?.configured ?? false} />
        ) : (
          <>
            <div className="flex flex-col gap-3 min-[640px]:flex-row min-[640px]:items-center">
              <span className="relative block flex-1">
                <Search size={16} strokeWidth={ICON_STROKE} aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-icon" />
                <Input
                  type="search"
                  placeholder="Search repositories"
                  aria-label="Search repositories"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="pl-10"
                />
              </span>
              <Tabs
                tabs={[
                  { id: 'all', label: 'All', count: total },
                  { id: 'public', label: 'Public', count: publicCount },
                  { id: 'private', label: 'Private', count: privateCount },
                ]}
                value={filter}
                onChange={(id) => setFilter(id as typeof filter)}
              />
            </div>

            <div className="mt-4">
              {reposQuery.isPending ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                </div>
              ) : reposQuery.isError ? (
                <p role="alert" className="text-sm text-danger">
                  Could not load repositories.
                </p>
              ) : filtered.length === 0 ? (
                <p className="py-8 text-center text-sm text-soft">No repositories match.</p>
              ) : (
                <div className="divide-y divide-line">
                  {filtered.map((repo) => (
                    <RepoRow key={repo.fullName} repo={repo} onSelect={() => onSelect({ kind: 'github', repo: repo.fullName, branch: repo.defaultBranch })} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </Card>
    </PageWithRail>
  );
}

function OverviewRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between px-1 py-1.5">
      <span className="text-sm text-soft">{label}</span>
      <span className="text-base font-semibold text-ink">{value}</span>
    </div>
  );
}

function NotInstalledNotice({ configured }: { configured: boolean }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line bg-surface-2 px-5 py-6">
      <IconChip>
        <GitBranch size={20} strokeWidth={ICON_STROKE} />
      </IconChip>
      <div>
        <p className="text-base font-semibold text-ink">GitHub isn't connected yet</p>
        <p className="mt-1 text-sm text-soft">
          {configured
            ? "The GitHub App is configured but isn't installed on any repositories yet."
            : 'Connect the Shipway GitHub App to browse and deploy your repositories.'}
        </p>
      </div>
      <ButtonLink href="/settings/github" variant="secondary">
        Connect GitHub
      </ButtonLink>
    </div>
  );
}

function RepoRow({ repo, onSelect }: { repo: GithubRepo; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <IconChip size={36} tone={repo.private ? 'purple' : 'neutral'}>
        {repo.private ? <Lock size={16} strokeWidth={ICON_STROKE} /> : <Globe size={16} strokeWidth={ICON_STROKE} />}
      </IconChip>
      <span className="min-w-0 flex-1 truncate font-semibold text-ink">{repo.fullName}</span>
      {repo.private && <Badge>Private</Badge>}
      <ArrowRight size={18} strokeWidth={ICON_STROKE} aria-hidden className="shrink-0 text-icon opacity-60 transition-opacity duration-150 ease-out group-hover:opacity-100" />
    </button>
  );
}

// ---- Git URL tab ----

function GitUrlSourceTab({ onSelect }: { onSelect: (source: Source) => void }) {
  const [url, setUrl] = useState('');
  const [touched, setTouched] = useState(false);

  const error = touched && url !== '' && !isValidRepoUrl(url) ? 'Enter a valid http(s) git URL.' : undefined;

  function handleContinue(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!isValidRepoUrl(url)) return;
    onSelect({ kind: 'url', repoUrl: url, branch: 'main' });
  }

  return (
    <Card className="max-w-[640px]">
      <CardHeader icon={<Link2 size={20} strokeWidth={ICON_STROKE} />} title="Paste a git URL" description="Any public repository, or a private one with a token embedded." />
      <form onSubmit={handleContinue} className="mt-5 flex flex-col gap-4" noValidate>
        <Field label="Repository URL" hint="Public repos, or embed a token for private ones." error={error}>
          <Input
            mono
            required
            autoFocus
            placeholder="https://github.com/acme/app.git"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setTouched(false);
            }}
            onBlur={() => setTouched(true)}
          />
        </Field>
        <div>
          <Button type="submit" disabled={url.trim() === ''}>
            Continue
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — configure
// ---------------------------------------------------------------------------

function SourceChip({ source, onChange }: { source: Source | null; onChange: () => void }) {
  if (!source) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3">
      <IconChip size={36}>{source.kind === 'github' ? <GitBranch size={18} strokeWidth={ICON_STROKE} /> : <Link2 size={18} strokeWidth={ICON_STROKE} />}</IconChip>
      <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink">{sourceLabel(source)}</span>
      <button type="button" onClick={onChange} className="shrink-0 text-sm font-medium text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
        Change
      </button>
    </div>
  );
}

function FrameworkTiles({ type, onChange }: { type: ProjectType; onChange: (type: ProjectType) => void }) {
  return (
    <div role="radiogroup" aria-label="Framework" className="grid grid-cols-2 gap-3 min-[640px]:grid-cols-4">
      {TYPE_OPTIONS.map((option) => {
        const selected = type === option.value;
        const Icon = option.Icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={`flex flex-col items-start gap-3 rounded-2xl p-4 text-left transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              selected ? 'border-2 border-focus bg-surface-2' : 'border border-line bg-surface hover:bg-surface-2'
            }`}
          >
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-surface-2">
              <Icon size={28} />
            </span>
            <span className="text-base font-semibold text-ink">{option.label}</span>
            <span className="text-[13px] text-soft">{option.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}

function DeployConfigDetails({
  installCmd,
  buildCmd,
  startCmd,
  isNodeLike,
  onInstallCmd,
  onBuildCmd,
  onStartCmd,
}: {
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  isNodeLike: boolean;
  onInstallCmd: (v: string) => void;
  onBuildCmd: (v: string) => void;
  onStartCmd: (v: string) => void;
}) {
  return (
    <details open className="group rounded-2xl border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-3.5 p-6 [&::-webkit-details-marker]:hidden">
        <IconChip>
          <Terminal size={20} strokeWidth={ICON_STROKE} />
        </IconChip>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold text-ink">Deploy configuration</h2>
          <p className="mt-0.5 text-sm text-soft">Install, build, and start commands for this project.</p>
        </div>
        <ChevronDown size={18} strokeWidth={ICON_STROKE} aria-hidden className="shrink-0 text-icon transition-transform duration-150 ease-out group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-4 px-6 pb-6">
        <Field label="Install command">
          <Input mono value={installCmd} onChange={(event) => onInstallCmd(event.target.value)} />
        </Field>
        <Field label="Build command">
          <Input mono value={buildCmd} onChange={(event) => onBuildCmd(event.target.value)} />
        </Field>
        {isNodeLike && (
          <Field label="Start command">
            <Input mono value={startCmd} onChange={(event) => onStartCmd(event.target.value)} />
          </Field>
        )}
      </div>
    </details>
  );
}

function EnvVarsCard({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const lineCount = value === '' ? 0 : value.split('\n').filter((line) => line.trim() !== '').length;
  return (
    <Card>
      <CardHeader icon={<Braces size={20} strokeWidth={ICON_STROKE} />} title="Environment variables" description="Paste your .env. Set after the project is created, before the first deploy." />
      <div className="mt-4 flex flex-col gap-1.5">
        <Textarea mono rows={6} placeholder={'APP_KEY=\nDB_HOST=127.0.0.1'} value={value} onChange={(event) => onChange(event.target.value)} />
        <div className="flex items-center justify-between text-[13px] text-soft">
          <span>.env format</span>
          <span>
            {lineCount} {lineCount === 1 ? 'variable' : 'variables'}
          </span>
        </div>
      </div>
    </Card>
  );
}

function HealthCheckCard({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Card>
      <CardHeader icon={<HeartPulse size={20} strokeWidth={ICON_STROKE} />} title="Health checks" description="Checked after each deploy before the release goes live." />
      <div className="mt-4">
        <Field label="Path" hint={value.trim() === '' ? 'Off. The deploy finishes as soon as the app starts.' : undefined}>
          <Input mono placeholder="/up" value={value} onChange={(event) => onChange(event.target.value)} />
        </Field>
      </div>
    </Card>
  );
}

function ProjectNameCard({
  name,
  slug,
  slugError,
  onNameChange,
  onSlugChange,
}: {
  name: string;
  slug: string;
  slugError: string | undefined;
  onNameChange: (v: string) => void;
  onSlugChange: (v: string) => void;
}) {
  return (
    <Card>
      <CardHeader icon={<Tag size={20} strokeWidth={ICON_STROKE} />} title="Project name" description="Used for the URL slug and process names." />
      <div className="mt-4 flex flex-col gap-4">
        <Field label="Name">
          <Input required value={name} onChange={(event) => onNameChange(event.target.value)} />
        </Field>
        <Field label="Slug" hint={slugError ? undefined : 'Lowercase letters, numbers, and hyphens.'} error={slugError}>
          <Input mono required value={slug} onChange={(event) => onSlugChange(event.target.value)} />
        </Field>
      </div>
    </Card>
  );
}

// ---- right rail ----

function ConfigureRail({
  source,
  onBranchChange,
  slug,
  baseDomain,
  serverIp,
  serverIpMissing,
  settingsSettled,
  cloudflare,
  dnsReady,
  createAnyway,
  onCreateAnywayChange,
  dnsResult,
  type,
  buildCmd,
  submitting,
  canSubmit,
  formError,
  provisionError,
}: {
  source: Source | null;
  onBranchChange: (branch: string) => void;
  slug: string;
  baseDomain: string;
  serverIp: string | null;
  serverIpMissing: boolean;
  settingsSettled: boolean;
  cloudflare: CloudflareStatus;
  dnsReady: boolean;
  createAnyway: boolean;
  onCreateAnywayChange: (checked: boolean) => void;
  dnsResult: DnsOutcome | null;
  type: ProjectType;
  buildCmd: string;
  submitting: boolean;
  canSubmit: boolean;
  formError: string | null;
  provisionError: ProvisionError | null;
}) {
  const domain = `${slug || 'your-project'}.${baseDomain}`;

  return (
    <>
      <Card>
        <CardHeader icon={source?.kind === 'url' ? <Link2 size={20} strokeWidth={ICON_STROKE} /> : <GitBranch size={20} strokeWidth={ICON_STROKE} />} title="Source" description={source ? sourceLabel(source) : undefined} />
        <div className="mt-4">
          {source?.kind === 'github' ? (
            <GithubBranchField repo={source.repo} branch={source.branch} onChange={onBranchChange} />
          ) : (
            <Field label="Branch">
              <Input mono value={source?.branch ?? ''} onChange={(event) => onBranchChange(event.target.value)} />
            </Field>
          )}
        </div>
      </Card>

      <DomainCard
        domain={domain}
        serverIp={serverIp}
        serverIpMissing={serverIpMissing}
        settingsSettled={settingsSettled}
        cloudflare={cloudflare}
        dnsReady={dnsReady}
        createAnyway={createAnyway}
        onCreateAnywayChange={onCreateAnywayChange}
        dnsResult={dnsResult}
      />

      <Card>
        <CardHeader icon={<Rocket size={20} strokeWidth={ICON_STROKE} />} title="Deploy summary" />
        <div className="mt-3 flex flex-col gap-0.5">
          <SummaryRow label="Domain" value={domain} mono />
          <SummaryRow label="Framework" value={TYPE_LABEL[type]} />
          <SummaryRow label="Build command" value={buildCmd || 'none'} mono />
        </div>
      </Card>

      {formError && (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      )}
      {provisionError && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
          <p className="text-sm font-medium text-danger">Provisioning failed at {provisionError.step}</p>
          <p className="mt-1 text-sm text-soft">{provisionError.detail}</p>
        </div>
      )}

      <Button type="submit" loading={submitting} disabled={!canSubmit} className="w-full">
        Deploy
      </Button>
    </>
  );
}

/**
 * Right rail's Domain card (plan Task 5 / spec §3 "New Project DNS"): shows the exact `A` record
 * this project would get, live Cloudflare connection status, and — while it can't actually be
 * created (missing server IP, or Cloudflare not connected) — a calm explanation plus the "create
 * anyway" acknowledgment that gates Deploy. After a successful create, `dnsResult` replaces the
 * live-status section with what actually happened, briefly, before the page navigates away.
 */
function DomainCard({
  domain,
  serverIp,
  serverIpMissing,
  settingsSettled,
  cloudflare,
  dnsReady,
  createAnyway,
  onCreateAnywayChange,
  dnsResult,
}: {
  domain: string;
  serverIp: string | null;
  serverIpMissing: boolean;
  settingsSettled: boolean;
  cloudflare: CloudflareStatus;
  dnsReady: boolean;
  createAnyway: boolean;
  onCreateAnywayChange: (checked: boolean) => void;
  dnsResult: DnsOutcome | null;
}) {
  return (
    <Card>
      <CardHeader icon={<Globe size={20} strokeWidth={ICON_STROKE} />} title="Domain" />

      <div className="mt-3 flex flex-col gap-3">
        {!settingsSettled ? (
          <Skeleton className="h-10 w-full" />
        ) : serverIpMissing ? (
          <p className="text-sm text-soft">
            Set the server IP in{' '}
            <Link href="/settings/general" className="font-medium text-link hover:underline">
              Settings &gt; General
            </Link>{' '}
            before Shipway can create a DNS record for this project.
          </p>
        ) : (
          <p className="rounded-xl bg-surface-2 px-3.5 py-2.5 font-mono text-sm text-ink">
            A &nbsp;&nbsp; {domain} &nbsp;&nbsp; &rarr; &nbsp;&nbsp; {serverIp}
          </p>
        )}

        {dnsResult ? (
          <div className={`rounded-xl px-4 py-3 text-sm ${dnsResult.error ? 'bg-danger/10 text-danger' : 'bg-ok-tint text-ok-tint-fg'}`}>
            {dnsResultLine(dnsResult)}
          </div>
        ) : (
          <>
            <div>
              <Badge tone={cloudflare.tone}>{cloudflare.label}</Badge>
            </div>

            {settingsSettled && !cloudflare.pending && !dnsReady && (
              <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
                <p className="text-sm text-soft">
                  {serverIpMissing ? (
                    'No DNS record will be created until the server IP is set.'
                  ) : (
                    <>
                      Cloudflare isn&rsquo;t connected, so no DNS record will be created for this project.{' '}
                      <Link href="/settings/cloudflare" className="font-medium text-link hover:underline">
                        Connect Cloudflare &rarr;
                      </Link>
                    </>
                  )}
                </p>
                <Checkbox
                  className="mt-3"
                  checked={createAnyway}
                  onChange={onCreateAnywayChange}
                  label="Create anyway without a DNS record"
                />
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function SummaryRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-1 py-1.5">
      <span className="text-sm text-soft">{label}</span>
      <span className={`min-w-0 truncate text-right text-sm font-medium text-ink ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function GithubBranchField({ repo, branch, onChange }: { repo: string; branch: string; onChange: (branch: string) => void }) {
  const branchesQuery = useGithubBranches(repo);

  if (branchesQuery.isPending) {
    return <Skeleton className="h-11 w-full" />;
  }
  if (branchesQuery.isError) {
    return (
      <Field label="Branch">
        <Input mono value={branch} onChange={(event) => onChange(event.target.value)} />
      </Field>
    );
  }

  const options = branchesQuery.data?.includes(branch) ? branchesQuery.data : [branch, ...(branchesQuery.data ?? [])];

  return (
    <Field label="Branch">
      <Select mono value={branch} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    </Field>
  );
}
