/**
 * Scripts tab: pre-deploy and post-deploy shell scripts, each its own Card, one shared Save.
 * Ordering/semantics in the helper text mirror the pipeline exactly (see pipeline.ts's
 * runBuildPhase/runPostActivate): pre-deploy runs after code export + env write but before
 * install/build; post-deploy runs after the release is live and has passed its health check, and a
 * failure there does not roll the release back.
 */
import { type FormEvent, useState } from 'react';
import { PlayCircle, Rocket } from 'lucide-react';
import { ApiError, patchProject, type Project } from '../../api';
import { useProject } from '../../hooks';
import { Button, Card, CardHeader, ICON_STROKE, Skeleton, Textarea } from '../../components/ui';
import { LARAVEL_POST_DEPLOY_SCRIPT, LARAVEL_PRE_DEPLOY_SCRIPT } from '../../../../server/src/deploy/laravel.js';

export default function ScriptsTab({ projectId }: { projectId: number }) {
  const projectQuery = useProject(projectId);

  if (projectQuery.isPending) {
    return (
      <div className="flex flex-col gap-5">
        <Skeleton className="h-64 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }
  if (projectQuery.isError || !projectQuery.data) {
    return (
      <p role="alert" className="text-sm text-danger">
        Could not load scripts.
      </p>
    );
  }

  return <ScriptsForm key={projectQuery.data.id} project={projectQuery.data} />;
}

function ScriptsForm({ project }: { project: Project }) {
  const [preDeployScript, setPreDeployScript] = useState(project.preDeployScript ?? '');
  const [postDeployScript, setPostDeployScript] = useState(project.postDeployScript ?? '');
  // Offered only for php, and only into an empty box: these are the same defaults New Project
  // prefills (see deploy/laravel.ts), for a project created before they existed — never something
  // that can overwrite a script someone already wrote.
  const isPhp = project.type === 'php';
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function change(setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
      setDirty(true);
      setError(null);
    };
  }

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
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-5" noValidate>
      <Card>
        <CardHeader
          icon={<PlayCircle size={20} strokeWidth={ICON_STROKE} />}
          title="Pre-deploy script"
          description="Runs after export and env write, before install/build. A non-zero exit fails the deploy."
          action={
            isPhp && preDeployScript.trim() === '' ? (
              <Button type="button" variant="outline" size="sm" onClick={() => change(setPreDeployScript)(LARAVEL_PRE_DEPLOY_SCRIPT)}>
                Insert Laravel defaults
              </Button>
            ) : undefined
          }
        />
        <Textarea
          mono
          spellCheck={false}
          rows={10}
          className="mt-4 min-h-[240px]"
          aria-label="Pre-deploy script"
          value={preDeployScript}
          onChange={(event) => change(setPreDeployScript)(event.target.value)}
        />
      </Card>

      <Card>
        <CardHeader
          icon={<Rocket size={20} strokeWidth={ICON_STROKE} />}
          title="Post-deploy script"
          description="Runs once the release is live and healthy. A failure here does not roll back."
          action={
            isPhp && postDeployScript.trim() === '' ? (
              <Button type="button" variant="outline" size="sm" onClick={() => change(setPostDeployScript)(LARAVEL_POST_DEPLOY_SCRIPT)}>
                Insert Laravel defaults
              </Button>
            ) : undefined
          }
        />
        <Textarea
          mono
          spellCheck={false}
          rows={10}
          className="mt-4 min-h-[240px]"
          aria-label="Post-deploy script"
          value={postDeployScript}
          onChange={(event) => change(setPostDeployScript)(event.target.value)}
        />
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={saving} disabled={!dirty || saving}>
          Save
        </Button>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
