/**
 * Environment tab: the project's `.env`, editable as either a key/value table (default, one row per
 * `KEY=value` pair) or raw text, plus a read-only preview of the managed block Shipway appends on
 * every deploy from the SMTP tab's config (backed by `GET /api/projects/:id/env/preview`).
 *
 * The editor itself — both views, and the `parseEnv`/`serializeEnv` conversion between them that
 * keeps comments and unparseable lines intact — lives in `components/EnvDraft.tsx`, shared with New
 * Project. This file is just the saving half: load, hand the text to the draft, `PUT` it back.
 */
import { KeyRound } from 'lucide-react';
import { ApiError, putProjectEnv } from '../../api';
import { useProjectEnv, useProjectEnvPreview } from '../../hooks';
import { EnvDraftEditor, useEnvDraft } from '../../components/EnvDraft';
import { Button, Card, CardHeader, ICON_STROKE, Skeleton } from '../../components/ui';
import { useState } from 'react';

export default function EnvEditorTab({ projectId }: { projectId: number }) {
  const envQuery = useProjectEnv(projectId);

  if (envQuery.isPending) {
    return <Skeleton className="h-96 w-full rounded-2xl" />;
  }
  if (envQuery.isError || !envQuery.data) {
    return (
      <p role="alert" className="text-sm text-danger">
        Could not load the environment file.
      </p>
    );
  }

  return <EnvEditorForm key={projectId} projectId={projectId} initialContent={envQuery.data.content} />;
}

function EnvEditorForm({ projectId, initialContent }: { projectId: number; initialContent: string }) {
  const previewQuery = useProjectEnvPreview(projectId);
  const draft = useEnvDraft(initialContent);
  const [saving, setSaving] = useState(false);

  async function handleSave(): Promise<void> {
    setSaving(true);
    draft.setError(null);
    try {
      await putProjectEnv(projectId, draft.text());
      draft.setDirty(false);
    } catch (err) {
      draft.setError(err instanceof ApiError ? err.message : 'Could not save the environment file. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader icon={<KeyRound size={20} strokeWidth={ICON_STROKE} />} title="Environment variables" description="Injected into every deploy as .env." />

      <div className="mt-5 flex flex-col gap-4">
        <EnvDraftEditor draft={draft} />

        <div className="flex flex-wrap items-center gap-3">
          <Button loading={saving} disabled={!draft.dirty} onClick={() => void handleSave()}>
            Save
          </Button>
          {draft.dirty && <span className="text-sm text-warn">Unsaved changes</span>}
          {draft.error && (
            <span role="alert" className="text-sm text-danger">
              {draft.error}
            </span>
          )}
        </div>
      </div>

      <div className="mt-6 rounded-xl bg-surface-2 p-5">
        <h3 className="text-sm font-semibold text-ink">What Shipway appends</h3>
        <p className="mt-1 text-[13px] text-soft">Rendered from the SMTP tab, for the current mode. Read-only.</p>
        <div className="mt-3">
          {previewQuery.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : previewQuery.isError || !previewQuery.data ? (
            <p role="alert" className="text-xs text-danger">
              Could not load the preview.
            </p>
          ) : previewQuery.data.content === '' ? (
            <p className="text-[13px] text-soft">Nothing managed for the current SMTP mode.</p>
          ) : (
            <pre className="overflow-x-auto rounded-lg bg-surface px-4 py-3 font-mono text-xs text-soft">{previewQuery.data.content}</pre>
          )}
        </div>
      </div>
    </Card>
  );
}
