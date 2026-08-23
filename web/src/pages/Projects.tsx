/**
 * The projects table (DESIGN.md: "Projects page is a table, not a card grid: berth light, name,
 * slug.intcore.dev link (mono), type chip, last deploy (status + relative time + sha), deploy
 * button per row"). The status word and berth light are combined via `StatusBadge` in the first
 * column; the "last deploy" column then adds the relative time and short sha without repeating the
 * word.
 */
import { useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, deployProject, type LastDeployment, type ProjectListItem } from '../api';
import { useProjects, useSettings } from '../hooks';
import { StatusBadge } from '../components/StatusBadge';
import { ProjectUrl } from '../components/ProjectUrl';
import { Button, Chip, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { formatRelativeTime, shortSha } from '../lib/format';

export default function ProjectsPage() {
  const projectsQuery = useProjects();
  const settingsQuery = useSettings();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const search = useSearch();
  const [deployingId, setDeployingId] = useState<number | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);

  const baseDomain = settingsQuery.data?.base_domain ?? null;
  const deletedSlug = new URLSearchParams(search).get('deleted');

  async function handleDeploy(project: ProjectListItem) {
    setDeployError(null);
    setDeployingId(project.id);
    try {
      await deployProject(project.id);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/projects/${String(project.id)}`);
    } catch (err) {
      setDeployError(err instanceof ApiError ? err.message : 'Could not queue the deploy. Try again.');
    } finally {
      setDeployingId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Projects"
        actions={
          <Link
            href="/projects/new"
            className="inline-flex items-center justify-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-paper transition-colors duration-150 ease-out hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            New project
          </Link>
        }
      />

      {deletedSlug && (
        <p role="status" className="mb-4 flex items-center gap-2 text-sm text-go">
          Project <Chip>{deletedSlug}</Chip> deleted.
        </p>
      )}

      {deployError && (
        <p role="alert" className="mb-4 text-sm text-stop">
          {deployError}
        </p>
      )}

      {projectsQuery.isPending ? (
        <TableSkeleton />
      ) : projectsQuery.isError ? (
        <p role="alert" className="text-sm text-stop">
          Could not load projects.
        </p>
      ) : projectsQuery.data.length === 0 ? (
        <EmptyState
          message="No projects yet. Connect GitHub and create your first project."
          action={{ label: 'New project', href: '/projects/new' }}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead className="bg-panel text-xs font-medium text-ink-soft">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  URL
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Type
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Last deploy
                </th>
                <th scope="col" className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {projectsQuery.data.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  baseDomain={baseDomain}
                  deploying={deployingId === project.id}
                  onDeploy={() => void handleDeploy(project)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProjectRow({
  project,
  baseDomain,
  deploying,
  onDeploy,
}: {
  project: ProjectListItem;
  baseDomain: string | null;
  deploying: boolean;
  onDeploy: () => void;
}) {
  return (
    <tr className="h-11">
      <td className="px-4 py-3">
        <StatusBadge status={project.lastDeployment?.status ?? null} />
      </td>
      <td className="px-4 py-3 font-medium text-ink">{project.name}</td>
      <td className="px-4 py-3">
        <ProjectUrl slug={project.slug} baseDomain={baseDomain} />
      </td>
      <td className="px-4 py-3">
        <Chip>{project.type}</Chip>
      </td>
      <td className="px-4 py-3">
        <LastDeployCell lastDeployment={project.lastDeployment} />
      </td>
      <td className="px-4 py-3 text-right">
        <Button variant="secondary" className="px-2.5 py-1 text-xs" loading={deploying} onClick={onDeploy}>
          Deploy
        </Button>
      </td>
    </tr>
  );
}

function LastDeployCell({ lastDeployment }: { lastDeployment: LastDeployment | null }) {
  if (!lastDeployment) {
    return <span className="text-ink-soft">Not deployed yet</span>;
  }

  return (
    <span className="flex items-center gap-2 text-ink-soft">
      {lastDeployment.finishedAt !== null && <span>{formatRelativeTime(lastDeployment.finishedAt)}</span>}
      {lastDeployment.commitSha && <Chip>{shortSha(lastDeployment.commitSha)}</Chip>}
    </span>
  );
}

function TableSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="bg-panel px-4 py-3">
        <Skeleton className="h-3 w-32" />
      </div>
      <div className="divide-y divide-line">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="flex h-11 items-center gap-6 px-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}
