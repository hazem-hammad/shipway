/**
 * Danger tab: project deletion. Matches PRODUCT.md's confirm pattern (destructive actions state
 * exactly what they do and require typed confirmation for the blast radius that deserves it) and
 * DESIGN.md's rule for this tab specifically: danger styling lives ONLY on the button, never as a
 * red side-stripe or tinted panel around the card. Deleting navigates to /projects with an inline
 * notice, mirroring the `?deleted=` pattern already used there.
 *
 * The blast radius is itemized by NAME rather than summarized: the subdomain that will stop
 * resolving and, most importantly, the databases that will be dropped with all their data. Those
 * used to be deleted as rows while the real database was left orphaned on the engine; now they are
 * genuinely dropped, which makes saying so beforehand essential rather than merely helpful.
 */
import { useState } from 'react';
import { useLocation } from 'wouter';
import { Trash2 } from 'lucide-react';
import { ApiError, deleteProject, type Project, type UndroppedDatabase } from '../../api';
import { useDatabases, useIsAdmin, useProject, useSettings } from '../../hooks';
import { projectDomain } from '../../../../server/src/lib/domain.js';
import { Button, Card, CardHeader, Chip, ICON_STROKE, Input, ReadOnlyNotice, Skeleton } from '../../components/ui';

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
  const settingsQuery = useSettings();
  // Every database, filtered to this project's — the same list the Databases page shows, so the
  // names here are exactly the ones that will be dropped.
  const databasesQuery = useDatabases();

  // `DELETE /api/projects/:id` is admin-only (server/src/routes/projects.ts). Without this a member
  // could type the slug, click a red Delete button, and learn the rule from a 403 — after being
  // walked through a confirmation that listed the databases about to be destroyed.
  const canEdit = useIsAdmin();
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undropped, setUndropped] = useState<UndroppedDatabase[] | null>(null);

  const baseDomain = settingsQuery.data?.base_domain ?? null;
  const domain = baseDomain ? projectDomain(project, baseDomain) : null;
  const linkedDatabases = databasesQuery.data?.filter((database) => database.projectId === project.id) ?? [];

  const canDelete = canEdit && confirmText === project.slug && !deleting;

  async function handleDelete() {
    setError(null);
    setUndropped(null);
    setDeleting(true);
    try {
      const result = await deleteProject(project.id, project.slug);
      const failed = result?.databasesFailed ?? [];
      if (failed.length > 0) {
        // The project IS gone, but something is still on the database server. Staying put to say so
        // is more useful than navigating away with a success banner.
        setUndropped(failed);
        setDeleting(false);
        return;
      }
      navigate(`~/projects?deleted=${encodeURIComponent(project.slug)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the project. Try again.');
      setDeleting(false);
    }
  }

  return (
    <Card className="max-w-[640px]">
      <CardHeader icon={<Trash2 size={20} strokeWidth={ICON_STROKE} />} title="Delete project" description="Permanently removes this project and everything it deployed." />

      {/* Named, itemized, and specific: a confirmation that says "and everything it deployed" leaves
          the reader to guess whether that includes their data. The database names are the part
          people most need to see before typing the slug. */}
      <div className="mt-5 text-sm text-soft">
        <p className="text-ink">This permanently deletes:</p>
        <ul className="mt-2 flex flex-col gap-1.5">
          <li className="flex gap-2">
            <span aria-hidden>&bull;</span>
            <span>
              The subdomain {domain ? <Chip>{domain}</Chip> : <span className="text-ink">for this project</span>}, its DNS record and its nginx config
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden>&bull;</span>
            <span>
              {databasesQuery.isPending ? (
                'Any database linked to this project, including all of its data'
              ) : linkedDatabases.length === 0 ? (
                <span>No databases are linked to this project</span>
              ) : (
                <span>
                  {linkedDatabases.length === 1 ? 'The linked database' : `The ${String(linkedDatabases.length)} linked databases`}{' '}
                  {linkedDatabases.map((database) => (
                    <Chip key={database.id}>
                      {database.name} ({database.engine})
                    </Chip>
                  ))}{' '}
                  and all of the data in {linkedDatabases.length === 1 ? 'it' : 'them'}
                </span>
              )}
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden>&bull;</span>
            <span>Every release, worker and cron entry, and the app&rsquo;s files and logs</span>
          </li>
        </ul>
        <p className="mt-3">This cannot be undone.</p>
      </div>

      <p className="mt-4 text-sm text-ink">
        Type <Chip>{project.slug}</Chip> to confirm.
      </p>
      <Input
        mono
        disabled={!canEdit}
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

      {undropped && (
        <div role="alert" className="mt-3 rounded-xl bg-surface-2 px-4 py-3 text-sm">
          <p className="font-medium text-ink">The project was deleted, but these databases could not be dropped:</p>
          <ul className="mt-1.5 flex flex-col gap-1 text-soft">
            {undropped.map((database) => (
              <li key={database.name}>
                <span className="font-mono text-ink">{database.name}</span> &mdash; {database.reason}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-soft">They are still on the database server and need removing by hand.</p>
        </div>
      )}

      <div className="mt-5">
        {canEdit ? (
          <Button variant="danger" disabled={!canDelete} loading={deleting} onClick={() => void handleDelete()}>
            Delete project
          </Button>
        ) : (
          <ReadOnlyNotice can="delete a project" />
        )}
      </div>
    </Card>
  );
}
