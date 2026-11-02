import type { Block, BlockProperty, ContentFragment, CursorData, DbId, Orca } from "../../vendor/orca";
import { repoKey } from "../index-store";
import { insertionCursor } from "../model";
import { inputInsertionCursor } from "./input-location";
import { footnoteTrigger } from "./settings";
import { isNativeNoteFragment, makeNativeNoteFragment } from "./native-reference";
import { captureNativeNoteSnapshot, decodeNativeNoteSnapshot, encodeNativeNoteSnapshot, nativeContentSignature, NATIVE_SNAPSHOT_LIMITS,
  type NativeNoteSnapshot, type NativeSnapshotBlock, type NativeSnapshotLimits } from "./native-content-snapshot";
import { NativeMetadataClaims, type NativeMetadataClaim, type NativeMetadataPurpose } from "./native-metadata-authority";
import { prepareNativeMetadataChange } from "./native-metadata-change";
import { NativeSnapshotJournal, type NativeSnapshotHistoryObservation } from "./native-snapshot-journal";
import { captureNativeOpeningRequest, assertNativeOpeningContent, nativeOpeningSnapshotWire, findNativeOpeningCheckpoint,
  NativeOpeningBaselineError, type NativeOpeningBaselineContent, type NativeOpeningBaselineRequest, type NativeOpeningBaselineResult } from "./native-opening-baseline";
export { NativeOpeningBaselineError } from "./native-opening-baseline";
export type { NativeOpeningBaselineRequest, NativeOpeningBaselineResult } from "./native-opening-baseline";
import type { NativeSourceIdentity } from "./native-source-session";
import { NativeAnnotationFormatError, parseAnnotationCatalog, validateAnnotationStore, readAnnotationMetadata, assertLegacyTextFormat,
  type AnnotationCatalog, type NativeTreeAnnotationMetadata } from "./native-content-format";
import { assertLegacyMigrationBlock, replaceLegacyMarkers, type LegacyImportPlan } from "./legacy";
import { DEFAULT_PREFERENCES, ITEM_PROPERTY, ITEM_REPR, STORE_PROPERTY, STORE_REPR,
  type AnnotationMetadata, type AnnotationRecord, type ContentSave, type DurableValues, type ScopePreferences } from "./types";

const clone = <T>(value: T): T => structuredClone(value);
export interface EditorPort {
  invokeCommand(id: string, cursor: CursorData | null, ...args: any[]): Promise<any>;
  invokeGroup(action: () => Promise<void>, options?: any): Promise<any>;
}
export interface SourceContext { readonly panelId: string; readonly viewRootId: DbId }
export interface InsertionBookmark {
  readonly cursor: CursorData;
  readonly content: ContentFragment[];
  /** Exact native literal observed after a dedicated-symbol input; absent for all ordinary insertions. */
  readonly replacement?: { readonly index: number; readonly start: number; readonly end: number; readonly expected: string; readonly trigger: string };
}
export interface ReferenceSource { readonly block: Block; readonly indices: readonly number[]; readonly relationIds: readonly DbId[] }
/** Detached READ result only; neither branch grants Source/render/write rights.
 * Native content deliberately has no text write source. A checkpoint can lag
 * later native edits, so stamp equality is diagnostic, not read permission. */
export type AnnotationContentRead =
  | { readonly kind: "plain-text"; readonly record: AnnotationRecord; readonly snapshot: NativeNoteSnapshot }
  | { readonly kind: "native-tree"; readonly id: DbId; readonly metadata: NativeTreeAnnotationMetadata;
      readonly snapshot: NativeNoteSnapshot; readonly signature: string; readonly checkpointMatches: boolean };
/** View-level limits, independently bounded from each lossless snapshot. Only
 * lowering is allowed; exhaustion rejects the WHOLE read, never silent top-N.
 * These are NOT host raw-IPC limits or quotas for all historical aggregates. */
export interface AnnotationContentCatalogLimits {
  readonly maxItems?: number;
  readonly maxTotalRows?: number;
  readonly maxTotalWireCodeUnits?: number;
  readonly snapshotLimits?: Partial<NativeSnapshotLimits>;
}
/** Detached READ DTO only: no Source/render/edit authority or native text
 * write source. Prepared identities are explicit, never empty formal entries. */
export interface AnnotationContentCatalogRead {
  readonly catalog: AnnotationCatalog | undefined;
  readonly contents: readonly AnnotationContentRead[];
  readonly excludedPreparedIds: readonly DbId[];
}
function contentCatalogLimits(options?: AnnotationContentCatalogLimits) {
  const totals = { maxItems: NATIVE_SNAPSHOT_LIMITS.maxRows, maxTotalRows: NATIVE_SNAPSHOT_LIMITS.maxRows, maxTotalWireCodeUnits: 32_000_000 };
  const snapshotLimits = { ...NATIVE_SNAPSHOT_LIMITS };
  const fields = (raw: unknown): [string, unknown][] => {
    if (raw === null || typeof raw !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)))
      throw new TypeError("注释清单资源限制必须为自有数据对象。");
    return Reflect.ownKeys(raw).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (typeof key !== "string" || !descriptor || !("value" in descriptor)) throw new TypeError("注释清单资源限制不能含未知字段或 getter。");
      return [key, descriptor.value];
    });
  };
  const lower = <T extends object>(target: T, key: string, value: unknown) => {
    if (!Object.hasOwn(target, key)) throw new TypeError("注释清单含未知资源限制。");
    const name = key as keyof T;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > (target[name] as number))
      throw new TypeError(`注释清单资源限制 ${key} 无效或超过上限。`);
    target[name] = value as T[keyof T];
  };
  if (options !== undefined) for (const [key, value] of fields(options)) {
    if (key === "snapshotLimits") for (const [name, limit] of fields(value)) lower(snapshotLimits, name, limit);
    else lower(totals, key, value);
  }
  return { ...totals, snapshotLimits };
}
export interface NativeMetadataWriteAccess {
  readonly claims: NativeMetadataClaims;
  /** Explicit Source.owner command bridge. Absent until the canonical bridge
   * and real input observer are connected; NEVER fall back to backend writes. */
  readonly dispatch?: (source: NativeSourceIdentity, itemId: DbId, property: Readonly<BlockProperty>) => Promise<void>;
}
export interface NativeMetadataCommentRequest {
  readonly itemId: DbId;
  readonly expectedMetadata: NativeTreeAnnotationMetadata;
  readonly comment: string;
}
export interface NativeMetadataCheckpointRequest {
  readonly itemId: DbId;
  readonly operationId: string;
  readonly expectedSnapshot: NativeNoteSnapshot;
  readonly expectedInputEpoch: number;
}
export interface NativeMetadataSaveResult {
  readonly kind: "native-metadata";
  readonly itemId: DbId;
  readonly metadata: NativeTreeAnnotationMetadata;
  /** Canonical-content diagnostic only; NOT an input flush or all-input-saved receipt. */
  readonly signature: string;
  readonly changed: boolean;
  readonly checkpoint?: { readonly operationId: string; readonly appended: boolean };
}
export type NativeMetadataSaveErrorCode = "CONFLICT" | "CONTENT_CHANGED" | "DISPATCH_UNAVAILABLE" | "POST_VERIFY";
export class NativeMetadataSaveError extends Error {
  override readonly name = "NativeMetadataSaveError";
  constructor(readonly code: NativeMetadataSaveErrorCode, readonly dispatched = false) {
    super(`原生注释元数据保存 ${code}。${dispatched ? "命令可能已派发并完成；未自动重试或回滚。" : "未派发原生更改。"}`);
  }
}
/** Comparison ONLY, through the existing complete lossless codec. This carrier
 * exists solely in memory, is never sent to any host or treated as an identity.
 * JSON serializes codec tuples, NEVER metadata/Date/proxy objects themselves.
 * Conservative equality includes own-field order, descriptors, holes and Dates. */
function propertyBaseline(property: Readonly<BlockProperty>): string {
  const carrier: Block = { id: 0, children: [], aliases: [], refs: [], backRefs: [], created: new Date(0), modified: new Date(0), properties: [property] };
  return JSON.stringify(encodeNativeNoteSnapshot(captureNativeNoteSnapshot(0, [carrier])));
}
function metadataBaseline(metadata: NativeTreeAnnotationMetadata): string {
  return propertyBaseline({ name: "native-metadata-comparison-only", type: 0, value: metadata });
}
function snapshotProperty(snapshot: NativeNoteSnapshot): Readonly<BlockProperty> {
  const property = snapshot.blocks[0].properties.find(property => property.name === ITEM_PROPERTY);
  if (!property) throw new NativeMetadataSaveError("CONFLICT");
  return property;
}
function snapshotMetadata(snapshot: NativeNoteSnapshot): NativeTreeAnnotationMetadata {
  const item = readAnnotationMetadata(snapshot.blocks[0]);
  if (item?.kind !== "native-tree") throw new NativeMetadataSaveError("CONFLICT");
  return item.metadata;
}
function sameCatalog(a: AnnotationCatalog | undefined, b: AnnotationCatalog | undefined): boolean {
  return a?.version === b?.version && a?.rootId === b?.rootId && a?.token === b?.token
    && (a?.version !== 2 || b?.version === 2 && a.contentProtocol === b.contentProtocol);
}
type AnnotationReadableBlock = Pick<NativeSnapshotBlock, "id" | "properties" | "content">;
function value(block: Pick<AnnotationReadableBlock, "properties">, name: string): any { return block.properties.find((property) => property.name === name)?.value; }
function plainContent(block: Pick<AnnotationReadableBlock, "content">): string {
  if (!(block.content ?? []).every((fragment) => fragment.t === "t" && typeof fragment.v === "string" && !fragment.f && !fragment.fa)) {
    throw new Error("注释包含未支持的富文本，未覆盖这些内容。");
  }
  return (block.content ?? []).map((fragment) => fragment.v).join("");
}
export function annotationRecord(block: AnnotationReadableBlock): AnnotationRecord | undefined {
  const meta = value(block, ITEM_PROPERTY) as AnnotationMetadata | undefined;
  if (!meta) return;
  if (meta.version !== 1 || !Number.isSafeInteger(meta.ownerRootId) || !Number.isSafeInteger(meta.revision) || meta.revision < 1
    || !["active", "recycled", "archived"].includes(meta.state) || typeof meta.comment !== "string"
    || typeof meta.createdAt !== "number" || !Number.isFinite(meta.createdAt) || meta.createdAt < 0
    || typeof meta.updatedAt !== "number" || !Number.isFinite(meta.updatedAt) || meta.updatedAt < 0
    || [meta.recycledAt, meta.archivedAt].some(time => time != null && (typeof time !== "number" || !Number.isFinite(time) || time < 0))) throw new Error(`注释 ${block.id} 的记录格式损坏，未自动改写。`);
  return { id: block.id, ownerRootId: meta.ownerRootId, text: plainContent(block), comment: meta.comment,
    state: meta.state, revision: meta.revision, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
    ...(meta.recycledAt != null ? { recycledAt: meta.recycledAt } : {}), ...(meta.archivedAt != null ? { archivedAt: meta.archivedAt } : {}) };
}
function metadata(record: AnnotationRecord): AnnotationMetadata {
  const { id: _id, text: _text, ...rest } = record;
  return { version: 1, ...rest };
}
function validateFields(text: string, comment: string): void {
  if (typeof text !== "string" || typeof comment !== "string" || text.length > 50_000 || comment.length > 50_000) throw new Error("注释与整条批注均需为不超过50000字符的纯文本，未截断原内容。");
}
function property(record: AnnotationRecord): BlockProperty { return { name: ITEM_PROPERTY, type: 0, value: metadata(record) }; }
export function isAnnotationStorage(block: Pick<NativeSnapshotBlock, "properties">): boolean { return !!value(block, STORE_PROPERTY) || !!value(block, ITEM_PROPERTY); }
function parsePreferences(raw: string | null): ScopePreferences {
  if (raw == null) return clone(DEFAULT_PREFERENCES);
  const parsed = JSON.parse(raw);
  if (parsed?.version !== 1 || !Array.isArray(parsed.roots) || !parsed.roots.every(Number.isSafeInteger)) throw new Error("注释归集配置损坏，未覆盖原配置。");
  return { version: 1, roots: [...new Set<DbId>(parsed.roots)], placement: parsed.placement === "right" ? "right" : "bottom",
    navigatorVisible: parsed.navigatorVisible !== false, footerVisible: parsed.footerVisible !== false,
    directoryClick: parsed.directoryClick === "footer" ? "footer" : "body",
    triggerSymbol: footnoteTrigger(parsed.triggerSymbol),
    footerStyle: parsed.footerStyle === "heading" ? "heading" : "rule", title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 80) : DEFAULT_PREFERENCES.title,
    excerptLength: Math.max(24, Math.min(500, Number(parsed.excerptLength) || 100)), locationMode: parsed.locationMode === "highlight" ? "highlight" : "choose",
    historyLimit: Math.max(2, Math.min(200, Number(parsed.historyLimit) || 40)),
    archiveDays: Number.isSafeInteger(parsed.archiveDays) && parsed.archiveDays >= 1 ? Math.min(3650, parsed.archiveDays) : null };
}
/** Real SDK port. Construction/load only reads metadata; the store page is created
 * ONLY after explicit create/import. No scan, automatic adoption, or startup cleanup.
 * Native groups are undo groups, not a database/CAS guarantee across windows.
 */
export class OrcaAnnotationRepository {
  readonly repository: string;
  readonly namespace: string;
  readonly values: DurableValues;
  /** Independent schema-2 recovery journal; legacy schema-1 history is untouched. */
  readonly nativeJournal: NativeSnapshotJournal;
  private catalog?: AnnotationCatalog;
  private contentCatalogLoaded = false;
  private preferencesValue: ScopePreferences = clone(DEFAULT_PREFERENCES);
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  constructor(readonly api: Orca, readonly pluginName: string, private readonly source: () => SourceContext | undefined,
    private readonly now: () => number = Date.now,
    private readonly nativeAccess?: () => NativeMetadataWriteAccess | undefined) {
    this.repository = repoKey(api);
    this.namespace = `vnext:1:${encodeURIComponent(this.repository)}`;
    this.values = {
      read: async (key) => { this.assertRepo(); const raw = await api.plugins.getData(pluginName, `${this.namespace}:${key}`); this.assertRepo();
        if (raw == null) return null; if (typeof raw !== "string") throw new Error("注释持久数据类型未知，未覆盖。"); return raw; },
      write: async (key, raw) => { this.assertRepo(); await api.plugins.setData(pluginName, `${this.namespace}:${key}`, raw); this.assertRepo(); },
      remove: async (key) => { this.assertRepo(); await api.plugins.removeData(pluginName, `${this.namespace}:${key}`); this.assertRepo(); },
    };
    this.nativeJournal = new NativeSnapshotJournal(this.values, this.namespace);
  }
  get preferences(): ScopePreferences { return this.preferencesValue; }
  get storageRootId(): DbId | undefined { return this.catalog?.rootId; }
  /** Read-side branch only. Fresh list/read APIs still authenticate identity. */
  get contentProtocolVersion(): 1 | 2 | undefined { return this.catalog?.version; }
  assertRepo(): void {
    if (this.stopped || repoKey(this.api) !== this.repository) throw new Error("注释会话已结束或笔记库已切换，已停止继续写入；请在原库核对草稿。");
  }
  private sharedSerial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => { this.assertRepo(); return action(); }); this.queue = result.catch(() => {}); return result;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    return this.sharedSerial(async () => { await this.legacyStore(); return action(); });
  }
  private cache(rows: any): void {
    if (!Array.isArray(rows)) return;
    for (const block of rows) if (block && Number.isSafeInteger(block.id) && Array.isArray(block.children)
      && JSON.stringify(this.api.state.blocks[block.id]) !== JSON.stringify(block)) this.api.state.blocks[block.id] = block;
  }
  private announce(ids: DbId[]): void { this.api.broadcasts?.broadcast?.("refresh-blocks", ids); }
  async load(): Promise<void> {
    const [catalog, preferences] = await Promise.all([this.values.read("catalog"), this.values.read("preferences")]);
    this.catalog = catalog == null ? undefined : parseAnnotationCatalog(JSON.parse(catalog));
    this.preferencesValue = parsePreferences(preferences);
    this.contentCatalogLoaded = true;
  }
  async savePreferences(patch: Partial<ScopePreferences>): Promise<void> {
    await this.serial(async () => { const next = parsePreferences(JSON.stringify({ ...this.preferencesValue, ...patch, version: 1 }));
      await this.values.write("preferences", JSON.stringify(next)); this.preferencesValue = next; });
  }
  async block(id: DbId): Promise<Block | undefined> {
    this.assertRepo(); const result = await this.api.invokeBackend("get-block", id) as Block | null | undefined; this.assertRepo();
    if (result && result.id !== id) throw new Error("读取到不匹配的块。");
    if (result) this.cache([result]); return result ? clone(result) : undefined;
  }
  /** Fresh, detached native-tree read with NO cache refresh or broadcasts.
   * Never use the legacy block()/blocks() refresh path to verify pending native
   * content: it can replace newer live rows with an older persisted response.
   * This is not a flush/atomic snapshot/ownership check or a write permission.
   * Callers still verify catalog/source, input generation and durable content.
   * No V2 schema, migration or editing entry is enabled by this read API. */
  async readPersistedNativeNote(rootId: DbId, limits?: Partial<NativeSnapshotLimits>): Promise<NativeNoteSnapshot> {
    this.assertRepo();
    if (!Number.isSafeInteger(rootId)) throw new TypeError("原生注释根身份无效。");
    const rows: unknown = await this.api.invokeBackend("get-block-tree", rootId);
    this.assertRepo();
    if (!Array.isArray(rows)) throw new Error("原生注释持久树格式未知，未刷新或覆盖活跃内容。");
    const snapshot = captureNativeNoteSnapshot(rootId, rows, limits);
    this.assertRepo();
    return snapshot;
  }
  async blocks(ids: readonly DbId[]): Promise<Block[]> {
    this.assertRepo(); const out: Block[] = [];
    for (let i = 0; i < ids.length; i += 150) { const batch = ids.slice(i, i + 150), rows = await this.api.invokeBackend("get-blocks", batch) as Block[];
      this.assertRepo(); if (!Array.isArray(rows) || rows.some((row) => !batch.includes(row.id))) throw new Error("批量读取块的格式未知。"); this.cache(rows); out.push(...clone(rows)); }
    return out;
  }
  private async uncachedBlocks(ids: readonly DbId[]): Promise<Block[]> {
    const out: Block[] = [];
    for (let i = 0; i < ids.length; i += 150) {
      this.assertRepo(); const batch = ids.slice(i, i + 150), rows = await this.api.invokeBackend("get-blocks", batch) as Block[]; this.assertRepo();
      if (!Array.isArray(rows) || rows.length !== batch.length || rows.some(row => !row || !batch.includes(row.id))
        || new Set(rows.map(row => row.id)).size !== batch.length) throw new Error("批量读取块不完整或格式未知。");
      out.push(...rows);
    }
    return out;
  }
  private async currentCatalog(): Promise<AnnotationCatalog | undefined> {
    const raw = await this.values.read("catalog");
    return raw == null ? undefined : parseAnnotationCatalog(JSON.parse(raw));
  }
  private async uncachedBlock(id: DbId): Promise<Block | undefined> {
    this.assertRepo(); const block = await this.api.invokeBackend("get-block", id) as Block | null | undefined; this.assertRepo();
    if (block && block.id !== id) throw new Error("读取到不匹配的块。");
    return block ?? undefined;
  }
  private async verifiedStore(catalog: AnnotationCatalog): Promise<Block> {
    const block = await this.uncachedBlock(catalog.rootId);
    try {
      if (!block) throw new NativeAnnotationFormatError("INVALID_STORE", catalog.rootId);
      validateAnnotationStore(block, catalog);
      if (!Array.isArray(block.children) || !Array.from(block.children).every(Number.isSafeInteger)
        || new Set(block.children).size !== block.children.length || value(block, "_repr")?.type !== STORE_REPR)
        throw new NativeAnnotationFormatError("INVALID_STORE", catalog.rootId);
    } catch (error) {
      if (!(error instanceof NativeAnnotationFormatError)) throw error;
      throw new NativeAnnotationFormatError(error.code, catalog.rootId, "独立注释资料库不可用；未把其他正文当作资料库。", { cause: error });
    }
    return block!;
  }
  /** Fresh negative old-writer gate. No cache refresh, adoption or token repair.
   * This is a point-in-time check, NOT a cross-window writer lock/CAS. */
  private async legacyStore(): Promise<Block | undefined> {
    const fresh = await this.currentCatalog();
    if (fresh?.version === 2 || this.catalog?.version === 2)
      throw new NativeAnnotationFormatError("LEGACY_TEXT_FORBIDDEN", fresh?.rootId ?? this.catalog?.rootId, "原生内容资料库不能通过旧文本接口改写。");
    if (!sameCatalog(fresh, this.catalog)) throw new NativeAnnotationFormatError("STORE_MISMATCH", fresh?.rootId, "注释资料库索引已变化，未沿用旧会话改写。");
    return fresh ? this.verifiedStore(fresh) : undefined;
  }
  private async root(): Promise<Block | undefined> {
    // No catalog means a read-only empty V1 view; never scan/adopt lookalikes.
    if (!this.catalog) return;
    const block = await this.legacyStore();
    if (block) this.cache([block]); return block ? clone(block) : undefined;
  }
  /** Complete, freshly authenticated READ facade. Native rows/metadata are
   * detached by the lossless codec and NEVER cached/broadcast or flattened.
   * Published is still a declaration, not completed-operation/edit authority;
   * callers must separately resolve catalog/state/Source/unique-M permissions.
   * Multiple reads do not create an atomic tree/database snapshot. */
  async readContent(id: DbId, limits?: Partial<NativeSnapshotLimits>): Promise<AnnotationContentRead> {
    return this.readContentChecked(id, limits);
  }
  private async readContentChecked(id: DbId, limits?: Partial<NativeSnapshotLimits>, fence: () => void = () => {}): Promise<AnnotationContentRead> {
    this.assertRepo(); fence();
    if (!Number.isSafeInteger(id)) throw new NativeAnnotationFormatError("INVALID_BLOCK", undefined, "条目身份无效。");
    const catalog = await this.currentCatalog(); fence();
    if (!catalog || !sameCatalog(catalog, this.catalog)) throw new NativeAnnotationFormatError("STORE_MISMATCH", id, "注释资料库索引已变化或尚未加载。");
    const before = await this.verifiedStore(catalog); fence();
    if (!before.children.includes(id)) throw new NativeAnnotationFormatError("STORE_MISMATCH", id, "条目不在已验证资料库中。");
    const snapshot = await this.readPersistedNativeNote(id, limits); fence();
    const block = snapshot.blocks[0];
    const item = readAnnotationMetadata(block);
    if (!item || block.parent !== catalog.rootId || value(block, "_repr")?.type !== ITEM_REPR)
      throw new NativeAnnotationFormatError("INVALID_METADATA", id, "条目不属于已验证资料库。");
    const afterCatalog = await this.currentCatalog(); fence();
    if (!sameCatalog(catalog, afterCatalog)) throw new NativeAnnotationFormatError("STORE_MISMATCH", id, "读取期间资料库已变化。");
    const after = await this.verifiedStore(afterCatalog!); fence();
    if (!after.children.includes(id)) throw new NativeAnnotationFormatError("STORE_MISMATCH", id, "读取期间条目已移出资料库。");
    this.assertRepo();
    if (item.kind === "native-tree") {
      if (catalog.version !== 2 || !item.isPublished) throw new NativeAnnotationFormatError("LEGACY_TEXT_FORBIDDEN", id, "原生条目尚未发布或资料库协议未升级。");
      const signature = nativeContentSignature(snapshot, limits);
      return { kind: "native-tree", id, metadata: item.metadata, snapshot, signature, checkpointMatches: item.metadata.contentStamp.value === signature };
    }
    const record = annotationRecord(block);
    if (!record) throw new NativeAnnotationFormatError("MISSING_METADATA", id);
    return { kind: "plain-text", record, snapshot };
  }
  /** First-opening persistent recovery evidence ONLY, never Source/children or
   * render/input permission. Explicit prepare may append schema-2 history; an
   * ordinary check-existing/refresh never silently creates a baseline. No
   * canonical command, metadata dispatcher, live cache or legacy text gate.
   * This bounded A/history/B observation is NOT a cross-window lock or flush. */
  async prepareNativeOpening(request: NativeOpeningBaselineRequest, fence: () => void): Promise<NativeOpeningBaselineResult> {
    const input = captureNativeOpeningRequest(request, fence); // Before ANY await/FIFO wait; never execute request getters.
    return this.sharedSerial(async () => {
      const check = () => { this.assertRepo(); fence(); };
      const fresh = async (): Promise<NativeOpeningBaselineContent> => {
        check(); const content = await this.readContentChecked(input.itemId, undefined, check); check();
        assertNativeOpeningContent(content, input.itemId); return content;
      };
      check(); const before = await fresh(); check();
      const wire = nativeOpeningSnapshotWire(before.snapshot);
      let observation: NativeSnapshotHistoryObservation | undefined;
      try {
        observation = await this.nativeJournal.observeHistory(input.itemId, check); check();
        let matchedOperationId = findNativeOpeningCheckpoint(observation.entries, before, wire), appended = false;
        if (matchedOperationId === undefined && input.mode === "prepare") {
          const at = this.now();
          if (typeof at !== "number" || !Number.isFinite(at) || Object.is(at, -0) || at < 0 || at > 8_640_000_000_000_000)
            throw new NativeOpeningBaselineError("INVALID_CLOCK", input.itemId);
          const expected = { operationId: input.operationId, at, reason: "save" as const };
          check();
          // Save the FIRST complete observed A. No rebase, canonical mutation,
          // retry, rollback, or cleanup if this write succeeds and then rejects.
          const receipt = await this.nativeJournal.appendCheckpoint({ rootId: input.itemId, ...expected,
            revision: before.metadata.revision, comment: before.metadata.comment, snapshot: before.snapshot }, check);
          check(); observation.close();
          // A resolved receipt is not evidence. Independently reread the exact
          // proposed entry and retain its SAME-INSTANCE observation through B.
          observation = await this.nativeJournal.observeHistory(input.itemId, check); check();
          matchedOperationId = findNativeOpeningCheckpoint(observation.entries, before, wire, expected);
          if (matchedOperationId === undefined) throw new NativeOpeningBaselineError("BASELINE_NOT_RETAINED", input.itemId);
          appended = receipt === "appended";
        }
        // Even needs-baseline is a detached, freshly rechecked observation.
        check(); let after = await fresh(); check();
        if (nativeOpeningSnapshotWire(after.snapshot) !== wire) throw new NativeOpeningBaselineError("CONTENT_CHANGED", input.itemId);
        if (matchedOperationId !== undefined && !observation.isCurrent()) {
          // One bounded READ reconciliation of a known local history change;
          // never automatically append/rebase/retry the write. Non-evicting
          // appends can retain A; completed pruning must not return stale ready.
          observation.close();
          observation = await this.nativeJournal.observeHistory(input.itemId, check); check();
          matchedOperationId = findNativeOpeningCheckpoint(observation.entries, before, wire);
          // Reconciliation introduced an await after B. Close that interval
          // with one fresh B2; still compare to original A, never a new base.
          after = await fresh(); check();
          if (nativeOpeningSnapshotWire(after.snapshot) !== wire) throw new NativeOpeningBaselineError("CONTENT_CHANGED", input.itemId);
        }
        check();
        if (matchedOperationId !== undefined && !observation.isCurrent())
          throw new NativeOpeningBaselineError("HISTORY_OBSERVATION_CHANGED", input.itemId);
        const result: NativeOpeningBaselineResult = matchedOperationId === undefined
          ? Object.freeze({ kind: "needs-baseline", content: after, wire })
          : Object.freeze({ kind: "ready", content: after, wire, matchedOperationId, appended });
        return result;
      } finally { observation?.close(); }
    });
  }
  /** Complete fresh read pool for the canonical bridge, NOT the bridge itself,
   * a unique-M/Context/D, a render/edit lease, or V2 UI completion. No legacy
   * list/block/blocks/cache/broadcast path is used. Each accepted item uses the
   * real readContent facade; untyped/prepared roots never fetch their trees.
   * Catalog/Store membership and order are reauthenticated, but multi-read item
   * contents are NOT a cross-item atomic snapshot/CAS. External publication of
   * an excluded prepared root is observed by a caller-subscribed later refresh. */
  async readContentCatalog(options?: AnnotationContentCatalogLimits): Promise<AnnotationContentCatalogRead> {
    this.assertRepo();
    const limits = contentCatalogLimits(options); // Capture/validate BEFORE any IO; never execute option getters.
    if (!this.contentCatalogLoaded) throw new NativeAnnotationFormatError("STORE_MISMATCH", undefined, "注释资料库索引尚未加载。");
    const catalog = await this.currentCatalog();
    if (!sameCatalog(catalog, this.catalog)) throw new NativeAnnotationFormatError("STORE_MISMATCH", catalog?.rootId, "注释资料库索引已变化。");
    if (!catalog) {
      // No catalog is a read-only empty view, not permission to create/scan/adopt.
      const after = await this.currentCatalog();
      if (!sameCatalog(catalog, after) || !sameCatalog(catalog, this.catalog))
        throw new NativeAnnotationFormatError("STORE_MISMATCH", after?.rootId, "读取期间资料库索引已变化。");
      this.assertRepo();
      return { catalog: undefined, contents: [], excludedPreparedIds: [] };
    }
    const before = await this.verifiedStore(catalog), children = [...before.children];
    if (children.length > limits.maxItems) throw new RangeError("注释清单 item 资源限制超出；未截断或发布部分清单。");
    const roots = await this.uncachedBlocks(children), byId = new Map(roots.map(block => [block.id, block]));
    const contents: AnnotationContentRead[] = [], excludedPreparedIds: DbId[] = [];
    let totalRows = 0, totalWireCodeUnits = 0;
    // Authenticate every typed root before the first full-tree read. Missing
    // ITEM is skippable; present malformed/null/future/duplicate ITEM is not.
    const accepted: DbId[] = [];
    for (const id of children) {
      const block = byId.get(id), item = readAnnotationMetadata(block);
      if (!item) continue;
      if (block!.parent !== catalog.rootId || value(block!, "_repr")?.type !== ITEM_REPR)
        throw new NativeAnnotationFormatError("INVALID_METADATA", id, "条目不属于已验证资料库。");
      if (item.kind === "native-tree") {
        if (catalog.version !== 2) throw new NativeAnnotationFormatError("LEGACY_TEXT_FORBIDDEN", id, "原生条目的资料库协议尚未升级。");
        if (!item.isPublished) { excludedPreparedIds.push(id); continue; }
      }
      accepted.push(id);
    }
    for (const id of accepted) {
      const content = await this.readContent(id, limits.snapshotLimits);
      totalRows += content.snapshot.blocks.length;
      if (totalRows > limits.maxTotalRows) throw new RangeError("注释清单 aggregate rows 资源限制超出；未发布部分清单。");
      // Measure ONLY the codec wire tuples, never JSON-flatten raw Block/Date.
      totalWireCodeUnits += JSON.stringify(encodeNativeNoteSnapshot(content.snapshot, limits.snapshotLimits)).length;
      if (totalWireCodeUnits > limits.maxTotalWireCodeUnits) throw new RangeError("注释清单 aggregate wire code units 资源限制超出；未发布部分清单。");
      contents.push(content);
    }
    const afterCatalog = await this.currentCatalog();
    if (!sameCatalog(catalog, afterCatalog) || !sameCatalog(catalog, this.catalog))
      throw new NativeAnnotationFormatError("STORE_MISMATCH", catalog.rootId, "读取期间资料库索引已变化。");
    const after = await this.verifiedStore(afterCatalog!);
    if (after.children.length !== children.length || children.some((id, index) => after.children[index] !== id))
      throw new NativeAnnotationFormatError("STORE_MISMATCH", catalog.rootId, "读取期间资料库成员或顺序已变化；未发布不完整清单。");
    // Also catch catalog replacement during the last Store IO. This remains a
    // bounded sequence of observations, not a cross-window lock or atomic read.
    const finalCatalog = await this.currentCatalog();
    if (!sameCatalog(catalog, finalCatalog) || !sameCatalog(catalog, this.catalog))
      throw new NativeAnnotationFormatError("STORE_MISMATCH", catalog.rootId, "读取期间资料库索引已变化。");
    this.assertRepo();
    return { catalog, contents, excludedPreparedIds };
  }
  /** All request data is detached/captured before the first await or queue.
   * A no-op still needs explicit dispatch ACCESS, but never sends an empty command. */
  async saveComment(request: NativeMetadataCommentRequest, claim: NativeMetadataClaim): Promise<NativeMetadataSaveResult> {
    const itemId = request.itemId, comment = request.comment, baseline = metadataBaseline(request.expectedMetadata);
    if (!Number.isSafeInteger(itemId) || typeof comment !== "string") throw new NativeMetadataSaveError("CONFLICT");
    return this.writeNativeMetadata(itemId, "comment", claim, baseline, { comment });
  }
  async checkpointNative(request: NativeMetadataCheckpointRequest, claim: NativeMetadataClaim): Promise<NativeMetadataSaveResult> {
    const itemId = request.itemId, operationId = request.operationId, expectedInputEpoch = request.expectedInputEpoch;
    const expected = decodeNativeNoteSnapshot(encodeNativeNoteSnapshot(request.expectedSnapshot));
    if (expected.rootId !== itemId || !Number.isSafeInteger(expectedInputEpoch) || expectedInputEpoch < 0
      || typeof operationId !== "string" || !operationId.trim() || operationId.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(operationId))
      throw new NativeMetadataSaveError("CONFLICT");
    return this.writeNativeMetadata(itemId, "checkpoint", claim, metadataBaseline(snapshotMetadata(expected)),
      { expected, operationId, expectedInputEpoch });
  }
  /** Read the COMPLETE live N/C graph synchronously without fetching, refreshing,
   * traversing references, or replacing any live cache row. Equality here is NOT
   * a settled DOM/input proof. Unknown codec/proxy errors propagate unchanged. */
  private liveNativeSnapshot(itemId: DbId, dispatched: boolean): NativeNoteSnapshot {
    const rows: Block[] = [], pending = [itemId], seen = new Set<DbId>();
    while (pending.length) {
      const id = pending.pop()!, row = this.api.state.blocks[id];
      if (!Number.isSafeInteger(id) || seen.has(id) || !row || row.id !== id || !Array.isArray(row.children)
        || rows.length >= NATIVE_SNAPSHOT_LIMITS.maxRows || rows.length + pending.length + row.children.length + 1 > NATIVE_SNAPSHOT_LIMITS.maxRows)
        throw new NativeMetadataSaveError(dispatched ? "POST_VERIFY" : "CONTENT_CHANGED", dispatched);
      seen.add(id); rows.push(row);
      for (let i = row.children.length - 1; i >= 0; i--) pending.push(row.children[i]);
    }
    return captureNativeNoteSnapshot(itemId, rows);
  }
  private async writeNativeMetadata(itemId: DbId, purpose: NativeMetadataPurpose, claim: NativeMetadataClaim, baseline: string,
    request: { readonly comment: string } | { readonly expected: NativeNoteSnapshot; readonly operationId: string; readonly expectedInputEpoch: number }): Promise<NativeMetadataSaveResult> {
    // Default CLOSED, even on an apparent no-op. Capture the explicit controlled
    // port once; neither old editor()/backend nor a broad affected recache is safe.
    const access = this.nativeAccess?.(), dispatch = access?.dispatch;
    if (!(access?.claims instanceof NativeMetadataClaims) || typeof dispatch !== "function") throw new NativeMetadataSaveError("DISPATCH_UNAVAILABLE");
    const permit = access.claims.consume(claim, itemId, purpose);
    try {
      return await permit.action.enqueue(nativeGuard => this.sharedSerial(async () => {
        type NativeRead = Extract<AnnotationContentRead, { kind: "native-tree" }>;
        let current: NativeRead | undefined, canonicalDispatched = false;
        const fence = () => {
          this.assertRepo(); nativeGuard.assertCurrent();
          if (current) permit.assertCurrent(current, canonicalDispatched);
        };
        const fresh = async (): Promise<NativeRead> => {
          fence(); let item: AnnotationContentRead;
          try { item = await this.readContentChecked(itemId, undefined, fence); }
          catch (error) {
            if (canonicalDispatched && error instanceof NativeAnnotationFormatError) throw new NativeMetadataSaveError("POST_VERIFY", true);
            throw error; // Unknown IO/guard/producer errors keep their exact identity.
          }
          if (item.kind !== "native-tree") throw new NativeMetadataSaveError(canonicalDispatched ? "POST_VERIFY" : "CONFLICT", canonicalDispatched);
          current = item; fence(); return item;
        };
        const matches = (snapshot: NativeNoteSnapshot, expectedMetadata: string, signature: string, code: NativeMetadataSaveErrorCode, wrapper: string) => {
          let actual: NativeTreeAnnotationMetadata;
          try { actual = snapshotMetadata(snapshot); }
          catch (error) {
            if (error instanceof NativeAnnotationFormatError || error instanceof NativeMetadataSaveError) throw new NativeMetadataSaveError(code, canonicalDispatched);
            throw error;
          }
          if (metadataBaseline(actual) !== expectedMetadata || nativeContentSignature(snapshot) !== signature
            || propertyBaseline(snapshotProperty(snapshot)) !== wrapper)
            throw new NativeMetadataSaveError(code, canonicalDispatched);
        };
        const input = (item: NativeRead, wrapper: string) => {
          if (!("expected" in request)) return;
          // The authority owns capture/provenance. Older permits without this
          // explicit observation generation remain CLOSED, never guessed settled.
          const epoch = permit.inputEpoch;
          if (epoch !== request.expectedInputEpoch) throw new NativeMetadataSaveError("CONFLICT");
          matches(permit.inputSnapshot(), baseline, item.signature, "CONTENT_CHANGED", wrapper);
        };
        const checkBefore = (item: NativeRead, wrapper: string) => {
          if (metadataBaseline(item.metadata) !== baseline) throw new NativeMetadataSaveError("CONFLICT");
          if ("expected" in request && nativeContentSignature(request.expected) !== item.signature) throw new NativeMetadataSaveError("CONTENT_CHANGED");
          input(item, wrapper); fence();
          // LAST synchronous read follows callbacks that may themselves observe
          // Source/input. No awaits or preparation after this before dispatch.
          matches(this.liveNativeSnapshot(itemId, false), baseline, item.signature, "CONTENT_CHANGED", wrapper);
        };
        const before = await fresh(), beforeWrapper = propertyBaseline(snapshotProperty(before.snapshot));
        checkBefore(before, beforeWrapper);
        const at = this.now();
        if (typeof at !== "number" || !Number.isFinite(at) || Object.is(at, -0) || at < 0 || at > 8_640_000_000_000_000)
          throw new NativeMetadataSaveError("CONFLICT");
        const change = prepareNativeMetadataChange(before.snapshot, "comment" in request ? { comment: request.comment, updatedAt: at } : { checkpoint: true, updatedAt: at });
        let checkpoint: NativeMetadataSaveResult["checkpoint"];
        if ("expected" in request) {
          fence();
          // BEFORE, not the proposed header. A retained copy is not a completion
          // receipt; failure after storage may leave it present. Never clean it
          // up or retry/roll back native commands automatically.
          const appended = await this.nativeJournal.appendCheckpoint({ rootId: itemId, operationId: request.operationId,
            revision: before.metadata.revision, at, comment: before.metadata.comment, reason: "save", snapshot: change.before }, fence);
          fence(); checkpoint = { operationId: request.operationId, appended: appended === "appended" };
        }
        // Reauthenticate both catalog/Store and durable/live/input baselines after
        // every recovery IO and preparation. Neither stamp nor revision is CAS.
        const last = await fresh();
        // The proposal (including UNKNOWN property-wrapper fields) belongs to
        // the FIRST complete tree. Re-preparing it from a later live/cache tree
        // would silently rebase an old intent; using it on a newer tree could
        // overwrite wrapper data even when ITEM metadata itself is unchanged.
        if (last.signature !== before.signature || propertyBaseline(snapshotProperty(last.snapshot)) !== beforeWrapper)
          throw new NativeMetadataSaveError("CONTENT_CHANGED");
        checkBefore(last, beforeWrapper);
        if (change.changed) {
          // Final synchronous three fences; calling the port marks uncertainty
          // BEFORE its body runs (a rejected command may have partially applied).
          fence(); matches(this.liveNativeSnapshot(itemId, false), baseline, last.signature, "CONTENT_CHANGED", beforeWrapper);
          canonicalDispatched = true;
          await dispatch(permit.action.source, itemId, change.property);
          fence(); const after = await fresh();
          const proposedMetadata = metadataBaseline(change.metadata), proposedWrapper = propertyBaseline(change.property);
          if (metadataBaseline(after.metadata) !== proposedMetadata || after.signature !== change.signature
            || propertyBaseline(snapshotProperty(after.snapshot)) !== proposedWrapper)
            throw new NativeMetadataSaveError("POST_VERIFY", true);
          fence(); matches(this.liveNativeSnapshot(itemId, true), proposedMetadata, change.signature, "POST_VERIFY", proposedWrapper);
          return { kind: "native-metadata", itemId, metadata: after.metadata, signature: after.signature, changed: true, ...(checkpoint ? { checkpoint } : {}) };
        }
        return { kind: "native-metadata", itemId, metadata: last.metadata, signature: last.signature, changed: false, ...(checkpoint ? { checkpoint } : {}) };
      }));
    } finally { permit.close(); }
  }
  private async createBlock(parent: Block | null, text: string, repr: Record<string, any>): Promise<Block> {
    this.assertRepo(); const [block, , affected] = await this.api.invokeBackend("create-block", parent?.id ?? null, parent?.children.at(-1) ?? null,
      undefined, undefined, repr, text ? [{ t: "t", v: text }] : null, text || null);
    this.assertRepo(); if (!block || !Number.isSafeInteger(block.id)) throw new Error("注释创建未返回有效块。");
    this.cache([block, ...(affected ?? [])]); this.announce([block.id, ...(parent ? [parent.id] : [])]); return clone(block);
  }
  private async writeProperties(id: DbId, properties: BlockProperty[]): Promise<void> {
    this.assertRepo(); const [, affected] = await this.api.invokeBackend("set-properties", [id], properties); this.assertRepo(); this.cache(affected); this.announce([id]);
  }
  private async writeText(id: DbId, text: string): Promise<void> {
    this.assertRepo(); const [, affected] = await this.api.invokeBackend("set-blocks-content", [{ id, content: text ? [{ t: "t", v: text }] : null,
      text: text || null, modified: new Date(this.now()) }]); this.assertRepo(); this.cache(affected); this.announce([id]);
  }
  private async removeNewBlock(block: Block): Promise<void> {
    const current = await this.block(block.id);
    if (!current || JSON.stringify(current.content ?? []) !== JSON.stringify(block.content ?? []) || current.backRefs.length || current.children.length) return;
    const [, affected] = await this.api.invokeBackend("delete-blocks", [block.id]); this.assertRepo(); this.cache(affected); this.api.state.blocks[block.id] = undefined; this.announce([block.id]);
  }
  private async ensureRoot(): Promise<Block> {
    const existing = await this.root(); if (existing) return existing;
    const created = await this.createBlock(null, "注释资料库（由脚注插件管理）", { type: STORE_REPR, cap: "注释资料库" });
    const catalog = { version: 1 as const, rootId: created.id, token: crypto.randomUUID() };
    try { await this.writeProperties(created.id, [{ name: STORE_PROPERTY, type: 0, value: { version: 1, token: catalog.token } }]);
      await this.values.write("catalog", JSON.stringify(catalog)); this.catalog = catalog;
    } catch (error) { await this.removeNewBlock(created).catch(() => {}); throw error; }
    return (await this.block(created.id))!;
  }
  async list(): Promise<AnnotationRecord[]> {
    const root = await this.root(); if (!root) return [];
    const rows = await this.uncachedBlocks(root.children), accepted: Block[] = [];
    const records = rows.flatMap(block => {
      const item = readAnnotationMetadata(block); if (!item) return [];
      assertLegacyTextFormat(block, this.catalog);
      if (block.parent !== root.id || value(block, "_repr")?.type !== ITEM_REPR) throw new Error("清单条目不属于已验证的注释资料库，未发布不完整清单。");
      const record = annotationRecord(block); if (!record) return [];
      accepted.push(block); return [record];
    });
    // Unknown/untyped rows are NOT permission to replace a newer live row.
    this.cache(accepted); return records;
  }
  async get(id: DbId): Promise<AnnotationRecord> {
    const root = await this.root(), block = await this.uncachedBlock(id);
    if (block) assertLegacyTextFormat(block, this.catalog);
    const record = block && annotationRecord(block);
    if (!root || !record || block!.parent !== root.id || !root.children.includes(id)
      || value(block!, "_repr")?.type !== ITEM_REPR) throw new Error("这条注释已不存在或不属于已验证的注释资料库。");
    this.cache([block]); return record;
  }
  async create(ownerRootId: DbId, text = "", comment = ""): Promise<AnnotationRecord> {
    validateFields(text, comment);
    return this.serial(async () => {
      if (!await this.block(ownerRootId)) throw new Error("正文页面已不存在。");
      const root = await this.ensureRoot(), block = await this.createBlock(root, text, { type: ITEM_REPR, cap: "注释" }), at = this.now();
      const record: AnnotationRecord = { id: block.id, ownerRootId, text, comment, state: "active", revision: 1, createdAt: at, updatedAt: at };
      try { await this.writeProperties(block.id, [property(record)]); } catch (error) { await this.removeNewBlock(block).catch(() => {}); throw error; }
      return this.get(block.id);
    });
  }
  async save(change: ContentSave, base: AnnotationRecord): Promise<AnnotationRecord> {
    validateFields(change.text, change.comment);
    return this.serial(async () => {
      const current = await this.get(change.itemId);
      if (current.state !== "active" || current.revision !== change.baseRevision || current.text !== base.text || current.comment !== base.comment) throw new Error("这条注释在其他位置发生了变化，当前草稿仍已保留，未覆盖新内容。");
      if (current.text === change.text && current.comment === change.comment) return current;
      const next = { ...current, text: change.text, comment: change.comment, revision: current.revision + 1, updatedAt: this.now() };
      let textWritten = false;
      try { if (current.text !== next.text) { await this.writeText(current.id, next.text); textWritten = true; } await this.writeProperties(current.id, [property(next)]); }
      catch (error) {
        if (textWritten) { const latest = await this.get(current.id).catch(() => undefined);
          if (latest?.revision === current.revision && latest.text === next.text) await this.writeText(current.id, current.text).catch(() => {}); }
        throw error;
      }
      return this.get(current.id);
    });
  }
  private editor(): EditorPort {
    this.assertRepo(); const source = this.source();
    const editor = source && this.api.nav.findViewPanel(source.panelId, this.api.state.panels)?.viewState?.editor;
    if (!editor?.invokeCommand || !editor.invokeGroup) throw new Error("请先打开正文页面，再修改引用。");
    const guard = () => {
      this.assertRepo(); const current = this.source();
      if (!source || !current || source.panelId !== current.panelId || source.viewRootId !== current.viewRootId
        || this.api.nav.findViewPanel(current.panelId, this.api.state.panels)?.viewState?.editor !== editor) throw new Error("正文来源已变化，未继续修改引用。");
    };
    return {
      invokeCommand: async (id, cursor, ...args) => { guard(); const result = await editor.invokeCommand(id, cursor, ...args); guard(); return result; },
      invokeGroup: async (action, options) => { guard(); const result = await editor.invokeGroup(action, options); this.assertRepo(); return result; },
    };
  }
  async insert(bookmark: InsertionBookmark, itemId: DbId, validateSource?: () => boolean): Promise<void> {
    await this.serial(async () => {
      const item = await this.get(itemId); if (item.state !== "active" || !item.text.trim()) throw new Error("请先填写注释内容，再插入引用。");
      const context = this.source();
      if (bookmark.cursor.mirror || !context || bookmark.cursor.panelId !== context.panelId || bookmark.cursor.rootBlockId !== context.viewRootId) throw new Error("请在当前源页面中选择引用位置。");
      const cursor = inputInsertionCursor(bookmark, insertionCursor), current = await this.block(cursor.anchor.blockId);
      if (!current || isAnnotationStorage(current) || value(current, "_repr")?.type === "code") throw new Error("请在普通正文中选择引用位置。");
      if (JSON.stringify(current.content ?? []) !== JSON.stringify(bookmark.content)) throw new Error("插入位置已变化，请在正文重新点一下位置；注释内容仍保留。");
      const editor = this.editor();
      await editor.invokeGroup(async () => {
        this.assertRepo(); const existing = current.refs.find((ref) => ref.type === 1 && ref.to === itemId && ref.from === current.id);
        if (!existing) await editor.invokeCommand("core.editor.createRef", cursor, current.id, itemId, 1);
        // Target IO must finish BEFORE the last source read/check. A target read
        // after a checked literal would authorize replacing newly changed prose.
        const target = await this.get(itemId);
        // This last read must NOT cache an older DB snapshot over newer live
        // editor state before comparing it. Both independent views must agree.
        this.assertRepo();
        const fresh = await this.api.invokeBackend("get-block", current.id) as Block | null | undefined;
        this.assertRepo();
        if (fresh && fresh.id !== current.id) throw new Error("读取到不匹配的引用来源块。");
        const cached = this.api.state.blocks[current.id];
        if (!fresh || isAnnotationStorage(fresh) || value(fresh, "_repr")?.type === "code" || target.state !== "active" || !target.text.trim()
          || JSON.stringify(fresh.content ?? []) !== JSON.stringify(bookmark.content)
          || !cached || JSON.stringify(cached.content ?? []) !== JSON.stringify(bookmark.content)
          || (validateSource && !validateSource())) throw new Error("引用位置或注释状态发生了变化，未继续插入。");
        const fragment = makeNativeNoteFragment(fresh, itemId), ownedRef = fresh.refs.find(ref => ref.id === fragment.v)!;
        const liveRef = cached.refs.find(ref => ref.id === ownedRef.id);
        if (liveRef && (liveRef.from !== ownedRef.from || liveRef.to !== ownedRef.to || liveRef.type !== ownedRef.type)) throw new Error("引用关系已变化，未继续插入。");
        // Native insertFragments interprets numeric r.v as a relation-row ID
        // ONLY if the live source owns that row. Add just our verified relation;
        // never refresh stale text/properties over the editor to achieve this.
        if (!liveRef) cached.refs = [...cached.refs, clone(ownedRef)];
        // No more plugin awaits between validation and native dispatch.
        await editor.invokeCommand("core.editor.insertFragments", cursor, [fragment]);
      }, { topGroup: true, undoable: true });
    });
  }
  async referenceSources(id: DbId): Promise<ReferenceSource[]> {
    const root = await this.root(), target = await this.uncachedBlock(id);
    if (!root || !target) throw new Error("注释已不存在。");
    assertLegacyTextFormat(target, this.catalog);
    if (!annotationRecord(target) || target.parent !== root.id || !root.children.includes(id) || value(target, "_repr")?.type !== ITEM_REPR)
      throw new Error("注释不属于已验证的资料库。");
    if (target.backRefs.some((ref) => ref.type !== 1)) throw new Error("这条注释还有非正文引用关系，未自动移除这些关系。");
    const ids = [...new Set(target.backRefs.map((ref) => ref.from))], rows = await this.uncachedBlocks(ids);
    if (rows.length !== ids.length) throw new Error("引用来源缺失，未按不完整关系清理正文。");
    for (const ref of target.backRefs) if (!rows.find(block => block.id === ref.from)?.refs.some(candidate => candidate.id === ref.id && candidate.from === ref.from && candidate.to === id && candidate.type === 1)) throw new Error("引用的正向／反向关系不完整，未清理正文。");
    return rows.map((block) => {
      const relations = block.refs.filter((ref) => ref.to === id && ref.type === 1);
      if (relations.some(ref => !target.backRefs.some(back => back.id === ref.id && back.from === block.id))) throw new Error("引用的反向关系不完整，未清理正文。");
      const indices = (block.content ?? []).flatMap((fragment, index) => fragment.t === "r" && relations.some((ref) => ref.id === fragment.v) ? [index] : []);
      return { block, indices, relationIds: relations.map((ref) => ref.id) };
    });
  }
  async removeOccurrence(blockId: DbId, fragmentIndex: number, expectedTargetId?: DbId, expectedContent?: readonly ContentFragment[]): Promise<void> {
    await this.serial(async () => {
      const block = await this.block(blockId), fragment = block?.content?.[fragmentIndex];
      if (!block || !fragment || !isNativeNoteFragment(fragment)) throw new Error("该处引用已变化。");
      const relation = block.refs.find((ref) => ref.id === fragment.v && ref.from === blockId);
      if (!relation || relation.type !== 1 || (expectedTargetId != null && relation.to !== expectedTargetId) || !(await this.get(relation.to))) throw new Error("引用目标不可用或已变化，未删除其他引用。");
      if (expectedContent && JSON.stringify(block.content ?? []) !== JSON.stringify(expectedContent)) throw new Error("引用所在正文已变化，未删除别处引用。");
      const content = clone(block.content!); content.splice(fragmentIndex, 1); const editor = this.editor();
      await editor.invokeGroup(async () => {
        this.assertRepo(); const latest = await this.block(blockId);
        if (!latest || JSON.stringify(latest.content ?? []) !== JSON.stringify(block.content ?? [])) throw new Error("引用所在正文已变化，未删除别处引用。");
        await editor.invokeCommand("core.editor.setBlocksContent", null, [{ id: blockId, content }], false);
        if (!content.some((entry) => entry.t === "r" && entry.v === relation.id)) await editor.invokeCommand("core.editor.deleteRef", null, { refId: relation.id });
      }, { topGroup: true, undoable: true });
    });
  }
  async recycle(id: DbId): Promise<{ references: number; sources: number }> {
    return this.serial(async () => {
      const current = await this.get(id); if (current.state !== "active") throw new Error("注释已不在使用区。");
      const sources = await this.referenceSources(id), editor = this.editor();
      const next: AnnotationRecord = { ...current, state: "recycled", recycledAt: this.now(), archivedAt: undefined,
        revision: current.revision + 1, updatedAt: this.now() };
      // Explicitly journal this multi-block operation before any source edit. It is
      // not replayed automatically against user prose after an interruption.
      if (await this.values.read(`operation:${id}`) != null) throw new Error("这条注释仍有未处理的恢复日志，未覆盖或重试中断操作。");
      await this.values.write(`operation:${id}`, JSON.stringify({ version: 1, kind: "recycle", before: current,
        sources: sources.map(({ block }) => ({ id: block.id, content: block.content })), at: this.now() }));
      await editor.invokeGroup(async () => {
        this.assertRepo();
        const updates = [];
        for (const source of sources) {
          const latest = await this.block(source.block.id);
          if (!latest || JSON.stringify(latest.content ?? []) !== JSON.stringify(source.block.content ?? [])) throw new Error("引用所在正文已变化，删除未完成；未用旧位置覆盖正文。");
          if (source.indices.length) updates.push({ id: latest.id, content: clone(latest.content ?? []).filter((_, index) => !source.indices.includes(index)) });
        }
        if (updates.length) await editor.invokeCommand("core.editor.setBlocksContent", null, updates, false);
        for (const source of sources) for (const refId of source.relationIds) await editor.invokeCommand("core.editor.deleteRef", null, { refId });
        await editor.invokeCommand("core.editor.setProperties", null, [id], [property(next)]);
      }, { topGroup: true, undoable: true });
      await this.values.remove(`operation:${id}`);
      return { references: sources.reduce((sum, source) => sum + source.indices.length, 0), sources: sources.filter((source) => source.indices.length).length };
    });
  }
  async importLegacy(plan: LegacyImportPlan, selectedIds: ReadonlySet<DbId>): Promise<DbId[]> {
    return this.serial(async () => {
      if (plan.issues.length) throw new Error(`旧格式尚有冲突，未迁移：${plan.issues.join("；")}`);
      const definitions = plan.definitions.filter((definition) => selectedIds.has(definition.blockId));
      if (!definitions.length || definitions.some((definition) => definition.blocked)) throw new Error("请选择可迁移的旧定义。");
      const labels = new Set(definitions.map((definition) => definition.label));
      const sources = plan.sources.filter((source) => source.tokens.some((token) => labels.has(token.label)));
      for (const definition of definitions) {
        const fresh = await this.uncachedBlock(definition.blockId);
        if (fresh) assertLegacyMigrationBlock(fresh);
        if (!fresh || fresh.parent !== definition.source.parent || fresh.children.length
          || JSON.stringify(fresh.content ?? []) !== JSON.stringify(definition.source.content ?? [])) throw new Error("旧定义在预览后发生变化，未迁移。");
      }
      for (const source of sources) {
        const fresh = await this.uncachedBlock(source.block.id);
        if (fresh) assertLegacyMigrationBlock(fresh);
        if (!fresh || JSON.stringify(fresh.content ?? []) !== JSON.stringify(source.block.content ?? [])) throw new Error("正文在迁移预览后发生变化，未迁移。");
      }
      if (await this.values.read("migration-operation") != null) throw new Error("仍有未处理的迁移恢复日志，未覆盖或开始新的迁移。");
      await this.values.write("migration-operation", JSON.stringify({ version: 1, rootId: plan.rootId, at: this.now(), definitions, sources }));
      const root = await this.ensureRoot(), editor = this.editor(), at = this.now();
      await editor.invokeGroup(async () => {
        for (const definition of definitions) {
          this.assertRepo(); const fresh = await this.uncachedBlock(definition.blockId);
          if (fresh) assertLegacyMigrationBlock(fresh);
          if (!fresh || fresh.parent !== definition.source.parent || fresh.children.length || JSON.stringify(fresh.content ?? []) !== JSON.stringify(definition.source.content ?? [])) throw new Error("旧定义发生变化，迁移已停止。");
          const created = new Date(definition.source.created).getTime();
          const record: AnnotationRecord = { id: definition.blockId, ownerRootId: plan.rootId, text: definition.text, comment: "",
            state: "active", revision: 1, createdAt: Number.isFinite(created) ? created : at, updatedAt: at };
          await editor.invokeCommand("core.editor.setBlocksContent", null, [{ id: record.id, content: [{ t: "t", v: record.text }] }], false);
          const afterText = await this.uncachedBlock(record.id);
          if (afterText) assertLegacyMigrationBlock(afterText);
          if (!afterText || afterText.parent !== definition.source.parent || afterText.children.length || plainContent(afterText) !== record.text) throw new Error("旧定义在改写期间发生变化，未移动其内容或子块。");
          await editor.invokeCommand("core.editor.setProperties", null, [record.id], [property(record), { name: "_repr", type: 0, value: { type: ITEM_REPR, cap: "注释" } }]);
          const afterMetadata = await this.uncachedBlock(record.id);
          if (afterMetadata) assertLegacyTextFormat(afterMetadata, this.catalog);
          if (!afterMetadata || afterMetadata.parent !== definition.source.parent || afterMetadata.children.length
            || JSON.stringify(annotationRecord(afterMetadata)) !== JSON.stringify(record)) throw new Error("旧定义在移动前发生变化，未移动其内容或子块。");
          await editor.invokeCommand("core.editor.moveBlocks", null, [record.id], root.id, "lastChild");
        }
        for (const source of sources) {
          this.assertRepo(); const before = await this.uncachedBlock(source.block.id);
          if (before) assertLegacyMigrationBlock(before);
          if (!before || JSON.stringify(before.content ?? []) !== JSON.stringify(source.block.content ?? [])) throw new Error("正文在迁移期间变化，未覆盖正文。");
          const markers = new Map<string, ContentFragment>();
          for (const definition of definitions) if (source.tokens.some((token) => token.label === definition.label)) {
            if (!before.refs.some((ref) => ref.type === 1 && ref.to === definition.blockId)) await editor.invokeCommand("core.editor.createRef", null, before.id, definition.blockId, 1);
            const current = await this.uncachedBlock(before.id); if (!current) throw new Error("引用来源已不存在。");
            assertLegacyMigrationBlock(current);
            markers.set(definition.label, makeNativeNoteFragment(current, definition.blockId));
          }
          const current = await this.uncachedBlock(before.id);
          if (current) assertLegacyMigrationBlock(current);
          if (!current || JSON.stringify(current.content ?? []) !== JSON.stringify(source.block.content ?? [])) throw new Error("正文已变化，未继续迁移引用。");
          const content = replaceLegacyMarkers(current.content ?? [], source.tokens, markers);
          await editor.invokeCommand("core.editor.setBlocksContent", null, [{ id: current.id, content }], false);
        }
      }, { topGroup: true, undoable: true });
      await this.values.remove("migration-operation");
      return definitions.map((definition) => definition.blockId);
    });
  }
  async archive(id: DbId): Promise<void> { await this.serial(async () => { const item = await this.get(id);
    if (item.state !== "recycled") throw new Error("只有回收站条目可以再次删除归档。");
    await this.writeProperties(id, [property({ ...item, state: "archived", archivedAt: this.now(), updatedAt: this.now(), revision: item.revision + 1 })]); }); }
  async recover(id: DbId): Promise<void> { await this.serial(async () => { const item = await this.get(id);
    if (item.state === "active") return;
    await this.writeProperties(id, [property({ ...item, state: "active", recycledAt: undefined, archivedAt: undefined,
      updatedAt: this.now(), revision: item.revision + 1 })]); }); }
  async purgeExpired(): Promise<{ removed: DbId[]; retained: DbId[] }> {
    if (this.preferencesValue.archiveDays == null) { this.assertRepo(); return { removed: [], retained: [] }; }
    return this.serial(async () => {
      const days = this.preferencesValue.archiveDays, removed: DbId[] = [], retained: DbId[] = [];
      if (days == null) return { removed, retained };
      for (const item of await this.list()) if (item.state === "archived" && item.archivedAt != null && this.now() - item.archivedAt >= days * 86_400_000) {
        const block = await this.block(item.id); if (!block) continue;
        const latest = annotationRecord(block);
        if (block.backRefs.length || block.children.length || !latest || latest.state !== "archived"
          || latest.archivedAt == null || this.now() - latest.archivedAt < days * 86_400_000
          || JSON.stringify(latest) !== JSON.stringify(item) || block.parent !== this.catalog?.rootId) { retained.push(item.id); continue; }
        const [, affected] = await this.api.invokeBackend("delete-blocks", [item.id]); this.assertRepo(); this.cache(affected);
        if (await this.block(item.id)) { retained.push(item.id); continue; }
        this.api.state.blocks[item.id] = undefined; removed.push(item.id); this.announce([item.id]);
      }
      return { removed, retained };
    });
  }
  async settle(): Promise<void> { await this.queue; }
  stop(): void { this.stopped = true; }
}
