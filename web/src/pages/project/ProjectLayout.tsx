/**
 * Project detail shell (DESIGN.md: "Project detail: name + URL + berth light header, horizontal
 * tabs (Deployments / Settings / Environment / Scripts / Workers / Cron / SMTP / Danger)"). Routed
 * as `/projects/:id` with `nest` (see App.tsx), so every tab below — plus the deployment log page
 * — is addressed by a plain relative path inside this component's own Switch. Workers and Cron
 * render "coming in the next update" placeholders; Task 25 fills them in.
 */
import { Link, Route, Switch, useLocation, useParams } from 'wouter';
import { useDeployments, useProject, useSettings } from '../../hooks';
import { StatusBadge } from '../../components/StatusBadge';
import { ProjectUrl } from '../../components/ProjectUrl';
import { EmptyState, Skeleton } from '../../components/ui';
import DeploymentsTab from './Deployments';
import DeploymentLogPage from './DeploymentLog';
import SettingsTab from './Settings';
import EnvEditorTab from './EnvEditor';
import ScriptsTab from './Scripts';
import SmtpTab from './Smtp';
import DangerTab from './Danger';

interface TabDef {
  key: string;
  href: string;
  label: string;
}

const TABS: TabDef[] = [
  { key: 'deployments', href: '/', label: 'Deployments' },
  { key: 'settings', href: '/settings', label: 'Settings' },
  { key: 'environment', href: '/environment', label: 'Environment' },
  { key: 'scripts', href: '/scripts', label: 'Scripts' },
  { key: 'workers', href: '/workers', label: 'Workers' },
  { key: 'cron', href: '/cron', label: 'Cron' },
  { key: 'smtp', href: '/smtp', label: 'SMTP' },
  { key: 'danger', href: '/danger', label: 'Danger' },
];

export default function ProjectLayout() {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const [location] = useLocation();

  const projectQuery = useProject(projectId);
  const settingsQuery = useSettings();
  // Shares its query key ("deployments", projectId) with the Deployments tab's own useDeployments
  // call, so this doesn't add a second network round trip once that tab has been visited.
  const deploymentsQuery = useDeployments(projectId);

  if (projectQuery.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-8 w-full max-w-xl" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (projectQuery.isError || !projectQuery.data) {
    return (
      <p role="alert" className="text-sm text-stop">
        Could not load this project.
      </p>
    );
  }

  const project = projectQuery.data;
  const latestStatus = deploymentsQuery.data?.[0]?.status ?? null;

  return (
    <div>
      <div className="mb-1">
        <Link
          href="~/projects"
          className="text-xs font-medium text-ink-soft underline decoration-line underline-offset-2 transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Projects
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={latestStatus} />
        <h1 className="text-xl font-semibold text-ink">{project.name}</h1>
        <ProjectUrl slug={project.slug} baseDomain={settingsQuery.data?.base_domain ?? null} />
      </div>

      <nav className="mb-6 flex flex-wrap gap-1 border-b border-line" aria-label="Project sections">
        {TABS.map((tab) => {
          const active =
            tab.key === 'deployments' ? location === '/' || location.startsWith('/deployments') : location === tab.href;
          return (
            <Link
              key={tab.key}
              href={tab.href}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                active ? 'border-accent text-accent' : 'border-transparent text-ink-soft hover:text-ink'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

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
        <Route path="/scripts">
          <ScriptsTab projectId={projectId} />
        </Route>
        <Route path="/workers">
          <EmptyState message="Workers are coming in the next update." />
        </Route>
        <Route path="/cron">
          <EmptyState message="Cron is coming in the next update." />
        </Route>
        <Route path="/smtp">
          <SmtpTab projectId={projectId} />
        </Route>
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
  );
}
