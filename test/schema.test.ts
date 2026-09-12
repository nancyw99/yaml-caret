// Coverage for validateSchema: one test per schema kind, plus the path
// construction rules (dotted vs bracketed keys, array indices) since a
// wrong path is as misleading as a wrong error message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema, SchemaValidationError, type Schema } from '../src/schema';
import type { YamlValue } from '../src/parser';

function assertValid(value: YamlValue, schema: Schema): void {
  assert.doesNotThrow(() => validateSchema(value, schema));
}

function assertInvalid(value: YamlValue, schema: Schema, message: string, path = '$'): void {
  assert.throws(() => validateSchema(value, schema), (err: unknown) => {
    if (!(err instanceof SchemaValidationError)) return false;
    assert.equal(err.path, path);
    assert.equal(err.message, `${message} (at ${path})`);
    return true;
  });
}

test('string schema accepts strings and rejects everything else', () => {
  assertValid('hello', { type: 'string' });
  assertInvalid(42, { type: 'string' }, 'expected string, got number');
});

test('number schema accepts numbers and rejects strings', () => {
  assertValid(42, { type: 'number' });
  assertInvalid('42', { type: 'number' }, 'expected number, got string');
});

test('boolean schema accepts booleans and rejects null', () => {
  assertValid(true, { type: 'boolean' });
  assertInvalid(null, { type: 'boolean' }, 'expected boolean, got null');
});

test('null schema accepts only null', () => {
  assertValid(null, { type: 'null' });
  assertInvalid(false, { type: 'null' }, 'expected null, got boolean');
});

test('enum schema accepts listed values and reports all options on mismatch', () => {
  const schema: Schema = { type: 'enum', values: ['a', 'b', 1] };
  assertValid('a', schema);
  assertValid(1, schema);
  assertInvalid('c', schema, 'expected one of "a", "b", 1, got string');
});

test('union schema accepts any matching option and reports both on mismatch', () => {
  const schema: Schema = { type: 'union', options: [{ type: 'string' }, { type: 'number' }] };
  assertValid('a', schema);
  assertValid(1, schema);
  assertInvalid(true, schema, 'expected string or number, got boolean');
});

test('array schema validates every item and reports the failing index', () => {
  const schema: Schema = { type: 'array', items: { type: 'number' } };
  assertValid([1, 2, 3], schema);
  assertInvalid('nope', schema, 'expected array, got string');
  assertInvalid([1, 'two', 3], schema, 'expected number, got string', '$[1]');
});

test('object schema rejects arrays and null even though typeof array is "object"', () => {
  const schema: Schema = { type: 'object', properties: {} };
  assertInvalid([], schema, 'expected object, got array');
  assertInvalid(null, schema, 'expected object, got null');
});

test('object schema enforces required properties', () => {
  const schema: Schema = {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  };
  assertValid({ name: 'x' }, schema);
  assertInvalid({}, schema, 'missing required property "name"');
});

test('object schema validates known properties and ignores unknown ones by default', () => {
  const schema: Schema = {
    type: 'object',
    properties: { port: { type: 'number' } },
  };
  assertValid({ port: 8080, extra: 'ignored' }, schema);
  assertInvalid({ port: 'nope' }, schema, 'expected number, got string', '$.port');
});

test('object schema rejects unknown properties when additionalProperties is false', () => {
  const schema: Schema = {
    type: 'object',
    properties: { port: { type: 'number' } },
    additionalProperties: false,
  };
  assertValid({ port: 8080 }, schema);
  assertInvalid({ port: 8080, extra: 1 }, schema, 'unexpected property "extra"', '$.extra');
});

test('nested object properties build dotted paths', () => {
  const schema: Schema = {
    type: 'object',
    properties: {
      database: {
        type: 'object',
        properties: { port: { type: 'number' } },
      },
    },
  };
  assertInvalid({ database: { port: 'nope' } }, schema, 'expected number, got string', '$.database.port');
});

test('property keys that are not valid identifiers use bracket notation in the path', () => {
  const schema: Schema = {
    type: 'object',
    properties: { 'weird key': { type: 'number' } },
  };
  assertInvalid({ 'weird key': 'nope' }, schema, 'expected number, got string', '$["weird key"]');
});

test('array items combine with object paths for nested reporting', () => {
  const schema: Schema = {
    type: 'array',
    items: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
  };
  assertInvalid([{ name: 'ok' }, { name: 5 }], schema, 'expected string, got number', '$[1].name');
});
