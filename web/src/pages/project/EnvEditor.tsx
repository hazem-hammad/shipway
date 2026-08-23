/**
 * Environment tab: the project's raw `.env` text (editable) plus a read-only preview of the
 * managed block Shipway appends on every deploy from the SMTP tab's config (task-24 controller
 * ruling — backed by the new `GET /api/projects/:id/env/preview` route added in this same task).
 */
import { type ChangeEvent, useState } from 'react';
import { ApiError, putProjectEnv } from '../../api';
import { useProjectEnv, useProjectEnvPreview } from '../../hooks';
import { Button, Skeleton, Textarea } from '../../components/ui';

export default function EnvEditorTab({ projectId }: { projectId: number }) {
  const envQuery = useProjectEnv(projectId);

  if (envQuery.isPending) {
    return <Skeleton className="h-80 w-full" />;
  }
  if (envQuery.isError || !envQuery.data) {
    return (
      <p role="alert" className="text-sm text-stop">
        Could not load the environment file.
      </p>
    );
  }

  return <EnvEditorForm key={projectId} projectId={projectId} initialContent={envQuery.data.content} />;
}

function EnvEditorForm({ projectId, initialContent }: { projectId: number; initialContent: string }) {
  const previewQuery = useProjectEnvPreview(projectId);

  const [content, setContent] = useState(initialContent);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setContent(event.target.value);
    setDirty(true);
    setError(null);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await putProjectEnv(projectId, content);
      setDirty(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the environment file. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Textarea
          mono
          spellCheck={false}
          value={content}
          onChange={handleChange}
          aria-label="Environment file"
          className="min-h-[320px] w-full"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button loading={saving} disabled={!dirty} onClick={() => void handleSave()}>
            Save env
          </Button>
          {dirty && <span className="text-xs text-hold">Unsaved changes.</span>}
          {error && (
            <span role="alert" className="text-xs text-stop">
              {error}
            </span>
          )}
        </div>
      </div>

      <div>
        <h2 className="mb-1 text-sm font-medium text-ink">Managed block preview</h2>
        <p className="mb-2 text-xs text-ink-soft">What Shipway appends to this file on every deploy, from the SMTP tab. Read-only.</p>
        {previewQuery.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : previewQuery.isError || !previewQuery.data ? (
          <p role="alert" className="text-xs text-stop">
            Could not load the preview.
          </p>
        ) : previewQuery.data.content === '' ? (
          <p className="text-xs text-ink-soft">Nothing managed for the current SMTP mode.</p>
        ) : (
          <pre className="overflow-x-auto rounded-md border border-line bg-panel px-4 py-3 font-mono text-xs text-ink-soft">
            {previewQuery.data.content}
          </pre>
        )}
      </div>
    </div>
  );
}
