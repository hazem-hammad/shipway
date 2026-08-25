/**
 * Environment tab: the project's `.env` text, editable as either a Table (default, one row per
 * `KEY=value` pair) or Raw (today's textarea), plus a read-only preview of the managed block Shipway
 * appends on every deploy from the SMTP tab's config (backed by `GET /api/projects/:id/env/preview`).
 *
 * Table <-> Raw conversion goes through `parseEnv`/`serializeEnv` (server/src/deploy/envparse.ts,
 * imported here via a relative path per Ruling 1 in
 * .superpowers/sdd/2026-08-25-shipway-v3/progress.md), so switching modes never drops a comment,
 * blank line, or line the parser isn't confident about reformatting.
 */
import { type ChangeEvent, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, KeyRound, Plus, Trash2 } from 'lucide-react';
import { ApiError, putProjectEnv } from '../../api';
import { useProjectEnv, useProjectEnvPreview } from '../../hooks';
import { Button, Card, CardHeader, ICON_STROKE, Input, Skeleton, Tabs, Textarea } from '../../components/ui';
import { findDuplicateKeys, hasCRLF, parseEnv, serializeEnv, type EnvExtra, type EnvRow } from '../../../../server/src/deploy/envparse.js';

/** Keys that look like secrets get masked by default with a per-row reveal toggle. */
const SECRET_KEY_RE = /(SECRET|TOKEN|KEY|PASSWORD|PASS|DSN|CREDENTIAL)/i;

type Mode = 'table' | 'raw';

/** A table row plus view-only state (stable id for React keys/reveal-state, reveal toggle). Stripped
 *  back down to `EnvRow` before it ever reaches `serializeEnv`. */
interface EditableRow extends EnvRow {
  id: number;
  revealed: boolean;
}

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
  const idRef = useRef(0);
  const nextId = () => idRef.current++;

  const [mode, setMode] = useState<Mode>('table');
  const [rows, setRows] = useState<EditableRow[]>(() =>
    parseEnv(initialContent).rows.map((row) => ({ ...row, id: nextId(), revealed: false })),
  );
  const [extras, setExtras] = useState<EnvExtra[]>(() => parseEnv(initialContent).extras);
  const [rawText, setRawText] = useState(initialContent);

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duplicateKeys = useMemo(() => findDuplicateKeys(rows), [rows]);
  // Detected once from the file as loaded: parseEnv splits on `\n` only, so a CRLF file leaves every
  // line's trailing `\r` in place, which fails every row-shaped pattern in envparse.ts and yields zero
  // editable rows. Rather than silently normalizing line endings, Table mode shows an honest note and
  // points at Raw mode instead (see envparse.ts's `hasCRLF` doc comment for why).
  const fileHasCRLF = useMemo(() => hasCRLF(initialContent), [initialContent]);

  function switchMode(next: Mode) {
    if (next === mode) return;
    if (next === 'raw') {
      setRawText(serializeEnv(rows, extras));
    } else {
      const parsed = parseEnv(rawText);
      setRows(parsed.rows.map((row) => ({ ...row, id: nextId(), revealed: false })));
      setExtras(parsed.extras);
    }
    setMode(next);
  }

  function updateRow(id: number, patch: Partial<Pick<EditableRow, 'key' | 'value'>>) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setDirty(true);
    setError(null);
  }

  function addRow() {
    setRows((prev) => [...prev, { id: nextId(), key: '', value: '', revealed: false }]);
    setDirty(true);
  }

  function deleteRow(id: number) {
    setRows((prev) => prev.filter((row) => row.id !== id));
    setDirty(true);
  }

  function toggleReveal(id: number) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, revealed: !row.revealed } : row)));
  }

  function handleRawChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setRawText(event.target.value);
    setDirty(true);
    setError(null);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const content = mode === 'raw' ? rawText : serializeEnv(rows, extras);
      await putProjectEnv(projectId, content);
      setDirty(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the environment file. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader icon={<KeyRound size={20} strokeWidth={ICON_STROKE} />} title="Environment variables" description="Injected into every deploy as .env." />

      <div className="mt-5 flex flex-col gap-4">
        <Tabs
          tabs={[
            { id: 'table', label: 'Table' },
            { id: 'raw', label: 'Raw' },
          ]}
          value={mode}
          onChange={(id) => switchMode(id === 'raw' ? 'raw' : 'table')}
        />

        {mode === 'table' ? (
          <div className="flex flex-col gap-3">
            {fileHasCRLF && (
              <p role="alert" className="text-[13px] text-warn">
                This file uses Windows line endings (CRLF), so Table mode has nothing to show as rows.
                Switch to Raw mode to edit it; typing there converts the whole file to Unix-style line
                endings (LF) when you save.
              </p>
            )}
            {rows.length === 0 ? (
              <p className="text-sm text-soft">No environment variables yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {rows.map((row) => (
                  <EnvRowFields
                    key={row.id}
                    row={row}
                    isDuplicate={row.key !== '' && duplicateKeys.has(row.key)}
                    onKeyChange={(key) => updateRow(row.id, { key })}
                    onValueChange={(value) => updateRow(row.id, { value })}
                    onDelete={() => deleteRow(row.id)}
                    onToggleReveal={() => toggleReveal(row.id)}
                  />
                ))}
              </div>
            )}

            <div>
              <Button variant="outline" size="sm" onClick={addRow}>
                <Plus size={16} strokeWidth={ICON_STROKE} aria-hidden />
                Add variable
              </Button>
            </div>

            {extras.length > 0 && (
              <p className="text-[13px] text-soft">
                {extras.length} {extras.length === 1 ? 'line' : 'lines'} kept as written (comments and blanks).
              </p>
            )}
          </div>
        ) : (
          <Textarea
            mono
            spellCheck={false}
            value={rawText}
            onChange={handleRawChange}
            aria-label="Environment file"
            className="min-h-[320px] w-full"
          />
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button loading={saving} disabled={!dirty} onClick={() => void handleSave()}>
            Save
          </Button>
          {dirty && <span className="text-sm text-warn">Unsaved changes</span>}
          {error && (
            <span role="alert" className="text-sm text-danger">
              {error}
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

const ICON_BUTTON_CLASSES =
  'grid h-9 w-9 shrink-0 place-items-center rounded-lg text-icon transition-colors duration-150 ease-out hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

function EnvRowFields({
  row,
  isDuplicate,
  onKeyChange,
  onValueChange,
  onDelete,
  onToggleReveal,
}: {
  row: EditableRow;
  isDuplicate: boolean;
  onKeyChange: (key: string) => void;
  onValueChange: (value: string) => void;
  onDelete: () => void;
  onToggleReveal: () => void;
}) {
  const isSecret = row.key !== '' && SECRET_KEY_RE.test(row.key);
  const masked = isSecret && !row.revealed;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div className="min-w-0 basis-2/5">
          <Input mono value={row.key} onChange={(event) => onKeyChange(event.target.value)} placeholder="KEY" aria-label="Variable name" />
        </div>
        <span aria-hidden className="text-soft">
          =
        </span>
        <div className="min-w-0 flex-1">
          <Input
            mono
            type={masked ? 'password' : 'text'}
            value={row.value}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder="value"
            aria-label="Variable value"
          />
        </div>
        {isSecret && (
          <button
            type="button"
            onClick={onToggleReveal}
            aria-label={row.revealed ? 'Hide value' : 'Reveal value'}
            className={`${ICON_BUTTON_CLASSES} hover:text-ink`}
          >
            {row.revealed ? <EyeOff size={16} strokeWidth={ICON_STROKE} aria-hidden /> : <Eye size={16} strokeWidth={ICON_STROKE} aria-hidden />}
          </button>
        )}
        <button type="button" onClick={onDelete} aria-label="Delete variable" className={`${ICON_BUTTON_CLASSES} hover:text-danger`}>
          <Trash2 size={16} strokeWidth={ICON_STROKE} aria-hidden />
        </button>
      </div>
      {isDuplicate && (
        <p role="alert" className="text-[13px] text-danger">
          Duplicate key "{row.key}". The last one wins.
        </p>
      )}
    </div>
  );
}
