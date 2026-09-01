/**
 * New Project (route `/projects/new`) — an OpenShip-adapted two-step flow, entirely component
 * state (no sub-route/query-string for the step): pick a source (a GitHub App repo, or paste any
 * git URL), then configure the framework/runtime/deploy settings and hit Deploy.
 *
 * The server only provisions on `POST /api/projects`; this page's job (per the controller ruling
 * carried over from the v1 page) is to also set the env (if any was pasted) and kick off the first
 * deploy, then land the user on that deployment's live log.
 */
import { Fragment, type FormEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Braces,
  ChevronDown,
  Database,
  GitBranch,
  Globe,
  HeartPulse,
  Check,
  Link2,
  LoaderCircle,
  Lock,
  Mail,
  Minus,
  PlayCircle,
  Rocket,
  Search,
  Tag,
  Terminal,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import {
  ApiError,
  createDatabase,
  createProject,
  deployProject,
  fetchDatabaseCredentials,
  importDatabaseSql,
  injectDatabase,
  putProjectEnv,
  putProjectSmtp,
  MAX_SQL_IMPORT_BYTES,
  type CloudflareVerifyResult,
  type CreateProjectBody,
  type DatabaseListItem,
  type DbConnection,
  type DnsOutcome,
  type GithubRepo,
  type ProjectSmtpMode,
  type ProjectType,
  type SesSmtpConfig,
  type SmtpConfig,
} from '../api';
import {
  useCloudflareVerify,
  useDatabases,
  useDbConnections,
  useGitBranches,
  useGithubBranches,
  useGithubDirs,
  useGithubRepos,
  useGithubStatus,
  useServicesInfo,
  useSettings,
} from '../hooks';
import { EnvDraftEditor, useEnvDraft } from '../components/EnvDraft';
import {
  LARAVEL_BUILD_CMD,
  LARAVEL_INSTALL_CMD,
  LARAVEL_POST_DEPLOY_SCRIPT,
  LARAVEL_PRE_DEPLOY_SCRIPT,
  buildPhpEnv,
  generateAppKey,
  upsertEnvVars,
} from '../../../server/src/deploy/laravel.js';
import { NODE_BUILD_CMD, NODE_INSTALL_CMD, NODE_START_CMD } from '../../../server/src/deploy/node.js';
import { IDENTIFIER_RE, connectionEnv, isReservedDbName, type DbEngine } from '../../../server/src/services/dbconn.js';
import { NextjsIcon, NodeIcon, PhpIcon, StaticIcon, type BrandIconProps } from '../components/BrandIcons';
import {
  Badge,
  type BadgeTone,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  Checkbox,
  Combobox,
  CopyIconButton,
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
  buttonClasses,
} from '../components/ui';
import { slugify, SLUG_RE } from '../lib/slug';
import { isDbCapable } from '../lib/database';
import { SMTP_OPTIONS, managedMailVars, smtpOptionLabel } from '../lib/smtp';
import { SES_DEFAULT_REGION, SES_REGIONS, SES_SMTP_PORT, sesSmtpHost } from '../lib/ses';

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
  /** Release-relative directory nginx serves as the web root. '' means the repo root. */
  publicDir: string;
  preDeployScript: string;
  postDeployScript: string;
}

/**
 * Mirrors `defaultsForType` in `server/src/routes/projects.ts`, which is the authority — this copy
 * only exists so the fields are already filled in while the user is still looking at the form. The
 * php row comes from `deploy/laravel.ts`, imported rather than retyped, so the two can't drift.
 */
const TYPE_DEFAULTS: Record<ProjectType, TypeDefaults> = {
  php: {
    installCmd: LARAVEL_INSTALL_CMD,
    buildCmd: LARAVEL_BUILD_CMD,
    startCmd: '',
    publicDir: 'public',
    preDeployScript: LARAVEL_PRE_DEPLOY_SCRIPT,
    postDeployScript: LARAVEL_POST_DEPLOY_SCRIPT,
  },
  node: { installCmd: NODE_INSTALL_CMD, buildCmd: NODE_BUILD_CMD, startCmd: NODE_START_CMD, publicDir: '', preDeployScript: '', postDeployScript: '' },
  nextjs: { installCmd: NODE_INSTALL_CMD, buildCmd: NODE_BUILD_CMD, startCmd: NODE_START_CMD, publicDir: '', preDeployScript: '', postDeployScript: '' },
  static: { installCmd: '', buildCmd: '', startCmd: '', publicDir: '', preDeployScript: '', postDeployScript: '' },
};

/**
 * Mirrors the server's `isValidPublicDir` (server/src/system/templates.ts) so a value that would be
 * rejected with a bare "invalid publicDir" 400 is caught inline instead. Kept deliberately in sync:
 * the directory is interpolated into the vhost's `root`, so a leading `/` or a `..` segment could
 * point the web root outside the release.
 */
const PUBLIC_DIR_RE = /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/;

/**
 * Offered alongside the repo's real directories. A site's web root is very often produced by the
 * build rather than committed, so these cover the conventional output names that `listTopLevelDirs`
 * cannot see.
 */
const COMMON_PUBLIC_DIRS = ['public', 'dist', 'build', 'out', '_site'];

function publicDirError(value: string): string | null {
  if (value === '') return null;
  if (!PUBLIC_DIR_RE.test(value)) {
    return 'Must be a relative path starting with a letter or number — no leading slash.';
  }
  if (value.split('/').some((segment) => segment === '..')) {
    return 'Cannot contain a ".." segment.';
  }
  return null;
}

const PHP_VERSIONS = ['8.1', '8.2', '8.3', '8.4'];
const NODE_VERSIONS = ['18', '20', '22'];

// ---------------------------------------------------------------------------
// Optional database — a connection first, then a database on it
// ---------------------------------------------------------------------------

const DB_ENGINES: { value: DbEngine; label: string }[] = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'postgres', label: 'PostgreSQL' },
];

/**
 * How a connection is labelled in the picker: its name, then where it actually points. The host and
 * port are the part that tells a local engine from a registered RDS instance at a glance, which is
 * the whole reason the connection is asked for first.
 */
function connectionLabel(connection: DbConnection): string {
  return `${connection.name} · ${connection.host}:${String(connection.port)}`;
}

/**
 * A database name suggestion from the project slug: hyphens aren't legal in either engine's
 * unquoted identifiers (and `IDENTIFIER_RE` rejects them), so they become underscores, and the
 * result is trimmed to the 32 characters that regex allows.
 */
function dbNameFromSlug(slug: string): string {
  const candidate = slug.replace(/-/g, '_').replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, '');
  return candidate.slice(0, 32);
}

const DB_ENGINE_LABEL: Record<DbEngine, string> = { mysql: 'MySQL', postgres: 'PostgreSQL' };

function dbNameError(name: string): string | null {
  if (name === '') return 'Give the database a name.';
  if (!IDENTIFIER_RE.test(name)) {
    return 'Lowercase letters, numbers, and underscores only, starting with a letter. Up to 32 characters.';
  }
  // Mirrors the server's own refusal (routes/databases.ts): `mysql`, `postgres`, `information_schema`
  // and friends are the engines' own system databases, and creating a project database with one of
  // those names grants the project access to the server's user and grant tables.
  if (isReservedDbName(name)) {
    return `"${name}" is a system database name on MySQL or PostgreSQL. Pick another name.`;
  }
  return null;
}

/**
 * Why the chosen email service can't be saved yet, or null. Only `custom` and `ses` can be
 * incomplete — Mailpit and None need nothing from the user. Deliberately the same fields the
 * server validates (`PUT /api/projects/:id/smtp`), so the form refuses what the API would refuse,
 * at the point the user can still fix it.
 */
function mailFormError(
  mode: ProjectSmtpMode,
  f: { host: string; port: string; username: string; password: string; from: string; region: string },
): string | null {
  if (mode === 'custom') {
    if (f.host.trim() === '') return 'Give the SMTP server a hostname.';
    const port = Number(f.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Port must be a number between 1 and 65535.';
    return null;
  }
  if (mode === 'ses') {
    if (f.region.trim() === '') return 'Pick the AWS region your SES identity lives in.';
    // SES is the one service that can't fall back to anything: an unverified from-address or the
    // wrong kind of credential fails at send time, long after this page.
    if (f.username.trim() === '') return 'SES needs its SMTP username — the one minted in the SES console, not an AWS access key.';
    if (f.password === '') return 'SES needs its SMTP password.';
    if (f.from.trim() === '') return 'SES needs a from-address, and it must be an identity you have verified.';
    return null;
  }
  return null;
}

/** The `config` half of `PUT /api/projects/:id/smtp`'s body, for the two modes that carry one. */
function mailConfigBody(
  mode: 'custom' | 'ses',
  config: { smtpConfig?: SmtpConfig; sesConfig?: SesSmtpConfig },
): SmtpConfig | SesSmtpConfig | undefined {
  return mode === 'custom' ? config.smtpConfig : config.sesConfig;
}

/**
 * The setup screen shown between "Deploy" and the deployment log: one line per thing Shipway is
 * actually doing, ticked off as each finishes.
 *
 * Every step here is real work, and a step only appears when it will actually run — no database
 * line for a project without one, no SQL line without a dump. The one presentational liberty is
 * that the three stages `POST /api/projects` performs server-side in a single request (vhost +
 * unit, the DNS record, and the Laravel cron/worker seed) are revealed in sequence rather than
 * all at once, because they genuinely happen in that order inside that call.
 */
type PrepState = 'pending' | 'active' | 'done' | 'skipped' | 'failed';

interface PrepStep {
  id: string;
  label: string;
  state: PrepState;
  /** Replaces `label`'s trailing detail once the step resolves — e.g. what DNS actually did. */
  detail?: string;
}

/**
 * The floor on how long the setup screen stays up. The work behind it is often faster than this,
 * and a progress screen that flashes past is worse than none at all — the user is left unsure
 * whether anything happened. Padding to a readable minimum is the point, not the illusion of work.
 */
const MIN_PREP_MS = 5000;

/** The beat between the server-side stages of project creation, revealed in sequence. */
const PREP_BEAT_MS = 420;

/**
 * How a project gets its database: no database at all, a new one created on the chosen connection,
 * or one that is already there.
 */
type DbMode = 'none' | 'create' | 'existing';

/**
 * A setup step that failed after the project row itself was created, and which one. The project
 * exists and is deployable in every case — the rail uses `stage` to say what is actually missing,
 * because "no database", "a database with none of your data in it" and "mail that will not send"
 * need three different next moves.
 */
interface SetupFailure {
  stage: 'create' | 'import' | 'smtp';
  message: string;
}

/** The Connection dropdown's "don't give this project a database" value. */
const DB_CONNECTION_NONE = '';

/**
 * `name · project` — the name first, since that is what the user picks by. The connection is not
 * repeated: the list only holds databases on the connection already selected above it.
 */
function databaseOptionLabel(database: DatabaseListItem): string {
  const attached = database.projectName === null ? 'unattached' : database.projectName;
  return `${database.name} · ${attached}`;
}

interface ProvisionError {
  step: string;
  detail: string;
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
}

/**
 * `POST /api/databases` fails with a bare `{ error: 'database provisioning failed', detail }` — the
 * `error` alone ("database provisioning failed") says nothing actionable, so the `detail` (missing
 * admin credentials, a name the engine already has, …) is what gets shown.
 */
function databaseErrorMessage(err: unknown, fallback = 'Something went wrong creating the database.'): string {
  if (err instanceof ApiError) {
    const detail = (err.body as { detail?: string } | undefined)?.detail;
    return detail === undefined || detail === '' ? err.message : `${err.message}: ${detail}`;
  }
  return fallback;
}

/** `1.4 MB` — one decimal place, and never for a file too small to have one. Only ever shown next
 * to a picked SQL file, which is why it stops at MB: the upload is capped well below a GB. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** Why a picked dump can't be uploaded, or null. The server enforces both of these itself; catching
 * them here saves pushing a file across the wire only to be told no at the end of it. */
function sqlFileError(file: File | null): string | null {
  if (file === null) return null;
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_SQL_IMPORT_BYTES) {
    return `That file is ${formatFileSize(file.size)} — the limit is ${formatFileSize(MAX_SQL_IMPORT_BYTES)}. Import it from a shell instead.`;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * What the DNS step reports once it has run. `attempted: false` means no Cloudflare client was
 * configured at all, which is a real outcome rather than a failure — the user acknowledged it on
 * the form before submitting (see `createAnyway`), so it is stated plainly rather than dressed up.
 * A genuine DNS failure never reaches here: it fails project creation with a 502 instead.
 */
function dnsStepDetail(slug: string, baseDomain: string, dns: DnsOutcome): string {
  const host = `${slug}.${baseDomain}`;
  if (!dns.attempted) return `Skipped the DNS record for ${host} — Cloudflare isn't connected`;
  if (dns.existed) return `${host} already pointed here`;
  return `Pointed ${host} at this server`;
}

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

/** Tone for the post-create result row: red for an error, green for an actual record
 * (created/existed), neutral for the "nothing happened" case (`attempted: false` — no DNS client
 * configured, or the user created anyway) which is neither good nor bad news. */
function dnsResultTone(outcome: DnsOutcome): 'danger' | 'ok' | 'neutral' {
  if (outcome.error) return 'danger';
  if (outcome.created || outcome.existed) return 'ok';
  return 'neutral';
}

const DNS_RESULT_TONE_CLASSES: Record<'danger' | 'ok' | 'neutral', string> = {
  danger: 'bg-danger/10 text-danger',
  ok: 'bg-ok-tint text-ok-tint-fg',
  neutral: 'bg-surface-2 text-soft',
};

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
  const [publicDir, setPublicDir] = useState(TYPE_DEFAULTS.php.publicDir);
  const [preDeployScript, setPreDeployScript] = useState(TYPE_DEFAULTS.php.preDeployScript);
  const [postDeployScript, setPostDeployScript] = useState(TYPE_DEFAULTS.php.postDeployScript);
  const [healthCheckPath, setHealthCheckPath] = useState('');

  // Optional database, asked as two questions: which connection, then which database on it.
  // 'create' provisions one right after the project and before its env is written (see
  // handleDeploy), so the generated password can go straight into DB_PASSWORD; 'existing' reuses a
  // database already on that connection and injects its stored credentials.
  const [dbConnectionId, setDbConnectionId] = useState<string>(DB_CONNECTION_NONE);
  const [dbCreateNew, setDbCreateNew] = useState(false);
  const [dbExistingId, setDbExistingId] = useState<number | null>(null);
  const [dbNameInput, setDbNameInput] = useState('');
  const [dbNameTouched, setDbNameTouched] = useState(false);
  // An optional dump to replay into the database being created, uploaded straight after it is
  // provisioned and before the first deploy — so an app whose migrations expect an existing schema
  // finds one. Only ever read in 'create' mode; an existing database already has whatever it has.
  const [dbSqlFile, setDbSqlFile] = useState<File | null>(null);

  // The email service this project's mail goes through. Held here rather than left to the SMTP tab
  // because the MAIL_* it implies belong in the env the user is reviewing before the first deploy —
  // and because a project that silently defaults to a catch-all is a project whose password-reset
  // mails quietly go nowhere.
  const [smtpMode, setSmtpMode] = useState<ProjectSmtpMode>('mailpit');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUsername, setSmtpUsername] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpEncryption, setSmtpEncryption] = useState('tls');
  const [sesRegion, setSesRegion] = useState(SES_DEFAULT_REGION);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugApiError, setSlugApiError] = useState<string | null>(null);

  // Non-null only while the setup screen is up, which is also what makes that screen show instead
  // of the form. Rebuilt per submit, so a retry after a failure starts from a clean plan.
  const [prep, setPrep] = useState<PrepStep[] | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [provisionError, setProvisionError] = useState<ProvisionError | null>(null);
  // Set once the project row exists, so a follow-up step that failed (the database) can be reported
  // without offering a Deploy button that would only 409 on the now-taken slug.
  const [created, setCreated] = useState<{ id: number; slug: string } | null>(null);
  // `stage` is the difference between "there is no database" and "there is one, but your dump
  // didn't load into it" — two failures with the same shape and completely different fixes.
  const [setupError, setSetupError] = useState<SetupFailure | null>(null);

  // "Create anyway without a DNS record" — required only while dnsReady is false (spec §3 "New
  // Project DNS"); reset to false below whenever the underlying gap reason changes, so a stale ack
  // from a previous, different reason (e.g. Cloudflare reconnects, then later disconnects again)
  // can never silently carry over as a pre-checked box for a gap the user never actually saw.
  const [createAnyway, setCreateAnyway] = useState(false);
  // Set right after a successful create, briefly, so the Domain card can show what actually
  // happened to DNS before this page navigates to the deployment log (see handleDeploy).
  const [dnsResult, setDnsResult] = useState<DnsOutcome | null>(null);
  // Scrolled into view the instant a create succeeds (see handleDeploy) — the right rail isn't
  // sticky, so a user who scrolled down to the Project name/slug fields before hitting Deploy would
  // otherwise never see the DNS result before this page navigates away.
  const domainCardRef = useRef<HTMLDivElement>(null);

  const isNodeLike = type === 'node' || type === 'nextjs';
  // Same runtimes as the project's Settings page: node/nextjs are proxied to a port, so a web root
  // is meaningless there — php and static are the two nginx serves files from directly.
  const showPublicDir = type === 'php' || type === 'static';
  const publicDirIssue = showPublicDir ? publicDirError(publicDir) : null;
  // Suggestions for the public-directory field: the repo's own top-level folders (GitHub sources
  // only — a plain Git URL isn't cloned until deploy, so there's nothing to list yet), followed by
  // the conventional build-output names that wouldn't be committed.
  const dirsRepo = showPublicDir && source?.kind === 'github' ? source.repo : null;
  const dirsQuery = useGithubDirs(dirsRepo, dirsRepo === null ? null : source?.branch ?? null);
  const publicDirOptions = useMemo(() => {
    const fromRepo = dirsQuery.data ?? [];
    return [...fromRepo, ...COMMON_PUBLIC_DIRS.filter((d) => !fromRepo.includes(d))];
  }, [dirsQuery.data]);
  const baseDomain = settingsQuery.data?.base_domain ?? 'your-domain';
  const serverIp = settingsQuery.data?.server_ip ?? null;
  const settingsSettled = !settingsQuery.isPending;
  const serverIpMissing = settingsSettled && serverIp === null;
  const cfStatus = cloudflareStatus(cloudflareQuery.data, cloudflareQuery.isPending, cloudflareQuery.isError);
  const dnsReady = settingsSettled && !serverIpMissing && cfStatus.ready;
  // Identifies WHY dns isn't ready (or that it is) — 'pending' while still loading, so the effect
  // below never fires on the initial settle. Distinct string per reason means a gap that changes
  // reason (not just resolves and reappears identically) also clears a stale acknowledgment.
  const dnsGapReason = !settingsSettled ? 'pending' : serverIpMissing ? 'server-ip' : !cfStatus.ready ? 'cloudflare' : 'ready';

  useEffect(() => {
    setCreateAnyway(false);
  }, [dnsGapReason]);

  // ---- environment variables ----

  // Generated once per visit, deliberately: an APP_KEY that changed while the user read the env
  // would not be the key their app ends up with.
  const appKeyRef = useRef(generateAppKey());
  const envDraft = useEnvDraft('');
  // Redis/mailpit as this server actually has them, so the template can point the app at something
  // that will answer (and degrade the driver when it can't — see deploy/laravel.ts). The same
  // response carries which engines can take a database, which is what the connection list is built
  // from.
  const servicesQuery = useServicesInfo();
  const redis = servicesQuery.data?.redis ?? null;
  const mailpit = servicesQuery.data?.mailpit ?? null;
  const servicesSettled = !servicesQuery.isPending;
  // Every server a database can go on: this host's engines plus any registered external one. An
  // engine with no admin credentials never appears in it, so nothing here has to check for that.
  const dbConnectionsQuery = useDbConnections();
  const dbConnections = dbConnectionsQuery.data ?? [];
  const dbConnection = dbConnections.find((row) => row.key === dbConnectionId) ?? null;
  // 'mysql' is only ever a placeholder for the no-connection case: every path that reads this
  // (creating the database, rendering the env block) runs with a connection selected.
  const dbEngine: DbEngine = dbConnection?.engine ?? 'mysql';

  const databasesQuery = useDatabases();
  // A database whose name is a system schema (`mysql`, `postgres`, …) is never offered here: its
  // user holds privileges on the engine's own tables, so attaching it to a project would put those
  // credentials in an app's .env. The card says how many were hidden rather than silently shortening
  // the list. Such rows can only predate the create-time guard in routes/databases.ts.
  const selectableDatabases = (databasesQuery.data ?? []).filter((row) => !isReservedDbName(row.name));
  // A database belongs to the connection it was created on, so the list below is only ever that
  // connection's own — which is what makes "create a new one here" and "use one that's already
  // there" two answers to the same question rather than two unrelated pickers.
  const existingDatabases = dbConnection === null ? [] : selectableDatabases.filter((row) => row.connectionKey === dbConnection.key);
  const hiddenDatabaseCount =
    dbConnection === null
      ? 0
      : (databasesQuery.data ?? []).filter((row) => row.connectionKey === dbConnection.key && isReservedDbName(row.name)).length;
  const existingDb = existingDatabases.find((row) => row.id === dbExistingId) ?? null;

  // Exactly the shape `buildManagedVars` takes, so the preview below and the .env written at deploy
  // come from one function rather than two that agree today.
  const mailConfig = useMemo(
    () =>
      smtpMode === 'custom'
        ? {
            smtpConfig: {
              host: smtpHost.trim(),
              port: Number(smtpPort),
              username: smtpUsername.trim() === '' ? undefined : smtpUsername,
              password: smtpPassword === '' ? undefined : smtpPassword,
              fromAddress: smtpFrom.trim() === '' ? undefined : smtpFrom.trim(),
              encryption: smtpEncryption.trim() === '' ? undefined : smtpEncryption.trim(),
            },
          }
        : smtpMode === 'ses'
          ? { sesConfig: { region: sesRegion.trim(), username: smtpUsername.trim(), password: smtpPassword, fromAddress: smtpFrom.trim() } }
          : {},
    [smtpMode, smtpHost, smtpPort, smtpUsername, smtpPassword, smtpFrom, smtpEncryption, sesRegion],
  );
  // `null` while the form is still missing something the service needs — never "writes nothing".
  const managedMail = managedMailVars(smtpMode, mailConfig);
  // The template only cares WHICH keys the service owns, not their values — depending on the values
  // would rebuild the whole env draft on every keystroke in the SMTP fields.
  const managedMailKey = Object.keys(managedMail ?? {}).join(',');
  const mailIssue = mailFormError(smtpMode, { host: smtpHost, port: smtpPort, username: smtpUsername, password: smtpPassword, from: smtpFrom, region: sesRegion });

  // A static site has no server to open a connection from, and nextjs is excluded by the same rule
  // that hides its Database tab — so the card is not shown, and the mode is forced off rather than
  // merely hidden. Without the second half, picking a connection as php and then switching type
  // would still provision a database for a project that can never use it.
  const showDatabase = isDbCapable(type);
  const dbMode: DbMode = !showDatabase || dbConnection === null ? 'none' : dbCreateNew ? 'create' : 'existing';
  const dbName = dbNameTouched ? dbNameInput : dbNameFromSlug(slug);
  const dbNameIssue = dbMode === 'create' ? dbNameError(dbName) : null;
  // "Use an existing database" with nothing chosen blocks Deploy, but is not shown in red: an
  // unfinished form is not a mistake, and the placeholder plus the disabled button already say so.
  // A database that *was* chosen and has since been dropped (in another tab, between picking it and
  // deploying) is a mistake, and that one gets the error text.
  const existingDbUnpicked = dbMode === 'existing' && existingDb === null;
  const existingDbError = existingDbUnpicked && dbExistingId !== null ? 'That database no longer exists. Pick another.' : null;
  const dbSqlIssue = dbMode === 'create' ? sqlFileError(dbSqlFile) : null;
  const dbBlocked = dbNameIssue !== null || existingDbUnpicked || dbSqlIssue !== null;

  // What the env template renders as its DB_* block. For an existing database the real password is
  // fetched at submit time (it's stored encrypted server-side, revealed only on request), so the
  // block shows its name and user now and gets the password written into it then.
  const dbTarget =
    dbMode === 'create' && dbNameIssue === null && dbConnection !== null
      ? {
          engine: dbEngine,
          name: dbName,
          username: dbName,
          password: '',
          provisioned: true,
          host: dbConnection.host,
          port: dbConnection.port,
        }
      : dbMode === 'existing' && existingDb !== null
        ? {
            engine: existingDb.engine,
            name: existingDb.name,
            username: existingDb.username,
            password: '',
            provisioned: false,
            host: existingDb.host,
            port: existingDb.port,
          }
        : null;

  /**
   * The Laravel starting point for a php project, recomputed live from the name/slug/database the
   * user is choosing. Empty for every other type — a node/next/static project has no env Shipway
   * can guess. `DB_PASSWORD` is blank here because the database does not exist yet; `handleDeploy`
   * fills it in (via `upsertEnvVars`) the moment it does.
   */
  const envTemplate = useMemo(() => {
    if (type !== 'php' || !servicesSettled) return '';
    return buildPhpEnv({
      appName: name.trim() === '' ? 'Laravel' : name,
      appUrl: `https://${slug === '' ? 'your-project' : slug}.${baseDomain}`,
      appKey: appKeyRef.current,
      baseDomain,
      redis: redis ? { host: redis.host, port: redis.port, password: redis.password ?? null } : null,
      smtpMode,
      // The template writes none of these: everything it emits is a USER key, and a user key
      // suppresses the managed one Shipway regenerates each deploy (see buildEnvFile). Writing
      // MAIL_HOST here is what used to pin a project to whatever service it was created with.
      managedMailKeys: Object.keys(managedMail ?? {}),
      db: dbTarget,
    });
  }, [
    type,
    servicesSettled,
    name,
    slug,
    baseDomain,
    redis,
    smtpMode,
    managedMailKey,
    dbTarget?.engine,
    dbTarget?.name,
    dbTarget?.username,
    dbTarget?.provisioned,
    dbTarget?.host,
    dbTarget?.port,
  ]);

  // Keeps the draft in step with the template until the user types in it — from then on it is
  // theirs, and only the explicit "Reset" button below re-applies the template. The ref makes this
  // idempotent: `reset` builds fresh row objects every time, so re-running it on its own re-render
  // would loop forever.
  const appliedTemplateRef = useRef<string | null>(null);
  useEffect(() => {
    if (envDraft.dirty || appliedTemplateRef.current === envTemplate) return;
    appliedTemplateRef.current = envTemplate;
    envDraft.reset(envTemplate);
  }, [envTemplate, envDraft]);

  // Only fires if the chosen connection stops being offered — its engine turns out to have no admin
  // credentials on this host once `/api/services/info` settles. Clearing it is the honest outcome:
  // there is nowhere to put the database that was being described.
  useEffect(() => {
    if (dbConnectionId !== DB_CONNECTION_NONE && !dbConnectionsQuery.isPending && !dbConnections.some((row) => row.key === dbConnectionId)) {
      setDbConnectionId(DB_CONNECTION_NONE);
      setDbCreateNew(false);
      setDbExistingId(null);
    }
  }, [dbConnections, dbConnectionId, dbConnectionsQuery.isPending]);

  /**
   * Picking a connection clears what was chosen on the previous one: a database belongs to the
   * connection it lives on, so carrying that selection across would point the project at a database
   * the new connection has never heard of. A connection with nothing on it yet opens on "create a
   * new database", since that is the only thing it can offer.
   */
  function handleDbConnectionChange(next: string): void {
    setDbConnectionId(next);
    setDbExistingId(null);
    const connection = dbConnections.find((row) => row.key === next) ?? null;
    const hasExisting = connection !== null && selectableDatabases.some((row) => row.connectionKey === connection.key);
    setDbCreateNew(connection !== null && !hasExisting);
  }

  function resetEnvToTemplate(): void {
    appliedTemplateRef.current = envTemplate;
    envDraft.reset(envTemplate);
  }

  function handleTypeChange(next: ProjectType) {
    setType(next);
    const defaults = TYPE_DEFAULTS[next];
    setInstallCmd(defaults.installCmd);
    setBuildCmd(defaults.buildCmd);
    setStartCmd(defaults.startCmd);
    setPublicDir(defaults.publicDir);
    setPreDeployScript(defaults.preDeployScript);
    setPostDeployScript(defaults.postDeployScript);
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
    publicDirIssue === null &&
    mailIssue === null &&
    !dbBlocked &&
    created === null &&
    !submitting &&
    (dnsReady || createAnyway);

  function setBranch(next: string) {
    if (!source) return;
    setSource({ ...source, branch: next });
  }

  /** Queues the first deploy and lands on its live log, or on the project if queueing failed. */
  /**
   * Triggers the first deploy and lands the user on its log.
   *
   * `notBefore` (an epoch ms deadline, used only from the setup screen) delays the NAVIGATION, never
   * the request — the deploy is kicked off immediately so the "Starting the first deploy" line is
   * true while it is showing, and only the hand-off waits for the screen's minimum time to elapse.
   */
  async function startFirstDeploy(projectId: number, notBefore = 0): Promise<void> {
    try {
      const { deploymentId } = await deployProject(projectId);
      await sleep(Math.max(0, notBefore - Date.now()));
      navigate(`/projects/${String(projectId)}/deployments/${String(deploymentId)}`);
    } catch {
      // Best-effort, matching the create-then-deploy split below — land on the project instead.
      await sleep(Math.max(0, notBefore - Date.now()));
      navigate(`/projects/${String(projectId)}`);
    }
  }

  /** Marks one step, leaving the rest alone. A no-op once the screen is down. */
  function setStepState(id: string, state: PrepState, detail?: string): void {
    setPrep((current) => current?.map((s) => (s.id === id ? { ...s, state, ...(detail === undefined ? {} : { detail }) } : s)) ?? null);
  }

  /** Marks `id` done (or skipped/failed) and lights the next step that hasn't run yet. */
  function completeStep(id: string, state: PrepState = 'done', detail?: string): void {
    setPrep((current) => {
      if (!current) return null;
      const next = current.map((s) => (s.id === id ? { ...s, state, ...(detail === undefined ? {} : { detail }) } : s));
      const upcoming = next.find((s) => s.state === 'pending');
      return upcoming ? next.map((s) => (s.id === upcoming.id ? { ...s, state: 'active' } : s)) : next;
    });
  }

  /**
   * The steps this particular submit will actually run, in order. Built from the form as it stands
   * so nothing is listed that won't happen — a project with no database contributes no database
   * line, rather than a line that resolves to "skipped" and leaves the user wondering what it was.
   */
  function buildPrepPlan(): PrepStep[] {
    const steps: PrepStep[] = [
      { id: 'project', label: 'Creating the project and its web server config', state: 'active' },
      { id: 'dns', label: `Pointing ${slug}.${baseDomain} at this server`, state: 'pending' },
    ];
    if (type === 'php') {
      steps.push({ id: 'jobs', label: 'Scheduling the Laravel cron and queue worker', state: 'pending' });
    }
    steps.push({ id: 'mail', label: `Setting up email via ${smtpOptionLabel(smtpMode)}`, state: 'pending' });
    if (dbMode === 'create' && dbConnection !== null) {
      steps.push({ id: 'db', label: `Creating the ${DB_ENGINE_LABEL[dbConnection.engine]} database ${dbName}`, state: 'pending' });
      if (dbSqlFile !== null && dbSqlIssue === null) {
        steps.push({ id: 'sql', label: `Importing ${dbSqlFile.name}`, state: 'pending' });
      }
    } else if (dbMode === 'existing' && existingDb !== null) {
      steps.push({ id: 'db', label: `Linking the database ${existingDb.name}`, state: 'pending' });
    }
    steps.push({ id: 'env', label: 'Writing environment variables', state: 'pending' });
    steps.push({ id: 'deploy', label: 'Starting the first deploy', state: 'pending' });
    return steps;
  }

  async function handleDeploy(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || !source) return;

    setFormError(null);
    setProvisionError(null);
    setSlugApiError(null);
    setDnsResult(null);
    setSetupError(null);
    setSubmitting(true);
    // The screen goes up only now — after canSubmit, so every client-side check (subdomain shape,
    // database name, mail config) has already passed and this is genuinely the work starting.
    setPrep(buildPrepPlan());
    const prepStartedAt = Date.now();

    const body: CreateProjectBody = {
      name,
      slug,
      branch: source.branch,
      type,
      ...(source.kind === 'github' ? { repo: source.repo } : { repoUrl: source.repoUrl }),
      installCmd,
      buildCmd,
      preDeployScript,
      postDeployScript,
      healthCheckPath: healthCheckPath.trim() === '' ? null : healthCheckPath.trim(),
      ...(showPublicDir ? { publicDir } : {}),
      ...(type === 'php' ? { phpVersion } : {}),
      ...(isNodeLike ? { nodeVersion, startCmd } : {}),
    };

    try {
      const project = await createProject(body);
      setCreated({ id: project.id, slug: project.slug });

      // These three all completed inside the one request above, in this order, server-side:
      // the vhost and unit, then the DNS record, then the Laravel cron/worker seed. Revealed with a
      // beat between them because that is the order they happened in, not to pad the clock — the
      // padding is at the end, once.
      completeStep('project');
      await sleep(PREP_BEAT_MS);
      completeStep('dns', 'done', dnsStepDetail(slug, baseDomain, project.dns));
      if (type === 'php') {
        await sleep(PREP_BEAT_MS);
        completeStep('jobs');
      }

      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      await queryClient.invalidateQueries({ queryKey: ['overview'] });

      // Surface the DNS outcome in the Domain card for a short beat before navigating away — the
      // simpler of the two approaches the plan allows (the alternative, passing the outcome
      // through to the deployment log page, has nowhere to land: wouter's `navigate` carries no
      // location state, and coupling the deployment log — a surface other work on this project
      // owns — to a one-time "how did project creation's DNS step go" payload would outlive its
      // usefulness the moment the user leaves this page anyway).
      //
      // The right rail isn't sticky (DESIGN.md doesn't call for that), so a user who scrolled down
      // to the Project name/slug fields at the bottom of the LEFT column before hitting Deploy
      // would otherwise have the Domain card scrolled off-screen above the viewport the entire
      // time — the result would exist but never actually be seen. `scrollIntoView` fixes that
      // deterministically (no animation to race against the fixed-length delay below): 'nearest'
      // means it's a no-op when the card is already visible, so this never yanks the page around
      // for someone who submitted from the top.
      // Before the env write and the first deploy: the MAIL_* block is rendered from this at deploy
      // time, so a project must carry its email service by then or it starts life on the default.
      // A failure here is not worth abandoning the project over — the SMTP tab can still set it —
      // so it degrades to the same rail message the database step uses.
      let smtpFailure: string | null = null;
      try {
        await putProjectSmtp(project.id, { mode: smtpMode, ...(smtpMode === 'custom' || smtpMode === 'ses' ? { config: mailConfigBody(smtpMode, mailConfig) } : {}) });
        completeStep('mail');
      } catch (err) {
        smtpFailure = databaseErrorMessage(err, 'Could not save the email service. Set it on the project\u2019s Email tab.');
        completeStep('mail', 'failed');
      }

      // Still recorded for the Domain card, which is what the user lands back on if a later step
      // fails and the setup screen comes down.
      setDnsResult(project.dns);

      // The database comes before the env write, not after: its password is generated server-side
      // and returned exactly once (POST /api/databases), so this is the only moment it can be put
      // into the env the user just reviewed. `upsertEnvVars` writes it wherever the DB_* keys
      // ended up — rewritten in place if the template's block survived their edits, appended if
      // they deleted it.
      let envText = envDraft.text();
      let dbFailure: SetupFailure | null = null;
      let attachExistingDbId: number | null = null;
      // Which step the catch below is reporting on. Only ever advanced past 'create' once the
      // database itself is provisioned, so the rail can say the database is fine and the dump isn't.
      let dbStage: SetupFailure['stage'] = 'create';
      try {
        if (dbMode === 'create' && dbNameIssue === null && dbConnection !== null) {
          const db = await createDatabase({ connection: dbConnection.key, name: dbName, projectId: project.id });
          completeStep('db');
          envText = upsertEnvVars(
            envText,
            connectionEnv(db.engine, { name: db.name, username: db.username, password: db.password }, { host: db.host, port: db.port }),
          );
          // Before the first deploy, deliberately: a dump that fails to import is a reason not to
          // run the app's migrations against a half-loaded schema, and stopping here is what gives
          // the user that choice (the rail's "Deploy anyway" is the other half of it).
          if (dbSqlFile !== null && dbSqlIssue === null) {
            dbStage = 'import';
            const imported = await importDatabaseSql(db.id, dbSqlFile);
            completeStep('sql', 'done', `Imported ${dbSqlFile.name} (${formatFileSize(imported.bytes)})`);
          }
        } else if (dbMode === 'existing' && existingDb !== null) {
          // The stored password is only handed out by this endpoint, so this is where the env's
          // blank DB_PASSWORD gets its real value. `credentials.env` is the server's own rendering
          // of the DB_* block (`connectionEnv`), used verbatim rather than reassembled here.
          const credentials = await fetchDatabaseCredentials(existingDb.id);
          envText = upsertEnvVars(envText, credentials.env);
          attachExistingDbId = existingDb.id;
          completeStep('db');
        }
      } catch (err) {
        dbFailure = {
          stage: dbStage,
          message: databaseErrorMessage(err, dbStage === 'import' ? 'Something went wrong importing the SQL file.' : undefined),
        };
        setStepState(dbStage === 'import' ? 'sql' : 'db', 'failed');
        setSetupError(dbFailure);
      }

      if (envText.trim() !== '') {
        try {
          await putProjectEnv(project.id, envText);
          completeStep('env');
        } catch {
          // Best-effort — the project exists either way; env can still be set from its page.
          completeStep('env', 'failed');
        }
      } else {
        completeStep('env', 'skipped', 'No environment variables to write');
      }

      // Records the association (and audits it) now that the env is saved. Its own env append is a
      // no-op here — every DB_* key it would add is already in the env just written — so this is
      // purely about the database no longer showing up as belonging to nobody.
      if (attachExistingDbId !== null) {
        try {
          await injectDatabase(attachExistingDbId, project.id);
          await queryClient.invalidateQueries({ queryKey: ['databases'] });
        } catch {
          // The credentials are already in the env, which is what actually matters for the deploy.
        }
      }

      // A failed database is not a failed project, but deploying an app whose DB_PASSWORD is still
      // blank would just fail its migrations — so stop here and let the user decide (the rail shows
      // what went wrong, with "Deploy anyway" and a link to the project).
      // A failed step means the rail has something to say and the form is where it says it, so the
      // setup screen comes down rather than sitting on a half-ticked list with no way forward.
      if (dbFailure !== null) {
        setPrep(null);
        return;
      }
      if (smtpFailure !== null) {
        setSetupError({ stage: 'smtp', message: smtpFailure });
        setPrep(null);
        return;
      }

      // The deploy fires now; the hand-off to its log waits until the screen has been up long
      // enough to read. A progress screen that flashes past leaves the user unsure anything ran.
      await startFirstDeploy(project.id, prepStartedAt + MIN_PREP_MS);
    } catch (err) {
      setPrep(null);
      if (err instanceof ApiError && err.status === 409) {
        setSlugApiError(err.message === 'this name is reserved' ? 'This name is reserved.' : 'This subdomain is already in use.');
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

  // Ahead of the source/configure split: once setup is under way neither of those views is
  // actionable, and this screen owns the page until it navigates or hands back on a failure.
  if (prep !== null) {
    return <PreparingScreen steps={prep} projectName={name.trim() === '' ? slug : name} domain={`${slug}.${baseDomain}`} />;
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
              domainCardRef={domainCardRef}
              type={type}
              buildCmd={buildCmd}
              database={dbTarget ? { engine: dbTarget.engine, name: dbTarget.name } : null}
              submitting={submitting}
              canSubmit={canSubmit}
              formError={formError}
              provisionError={provisionError}
              created={created}
              setupError={setupError}
              onDeployAnyway={() => {
                if (created) void startFirstDeploy(created.id);
              }}
            />
          }
        >
          {/* Name/slug first: the project's domain, its suggested database name, and the APP_URL in
              the env below are all derived from the slug, so they should be settled before the user
              reads any of them. */}
          <ProjectNameCard name={name} slug={slug} slugError={slugError} onNameChange={handleNameChange} onSlugChange={handleSlugChange} />

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
            showPublicDir={showPublicDir}
            publicDir={publicDir}
            publicDirIssue={publicDirIssue}
            publicDirOptions={publicDirOptions}
            onInstallCmd={setInstallCmd}
            onBuildCmd={setBuildCmd}
            onStartCmd={setStartCmd}
            onPublicDir={setPublicDir}
          />

          <DeployScriptsCard
            type={type}
            preDeployScript={preDeployScript}
            postDeployScript={postDeployScript}
            onPreDeployScript={setPreDeployScript}
            onPostDeployScript={setPostDeployScript}
            onResetToDefaults={() => {
              setPreDeployScript(TYPE_DEFAULTS[type].preDeployScript);
              setPostDeployScript(TYPE_DEFAULTS[type].postDeployScript);
            }}
          />

          {showDatabase && (
            <DatabaseCard
              connections={dbConnections}
              connectionId={dbConnectionId}
              connection={dbConnection}
              mode={dbMode}
              existingDatabases={existingDatabases}
              existingDatabasesPending={databasesQuery.isPending}
              existingId={dbExistingId}
              existingDb={existingDb}
              existingError={existingDbError}
              hiddenDatabaseCount={hiddenDatabaseCount}
              name={dbName}
              nameIssue={dbNameIssue}
              sqlFile={dbSqlFile}
              sqlIssue={dbSqlIssue}
              onSqlFileChange={setDbSqlFile}
              onConnectionChange={handleDbConnectionChange}
              onCreateNewChange={(value) => {
                setDbCreateNew(value);
                if (value) setDbExistingId(null);
              }}
              onExistingChange={setDbExistingId}
              onNameChange={(value) => {
                setDbNameTouched(true);
                setDbNameInput(value);
              }}
            />
          )}

          <MailCard
            mode={smtpMode}
            mailpitAvailable={mailpit !== null}
            issue={mailIssue}
            managed={managedMail}
            host={smtpHost}
            port={smtpPort}
            username={smtpUsername}
            password={smtpPassword}
            fromAddress={smtpFrom}
            encryption={smtpEncryption}
            region={sesRegion}
            onModeChange={setSmtpMode}
            onHostChange={setSmtpHost}
            onPortChange={setSmtpPort}
            onUsernameChange={setSmtpUsername}
            onPasswordChange={setSmtpPassword}
            onFromAddressChange={setSmtpFrom}
            onEncryptionChange={setSmtpEncryption}
            onRegionChange={setSesRegion}
          />

          <EnvVarsCard
            draft={envDraft}
            type={type}
            servicesPending={!servicesSettled}
            redisConfigured={redis !== null}
            mailpitConfigured={mailpit !== null}
            onReset={resetEnvToTemplate}
          />

          <HealthCheckCard value={healthCheckPath} onChange={setHealthCheckPath} />

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
  showPublicDir,
  publicDir,
  publicDirIssue,
  publicDirOptions,
  onInstallCmd,
  onBuildCmd,
  onStartCmd,
  onPublicDir,
}: {
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  isNodeLike: boolean;
  showPublicDir: boolean;
  publicDir: string;
  publicDirIssue: string | null;
  publicDirOptions: string[];
  onInstallCmd: (v: string) => void;
  onBuildCmd: (v: string) => void;
  onStartCmd: (v: string) => void;
  onPublicDir: (v: string) => void;
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
        {showPublicDir && (
          <Field
            label="Public directory"
            error={publicDirIssue ?? undefined}
            hint="The folder nginx serves, relative to the repo root. Pick one of the repo's folders, or type a build-output folder (dist, build, …) — those don't exist until the build runs, so they aren't listed. Leave blank to serve the repo root."
          >
            <Input
              mono
              list="public-dir-options"
              value={publicDir}
              onChange={(event) => onPublicDir(event.target.value)}
              placeholder="repo root"
              autoComplete="off"
              spellCheck={false}
            />
            <datalist id="public-dir-options">
              {publicDirOptions.map((dir) => (
                <option key={dir} value={dir} />
              ))}
            </datalist>
          </Field>
        )}
      </div>
    </details>
  );
}

/**
 * Environment variables, in the same two views the project's Environment tab uses (a key/value
 * table, and the whole file as free text) — because for a php project this box is not empty: it
 * arrives holding the Laravel defaults from `deploy/laravel.ts`, already pointed at this server's
 * redis and mailpit and at whatever database is being created alongside the project. The point is
 * that the user reads and edits it here, before the first deploy, instead of meeting a 500 after it.
 *
 * `onReset` re-applies that template, which is the only way back to it once the draft is dirty (the
 * live regeneration in the page stops the moment the user types, so their edits are never eaten by
 * a later keystroke in the Name field).
 */
/**
 * Says which of this server's shared services the env is already wired to — and, when one is
 * missing, which driver the template fell back to because of it (see `deploy/laravel.ts`), so a
 * `sync` queue or a logged email is never a surprise later.
 */
function servicesNote(redisConfigured: boolean, mailpitConfigured: boolean): string {
  if (redisConfigured && mailpitConfigured) return "This server's redis and Mailpit credentials are already filled in.";
  if (redisConfigured) return "Redis credentials are filled in. No Mailpit here, so mail is written to the log.";
  if (mailpitConfigured) return "Mailpit credentials are filled in. No redis here, so the queue runs sync.";
  return 'No redis or Mailpit on this server, so the queue runs sync and mail goes to the log.';
}

function EnvVarsCard({
  draft,
  type,
  servicesPending,
  redisConfigured,
  mailpitConfigured,
  onReset,
}: {
  draft: ReturnType<typeof useEnvDraft>;
  type: ProjectType;
  servicesPending: boolean;
  redisConfigured: boolean;
  mailpitConfigured: boolean;
  onReset: () => void;
}) {
  const isPhp = type === 'php';
  const description = isPhp
    ? 'Laravel defaults, ready to edit. Written to .env before the first deploy.'
    : 'Paste your .env. Written before the first deploy.';

  return (
    <Card>
      <CardHeader icon={<Braces size={20} strokeWidth={ICON_STROKE} />} title="Environment variables" description={description} />

      <div className="mt-4 flex flex-col gap-3">
        {isPhp && servicesPending ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : (
          <EnvDraftEditor
            draft={draft}
            rawLabel="Raw .env"
            emptyText={isPhp ? 'No variables yet — Reset to defaults fills in a working Laravel .env.' : 'No environment variables yet.'}
            rawRows={16}
          />
        )}

        {isPhp && !servicesPending && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={onReset} disabled={!draft.dirty}>
              Reset to Laravel defaults
            </Button>
            <span className="text-[13px] text-soft">{servicesNote(redisConfigured, mailpitConfigured)}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Pre/post-deploy scripts, prefilled for php with the Laravel commands that belong at each stage
 * (`deploy/laravel.ts` documents why migrate lives in the build command and `storage:link`/
 * `queue:restart` run post-activation).
 *
 * Collapsed by default for every type, php included. The php prefill is a sensible default rather
 * than something most people edit, so opening it on arrival spent a screenful of the form on a
 * section that usually gets scrolled past — the summary still says what is in there for anyone who
 * wants it.
 */
function DeployScriptsCard({
  type,
  preDeployScript,
  postDeployScript,
  onPreDeployScript,
  onPostDeployScript,
  onResetToDefaults,
}: {
  type: ProjectType;
  preDeployScript: string;
  postDeployScript: string;
  onPreDeployScript: (v: string) => void;
  onPostDeployScript: (v: string) => void;
  onResetToDefaults: () => void;
}) {
  const isPhp = type === 'php';

  return (
    <details className="group rounded-2xl border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-3.5 p-6 [&::-webkit-details-marker]:hidden">
        <IconChip>
          <PlayCircle size={20} strokeWidth={ICON_STROKE} />
        </IconChip>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold text-ink">Deploy scripts</h2>
          <p className="mt-0.5 text-sm text-soft">
            {isPhp ? "Laravel's artisan steps, at the stage each one belongs to." : 'Shell scripts run around each deploy.'}
          </p>
        </div>
        <ChevronDown size={18} strokeWidth={ICON_STROKE} aria-hidden className="shrink-0 text-icon transition-transform duration-150 ease-out group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-4 px-6 pb-6">
        <Field label="Pre-deploy" hint="Runs after the code is exported and .env is written, before the install command. A non-zero exit fails the deploy.">
          <Textarea mono spellCheck={false} rows={6} value={preDeployScript} onChange={(event) => onPreDeployScript(event.target.value)} />
        </Field>
        <Field label="Post-deploy" hint="Runs once the release is live and healthy. A failure here does not roll it back.">
          <Textarea mono spellCheck={false} rows={8} value={postDeployScript} onChange={(event) => onPostDeployScript(event.target.value)} />
        </Field>
        {isPhp && (
          <div>
            <Button type="button" variant="outline" size="sm" onClick={onResetToDefaults}>
              Reset to Laravel defaults
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}

/**
 * The full-page setup screen. Deliberately replaces the form rather than overlaying it: the form is
 * no longer actionable at this point (the project exists), and leaving it visible behind a spinner
 * invites someone to try editing fields that no longer feed anything.
 */
function PreparingScreen({ steps, projectName, domain }: { steps: PrepStep[]; projectName: string; domain: string }) {
  const settled = steps.filter((s) => s.state === 'done' || s.state === 'skipped' || s.state === 'failed').length;
  const percent = steps.length === 0 ? 0 : Math.round((settled / steps.length) * 100);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 py-12">
      <PreparingMark />

      <h1 className="mt-8 text-center text-2xl font-semibold text-ink">Setting up {projectName}</h1>
      <p className="mt-1.5 text-center font-mono text-sm text-soft">{domain}</p>

      <div className="mt-8 w-full max-w-md">
        <div className="h-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${String(percent)}%` }} />
        </div>

        <ol className="mt-6 flex flex-col gap-3">
          {steps.map((step) => (
            <li key={step.id} className="flex items-start gap-3">
              <PrepStepIcon state={step.state} />
              <span
                className={`text-sm transition-colors duration-300 ease-out ${
                  step.state === 'pending' ? 'text-faint' : step.state === 'failed' ? 'text-danger' : step.state === 'active' ? 'text-ink' : 'text-soft'
                }`}
              >
                {step.detail ?? step.label}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Per-step status glyph, on a fixed 18px box so the labels stay aligned as states change. */
function PrepStepIcon({ state }: { state: PrepState }) {
  const box = 'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center';
  if (state === 'done') {
    return (
      <span className={box}>
        <Check size={15} strokeWidth={2.25} aria-hidden className="text-ok" />
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className={box}>
        <X size={15} strokeWidth={2.25} aria-hidden className="text-danger" />
      </span>
    );
  }
  if (state === 'skipped') {
    return (
      <span className={box}>
        <Minus size={15} strokeWidth={2} aria-hidden className="text-faint" />
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span className={box}>
        <LoaderCircle size={15} strokeWidth={2.25} aria-hidden className="animate-spin text-ink" />
      </span>
    );
  }
  return (
    <span className={box} aria-hidden>
      <span className="h-1.5 w-1.5 rounded-full bg-line" />
    </span>
  );
}

/**
 * The mark above the steps: a static core with two counter-rotating arcs around it. Drawn inline
 * rather than pulled from an icon set because it has to animate, and built from `currentColor` and
 * the theme tokens so it reads correctly in both light and dark.
 */
function PreparingMark() {
  return (
    <div className="relative flex h-28 w-28 items-center justify-center" aria-hidden>
      {/* Outer arc, slow clockwise. */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full animate-spin text-line" style={{ animationDuration: '3.6s' }}>
        <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="60 229" />
      </svg>
      {/* Inner arc, faster and counter-clockwise, so the two never lock into one apparent shape. */}
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 h-full w-full animate-spin text-primary"
        style={{ animationDuration: '2.1s', animationDirection: 'reverse' }}
      >
        <circle cx="50" cy="50" r="36" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="40 186" />
      </svg>
      {/* The project itself: a box being packed. Static — the motion belongs to the arcs, and a
          third moving element reads as noise rather than progress. */}
      <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-ink">
        <Rocket size={24} strokeWidth={ICON_STROKE} />
      </span>
    </div>
  );
}

/**
 * Which email service this project's mail goes through, and — the point of showing it here at all —
 * exactly which `MAIL_*` that choice will put in the `.env` below.
 *
 * Those vars are deliberately NOT editable rows in the env card. Shipway regenerates them from this
 * choice on every deploy (`buildManagedVars`), and anything the user writes for the same key WINS
 * over the regenerated value (`buildEnvFile`) — so an editable copy would be a copy that silently
 * disables the dropdown above it. Showing them read-only, attributed, is the honest version: this
 * is what you picked, this is what it writes, change it by changing the choice.
 */
function MailCard({
  mode,
  mailpitAvailable,
  issue,
  managed,
  host,
  port,
  username,
  password,
  fromAddress,
  encryption,
  region,
  onModeChange,
  onHostChange,
  onPortChange,
  onUsernameChange,
  onPasswordChange,
  onFromAddressChange,
  onEncryptionChange,
  onRegionChange,
}: {
  mode: ProjectSmtpMode;
  mailpitAvailable: boolean;
  issue: string | null;
  managed: Record<string, string> | null;
  host: string;
  port: string;
  username: string;
  password: string;
  fromAddress: string;
  encryption: string;
  region: string;
  onModeChange: (mode: ProjectSmtpMode) => void;
  onHostChange: (value: string) => void;
  onPortChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onFromAddressChange: (value: string) => void;
  onEncryptionChange: (value: string) => void;
  onRegionChange: (value: string) => void;
}) {
  const selected = SMTP_OPTIONS.find((option) => option.value === mode) ?? SMTP_OPTIONS[0]!;

  return (
    <Card>
      <CardHeader
        icon={<Mail size={20} strokeWidth={ICON_STROKE} />}
        title="Email"
        description="How this project sends mail. Shipway writes the matching MAIL_* into the env below and keeps them in step with this choice."
      />
      <div className="mt-4 flex flex-col gap-4">
        <Field label="Service" hint={selected.blurb}>
          <Select value={mode} onChange={(event) => onModeChange(event.target.value as ProjectSmtpMode)}>
            {SMTP_OPTIONS.map((option) => (
              <option key={option.value} value={option.value} disabled={option.value === 'mailpit' && !mailpitAvailable}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        {mode === 'mailpit' && !mailpitAvailable && (
          <p className="text-[13px] text-warn">There is no Mailpit on this server, so this project would have nowhere to deliver. Pick another service.</p>
        )}

        {mode === 'custom' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="SMTP host">
              <Input mono value={host} onChange={(event) => onHostChange(event.target.value)} placeholder="smtp.example.com" autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Port">
              <Input mono value={port} onChange={(event) => onPortChange(event.target.value)} inputMode="numeric" autoComplete="off" />
            </Field>
            <Field label="Username" hint="Optional.">
              <Input mono value={username} onChange={(event) => onUsernameChange(event.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Password" hint="Optional.">
              <Input mono type="password" value={password} onChange={(event) => onPasswordChange(event.target.value)} autoComplete="new-password" />
            </Field>
            <Field label="From address" hint="Optional.">
              <Input mono value={fromAddress} onChange={(event) => onFromAddressChange(event.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Encryption" hint="Usually tls for 587, ssl for 465.">
              <Input mono value={encryption} onChange={(event) => onEncryptionChange(event.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          </div>
        )}

        {mode === 'ses' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Region" hint={`Endpoint: ${sesSmtpHost(region)}:${String(SES_SMTP_PORT)}`}>
              <Select mono value={region} onChange={(event) => onRegionChange(event.target.value)}>
                {SES_REGIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="From address" hint="Must be an identity verified in SES.">
              <Input mono value={fromAddress} onChange={(event) => onFromAddressChange(event.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="SMTP username" hint="From the SES console — not an AWS access key.">
              <Input mono value={username} onChange={(event) => onUsernameChange(event.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="SMTP password">
              <Input mono type="password" value={password} onChange={(event) => onPasswordChange(event.target.value)} autoComplete="new-password" />
            </Field>
          </div>
        )}

        {issue !== null ? (
          <p role="alert" className="text-[13px] text-danger">
            {issue}
          </p>
        ) : (
          <ManagedMailPreview mode={mode} label={selected.label} vars={managed} />
        )}
      </div>
    </Card>
  );
}

/**
 * The `MAIL_*` the chosen service contributes, shown read-only and attributed. Values are rendered
 * verbatim except the password, which is masked: this block sits on a page the user may well have
 * open in front of someone else, and the credential is already in the field above for anyone who
 * needs to check it.
 */
function ManagedMailPreview({ mode, label, vars }: { mode: ProjectSmtpMode; label: string; vars: Record<string, string> | null }) {
  if (vars === null) {
    return <p className="text-[13px] text-soft">Fill in the fields above to see what {label} will add to the env.</p>;
  }
  const entries = Object.entries(vars);
  if (entries.length === 0) {
    return (
      <p className="text-[13px] text-soft">
        {mode === 'none' ? 'Nothing is added to the env; MAIL_MAILER=log is written below so mail goes to the log.' : `${label} adds nothing to the env.`}
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
      <p className="text-[13px] font-medium text-ink">
        Added automatically because you picked {label}
      </p>
      <p className="mt-0.5 text-[13px] text-soft">
        Shipway owns these — they are rewritten from this choice on every deploy, so they are not in the editable env below.
      </p>
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-xs">
        {entries.map(([key, value]) => (
          <Fragment key={key}>
            <dt className="text-soft">{key}</dt>
            <dd className="truncate text-ink">{SECRET_MAIL_KEY_RE.test(key) ? '\u2022'.repeat(10) : value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/** Mail keys whose value is a credential, masked in the preview above. */
const SECRET_MAIL_KEY_RE = /PASSWORD/;

/**
 * The project's database, asked the way it actually works: first the connection — a database server
 * Shipway can reach — then either a new database created on it (a name is all it takes; Shipway
 * provisions the database and its user) or one that is already there, connected to as-is.
 *
 * Connection first rather than one flat list of every database, because the connection is the axis
 * that grows: an external Postgres (RDS, a managed instance) becomes another entry in that first
 * dropdown whose own databases fill the second, and nothing else about this card changes.
 */
function DatabaseCard({
  connections,
  connectionId,
  connection,
  mode,
  existingDatabases,
  existingDatabasesPending,
  existingId,
  existingDb,
  existingError,
  hiddenDatabaseCount,
  name,
  nameIssue,
  sqlFile,
  sqlIssue,
  onConnectionChange,
  onCreateNewChange,
  onExistingChange,
  onNameChange,
  onSqlFileChange,
}: {
  connections: DbConnection[];
  connectionId: string;
  connection: DbConnection | null;
  mode: DbMode;
  existingDatabases: DatabaseListItem[];
  existingDatabasesPending: boolean;
  existingId: number | null;
  existingDb: DatabaseListItem | null;
  existingError: string | null;
  hiddenDatabaseCount: number;
  name: string;
  nameIssue: string | null;
  sqlFile: File | null;
  sqlIssue: string | null;
  onConnectionChange: (id: string) => void;
  onCreateNewChange: (createNew: boolean) => void;
  onExistingChange: (id: number | null) => void;
  onNameChange: (name: string) => void;
  onSqlFileChange: (file: File | null) => void;
}) {
  // Named so the card can say which of this host's engines is missing rather than just quietly
  // listing fewer connections — an absent entry otherwise reads as a bug rather than as
  // unconfigured credentials. Registered external servers are not expected to be there at all, so
  // only the two local engines are checked for.
  const missingEngines = DB_ENGINES.filter((engine) => !connections.some((row) => row.kind === 'local' && row.engine === engine.value));
  // Nothing to pick from, so the choice collapses to "create a new one" on its own.
  const noExisting = !existingDatabasesPending && existingDatabases.length === 0;

  return (
    <Card>
      <CardHeader
        icon={<Database size={20} strokeWidth={ICON_STROKE} />}
        title="Database"
        description="Pick a connection, then create a database on it or use one that's already there. Its credentials go into the env below as DB_*."
      />
      <div className="mt-4 flex flex-col gap-4">
        <Field
          label="Connection"
          hint={
            connections.length === 0
              ? 'No database server on this host has admin credentials configured.'
              : 'The database server this project connects to.'
          }
        >
          <Select mono value={connectionId} onChange={(event) => onConnectionChange(event.target.value)}>
            <option value={DB_CONNECTION_NONE}>No database</option>
            {connections.map((row) => (
              <option key={row.key} value={row.key}>
                {connectionLabel(row)}
              </option>
            ))}
          </Select>
        </Field>

        {missingEngines.length > 0 && (
          <p className="text-[13px] text-soft">
            {missingEngines.map((engine) => engine.label).join(' and ')} has no admin credentials on this server, so it isn&rsquo;t
            listed as a connection. External servers can be registered on the{' '}
            <Link href="/databases" className="font-medium text-link hover:underline">
              Databases page
            </Link>
            .
          </p>
        )}

        {connection !== null && (
          <>
            <div role="radiogroup" aria-label="How this project gets its database" className="flex flex-col gap-3 sm:flex-row">
              <DbModeOption
                label="Use an existing database"
                description={noExisting ? 'Nothing on this connection yet' : `${String(existingDatabases.length)} on this connection`}
                checked={mode === 'existing'}
                disabled={noExisting}
                onSelect={() => onCreateNewChange(false)}
              />
              <DbModeOption
                label="Create a new database"
                description="Shipway provisions it and its user"
                checked={mode === 'create'}
                disabled={false}
                onSelect={() => onCreateNewChange(true)}
              />
            </div>

            {mode === 'existing' &&
              (existingDatabasesPending ? (
                <Skeleton className="h-11 w-full" />
              ) : (
                <Field
                  label="Database"
                  error={existingError ?? undefined}
                  hint={
                    existingError
                      ? undefined
                      : existingDatabases.length === 0
                        ? 'No databases on this connection yet — create one instead.'
                        : 'Databases on this connection, as listed on the Databases page.'
                  }
                >
                  <Select
                    mono
                    value={existingId === null ? '' : String(existingId)}
                    onChange={(event) => onExistingChange(event.target.value === '' ? null : Number(event.target.value))}
                  >
                    <option value="">Select a database…</option>
                    {existingDatabases.map((database) => (
                      <option key={database.id} value={database.id}>
                        {databaseOptionLabel(database)}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}

            {mode === 'create' && (
              <>
                <Field
                  label="Database name"
                  error={nameIssue ?? undefined}
                  hint={nameIssue ? undefined : `Created on ${connection.name}, with a user of the same name. Suggested from the subdomain.`}
                >
                  <Input mono value={name} onChange={(event) => onNameChange(event.target.value)} autoComplete="off" spellCheck={false} />
                </Field>
                <SqlFileField file={sqlFile} issue={sqlIssue} engineLabel={DB_ENGINE_LABEL[connection.engine]} onChange={onSqlFileChange} />
              </>
            )}
          </>
        )}

        {hiddenDatabaseCount > 0 && (
          <p className="text-[13px] text-warn">
            {hiddenDatabaseCount} {hiddenDatabaseCount === 1 ? 'database is' : 'databases are'} not listed: their name is a system
            database on MySQL or PostgreSQL, so their credentials must not go into a project.{' '}
            <Link href="/databases" className="font-medium text-link hover:underline">
              Review them
            </Link>
            .
          </p>
        )}

        {mode === 'existing' && existingDb !== null && (
          <div className="rounded-xl bg-surface-2 px-4 py-3 font-mono text-sm text-soft">
            user {existingDb.username} · password filled in when the project is created
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * The optional dump to load into the database being created. Deliberately a field on "create a new
 * database" rather than a third mode next to it: importing a dump is not a different answer to
 * "where does this project's database come from", it is what the new database starts out holding —
 * and as a mode it would have duplicated the name field and its validation to add one file picker.
 *
 * The `<input type="file">` is visually hidden but still focusable, with the label doing the
 * clicking, because the native control cannot be styled into the rest of this form. Clearing the
 * choice is a real button OUTSIDE the label — inside it, every click would reopen the picker.
 */
function SqlFileField({
  file,
  issue,
  engineLabel,
  onChange,
}: {
  file: File | null;
  issue: string | null;
  engineLabel: string;
  onChange: (file: File | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">SQL file (optional)</span>
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2 transition-colors duration-150 ease-out hover:bg-surface-2 has-[:focus-visible]:border-focus">
          <input
            type="file"
            accept=".sql,application/sql,text/plain"
            className="sr-only"
            onChange={(event) => onChange(event.target.files?.[0] ?? null)}
          />
          <span className={buttonClasses('outline', 'sm', 'pointer-events-none shrink-0')}>
            <Upload size={15} strokeWidth={ICON_STROKE} aria-hidden />
            {file === null ? 'Choose file' : 'Replace'}
          </span>
          <span className={`min-w-0 truncate text-sm ${file === null ? 'text-soft' : 'font-mono text-ink'}`}>
            {file === null ? 'No file chosen' : `${file.name} · ${formatFileSize(file.size)}`}
          </span>
        </label>
        {file !== null && (
          <button
            type="button"
            aria-label="Remove the SQL file"
            onClick={() => onChange(null)}
            className="shrink-0 rounded-xl border border-line bg-surface p-2.5 text-icon transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X size={15} strokeWidth={ICON_STROKE} aria-hidden />
          </button>
        )}
      </div>
      {issue !== null ? (
        <span className="text-[13px] text-danger">{issue}</span>
      ) : (
        <span className="text-[13px] text-soft">
          Replayed into the new database with the {engineLabel} client as soon as it exists, before the first deploy. Up to{' '}
          {formatFileSize(MAX_SQL_IMPORT_BYTES)}.
        </span>
      )}
    </div>
  );
}

/** One of the two answers to "how does this project get its database" — same shape as the engine
 * radios on the Databases page, so the two pages read as one idea. */
function DbModeOption({
  label,
  description,
  checked,
  disabled,
  onSelect,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`flex flex-1 items-start gap-3 rounded-xl border px-4 py-3 transition-colors duration-150 ease-out ${
        disabled
          ? 'cursor-not-allowed border-line bg-surface opacity-60'
          : checked
            ? 'cursor-pointer border-focus bg-surface-2'
            : 'cursor-pointer border-line bg-surface hover:bg-surface-2'
      }`}
    >
      <input
        type="radio"
        name="db-mode"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span className="mt-0.5 block text-[13px] text-soft">{description}</span>
      </span>
    </label>
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
      <CardHeader icon={<Tag size={20} strokeWidth={ICON_STROKE} />} title="Project name" description="Used for the subdomain and process names." />
      <div className="mt-4 flex flex-col gap-4">
        <Field label="Name">
          <Input required value={name} onChange={(event) => onNameChange(event.target.value)} />
        </Field>
        <Field label="Subdomain" hint={slugError ? undefined : 'Lowercase letters, numbers, and hyphens.'} error={slugError}>
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
  domainCardRef,
  type,
  buildCmd,
  database,
  submitting,
  canSubmit,
  formError,
  provisionError,
  created,
  setupError,
  onDeployAnyway,
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
  domainCardRef: RefObject<HTMLDivElement | null>;
  type: ProjectType;
  buildCmd: string;
  database: { engine: DbEngine; name: string } | null;
  submitting: boolean;
  canSubmit: boolean;
  formError: string | null;
  provisionError: ProvisionError | null;
  created: { id: number; slug: string } | null;
  setupError: SetupFailure | null;
  onDeployAnyway: () => void;
}) {
  const domain = `${slug || 'your-project'}.${baseDomain}`;

  return (
    <>
      <Card>
        <CardHeader icon={source?.kind === 'url' ? <Link2 size={20} strokeWidth={ICON_STROKE} /> : <GitBranch size={20} strokeWidth={ICON_STROKE} />} title="Source" description={source ? sourceLabel(source) : undefined} />
        <div className="mt-4">
          {source?.kind === 'github' ? (
            <GithubBranchField repo={source.repo} branch={source.branch} onChange={onBranchChange} />
          ) : source?.kind === 'url' ? (
            <GitUrlBranchField repoUrl={source.repoUrl} branch={source.branch} onChange={onBranchChange} />
          ) : (
            <Field label="Branch">
              <Input mono value="" onChange={(event) => onBranchChange(event.target.value)} />
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
        domainCardRef={domainCardRef}
      />

      <Card>
        <CardHeader icon={<Rocket size={20} strokeWidth={ICON_STROKE} />} title="Deploy summary" description="What Deploy will create" />
        <div className="mt-4 flex flex-col">
          <SummaryRow icon={<Globe size={15} strokeWidth={ICON_STROKE} />} label="Domain" value={domain} mono />
          <SummaryRow
            icon={<GitBranch size={15} strokeWidth={ICON_STROKE} />}
            label="Branch"
            value={source?.branch || 'not set'}
            mono={Boolean(source?.branch)}
            muted={!source?.branch}
          />
          <SummaryRow icon={<TypeIcon type={type} size={15} />} label="Framework" value={TYPE_LABEL[type]} />
          <SummaryRow
            icon={<Terminal size={15} strokeWidth={ICON_STROKE} />}
            label="Build command"
            value={buildCmd || 'none'}
            mono={buildCmd !== ''}
            muted={buildCmd === ''}
          />
          <SummaryRow
            icon={<Database size={15} strokeWidth={ICON_STROKE} />}
            label="Database"
            value={database ? `${DB_ENGINE_LABEL[database.engine]} · ${database.name}` : 'none'}
            mono={database !== null}
            muted={database === null}
          />
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

      {/* The project exists but its database does not, so its first deploy would fail its
          migrations. Deploying is still the user's call — nothing here is stuck. */}
      {created && setupError ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
            <p className="text-sm font-medium text-danger">{SETUP_FAILURE_TITLE[setupError.stage]}</p>
            <p className="mt-1 text-sm whitespace-pre-wrap text-soft">{setupError.message}</p>
            <SetupFailureAdvice stage={setupError.stage} projectId={created.id} />
          </div>
          <Button type="button" variant="outline" onClick={onDeployAnyway} className="w-full">
            Deploy anyway
          </Button>
          <ButtonLink href={`/projects/${String(created.id)}`} variant="secondary" className="w-full">
            Open project
          </ButtonLink>
        </div>
      ) : (
        <Button type="submit" loading={submitting} disabled={!canSubmit} className="w-full">
          Deploy
        </Button>
      )}
    </>
  );
}

/** What the rail leads with per failed step. The project exists in all three cases; only the thing
 * that is missing differs. */
const SETUP_FAILURE_TITLE: Record<SetupFailure['stage'], string> = {
  create: 'Project created, but its database wasn\u2019t',
  import: 'Database created, but the SQL file didn\u2019t import',
  smtp: 'Project created, but its email service wasn\u2019t saved',
};

/** The next move for each failed step — different enough per stage to be worth saying outright
 * rather than leaving the user to work out which page owns the thing that broke. */
function SetupFailureAdvice({ stage, projectId }: { stage: SetupFailure['stage']; projectId: number }) {
  if (stage === 'smtp') {
    return (
      <p className="mt-2 text-sm text-soft">
        The project is fine and will deploy; mail just falls back to the default until you set it on its{' '}
        <Link href={`/projects/${String(projectId)}/smtp`} className="font-medium text-link hover:underline">
          Email tab
        </Link>
        .
      </p>
    );
  }
  if (stage === 'import') {
    return (
      <p className="mt-2 text-sm text-soft">
        The database exists and its credentials are already in this project&rsquo;s env — only the dump is missing. Load it from the
        console on{' '}
        <Link href="/databases" className="font-medium text-link hover:underline">
          Databases
        </Link>
        , then deploy.
      </p>
    );
  }
  return (
    <p className="mt-2 text-sm text-soft">
      Create it from{' '}
      <Link href="/databases" className="font-medium text-link hover:underline">
        Databases
      </Link>{' '}
      and use &ldquo;Add to project env&rdquo;, then deploy.
    </p>
  );
}

/**
 * Right rail's Domain card (plan Task 5 / spec §3 "New Project DNS"): shows the exact `A` record
 * this project would get, live Cloudflare connection status, and — while it can't actually be
 * created (missing server IP, or Cloudflare not connected) — a calm explanation plus the "create
 * anyway" acknowledgment that gates Deploy. After a successful create, `dnsResult` replaces the
 * live-status section with what actually happened, briefly, before the page navigates away.
 *
 * `domainCardRef` is attached to the outer wrapper (not `Card` itself, which doesn't forward refs)
 * so `handleDeploy` can `scrollIntoView` it the instant a result lands — the right rail scrolls
 * with the page (it isn't sticky), so without this a user who submitted from further down the form
 * would never actually see the result before navigating away.
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
  domainCardRef,
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
  domainCardRef: RefObject<HTMLDivElement | null>;
}) {
  const dnsTone = dnsResult === null ? null : dnsResultTone(dnsResult);

  return (
    <div ref={domainCardRef}>
      <Card>
        <CardHeader icon={<Globe size={20} strokeWidth={ICON_STROKE} />} title="Domain" description="Where this project will be reachable" />

        <div className="mt-4 flex flex-col gap-3">
          {/* The URL itself, given the weight the card's title promises — it is the one thing on
              this card a user wants to read back, and the one thing worth copying. */}
          {!settingsSettled ? (
            <Skeleton className="h-14 w-full" />
          ) : (
            <div className="flex items-center gap-2.5 rounded-xl border border-line bg-surface-2 py-2.5 pr-2 pl-3.5">
              <Lock size={15} strokeWidth={ICON_STROKE} aria-hidden className="shrink-0 text-icon" />
              <p className="min-w-0 flex-1 truncate font-mono text-sm text-ink" title={domain}>
                <span className="text-faint">https://</span>
                <span className="font-medium">{domain}</span>
              </p>
              <CopyIconButton value={`https://${domain}`} label="Copy project URL" />
            </div>
          )}

          {/* The A record, as a record: three labelled fields rather than one run-on mono line, so
              it can be read (and retyped into another DNS provider) field by field. */}
          {!settingsSettled ? (
            <Skeleton className="h-28 w-full" />
          ) : serverIpMissing ? (
            <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
              <p className="text-sm text-soft">
                Set the server IP in{' '}
                <Link href="/settings/general" className="font-medium text-link hover:underline">
                  Settings &gt; General
                </Link>{' '}
                before Shipway can create a DNS record for this project.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-line bg-surface-2 p-3">
              <div className="flex items-center justify-between gap-2 px-0.5">
                <span className="section-label">DNS record</span>
                {dnsResult === null && <Badge tone={cloudflare.tone}>{cloudflare.label}</Badge>}
              </div>
              <dl className="mt-2.5 flex flex-col gap-1.5">
                <DnsRecordField label="Type" value="A" />
                <DnsRecordField label="Name" value={domain} />
                <DnsRecordField label="Value" value={serverIp ?? ''} />
              </dl>
            </div>
          )}

          {dnsResult !== null && dnsTone !== null ? (
            <div className={`flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm ${DNS_RESULT_TONE_CLASSES[dnsTone]}`}>
              <span aria-hidden className="mt-px shrink-0">
                {dnsTone === 'ok' ? (
                  <Check size={16} strokeWidth={2.25} />
                ) : dnsTone === 'danger' ? (
                  <X size={16} strokeWidth={2.25} />
                ) : (
                  <Minus size={16} strokeWidth={2.25} />
                )}
              </span>
              <span className="min-w-0">{dnsResultLine(dnsResult)}</span>
            </div>
          ) : (
            settingsSettled &&
            !cloudflare.pending &&
            !dnsReady && (
              <div className="rounded-xl border border-warn/30 bg-warn/5 px-4 py-3">
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
            )
          )}
        </div>
      </Card>
    </div>
  );
}

/** The framework's own brand mark (same marks as the type tiles), at summary-row scale. */
function TypeIcon({ type, size }: { type: ProjectType; size: number }) {
  const option = TYPE_OPTIONS.find((candidate) => candidate.value === type);
  if (!option) return null;
  return <option.Icon size={size} />;
}

/** One field of the A record: a fixed-width micro label with the value in mono beside it. */
function DnsRecordField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 px-0.5">
      <dt className="section-label w-11 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-sm text-ink" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * One line of the Deploy summary: icon + label on the left, the value right-aligned, hairline
 * between rows. `muted` renders a value that is an absence ("none") in the faint tone, so a glance
 * down the card separates what was configured from what wasn't.
 */
function SummaryRow({
  icon,
  label,
  value,
  mono = false,
  muted = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0 last:pb-0 first:pt-0">
      <span className="flex min-w-0 shrink-0 items-center gap-2 text-sm text-soft">
        <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center text-icon">
          {icon}
        </span>
        {label}
      </span>
      <span
        title={value}
        className={`min-w-0 truncate text-right text-sm ${muted ? 'text-faint' : 'font-medium text-ink'} ${mono ? 'font-mono' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Branch dropdown for a pasted Git URL, from `git ls-remote` (`GET /api/git/branches`). Falls back
 * to a free-text input whenever the remote can't be listed — a private URL without credentials, a
 * host that doesn't answer — because a branch typed by hand still deploys fine; only the
 * convenience of picking from a list is lost.
 *
 * On the first successful listing it also corrects the branch: step 1 has to guess `main` before
 * anything about the remote is known, and a repo whose default is `master` (or `develop`) would
 * otherwise fail its first deploy with "branch not found". The ref keeps that to exactly once, so
 * it can never fight a choice the user makes afterwards.
 */
function GitUrlBranchField({ repoUrl, branch, onChange }: { repoUrl: string; branch: string; onChange: (branch: string) => void }) {
  const branchesQuery = useGitBranches(repoUrl);
  const branches = branchesQuery.data?.branches;
  const defaultBranch = branchesQuery.data?.defaultBranch ?? null;
  const correctedRef = useRef(false);

  useEffect(() => {
    if (correctedRef.current || !branches || branches.length === 0) return;
    correctedRef.current = true;
    if (!branches.includes(branch) && defaultBranch !== null) {
      onChange(defaultBranch);
    }
  }, [branches, defaultBranch, branch, onChange]);

  if (branchesQuery.isPending) {
    return <Skeleton className="h-11 w-full" />;
  }

  if (branchesQuery.isError || !branches || branches.length === 0) {
    return (
      <Field
        label="Branch"
        hint={branchesQuery.isError ? "Couldn't read the branches from this URL — type the branch to deploy." : undefined}
      >
        <Input mono value={branch} onChange={(event) => onChange(event.target.value)} />
      </Field>
    );
  }

  const options = branches.includes(branch) ? branches : [branch, ...branches];

  return (
    <Field label="Branch" as="div" hint={`${branches.length} ${branches.length === 1 ? 'branch' : 'branches'} on this remote — type to search.`}>
      <Combobox
        mono
        noun="branch"
        allowCustom
        icon={<GitBranch size={15} strokeWidth={ICON_STROKE} />}
        value={branch}
        options={options}
        onChange={onChange}
      />
    </Field>
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

  const branches = branchesQuery.data ?? [];
  const options = branches.includes(branch) ? branches : [branch, ...branches];

  return (
    <Field label="Branch" as="div" hint={`${branches.length} ${branches.length === 1 ? 'branch' : 'branches'} in this repo — type to search.`}>
      <Combobox
        mono
        noun="branch"
        icon={<GitBranch size={15} strokeWidth={ICON_STROKE} />}
        value={branch}
        options={options}
        onChange={onChange}
      />
    </Field>
  );
}
