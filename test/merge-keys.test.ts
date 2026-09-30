import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '../src/parser';

test('a merge key copies the keys of an aliased mapping', () => {
  const v = parseYaml('base: &b\n  a: 1\n  b: 2\nchild:\n  <<: *b\n  c: 3\n');
  assert.deepEqual(v, { base: { a: 1, b: 2 }, child: { a: 1, b: 2, c: 3 } });
});

test('an explicit key overrides a merged one, whichever comes first', () => {
  const before = parseYaml('base: &b\n  a: 1\nchild:\n  a: 9\n  <<: *b\n');
  const after = parseYaml('base: &b\n  a: 1\nchild:\n  <<: *b\n  a: 9\n');
  assert.deepEqual((before as any).child, { a: 9 });
  assert.deepEqual((after as any).child, { a: 9 });
});

test('a sequence of aliases merges in order, earliest winning', () => {
  const v = parseYaml('x: &x\n  k: from-x\n  only_x: 1\ny: &y\n  k: from-y\n  only_y: 2\nz:\n  <<:\n    - *x\n    - *y\n');
  assert.deepEqual((v as any).z, { k: 'from-x', only_x: 1, only_y: 2 });
});

test('an inline flow mapping can be merged', () => {
  assert.deepEqual(parseYaml('<<: {a: 1}\nb: 2\n'), { a: 1, b: 2 });
});

test('a quoted "<<" is an ordinary key', () => {
  assert.deepEqual(parseYaml('"<<": 1\n'), { '<<': 1 });
});

test('merging a scalar is an error pointing at the key', () => {
  assert.throws(
    () => parseYaml('a: 1\n<<: 5\n'),
    /merge key "<<" needs a mapping or a sequence of mappings \(line 2, column 1\)/,
  );
});

test('merging a sequence that holds a non-mapping is an error', () => {
  assert.throws(() => parseYaml('<<:\n  - 1\n'), /merge key "<<" needs a mapping/);
});

test('a repeated merge key is reported as a duplicate key', () => {
  assert.throws(() => parseYaml('a: &a\n  x: 1\nb:\n  <<: *a\n  <<: *a\n'), /duplicate key "<<"/);
});
