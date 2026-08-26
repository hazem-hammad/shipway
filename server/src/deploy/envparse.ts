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
 * when `isSafeRow` (see its doc comment) confirms it — either the source line reproduces byte-for-byte
 * through `formatValueDetailed` (the same function that decides what a SAVE writes for any row, not
 * just ones sourced from parsing text), or it's the one documented decorative-quote-drop exception,
 * verified as a genuine fixed point under reparse rather than assumed safe by character content.
 * Anything else (comments, blanks, `export FOO=bar` lines, an indented assignment, or an unterminated
 * quote) is kept as an opaque "extra" line at its original position instead of being reformatted or
 * silently dropped.
 *
 * Fix wave I1 (`.superpowers/sdd/2026-08-25-shipway-v3/final-review.md`): before this fix, the
 * write path (`formatRow`/`formatValue`, used by every `serializeEnv` call, including saving a row a
 * user typed fresh into a brand-new Table row — never parsed from any source text, so `isSafeRow`
 * never ran on it at all) decided quoting purely by `needsQuoting`'s character-membership test, with
 * no reparse verification of its own. A value like `'secret'` or `''` has none of `needsQuoting`'s
 * trigger characters, so it was written UNQUOTED — `MY_SECRET='secret'` — which reads back on the next
 * parse as a *single-quoted* assignment, silently stripping the apostrophes to `secret`. `formatValueDetailed`
 * (below) closes this by performing the exact same reparse verification on every write that `isSafeRow`
 * already performed on read, so the write path can no longer produce a value that doesn't round-trip.
 *
 * Fix wave M13 (same review): extending `parseDoubleQuoted` to recognize `\r`/`\n` let
 * `formatValueDetailed` PROVE a CR/LF-bearing value round-trips, which promoted lines like a
 * multi-line PEM key into editable Table rows — but the Table UI is a single-line `<input>` that
 * silently swallows control characters, so an edit to that specific row could destroy the newline.
 * `isSafeRow` (below) now refuses to classify any value containing `\r`/`\n` as a row at all; such a
 * line stays a preserved extra, matching an unrecognized backslash escape's treatment. The write path
 * (`formatValueDetailed`/`escapeForDoubleQuote`) is unchanged and still emits CR/LF correctly for a
 * value that arrives some other way (Raw mode, the API) — see `isSafeRow`'s doc comment for detail.
 *
 * Accepted normalizations (the ONLY byte-level differences `parseEnv`+`serializeEnv` are allowed to
 * introduce for a line that becomes a row, with zero user edits to that row):
 *   - Decorative quotes are dropped: `KEY="plain"` or `KEY='plain'` -> `KEY=plain`. This is safe
 *     specifically because it passes `formatValueDetailed`'s reparse check — not merely because `plain`
 *     has none of `needsQuoting`'s trigger characters.
 *   That's it. In particular: a double-quoted value is only ever accepted as a row UNCHANGED when its
 *   escaping already uses exactly the recognized `\\`/`\"`/`\r`/`\n` pairs (see `parseDoubleQuoted`) —
 *   any OTHER backslash usage (e.g. `\S` in `.\SQLEXPRESS`, `\d` in `^\d+$`) is a lone/unrecognized
 *   escape from a hand-authored file and the whole line becomes an extra rather than being silently
 *   re-escaped into something with a different byte count. A single-quoted source that actually needs
 *   quoting (contains a space/`#`/`"`/`\`) similarly becomes an extra rather than being switched to
 *   double-quote style mid-save, since that changes the file's bytes with no user edit to that row —
 *   see `isSafeRow`'s doc comment for exactly which of its two cases each shape falls into. Every row
 *   that IS produced is checked against this contract directly rather than trusted by construction — a
 *   value's decode is never assumed reversible; it's verified, by actually round-tripping it through
 *   the parser again, on BOTH the read and write paths.
 */

export interface EnvRow {
  key: string;
  value: string;
  /**
   * True when the source line wrapped the value in quotes (single or double). Informational only:
   * `serializeEnv` decides quoting purely by whether the value needs it (see `formatValueDetailed`
   * below), mirroring `envfile.ts`'s (unexported) `formatAssignment` — so a row's quotes are not
   * "sticky". A value that was quoted but didn't need to be (e.g. `KEY="plain"`) always comes back out
   * unquoted, but only when doing so is a genuine fixed point under reparse (see `formatValueDetailed`'s
   * doc comment) — a value like `"'secret'"` looks unquotable by character content alone but isn't,
   * because the unquoted form would be misread as single-quoted on the next parse, so `formatValueDetailed`
   * escalates it to an explicit double-quoted row (`quoted: true`) instead of silently corrupting it.
   * A value that DOES need quoting (space/`#`/`"`/`\`) is only ever represented as a row when its
   * source form already reproduces byte-for-byte through `serializeEnv` — see the module doc comment's
   * "Accepted normalizations" — so for such a row `quoted` is always `true` and stays that way; a value
   * needing quoting whose source form wouldn't round-trip exactly (e.g. a single-quoted value with a
   * space, or a double-quoted value with an unrecognized backslash escape) never becomes a row at all —
   * it's kept as an extra instead.
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

/** Unescapes a double-quoted value using the same pairing `escapeForDoubleQuote` produces (`\\` ->
 *  `\`, `\"` -> `"`, `\r` -> a literal CR, `\n` -> a literal LF), requiring the closing quote to be
 *  the last character on the line. Returns `null` for an unterminated quote, trailing junk after the
 *  close, OR a backslash that isn't part of one of those four recognized pairs (all three go to
 *  `extras`).
 *
 *  The four recognized pairs are exactly (and only) the ones `escapeForDoubleQuote` can ever produce
 *  — see its doc comment — which is what lets `isSafeRow` and `formatValueDetailed`'s own internal
 *  round-trip check treat "this decodes" and "this is safe to accept as a row" as the same question.
 *  Any OTHER backslash escape (e.g. `\S` in `.\SQLEXPRESS`, `\d` in `^\d+$`) is a lone/unrecognized
 *  backslash from a hand-authored file, not something this parser's own encoder would ever emit, and
 *  is rejected rather than guessed at.
 *
 *  Rejecting unrecognized escapes here is also the fix for a critical round-trip bug: a lone
 *  backslash not followed by a recognized escape char (e.g. `.\SQLEXPRESS` in a DSN, `^\d+$` in a
 *  regex, `C:\Users` in a Windows path) used to be decoded as a literal single backslash — a
 *  reasonable-looking decode in isolation — but `formatRow` unconditionally doubles every backslash
 *  on re-encode, so ANY save (even one that only edited a different row, since the whole file is
 *  re-serialized) silently turned `.\SQLEXPRESS` into `.\\SQLEXPRESS`. Rejecting unrecognized escapes
 *  here means such a line is never accepted as an editable row in the first place — it's kept as an
 *  extra and can never be mutated by a save. */
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
      if (next === 'r') {
        out += '\r';
        i++;
        continue;
      }
      if (next === 'n') {
        out += '\n';
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

/** Decodes a whole `KEY=rest` line with no safety gating — the raw building block both `parseEnv`
 *  and `isSafeRow`'s fixed-point check share. Returns `null` for anything that isn't a bare
 *  `KEY=value` assignment (blanks/comments/`export`/indentation are filtered by `parseEnv` before it
 *  ever gets here, so in practice this only returns `null` for an unparseable value). */
function decodeLine(line: string): { key: string; value: string; quoted: boolean } | null {
  const match = ASSIGNMENT_RE.exec(line);
  if (!match) return null;
  const parsed = parseAssignmentValue(match[2] as string);
  return parsed ? { key: match[1] as string, value: parsed.value, quoted: parsed.quoted } : null;
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
    const decoded = match ? parseAssignmentValue(match[2] as string) : null;
    if (!match || !decoded || !isSafeRow(match[2] as string, match[1] as string, decoded.value)) {
      extras.push({ index, line });
      return;
    }

    rows.push({ key: match[1] as string, value: decoded.value, quoted: decoded.quoted });
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
 *  here per Ruling 1's guidance — see the module doc comment). A first-pass signal only: "definitely
 *  needs quoting", not "safe to leave unquoted" — see `formatValueDetailed`, which is the actual
 *  authority on that question (fix wave I1). Quotes only when the value contains a space, `#`, `"`,
 *  or `\`. */
function needsQuoting(value: string): boolean {
  return /[ #"\\]/.test(value);
}

/** Escapes `value` for the inside of a double-quoted assignment, using exactly the four pairs
 *  `parseDoubleQuoted` recognizes (`\` -> `\\`, `"` -> `\"`, CR -> `\r`, LF -> `\n`), in an order that
 *  keeps them unambiguous: backslashes first (so the literal backslash characters introduced by every
 *  later step are never themselves re-escaped), then quotes, then CR/LF. Every other character
 *  (letters, digits, unicode, tabs, `'`, `#`, spaces, ...) passes through unchanged — `parseDoubleQuoted`
 *  copies them back verbatim, so this pairing is a true bijection: for ANY string `value` (this is the
 *  fix-wave I1 property), `parseDoubleQuoted` un-escaping `escapeForDoubleQuote(value)` always yields
 *  back exactly `value`. That is what makes "escalate to double-quoting" below a real fallback rather
 *  than just a different guess. */
function escapeForDoubleQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

interface FormattedValue {
  /** The `rest`-of-line text `formatRow` emits for this value (everything after `KEY=`). */
  text: string;
  /** Whether `text` is the escaped double-quoted form (escalated) vs. the bare value emitted unquoted. */
  quoted: boolean;
}

/**
 * THE single source of truth for how to write `value` safely (fix wave I1 — this used to be a
 * character-membership guess with no verification; see the module doc comment's "Round 2" history).
 * Tries the shortest safe representation first, but only ever returns one that's PROVEN — by actually
 * reparsing it, not by reasoning about which characters make that ambiguous — to read back as exactly
 * `value`:
 *
 *   1. If `value` doesn't need quoting by `needsQuoting`'s character test AND writing it bare and
 *      decoding that back (via `decodeLine`, the same primitive `parseEnv` itself uses) reproduces
 *      `value` unquoted — genuinely a fixed point — emit it bare. This is what makes `KEY="plain"`
 *      correctly drop its decorative quotes on save; it's ALSO what catches the sibling bug a value
 *      like `'secret'` or `''` used to hit: `needsQuoting` sees no space/#/"/\\ and used to wave it
 *      through unquoted, but `'secret'` written bare and reparsed comes back as a *single-quoted*
 *      assignment (value `secret`, apostrophes stripped as delimiters) — not a fixed point — so this
 *      step correctly declines it.
 *   2. Otherwise, escalate to `escapeForDoubleQuote` (see its doc comment for why that's ALWAYS a
 *      fixed point, for literally any string) and emit the double-quoted form.
 *
 * The invariant this guarantees, for ANY value a user can type into a Table-mode cell: writing `value`
 * this way and reparsing it back always yields exactly `value` — `decodeLine(`${key}=${formatValueDetailed(key,
 * value).text}`)?.value === value`, unconditionally. There is no third "can't be represented" case.
 */
function formatValueDetailed(key: string, value: string): FormattedValue {
  if (!needsQuoting(value)) {
    const reparsed = decodeLine(`${key}=${value}`);
    if (reparsed !== null && !reparsed.quoted && reparsed.value === value) {
      return { text: value, quoted: false };
    }
  }
  return { text: `"${escapeForDoubleQuote(value)}"`, quoted: true };
}

function formatValue(key: string, value: string): string {
  return formatValueDetailed(key, value).text;
}

/**
 * A single `KEY=value` line, quoted exactly the way `serializeEnv` would write it (i.e. through
 * `formatValueDetailed`, so the round-trip guarantee in its doc comment holds here too). Exported
 * for callers that assemble or patch individual lines rather than a whole rows+extras document —
 * `deploy/laravel.ts`'s `upsertEnvVars`, which rewrites specific keys in place inside env text it
 * must otherwise leave byte-for-byte alone.
 */
export function formatEnvAssignment(key: string, value: string): string {
  return `${key}=${formatValue(key, value)}`;
}

function formatRow(row: EnvRow): string {
  return `${row.key}=${formatValue(row.key, row.value)}`;
}

/**
 * The gate `parseEnv` runs before accepting a candidate `{key, value}` as an editable row.
 * `originalRest` is the exact source text after `KEY=` (before any decoding). A row is safe to accept
 * in exactly two cases, both driven by `formatValueDetailed` — the same function `formatRow` uses to
 * actually write the value on save, so "safe to show as an editable row" and "safe to write" can never
 * drift apart the way they did before fix wave I1 (the write path had no reparse check of its own):
 *
 *   1. `formatValueDetailed` reproduces `originalRest` byte-for-byte (the normal, no-surprises case —
 *      covers plain unquoted values and double-quoted values whose escaping already uses exactly the
 *      recognized `\\`/`\"`/`\r`/`\n` pairs).
 *   2. `formatValueDetailed` chose to emit `value` UNQUOTED. That choice is only ever made after
 *      `formatValueDetailed` has itself verified (case 1 of its own logic) that doing so is a genuine
 *      fixed point under reparse — so it's always safe to accept even when the SOURCE had (unneeded)
 *      quotes, changing this row's bytes on save from e.g. `KEY="plain"` to `KEY=plain`. That's the one
 *      sanctioned normalization (see the module doc comment's "Accepted normalizations"): dropping
 *      decorative quotes the value never needed.
 *
 * Prior to fix wave I1, case 2 was a second, independently-implemented reparse check living only in
 * `isSafeRow` — the write path (`formatRow`/`formatValue`) had no equivalent guard at all, so a value
 * like `'secret'` typed fresh into a NEW row (not sourced from parsing any existing text, so `isSafeRow`
 * never even ran on it) could be written unquoted, corrupting it on the very next reparse. Now that
 * `formatValueDetailed` performs that same fixed-point check unconditionally for every write, `isSafeRow`
 * just asks what `formatValueDetailed` decided rather than re-deriving it — which also means values that
 * used to be conservatively kept as un-editable extras purely because the write side couldn't yet prove
 * they were safe (`MY_SECRET="'secret'"`, `KEY="''"`, `TOKEN="'hello"`, `KEY="'a'b'c'"` — see
 * `envparse.test.ts`'s "Round 2" fixtures) now correctly become editable rows: `formatValueDetailed`
 * proves the escalated double-quoted form byte-matches the source exactly, satisfying case 1.
 *
 * Fix wave M13 (`.superpowers/sdd/2026-08-25-shipway-v3/final-review.md`): extending `parseDoubleQuoted`
 * to recognize `\r`/`\n` made `formatValueDetailed` able to PROVE a value containing a literal CR/LF is a
 * genuine fixed point (case 1 above) — which is correct for round-tripping bytes, but promoted such a
 * value into an editable ROW. The Table-mode UI is a single-line `<input>`, which cannot display a
 * control character and silently drops it: a multi-line PEM key or a `\n`-bearing value renders as
 * mangled single-line text, and typing even one more character into that field rewrites the whole line
 * WITHOUT the newline — silently destroying it on save. Before this fix such a line was an unrecognized
 * escape and stayed an opaque, uneditable extra, so this is a data-safety regression specific to the
 * table, not the parser: the value decodes correctly and the FILE round-trips safely as long as the row
 * is never edited. Rather than weaken `escapeForDoubleQuote`/`parseDoubleQuoted` (the write path must
 * still be able to emit CR/LF correctly for values that arrive some other way, e.g. Raw mode or the API),
 * `isSafeRow` now refuses to classify any CR/LF-bearing value as a row at all — the line is kept as a
 * verbatim extra instead, restoring the invariant that anything the table CAN edit, the table can
 * faithfully display.
 */
function isSafeRow(originalRest: string, key: string, value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  const formatted = formatValueDetailed(key, value);
  if (formatted.text === originalRest) return true;
  return !formatted.quoted;
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
