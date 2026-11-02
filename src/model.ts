import type { Block, ContentFragment, CursorData, CursorNodeData, DbId } from "../vendor/orca";
import {
  DEF_TYPE, REF_TYPE, formatDefinition, parseContent, sourceText,
  type ReferenceToken, type DefinitionToken,
} from "./markdown";
export { DEF_TYPE, REF_TYPE, formatDefinition, parseContent, sourceText } from "./markdown";

export const LEGACY_NOTE_TYPE = "orca-footnotes.note";
export const LEGACY_LIST_TYPE = "orca-footnotes.list";
export const MAX_BLOCKS = 20_000;
export const MAX_NOTE_LENGTH = 50_000;
export type ReadBlock = ((id: DbId) => Promise<Block | undefined>) & { prefetch?: (ids: DbId[]) => Promise<void> };
export interface NoteReference extends ReferenceToken { blockId: DbId; number: number }
export interface NoteDefinition extends DefinitionToken { blockId: DbId; number?: number; refCount: number }
export interface NoteEntry {
  label: string;
  number: number;
  references: NoteReference[];
  definition?: NoteDefinition;
  problem?: string;
}
export interface NoteIndex {
  rootId: DbId;
  blocks: Block[];
  references: NoteReference[];
  definitions: NoteDefinition[];
  entries: NoteEntry[];
  issues: string[];
  legacyCount: number;
}
export interface NoteTarget {
  rootId: DbId;
  label: string;
  definition: NoteDefinition;
  definitionContent: ContentFragment[];
  reference?: NoteReference;
  referenceContent?: ContentFragment[];
}
export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function reprType(block: Block): string | undefined {
  return block.properties?.find((p) => p.name === "_repr")?.value?.type;
}
export function validateNote(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new Error("注释不能为空。删除引用请使用“删除此处引用”。");
  if (normalized.length > MAX_NOTE_LENGTH) throw new Error(`注释不能超过 ${MAX_NOTE_LENGTH} 字符。`);
  return normalized;
}
export function referenceFragment(label: string, enhanced = false): ContentFragment {
  return { t: enhanced ? REF_TYPE : "t", v: `[^${label}]` };
}
export function definitionFragment(label: string, text: string, enhanced = false): ContentFragment {
  return { t: enhanced ? DEF_TYPE : "t", v: formatDefinition(label, validateNote(text)) };
}
export function plainFragments(content: ContentFragment[]): ContentFragment[] {
  return content.map((f) => f.t === REF_TYPE || f.t === DEF_TYPE ? { ...clone(f), t: "t" } : clone(f));
}
export async function findRoot(startId: DbId, read: ReadBlock): Promise<Block> {
  const seen = new Set<DbId>();
  let id = startId;
  while (true) {
    if (seen.has(id)) throw new Error("笔记的父子关系存在循环，已停止编号。");
    if (seen.size >= MAX_BLOCKS) throw new Error("笔记层级超过安全上限。");
    seen.add(id);
    const b = await read(id);
    if (!b) throw new Error(`无法读取块 ${id}，暂不显示不完整编号。`);
    if (b.parent == null) return b;
    id = b.parent;
  }
}
export async function collectIndex(rootId: DbId, read: ReadBlock): Promise<NoteIndex> {
  const blocks: Block[] = [], issues: string[] = [];
  const refs: NoteReference[] = [], definitions: NoteDefinition[] = [];
  const numbers = new Map<string, number>();
  const seen = new Set<DbId>();
  const stack: Array<{ id: DbId; parent?: DbId }> = [{ id: rootId }];
  let legacyCount = 0;
  while (stack.length) {
    const { id, parent } = stack.pop()!;
    if (seen.has(id)) throw new Error("笔记包含循环或重复子块，已停止编号。");
    if (seen.size >= MAX_BLOCKS) throw new Error(`笔记超过 ${MAX_BLOCKS} 块，已停止自动编号。`);
    seen.add(id);
    const b = await read(id);
    if (!b) throw new Error(`无法读取块 ${id}，请稍后刷新。`);
    if (parent != null && b.parent !== parent) throw new Error("段落正在移动，请稍后重试。");
    blocks.push(b);
    legacyCount += (b.content ?? []).filter((f) => f.t === LEGACY_NOTE_TYPE).length;
    const parsed = parseContent(b.content ?? [], { codeBlock: reprType(b) === "code" });
    issues.push(...parsed.issues.map((message) => `块 ${id}：${message}`));
    if (parsed.definition) definitions.push({ ...parsed.definition, blockId: id, refCount: 0 });
    for (const ref of parsed.references) {
      if (!numbers.has(ref.label)) numbers.set(ref.label, numbers.size + 1);
      refs.push({ ...ref, blockId: id, number: numbers.get(ref.label)! });
    }
    await read.prefetch?.(b.children);
    for (let i = b.children.length - 1; i >= 0; i--) stack.push({ id: b.children[i], parent: id });
  }
  const byLabel = new Map<string, NoteDefinition[]>();
  for (const def of definitions) {
    const list = byLabel.get(def.label) ?? [];
    list.push(def); byLabel.set(def.label, list);
    def.number = numbers.get(def.label);
    def.refCount = refs.filter((ref) => ref.label === def.label).length;
  }
  for (const [label, defs] of byLabel) if (defs.length > 1) issues.push(`[^${label}] 有 ${defs.length} 个定义，拒绝猜测或覆盖。`);
  const entries: NoteEntry[] = [...numbers].map(([label, number]) => {
    const defs = byLabel.get(label) ?? [];
    const problem = defs.length === 0 ? `[^${label}] 缺少注释定义。` : defs.length > 1 ? `[^${label}] 定义冲突。` : undefined;
    if (defs.length === 0) issues.push(problem!);
    return { label, number, references: refs.filter((ref) => ref.label === label), definition: defs.length === 1 ? defs[0] : undefined, problem };
  });
  if (legacyCount) issues.push(`含 ${legacyCount} 处 0.1 旧脚注；请先执行“迁移本篇旧版脚注”。`);
  return { rootId, blocks, references: refs, definitions, entries, issues, legacyCount };
}
export function nextLabel(index: NoteIndex): string {
  const reserved = new Set([...index.references, ...index.definitions].map((item) => item.label));
  let n = 1;
  while (reserved.has(String(n))) n++;
  return String(n);
}
export function assertPlainDefinition(block: Block): void {
  const simple = (block.content ?? []).every((f) => ["t", DEF_TYPE].includes(f.t) && typeof f.v === "string" &&
    Object.keys(f).every((key) => key === "t" || key === "v" ||
      (key === "f" && !f.f) || (key === "fa" && (!f.fa || Object.keys(f.fa).length === 0))));
  if (!simple) throw new Error("尾注定义含宿主富文本格式或额外属性，请直接编辑原文；插件不会丢弃这些格式来美化或重写。");
}
export function assertEditableIndex(index: NoteIndex): void {
  if (index.issues.length) throw new Error(index.issues.join("\n"));
}
export function captureTarget(index: NoteIndex, label: string, reference?: NoteReference): NoteTarget {
  const defs = index.definitions.filter((d) => d.label === label);
  if (defs.length !== 1) throw new Error(defs.length ? "脚注定义冲突，请先修正原文。" : "缺少脚注定义，请先补齐原文。");
  const def = defs[0];
  return {
    rootId: index.rootId, label, definition: clone(def), definitionContent: clone(index.blocks.find((b) => b.id === def.blockId)!.content ?? []),
    reference: reference && clone(reference),
    referenceContent: reference && clone(index.blocks.find((b) => b.id === reference.blockId)!.content ?? []),
  };
}
export function checkTarget(index: NoteIndex, target: NoteTarget): NoteDefinition {
  if (index.rootId !== target.rootId) throw new Error("尾注所在笔记已改变，请重新打开确认，未继续写入。");
  const defs = index.definitions.filter((d) => d.label === target.label);
  if (defs.length !== 1 || defs[0].blockId !== target.definition.blockId || defs[0].raw !== target.definition.raw) {
    throw new Error("注释定义已改变、删除或出现重复，请重新打开，避免覆盖新内容。");
  }
  const current = index.blocks.find((b) => b.id === defs[0].blockId)!;
  if (JSON.stringify(current.content ?? []) !== JSON.stringify(target.definitionContent)) throw new Error("注释段落已改变，请重新打开。");
  if (target.reference) {
    const owner = index.blocks.find((b) => b.id === target.reference!.blockId);
    if (!owner || JSON.stringify(owner.content ?? []) !== JSON.stringify(target.referenceContent)) {
      throw new Error("引用所在段落已改变，请重新选择，避免误删另一处相同引用。");
    }
  }
  return defs[0];
}
export function insertionCursor(cursor: CursorData): CursorData {
  if (cursor.mirror) throw new Error("暂不在镜像中插入脚注，请打开源笔记。");
  const end = cursor.isForward ? cursor.focus : cursor.anchor;
  // Orca's insertFragments distinguishes a caret by anchor === focus, not equal fields.
  const point = { ...end };
  return { ...clone(cursor), anchor: point, focus: point, isForward: true };
}
export function cursorOffset(content: ContentFragment[], node: CursorNodeData): number {
  if (node.index < 0 || node.index > content.length) throw new Error("光标位置已失效。");
  const before = sourceText(content.slice(0, node.index)).length;
  if (!node.isInline) return before;
  const item = content[node.index];
  if (!item || !["t", REF_TYPE, DEF_TYPE].includes(item.t) || typeof item.v !== "string" || node.offset < 0 || node.offset > item.v.length) {
    throw new Error("请把光标放到 Markdown 脚注标记中。");
  }
  return before + node.offset;
}
export function plainList(index: NoteIndex): string {
  const lines = index.entries.map((e) => `[${e.number}] [^${e.label}] ${e.definition?.text ?? e.problem}\n（${e.references.length} 处引用）`);
  for (const d of index.definitions.filter((d) => !d.refCount)) lines.push(`未引用 [^${d.label}] ${d.text}`);
  if (index.issues.length) lines.push(`注意：\n${index.issues.join("\n")}`);
  return "尾注\n\n" + (lines.join("\n\n") || "（暂无脚注）");
}
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
