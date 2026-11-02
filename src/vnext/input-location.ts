import type { ContentFragment, CursorData } from "../../vendor/orca";
import type { InsertionBookmark } from "./repository";
import { footnoteTrigger } from "./settings";

export interface SymbolStart {
  readonly panelId: string;
  readonly rootBlockId: number;
  readonly blockId: number;
  readonly index: number;
  readonly offset: number;
  readonly symbol: string;
}
const pointEqual = (a: CursorData["anchor"], b: CursorData["focus"]) => a.blockId === b.blockId && a.index === b.index && a.offset === b.offset && a.isInline === b.isInline;
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const triggerAllowed = (value: unknown): value is string => typeof value === "string" && value !== "" && footnoteTrigger(value) === value;
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

/** Observe a normal native input AFTER insertion. Never preventDefault, change a
 * DOM selection, or write text here. An unmatched/changed caret leaves literal
 * input entirely with the native editor. UTF-16 offsets match CursorData. */
export function symbolStart(cursor: CursorData, symbol: string): SymbolStart | undefined {
  if (!triggerAllowed(symbol) || cursor.mirror || !pointEqual(cursor.anchor, cursor.focus)
    || cursor.anchor.isInline !== true || !Number.isSafeInteger(cursor.anchor.blockId) || cursor.anchor.blockId <= 0
    || !Number.isSafeInteger(cursor.rootBlockId) || cursor.rootBlockId <= 0 || !cursor.panelId
    || !integer(cursor.anchor.index) || !integer(cursor.anchor.offset) || cursor.anchor.offset < symbol.length) return;
  return { panelId: cursor.panelId, rootBlockId: cursor.rootBlockId, blockId: cursor.anchor.blockId,
    index: cursor.anchor.index, offset: cursor.anchor.offset - symbol.length, symbol };
}

/** A source snapshot must catch up to ALL native input before opening the UI.
 * Only one exact text-fragment range can ever become a replacement bookmark.
 * A later native selection, new paragraph, mirror or source switch is not ours. */
export function resolveSymbol(start: SymbolStart, cursor: CursorData, content: readonly ContentFragment[], observedText: string): { text: string; bookmark: InsertionBookmark } | undefined {
  if (!triggerAllowed(start.symbol) || !integer(start.index) || !integer(cursor.anchor.index)
    || cursor.mirror || cursor.anchor.isInline !== true || cursor.panelId !== start.panelId || cursor.rootBlockId !== start.rootBlockId
    || cursor.anchor.blockId !== start.blockId || cursor.anchor.index !== start.index || !pointEqual(cursor.anchor, cursor.focus)) return;
  const fragment = content[start.index], end = cursor.anchor.offset;
  if (!fragment || fragment.t !== "t" || typeof fragment.v !== "string" || typeof observedText !== "string" || observedText !== fragment.v
    || !integer(start.offset) || !integer(end)
    || end < start.offset + start.symbol.length || end > fragment.v.length || end - start.offset > 50_000
    || fragment.v.slice(start.offset, start.offset + start.symbol.length) !== start.symbol) return;
  const expected = fragment.v.slice(start.offset, end);
  return { text: expected.slice(start.symbol.length), bookmark: { cursor: copy(cursor), content: copy([...content]),
    replacement: { index: start.index, start: start.offset, end, expected, trigger: start.symbol } } };
}

/** Construct a native selection over ONLY our still-exact observed literal.
 * Ordinary bookmarks remain collapsed: a user's unrelated selected text must
 * never be replaced by adding an annotation. Actual writes stay native commands. */
export function inputInsertionCursor(bookmark: InsertionBookmark, collapse: (cursor: CursorData) => CursorData): CursorData {
  const cursor = collapse(bookmark.cursor), range = bookmark.replacement;
  if (!range) return cursor;
  const fragment = bookmark.content[range.index];
  if (bookmark.cursor.mirror || bookmark.cursor.anchor.isInline !== true || !pointEqual(bookmark.cursor.anchor, bookmark.cursor.focus)
    || !integer(range.index) || !integer(range.start) || !integer(range.end) || range.end <= range.start
    || range.index !== bookmark.cursor.anchor.index || range.end !== bookmark.cursor.anchor.offset
    || !triggerAllowed(range.trigger)
    || typeof range.expected !== "string" || !range.expected.startsWith(range.trigger)
    || range.expected.length !== range.end - range.start || range.expected.length > 50_000
    || fragment?.t !== "t" || typeof fragment.v !== "string" || fragment.v.slice(range.start, range.end) !== range.expected) {
    throw new Error("尾注输入位置已变化，未替换正文。");
  }
  return { ...cursor, isForward: true, anchor: { ...cursor.anchor, offset: range.start }, focus: { ...cursor.anchor, offset: range.end } };
}

/** Native range insertion leaves the inserted fragment selected. Read the
 * resulting native cursor instead of guessing r's length/index/isInline. Only
 * its forward end in the same physical source may be collapsed; no new command
 * or content edit is involved. At EOF native legitimately uses isInline=false. */
export function inputResultCursor(bookmark: InsertionBookmark, actual: CursorData | null | undefined): CursorData | undefined {
  const insertedAt = bookmark.cursor.isForward ? bookmark.cursor.focus : bookmark.cursor.anchor;
  if (!actual || actual.mirror || typeof actual.isForward !== "boolean" || typeof actual.anchor.isInline !== "boolean" || typeof actual.focus.isInline !== "boolean"
    || actual.panelId !== bookmark.cursor.panelId || actual.rootBlockId !== bookmark.cursor.rootBlockId
    || actual.anchor.blockId !== insertedAt.blockId || actual.focus.blockId !== insertedAt.blockId
    || !integer(actual.anchor.index) || !integer(actual.anchor.offset) || !integer(actual.focus.index) || !integer(actual.focus.offset)) return;
  const end = actual.isForward ? actual.focus : actual.anchor;
  return { ...actual, isForward: true, anchor: end, focus: end };
}
