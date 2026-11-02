import type { Block, BlockProperty } from "../../vendor/orca";
import { readAnnotationMetadata, NativeAnnotationFormatError, type NativeTreeAnnotationMetadata } from "./native-content-format";
import { decodeNativeNoteSnapshot, encodeNativeNoteSnapshot, nativeContentSignature,
  type NativeNoteSnapshot } from "./native-content-snapshot";
import { ITEM_PROPERTY } from "./types";

/** A pure proposal, NOT an issued Source/item/render/command authority. It sends
 * nothing to the host. Only the ITEM property may later be submitted; snapshot
 * is for complete baseline/quota/history verification, never a content write. */
export interface NativeMetadataChange {
  readonly itemId: number;
  readonly changed: boolean;
  readonly before: NativeNoteSnapshot;
  readonly snapshot: NativeNoteSnapshot;
  readonly property: Readonly<BlockProperty>;
  readonly metadata: NativeTreeAnnotationMetadata;
  readonly signature: string;
}
export type NativeMetadataUpdate =
  | { readonly comment: string; readonly updatedAt: number; readonly checkpoint?: never }
  | { readonly checkpoint: true; readonly updatedAt: number; readonly comment?: never };

function updateFields<T extends object>(original: T, changes: Readonly<Record<string, unknown>>): T {
  const descriptors = Object.getOwnPropertyDescriptors(original);
  for (const [key, value] of Object.entries(changes)) {
    const descriptor = descriptors[key as keyof T];
    if (!descriptor || !("value" in descriptor)) throw new TypeError("缺少可验证的原生元数据自有字段。");
    Object.defineProperty(descriptors, key, { value: { ...descriptor, value }, enumerable: true, configurable: true, writable: true });
  }
  // On a NEW object even a nonconfigurable old data descriptor can safely get
  // a new value. Never spread a metadata/property/block and lose hidden fields.
  return Object.create(Object.getPrototypeOf(original), descriptors) as T;
}
function patch(value: NativeMetadataUpdate): { comment?: string; checkpoint?: true; updatedAt: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("原生元数据更改参数无效。");
  const keys = Reflect.ownKeys(value), fields = Object.getOwnPropertyDescriptors(value);
  if (keys.length !== 2 || !keys.includes("updatedAt") || keys.some(key => !["updatedAt", "comment", "checkpoint"].includes(String(key)))
    || keys.some(key => typeof key !== "string" || !fields[key] || !("value" in fields[key]))) throw new TypeError("原生元数据更改参数无效。");
  const updatedAt = fields.updatedAt.value;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0 || updatedAt > 8_640_000_000_000_000)
    throw new TypeError("原生元数据时间无效。");
  if (keys.includes("comment")) {
    const comment = fields.comment?.value;
    if (typeof comment !== "string") throw new TypeError("原生批注必须是原样字符串。");
    return { comment, updatedAt };
  }
  if (fields.checkpoint?.value !== true) throw new TypeError("未知的原生检查点更改。");
  return { checkpoint: true, updatedAt };
}

/** Only a memory-codec envelope, never a host block, D, Context or publication
 * identity. Capture the caller's FULL metadata before a Controller queue await. */
export function detachNativeMetadataBaseline(itemId: number, metadata: NativeTreeAnnotationMetadata): NativeTreeAnnotationMetadata {
  const carrier: Block & Record<string, unknown> = { id: itemId, children: [], properties: [{ name: ITEM_PROPERTY, type: 0, value: metadata }],
    aliases: [], refs: [], backRefs: [], created: new Date(0), modified: new Date(0) };
  const snapshot = decodeNativeNoteSnapshot(encodeNativeNoteSnapshot({ version: 1, rootId: itemId, blocks: [carrier] }));
  const parsed = readAnnotationMetadata(snapshot.blocks[0]);
  if (parsed?.kind !== "native-tree") throw new NativeAnnotationFormatError("INVALID_METADATA", itemId);
  return parsed.metadata;
}

/** Detached descriptor-preserving metadata preparation. No catalog/source/shape
 * authorization, publish operation, queue, native dispatch or successful save
 * is inferred from the result. In particular N's empty-container and command
 * history constraints remain the mutation gateway's separate responsibility. */
export function prepareNativeMetadataChange(snapshot: NativeNoteSnapshot, update: NativeMetadataUpdate): NativeMetadataChange {
  const requested = patch(update), before = decodeNativeNoteSnapshot(encodeNativeNoteSnapshot(snapshot));
  const root = before.blocks[0], item = readAnnotationMetadata(root);
  if (item?.kind !== "native-tree" || !item.isPublished || item.metadata.state !== "active")
    throw new NativeAnnotationFormatError("INVALID_METADATA", before.rootId, "只有已发布且在用的原生条目可以准备元数据更改。");
  const index = root.properties.findIndex(property => property.name === ITEM_PROPERTY), oldProperty = root.properties[index];
  const metadata = item.metadata, signature = nativeContentSignature(before);
  const changed = requested.checkpoint ? metadata.contentStamp.value !== signature : requested.comment !== metadata.comment;
  if (!changed) return { itemId: before.rootId, changed: false, before, snapshot: before, property: oldProperty, metadata, signature };
  if (!Number.isSafeInteger(metadata.revision + 1)) throw new NativeAnnotationFormatError("INVALID_METADATA", before.rootId, "检查点版本超出安全整数范围。");
  const fields: Record<string, unknown> = { revision: metadata.revision + 1, updatedAt: requested.updatedAt };
  if (requested.checkpoint) fields.contentStamp = updateFields(metadata.contentStamp, { value: signature });
  else fields.comment = requested.comment;
  const nextMetadata = updateFields(metadata, fields), nextProperty = updateFields(oldProperty, { value: nextMetadata });
  const descriptors: PropertyDescriptorMap = Object.create(null);
  for (const key of Reflect.ownKeys(root.properties)) descriptors[key] = Object.getOwnPropertyDescriptor(root.properties, key)!;
  descriptors[String(index)] = { ...descriptors[String(index)], value: nextProperty };
  const properties = Object.defineProperties([], descriptors);
  const nextRoot = updateFields(root, { properties });
  // Revalidate the COMPLETE proposed native snapshot and aggregate quota. Large
  // comment updates must not make an otherwise readable tree un-backupable.
  const after = decodeNativeNoteSnapshot(encodeNativeNoteSnapshot({ version: 1, rootId: before.rootId,
    blocks: before.blocks.map((block, i) => i === 0 ? nextRoot : block) }));
  const result = readAnnotationMetadata(after.blocks[0]);
  if (result?.kind !== "native-tree") throw new NativeAnnotationFormatError("INVALID_METADATA", before.rootId);
  return { itemId: before.rootId, changed: true, before, snapshot: after, property: after.blocks[0].properties[index], metadata: result.metadata, signature };
}
