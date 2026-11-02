import type { Block, BlockProperty } from "../vendor/orca";
import { reprType, type NoteIndex } from "./model";

/** Layout ownership only. Markdown remains the reference/definition source of truth. */
export const FOOTER_PROPERTY = "orca-footnotes.footer";
export const DEFINITION_PROPERTY = "orca-footnotes.definition";
export interface FooterMarker { version: 1 | 2; scope: number; id: string }
export interface DefinitionMarker { version: 1; scope: number }
export function footerMarker(block: Block): FooterMarker | undefined {
  const v = block.properties.find((p) => p.name === FOOTER_PROPERTY)?.value;
  return v && [1, 2].includes(v.version) && Number.isSafeInteger(v.scope) && typeof v.id === "string" && v.id.length > 0
    ? { version: v.version, scope: v.scope, id: v.id } : undefined;
}
export function definitionMarker(block: Block): DefinitionMarker | undefined {
  const v = block.properties.find((p) => p.name === DEFINITION_PROPERTY)?.value;
  return v && v.version === 1 && Number.isSafeInteger(v.scope) ? { version: 1, scope: v.scope } : undefined;
}
export function makeFooterProperty(scope: number, id: string = crypto.randomUUID()): BlockProperty {
  return { name: FOOTER_PROPERTY, type: 0, value: { version: 2, scope, id } satisfies FooterMarker };
}
export function makeDefinitionProperty(scope: number): BlockProperty {
  return { name: DEFINITION_PROPERTY, type: 0, value: { version: 1, scope } satisfies DefinitionMarker };
}
export function isManagedDefinition(block: Block): boolean { return !!definitionMarker(block); }
export interface FooterPlan {
  heading?: Block;
  definitionIds: number[];
  moves: number[];
  preservedLegacyIds: number[];
  unmanagedDefinitionIds: number[];
}
function unsafeDefinition(block: Block, index: NoteIndex, byId: Map<number, Block>): string | undefined {
  if (block.id === index.rootId) return "尾注定义位于根块";
  if (block.children.length) return "尾注定义带有子块";
  let parent = block.parent == null ? undefined : byId.get(block.parent);
  while (parent) {
    if (reprType(parent) === "code") return "尾注定义位于代码块内";
    parent = parent.parent == null ? undefined : byId.get(parent.parent);
  }
}
/** Only owned definitions may move/convert; appearance or DEF_TYPE is not ownership. */
export function planFooterOrder(index: NoteIndex): FooterPlan {
  const byId = new Map(index.blocks.map((b) => [b.id, b]));
  const root = byId.get(index.rootId);
  if (!root) throw new Error("未找到笔记根块，已取消更新。");
  const marked = index.blocks.filter((b) => b.properties.some((p) => p.name === FOOTER_PROPERTY));
  // v1 is historical, possibly attached to an unsafe user subtree. v2 is the active, independent separator.
  const active = marked.filter((b) => b.properties.find((p) => p.name === FOOTER_PROPERTY)?.value?.version !== 1);
  if (active.some((b) => footerMarker(b)?.version !== 2)) throw new Error("尾注活动区标识损坏或版本未知；未移动内容，请复制诊断信息。");
  if (active.length > 1) throw new Error("本篇有多个活动尾注区；未自动合并或移动内容，请先核对。");
  const unmanagedDefinitionIds: number[] = [];
  const definitionIds = [...index.definitions].sort((a, b) =>
    (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER)).flatMap((def) => {
    const b = byId.get(def.blockId)!;
    if (!isManagedDefinition(b)) {
      if (b.properties.some((p) => p.name === DEFINITION_PROPERTY)) throw new Error(`块 ${b.id} 的尾注所有权标识损坏；保留原位。`);
      unmanagedDefinitionIds.push(b.id); return [];
    }
    const reason = unsafeDefinition(b, index, byId);
    if (reason) throw new Error(`${reason}（块 ${b.id}）；已停止排版，不连带搬动内容。`);
    return [b.id];
  });
  let heading = active[0];
  if (heading && (heading.id === index.rootId || heading.children.length || !["hr", "heading"].includes(reprType(heading) ?? "")
    || index.definitions.some((d) => d.blockId === heading.id) || index.references.some((ref) => ref.blockId === heading.id))) {
    throw new Error(`活动尾注分隔块 ${heading.id} 的结构已改变；本次不移动它或其子块。请复制诊断信息。`);
  }
  const legacy = marked.filter((b) => b.properties.find((p) => p.name === FOOTER_PROPERTY)?.value?.version === 1);
  // The only silent v1 upgrade is a unique, empty, childless native rule. Never hide a nonempty old title.
  const safeLegacy = legacy.filter((b) => footerMarker(b) && b.id !== index.rootId && reprType(b) === "hr"
    && !(b.content ?? []).length && !b.children.length);
  if (!heading && safeLegacy.length === 1) heading = safeLegacy[0];
  const preservedLegacyIds = legacy.filter((b) => b.id !== heading?.id).map((b) => b.id);
  const children = root.children.filter((id) => id !== heading?.id);
  const tail = children.slice(-definitionIds.length);
  const arranged = definitionIds.length === 0 || (tail.length === definitionIds.length
    && tail.every((id, i) => id === definitionIds[i]) && definitionIds.every((id) => byId.get(id)?.parent === root.id));
  return { heading, definitionIds, moves: arranged ? [] : definitionIds, preservedLegacyIds, unmanagedDefinitionIds };
}
