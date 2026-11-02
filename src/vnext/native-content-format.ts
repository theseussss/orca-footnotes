import type { Block, DbId } from "../../vendor/orca";
import { captureNativeNoteSnapshot } from "./native-content-snapshot";
import { ITEM_PROPERTY, STORE_PROPERTY, type AnnotationMetadata } from "./types";

/** Read-only candidate protocol. None of these types is a DB/Source/render lease. */
export type NativeAnnotationFormatErrorCode = "INVALID_DATA" | "INVALID_BLOCK" | "INVALID_CATALOG"
  | "UNSUPPORTED_VERSION" | "UNSUPPORTED_PROTOCOL" | "INVALID_STORE" | "STORE_MISMATCH"
  | "DUPLICATE_PROPERTY" | "MISSING_METADATA" | "INVALID_METADATA" | "UNSUPPORTED_CONTENT_KIND" | "LEGACY_TEXT_FORBIDDEN";
export class NativeAnnotationFormatError extends Error {
  override readonly name = "NativeAnnotationFormatError";
  constructor(readonly code: NativeAnnotationFormatErrorCode, readonly id?: DbId, detail?: string, options?: ErrorOptions) {
    super(`注释记录格式 ${code}${id === undefined ? "" : ` (block ${id})`}${detail ? `: ${detail}` : ""}`, options);
  }
}
type Data = Readonly<Record<string, unknown>>;
export interface LegacyAnnotationCatalog extends Data { readonly version: 1; readonly rootId: DbId; readonly token: string }
export interface NativeAnnotationCatalog extends Data {
  readonly version: 2; readonly rootId: DbId; readonly token: string; readonly contentProtocol: "native-tree-v1";
}
export type AnnotationCatalog = LegacyAnnotationCatalog | NativeAnnotationCatalog;
export interface LegacyAnnotationStore extends Data { readonly version: 1; readonly token: string }
export interface NativeAnnotationStore extends Data { readonly version: 2; readonly token: string; readonly contentProtocol: "native-tree-v1" }
export type AnnotationStore = LegacyAnnotationStore | NativeAnnotationStore;
export interface NativeAnnotationContentStamp extends Data {
  readonly algorithm: "native-content-signature"; readonly version: 1; readonly value: string;
}
export interface NativeTreeAnnotationMetadata extends Omit<AnnotationMetadata, "version">, Data {
  readonly version: 2; readonly contentKind: "native-tree"; readonly operationId: string;
  readonly publicationStatus: "prepared" | "published"; readonly contentStamp: NativeAnnotationContentStamp;
}
export type AnnotationMetadataRead = { readonly kind: "legacy-text"; readonly version: 1; readonly id: DbId; readonly metadata: AnnotationMetadata & Data }
  | { readonly kind: "native-tree"; readonly version: 2; readonly id: DbId; readonly publicationStatus: "prepared"; readonly isPublished: false;
      readonly metadata: NativeTreeAnnotationMetadata & { readonly publicationStatus: "prepared" } }
  | { readonly kind: "native-tree"; readonly version: 2; readonly id: DbId; readonly publicationStatus: "published"; readonly isPublished: true;
      readonly metadata: NativeTreeAnnotationMetadata & { readonly publicationStatus: "published" } };

const fail = (code: NativeAnnotationFormatErrorCode, id?: DbId, detail?: string): never => { throw new NativeAnnotationFormatError(code, id, detail); };
function guard<T>(id: DbId | undefined, action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof NativeAnnotationFormatError) throw error;
    throw new NativeAnnotationFormatError("INVALID_DATA", id, "unsupported or unreadable own data", { cause: error });
  }
}
function object(value: unknown, code: NativeAnnotationFormatErrorCode, id?: DbId): Data {
  if (value === null || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(code, id, "expected ordinary own-data object");
  return value as Data;
}
function own(value: object, name: string, id?: DbId): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) return fail("INVALID_DATA", id, "accessor field");
  return descriptor.value;
}
/** Reuse the lossless data codec via a synthetic, in-memory carrier, not a real
 * annotation/store block. No repository import, JSON roundtrip, host call, cache
 * refresh or write. Whole input is detached, including all unknown own fields;
 * accessors/functions/symbols/custom prototypes/cycles/resource excess fail.
 * Ordinary data-descriptor proxies are supported, not adversarial mutable traps.
 * The carrier's fixed timestamps/identity have no host or publication meaning. */
function detach(value: unknown, id?: DbId): unknown {
  return guard(id, () => {
    const carrier: Block = { id: 0, children: [], aliases: [], refs: [], backRefs: [], created: new Date(0), modified: new Date(0),
      properties: [{ name: "read-only-format-payload", type: 0, value }] };
    return captureNativeNoteSnapshot(0, [carrier]).blocks[0].properties[0].value;
  });
}
function version(data: Data, code: NativeAnnotationFormatErrorCode, id?: DbId): 1 | 2 {
  const value = own(data, "version", id);
  if (value === undefined) return fail(code, id, "missing version");
  if (value !== 1 && value !== 2) return fail("UNSUPPORTED_VERSION", id);
  return value;
}
/** No trimming/coercion: blanks and C0/DEL/C1 controls are rejected, not fixed. */
function identity(value: unknown, code: NativeAnnotationFormatErrorCode, id?: DbId): void {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail(code, id, "invalid token/operation identity");
}
function protocol(data: Data, v: 1 | 2, id?: DbId): void {
  if (v === 2 ? own(data, "contentProtocol", id) !== "native-tree-v1" : Object.hasOwn(data, "contentProtocol")) fail("UNSUPPORTED_PROTOCOL", id);
}
/** Input is a parsed object, not JSON source. Duplicate JSON object keys already
 * discarded by JSON.parse cannot be recovered here; the caller owns raw parsing.
 * Native Block.properties duplicates, in contrast, are always rejected below. */
export function parseAnnotationCatalog(raw: unknown): AnnotationCatalog {
  return guard(undefined, () => {
    const data = object(detach(raw), "INVALID_CATALOG"), v = version(data, "INVALID_CATALOG");
    if (!Number.isSafeInteger(own(data, "rootId"))) fail("INVALID_CATALOG", undefined, "invalid root identity");
    identity(own(data, "token"), "INVALID_CATALOG"); protocol(data, v);
    return data as unknown as AnnotationCatalog;
  });
}
interface BlockData { readonly id: DbId; readonly properties: ReadonlyMap<string, Data> }
function readBlock(raw: unknown): BlockData {
  return guard(undefined, () => {
    const initial = object(raw, "INVALID_BLOCK"), rawId = own(initial, "id");
    if (!Number.isSafeInteger(rawId)) return fail("INVALID_BLOCK", undefined, "invalid block identity");
    const id = rawId as DbId;
    return guard(id, () => {
      const data = object(detach(raw, id), "INVALID_BLOCK", id);
      // Defensive descriptor-proxy consistency check, not an atomic Store read.
      if (own(data, "id", id) !== id) fail("INVALID_BLOCK", id, "identity changed during read");
      const properties = own(data, "properties", id);
      if (!Array.isArray(properties)) return fail("INVALID_BLOCK", id, "missing properties array");
      const result = new Map<string, Data>();
      for (let i = 0; i < properties.length; i++) {
        if (!Object.hasOwn(properties, String(i))) return fail("INVALID_BLOCK", id, "sparse properties array");
        const property = object(own(properties, String(i), id), "INVALID_BLOCK", id), name = own(property, "name", id), type = own(property, "type", id);
        if (typeof name !== "string" || !name || !Number.isSafeInteger(type)) return fail("INVALID_BLOCK", id, "invalid property wrapper");
        if (result.has(name)) return fail("DUPLICATE_PROPERTY", id);
        result.set(name, property);
      }
      return { id, properties: result };
    });
  });
}
function propertyValue(block: BlockData, name: string, code: NativeAnnotationFormatErrorCode): Data | undefined {
  const property = block.properties.get(name);
  if (!property) return undefined;
  if (own(property, "type", block.id) !== 0) return fail(code, block.id, "protocol property requires native object type 0");
  return object(own(property, "value", block.id), code, block.id);
}
/** Validates exact catalog/Store pairing only; NOT an item/tree ownership proof,
 * active library identity check, render lease, atomic read, or edit permission. */
export function validateAnnotationStore(rawBlock: unknown, rawCatalog: unknown): AnnotationStore {
  const catalog = parseAnnotationCatalog(rawCatalog), block = readBlock(rawBlock);
  const marker = propertyValue(block, STORE_PROPERTY, "INVALID_STORE");
  if (!marker) return fail("INVALID_STORE", block.id, "missing Store marker");
  const v = version(marker, "INVALID_STORE", block.id);
  identity(own(marker, "token", block.id), "INVALID_STORE", block.id); protocol(marker, v, block.id);
  if (block.id !== catalog.rootId || v !== catalog.version || own(marker, "token", block.id) !== catalog.token) return fail("STORE_MISMATCH", block.id);
  return marker as unknown as AnnotationStore;
}
function time(value: unknown, id: DbId): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) fail("INVALID_METADATA", id, "invalid time");
}
function readItem(block: BlockData): AnnotationMetadataRead | undefined {
  const metadata = propertyValue(block, ITEM_PROPERTY, "INVALID_METADATA");
  if (!metadata) return undefined;
  const id = block.id, v = version(metadata, "INVALID_METADATA", id);
  if (!Number.isSafeInteger(own(metadata, "ownerRootId", id)) || !Number.isSafeInteger(own(metadata, "revision", id)) || (own(metadata, "revision", id) as number) < 1
    || !["active", "recycled", "archived"].includes(own(metadata, "state", id) as string)
    || typeof own(metadata, "comment", id) !== "string" || (v === 1 && (own(metadata, "comment", id) as string).length > 50_000)) fail("INVALID_METADATA", id, "invalid annotation fields");
  time(own(metadata, "createdAt", id), id); time(own(metadata, "updatedAt", id), id);
  for (const key of ["recycledAt", "archivedAt"]) { const value = own(metadata, key, id); if (value !== undefined) time(value, id); }
  if (v === 1) {
    if (Object.hasOwn(metadata, "contentKind")) return fail("UNSUPPORTED_CONTENT_KIND", id, "V1 cannot declare a native/future content kind");
    return { kind: "legacy-text", version: 1, id, metadata: metadata as unknown as AnnotationMetadata & Data };
  }
  if (own(metadata, "contentKind", id) !== "native-tree") return fail("UNSUPPORTED_CONTENT_KIND", id);
  identity(own(metadata, "operationId", id), "INVALID_METADATA", id);
  const status = own(metadata, "publicationStatus", id);
  if (status !== "prepared" && status !== "published") return fail("INVALID_METADATA", id, "unknown publication status");
  const stamp = object(own(metadata, "contentStamp", id), "INVALID_METADATA", id), stampValue = own(stamp, "value", id);
  if (own(stamp, "algorithm", id) !== "native-content-signature" || own(stamp, "version", id) !== 1 || typeof stampValue !== "string" || !stampValue.length)
    return fail("INVALID_METADATA", id, "unknown or invalid content stamp");
  // Published is a parsed declaration, NOT verified publication/renderer authority.
  return status === "prepared"
    ? { kind: "native-tree", version: 2, id, publicationStatus: status, isPublished: false, metadata: metadata as unknown as NativeTreeAnnotationMetadata & { publicationStatus: "prepared" } }
    : { kind: "native-tree", version: 2, id, publicationStatus: status, isPublished: true, metadata: metadata as unknown as NativeTreeAnnotationMetadata & { publicationStatus: "published" } };
}
/** No plain text projection; V1 must still pass the existing legacy parser.
 * Unknown own metadata/descriptor flags survive on detached data. Rich content
 * is never rewritten, flattened or treated as an empty V1 record. */
export function readAnnotationMetadata(block: unknown): AnnotationMetadataRead | undefined { return readItem(readBlock(block)); }
/** Negative old-string-API gate only, NOT permission to save/restore anything.
 * A successful V1 check still requires the legacy content parser, catalog/Store,
 * ownership/state/revision/source checks. Supplying a V2 catalog always refuses
 * even a V1 item. No catalog means item-format-only, not catalog validation. */
export function assertLegacyTextFormat(rawBlock: unknown, rawCatalog?: unknown): void {
  const block = readBlock(rawBlock), item = readItem(block);
  if (rawCatalog !== undefined) {
    const catalog = parseAnnotationCatalog(rawCatalog);
    if (catalog.version === 2) return fail("LEGACY_TEXT_FORBIDDEN", block.id);
  }
  if (!item) return fail("MISSING_METADATA", block.id);
  if (item.version === 2) return fail("LEGACY_TEXT_FORBIDDEN", block.id);
}
