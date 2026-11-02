import type { ContentFragment } from '../vendor/orca';

export const REF_TYPE = 'orca-footnotes.md-ref';
export const DEF_TYPE = 'orca-footnotes.md-def';

/** Offsets are half-open JavaScript (UTF-16) offsets into sourceText(content). */
export interface ReferenceToken {
  label: string;
  start: number;
  end: number;
  raw: string;
}

/** A definition owns the entire block, including its indentation and newlines. */
export interface DefinitionToken extends ReferenceToken {
  text: string;
}

export interface ParsedContent {
  text: string;
  references: ReferenceToken[];
  definition?: DefinitionToken;
  issues: string[];
}

export interface TextRangeEdit {
  start: number;
  end: number;
  expected: string;
  text: string;
  type?: string;
}

interface Span {
  fragment: ContentFragment;
  start: number;
  end: number;
  editable: boolean;
}

interface Line {
  start: number;
  contentEnd: number;
  end: number;
}

interface DefinitionHeader {
  label: string;
  colon: number;
  prefix: string;
  container: boolean;
}

const WHITESPACE = /[\s\p{White_Space}]/u;
const BLANK = /^[\s\p{White_Space}]*$/u;

function isTextFragment(fragment: ContentFragment): boolean {
  return typeof fragment.v === 'string'
    && (fragment.t === 't' || fragment.t === REF_TYPE || fragment.t === DEF_TYPE);
}

function projection(content: ContentFragment[]): { text: string; spans: Span[] } {
  const parts: string[] = [];
  const spans: Span[] = [];
  let offset = 0;
  for (const fragment of content) {
    const textual = isTextFragment(fragment);
    const value = textual ? fragment.v as string : '\uFFFC';
    parts.push(value);
    spans.push({
      fragment,
      start: offset,
      end: offset + value.length,
      // Treat formatting identically before/after enhanced types are stripped.
      editable: textual && !(typeof fragment.f === 'string' && fragment.f.split('+').includes('c')),
    });
    offset += value.length;
  }
  return { text: parts.join(''), spans };
}

/** Private metadata is deliberately irrelevant; unknown/non-string fragments are opaque. */
export function sourceText(content: ContentFragment[]): string {
  return projection(content).text;
}

/** Labels are case-sensitive; the length limit counts Unicode code points, not UTF-16 units. */
export function isValidLabel(label: string): boolean {
  if (typeof label !== 'string' || label.length === 0) return false;
  let length = 0;
  for (const character of label) {
    if (++length > 128 || WHITESPACE.test(character)
      || character === '[' || character === ']' || character === '\\' || character === ':') return false;
  }
  return true;
}

/** Keep original LF/CRLF/CR sequences, including a final empty line. */
function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '\n' && text[cursor] !== '\r') {
      cursor++;
      continue;
    }
    const contentEnd = cursor;
    cursor += text[cursor] === '\r' && text[cursor + 1] === '\n' ? 2 : 1;
    lines.push({ start, contentEnd, end: cursor });
    start = cursor;
  }
  lines.push({ start, contentEnd: text.length, end: text.length });
  return lines;
}

/** One separator space, then exactly four added spaces on every continuation (even blank ones). */
export function formatDefinition(label: string, text: string): string {
  if (!isValidLabel(label)) throw new TypeError('Invalid footnote label');
  if (typeof text !== 'string') throw new TypeError('Definition text must be a string');
  return linesOf(text).map((line, index) =>
    (index === 0 ? `[^${label}]: ` : '    ')
      + text.slice(line.start, line.contentEnd)
      + text.slice(line.contentEnd, line.end),
  ).join('');
}

function available(mask: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (!mask[i]) return false;
  return true;
}

function escaped(text: string, position: number, mask: Uint8Array): boolean {
  let count = 0;
  for (let i = position - 1; i >= 0 && mask[i] && text[i] === '\\'; i--) count++;
  return count % 2 === 1;
}

/** Only fenced code is a block-code syntax here; indented code requires the caller's codeBlock flag. */
function fenceMask(text: string, lines: Line[], mask: Uint8Array): Uint8Array {
  const fenced = new Uint8Array(text.length);
  let open: { marker: string; length: number } | undefined;
  for (const line of lines) {
    let start = line.start;
    while (start < line.contentEnd && text[start] === ' ') start++;
    const marker = text[start];
    let end = start;
    if (marker === '`' || marker === '~') {
      while (end < line.contentEnd && text[end] === marker) end++;
    }
    const length = end - start;
    const markerAllowed = start - line.start <= 3 && length >= 3 && available(mask, line.start, end);
    const rest = text.slice(end, line.contentEnd);
    if (open) {
      fenced.fill(1, line.start, line.end);
      if (markerAllowed && marker === open.marker && length >= open.length && /^[ \t]*$/u.test(rest)) {
        open = undefined;
      }
    } else if (markerAllowed && (marker === '~' || !rest.includes('`'))) {
      open = { marker, length };
      fenced.fill(1, line.start, line.end);
    }
  }
  return fenced;
}

function horizontalWhitespace(text: string, start: number, end: number): number {
  while (start < end && WHITESPACE.test(text[start])) start++;
  return start;
}

/** Recognize unsupported indentation/containers as suspicious, not as body references. */
function definitionHeader(text: string, line: Line, mask: Uint8Array): DefinitionHeader | undefined {
  let start = horizontalWhitespace(text, line.start, line.contentEnd);
  let container = false;
  while (start < line.contentEnd) {
    let next = start;
    if (text[start] === '>') next++;
    else if ('-+*'.includes(text[start]) && /[ \t]/u.test(text[start + 1] ?? '')) next++;
    else {
      const list = /^(?:[0-9]{1,9})[.)][ \t]/u.exec(text.slice(start, line.contentEnd));
      if (list) next += list[0].length;
    }
    if (next === start) break;
    container = true;
    start = horizontalWhitespace(text, next, line.contentEnd);
  }
  if (text[start] !== '[' || text[start + 1] !== '^' || !available(mask, start, start + 2)) return undefined;
  const close = text.indexOf(']', start + 2);
  if (close < 0 || close >= line.contentEnd || text[close + 1] !== ':') return undefined;
  return { label: text.slice(start + 2, close), colon: close + 1, prefix: text.slice(line.start, start), container };
}

function parseDefinition(
  text: string, lines: Line[], lineIndex: number, header: DefinitionHeader, spans: Span[],
): ParsedContent {
  const issues: string[] = [];
  if (lineIndex !== 0) issues.push('Footnote definition must occupy the whole block, starting on its first line.');
  if (header.container || !/^ {0,3}$/u.test(header.prefix)) {
    issues.push('Unsupported footnote definition indentation or list/quote container (at most three spaces are allowed).');
  }
  if (!isValidLabel(header.label)) issues.push('Invalid label in suspected footnote definition.');
  if (spans.some(span => !span.editable)) {
    issues.push('Footnote definition must contain only text fragments without code formatting or opaque fragments.');
  }
  if (issues.length) return { text, references: [], issues };

  let first = header.colon + 1;
  // Remove exactly one syntax separator, not user-authored leading/trailing whitespace.
  if (text[first] === ' ' || text[first] === '\t') first++;
  let body = text.slice(first, lines[0].contentEnd) + text.slice(lines[0].contentEnd, lines[0].end);
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    const value = text.slice(line.start, line.contentEnd);
    let unindented: string;
    if (value.startsWith('    ')) unindented = value.slice(4);
    else if (value.startsWith('\t')) unindented = value.slice(1);
    else if (BLANK.test(value)) unindented = value;
    else {
      issues.push(`Unsupported footnote definition continuation at line ${index + 1}: use four spaces or a tab.`);
      continue;
    }
    body += unindented + text.slice(line.contentEnd, line.end);
  }
  if (issues.length) return { text, references: [], issues };
  return {
    text,
    references: [],
    definition: { label: header.label, start: 0, end: text.length, raw: text, text: body },
    issues,
  };
}

function referenceAt(text: string, start: number, mask: Uint8Array): ReferenceToken | undefined {
  if (text[start] !== '[' || text[start + 1] !== '^' || !available(mask, start, start + 2)) return undefined;
  // A valid 128-code-point label occupies at most 256 UTF-16 units.
  for (let end = start + 2; end < text.length && end - start - 2 <= 256 && mask[end]; end++) {
    const character = text[end];
    if (character === ']') {
      const label = text.slice(start + 2, end);
      return isValidLabel(label) ? { label, start, end: end + 1, raw: text.slice(start, end + 1) } : undefined;
    }
    if (WHITESPACE.test(character) || character === '[' || character === '\\' || character === ':') return undefined;
  }
  return undefined;
}

function backtickRun(text: string, start: number, mask: Uint8Array): number {
  let end = start;
  while (end < text.length && mask[end] && text[end] === '`') end++;
  return end - start;
}

function codeSpanEnd(
  text: string, start: number, length: number, mask: Uint8Array, fenced: Uint8Array, lineStarts: Map<number, Line>,
): number | undefined {
  for (let cursor = start + length; cursor < text.length;) {
    if (fenced[cursor]) return undefined;
    const line = lineStarts.get(cursor);
    if (line && /^[ \t]*$/u.test(text.slice(line.start, line.contentEnd))) return undefined;
    if (mask[cursor] && text[cursor] === '`') {
      const run = backtickRun(text, cursor, mask);
      // Backslashes inside a code span are literal; only run length closes it.
      if (run === length) return cursor + run;
      cursor += run;
    } else cursor++;
  }
  return undefined;
}

/** Parse literal source, never enhanced metadata, document-wide numbering, or HTML. */
export function parseContent(content: ContentFragment[], options?: { codeBlock?: boolean }): ParsedContent {
  const { text, spans } = projection(content);
  const result: ParsedContent = { text, references: [], issues: [] };
  if (options?.codeBlock || text.length === 0) return result;

  const mask = new Uint8Array(text.length);
  for (const span of spans) if (span.editable) mask.fill(1, span.start, span.end);
  const lines = linesOf(text);
  const lineStarts = new Map(lines.map(line => [line.start, line]));
  const lineIndexes = new Map(lines.map((line, index) => [line.start, index]));
  const fenced = fenceMask(text, lines, mask);
  for (let i = 0; i < mask.length; i++) if (fenced[i]) mask[i] = 0;

  for (let cursor = 0; cursor < text.length;) {
    const line = lineStarts.get(cursor);
    if (line) {
      const header = definitionHeader(text, line, mask);
      if (header) return parseDefinition(text, lines, lineIndexes.get(cursor)!, header, spans);
    }
    if (!mask[cursor]) {
      cursor++;
      continue;
    }
    if (text[cursor] === '[' && !escaped(text, cursor, mask)) {
      const token = referenceAt(text, cursor, mask);
      if (token) {
        result.references.push(token);
        cursor = token.end;
        continue;
      }
    }
    if (text[cursor] === '`' && !escaped(text, cursor, mask)) {
      const length = backtickRun(text, cursor, mask);
      cursor = codeSpanEnd(text, cursor, length, mask, fenced, lineStarts) ?? cursor + length;
    } else cursor++;
  }
  return result;
}

/**
 * Apply exact, original-coordinate edits without flattening rich text.
 * Zero-width insertions may occur inside editable text or at any fragment boundary, including [] at 0.
 * Markdown code syntax is the parser's responsibility; this function guards fragment types/f:c.
 * Boundary insertions are allowed; multiple insertions at the same offset retain input order.
 */
export function replaceTextRanges(content: ContentFragment[], edits: Array<TextRangeEdit>): ContentFragment[] {
  const { text, spans } = projection(content);
  for (const edit of edits) {
    if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end)
      || edit.start < 0 || edit.end < edit.start || edit.end > text.length) {
      throw new RangeError('Text edit is out of bounds or has invalid offsets');
    }
    if (typeof edit.expected !== 'string' || text.slice(edit.start, edit.end) !== edit.expected) {
      throw new Error('Text edit expected source does not match');
    }
    if (typeof edit.text !== 'string') throw new TypeError('Replacement text must be a string');
    if (edit.type !== undefined && edit.type !== 't' && edit.type !== REF_TYPE && edit.type !== DEF_TYPE) {
      throw new TypeError('Unsupported replacement fragment type');
    }
    if (edit.start === edit.end) {
      if (spans.some(span => !span.editable && span.start < edit.start && edit.start < span.end)) {
        throw new Error('Insertion is inside opaque content or code formatting');
      }
    } else if (spans.some(span => span.start < edit.end && span.end > edit.start && !span.editable)) {
      throw new Error('Text edit crosses opaque content or code formatting');
    }
  }
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start < ordered[i - 1].end) {
      throw new Error('Text edits overlap (an insertion may touch a range boundary, but not its interior)');
    }
  }
  if (ordered.length === 0) return content.slice();

  const output: ContentFragment[] = [];
  let spanIndex = 0;
  let cursor = 0;
  const consume = (target: number, keep: boolean): void => {
    while (spanIndex < spans.length) {
      const span = spans[spanIndex];
      if (span.start === span.end) {
        if (span.start > target) break;
        // Empty original fragments carry no replaced characters; preserve their attributes too.
        output.push(span.fragment);
        spanIndex++;
        continue;
      }
      if (cursor >= target) break;
      const end = Math.min(target, span.end);
      if (keep) {
        output.push(cursor === span.start && end === span.end
          ? span.fragment
          : { ...span.fragment, v: (span.fragment.v as string).slice(cursor - span.start, end - span.start) });
      }
      cursor = end;
      if (cursor === span.end) spanIndex++;
    }
  };
  for (const edit of ordered) {
    consume(edit.start, true);
    if (edit.text !== '') output.push({ t: edit.type ?? 't', v: edit.text });
    consume(edit.end, false);
  }
  consume(text.length, true);
  return output;
}
