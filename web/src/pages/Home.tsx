/**
 * Home dashboard (route `/`, DESIGN.md's Home): the greeting header, a "Your Projects" card
 * (recent deploys list or the launch illustration when there are none yet), four quick-action
 * tiles, and a right rail (Activity counts + system status, Quick Tip). All data comes from
 * `GET /api/overview` via `useOverview()` (Task 5), polled every 30s.
 */
import type { ComponentType, ReactNode } from 'react';
import { Link } from 'wouter';
import {
  Activity,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Database,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Globe,
  Rocket,
  Settings as SettingsIcon,
  Upload,
  Zap,
} from 'lucide-react';
import type { DeploymentStatus, Overview, OverviewRecentProject, ProjectType } from '../api';
import { useOverview } from '../hooks';
import { formatRelativeTime } from '../lib/format';
import {
  Badge,
  ButtonLink,
  Card,
  CardHeader,
  ICON_STROKE,
  IconChip,
  PageHeader,
  PageWithRail,
  Skeleton,
  StatusDot,
  type StatusDotStatus,
} from '../components/ui';

const PROJECT_TYPE_LABEL: Record<ProjectType, string> = {
  php: 'PHP',
  node: 'Node',
  nextjs: 'Next.js',
  static: 'Static',
};

const DOT_STATUS_BY_DEPLOY: Record<DeploymentStatus, StatusDotStatus> = {
  queued: 'warn',
  running: 'warn',
  success: 'ok',
  failed: 'danger',
  rolled_back: 'ok',
  canceled: 'idle',
};

const DEPLOY_STATUS_LABEL: Record<DeploymentStatus, string> = {
  queued: 'queued',
  running: 'running',
  success: 'success',
  failed: 'failed',
  rolled_back: 'rolled back',
  canceled: 'canceled',
};

/** "Good morning/afternoon/evening" from the local clock (DESIGN.md Copy). */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function HomePage() {
  const overviewQuery = useOverview();

  if (overviewQuery.isPending) {
    return <HomeSkeleton />;
  }

  if (overviewQuery.isError || !overviewQuery.data) {
    return (
      <div>
        <PageHeader title="Home" />
        <p role="alert" className="text-base text-danger">
          Could not load the dashboard. Try refreshing.
        </p>
      </div>
    );
  }

  return <HomeContent overview={overviewQuery.data} />;
}

function HomeContent({ overview }: { overview: Overview }) {
  const firstName = overview.user.name.trim().split(/\s+/)[0] || overview.user.name;
  const degraded = overview.servicesDown.length > 0;

  return (
    <div>
      <PageHeader title={`${greeting()}, ${firstName}`} subtitle="Here's what's happening across your projects" />

      <PageWithRail
        rail={
          <>
            <ActivityCard overview={overview} degraded={degraded} />
            <QuickTipCard hasProjects={overview.projects > 0} />
          </>
        }
      >
        <Card>
          <CardHeader
            icon={<FolderGit2 size={20} strokeWidth={ICON_STROKE} />}
            title="Your Projects"
            description={`${String(overview.projects)} ${overview.projects === 1 ? 'project' : 'projects'}`}
            action={
              <Link href="/projects" className="text-sm font-medium text-link hover:underline">
                View all →
              </Link>
            }
          />
          <div className="mt-5">
            {overview.projects > 0 ? (
              <div className="divide-y divide-line">
                {overview.recentProjects.map((project) => (
                  <ProjectRow key={project.id} project={project} />
                ))}
              </div>
            ) : (
              <ProjectsEmptyState />
            )}
          </div>
        </Card>

        <div className="grid grid-cols-2 gap-4 min-[900px]:grid-cols-4">
          {QUICK_ACTIONS.map((action) => (
            <QuickActionTile key={action.label} action={action} />
          ))}
        </div>
      </PageWithRail>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Your Projects — row (non-empty) and illustrated empty state.
// ---------------------------------------------------------------------------

function ProjectRow({ project }: { project: OverviewRecentProject }) {
  const status: StatusDotStatus = project.lastDeployment ? DOT_STATUS_BY_DEPLOY[project.lastDeployment.status] : 'idle';
  const lastDeployLabel = !project.lastDeployment
    ? 'Not deployed yet'
    : project.lastDeployment.finishedAt !== null
      ? formatRelativeTime(project.lastDeployment.finishedAt)
      : DEPLOY_STATUS_LABEL[project.lastDeployment.status];

  return (
    <Link
      href={`/projects/${String(project.id)}`}
      className="group flex h-14 items-center gap-3 rounded-xl px-2 transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <StatusDot status={status} />
      <span className="min-w-0 flex-1 truncate text-base font-medium text-ink">{project.name}</span>
      <Badge>{PROJECT_TYPE_LABEL[project.type]}</Badge>
      <span className="w-28 shrink-0 text-right text-sm text-soft">{lastDeployLabel}</span>
      <ArrowRight
        size={18}
        strokeWidth={ICON_STROKE}
        aria-hidden
        className="shrink-0 text-icon opacity-60 transition-opacity duration-150 ease-out group-hover:opacity-100"
      />
    </Link>
  );
}

/** One node of the launch illustration: an icon squircle + label, connected to the center ring. */
interface IllustrationNode {
  x: number;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

const ILLUSTRATION_NODES: IllustrationNode[] = [
  { x: 45, label: 'Repo', icon: GitBranch },
  { x: 135, label: 'Domain', icon: Globe },
  { x: 225, label: 'Deploy', icon: Upload },
  { x: 315, label: 'Data', icon: Database },
];

/**
 * Empty-state illustration (DESIGN.md Empty states): a central ring node with a tiny "live" dot,
 * dashed connectors fanning out to four labeled mini-squircles built from the same icon language
 * used everywhere else on the page. Purely decorative — the headline/copy carry the meaning.
 */
function LaunchIllustration() {
  return (
    <div className="relative mx-auto h-[184px] w-[360px]" aria-hidden="true">
      <svg width={360} height={184} className="absolute inset-0 text-line">
        {ILLUSTRATION_NODES.map((node) => (
          <line
            key={node.label}
            x1={180}
            y1={56}
            x2={node.x}
            y2={118}
            stroke="currentColor"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            strokeLinecap="round"
          />
        ))}
      </svg>

      <div className="absolute top-0 left-1/2 h-14 w-14 -translate-x-1/2 rounded-full border-2 border-line bg-surface-2">
        <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-ok" />
      </div>

      {ILLUSTRATION_NODES.map(({ x, label, icon: Icon }) => (
        <div
          key={label}
          className="absolute top-[118px] flex w-[72px] -translate-x-1/2 flex-col items-center gap-2"
          style={{ left: x }}
        >
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-surface-2 text-icon">
            <Icon size={18} strokeWidth={ICON_STROKE} />
          </div>
          <span className="text-xs text-soft">{label}</span>
        </div>
      ))}
    </div>
  );
}

function ProjectsEmptyState() {
  return (
    <div className="flex flex-col items-center gap-5 px-4 py-8 text-center">
      <LaunchIllustration />
      <div className="flex flex-col items-center gap-2">
        <h3 className="text-2xl font-semibold text-ink">Launch your first project</h3>
        <p className="max-w-md text-lg text-soft">
          Connect a repository and Shipway builds it, ships it, and hands you a live URL in minutes.
        </p>
      </div>
      <div className="mt-1 flex items-center gap-2.5">
        <ButtonLink href="/projects/new" variant="primary">
          Create project
        </ButtonLink>
        <ButtonLink href="/projects/new" variant="secondary">
          Import from GitHub
        </ButtonLink>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick-action tiles.
// ---------------------------------------------------------------------------

interface QuickAction {
  href: string;
  external?: boolean;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  sublabel: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  { href: '/projects/new', icon: GitBranch, label: 'New project', sublabel: 'From repository' },
  { href: '/deployments', icon: Rocket, label: 'Deployments', sublabel: 'Across all projects' },
  { href: '/settings/general', icon: SettingsIcon, label: 'Settings', sublabel: 'Account & team' },
  {
    href: 'https://github.com/hazem-hammad/shipway#readme',
    icon: BookOpen,
    label: 'Docs',
    sublabel: 'Server setup guide',
    external: true,
  },
];

function QuickActionTile({ action }: { action: QuickAction }) {
  const { href, icon: Icon, label, sublabel, external } = action;
  const className =
    'flex flex-col items-start gap-3 rounded-2xl border border-line bg-surface p-5 transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

  const content = (
    <>
      <IconChip>
        <Icon size={20} strokeWidth={ICON_STROKE} />
      </IconChip>
      <span className="flex items-center gap-1.5 text-base font-semibold text-ink">
        {label}
        {external && <ExternalLink size={14} strokeWidth={ICON_STROKE} aria-hidden className="text-icon" />}
      </span>
      <span className="text-sm text-soft">{sublabel}</span>
    </>
  );

  return external ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
      {content}
    </a>
  ) : (
    <Link href={href} className={className}>
      {content}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Right rail: Activity + Quick Tip.
// ---------------------------------------------------------------------------

function ActivityRow({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between px-1 py-2">
      <span className="flex items-center gap-3 text-base text-ink">
        <IconChip size={36}>{icon}</IconChip>
        {label}
      </span>
      <span className="text-[18px] font-semibold text-ink">{value}</span>
    </div>
  );
}

function ActivityCard({ overview, degraded }: { overview: Overview; degraded: boolean }) {
  return (
    <Card>
      <CardHeader icon={<Activity size={20} strokeWidth={ICON_STROKE} />} title="Activity" />
      <div className="mt-4 flex flex-col gap-0.5">
        <ActivityRow icon={<FolderGit2 size={18} strokeWidth={ICON_STROKE} />} label="Projects" value={overview.projects} />
        <ActivityRow icon={<Rocket size={18} strokeWidth={ICON_STROKE} />} label="Deployments" value={overview.deployments} />
        <div className="my-2 border-t border-line" />
        <div className="flex items-center justify-between px-1 py-2">
          <span className="flex items-center gap-3 text-base text-ink">
            <CheckCircle2 size={18} strokeWidth={ICON_STROKE} className="text-icon" />
            System status
          </span>
          <span
            className={`text-sm font-medium ${degraded ? 'text-warn' : 'text-ok'}`}
            title={degraded ? `Down: ${overview.servicesDown.join(', ')}` : undefined}
          >
            {degraded ? 'Degraded' : 'Operational'}
          </span>
        </div>
      </div>
    </Card>
  );
}

function QuickTipCard({ hasProjects }: { hasProjects: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-surface-2 p-5">
      <IconChip tone="orange" size={36}>
        <Zap size={18} strokeWidth={ICON_STROKE} />
      </IconChip>
      <p className="mt-3 text-sm text-ink">
        {hasProjects
          ? 'Push to a connected branch and Shipway deploys it automatically.'
          : 'Create your first project to start deploying.'}
      </p>
      <Link href="/projects/new" className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-link hover:underline">
        New Project →
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton.
// ---------------------------------------------------------------------------

function HomeSkeleton() {
  return (
    <div>
      <div className="mb-8">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="mt-2 h-5 w-96" />
      </div>
      <PageWithRail
        rail={
          <>
            <Card className="flex flex-col gap-4">
              <Skeleton className="h-10 w-10 rounded-xl" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </Card>
            <Card className="flex flex-col gap-3 bg-surface-2">
              <Skeleton className="h-9 w-9 rounded-xl" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-1/2" />
            </Card>
          </>
        }
      >
        <Card className="flex flex-col gap-4">
          <div className="flex items-center gap-3.5">
            <Skeleton className="h-10 w-10 rounded-xl" />
            <div className="flex-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-2 h-3 w-20" />
            </div>
          </div>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </Card>
        <div className="grid grid-cols-2 gap-4 min-[900px]:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
      </PageWithRail>
    </div>
  );
}
