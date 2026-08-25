import { describe, expect, it } from 'vitest';
import { parseEnv, serializeEnv, findDuplicateKeys, hasCRLF, type EnvRow } from '../src/deploy/envparse.js';

describe('parseEnv', () => {
  it('parses a plain KEY=value line into a row', () => {
    const { rows, extras } = parseEnv('APP_NAME=demo');
    expect(rows).toEqual([{ key: 'APP_NAME', value: 'demo', quoted: false }]);
    expect(extras).toEqual([]);
  });

  it('parses an empty value', () => {
    const { rows } = parseEnv('FEATURE_FLAG=');
    expect(rows).toEqual([{ key: 'FEATURE_FLAG', value: '', quoted: false }]);
  });

  it('keeps everything after the first = as the value (= inside values)', () => {
    const { rows } = parseEnv('CONN=a=b=c');
    expect(rows).toEqual([{ key: 'CONN', value: 'a=b=c', quoted: false }]);
  });

  it('unwraps a double-quoted value with a space', () => {
    const { rows } = parseEnv('MAIL_FROM_ADDRESS="no reply"');
    expect(rows).toEqual([{ key: 'MAIL_FROM_ADDRESS', value: 'no reply', quoted: true }]);
  });

  it('unwraps a double-quoted value containing a literal #', () => {
    const { rows } = parseEnv('MAIL_ENCRYPTION="tls#insecure"');
    expect(rows).toEqual([{ key: 'MAIL_ENCRYPTION', value: 'tls#insecure', quoted: true }]);
  });

  it('unescapes \\\\ and \\" inside a double-quoted value', () => {
    const { rows } = parseEnv('MAIL_PASSWORD="p@ss\\"w\\\\ord"');
    expect(rows).toEqual([{ key: 'MAIL_PASSWORD', value: 'p@ss"w\\ord', quoted: true }]);
  });

  it('unwraps a single-quoted value that needs no quoting, dropping the decorative quotes (the one accepted normalization)', () => {
    const { rows, extras } = parseEnv("TOKEN='plain'");
    expect(rows).toEqual([{ key: 'TOKEN', value: 'plain', quoted: true }]);
    expect(extras).toEqual([]);
  });

  it('treats a single-quoted value that actually needs quoting (has a space) as an extra rather than switching quote style', () => {
    // Regression guard for the reviewer-flagged critical bug's sibling case: switching a single-quoted
    // value that needs quoting to formatRow's double-quote form would change the file's bytes on a save
    // that never touched this row. Since a single-quoted source can never byte-match a double-quoted
    // `serializeEnv` output, such a line is kept verbatim as an extra instead (see envparse.ts's
    // "Accepted normalizations" doc comment).
    const { rows, extras } = parseEnv("TOKEN='raw value'");
    expect(rows).toEqual([]);
    expect(extras).toEqual([{ index: 0, line: "TOKEN='raw value'" }]);
  });

  it('treats a double-quoted value with a lone/unrecognized backslash escape as an extra (CRITICAL regression: Windows DSN)', () => {
    // The reported bug: `.\SQLEXPRESS` decoded a bare `\` as a literal backslash, but the encoder
    // unconditionally doubles every backslash, so a save with zero edits to this row silently turned
    // `.\SQLEXPRESS` into `.\\SQLEXPRESS`. Rejecting the unrecognized escape means this line is never
    // accepted as a row at all — see the byte-identical round-trip test below.
    const line = 'DB_DSN="sqlsrv:Server=.\\SQLEXPRESS;Database=app"';
    const { rows, extras } = parseEnv(line);
    expect(rows).toEqual([]);
    expect(extras).toEqual([{ index: 0, line }]);
  });

  it('treats a double-quoted value with a regex-style backslash escape as an extra (CRITICAL regression: \\d)', () => {
    const line = 'PATTERN="^\\d+$"';
    const { rows, extras } = parseEnv(line);
    expect(rows).toEqual([]);
    expect(extras).toEqual([{ index: 0, line }]);
  });

  it('treats a double-quoted Windows path with multiple unrecognized backslashes as an extra', () => {
    const line = 'PATH="C:\\Program Files\\App"';
    const { rows, extras } = parseEnv(line);
    expect(rows).toEqual([]);
    expect(extras).toEqual([{ index: 0, line }]);
  });

  it('still accepts a double-quoted value whose only backslash is a properly escaped `\\\\` pair', () => {
    // Contrast case: this backslash IS one of the two recognized pairs, so it decodes and
    // re-encodes symmetrically and is safe to accept as an editable row.
    const { rows, extras } = parseEnv('KEY="a\\\\b"');
    expect(rows).toEqual([{ key: 'KEY', value: 'a\\b', quoted: true }]);
    expect(extras).toEqual([]);
  });

  it('treats blank lines as extras at their original position', () => {
    const { rows, extras } = parseEnv('APP_NAME=demo\n\nDEBUG=true');
    expect(rows).toEqual([
      { key: 'APP_NAME', value: 'demo', quoted: false },
      { key: 'DEBUG', value: 'true', quoted: false },
    ]);
    expect(extras).toEqual([{ index: 1, line: '' }]);
  });

  it('treats comment lines (leading or indented #) as extras, preserved verbatim', () => {
    const text = ['# top comment', 'APP_NAME=demo', '  # indented comment'].join('\n');
    const { rows, extras } = parseEnv(text);
    expect(rows).toEqual([{ key: 'APP_NAME', value: 'demo', quoted: false }]);
    expect(extras).toEqual([
      { index: 0, line: '# top comment' },
      { index: 2, line: '  # indented comment' },
    ]);
  });

  it('treats `export FOO=1` forms as extras, not rows', () => {
    const { rows, extras } = parseEnv('export FOO=1\nBAR=2');
    expect(rows).toEqual([{ key: 'BAR', value: '2', quoted: false }]);
    expect(extras).toEqual([{ index: 0, line: 'export FOO=1' }]);
  });

  it('treats an indented KEY=value line as an unparseable extra (no silent de-indent)', () => {
    const { rows, extras } = parseEnv('  INDENTED=oops');
    expect(rows).toEqual([]);
    expect(extras).toEqual([{ index: 0, line: '  INDENTED=oops' }]);
  });

  it('treats an unterminated quote ("multiline-ish") as an extra, verbatim, with no merging across lines', () => {
    const text = ['GOOD=1', 'BROKEN="unterminated', 'still not valid"', 'AFTER=2'].join('\n');
    const { rows, extras } = parseEnv(text);
    expect(rows).toEqual([
      { key: 'GOOD', value: '1', quoted: false },
      { key: 'AFTER', value: '2', quoted: false },
    ]);
    expect(extras).toEqual([
      { index: 1, line: 'BROKEN="unterminated' },
      { index: 2, line: 'still not valid"' },
    ]);
  });

  it('treats an unquoted value with a trailing comment as an extra (a row cannot carry the comment)', () => {
    const { rows, extras } = parseEnv('KEY=value # trailing comment');
    expect(rows).toEqual([]);
    expect(extras).toEqual([{ index: 0, line: 'KEY=value # trailing comment' }]);
  });

  it('treats an unquoted value containing an internal space as an extra', () => {
    const { rows, extras } = parseEnv('KEY=hello world');
    expect(rows).toEqual([]);
    expect(extras).toEqual([{ index: 0, line: 'KEY=hello world' }]);
  });

  it('treats a bare # with no preceding whitespace as an unparseable unquoted value (extra)', () => {
    const { rows, extras } = parseEnv('KEY=a#b');
    expect(rows).toEqual([]);
    expect(extras).toEqual([{ index: 0, line: 'KEY=a#b' }]);
  });

  it('treats a line with no = and no recognizable form as an extra', () => {
    const { rows, extras } = parseEnv('not an assignment at all');
    expect(rows).toEqual([]);
    expect(extras).toEqual([{ index: 0, line: 'not an assignment at all' }]);
  });

  it('parses an empty file as no rows and no extras', () => {
    expect(parseEnv('')).toEqual({ rows: [], extras: [] });
  });
});

describe('serializeEnv', () => {
  it('round-trips a mixed file (comments, blanks, export, quotes, plain) byte-for-byte', () => {
    const text = [
      '# app config',
      'APP_NAME=demo',
      '',
      'export LEGACY=1',
      'MAIL_FROM_ADDRESS="no reply"',
      'MAIL_ENCRYPTION="tls#insecure"',
      'MAIL_PASSWORD="p@ss\\"w\\\\ord"',
      'TOKEN="raw value"',
      'CONN=a=b=c',
      '  # trailing indented comment',
    ].join('\n');

    const { rows, extras } = parseEnv(text);
    expect(serializeEnv(rows, extras)).toBe(text);
  });

  it('drops quotes that were not needed (quoting is re-derived, not preserved verbatim)', () => {
    const { rows, extras } = parseEnv('KEY="plain"');
    expect(serializeEnv(rows, extras)).toBe('KEY=plain');
  });

  it('does NOT switch a single-quoted value that needs quoting to double-quote style (superseded behavior, see the parseEnv test above): it round-trips byte-identically as an extra instead', () => {
    const text = "TOKEN='raw value'";
    const { rows, extras } = parseEnv(text);
    expect(serializeEnv(rows, extras)).toBe(text);
  });

  it('CRITICAL regression: a DSN with an unescaped Windows-path backslash round-trips byte-identically with zero edits (was silently doubled before the fix)', () => {
    const text = 'DB_DSN="sqlsrv:Server=.\\SQLEXPRESS;Database=app"';
    const { rows, extras } = parseEnv(text);
    expect(serializeEnv(rows, extras)).toBe(text);
    expect(serializeEnv(rows, extras)).not.toContain('\\\\SQLEXPRESS');
  });

  it('CRITICAL regression: a regex value with an unescaped backslash round-trips byte-identically with zero edits', () => {
    const text = 'PATTERN="^\\d+$"';
    const { rows, extras } = parseEnv(text);
    expect(serializeEnv(rows, extras)).toBe(text);
  });

  it('CRITICAL regression: editing an unrelated row and re-serializing leaves backslash-bearing extra lines byte-for-byte untouched', () => {
    const text = [
      'APP_NAME=demo',
      'DB_DSN="sqlsrv:Server=.\\SQLEXPRESS;Database=app"',
      'PATTERN="^\\d+$"',
    ].join('\n');
    const { rows, extras } = parseEnv(text);

    // Confirm the setup: only APP_NAME became an editable row; the two backslash lines are extras.
    expect(rows).toEqual([{ key: 'APP_NAME', value: 'demo', quoted: false }]);
    expect(extras.map((e) => e.line)).toEqual([
      'DB_DSN="sqlsrv:Server=.\\SQLEXPRESS;Database=app"',
      'PATTERN="^\\d+$"',
    ]);

    // Edit the one row that IS editable (simulates a user changing APP_NAME then hitting Save).
    const editedRows = rows.map((r) => (r.key === 'APP_NAME' ? { ...r, value: 'renamed' } : r));
    const out = serializeEnv(editedRows, extras);

    expect(out).toBe(
      ['APP_NAME=renamed', 'DB_DSN="sqlsrv:Server=.\\SQLEXPRESS;Database=app"', 'PATTERN="^\\d+$"'].join('\n'),
    );
  });

  it('CRITICAL regression: a realistic Laravel-style .env round-trips byte-identically', () => {
    const text = [
      'APP_NAME=Laravel',
      'APP_ENV=local',
      'APP_KEY=base64:abcd1234',
      'APP_DEBUG=true',
      'APP_URL=http://localhost',
      '',
      'LOG_CHANNEL=stack',
      '',
      'DB_CONNECTION=sqlsrv',
      'DB_HOST=127.0.0.1',
      'DB_PORT=1433',
      'DB_DATABASE=app',
      'DB_USERNAME=sa',
      'DB_PASSWORD="p@ss\\"w\\\\ord"',
      // A hand-authored Windows-style DSN a developer might paste in directly — the exact shape of
      // bug this fix exists for.
      'DB_DSN="sqlsrv:Server=.\\SQLEXPRESS;Database=app"',
      '',
      '# Regex used by a validation rule',
      'ZIP_PATTERN="^\\d{5}$"',
      '',
      'CACHE_DRIVER=file',
      'QUEUE_CONNECTION=sync',
      'SESSION_DRIVER=file',
      'SESSION_LIFETIME=120',
    ].join('\n');

    const { rows, extras } = parseEnv(text);
    expect(serializeEnv(rows, extras)).toBe(text);

    // The two backslash-bearing values did NOT become editable rows (they're extras); every other
    // assignment DID.
    const rowKeys = rows.map((r) => r.key);
    expect(rowKeys).not.toContain('DB_DSN');
    expect(rowKeys).not.toContain('ZIP_PATTERN');
    expect(rowKeys).toEqual([
      'APP_NAME',
      'APP_ENV',
      'APP_KEY',
      'APP_DEBUG',
      'APP_URL',
      'LOG_CHANNEL',
      'DB_CONNECTION',
      'DB_HOST',
      'DB_PORT',
      'DB_DATABASE',
      'DB_USERNAME',
      'DB_PASSWORD',
      'CACHE_DRIVER',
      'QUEUE_CONNECTION',
      'SESSION_DRIVER',
      'SESSION_LIFETIME',
    ]);
  });

  it('matches formatAssignment\'s exact escaping for a password containing a quote and a backslash', () => {
    const rows: EnvRow[] = [{ key: 'MAIL_PASSWORD', value: 'p@ss"w\\ord', quoted: false }];
    expect(serializeEnv(rows, [])).toBe('MAIL_PASSWORD="p@ss\\"w\\\\ord"');
  });

  it('quotes a value containing only a backslash, matching formatAssignment', () => {
    const rows: EnvRow[] = [{ key: 'TOKEN', value: 'a\\b', quoted: false }];
    expect(serializeEnv(rows, [])).toBe('TOKEN="a\\\\b"');
  });

  it('reinserts extras at their original position when rows are otherwise unchanged', () => {
    const text = ['# header', 'A=1', '', 'B=2'].join('\n');
    const { rows, extras } = parseEnv(text);
    expect(serializeEnv(rows, extras)).toBe(text);
  });

  it('appends a newly added row after the parsed rows, leaving extras in place', () => {
    const text = ['# header', 'A=1'].join('\n');
    const { rows, extras } = parseEnv(text);
    const withNewRow: EnvRow[] = [...rows, { key: 'B', value: '2', quoted: false }];
    expect(serializeEnv(withNewRow, extras)).toBe(['# header', 'A=1', 'B=2'].join('\n'));
  });

  it('handles a deleted row without disturbing extra positions or throwing', () => {
    const text = ['A=1', '# comment', 'B=2', 'C=3'].join('\n');
    const { rows, extras } = parseEnv(text);
    const withoutB = rows.filter((r) => r.key !== 'B');
    const out = serializeEnv(withoutB, extras);
    expect(out).toContain('# comment');
    expect(out).toContain('A=1');
    expect(out).toContain('C=3');
    expect(out).not.toContain('B=2');
  });

  it('round-trips an empty file to an empty string', () => {
    expect(serializeEnv([], [])).toBe('');
  });

  it('is idempotent: parse -> serialize -> parse -> serialize converges', () => {
    const text = ['# app config', 'APP_NAME=demo', '', 'MAIL_PASSWORD="p@ss\\"w\\\\ord"'].join('\n');
    const once = parseEnv(text);
    const serialized = serializeEnv(once.rows, once.extras);
    const twice = parseEnv(serialized);
    expect(serializeEnv(twice.rows, twice.extras)).toBe(serialized);
  });
});

describe('quote-normalization fixed point (Round 2 regression: apostrophe-shaped values)', () => {
  // Reviewer-caught sibling bug: the Round 1 "drop decorative quotes" exception (`quoted &&
  // !needsQuoting(value)`) let a double-quoted value whose CONTENT happens to start/end with `'`
  // through as an unquoted row, even though `needsQuoting` never checks for `'` at all. That unquoted
  // text then gets misread as a *single-quoted* assignment on the very next parse (a Table<->Raw
  // switch or a page reload, not just a Save), silently stripping or corrupting the apostrophes.
  //
  // Fix wave I1 (final-review.md): the ORIGINAL read-path-only fix made these lines inert by keeping
  // them as non-editable `extras` forever — safe, but permanently un-editable, since at the time the
  // WRITE path (`formatRow`/`formatValue`) had no equivalent reparse guard and couldn't be trusted to
  // write a corrected value back safely either. Now that `formatValueDetailed` performs that same
  // fixed-point verification on every write (see envparse.ts), these values are PROVABLY safe to
  // write as an escalated double-quoted row — so they now correctly become editable ROWS with the
  // exact (uncorrupted) value, not extras. Each case is still asserted through TWO full
  // parse->serialize cycles (mimicking a mode switch followed by another mode switch, or two page
  // loads) to prove the value is stable, not just correct once.
  const fixtures = [
    { name: 'MY_SECRET="\'secret\'"', line: 'MY_SECRET="\'secret\'"', key: 'MY_SECRET', value: "'secret'" },
    { name: 'KEY="\'\'"', line: 'KEY="\'\'"', key: 'KEY', value: "''" },
    { name: 'TOKEN="\'hello"', line: 'TOKEN="\'hello"', key: 'TOKEN', value: "'hello" },
    { name: 'KEY="\'a\'b\'c\'"', line: 'KEY="\'a\'b\'c\'"', key: 'KEY', value: "'a'b'c'" },
  ];

  for (const { name, line, key, value } of fixtures) {
    it(`${name}: becomes an editable row with the exact (uncorrupted) value, byte-identical on re-encode, stable across two full parse->serialize cycles`, () => {
      const first = parseEnv(line);
      expect(first.rows).toEqual([{ key, value, quoted: true }]);
      expect(first.extras).toEqual([]);
      const serializedOnce = serializeEnv(first.rows, first.extras);
      expect(serializedOnce).toBe(line);

      // Second cycle: reparse what was just serialized (simulates a second mode switch / reload) and
      // confirm the value is still exactly the same, not progressively corrupted.
      const second = parseEnv(serializedOnce);
      expect(second.rows).toEqual([{ key, value, quoted: true }]);
      expect(second.extras).toEqual([]);
      const serializedTwice = serializeEnv(second.rows, second.extras);
      expect(serializedTwice).toBe(line);
    });
  }

  it('MY_SECRET="\'secret\'": the specific corruption the reviewer demonstrated (apostrophes silently stripped) does not happen', () => {
    const { rows, extras } = parseEnv('MY_SECRET="\'secret\'"');
    // Now a row, with the apostrophes intact — never corrupted to the bare "secret" the old
    // unquoted-write bug produced.
    expect(rows.find((r) => r.key === 'MY_SECRET')?.value).toBe("'secret'");
    expect(extras).toEqual([]);
  });

  it('KEY="\'\'": does not silently decode to an empty string on any reparse', () => {
    const { rows, extras } = parseEnv('KEY="\'\'"');
    expect(rows).toEqual([{ key: 'KEY', value: "''", quoted: true }]);
    expect(extras).toEqual([]);
    // Re-run through serializeEnv+parseEnv once more to be sure nothing collapses to '' downstream.
    const again = parseEnv(serializeEnv(rows, extras));
    expect(again.rows).toEqual([{ key: 'KEY', value: "''", quoted: true }]);
  });

  it('a double-quoted value that merely CONTAINS an apostrophe (not at either edge) is unaffected and still becomes a row', () => {
    // Sanity check that the fix isn't overly broad: "it's fine" has an apostrophe in the middle, does
    // not start or end with one, and needs quoting anyway (the space), so it round-trips normally.
    const { rows, extras } = parseEnv('MSG="it\'s fine"');
    expect(rows).toEqual([{ key: 'MSG', value: "it's fine", quoted: true }]);
    expect(extras).toEqual([]);
    expect(serializeEnv(rows, extras)).toBe('MSG="it\'s fine"');
  });

  it('a single-quoted SOURCE that needs quoting still stays an extra rather than switching to double-quote style', () => {
    // Contrast case, unaffected by the fix: `isSafeRow`'s case 2 only ever accepts a row when
    // `formatValueDetailed` chose the UNQUOTED form. A value needing quoting (here: the space) is
    // always escalated to double-quoted by `formatValueDetailed`, so a single-quoted source can never
    // byte-match it — correctly kept as an extra instead of silently switching quote style mid-save.
    const { rows, extras } = parseEnv("TOKEN='raw value'");
    expect(rows).toEqual([]);
    expect(extras).toEqual([{ index: 0, line: "TOKEN='raw value'" }]);
  });
});

describe('write-path round-trip (fix wave I1: BLOCKER — formatValue never verified what it wrote)', () => {
  // The bug, reproduced live against the running app: typing `'secret'` into a Table-mode value cell
  // (a NEW row, never parsed from any source text) saved as `MY_SECRET='secret'` and read back as
  // `secret` — formatValue decided quoting by character membership only (`needsQuoting`), with no
  // verification that the unquoted form it emitted actually meant the same thing on the next parse.
  // The fix: `formatValueDetailed` (envparse.ts) now reparses its own candidate output before
  // returning it, escalating to double-quoting whenever the bare form isn't a genuine fixed point.
  //
  // Each fixture here simulates the ACTUAL bug path: a fresh row (as if freshly typed into an empty
  // Table cell, `quoted: false`, never touched `parseEnv`) is written with `serializeEnv` and read
  // back with `parseEnv` — the invariant is that the row's value survives byte-for-byte.
  const fixtures: Array<{ name: string; key: string; value: string }> = [
    { name: "single-quote wrapped: 'secret'", key: 'MY_SECRET', value: "'secret'" },
    { name: 'bare double apostrophe: empty single-quoted shape', key: 'EMPTY_QUOTES', value: "''" },
    { name: "leading apostrophe only: 'hello", key: 'TOKEN', value: "'hello" },
    { name: "interspersed apostrophes: 'a'b'c'", key: 'KEY', value: "'a'b'c'" },
    { name: 'a backslash-bearing Windows DSN', key: 'DB_DSN', value: 'sqlsrv:Server=.\\SQLEXPRESS;Database=app' },
    { name: 'a value containing a double quote', key: 'MSG', value: 'she said "hi" to me' },
    { name: 'a value containing a bare #', key: 'MAIL_ENCRYPTION', value: 'tls#insecure' },
    { name: 'a value containing spaces', key: 'MAIL_FROM_ADDRESS', value: 'no reply' },
    { name: 'a value with a trailing backslash', key: 'PATH_LIKE', value: 'C:\\Windows\\System32\\' },
  ];

  for (const { name, key, value } of fixtures) {
    it(`${name}: parseEnv(serializeEnv([{key, value}], [])) yields back the exact value`, () => {
      const rows: EnvRow[] = [{ key, value, quoted: false }];
      const text = serializeEnv(rows, []);

      const parsed = parseEnv(text);
      const row = parsed.rows.find((r) => r.key === key);
      expect(row).toBeDefined();
      expect(row!.value).toBe(value);
      expect(parsed.extras).toEqual([]);

      // A second cycle (mode switch / reload) must be equally stable.
      const again = parseEnv(serializeEnv(parsed.rows, parsed.extras));
      expect(again.rows.find((r) => r.key === key)?.value).toBe(value);
    });
  }

  it('writing several adversarial rows together: every value survives, none bleed into each other', () => {
    const rows: EnvRow[] = fixtures.map(({ key, value }) => ({ key, value, quoted: false }));
    const text = serializeEnv(rows, []);
    const parsed = parseEnv(text);

    expect(parsed.extras).toEqual([]);
    expect(parsed.rows).toHaveLength(fixtures.length);
    for (const { key, value } of fixtures) {
      expect(parsed.rows.find((r) => r.key === key)?.value).toBe(value);
    }
  });

  it('property check: a few dozen generated values mixing quotes/backslashes/spaces all round-trip exactly', () => {
    // Small deterministic PRNG (mulberry32) so failures are reproducible without a fuzzing dependency.
    function mulberry32(seed: number): () => number {
      let a = seed;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const alphabet = ["'", '"', '\\', ' ', '#', 'a', 'b', '0', '_', '-', '.', ':', ';'];
    const rand = mulberry32(20260825);
    const values: string[] = [];
    for (let i = 0; i < 40; i++) {
      const len = 1 + Math.floor(rand() * 12);
      let value = '';
      for (let j = 0; j < len; j++) {
        value += alphabet[Math.floor(rand() * alphabet.length)];
      }
      values.push(value);
    }

    for (const value of values) {
      const rows: EnvRow[] = [{ key: 'GENERATED', value, quoted: false }];
      const parsed = parseEnv(serializeEnv(rows, []));
      const row = parsed.rows.find((r) => r.key === 'GENERATED');
      expect(row, `value ${JSON.stringify(value)} did not round-trip as a row (extras: ${JSON.stringify(parsed.extras)})`).toBeDefined();
      expect(row!.value, `value ${JSON.stringify(value)} corrupted on round-trip`).toBe(value);
    }
  });
});

describe('CR/LF-bearing values are kept as extras, never editable rows (fix wave M13)', () => {
  // The bug: extending parseDoubleQuoted to recognize \r/\n as escapes let formatValueDetailed PROVE
  // such a value is a fixed point under reparse, which promoted it into an editable Table row — but the
  // Table UI is a single-line <input> that silently swallows control characters. WINPATH="C:\next"
  // decodes to `C:` + LF + `ext`, displays as "C:ext", and appending one character used to rewrite the
  // line as `WINPATH=C:extX`, destroying the newline. The fix: isSafeRow now rejects any decoded value
  // containing \r or \n, so the line stays a verbatim extra (uneditable, but never mangled) — the same
  // treatment an unrecognized backslash escape already gets.
  const fixtures = [
    { name: 'a value with an embedded \\n escape (WINPATH="C:\\next")', line: 'WINPATH="C:\\next"' },
    {
      name: 'a multi-line PEM-style key',
      line: 'KEY="-----BEGIN PRIVATE KEY-----\\nMIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7\\n-----END PRIVATE KEY-----"',
    },
    { name: 'a \\r-bearing value', line: 'FIELD="a\\rb"' },
  ];

  for (const { name, line } of fixtures) {
    it(`${name}: classified as an extra, not a row`, () => {
      const { rows, extras } = parseEnv(line);
      expect(rows).toEqual([]);
      expect(extras).toEqual([{ index: 0, line }]);
    });

    it(`${name}: survives two parse->serialize cycles byte-identically`, () => {
      const first = parseEnv(line);
      const serializedOnce = serializeEnv(first.rows, first.extras);
      expect(serializedOnce).toBe(line);

      const second = parseEnv(serializedOnce);
      expect(second.rows).toEqual([]);
      const serializedTwice = serializeEnv(second.rows, second.extras);
      expect(serializedTwice).toBe(line);
    });

    it(`${name}: is counted in extras`, () => {
      const { extras } = parseEnv(line);
      expect(extras.length).toBe(1);
    });
  }

  it('editing an unrelated row in the same file leaves the CR/LF-bearing lines byte-for-byte untouched', () => {
    const text = [
      'APP_NAME=demo',
      'WINPATH="C:\\next"',
      'PEM_KEY="-----BEGIN KEY-----\\nabc123\\n-----END KEY-----"',
      'CRFIELD="a\\rb"',
    ].join('\n');
    const { rows, extras } = parseEnv(text);

    // Confirm the setup: only APP_NAME became an editable row; the three CR/LF-bearing lines are extras.
    expect(rows).toEqual([{ key: 'APP_NAME', value: 'demo', quoted: false }]);
    expect(extras.map((e) => e.line)).toEqual([
      'WINPATH="C:\\next"',
      'PEM_KEY="-----BEGIN KEY-----\\nabc123\\n-----END KEY-----"',
      'CRFIELD="a\\rb"',
    ]);

    // Edit the one row that IS editable (simulates a user changing APP_NAME then hitting Save).
    const editedRows = rows.map((r) => (r.key === 'APP_NAME' ? { ...r, value: 'renamed' } : r));
    const out = serializeEnv(editedRows, extras);

    expect(out).toBe(
      [
        'APP_NAME=renamed',
        'WINPATH="C:\\next"',
        'PEM_KEY="-----BEGIN KEY-----\\nabc123\\n-----END KEY-----"',
        'CRFIELD="a\\rb"',
      ].join('\n'),
    );
  });

  it('the write path can still emit a CR/LF-bearing value correctly for a row that arrives by other means (not weakened)', () => {
    // A value with a real embedded newline, as if it arrived via the API or a programmatic caller
    // rather than parseEnv (parseEnv itself will never produce such a row per the fixtures above) —
    // serializeEnv must still be able to escape it correctly, since Raw mode and direct API writes are
    // both still valid ways for such a value to reach disk.
    const rows: EnvRow[] = [{ key: 'PRIVATE_KEY', value: '-----BEGIN KEY-----\nabc123\n-----END KEY-----', quoted: false }];
    const text = serializeEnv(rows, []);
    expect(text).toBe('PRIVATE_KEY="-----BEGIN KEY-----\\nabc123\\n-----END KEY-----"');

    // And parseEnv correctly refuses to promote what it just wrote back into an editable row (it stays
    // a safely-preserved extra, per the fixtures above) rather than mangling it on the next load.
    const reparsed = parseEnv(text);
    expect(reparsed.rows).toEqual([]);
    expect(reparsed.extras).toEqual([{ index: 0, line: text }]);
  });
});

describe('hasCRLF', () => {
  it('is true when the text contains any \\r\\n line ending', () => {
    expect(hasCRLF('APP_NAME=demo\r\nDEBUG=true\r\n')).toBe(true);
  });

  it('is false for a normal LF-only file', () => {
    expect(hasCRLF('APP_NAME=demo\nDEBUG=true\n')).toBe(false);
  });

  it('is false for an empty file', () => {
    expect(hasCRLF('')).toBe(false);
  });

  it('documents the low-priority CRLF limitation: a CRLF file parses to zero rows (every line keeps its trailing \\r as an extra), but still round-trips byte-identically', () => {
    const text = 'APP_NAME=demo\r\nDEBUG=true\r\n';
    expect(hasCRLF(text)).toBe(true);
    const { rows, extras } = parseEnv(text);
    expect(rows).toEqual([]);
    expect(extras.length).toBeGreaterThan(0);
    expect(serializeEnv(rows, extras)).toBe(text);
  });
});

describe('findDuplicateKeys', () => {
  it('returns keys that appear on more than one row', () => {
    const rows: EnvRow[] = [
      { key: 'FOO', value: '1' },
      { key: 'BAR', value: '2' },
      { key: 'FOO', value: '3' },
    ];
    expect(findDuplicateKeys(rows)).toEqual(new Set(['FOO']));
  });

  it('returns an empty set when every key is unique', () => {
    const rows: EnvRow[] = [
      { key: 'FOO', value: '1' },
      { key: 'BAR', value: '2' },
    ];
    expect(findDuplicateKeys(rows)).toEqual(new Set());
  });

  it('ignores blank keys when detecting duplicates (in-progress new rows)', () => {
    const rows = [{ key: '', value: '' }, { key: '', value: '' }, { key: 'FOO', value: '1' }];
    expect(findDuplicateKeys(rows)).toEqual(new Set());
  });

  it('is case-sensitive', () => {
    const rows: EnvRow[] = [
      { key: 'Foo', value: '1' },
      { key: 'FOO', value: '2' },
    ];
    expect(findDuplicateKeys(rows)).toEqual(new Set());
  });
});
