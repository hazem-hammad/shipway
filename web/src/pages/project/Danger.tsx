/**
 * Danger tab: project deletion. Matches PRODUCT.md's confirm pattern (destructive actions state
 * exactly what they do and require typed confirmation for the blast radius that deserves it) and
 * DESIGN.md's rule for this tab specifically: danger styling lives ONLY on the button, never as a
 * red side-stripe or tinted panel around the card. Deleting navigates to /projects with an inline
 * notice, mirroring the `?deleted=` pattern already used there.
 */
import { useState } from 'react';
import { useLocation } from 'wouter';
import { Trash2 } from 'lucide-react';
import { ApiError, deleteProject, type Project } from '../../api';
import { useProject } from '../../hooks';
import { Button, Card, CardHeader, Chip, ICON_STROKE, Input, Skeleton } from '../../components/ui';

export default function DangerTab({ projectId }: { projectId: number }) {
  const projectQuery = useProject(projectId);

  if (projectQuery.isPending) {
    return <Skeleton className="h-64 w-full max-w-[640px] rounded-2xl" />;
  }
  if (projectQuery.isError || !projectQuery.data) {
    return (
      <p role="alert" className="text-sm text-danger">
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
    <Card className="max-w-[640px]">
      <CardHeader icon={<Trash2 size={20} strokeWidth={ICON_STROKE} />} title="Delete project" description="Permanently removes this project and everything it deployed." />

      <p className="mt-5 text-sm text-soft">
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
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="mt-5">
        <Button variant="danger" disabled={!canDelete} loading={deleting} onClick={() => void handleDelete()}>
          Delete project
        </Button>
      </div>
    </Card>
  );
}
