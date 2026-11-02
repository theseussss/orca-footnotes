import type { DbId } from "../../vendor/orca";
import type { AnnotationState } from "./domain";
import type { AnnotationRecord } from "./types";
import { ITEM_PROPERTY } from "./types";
import type { AnnotationContentRead } from "./repository";
import { readAnnotationMetadata } from "./native-content-format";
import { decodeNativeNoteSnapshot, encodeNativeNoteSnapshot,
  type NativeNoteSnapshot, type NativeSnapshotLimits } from "./native-content-snapshot";

/** Display DTO only. Never a V1 save payload, native render lease, or write source. */
export interface NativeAnnotationView {
  readonly contentKind: "native-tree";
  readonly id: DbId;
  readonly ownerRootId: DbId;
  readonly state: AnnotationState;
  readonly comment: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recycledAt?: number;
  readonly archivedAt?: number;
  readonly displayText: string;
  readonly projectionAvailable: boolean;
  readonly text?: never;
}
export type AnnotationViewRecord = AnnotationRecord | NativeAnnotationView;
export interface NativeTextProjection {
  readonly displayText: string;
  readonly projectionAvailable: boolean;
}
export const NATIVE_TEXT_UNAVAILABLE = "原生引文全文暂不可用，请在原生编辑器中查看。";

/** Own-data access only: not even a forged DTO may run an accessor. */
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new TypeError("Annotation view requires ordinary own data.");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new TypeError(`Annotation view rejects accessor ${key}.`);
  return descriptor.value;
}
/** UI branch only, NOT content/render/write authorization. */
export function isNativeAnnotationView(item: AnnotationViewRecord): item is NativeAnnotationView {
  return own(item, "contentKind") === "native-tree";
}
export function annotationViewText(item: AnnotationViewRecord): string {
  return isNativeAnnotationView(item) ? item.displayText : item.text;
}
/** Unavailable display copy must never be indexed as quotation text. */
export function annotationViewSearchText(item: AnnotationViewRecord): string {
  const text = isNativeAnnotationView(item) && !item.projectionAvailable ? "" : annotationViewText(item);
  return `${text}\n${item.comment}`;
}

/** Complete C preorder, excluding the N header. This temporary readonly display
 * is not RichRenderer/converter parity and must NEVER be saved back as content.
 * Codec-detach the WHOLE snapshot before reading, including unknown fields and
 * the excluded header. Quotas throw instead of returning a partial quotation.
 * r/future inline without native derived text cannot be guessed from IDs/aliases. */
export function projectNativeAnnotationText(snapshot: NativeNoteSnapshot, limits?: Partial<NativeSnapshotLimits>): NativeTextProjection {
  const detached = decodeNativeNoteSnapshot(encodeNativeNoteSnapshot(snapshot, limits), limits);
  const paragraphs: string[] = [];
  for (const block of detached.blocks.slice(1)) {
    const derived = own(block, "text");
    if (typeof derived === "string") { paragraphs.push(derived); continue; }
    const content = own(block, "content");
    if (!Array.isArray(content)) return Object.freeze({ displayText: NATIVE_TEXT_UNAVAILABLE, projectionAvailable: false });
    const pieces: string[] = [];
    for (const fragment of content) {
      if (fragment === null || typeof fragment !== "object" || Array.isArray(fragment)
        || own(fragment, "t") !== "t" || typeof own(fragment, "v") !== "string")
        return Object.freeze({ displayText: NATIVE_TEXT_UNAVAILABLE, projectionAvailable: false });
      pieces.push(own(fragment, "v") as string);
    }
    paragraphs.push(pieces.join(""));
  }
  return Object.freeze({ displayText: paragraphs.join("\n"), projectionAvailable: true });
}

export function annotationViewFromContent(content: AnnotationContentRead): AnnotationViewRecord {
  const kind = own(content, "kind");
  if (kind === "plain-text") return own(content, "record") as AnnotationRecord;
  if (kind !== "native-tree") throw new TypeError("Unknown annotation content view kind.");
  const id = own(content, "id");
  // The existing metadata reader losslessly detaches and validates ALL metadata
  // own data before these explicit display fields are copied. No spread of native
  // payloads, checkpoint/signature, snapshot, or a synthetic writable text field.
  const parsed = readAnnotationMetadata({ id, properties: [{ name: ITEM_PROPERTY, type: 0, value: own(content, "metadata") }] });
  if (parsed?.kind !== "native-tree") throw new TypeError("Native annotation view requires native metadata.");
  const snapshot = own(content, "snapshot") as NativeNoteSnapshot;
  const projection = projectNativeAnnotationText(snapshot);
  if (own(snapshot, "rootId") !== id) throw new TypeError("Native annotation view identity mismatch.");
  const metadata = parsed.metadata;
  return Object.freeze({ contentKind: "native-tree", id: parsed.id, ownerRootId: metadata.ownerRootId, state: metadata.state,
    comment: metadata.comment, revision: metadata.revision, createdAt: metadata.createdAt, updatedAt: metadata.updatedAt,
    ...(Object.hasOwn(metadata, "recycledAt") ? { recycledAt: metadata.recycledAt } : {}),
    ...(Object.hasOwn(metadata, "archivedAt") ? { archivedAt: metadata.archivedAt } : {}),
    displayText: projection.displayText, projectionAvailable: projection.projectionAvailable });
}
