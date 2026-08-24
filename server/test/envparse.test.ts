import { describe, expect, it } from 'vitest';
import { parseEnv, serializeEnv, findDuplicateKeys, type EnvRow } from '../src/deploy/envparse.js';

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

  it('unwraps a single-quoted value literally (no escapes)', () => {
    const { rows } = parseEnv("TOKEN='raw value'");
    expect(rows).toEqual([{ key: 'TOKEN', value: 'raw value', quoted: true }]);
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

  it('normalizes single-quote style to the unquoted/double-quote rule, same as formatAssignment', () => {
    const { rows, extras } = parseEnv("TOKEN='raw value'");
    // needs quoting (space) -> re-quoted with double quotes per formatAssignment's rule
    expect(serializeEnv(rows, extras)).toBe('TOKEN="raw value"');
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
