import type { Block, ContentFragment, DbId } from "../../vendor/orca";
import { collectIndex, assertPlainDefinition, clone, sourceText } from "../model";
import { replaceTextRanges, type ReferenceToken } from "../markdown";
import { isManagedDefinition } from "../footer";
import { NativeAnnotationFormatError, readAnnotationMetadata } from "./native-content-format";
import { ITEM_PROPERTY, ITEM_REPR, STORE_PROPERTY, STORE_REPR } from "./types";

export interface LegacyDefinition {
  readonly blockId: DbId;
  readonly label: string;
  readonly text: string;
  readonly owned: boolean;
  readonly source: Block;
  readonly blocked?: string;
}
export interface LegacySource { readonly block: Block; readonly tokens: readonly ReferenceToken[] }
export interface LegacyImportPlan {
  readonly rootId: DbId;
  readonly definitions: readonly LegacyDefinition[];
  readonly sources: readonly LegacySource[];
  readonly issues: readonly string[];
}
/** Migration is for ordinary old prose, never for an already managed V1/V2,
 * unknown or damaged annotation/Store. Metadata parsing also rejects duplicate
 * properties and unsupported own data BEFORE anything can be cached/journaled. */
export function assertLegacyMigrationBlock(block: Block): void {
  readAnnotationMetadata(block);
  const repr = block.properties.find(property => property.name === "_repr")?.value?.type;
  if (block.properties.some(property => property.name === ITEM_PROPERTY || property.name === STORE_PROPERTY)
    || repr === ITEM_REPR || repr === STORE_REPR)
    throw new NativeAnnotationFormatError("LEGACY_TEXT_FORBIDDEN", block.id, "已有注释协议身份，不能作为普通旧正文迁移改写。");
}
/** Preview only: never treats appearance/old enhanced type as ownership. */
export async function previewLegacy(rootId: DbId, blocks: readonly Block[]): Promise<LegacyImportPlan> {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const index = await collectIndex(rootId, async (id) => byId.get(id));
  const definitions = index.definitions.map((definition) => {
    const source = byId.get(definition.blockId)!;
    let blocked: string | undefined;
    try {
      assertLegacyMigrationBlock(source); assertPlainDefinition(source);
      if (source.id === rootId || source.children.length) throw new Error("定义是根块或带子块，不能作为单条注释迁移。");
    } catch (error) { blocked = error instanceof Error ? error.message : String(error); }
    return { blockId: source.id, label: definition.label, text: definition.text, owned: isManagedDefinition(source), source: clone(source), blocked };
  });
  const issues = [...index.issues], sources = index.blocks.flatMap((block) => {
    const tokens = index.references.filter((reference) => reference.blockId === block.id);
    if (tokens.length) {
      try { assertLegacyMigrationBlock(block); }
      catch (error) { issues.push(`引用来源 #${block.id} 不可作为普通旧正文迁移：${error instanceof Error ? error.message : String(error)}`); }
    }
    return tokens.length ? [{ block: clone(block), tokens }] : [];
  });
  return { rootId, definitions, sources, issues };
}
/** Reuse the exact-range legacy engine for rich-text preservation, but substitute
 * native r objects in memory. No sentinel is ever written to a notebook.
 */
export function replaceLegacyMarkers(content: ContentFragment[], tokens: readonly ReferenceToken[], markers: ReadonlyMap<string, ContentFragment>): ContentFragment[] {
  const selected = tokens.filter((token) => markers.has(token.label));
  if (!selected.length) return clone(content);
  const before = sourceText(content), substitutions = new Map<string, ContentFragment>();
  const edits = selected.map((token) => {
    const sentinel = `\uE000ofn-${crypto.randomUUID()}\uE001`;
    if (before.includes(sentinel)) throw new Error("迁移占位符冲突，未改写正文。");
    substitutions.set(sentinel, markers.get(token.label)!);
    return { start: token.start, end: token.end, expected: token.raw, text: sentinel };
  });
  const updated = replaceTextRanges(content, edits).map((fragment) => fragment.t === "t" && substitutions.has(fragment.v)
    ? clone(substitutions.get(fragment.v)!) : fragment);
  let expected = before;
  for (const token of [...selected].sort((a, b) => b.start - a.start)) expected = expected.slice(0, token.start) + "\uFFFC" + expected.slice(token.end);
  if (sourceText(updated) !== expected) throw new Error("迁移改变了引用之外的正文，已停止。");
  return updated;
}
