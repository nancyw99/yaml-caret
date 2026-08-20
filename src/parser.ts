// A block-style YAML parser (mappings, sequences, scalars, comments) with
// error messages that point at the exact line and column that went wrong.
//
// Deliberately out of scope for now: flow collections ([a, b], {k: v}),
// anchors/aliases, and multi-document streams beyond a single leading
// "---". Those are real YAML features that a lot of config files never
// touch; better to get the common 90% right with good diagnostics than
// to half-support everything.

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
  tabColumn: number | null; // 1-based column of a leading tab, if any; checked lazily so tabs
  // inside block scalar content (read straight from rawLines, never through this struct) are fine
}

function splitLines(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

function checkNoTab(line: SourceLine): void {
  if (line.tabColumn !== null) {
    throw new YamlParseError('tab characters are not allowed for indentation', line.number, line.tabColumn, line.raw);
  }
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
  const rawLines = splitLines(source);
  const lines: SourceLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const number = i + 1;
    const stripped = stripComment(raw);
    let indent = 0;
    let tabColumn: number | null = null;
    while (indent < stripped.length && (stripped[indent] === ' ' || stripped[indent] === '\t')) {
      if (stripped[indent] === '\t' && tabColumn === null) {
        tabColumn = indent + 1;
      }
      indent++;
    }
    const content = stripped.slice(indent).replace(/\s+$/, '');
    if (content.length === 0) continue; // blank or comment-only line
    lines.push({ number, raw, indent, content, tabColumn });
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

// Header of a block scalar introducer such as "|", ">-", "|2+".
interface BlockScalarHeader {
  style: '|' | '>';
  chomping: 'clip' | 'strip' | 'keep';
  indent: number | null; // explicit indentation indicator, relative to the parent indent
}

function parseBlockScalarHeader(text: string): BlockScalarHeader | null {
  const m = /^([|>])([+\-0-9]{0,2})$/.exec(text);
  if (!m) return null;
  const style = m[1] as '|' | '>';
  let chomping: 'clip' | 'strip' | 'keep' = 'clip';
  let indent: number | null = null;
  for (const ch of m[2]) {
    if (ch === '-' || ch === '+') {
      if (chomping !== 'clip') return null; // chomping indicator given twice
      chomping = ch === '-' ? 'strip' : 'keep';
    } else {
      if (indent !== null) return null; // indentation indicator given twice
      indent = parseInt(ch, 10);
      if (indent === 0) return null; // "0" is not a valid indentation indicator
    }
  }
  return { style, chomping, indent };
}

// Reads a block scalar's raw lines directly from the source (not the filtered
// SourceLine list, since blank lines inside the scalar are significant and were
// already dropped by toSourceLines). Returns the decoded string and the line
// number of the last raw line consumed, so the caller can resume from there.
function parseBlockScalar(
  rawLines: string[],
  headerLineNumber: number,
  parentIndent: number,
  header: BlockScalarHeader,
): { text: string; lastLine: number } {
  let determinedIndent = header.indent !== null ? parentIndent + header.indent : null;
  const entries: { text: string; blank: boolean; moreIndented: boolean }[] = [];
  let lastLine = headerLineNumber;
  let cursor = headerLineNumber; // rawLines is 0-based, so this already points past the header line

  while (cursor < rawLines.length) {
    const raw = rawLines[cursor];
    if (/^[ \t]*$/.test(raw)) {
      entries.push({ text: '', blank: true, moreIndented: false });
      lastLine = cursor + 1;
      cursor++;
      continue;
    }
    let lineIndent = 0;
    while (lineIndent < raw.length && raw[lineIndent] === ' ') lineIndent++;
    if (determinedIndent === null) {
      if (lineIndent <= parentIndent) break;
      determinedIndent = lineIndent;
    } else if (lineIndent < determinedIndent) {
      break;
    }
    entries.push({ text: raw.slice(determinedIndent), blank: false, moreIndented: lineIndent > determinedIndent });
    lastLine = cursor + 1;
    cursor++;
  }

  const n = entries.length;
  let body: string;
  if (header.style === '|') {
    body = entries.map((e) => e.text).join('\n');
  } else {
    let out = '';
    for (let i = 0; i < n; i++) {
      out += entries[i].text;
      if (i === n - 1) break;
      const cur = entries[i];
      const next = entries[i + 1];
      out += cur.blank || next.blank || cur.moreIndented || next.moreIndented ? '\n' : ' ';
    }
    body = out;
  }

  const trimmed = body.replace(/\n+$/, '');
  let text: string;
  if (header.chomping === 'strip') text = trimmed;
  else if (header.chomping === 'keep') text = n > 0 ? body + '\n' : '';
  else text = n > 0 ? trimmed + '\n' : '';

  return { text, lastLine };
}

// Advances past every filtered line that belongs to a raw line range already
// consumed elsewhere (block scalar content), landing on the first line after it.
function findLineIndexAfter(lines: SourceLine[], fromPos: number, rawLineNumber: number): number {
  let i = fromPos;
  while (i < lines.length && lines[i].number <= rawLineNumber) i++;
  return i;
}

function parseNode(lines: SourceLine[], pos: number, rawLines: string[]): [YamlValue, number] {
  const indent = lines[pos].indent;
  return parseNodeAt(lines, pos, indent, rawLines);
}

function parseNodeAt(lines: SourceLine[], pos: number, indent: number, rawLines: string[]): [YamlValue, number] {
  const line = lines[pos];
  checkNoTab(line);
  if (isSeqMarker(line.content)) {
    return parseSequence(lines, pos, indent, rawLines);
  }
  if (findTopLevelColon(line.content) !== -1) {
    return parseMapping(lines, pos, indent, rawLines);
  }
  if (line.content[0] === '|' || line.content[0] === '>') {
    const header = parseBlockScalarHeader(line.content);
    if (!header) {
      throw new YamlParseError(`invalid block scalar header "${line.content}"`, line.number, line.indent + 1, line.raw);
    }
    const block = parseBlockScalar(rawLines, line.number, indent, header);
    return [block.text, findLineIndexAfter(lines, pos + 1, block.lastLine)];
  }
  const value = parseScalarText(line.content, line.number, line.indent + 1, line.raw);
  return [value, pos + 1];
}

function parseSequence(
  lines: SourceLine[],
  pos: number,
  indent: number,
  rawLines: string[],
): [YamlValue[], number] {
  const result: YamlValue[] = [];
  while (pos < lines.length && lines[pos].indent === indent && isSeqMarker(lines[pos].content)) {
    const line = lines[pos];
    checkNoTab(line);
    const rest = line.content.slice(1);
    const restTrimmed = rest.replace(/^ +/, '');
    const leadingSpaces = rest.length - restTrimmed.length;
    const itemColumn = line.indent + 2 + leadingSpaces;

    if (restTrimmed.length === 0) {
      pos++;
      if (pos < lines.length && lines[pos].indent > indent) {
        const [value, next] = parseNode(lines, pos, rawLines);
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
        tabColumn: null,
      };
      const withSynthetic = lines.slice();
      withSynthetic[pos] = synthetic;
      const [value, next] = parseMapping(withSynthetic, pos, synthetic.indent, rawLines);
      result.push(value);
      pos = next;
    } else if (restTrimmed[0] === '|' || restTrimmed[0] === '>') {
      const header = parseBlockScalarHeader(restTrimmed);
      if (!header) {
        throw new YamlParseError(`invalid block scalar header "${restTrimmed}"`, line.number, itemColumn, line.raw);
      }
      const block = parseBlockScalar(rawLines, line.number, indent, header);
      result.push(block.text);
      pos = findLineIndexAfter(lines, pos + 1, block.lastLine);
    } else {
      const value = parseScalarText(restTrimmed, line.number, itemColumn, line.raw);
      result.push(value);
      pos++;
    }
  }
  return [result, pos];
}

function parseMapping(
  lines: SourceLine[],
  pos: number,
  indent: number,
  rawLines: string[],
): [Record<string, YamlValue>, number] {
  const result: Record<string, YamlValue> = {};
  const keyLocations = new Map<string, { line: number; column: number; raw: string }>();

  while (pos < lines.length && lines[pos].indent === indent && !isSeqMarker(lines[pos].content)) {
    const line = lines[pos];
    checkNoTab(line);
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
        const [value, next] = parseNode(lines, pos, rawLines);
        result[key] = value;
        pos = next;
      } else {
        result[key] = null;
      }
      continue;
    }

    const valueText = afterColon.slice(valueOffset).replace(/\s+$/, '');
    const valueColumn = line.indent + colonIdx + 2 + valueOffset;

    if (valueText[0] === '|' || valueText[0] === '>') {
      const header = parseBlockScalarHeader(valueText);
      if (!header) {
        throw new YamlParseError(`invalid block scalar header "${valueText}"`, line.number, valueColumn, line.raw);
      }
      const block = parseBlockScalar(rawLines, line.number, indent, header);
      result[key] = block.text;
      pos = findLineIndexAfter(lines, pos + 1, block.lastLine);
      continue;
    }

    result[key] = parseScalarText(valueText, line.number, valueColumn, line.raw);
    pos++;
  }

  return [result, pos];
}

export function parseYaml(source: string): YamlValue {
  const lines = toSourceLines(source);
  const rawLines = splitLines(source);
  let pos = 0;

  if (pos < lines.length && lines[pos].content === '---') {
    pos++;
  }
  if (pos >= lines.length || lines[pos].content === '...') {
    return null;
  }

  const [value, next] = parseNode(lines, pos, rawLines);
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
