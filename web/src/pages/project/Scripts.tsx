/**
 * Scripts tab: pre-deploy and post-deploy shell scripts, one Save (task-24 controller ruling).
 * Ordering/semantics in the helper text mirror the pipeline exactly (see pipeline.ts's
 * runBuildPhase/runPostActivate): pre-deploy runs after code export + env write but before
 * install/build; post-deploy runs after the release is live and has passed its health check, and a
 * failure there does not roll the release back.
 */
import { type FormEvent, useState } from 'react';
import { ApiError, patchProject, type Project } from '../../api';
import { useProject } from '../../hooks';
import { Button, Field, Skeleton, Textarea } from '../../components/ui';

export default function ScriptsTab({ projectId }: { projectId: number }) {
  const projectQuery = useProject(projectId);

  if (projectQuery.isPending) {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (projectQuery.isError || !projectQuery.data) {
    return (
      <p role="alert" className="text-sm text-stop">
        Could not load scripts.
      </p>
    );
  }

  return <ScriptsForm key={projectQuery.data.id} project={projectQuery.data} />;
}

function ScriptsForm({ project }: { project: Project }) {
  const [preDeployScript, setPreDeployScript] = useState(project.preDeployScript ?? '');
  const [postDeployScript, setPostDeployScript] = useState(project.postDeployScript ?? '');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await patchProject(project.id, {
        preDeployScript: preDeployScript.trim() === '' ? null : preDeployScript,
        postDeployScript: postDeployScript.trim() === '' ? null : postDeployScript,
      });
      setDirty(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save scripts. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex max-w-[720px] flex-col gap-6" noValidate>
      <p className="text-sm text-ink-soft">
        Each script runs in the release directory with the project env, via bash. A non-zero exit fails the deploy, same as
        `set -e`, so write scripts accordingly.
      </p>

      <Field label="Pre-deploy script" hint="Runs after export and env write, before install/build.">
        <Textarea
          mono
          spellCheck={false}
          rows={10}
          className="min-h-[240px]"
          value={preDeployScript}
          onChange={(event) => {
            setPreDeployScript(event.target.value);
            setDirty(true);
            setError(null);
          }}
        />
      </Field>

      <Field label="Post-deploy script" hint="Runs once the release is live and healthy. A failure here does not roll back.">
        <Textarea
          mono
          spellCheck={false}
          rows={10}
          className="min-h-[240px]"
          value={postDeployScript}
          onChange={(event) => {
            setPostDeployScript(event.target.value);
            setDirty(true);
            setError(null);
          }}
        />
      </Field>

      {error && (
        <p role="alert" className="text-sm text-stop">
          {error}
        </p>
      )}

      <div>
        <Button type="submit" loading={saving} disabled={!dirty || saving}>
          Save scripts
        </Button>
      </div>
    </form>
  );
}
