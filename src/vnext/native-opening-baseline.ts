import type { AnnotationContentRead } from "./repository";
import { encodeNativeNoteSnapshot, type NativeNoteSnapshot } from "./native-content-snapshot";
import type { NativeSnapshotCheckpoint } from "./native-snapshot-journal";

/** First-opening RECOVERY evidence only. Neither mode grants Source, render,
 * children/input, Provider, unique-M, or canonical write permission. Ordinary
 * reads/refreshes use check-existing; prepare is an explicit preparation step. */
export interface NativeOpeningBaselineRequest {
  readonly itemId: number;
  readonly operationId: string;
  readonly mode: "check-existing" | "prepare";
}
export type NativeOpeningBaselineContent = Extract<AnnotationContentRead, { kind: "native-tree" }>;
/** Detached observations, NOT an authorization or a native-input flush receipt.
 * A later canonical/live/DOM change can invalidate these observations. */
export type NativeOpeningBaselineResult =
  | { readonly kind: "ready"; readonly content: NativeOpeningBaselineContent; readonly wire: string;
      readonly matchedOperationId: string; readonly appended: boolean }
  | { readonly kind: "needs-baseline"; readonly content: NativeOpeningBaselineContent; readonly wire: string };
export type NativeOpeningBaselineErrorCode = "INVALID_REQUEST" | "INVALID_CONTENT" | "INVALID_CLOCK"
  | "CONTENT_CHANGED" | "BASELINE_NOT_RETAINED" | "HISTORY_OBSERVATION_CHANGED";
export class NativeOpeningBaselineError extends Error {
  override readonly name = "NativeOpeningBaselineError";
  constructor(readonly code: NativeOpeningBaselineErrorCode, readonly itemId?: number) {
    super(`原生注释首次准备证据 ${code}；未授予编辑权限，未自动重试、回滚或删除恢复副本。`);
  }
}

/** Capture ONLY own data, synchronously before the repository FIFO. Primitive
 * fields need no codec copy. Accessors (including unknown fields), inherited
 * fields, symbols and custom prototypes are rejected without executing getters.
 * Ordinary data-descriptor proxies are supported, not hostile mutable traps. */
export function captureNativeOpeningRequest(request: NativeOpeningBaselineRequest, fence: () => void): NativeOpeningBaselineRequest {
  const invalid = (): never => { throw new NativeOpeningBaselineError("INVALID_REQUEST"); };
  if (typeof fence !== "function" || request === null || typeof request !== "object"
    || ![Object.prototype, null].includes(Object.getPrototypeOf(request))) return invalid();
  const names = ["itemId", "operationId", "mode"] as const, keys = Reflect.ownKeys(request);
  if (keys.length !== names.length || !names.every(name => keys.includes(name))) return invalid();
  const fields: unknown[] = [];
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(request, name);
    if (!descriptor || !("value" in descriptor)) return invalid();
    fields.push(descriptor.value);
  }
  const [itemId, operationId, mode] = fields;
  if (!Number.isSafeInteger(itemId) || typeof operationId !== "string" || !operationId.trim()
    || operationId.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(operationId)
    || mode !== "check-existing" && mode !== "prepare") return invalid();
  return Object.freeze({ itemId: itemId as number, operationId, mode });
}

/** Content shape check only; repository authenticates fresh V2 catalog/Store.
 * N must be truly empty, not a blank-looking rich/native paragraph. C may be
 * rich, deep or empty and is always retained in the COMPLETE snapshot. */
export function assertNativeOpeningContent(content: AnnotationContentRead, itemId: number): asserts content is NativeOpeningBaselineContent {
  if (content.kind !== "native-tree" || !Object.is(content.id, itemId) || !Object.is(content.snapshot.rootId, itemId)
    || content.metadata.version !== 2 || content.metadata.publicationStatus !== "published" || content.metadata.state !== "active")
    throw new NativeOpeningBaselineError("INVALID_CONTENT", itemId);
  const root = content.snapshot.blocks[0], body = root?.content;
  if (!root || !Object.is(root.id, itemId) || root.children.length < 1
    || !(body == null || Array.isArray(body) && body.length === 0 && Reflect.ownKeys(body).length === 1))
    throw new NativeOpeningBaselineError("INVALID_CONTENT", itemId);
}

/** FULL lossless payload identity, including metadata, property wrappers, own
 * order/descriptor flags, Dates, holes and references. Never a semantic stamp. */
export function nativeOpeningSnapshotWire(snapshot: NativeNoteSnapshot): string {
  return JSON.stringify(encodeNativeNoteSnapshot(snapshot));
}

/** One scan of the real journal's freshly decoded history, no history copying
 * or truncation. The journal instance/key owns namespace/root authentication.
 * Same operation, revision, stamp or signature alone is NEVER a match. */
export function findNativeOpeningCheckpoint(history: readonly NativeSnapshotCheckpoint[], content: NativeOpeningBaselineContent, wire: string,
  expected?: Pick<NativeSnapshotCheckpoint, "operationId" | "at" | "reason">): string | undefined {
  for (const entry of history) {
    if (!Object.is(entry.rootId, content.id) || !Object.is(entry.snapshot.rootId, content.id)
      || entry.revision !== content.metadata.revision || entry.comment !== content.metadata.comment
      || expected && (entry.operationId !== expected.operationId || entry.at !== expected.at || entry.reason !== expected.reason)) continue;
    if (nativeOpeningSnapshotWire(entry.snapshot) === wire) return entry.operationId;
  }
  return undefined;
}
