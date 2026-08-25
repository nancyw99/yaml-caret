// A block-style YAML parser (mappings, sequences, scalars, comments) with
// error messages that point at the exact line and column that went wrong.
// Flow collections ([a, b], {k: v}) are supported inline within otherwise
// block-style documents, but must fit on a single line.
//
// Anchors (&name) and aliases (*name) are supported for whole nodes: a
// mapping value, a sequence item, or the document root. An anchor written
// immediately before an inline "- key: value" sequence shorthand is also
// handled. Not supported: anchors on mapping keys, merge keys ("<<"), and
// aliases inside flow collections.
//
// Deliberately out of scope for now: multi-document streams beyond a
// single leading "---". That's a real YAML feature that a lot of config
// files never touch; better to get the common 90% right with good
// diagnostics than to half-support everything.

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
  let depth = 0; // bracket nesting, so a ':' inside a flow collection isn't mistaken for a mapping
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
    if (c === '[' || c === '{') {
      depth++;
      continue;
    }
    if (c === ']' || c === '}') {
      if (depth > 0) depth--;
      continue;
    }
    if (c === ':' && depth === 0 && (i === content.length - 1 || content[i + 1] === ' ')) {
      return i;
    }
  }
  return -1;
}

// Reads a double-quoted scalar starting at text[start] (which must be '"'),
// stopping at the matching close quote rather than requiring it to be the
// last character in `text` — so the same reader works for a standalone
// scalar and for one embedded inside a flow collection followed by more
// content. `column` is the source column of text[0].
function readDoubleQuoted(
  text: string,
  start: number,
  line: number,
  column: number,
  raw: string,
): { value: string; end: number } {
  let result = '';
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      return { value: result, end: i + 1 };
    }
    if (c === '\\') {
      const next = text[i + 1];
      switch (next) {
        case 'n':
          result += '\n';
          i += 2;
          break;
        case 't':
          result += '\t';
          i += 2;
          break;
        case 'r':
          result += '\r';
          i += 2;
          break;
        case '"':
          result += '"';
          i += 2;
          break;
        case '\\':
          result += '\\';
          i += 2;
          break;
        case '0':
          result += '\0';
          i += 2;
          break;
        case 'u': {
          const hex = text.slice(i + 2, i + 6);
          if (hex.length < 4 || /[^0-9a-fA-F]/.test(hex)) {
            throw new YamlParseError('invalid \\u escape sequence', line, column + i, raw);
          }
          result += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          break;
        }
        default:
          throw new YamlParseError(`unknown escape sequence "\\${next ?? ''}"`, line, column + i, raw);
      }
      continue;
    }
    result += c;
    i++;
  }
  throw new YamlParseError('unterminated double-quoted string', line, column + start, raw);
}

// Same idea as readDoubleQuoted, for single-quoted scalars ('' is the
// escape for a literal quote).
function readSingleQuoted(
  text: string,
  start: number,
  line: number,
  column: number,
  raw: string,
): { value: string; end: number } {
  let result = '';
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      if (text[i + 1] === "'") {
        result += "'";
        i += 2;
        continue;
      }
      return { value: result, end: i + 1 };
    }
    result += c;
    i++;
  }
  throw new YamlParseError('unterminated single-quoted string', line, column + start, raw);
}

function parseDoubleQuoted(text: string, line: number, column: number, raw: string): string {
  const { value, end } = readDoubleQuoted(text, 0, line, column, raw);
  const rest = text.slice(end).trim();
  if (rest.length > 0) {
    throw new YamlParseError(`unexpected characters after closing quote: "${rest}"`, line, column + end - 1, raw);
  }
  return value;
}

function parseSingleQuoted(text: string, line: number, column: number, raw: string): string {
  const { value, end } = readSingleQuoted(text, 0, line, column, raw);
  const rest = text.slice(end).trim();
  if (rest.length > 0) {
    throw new YamlParseError(`unexpected characters after closing quote: "${rest}"`, line, column + end - 1, raw);
  }
  return value;
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

// A flow collection ([a, b] or {k: v}) is parsed on a single line with its
// own cursor, independent of the block indentation rules. `pos` is an index
// into `text`; `column` is the source column of text[0].
interface FlowCursor {
  text: string;
  pos: number;
}

function skipFlowSpace(cursor: FlowCursor): void {
  while (cursor.pos < cursor.text.length && cursor.text[cursor.pos] === ' ') cursor.pos++;
}

// Reads a run of plain (unquoted) flow text, stopping before any flow
// indicator: ',', '[', ']', '{', '}', or a ':' that looks like a mapping
// separator (followed by space, a delimiter, or end of text).
function readFlowPlainSpan(cursor: FlowCursor): string {
  const start = cursor.pos;
  const text = cursor.text;
  while (cursor.pos < text.length) {
    const c = text[cursor.pos];
    if (c === ',' || c === '[' || c === ']' || c === '{' || c === '}') break;
    if (c === ':') {
      const next = text[cursor.pos + 1];
      if (next === undefined || next === ' ' || next === ',' || next === ']' || next === '}') break;
    }
    cursor.pos++;
  }
  return text.slice(start, cursor.pos).replace(/\s+$/, '');
}

function parseFlowPlainScalar(cursor: FlowCursor, line: number, column: number, raw: string): YamlValue {
  const startPos = cursor.pos;
  const text = readFlowPlainSpan(cursor);
  if (text.length === 0) {
    throw new YamlParseError('expected a value', line, column + startPos, raw);
  }
  return parsePlainScalar(text);
}

// Flow mapping keys keep their literal text when unquoted, matching how
// block mapping keys are handled: only a quoted key goes through scalar
// type coercion.
function readFlowKeyText(cursor: FlowCursor, line: number, column: number, raw: string): string {
  const c = cursor.text[cursor.pos];
  if (c === '"') return readDoubleQuoted(cursor.text, cursor.pos, line, column, raw).value;
  if (c === "'") return readSingleQuoted(cursor.text, cursor.pos, line, column, raw).value;
  const startPos = cursor.pos;
  const text = readFlowPlainSpan(cursor);
  if (text.length === 0) {
    throw new YamlParseError('expected a mapping key', line, column + startPos, raw);
  }
  return text;
}

function parseFlowNode(cursor: FlowCursor, line: number, column: number, raw: string): YamlValue {
  skipFlowSpace(cursor);
  const c = cursor.text[cursor.pos];
  if (c === '[') return parseFlowSequence(cursor, line, column, raw);
  if (c === '{') return parseFlowMapping(cursor, line, column, raw);
  if (c === '"') {
    const { value, end } = readDoubleQuoted(cursor.text, cursor.pos, line, column, raw);
    cursor.pos = end;
    return value;
  }
  if (c === "'") {
    const { value, end } = readSingleQuoted(cursor.text, cursor.pos, line, column, raw);
    cursor.pos = end;
    return value;
  }
  return parseFlowPlainScalar(cursor, line, column, raw);
}

function parseFlowSequence(cursor: FlowCursor, line: number, column: number, raw: string): YamlValue[] {
  cursor.pos++; // consume '['
  const result: YamlValue[] = [];
  skipFlowSpace(cursor);
  if (cursor.text[cursor.pos] === ']') {
    cursor.pos++;
    return result;
  }
  while (true) {
    result.push(parseFlowNode(cursor, line, column, raw));
    skipFlowSpace(cursor);
    const c = cursor.text[cursor.pos];
    if (c === ',') {
      cursor.pos++;
      skipFlowSpace(cursor);
      if (cursor.text[cursor.pos] === ']') {
        cursor.pos++;
        return result;
      }
      continue;
    }
    if (c === ']') {
      cursor.pos++;
      return result;
    }
    if (c === undefined) {
      throw new YamlParseError('unterminated flow sequence, expected "]"', line, column + cursor.pos, raw);
    }
    throw new YamlParseError('expected "," or "]" in flow sequence', line, column + cursor.pos, raw);
  }
}

function parseFlowMapping(cursor: FlowCursor, line: number, column: number, raw: string): Record<string, YamlValue> {
  cursor.pos++; // consume '{'
  const result: Record<string, YamlValue> = {};
  const keyLocations = new Map<string, { line: number; column: number; raw: string }>();
  skipFlowSpace(cursor);
  if (cursor.text[cursor.pos] === '}') {
    cursor.pos++;
    return result;
  }
  while (true) {
    skipFlowSpace(cursor);
    const keyColumn = column + cursor.pos;
    const key = readFlowKeyText(cursor, line, column, raw);
    skipFlowSpace(cursor);

    let value: YamlValue = null;
    if (cursor.text[cursor.pos] === ':') {
      const next = cursor.text[cursor.pos + 1];
      if (next === undefined || next === ' ' || next === ',' || next === '}' || next === ']') {
        cursor.pos++;
        skipFlowSpace(cursor);
        value = parseFlowNode(cursor, line, column, raw);
      }
    }

    const existing = keyLocations.get(key);
    if (existing) {
      throw new YamlParseError(`duplicate key "${key}"`, line, keyColumn, raw, {
        message: 'note: first defined here',
        line: existing.line,
        column: existing.column,
        raw: existing.raw,
      });
    }
    keyLocations.set(key, { line, column: keyColumn, raw });
    result[key] = value;

    skipFlowSpace(cursor);
    const sep = cursor.text[cursor.pos];
    if (sep === ',') {
      cursor.pos++;
      skipFlowSpace(cursor);
      if (cursor.text[cursor.pos] === '}') {
        cursor.pos++;
        return result;
      }
      continue;
    }
    if (sep === '}') {
      cursor.pos++;
      return result;
    }
    if (sep === undefined) {
      throw new YamlParseError('unterminated flow mapping, expected "}"', line, column + cursor.pos, raw);
    }
    throw new YamlParseError('expected "," or "}" in flow mapping', line, column + cursor.pos, raw);
  }
}

function parseFlowRoot(text: string, line: number, column: number, raw: string): YamlValue {
  const cursor: FlowCursor = { text, pos: 0 };
  const value = parseFlowNode(cursor, line, column, raw);
  skipFlowSpace(cursor);
  if (cursor.pos < text.length) {
    throw new YamlParseError(
      `unexpected characters after flow collection: "${text.slice(cursor.pos)}"`,
      line,
      column + cursor.pos,
      raw,
    );
  }
  return value;
}

// Resolves a value's source text to a YamlValue, dispatching to the flow
// collection parser when the text opens with a flow indicator.
function parseValueText(text: string, line: number, column: number, raw: string): YamlValue {
  if (text[0] === '[' || text[0] === '{') {
    return parseFlowRoot(text, line, column, raw);
  }
  return parseScalarText(text, line, column, raw);
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

// An anchor or alias name: anything but whitespace and flow indicators.
const ANCHOR_NAME = '[^\\s,\\[\\]{}]+';
const ALIAS_RE = new RegExp(`^\\*(${ANCHOR_NAME})$`);
const ANCHOR_RE = new RegExp(`^&(${ANCHOR_NAME})(?:\\s+(.*))?$`);

function parseNode(
  lines: SourceLine[],
  pos: number,
  rawLines: string[],
  anchors: Map<string, YamlValue>,
): [YamlValue, number] {
  const indent = lines[pos].indent;
  return parseNodeAt(lines, pos, indent, rawLines, anchors);
}

function parseNodeAt(
  lines: SourceLine[],
  pos: number,
  indent: number,
  rawLines: string[],
  anchors: Map<string, YamlValue>,
): [YamlValue, number] {
  const line = lines[pos];
  checkNoTab(line);

  const aliasMatch = ALIAS_RE.exec(line.content);
  if (aliasMatch) {
    return [resolveAlias(aliasMatch[1], line.number, line.indent + 1, line.raw, anchors), pos + 1];
  }

  const anchorMatch = ANCHOR_RE.exec(line.content);
  if (anchorMatch) {
    const anchorName = anchorMatch[1];
    const rest = anchorMatch[2];
    let value: YamlValue;
    let next: number;
    if (rest === undefined) {
      if (pos + 1 < lines.length && lines[pos + 1].indent > indent) {
        [value, next] = parseNode(lines, pos + 1, rawLines, anchors);
      } else {
        value = null;
        next = pos + 1;
      }
    } else {
      const restColumn = line.indent + 1 + (line.content.length - rest.length);
      const synthetic: SourceLine = {
        number: line.number,
        raw: line.raw,
        indent: restColumn - 1,
        content: rest,
        tabColumn: null,
      };
      const withSynthetic = lines.slice();
      withSynthetic[pos] = synthetic;
      [value, next] = parseNodeAt(withSynthetic, pos, restColumn - 1, rawLines, anchors);
    }
    anchors.set(anchorName, value);
    return [value, next];
  }

  if (isSeqMarker(line.content)) {
    return parseSequence(lines, pos, indent, rawLines, anchors);
  }
  if (findTopLevelColon(line.content) !== -1) {
    return parseMapping(lines, pos, indent, rawLines, anchors);
  }
  if (line.content[0] === '|' || line.content[0] === '>') {
    const header = parseBlockScalarHeader(line.content);
    if (!header) {
      throw new YamlParseError(`invalid block scalar header "${line.content}"`, line.number, line.indent + 1, line.raw);
    }
    const block = parseBlockScalar(rawLines, line.number, indent, header);
    return [block.text, findLineIndexAfter(lines, pos + 1, block.lastLine)];
  }
  const value = parseValueText(line.content, line.number, line.indent + 1, line.raw);
  return [value, pos + 1];
}

function resolveAlias(
  name: string,
  line: number,
  column: number,
  raw: string,
  anchors: Map<string, YamlValue>,
): YamlValue {
  if (!anchors.has(name)) {
    throw new YamlParseError(`undefined alias "*${name}"`, line, column, raw);
  }
  return anchors.get(name)!;
}

// Parses value text that stands to the right of a mapping ":" or that has
// already had a sequence "- " and any anchor prefix stripped off: an
// anchor/alias, a block scalar header, or a plain/flow scalar. Unlike
// parseNodeAt, this never re-enters block mapping/sequence parsing, since
// text following ":" or "- " on the same line can't itself open a nested
// block collection.
function parseValueNode(
  lines: SourceLine[],
  pos: number,
  line: SourceLine,
  text: string,
  column: number,
  indent: number,
  rawLines: string[],
  anchors: Map<string, YamlValue>,
): [YamlValue, number] {
  const aliasMatch = ALIAS_RE.exec(text);
  if (aliasMatch) {
    return [resolveAlias(aliasMatch[1], line.number, column, line.raw, anchors), pos + 1];
  }

  const anchorMatch = ANCHOR_RE.exec(text);
  if (anchorMatch) {
    const anchorName = anchorMatch[1];
    const rest = anchorMatch[2];
    let value: YamlValue;
    let next: number;
    if (rest === undefined) {
      if (pos + 1 < lines.length && lines[pos + 1].indent > indent) {
        [value, next] = parseNode(lines, pos + 1, rawLines, anchors);
      } else {
        value = null;
        next = pos + 1;
      }
    } else {
      const restColumn = column + (text.length - rest.length);
      [value, next] = parseValueNode(lines, pos, line, rest, restColumn, indent, rawLines, anchors);
    }
    anchors.set(anchorName, value);
    return [value, next];
  }

  if (text[0] === '|' || text[0] === '>') {
    const header = parseBlockScalarHeader(text);
    if (!header) {
      throw new YamlParseError(`invalid block scalar header "${text}"`, line.number, column, line.raw);
    }
    const block = parseBlockScalar(rawLines, line.number, indent, header);
    return [block.text, findLineIndexAfter(lines, pos + 1, block.lastLine)];
  }

  return [parseValueText(text, line.number, column, line.raw), pos + 1];
}

function parseSequence(
  lines: SourceLine[],
  pos: number,
  indent: number,
  rawLines: string[],
  anchors: Map<string, YamlValue>,
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
        const [value, next] = parseNode(lines, pos, rawLines, anchors);
        result.push(value);
        pos = next;
      } else {
        result.push(null);
      }
      continue;
    }

    const [value, next] = parseSequenceItem(lines, pos, line, restTrimmed, itemColumn, indent, rawLines, anchors);
    result.push(value);
    pos = next;
  }
  return [result, pos];
}

// Parses the text of a non-empty sequence item (after "- " and leading
// spaces). Handles an anchor/alias prefix, then the "- key: value" inline
// mapping shorthand, then falls back to a plain value node.
function parseSequenceItem(
  lines: SourceLine[],
  pos: number,
  line: SourceLine,
  text: string,
  column: number,
  indent: number,
  rawLines: string[],
  anchors: Map<string, YamlValue>,
): [YamlValue, number] {
  const aliasMatch = ALIAS_RE.exec(text);
  if (aliasMatch) {
    return [resolveAlias(aliasMatch[1], line.number, column, line.raw, anchors), pos + 1];
  }

  const anchorMatch = ANCHOR_RE.exec(text);
  if (anchorMatch) {
    const anchorName = anchorMatch[1];
    const rest = anchorMatch[2];
    let value: YamlValue;
    let next: number;
    if (rest === undefined) {
      if (pos + 1 < lines.length && lines[pos + 1].indent > indent) {
        [value, next] = parseNode(lines, pos + 1, rawLines, anchors);
      } else {
        value = null;
        next = pos + 1;
      }
    } else {
      const restColumn = column + (text.length - rest.length);
      [value, next] = parseSequenceItem(lines, pos, line, rest, restColumn, indent, rawLines, anchors);
    }
    anchors.set(anchorName, value);
    return [value, next];
  }

  if (findTopLevelColon(text) !== -1) {
    // "- key: value" — the mapping's first entry is inline with the dash;
    // later entries are ordinary lines indented to line up under it.
    const synthetic: SourceLine = {
      number: line.number,
      raw: line.raw,
      indent: column - 1,
      content: text,
      tabColumn: null,
    };
    const withSynthetic = lines.slice();
    withSynthetic[pos] = synthetic;
    return parseMapping(withSynthetic, pos, synthetic.indent, rawLines, anchors);
  }

  return parseValueNode(lines, pos, line, text, column, indent, rawLines, anchors);
}

function parseMapping(
  lines: SourceLine[],
  pos: number,
  indent: number,
  rawLines: string[],
  anchors: Map<string, YamlValue>,
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
        const [value, next] = parseNode(lines, pos, rawLines, anchors);
        result[key] = value;
        pos = next;
      } else {
        result[key] = null;
      }
      continue;
    }

    const valueText = afterColon.slice(valueOffset).replace(/\s+$/, '');
    const valueColumn = line.indent + colonIdx + 2 + valueOffset;
    const [value, next] = parseValueNode(lines, pos, line, valueText, valueColumn, indent, rawLines, anchors);
    result[key] = value;
    pos = next;
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

  const anchors = new Map<string, YamlValue>();
  const [value, next] = parseNode(lines, pos, rawLines, anchors);
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
