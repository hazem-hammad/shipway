/**
 * Project detail shell (DESIGN.md v2: header CARD — status dot, name, domain link, repo/branch
 * chips, right-aligned Deploy — with pill Tabs underneath). Routed as `/projects/:id` with `nest`
 * (see App.tsx), so every tab below — plus the deployment log page — is addressed by a plain
 * relative path inside this component's own Switch. The Deploy button lives here (not in the
 * Deployments tab) since it acts on the project as a whole, matching every other page's row-level
 * Deploy affordance (Projects.tsx, Home.tsx).
 */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link, Route, Switch, useLocation, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, GitBranch } from 'lucide-react';
import { ApiError, deployProject, type DeploymentStatus, type Project, type ProjectType } from '../../api';
import { useDeployments, useProject, useSettings } from '../../hooks';
import { Button, Card, EmptyState, ICON_STROKE, Skeleton, StatusDot, type StatusDotStatus } from '../../components/ui';
import DeploymentsTab from './Deployments';
import DeploymentLogPage from './DeploymentLog';
import SettingsTab from './Settings';
import EnvEditorTab from './EnvEditor';
import DatabaseTab from './Database';
import ScriptsTab from './Scripts';
import WorkersTab from './Workers';
import CronTab from './Cron';
import SmtpTab from './Smtp';
import DangerTab from './Danger';
import { projectDomain, projectHost } from '../../../../server/src/lib/domain.js';

const DOT_STATUS_BY_DEPLOY: Record<DeploymentStatus, StatusDotStatus> = {
  queued: 'warn',
  running: 'warn',
  success: 'ok',
  failed: 'danger',
  rolled_back: 'ok',
  canceled: 'idle',
};

type TabKey = 'deployments' | 'settings' | 'environment' | 'database' | 'scripts' | 'workers' | 'cron' | 'smtp' | 'danger';

interface TabDef {
  key: TabKey;
  href: string;
  label: string;
}

const TABS: TabDef[] = [
  { key: 'deployments', href: '/', label: 'Deployments' },
  { key: 'settings', href: '/settings', label: 'Settings' },
  { key: 'environment', href: '/environment', label: 'Environment' },
  { key: 'database', href: '/database', label: 'Database' },
  { key: 'scripts', href: '/scripts', label: 'Scripts' },
  { key: 'workers', href: '/workers', label: 'Workers' },
  { key: 'cron', href: '/cron', label: 'Cron' },
  { key: 'smtp', href: '/smtp', label: 'SMTP' },
  { key: 'danger', href: '/danger', label: 'Danger' },
];

/**
 * Sections a given project type has no use for. Keyed by type rather than expressed as a condition
 * on each tab, so what a type does and doesn't get is one list to read.
 *
 * `TabKey` is a union rather than `string` specifically so an entry here cannot drift: rename a tab
 * and this stops compiling, instead of quietly hiding nothing.
 */
const HIDDEN_TABS: Partial<Record<ProjectType, readonly TabKey[]>> = {
  nextjs: ['database', 'smtp', 'workers', 'cron'],
};

function hasSection(type: ProjectType, key: TabKey): boolean {
  return !(HIDDEN_TABS[type] ?? []).includes(key);
}

function tabsForType(type: ProjectType): TabDef[] {
  return TABS.filter((tab) => hasSection(type, tab.key));
}

/** For a GitHub-App project, the repo full name; for a Git-URL project, just the host. */
function repoChipLabel(project: Project): string {
  if (project.repoUrl) {
    try {
      return new URL(project.repoUrl).host;
    } catch {
      return project.repoUrl;
    }
  }
  return project.repo;
}

export default function ProjectLayout() {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();

  const projectQuery = useProject(projectId);
  const settingsQuery = useSettings();
  // Shares its query key ("deployments", projectId) with the Deployments tab's own useDeployments
  // call, so this doesn't add a second network round trip once that tab has been visited.
  const deploymentsQuery = useDeployments(projectId);

  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  async function handleDeploy() {
    setDeployError(null);
    setDeploying(true);
    try {
      const { deploymentId } = await deployProject(projectId);
      await queryClient.invalidateQueries({ queryKey: ['deployments', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/deployments/${String(deploymentId)}`);
    } catch (err) {
      setDeployError(err instanceof ApiError ? err.message : 'Could not queue the deploy. Try again.');
    } finally {
      setDeploying(false);
    }
  }

  if (projectQuery.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-9 w-full max-w-lg" />
      </div>
    );
  }

  if (projectQuery.isError || !projectQuery.data) {
    return (
      <p role="alert" className="text-base text-danger">
        Could not load this project.
      </p>
    );
  }

  const project = projectQuery.data;
  const latestStatus = deploymentsQuery.data?.[0]?.status ?? null;
  const dotStatus: StatusDotStatus = latestStatus ? DOT_STATUS_BY_DEPLOY[latestStatus] : 'idle';
  const baseDomain = settingsQuery.data?.base_domain ?? null;

  return (
    <div>
      <Link
        href="~/projects"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-soft transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <ArrowLeft size={16} strokeWidth={ICON_STROKE} aria-hidden />
        Projects
      </Link>

      <Card className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <StatusDot status={dotStatus} />
              <h1 className="truncate text-2xl font-semibold text-ink">{project.name}</h1>
            </div>

            {baseDomain ? (
              <a
                href={`https://${projectDomain(project, baseDomain)}`}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-1.5 inline-flex w-fit items-center gap-1.5 font-mono text-sm text-soft transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {projectDomain(project, baseDomain)}
                <ExternalLink size={13} strokeWidth={ICON_STROKE} aria-hidden />
              </a>
            ) : (
              <span className="mt-1.5 block font-mono text-sm text-soft">{projectHost(project)}</span>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <MetaChip>
                <GitBranch size={13} strokeWidth={ICON_STROKE} aria-hidden />
                {repoChipLabel(project)}
              </MetaChip>
              <MetaChip>
                <GitBranch size={13} strokeWidth={ICON_STROKE} aria-hidden />
                {project.branch}
              </MetaChip>
            </div>
          </div>

          <Button loading={deploying} onClick={() => void handleDeploy()} className="shrink-0">
            Deploy
          </Button>
        </div>

        {deployError && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {deployError}
          </p>
        )}
      </Card>

      <ProjectTabs location={location} type={project.type} />

      <div className="mt-6">
        <Switch>
          <Route path="/deployments/:deployId">
            {(params) => <DeploymentLogPage deploymentId={Number(params.deployId)} />}
          </Route>
          <Route path="/settings">
            <SettingsTab projectId={projectId} />
          </Route>
          <Route path="/environment">
            <EnvEditorTab projectId={projectId} />
          </Route>
          {hasSection(project.type, 'database') && (
            <Route path="/database">
              <DatabaseTab projectId={projectId} />
            </Route>
          )}
          <Route path="/scripts">
            <ScriptsTab projectId={projectId} />
          </Route>
          {hasSection(project.type, 'workers') && (
            <Route path="/workers">
              <WorkersTab projectId={projectId} />
            </Route>
          )}
          {hasSection(project.type, 'cron') && (
            <Route path="/cron">
              <CronTab projectId={projectId} />
            </Route>
          )}
          {hasSection(project.type, 'smtp') && (
            <Route path="/smtp">
              <SmtpTab projectId={projectId} />
            </Route>
          )}
          <Route path="/danger">
            <DangerTab projectId={projectId} />
          </Route>
          <Route path="/">
            <DeploymentsTab projectId={projectId} />
          </Route>
          <Route>
            <EmptyState message="Unknown project section." />
          </Route>
        </Switch>
      </div>
    </div>
  );
}

function ProjectTabs({ location, type }: { location: string; type: ProjectType }) {
  return (
    <div role="tablist" aria-label="Project sections" className="flex flex-wrap items-center gap-1.5">
      {tabsForType(type).map((tab) => {
        const active = tab.key === 'deployments' ? location === '/' || location.startsWith('/deployments') : location === tab.href;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            role="tab"
            aria-selected={active}
            className={`inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-base font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              active ? 'bg-surface-3 text-ink' : 'text-soft hover:bg-surface-2 hover:text-ink'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

function MetaChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 font-mono text-xs text-soft">
      {children}
    </span>
  );
}
