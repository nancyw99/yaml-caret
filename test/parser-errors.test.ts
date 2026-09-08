// Regression tests for the caret-pointed error format the README documents.
// Each case is traced by hand against parser.ts to pin down the exact
// line/column it should report, then checked against the full rendered
// message — not just "it throws" — since a drifted column or a caret that
// no longer lines up with the reported column is the whole point of this
// library and would otherwise go unnoticed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlParseError } from '../src/parser';

// Mirrors YamlParseError's private render/renderBlock, which isn't
// exported. This is the format documented in the README, so hard-coding it
// here is asserting the public contract, not the implementation detail.
function formatBlock(message: string, line: number, column: number, sourceLine: string): string {
  const label = String(line);
  const gutter = ' '.repeat(label.length);
  const caret = ' '.repeat(Math.max(0, column - 1)) + '^';
  return [
    `${message} (line ${line}, column ${column})`,
    `${gutter} |`,
    `${label} | ${sourceLine}`,
    `${gutter} | ${caret}`,
  ].join('\n');
}

interface Note {
  message: string;
  line: number;
  column: number;
  raw: string;
}

function assertParseError(
  source: string,
  message: string,
  line: number,
  column: number,
  sourceLine: string,
  note?: Note,
): void {
  assert.throws(() => parseYaml(source), (err: unknown) => {
    if (!(err instanceof YamlParseError)) return false;
    assert.equal(err.line, line);
    assert.equal(err.column, column);
    assert.equal(err.sourceLine, sourceLine);
    let expected = formatBlock(message, line, column, sourceLine);
    if (note) expected += '\n' + formatBlock(note.message, note.line, note.column, note.raw);
    assert.equal(err.message, expected);
    return true;
  });
}

test('duplicate key in a block mapping points at both definitions', () => {
  assertParseError('name: web\nname: api\n', 'duplicate key "name"', 2, 1, 'name: api', {
    message: 'note: first defined here',
    line: 1,
    column: 1,
    raw: 'name: web',
  });
});

test('duplicate key in a flow mapping points at both definitions', () => {
  assertParseError('obj: {a: 1, a: 2}\n', 'duplicate key "a"', 1, 13, 'obj: {a: 1, a: 2}', {
    message: 'note: first defined here',
    line: 1,
    column: 7,
    raw: 'obj: {a: 1, a: 2}',
  });
});

test('a tab used for indentation is rejected at the tab column', () => {
  assertParseError(
    'database:\n\thost: localhost\n',
    'tab characters are not allowed for indentation',
    2,
    1,
    '\thost: localhost',
  );
});

test('an unterminated double-quoted string points at the opening quote', () => {
  assertParseError('key: "unterminated\n', 'unterminated double-quoted string', 1, 6, 'key: "unterminated');
});

test('an unterminated single-quoted string points at the opening quote', () => {
  assertParseError("key: 'unterminated\n", 'unterminated single-quoted string', 1, 6, "key: 'unterminated");
});

test('an unknown escape sequence names the offending character', () => {
  assertParseError('key: "\\q"\n', 'unknown escape sequence "\\q"', 1, 7, 'key: "\\q"');
});

test('a short \\u escape is rejected', () => {
  assertParseError('key: "\\u12"\n', 'invalid \\u escape sequence', 1, 7, 'key: "\\u12"');
});

test('trailing characters after a closing quote are reported at the quote', () => {
  assertParseError(
    'key: "value" extra\n',
    'unexpected characters after closing quote: "extra"',
    1,
    12,
    'key: "value" extra',
  );
});

test('an undefined alias is reported at the alias marker', () => {
  assertParseError('value: *missing\n', 'undefined alias "*missing"', 1, 8, 'value: *missing');
});

test('an invalid block scalar header is reported at the header', () => {
  assertParseError('key: |x\n', 'invalid block scalar header "|x"', 1, 6, 'key: |x');
});

test('a mapping line with no colon is reported as a bad entry', () => {
  assertParseError('a: 1\nb\n', 'expected "key: value"', 2, 1, 'b');
});

test('a colon with no key text before it is reported', () => {
  assertParseError(': value\n', 'missing mapping key before ":"', 1, 1, ': value');
});

test('an unterminated flow sequence points just past the last token', () => {
  assertParseError('items: [1, 2\n', 'unterminated flow sequence, expected "]"', 1, 13, 'items: [1, 2');
});

test('a second document rejected by parseYaml points at its "---"', () => {
  assertParseError(
    'first\n---\nsecond\n',
    'multiple documents found; use parseYamlDocuments() to parse a multi-document stream',
    2,
    1,
    '---',
  );
});

test('a line indented past its document root reports the expected column', () => {
  assertParseError(
    'hello\n  world\n',
    'unexpected indentation: expected this line to align with column 1',
    2,
    3,
    '  world',
  );
});
