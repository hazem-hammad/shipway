/**
 * Danger tab: project deletion, matching PRODUCT.md's confirm pattern ("Destructive confirms are
 * inline panels with typed-name input only for delete project / drop database" — DESIGN.md,
 * Components). Deleting navigates to /projects with a toast-style inline notice, mirroring the
 * existing `?created=1` pattern already used by the GitHub App settings section.
 */
import { useState } from 'react';
import { useLocation } from 'wouter';
import { ApiError, deleteProject, type Project } from '../../api';
import { useProject } from '../../hooks';
import { Button, Chip, Input, Skeleton } from '../../components/ui';

export default function DangerTab({ projectId }: { projectId: number }) {
  const projectQuery = useProject(projectId);

  if (projectQuery.isPending) {
    return <Skeleton className="h-48 w-full max-w-[640px]" />;
  }
  if (projectQuery.isError || !projectQuery.data) {
    return (
      <p role="alert" className="text-sm text-stop">
        Could not load this project.
      </p>
    );
  }

  return <DangerPanel project={projectQuery.data} />;
}

function DangerPanel({ project }: { project: Project }) {
  const [, navigate] = useLocation();
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = confirmText === project.slug && !deleting;

  async function handleDelete() {
    setError(null);
    setDeleting(true);
    try {
      await deleteProject(project.id, project.slug);
      navigate(`~/projects?deleted=${encodeURIComponent(project.slug)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the project. Try again.');
      setDeleting(false);
    }
  }

  return (
    <div className="max-w-[640px] rounded-lg border border-stop/30 bg-stop/5 px-6 py-5">
      <h2 className="text-sm font-semibold text-stop">Delete project</h2>
      <p className="mt-2 text-sm text-ink-soft">
        This deletes the app, its subdomain DNS record, its nginx config, all releases, workers, and cron entries. This cannot be
        undone.
      </p>
      <p className="mt-4 text-sm text-ink">
        Type <Chip>{project.slug}</Chip> to confirm.
      </p>
      <Input
        mono
        value={confirmText}
        onChange={(event) => setConfirmText(event.target.value)}
        aria-label="Type the project slug to confirm deletion"
        className="mt-2 max-w-xs"
      />
      {error && (
        <p role="alert" className="mt-3 text-sm text-stop">
          {error}
        </p>
      )}
      <div className="mt-4">
        <Button variant="destructive" disabled={!canDelete} loading={deleting} onClick={() => void handleDelete()}>
          Delete project
        </Button>
      </div>
    </div>
  );
}
