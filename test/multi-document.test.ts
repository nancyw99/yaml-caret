// Coverage for parseYamlDocuments. Focused on document-boundary handling,
// since that's where a block mapping/sequence's own loop condition has to
// agree with the document splitter about where a document ends — a mapping
// at indent 0 sits at the same indentation "---" always has, so it's easy
// for the mapping parser to mistake the marker for a stray entry line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYamlDocuments } from '../src/parser';

test('a mapping document root ends cleanly at a following "---"', () => {
  const docs = parseYamlDocuments('name: first\n---\nname: second\n');
  assert.deepEqual(docs, [{ name: 'first' }, { name: 'second' }]);
});

test('a multi-key mapping document root ends cleanly at a following "---"', () => {
  const docs = parseYamlDocuments('a: 1\nb: 2\n---\nc: 3\n');
  assert.deepEqual(docs, [{ a: 1, b: 2 }, { c: 3 }]);
});

test('a mapping document root ends cleanly at an explicit "..." marker', () => {
  const docs = parseYamlDocuments('name: first\n...\n');
  assert.deepEqual(docs, [{ name: 'first' }]);
});

test('a sequence document root ends cleanly at a following "---"', () => {
  const docs = parseYamlDocuments('- one\n- two\n---\n- three\n');
  assert.deepEqual(docs, [['one', 'two'], ['three']]);
});

test('a nested mapping inside a document is unaffected by the fix', () => {
  const docs = parseYamlDocuments('outer:\n  a: 1\n  b: 2\n---\nouter:\n  c: 3\n');
  assert.deepEqual(docs, [{ outer: { a: 1, b: 2 } }, { outer: { c: 3 } }]);
});

test('a stream with no "---" markers is a single document', () => {
  const docs = parseYamlDocuments('name: only\n');
  assert.deepEqual(docs, [{ name: 'only' }]);
});

test('anchors are scoped per document and do not leak across "---"', () => {
  assert.throws(
    () => parseYamlDocuments('first: &a hello\n---\nsecond: *a\n'),
    /undefined alias "\*a"/,
  );
});

test('an anchor name can be reused across documents in one stream', () => {
  const docs = parseYamlDocuments('a: &x first\nb: *x\n---\na: &x second\nb: *x\n');
  assert.deepEqual(docs, [{ a: 'first', b: 'first' }, { a: 'second', b: 'second' }]);
});

test('a leading "---" before the first document is optional', () => {
  const docs = parseYamlDocuments('---\nname: first\n---\nname: second\n');
  assert.deepEqual(docs, [{ name: 'first' }, { name: 'second' }]);
});
