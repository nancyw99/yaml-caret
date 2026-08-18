// Turns a YamlValue back into block-style YAML text. The output is meant
// to be a clean, canonical rendering, not a byte-for-byte round trip of
// whatever formatting the source happened to use.

import type { YamlValue } from './parser';

const INDENT = 2;

const RESERVED_WORDS = new Set(['null', 'Null', 'NULL', '~', 'true', 'True', 'TRUE', 'false', 'False', 'FALSE']);
const NUMBER_LIKE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const LEADING_SPECIAL_CHARS = "-?:,[]{}#&*!|>'\"%@`";

function pad(n: number): string {
  return ' '.repeat(n);
}

function isContainer(value: YamlValue): boolean {
  return value !== null && typeof value === 'object';
}

function isEmpty(value: YamlValue): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function needsQuoting(value: string): boolean {
  if (value === '') return true;
  if (RESERVED_WORDS.has(value)) return true;
  if (NUMBER_LIKE.test(value)) return true;
  if (/^\s|\s$/.test(value)) return true;
  if (/[\n\t]/.test(value)) return true;
  if (LEADING_SPECIAL_CHARS.includes(value[0])) return true;
  if (value.includes(': ') || value.endsWith(':') || value.includes(' #')) return true;
  return false;
}

function quoteDouble(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case '"':
        out += '\\"';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\r':
        out += '\\r';
        break;
      default:
        out += ch;
    }
  }
  return out + '"';
}

function formatString(value: string): string {
  return needsQuoting(value) ? quoteDouble(value) : value;
}

// Renders a value that stands alone on one line: a scalar, or an empty
// collection (which YAML writes inline as [] / {}).
function formatInline(value: YamlValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot represent non-finite number (${value}) in YAML`);
    }
    return String(value);
  }
  if (typeof value === 'string') return formatString(value);
  return Array.isArray(value) ? '[]' : '{}';
}

function renderBlock(value: YamlValue, indent: number): string[] {
  if (Array.isArray(value)) return renderSequence(value, indent);
  return renderMapping(value as Record<string, YamlValue>, indent);
}

function renderSequence(items: YamlValue[], indent: number): string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (isContainer(item) && !isEmpty(item)) {
      const child = renderBlock(item, indent + INDENT);
      lines.push(pad(indent) + '- ' + child[0].slice(indent + INDENT));
      lines.push(...child.slice(1));
    } else {
      lines.push(pad(indent) + '- ' + formatInline(item));
    }
  }
  return lines;
}

function renderMapping(obj: Record<string, YamlValue>, indent: number): string[] {
  const lines: string[] = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const keyText = formatString(key);
    if (isContainer(value) && !isEmpty(value)) {
      lines.push(pad(indent) + keyText + ':');
      lines.push(...renderBlock(value, indent + INDENT));
    } else {
      lines.push(pad(indent) + keyText + ': ' + formatInline(value));
    }
  }
  return lines;
}

export function stringifyYaml(value: YamlValue): string {
  if (isContainer(value) && !isEmpty(value)) {
    return renderBlock(value, 0).join('\n') + '\n';
  }
  return formatInline(value) + '\n';
}
