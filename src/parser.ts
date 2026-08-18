// A block-style YAML parser (mappings, sequences, scalars, comments) with
// error messages that point at the exact line and column that went wrong.
//
// Deliberately out of scope for now: flow collections ([a, b], {k: v}),
// anchors/aliases, block scalars (| and >), and multi-document streams
// beyond a single leading "---". Those are real YAML features that a lot
// of config files never touch; better to get the common 90% right with
// good diagnostics than to half-support everything.

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };

export interface YamlErrorNote {
  message: string;
  line: number;
  column: number;
  raw: string;
}

export class YamlParseError extends Error {
  readonly line: number;
  readonly column: number;
  readonly sourceLine: string;

  constructor(message: string, line: number, column: number, sourceLine: string, note?: YamlErrorNote) {
    super(YamlParseError.render(message, line, column, sourceLine, note));
    this.name = 'YamlParseError';
    this.line = line;
    this.column = column;
    this.sourceLine = sourceLine;
  }

  private static renderBlock(message: string, line: number, column: number, sourceLine: string): string {
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

  private static render(message: string, line: number, column: number, sourceLine: string, note?: YamlErrorNote): string {
    let out = YamlParseError.renderBlock(message, line, column, sourceLine);
    if (note) {
      out += '\n' + YamlParseError.renderBlock(note.message, note.line, note.column, note.raw);
    }
    return out;
  }
}

interface SourceLine {
  number: number; // 1-based line number in the original source
  raw: string; // the original full line, kept for error display
  indent: number; // count of leading spaces
  content: string; // text after indentation, trailing comment stripped, right-trimmed
}

// Removes a trailing "# comment" from a line without being fooled by
// '#' characters that appear inside quoted scalars.
function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inSingle) {
      if (c === "'") {
        if (raw[i + 1] === "'") {
          i++;
          continue;
        }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === '#' && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function toSourceLines(source: string): SourceLine[] {
  const rawLines = source.split(/\r\n|\r|\n/);
  const lines: SourceLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const number = i + 1;
    const stripped = stripComment(raw);
    let indent = 0;
    while (indent < stripped.length && (stripped[indent] === ' ' || stripped[indent] === '\t')) {
      if (stripped[indent] === '\t') {
        throw new YamlParseError('tab characters are not allowed for indentation', number, indent + 1, raw);
      }
      indent++;
    }
    const content = stripped.slice(indent).replace(/\s+$/, '');
    if (content.length === 0) continue; // blank or comment-only line
    lines.push({ number, raw, indent, content });
  }
  return lines;
}

function isSeqMarker(content: string): boolean {
  return content === '-' || content.startsWith('- ');
}

// Finds the ':' that separates a mapping key from its value: the first
// unquoted colon followed by a space or end of line.
function findTopLevelColon(content: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inSingle) {
      if (c === "'") {
        if (content[i + 1] === "'") {
          i++;
          continue;
        }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === ':' && (i === content.length - 1 || content[i + 1] === ' ')) {
      return i;
    }
  }
  return -1;
}

function parseDoubleQuoted(text: string, line: number, column: number, raw: string): string {
  let result = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const rest = text.slice(i + 1).trim();
      if (rest.length > 0) {
        throw new YamlParseError(`unexpected characters after closing quote: "${rest}"`, line, column + i, raw);
      }
      return result;
    }
    if (c === '\\') {
      const next = text[i + 1];
      switch (next) {
        case 'n':
          result += '\n';
          i++;
          break;
        case 't':
          result += '\t';
          i++;
          break;
        case 'r':
          result += '\r';
          i++;
          break;
        case '"':
          result += '"';
          i++;
          break;
        case '\\':
          result += '\\';
          i++;
          break;
        case '0':
          result += '\0';
          i++;
          break;
        case 'u': {
          const hex = text.slice(i + 2, i + 6);
          if (hex.length < 4 || /[^0-9a-fA-F]/.test(hex)) {
            throw new YamlParseError('invalid \\u escape sequence', line, column + i, raw);
          }
          result += String.fromCharCode(parseInt(hex, 16));
          i += 5;
          break;
        }
        default:
          throw new YamlParseError(`unknown escape sequence "\\${next ?? ''}"`, line, column + i, raw);
      }
      continue;
    }
    result += c;
  }
  throw new YamlParseError('unterminated double-quoted string', line, column, raw);
}

function parseSingleQuoted(text: string, line: number, column: number, raw: string): string {
  let result = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      if (text[i + 1] === "'") {
        result += "'";
        i++;
        continue;
      }
      const rest = text.slice(i + 1).trim();
      if (rest.length > 0) {
        throw new YamlParseError(`unexpected characters after closing quote: "${rest}"`, line, column + i, raw);
      }
      return result;
    }
    result += c;
  }
  throw new YamlParseError('unterminated single-quoted string', line, column, raw);
}

function parsePlainScalar(text: string): YamlValue {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '~' || trimmed === 'null' || trimmed === 'Null' || trimmed === 'NULL') {
    return null;
  }
  if (trimmed === 'true' || trimmed === 'True' || trimmed === 'TRUE') return true;
  if (trimmed === 'false' || trimmed === 'False' || trimmed === 'FALSE') return false;
  if (/^[-+]?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed)) return parseFloat(trimmed);
  return trimmed;
}

function parseScalarText(text: string, line: number, column: number, raw: string): YamlValue {
  if (text.length === 0) return null;
  if (text[0] === '"') return parseDoubleQuoted(text, line, column, raw);
  if (text[0] === "'") return parseSingleQuoted(text, line, column, raw);
  return parsePlainScalar(text);
}

function parseNode(lines: SourceLine[], pos: number): [YamlValue, number] {
  const indent = lines[pos].indent;
  return parseNodeAt(lines, pos, indent);
}

function parseNodeAt(lines: SourceLine[], pos: number, indent: number): [YamlValue, number] {
  const line = lines[pos];
  if (isSeqMarker(line.content)) {
    return parseSequence(lines, pos, indent);
  }
  if (findTopLevelColon(line.content) !== -1) {
    return parseMapping(lines, pos, indent);
  }
  const value = parseScalarText(line.content, line.number, line.indent + 1, line.raw);
  return [value, pos + 1];
}

function parseSequence(lines: SourceLine[], pos: number, indent: number): [YamlValue[], number] {
  const result: YamlValue[] = [];
  while (pos < lines.length && lines[pos].indent === indent && isSeqMarker(lines[pos].content)) {
    const line = lines[pos];
    const rest = line.content.slice(1);
    const restTrimmed = rest.replace(/^ +/, '');
    const leadingSpaces = rest.length - restTrimmed.length;
    const itemColumn = line.indent + 2 + leadingSpaces;

    if (restTrimmed.length === 0) {
      pos++;
      if (pos < lines.length && lines[pos].indent > indent) {
        const [value, next] = parseNode(lines, pos);
        result.push(value);
        pos = next;
      } else {
        result.push(null);
      }
      continue;
    }

    if (findTopLevelColon(restTrimmed) !== -1) {
      // "- key: value" — the mapping's first entry is inline with the dash;
      // later entries are ordinary lines indented to line up under it.
      const synthetic: SourceLine = {
        number: line.number,
        raw: line.raw,
        indent: itemColumn - 1,
        content: restTrimmed,
      };
      const withSynthetic = lines.slice();
      withSynthetic[pos] = synthetic;
      const [value, next] = parseMapping(withSynthetic, pos, synthetic.indent);
      result.push(value);
      pos = next;
    } else {
      const value = parseScalarText(restTrimmed, line.number, itemColumn, line.raw);
      result.push(value);
      pos++;
    }
  }
  return [result, pos];
}

function parseMapping(lines: SourceLine[], pos: number, indent: number): [Record<string, YamlValue>, number] {
  const result: Record<string, YamlValue> = {};
  const keyLocations = new Map<string, { line: number; column: number; raw: string }>();

  while (pos < lines.length && lines[pos].indent === indent && !isSeqMarker(lines[pos].content)) {
    const line = lines[pos];
    const colonIdx = findTopLevelColon(line.content);
    if (colonIdx === -1) {
      throw new YamlParseError('expected "key: value"', line.number, line.indent + 1, line.raw);
    }

    const rawKey = line.content.slice(0, colonIdx);
    const keyOffset = rawKey.search(/\S/);
    if (keyOffset === -1) {
      throw new YamlParseError('missing mapping key before ":"', line.number, line.indent + colonIdx + 1, line.raw);
    }
    const keyText = rawKey.trim();
    const keyColumn = line.indent + 1 + keyOffset;
    const key =
      keyText[0] === '"' || keyText[0] === "'"
        ? String(parseScalarText(keyText, line.number, keyColumn, line.raw))
        : keyText;

    const existing = keyLocations.get(key);
    if (existing) {
      throw new YamlParseError(`duplicate key "${key}"`, line.number, keyColumn, line.raw, {
        message: 'note: first defined here',
        line: existing.line,
        column: existing.column,
        raw: existing.raw,
      });
    }
    keyLocations.set(key, { line: line.number, column: keyColumn, raw: line.raw });

    const afterColon = line.content.slice(colonIdx + 1);
    const valueOffset = afterColon.search(/\S/);

    if (valueOffset === -1) {
      pos++;
      if (pos < lines.length && lines[pos].indent > indent) {
        const [value, next] = parseNode(lines, pos);
        result[key] = value;
        pos = next;
      } else {
        result[key] = null;
      }
      continue;
    }

    const valueText = afterColon.slice(valueOffset).replace(/\s+$/, '');
    const valueColumn = line.indent + colonIdx + 2 + valueOffset;
    result[key] = parseScalarText(valueText, line.number, valueColumn, line.raw);
    pos++;
  }

  return [result, pos];
}

export function parseYaml(source: string): YamlValue {
  const lines = toSourceLines(source);
  let pos = 0;

  if (pos < lines.length && lines[pos].content === '---') {
    pos++;
  }
  if (pos >= lines.length || lines[pos].content === '...') {
    return null;
  }

  const [value, next] = parseNode(lines, pos);
  let end = next;
  if (end < lines.length && lines[end].content === '...') {
    end++;
  }

  if (end < lines.length) {
    const line = lines[end];
    throw new YamlParseError(
      `unexpected indentation: expected this line to align with column ${lines[pos].indent + 1}`,
      line.number,
      line.indent + 1,
      line.raw,
    );
  }

  return value;
}
