/**
 * Environment tab: the project's `.env`, editable as either a key/value table (default, one row per
 * `KEY=value` pair) or raw text, plus a read-only preview of the managed block Shipway appends on
 * every deploy from the SMTP tab's config (backed by `GET /api/projects/:id/env/preview`).
 *
 * The editor itself — both views, and the `parseEnv`/`serializeEnv` conversion between them that
 * keeps comments and unparseable lines intact — lives in `components/EnvDraft.tsx`, shared with New
 * Project. This file is just the saving half: load, hand the text to the draft, `PUT` it back.
 */
import { Check, Copy, KeyRound } from 'lucide-react';
import { ApiError, putProjectEnv, type EnvApplyResult } from '../../api';
import { useProjectEnv, useProjectEnvPreview } from '../../hooks';
import { EnvDraftEditor, useEnvDraft, type EnvDraft } from '../../components/EnvDraft';
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
  // The outcome of the last save. Saving always stores the env; whether it reached the running
  // release is the separate question this answers, and the one worth showing — a save that changed
  // nothing on the server looks identical to one that changed everything without it.
  const [result, setResult] = useState<EnvApplyResult | null>(null);

  async function handleSave(): Promise<void> {
    setSaving(true);
    draft.setError(null);
    setResult(null);
    try {
      setResult(await putProjectEnv(projectId, draft.text()));
      draft.setDirty(false);
    } catch (err) {
      draft.setError(err instanceof ApiError ? err.message : 'Could not save the environment file. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        icon={<KeyRound size={20} strokeWidth={ICON_STROKE} />}
        title="Environment variables"
        description="Written to .env on save and on every deploy. Saving restarts the workers so they pick them up."
      />

      <div className="mt-5 flex flex-col gap-4">
        <EnvDraftEditor draft={draft} />

        <div className="flex flex-wrap items-center gap-3">
          <Button loading={saving} disabled={!draft.dirty} onClick={() => void handleSave()}>
            Save
          </Button>
          <CopyAllButton draft={draft} />
          {draft.dirty && <span className="text-sm text-warn">Unsaved changes</span>}
          {draft.error && (
            <span role="alert" className="text-sm text-danger">
              {draft.error}
            </span>
          )}
          {!draft.dirty && !draft.error && result !== null && <SaveOutcome result={result} />}
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

/**
 * Copies the whole draft — every variable, in whichever view is showing — as `.env` text, so it can
 * be pasted into another project, a local `.env`, or a teammate's message without selecting rows one
 * at a time. It copies what is on screen, unsaved edits included, which is the file the Save button
 * would write.
 */
function CopyAllButton({ draft }: { draft: EnvDraft }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(draft.text());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable or denied — the values are still on screen to copy by hand.
    }
  }

  return (
    <Button variant="secondary" onClick={() => void handleCopy()}>
      {copied ? <Check size={16} strokeWidth={ICON_STROKE} aria-hidden /> : <Copy size={16} strokeWidth={ICON_STROKE} aria-hidden />}
      {copied ? 'Copied' : 'Copy all'}
    </Button>
  );
}

/**
 * One line saying what the save actually did. Deliberately explicit about the not-applied cases:
 * "Saved" on its own is what used to make this screen misleading, since the env reached Shipway's
 * database and stopped there.
 */
function SaveOutcome({ result }: { result: EnvApplyResult }) {
  if (result.restartError !== undefined) {
    return (
      <span role="alert" className="text-sm text-warn">
        Saved and written to .env, but the restart failed: {result.restartError}. It will apply on the next deploy or restart.
      </span>
    );
  }
  if (!result.applied) {
    return (
      <span className="text-sm text-soft">
        {result.reason === 'deploy-in-flight'
          ? 'Saved. A deploy is already running and will pick these up.'
          : 'Saved. These apply on the first deploy.'}
      </span>
    );
  }
  return (
    <span className="text-sm text-ok-tint-fg">
      Saved and live
      {result.workersRestarted > 0
        ? ` — .env rewritten, ${String(result.workersRestarted)} worker ${result.workersRestarted === 1 ? 'instance' : 'instances'} restarted.`
        : ' — .env rewritten and the runtime reloaded.'}
    </span>
  );
}
