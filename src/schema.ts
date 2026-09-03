// Structural validation on top of a parsed YamlValue. This checks shape
// (types, required properties, enums) after parsing, not syntax — a
// YamlParseError means the text wasn't YAML; a SchemaValidationError means
// it was YAML but not the shape the caller expected.
//
// There's no line/column here: by the time a YamlValue exists, the parser
// has already thrown away source positions. Errors instead carry a path
// like "$.database.port" pointing at the offending value within the
// document.

import type { YamlValue } from './parser';

export type Schema =
  | { type: 'string' }
  | { type: 'number' }
  | { type: 'boolean' }
  | { type: 'null' }
  | { type: 'array'; items: Schema }
  | {
      type: 'object';
      properties: Record<string, Schema>;
      required?: string[];
      additionalProperties?: boolean;
    }
  | { type: 'enum'; values: readonly (string | number | boolean | null)[] }
  | { type: 'union'; options: readonly Schema[] };

export class SchemaValidationError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path})`);
    this.name = 'SchemaValidationError';
    this.path = path;
  }
}

function typeName(value: YamlValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value; // 'string' | 'number' | 'boolean' | 'object'
}

function describe(schema: Schema): string {
  switch (schema.type) {
    case 'enum':
      return `one of ${schema.values.map((v) => JSON.stringify(v)).join(', ')}`;
    case 'union':
      return schema.options.map(describe).join(' or ');
    default:
      return schema.type;
  }
}

function mismatch(schema: Schema, value: YamlValue, path: string): SchemaValidationError {
  return new SchemaValidationError(`expected ${describe(schema)}, got ${typeName(value)}`, path);
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

export function validateSchema(value: YamlValue, schema: Schema, path = '$'): void {
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') throw mismatch(schema, value, path);
      return;
    case 'number':
      if (typeof value !== 'number') throw mismatch(schema, value, path);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') throw mismatch(schema, value, path);
      return;
    case 'null':
      if (value !== null) throw mismatch(schema, value, path);
      return;
    case 'enum':
      if (!schema.values.includes(value as string | number | boolean | null)) throw mismatch(schema, value, path);
      return;
    case 'union': {
      for (const option of schema.options) {
        try {
          validateSchema(value, option, path);
          return;
        } catch (err) {
          if (!(err instanceof SchemaValidationError)) throw err;
        }
      }
      throw mismatch(schema, value, path);
    }
    case 'array': {
      if (!Array.isArray(value)) throw mismatch(schema, value, path);
      for (let i = 0; i < value.length; i++) {
        validateSchema(value[i], schema.items, `${path}[${i}]`);
      }
      return;
    }
    case 'object': {
      if (value === null || Array.isArray(value) || typeof value !== 'object') {
        throw mismatch(schema, value, path);
      }
      const obj = value as Record<string, YamlValue>;
      for (const key of schema.required ?? []) {
        if (!(key in obj)) {
          throw new SchemaValidationError(`missing required property "${key}"`, path);
        }
      }
      for (const key of Object.keys(schema.properties)) {
        if (key in obj) {
          validateSchema(obj[key], schema.properties[key], childPath(path, key));
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in schema.properties)) {
            throw new SchemaValidationError(`unexpected property "${key}"`, childPath(path, key));
          }
        }
      }
      return;
    }
  }
}
