/**
 * The two-view `.env` editor, shared by the project Environment tab and New Project.
 *
 * View 1 ("Table") is one row per `KEY=value` pair, with masking for secret-looking keys and a
 * duplicate-key warning. View 2 ("Raw") is the whole file as free text. Switching between them goes
 * through `parseEnv`/`serializeEnv` (server/src/deploy/envparse.ts, imported by relative path per
 * Ruling 1), so a comment, a blank line, or a line the parser won't confidently reformat survives
 * the trip in both directions — it's kept verbatim at its original position as an "extra".
 *
 * `useEnvDraft` owns that whole state machine (rows, extras, raw text, which view is showing, and
 * whether anything has been edited yet); `EnvDraftEditor` renders it. They're split because the two
 * callers wrap it differently: the Environment tab saves through `PUT /api/projects/:id/env` and
 * shows the managed-block preview alongside, while New Project holds the text until the project it
 * belongs to exists and regenerates the whole draft (via `reset`) while the user is still typing the
 * name and slug that feed the Laravel template.
 */
import { type ChangeEvent, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { Button, ICON_STROKE, Input, Tabs, Textarea } from './ui';
import { findDuplicateKeys, hasCRLF, parseEnv, serializeEnv, type EnvExtra, type EnvRow } from '../../../server/src/deploy/envparse.js';

/** Keys that look like secrets get masked by default with a per-row reveal toggle. */
export const SECRET_KEY_RE = /(SECRET|TOKEN|KEY|PASSWORD|PASS|DSN|CREDENTIAL)/i;

export type EnvMode = 'table' | 'raw';

/** A table row plus view-only state (stable id for React keys/reveal-state, reveal toggle). Stripped
 *  back down to `EnvRow` before it ever reaches `serializeEnv`. */
interface EditableRow extends EnvRow {
  id: number;
  revealed: boolean;
}

export interface EnvDraft {
  mode: EnvMode;
  switchMode: (next: EnvMode) => void;
  rows: EditableRow[];
  extras: EnvExtra[];
  rawText: string;
  /** True once the user has typed anything at all — a caller regenerating the draft from elsewhere
   *  (New Project's live Laravel template) uses this to stop overwriting their edits. */
  dirty: boolean;
  setDirty: (dirty: boolean) => void;
  updateRow: (id: number, patch: Partial<Pick<EditableRow, 'key' | 'value'>>) => void;
  addRow: () => void;
  deleteRow: (id: number) => void;
  toggleReveal: (id: number) => void;
  setRawText: (text: string) => void;
  /** The current draft as `.env` text, whichever view is showing. */
  text: () => string;
  /** Replaces the whole draft with `text`, discarding the current rows/extras and dirty flag. */
  reset: (text: string) => void;
  /** True when the text this draft was last loaded/reset from uses CRLF line endings — Table mode
   *  then has no rows to show (see `hasCRLF` in envparse.ts). */
  hasCRLF: boolean;
  /** An error message the caller wants shown under the editor, or `null`. Cleared by any edit. */
  error: string | null;
  setError: (error: string | null) => void;
}

/**
 * The env editor's state machine. `initialContent` seeds it; `reset` replaces it wholesale later.
 * Every mutator sets `dirty` and clears `error`, so callers only have to decide what to do with
 * those, not maintain them.
 */
export function useEnvDraft(initialContent: string): EnvDraft {
  const idRef = useRef(0);
  const nextId = (): number => idRef.current++;

  const [mode, setMode] = useState<EnvMode>('table');
  const [rows, setRows] = useState<EditableRow[]>(() => parseEnv(initialContent).rows.map((row) => ({ ...row, id: nextId(), revealed: false })));
  const [extras, setExtras] = useState<EnvExtra[]>(() => parseEnv(initialContent).extras);
  const [rawText, setRawTextState] = useState(initialContent);
  const [crlf, setCrlf] = useState(() => hasCRLF(initialContent));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchMode(next: EnvMode): void {
    if (next === mode) return;
    if (next === 'raw') {
      setRawTextState(serializeEnv(rows, extras));
    } else {
      const parsed = parseEnv(rawText);
      setRows(parsed.rows.map((row) => ({ ...row, id: nextId(), revealed: false })));
      setExtras(parsed.extras);
    }
    setMode(next);
  }

  function updateRow(id: number, patch: Partial<Pick<EditableRow, 'key' | 'value'>>): void {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setDirty(true);
    setError(null);
  }

  function addRow(): void {
    setRows((prev) => [...prev, { id: nextId(), key: '', value: '', revealed: false }]);
    setDirty(true);
  }

  function deleteRow(id: number): void {
    setRows((prev) => prev.filter((row) => row.id !== id));
    setDirty(true);
  }

  function toggleReveal(id: number): void {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, revealed: !row.revealed } : row)));
  }

  function setRawText(text: string): void {
    setRawTextState(text);
    setDirty(true);
    setError(null);
  }

  function text(): string {
    return mode === 'raw' ? rawText : serializeEnv(rows, extras);
  }

  function reset(next: string): void {
    const parsed = parseEnv(next);
    setRows(parsed.rows.map((row) => ({ ...row, id: nextId(), revealed: false })));
    setExtras(parsed.extras);
    setRawTextState(next);
    setCrlf(hasCRLF(next));
    setDirty(false);
    setError(null);
  }

  return {
    mode,
    switchMode,
    rows,
    extras,
    rawText,
    dirty,
    setDirty,
    updateRow,
    addRow,
    deleteRow,
    toggleReveal,
    setRawText,
    text,
    reset,
    hasCRLF: crlf,
    error,
    setError,
  };
}

/**
 * Renders a `useEnvDraft` draft: the Table/Raw tab strip and whichever view is selected. Nothing
 * about saving lives here — the caller owns that, and `rawLabel`/`emptyText` let it name the free-
 * text view and the no-variables-yet state for its own context.
 */
export function EnvDraftEditor({
  draft,
  rawLabel = 'Raw',
  emptyText = 'No environment variables yet.',
  rawRows,
}: {
  draft: EnvDraft;
  rawLabel?: string;
  emptyText?: string;
  rawRows?: number;
}) {
  const duplicateKeys = useMemo(() => findDuplicateKeys(draft.rows), [draft.rows]);

  return (
    <div className="flex flex-col gap-4">
      <Tabs
        tabs={[
          { id: 'table', label: 'Key / value' },
          { id: 'raw', label: rawLabel },
        ]}
        value={draft.mode}
        onChange={(id) => draft.switchMode(id === 'raw' ? 'raw' : 'table')}
      />

      {draft.mode === 'table' ? (
        <div className="flex flex-col gap-3">
          {draft.hasCRLF && (
            <p role="alert" className="text-[13px] text-warn">
              This file uses Windows line endings (CRLF), so the key/value view has nothing to show as rows. Switch to {rawLabel} to
              edit it; typing there converts the whole file to Unix-style line endings (LF) when you save.
            </p>
          )}
          {draft.rows.length === 0 ? (
            <p className="text-sm text-soft">{emptyText}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {draft.rows.map((row) => (
                <EnvRowFields
                  key={row.id}
                  row={row}
                  isDuplicate={row.key !== '' && duplicateKeys.has(row.key)}
                  onKeyChange={(key) => draft.updateRow(row.id, { key })}
                  onValueChange={(value) => draft.updateRow(row.id, { value })}
                  onDelete={() => draft.deleteRow(row.id)}
                  onToggleReveal={() => draft.toggleReveal(row.id)}
                />
              ))}
            </div>
          )}

          <div>
            <Button type="button" variant="outline" size="sm" onClick={draft.addRow}>
              <Plus size={16} strokeWidth={ICON_STROKE} aria-hidden />
              Add variable
            </Button>
          </div>

          {draft.extras.length > 0 && (
            <p className="text-[13px] text-soft">
              {draft.extras.length} {draft.extras.length === 1 ? 'line' : 'lines'} kept as written (comments and blanks).
            </p>
          )}
        </div>
      ) : (
        <Textarea
          mono
          spellCheck={false}
          rows={rawRows}
          value={draft.rawText}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => draft.setRawText(event.target.value)}
          aria-label="Environment file"
          className={rawRows === undefined ? 'min-h-[320px] w-full' : 'w-full'}
        />
      )}
    </div>
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
