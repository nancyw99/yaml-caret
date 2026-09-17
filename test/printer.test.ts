// Coverage for stringifyYaml: scalar formatting (including the quoting
// rules in needsQuoting, since those are what keep round-tripped output
// parseable), and block layout for nested mappings and sequences.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringifyYaml } from '../src/printer';
import { parseYaml } from '../src/parser';
import type { YamlValue } from '../src/parser';

test('scalars at the document root print on a single line', () => {
  assert.equal(stringifyYaml(null), 'null\n');
  assert.equal(stringifyYaml(true), 'true\n');
  assert.equal(stringifyYaml(false), 'false\n');
  assert.equal(stringifyYaml(42), '42\n');
  assert.equal(stringifyYaml(3.5), '3.5\n');
  assert.equal(stringifyYaml('hello'), 'hello\n');
});

test('empty collections print inline even at the document root', () => {
  assert.equal(stringifyYaml([]), '[]\n');
  assert.equal(stringifyYaml({}), '{}\n');
});

test('a non-finite number is rejected rather than printing an unparseable token', () => {
  assert.throws(() => stringifyYaml(Infinity), /non-finite/);
  assert.throws(() => stringifyYaml(NaN), /non-finite/);
});

test('strings that would be misread as another type get quoted', () => {
  assert.equal(stringifyYaml(''), '""\n');
  assert.equal(stringifyYaml('null'), '"null"\n');
  assert.equal(stringifyYaml('true'), '"true"\n');
  assert.equal(stringifyYaml('FALSE'), '"FALSE"\n');
  assert.equal(stringifyYaml('~'), '"~"\n');
  assert.equal(stringifyYaml('42'), '"42"\n');
  assert.equal(stringifyYaml('-3.5e2'), '"-3.5e2"\n');
});

test('strings with leading/trailing space or flow indicators get quoted', () => {
  assert.equal(stringifyYaml(' padded'), '" padded"\n');
  assert.equal(stringifyYaml('padded '), '"padded "\n');
  assert.equal(stringifyYaml('- item'), '"- item"\n');
  assert.equal(stringifyYaml('[a, b]'), '"[a, b]"\n');
  assert.equal(stringifyYaml('#tag'), '"#tag"\n');
  assert.equal(stringifyYaml('key: value'), '"key: value"\n');
  assert.equal(stringifyYaml('trailing:'), '"trailing:"\n');
  assert.equal(stringifyYaml('note # aside'), '"note # aside"\n');
});

test('ordinary strings print unquoted', () => {
  assert.equal(stringifyYaml('web-server'), 'web-server\n');
  assert.equal(stringifyYaml('v1.2.3-beta'), 'v1.2.3-beta\n');
});

test('special characters are escaped in double-quoted output', () => {
  assert.equal(stringifyYaml('line\nbreak'), '"line\\nbreak"\n');
  assert.equal(stringifyYaml('a\tb'), '"a\\tb"\n');
  assert.equal(stringifyYaml('a"b'), '"a\\"b"\n');
  assert.equal(stringifyYaml('a\\b'), '"a\\\\b"\n');
});

test('a flat mapping prints one "key: value" line per entry', () => {
  const value: YamlValue = { name: 'my-service', port: 8080, enabled: true };
  assert.equal(stringifyYaml(value), 'name: my-service\nport: 8080\nenabled: true\n');
});

test('a flat sequence prints one "- item" line per entry', () => {
  const value: YamlValue = ['web', 'internal', 3];
  assert.equal(stringifyYaml(value), '- web\n- internal\n- 3\n');
});

test('a nested mapping value is indented on its own block', () => {
  const value: YamlValue = { database: { host: 'localhost', port: 5432 } };
  assert.equal(stringifyYaml(value), 'database:\n  host: localhost\n  port: 5432\n');
});

test('a sequence of mappings keeps each item\'s first key on the dash line', () => {
  const value: YamlValue = [
    { name: 'a', port: 1 },
    { name: 'b', port: 2 },
  ];
  assert.equal(stringifyYaml(value), '- name: a\n  port: 1\n- name: b\n  port: 2\n');
});

test('a mapping of sequences indents the items under the key', () => {
  const value: YamlValue = { tags: ['web', 'internal'] };
  assert.equal(stringifyYaml(value), 'tags:\n  - web\n  - internal\n');
});

test('empty nested collections print inline rather than as an indented block', () => {
  const value: YamlValue = { tags: [], meta: {} };
  assert.equal(stringifyYaml(value), 'tags: []\nmeta: {}\n');
});

test('a key that would be misread as another type gets quoted like any other string', () => {
  // Integer-like keys enumerate before others regardless of insertion order,
  // a JS object quirk rather than anything printer.ts controls.
  const value: YamlValue = { 'true': 1, '123': 'x' };
  assert.equal(stringifyYaml(value), '"123": x\n"true": 1\n');
});

test('stringifyYaml output parses back to an equal value', () => {
  const value: YamlValue = {
    name: 'my-service',
    port: 8080,
    tags: ['web', 'internal', ''],
    database: { host: 'localhost', port: 5432, replicas: [] },
    note: 'says "hi"\nand bye',
  };
  assert.deepEqual(parseYaml(stringifyYaml(value)), value);
});
