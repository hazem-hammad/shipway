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
 * when `serializeEnv` is guaranteed to reproduce it byte-for-byte (see "Accepted normalizations"
 * below for the one deliberate exception). Anything else (comments, blanks, `export FOO=bar` lines,
 * an indented assignment, an unterminated quote, a value containing characters that would force
 * re-quoting on a form the parser isn't sure it can reverse) is kept as an opaque "extra" line at its
 * original position instead of being reformatted or silently dropped.
 *
 * Accepted normalizations (the ONLY byte-level differences `parseEnv`+`serializeEnv` are allowed to
 * introduce for a line that becomes a row, with zero user edits to that row):
 *   - Decorative quotes are dropped: `KEY="plain"` or `KEY='plain'` -> `KEY=plain`, but ONLY when the
 *     decoded value needs no quoting at all (`needsQuoting` false — no space, `#`, `"`, or `\`). This
 *     is safe because removing quotes around a value with none of the quoting-trigger characters can
 *     never change what a value means.
 *   That's it. In particular: a double-quoted value is only ever accepted as a row when its escaping
 *   already uses exactly the recognized `\\` -> `\` / `\"` -> `"` pairs (anything else — e.g. `\S` in
 *   `.\SQLEXPRESS`, `\d` in `^\d+$` — is a lone/unrecognized backslash and the whole line becomes an
 *   extra instead of being silently re-escaped into something with a different byte count). A
 *   single-quoted value that actually needs quoting (contains a space/`#`/`"`/`\`) also becomes an
 *   extra rather than being switched to double-quote style, since that changes the file's bytes with
 *   no user edit. Every row that IS produced is checked against this contract directly (see
 *   `isSafeRow` below) rather than trusted by construction — a value's decode is never assumed
 *   reversible; it's verified.
 */

export interface EnvRow {
  key: string;
  value: string;
  /**
   * True when the source line wrapped the value in quotes (single or double). Informational only:
   * `serializeEnv` decides quoting purely by whether the value needs it (see `needsQuoting` below),
   * mirroring `envfile.ts`'s (unexported) `formatAssignment` — so a row's quotes are not "sticky". A
   * value that was quoted but didn't need to be (e.g. `KEY="plain"`) always comes back out unquoted
   * (`quoted: true` on a value where `needsQuoting` is false just records that the source had quotes
   * to drop). A value that DOES need quoting (space/`#`/`"`/`\`) is only ever represented as a row when
   * its source form already reproduces byte-for-byte through `serializeEnv` — see the module doc
   * comment's "Accepted normalizations" — so for such a row `quoted` is always `true` and stays that
   * way; a value needing quoting whose source form wouldn't round-trip exactly (e.g. a single-quoted
   * value with a space, or a double-quoted value with an unrecognized backslash escape) never becomes
   * a row at all — it's kept as an extra instead.
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
 *  an unterminated quote, trailing junk after the close, OR a backslash that isn't part of one of
 *  those two recognized pairs (all three go to `extras`).
 *
 *  That last case is the fix for a critical round-trip bug: a lone backslash not followed by `"` or
 *  `\` (e.g. `.\SQLEXPRESS` in a DSN, `^\d+$` in a regex, `C:\Users` in a Windows path) used to be
 *  decoded as a literal single backslash — a reasonable-looking decode in isolation — but `formatRow`
 *  unconditionally doubles every backslash on re-encode, so ANY save (even one that only edited a
 *  different row, since the whole file is re-serialized) silently turned `.\SQLEXPRESS` into
 *  `.\\SQLEXPRESS`. Rejecting unrecognized escapes here means such a line is never accepted as an
 *  editable row in the first place — it's kept as an extra and can never be mutated by a save. */
function parseDoubleQuoted(rest: string): string | null {
  let out = '';
  for (let i = 1; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '\\') {
      const next = rest[i + 1];
      if (next === '"' || next === '\\') {
        out += next;
        i++;
        continue;
      }
      return null; // unrecognized escape — don't guess, don't risk a silent byte change on save
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
    if (!match || !parsed || !isSafeRow(match[2] as string, parsed.value, parsed.quoted)) {
      extras.push({ index, line });
      return;
    }

    rows.push({ key: match[1] as string, value: parsed.value, quoted: parsed.quoted });
  });

  return { rows, extras };
}

/** True when text uses Windows (CRLF) line endings anywhere. `parseEnv` splits on `\n` only, so a
 *  CRLF file leaves a trailing `\r` on every line — which then fails every row-shaped regex in this
 *  module (they all reject whitespace, and `\r` counts as `\s`), so a CRLF file parses as all-extras
 *  (zero editable rows). Rather than silently rewriting the file's line-ending style on save (which
 *  `serializeEnv`'s extras-are-verbatim design deliberately avoids), the UI uses this to show an
 *  honest "edit in Raw mode" note instead of a Table view that mysteriously has no rows. */
export function hasCRLF(text: string): boolean {
  return text.includes('\r\n');
}

/** Mirrors `formatAssignment` in `server/src/deploy/envfile.ts` (not exported there, so duplicated
 *  here per Ruling 1's guidance — see the module doc comment). Quotes only when the value contains a
 *  space, `#`, `"`, or `\`, escaping `\` then `"` in that order. */
function needsQuoting(value: string): boolean {
  return /[ #"\\]/.test(value);
}

/** The `rest`-of-line text `formatRow` would emit for `value` (everything after `KEY=`), with no
 *  quoting applied when none is needed. Split out from `formatRow` so `isSafeRow` can compare it
 *  directly against a parsed line's original `rest` text without reconstructing `key=`. */
function formatValue(value: string): string {
  if (!needsQuoting(value)) {
    return value;
  }
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function formatRow(row: EnvRow): string {
  return `${row.key}=${formatValue(row.value)}`;
}

/**
 * The gate `parseEnv` runs before accepting a candidate `{value, quoted}` as an editable row.
 * `originalRest` is the exact source text after `KEY=` (before any decoding). A row is only safe to
 * accept when EITHER:
 *   - `serializeEnv` reproduces `originalRest` byte-for-byte (the normal, no-surprises case), or
 *   - the value needs no quoting at all and the source wrapped it in quotes anyway — the one
 *     documented exception (see the module doc comment's "Accepted normalizations"): stripping
 *     decorative quotes around a value with no space/`#`/`"`/`\` can never change what it means.
 * Anything else — most importantly a double-quoted value whose escaping `parseDoubleQuoted` accepted
 * but that still doesn't reproduce byte-for-byte, or a single-quoted value that actually needs
 * quoting — is rejected so the line falls back to `extras` (preserved verbatim) instead of risking a
 * silent byte change on the next save.
 */
function isSafeRow(originalRest: string, value: string, quoted: boolean): boolean {
  if (formatValue(value) === originalRest) return true;
  if (quoted && !needsQuoting(value)) return true;
  return false;
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
