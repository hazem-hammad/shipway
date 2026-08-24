/**
 * Pure parser for the Table-mode view of a project's `.env` text
 * (web/src/pages/project/EnvEditor.tsx).
 *
 * Placement note (Ruling 1, .superpowers/sdd/2026-08-25-shipway-v3/progress.md): this lives in
 * `server/src/deploy` rather than `web/src/lib` because the web workspace has no vitest harness and
 * standing one up for a single pure module was judged disproportionate. The server workspace already
 * runs vitest over everything under `server/test`, so the parser (and its tests) live here; the web
 * app imports this file via a relative path. That import was verified to resolve cleanly through both
 * `tsc -b` (web's `moduleResolution: "Bundler"` happily follows a relative import outside `src/`, since
 * TypeScript's `include` only seeds root files — files reached via import are still type-checked) and
 * the Vite build (esbuild resolves relative specifiers by filesystem path, not workspace boundary).
 *
 * Nothing here touches the filesystem or the deploy-time managed-block logic in `envfile.ts` (the
 * user-env-vs-managed-block merge). This module only turns a whole `.env` text blob into rows a table
 * UI can edit, and back, and is deliberately conservative: a line only becomes a `{key, value}` row
 * when it can be reproduced byte-for-byte on the way back out. Anything else (comments, blanks,
 * `export FOO=bar` lines, an indented assignment, an unterminated quote, a value containing characters
 * that would force re-quoting) is kept as an opaque "extra" line at its original position instead of
 * being reformatted or silently dropped.
 */

export interface EnvRow {
  key: string;
  value: string;
  /**
   * True when the source line wrapped the value in quotes (single or double). Informational only:
   * `serializeEnv` decides quoting purely by whether the value needs it (see `needsQuoting` below),
   * mirroring `envfile.ts`'s (unexported) `formatAssignment` — so a row's quotes are not "sticky".
   * A value that was quoted but didn't need to be (e.g. `KEY="plain"`) comes back out unquoted; a
   * value that does need it (space, `#`, `"`, `\`) always round-trips with its quotes intact.
   */
  quoted?: boolean;
}

export interface EnvExtra {
  /** 0-based line index in the original text this line occupied. `serializeEnv` reinserts it there. */
  index: number;
  /** The original line, verbatim (no trimming, no re-encoding). */
  line: string;
}

export interface ParsedEnv {
  rows: EnvRow[];
  extras: EnvExtra[];
}

/** `KEY=rest`, no leading whitespace (an indented `KEY=value` line is treated as an unparseable
 *  extra rather than a row that silently loses its indentation on the way back out). */
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** An unquoted row value: no whitespace, `#`, `"`, or `\` allowed anywhere in it. Any of those make
 *  the line ambiguous (is it a trailing comment? a value that needs quoting?) so lines that don't
 *  match this go to `extras` verbatim instead of being guessed at. */
const UNQUOTED_VALUE_RE = /^[^\s#"\\]*$/;

/** Unescapes a double-quoted value using the same pairing `formatAssignment` produces (`\\` -> `\`,
 *  `\"` -> `"`), requiring the closing quote to be the last character on the line. Returns `null` for
 *  an unterminated quote or trailing junk after the close (both go to `extras`). */
function parseDoubleQuoted(rest: string): string | null {
  let out = '';
  for (let i = 1; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '\\' && (rest[i + 1] === '"' || rest[i + 1] === '\\')) {
      out += rest[i + 1];
      i++;
      continue;
    }
    if (ch === '"') {
      return i + 1 === rest.length ? out : null;
    }
    out += ch;
  }
  return null;
}

/** Single-quoted values are literal (no escapes), matching common shell/dotenv convention. Requires
 *  the closing quote to be the last character on the line. */
function parseSingleQuoted(rest: string): string | null {
  const closeIdx = rest.indexOf("'", 1);
  if (closeIdx === -1 || closeIdx + 1 !== rest.length) return null;
  return rest.slice(1, closeIdx);
}

/** Parses the `rest` of a `KEY=rest` line already matched by `ASSIGNMENT_RE`. Returns `null` when it
 *  can't be reproduced byte-for-byte by `serializeEnv` — the caller then keeps the whole line as an
 *  extra rather than mangling it. */
function parseAssignmentValue(rest: string): { value: string; quoted: boolean } | null {
  if (rest.startsWith('"')) {
    const value = parseDoubleQuoted(rest);
    return value === null ? null : { value, quoted: true };
  }
  if (rest.startsWith("'")) {
    const value = parseSingleQuoted(rest);
    return value === null ? null : { value, quoted: true };
  }
  return UNQUOTED_VALUE_RE.test(rest) ? { value: rest, quoted: false } : null;
}

/**
 * Splits `text` into well-formed `KEY=value` rows and everything else ("extras": blanks, comments,
 * `export FOO=bar` lines, indented assignments, and anything that can't be parsed with confidence),
 * preserving each extra's original line position so `serializeEnv` can put it back.
 */
export function parseEnv(text: string): ParsedEnv {
  const rows: EnvRow[] = [];
  const extras: EnvExtra[] = [];

  const lines = text === '' ? [] : text.split('\n');

  lines.forEach((line, index) => {
    if (line.trim() === '' || /^\s*#/.test(line) || /^\s*export\s+/.test(line)) {
      extras.push({ index, line });
      return;
    }

    const match = ASSIGNMENT_RE.exec(line);
    const parsed = match ? parseAssignmentValue(match[2] as string) : null;
    if (!match || !parsed) {
      extras.push({ index, line });
      return;
    }

    rows.push({ key: match[1] as string, value: parsed.value, quoted: parsed.quoted });
  });

  return { rows, extras };
}

/** Mirrors `formatAssignment` in `server/src/deploy/envfile.ts` (not exported there, so duplicated
 *  here per Ruling 1's guidance — see the module doc comment). Quotes only when the value contains a
 *  space, `#`, `"`, or `\`, escaping `\` then `"` in that order. */
function needsQuoting(value: string): boolean {
  return /[ #"\\]/.test(value);
}

function formatRow(row: EnvRow): string {
  if (!needsQuoting(row.value)) {
    return `${row.key}=${row.value}`;
  }
  const escaped = row.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${row.key}="${escaped}"`;
}

/**
 * Renders `rows` + `extras` back into `.env` text. Extras go back at their original line index; rows
 * fill the remaining slots in their array order. For text parsed by `parseEnv` and serialized back
 * unmodified, this reconstructs the original text exactly (quoting included, since only rows whose
 * quoting need matches their source form are ever produced by `parseEnv` in the first place).
 */
export function serializeEnv(rows: EnvRow[], extras: EnvExtra[]): string {
  const total = rows.length + extras.length;
  const lines: string[] = new Array(total);
  const used: boolean[] = new Array(total).fill(false);

  const sortedExtras = [...extras].sort((a, b) => a.index - b.index);
  for (const extra of sortedExtras) {
    let pos = Math.min(Math.max(extra.index, 0), Math.max(total - 1, 0));
    while (pos < total && used[pos]) pos++;
    if (pos >= total) {
      lines.push(extra.line);
      continue;
    }
    lines[pos] = extra.line;
    used[pos] = true;
  }

  let rowIdx = 0;
  for (let i = 0; i < total; i++) {
    if (!used[i] && rowIdx < rows.length) {
      lines[i] = formatRow(rows[rowIdx] as EnvRow);
      rowIdx++;
    }
  }
  while (rowIdx < rows.length) {
    lines.push(formatRow(rows[rowIdx] as EnvRow));
    rowIdx++;
  }

  return lines.filter((line) => line !== undefined).join('\n');
}

/** Keys (case-sensitive, ignoring blank keys) that appear on more than one row. In a real `.env` file
 *  the last assignment of a duplicate key wins, which is what the UI's inline warning tells the user. */
export function findDuplicateKeys(rows: Array<{ key: string }>): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.key === '') continue;
    counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [key, count] of counts) {
    if (count > 1) duplicates.add(key);
  }
  return duplicates;
}
