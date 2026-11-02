import type { NativeTreeAnnotationMetadata } from "./native-content-format";
import { readAnnotationMetadata } from "./native-content-format";
import { decodeNativeNoteSnapshot, encodeNativeNoteSnapshot, nativeContentSignature,
  type NativeNoteSnapshot } from "./native-content-snapshot";
import type { NativeNoteRenderBinding } from "./native-note-renderer";
import { NativeSourceSessions, type NativeSourceActionLease, type NativeSourceIdentity } from "./native-source-session";
import type { NativeTaskGuard } from "./native-task-lease";

export interface NativeMetadataScope {
  readonly panelId: string;
  /** Actual physical Source; a child A/B may share its parent's pool. */
  readonly sourceRootId: number;
  readonly scopeRootId: number;
  /** Complete currently authorized pool, supplied by the Controller/bridge. */
  readonly itemIds: ReadonlySet<number>;
  /** Complete authorized BODY ancestry/subtree owner IDs. Older items owned by
   * A/B remain in P's shared pool without rewriting their original ownership.
   * Absence deliberately restricts to scopeRootId, never the whole catalog. */
  readonly ownerRootIds?: ReadonlySet<number>;
}
export type NativeMetadataPurpose = "comment" | "checkpoint";
/** Trusted read-only bridge/inputTracker port, NOT an authorization DTO from UI
 * events, JSON, content stamps or a live==persisted comparison. The producer
 * independently owns real DOM/input settling, canonical UNIQUE M discovery,
 * subscription retirement, and original Provider/binding provenance. Neither
 * this class nor binding.isCurrent() can establish those facts by shape.
 * currentBindings is the COMPLETE current authorized binding set for this N,
 * not an arbitrary caller-selected singleton. No producer means no checkpoint.
 */
export interface NativeMetadataInputObservation {
  readonly state: "settled" | "pending" | "unknown";
  readonly epoch: number;
  readonly binding: NativeNoteRenderBinding;
  readonly snapshot: NativeNoteSnapshot;
  readonly sourceIdentity: NativeSourceIdentity;
  readonly currentBindings: readonly NativeNoteRenderBinding[];
}
/** Structural subset of repository.readContent's native branch. The repository
 * must obtain it fresh inside its shared queue and validate catalog/Store,
 * canonical parent/representation/membership itself. This shape is NOT a lease,
 * publication proof, DB authorization or substitute for that read boundary. */
export interface NativeMetadataItem {
  readonly kind: "native-tree";
  readonly id: number;
  readonly metadata: NativeTreeAnnotationMetadata;
  readonly snapshot: NativeNoteSnapshot;
  readonly signature: string;
}
export type NativeMetadataAuthorityErrorCode = "INVALID_CLAIM" | "CLAIM_USED" | "CLOSED" | "INVALID_PURPOSE"
  | "TARGET_MISMATCH" | "PURPOSE_MISMATCH" | "SOURCE_UNAVAILABLE" | "SOURCE_CHANGED"
  | "SCOPE_UNAVAILABLE" | "SCOPE_CHANGED" | "ITEM_NOT_IN_SCOPE" | "INVALID_ITEM" | "INVALID_CONTAINER"
  | "OUTSIDE_ACTION" | "INPUT_UNAVAILABLE" | "INPUT_UNSETTLED" | "INPUT_EPOCH" | "INPUT_BINDING"
  | "INPUT_SNAPSHOT" | "INPUT_CHANGED";
export class NativeMetadataAuthorityError extends Error {
  override readonly name = "NativeMetadataAuthorityError";
  constructor(readonly code: NativeMetadataAuthorityErrorCode, readonly dispatched = false) {
    super(`原生注释元数据权限 ${code}。${dispatched
      ? "已派发的命令可能已完成；未自动重试或回滚。" : "未获得本次元数据操作权限。"}`);
  }
}
declare const nativeMetadataClaimBrand: unique symbol;
export interface NativeMetadataClaim {
  readonly [nativeMetadataClaimBrand]: true;
  /** Closing the token also retires its already consumed permit. */
  close(): void;
}
export interface NativeMetadataPermit {
  /** One-shot forwarding facade over the ACTUAL sources.request('edit') lease.
   * Original context/source/guard are retained verbatim. It adds only a callback
   * lifetime fence, never a queue, Context, native dispatch or history boundary.
   * The repository calls enqueue(nativeGuard => sharedRepoQueue(...)) ONCE,
   * awaits that whole bounded operation, and uses BOTH guards after fresh reads.
   * NativeTaskLeaseError.started is callback entry, NOT canonical dispatch. */
  readonly action: NativeSourceActionLease;
  readonly scopeRootId: number;
  /** Exact input generation captured by THIS claim, not a caller DTO field. */
  readonly inputEpoch?: number;
  assertCurrent(item: NativeMetadataItem, dispatched?: boolean): void;
  /** Checkpoint-only; detached COMPLETE observation snapshot, never live data.
   * Still requires a separate fresh readContent/assertCurrent at every write. */
  inputSnapshot(): NativeNoteSnapshot;
  close(): void;
}
type ScopeIdentity = Pick<NativeMetadataScope, "panelId" | "sourceRootId" | "scopeRootId"> & {
  readonly ownerRootIds: ReadonlySet<number>;
};
interface InputCapture {
  readonly binding: NativeNoteRenderBinding;
  readonly context: NativeNoteRenderBinding["context"];
  readonly editor: HTMLElement;
  readonly element: HTMLElement;
  readonly current: NativeNoteRenderBinding["isCurrent"];
  readonly lease: object;
  readonly mirrorBlockId: number;
  readonly presentationKind: "footer" | "transient";
  readonly presentationBlockId: number;
  readonly epoch: number;
  readonly signature: string;
}
interface ClaimState {
  readonly id: number;
  readonly purpose: NativeMetadataPurpose;
  readonly raw: NativeSourceActionLease;
  readonly scope: ScopeIdentity;
  input?: InputCapture;
  open: boolean;
  consumed: boolean;
  active: boolean;
  enqueued: boolean;
}
const id = (value: unknown): value is number => Number.isSafeInteger(value);
const purpose = (value: unknown): value is NativeMetadataPurpose => value === "comment" || value === "checkpoint";
function fail(code: NativeMetadataAuthorityErrorCode, dispatched = false): never { throw new NativeMetadataAuthorityError(code, dispatched); }
function retire(state: ClaimState): void { state.open = false; state.raw.close(); }
function detached(snapshot: NativeNoteSnapshot, code: "INVALID_ITEM" | "INPUT_SNAPSHOT", dispatched: boolean): NativeNoteSnapshot {
  try { return decodeNativeNoteSnapshot(encodeNativeNoteSnapshot(snapshot)); }
  catch { return fail(code, dispatched); }
}
function container(snapshot: NativeNoteSnapshot, itemId: number, ownerRootIds: ReadonlySet<number>,
  code: "INVALID_ITEM" | "INPUT_SNAPSHOT", dispatched: boolean): void {
  if (snapshot.rootId !== itemId || snapshot.blocks[0]?.id !== itemId) fail(code, dispatched);
  const root = snapshot.blocks[0], content = root.content;
  // N is a NON-editable container, not a blank-looking native paragraph. In
  // particular [rich fragment], [{t:'t',v:''}] and whitespace are never empty.
  if (!(content == null || Array.isArray(content) && content.length === 0 && Reflect.ownKeys(content).length === 1)
    || root.children.length < 1) fail("INVALID_CONTAINER", dispatched);
  let metadata: ReturnType<typeof readAnnotationMetadata>;
  try { metadata = readAnnotationMetadata(root); } catch { return fail(code, dispatched); }
  if (metadata?.kind !== "native-tree" || !metadata.isPublished || metadata.metadata.state !== "active"
    || !ownerRootIds.has(metadata.metadata.ownerRootId)) fail(code, dispatched);
}

/** Opaque, one-use metadata capability minted only from this Source actor.
 * Three INDEPENDENT proofs: original edit action, current pool/item read, true
 * empty read-only N with at least one C. Checkpoint additionally pins the unique
 * current M and a settled real input observation generation/signature. No I/O,
 * item creation, canonical writes, renderer enablement, D or native-all license.
 * Do not retain a completed action as long-lived permission; isCurrentSource
 * is used only for read-only continuity and cannot revive a retired permit.
 */
export class NativeMetadataClaims {
  readonly #claims = new WeakMap<NativeMetadataClaim, ClaimState>();
  constructor(private readonly sources: NativeSourceSessions,
    private readonly readScope: (itemId: number) => NativeMetadataScope | undefined,
    private readonly readInput?: (itemId: number) => NativeMetadataInputObservation | undefined) {
    if (!(sources instanceof NativeSourceSessions)) fail("SOURCE_UNAVAILABLE");
  }

  private scope(state: ClaimState, dispatched: boolean, initial = false): ScopeIdentity {
    const current = this.readScope(state.id); // Unknown producer errors MUST stay original.
    if (!current || typeof current.panelId !== "string" || !current.panelId || !id(current.sourceRootId)
      || !id(current.scopeRootId) || !current.itemIds || typeof current.itemIds.has !== "function")
      return fail(initial ? "SCOPE_UNAVAILABLE" : "SCOPE_CHANGED", dispatched);
    const source = state.raw.source;
    if (current.panelId !== source.panelId || current.sourceRootId !== source.rootBlockId
      || !initial && (current.panelId !== state.scope.panelId || current.sourceRootId !== state.scope.sourceRootId
        || current.scopeRootId !== state.scope.scopeRootId)) fail("SCOPE_CHANGED", dispatched);
    if (current.itemIds.has(state.id) !== true) fail(initial ? "ITEM_NOT_IN_SCOPE" : "SCOPE_CHANGED", dispatched);
    const owners = new Set(current.ownerRootIds ?? [current.scopeRootId]);
    if (!owners.has(current.scopeRootId) || [...owners].some(owner => !id(owner))
      || !initial && (owners.size !== state.scope.ownerRootIds.size || [...owners].some(owner => !state.scope.ownerRootIds.has(owner))))
      fail(initial ? "SCOPE_UNAVAILABLE" : "SCOPE_CHANGED", dispatched);
    return Object.freeze({ panelId: current.panelId, sourceRootId: current.sourceRootId, scopeRootId: current.scopeRootId, ownerRootIds: owners });
  }
  private current(state: ClaimState, dispatched: boolean, active: boolean): void {
    if (!state.open) fail("CLOSED", dispatched);
    if (active && !state.active) fail("OUTSIDE_ACTION", dispatched);
    if (!this.sources.isCurrentSource(state.raw.source) || !state.raw.isCurrent()) fail("SOURCE_CHANGED", dispatched);
    this.scope(state, dispatched);
    if (!this.sources.isCurrentSource(state.raw.source) || !state.raw.isCurrent()) fail("SOURCE_CHANGED", dispatched);
  }
  private observation(state: ClaimState, epoch: number | undefined, dispatched: boolean): { snapshot: NativeNoteSnapshot; capture: InputCapture } {
    const observation = this.readInput?.(state.id); // No invented settled default.
    if (!observation) return fail("INPUT_UNAVAILABLE", dispatched);
    if (observation.state !== "settled") return fail("INPUT_UNSETTLED", dispatched);
    if (!id(epoch) || epoch < 0 || !id(observation.epoch) || observation.epoch !== epoch) return fail("INPUT_EPOCH", dispatched);
    const b = observation.binding, source = state.raw.source, model = b?.model;
    if (observation.sourceIdentity !== source || !b || !model || b.context !== state.raw.context || b.editor !== source.editor
      || b.context.editor.current !== source.editor || model.panelId !== source.panelId || model.sourceRootId !== source.rootBlockId
      || model.noteId !== state.id || !model.lease || typeof model.lease !== "object"
      || !id(model.mirrorBlockId) || !model.presentation || !id(model.presentation.blockId)
      || !["footer", "transient"].includes(model.presentation.kind)
      || new Set([model.noteId, model.mirrorBlockId, model.presentation.blockId, model.sourceRootId]).size !== 4
      || !Array.isArray(observation.currentBindings) || observation.currentBindings.length !== 1
      || observation.currentBindings[0] !== b || typeof b.isCurrent !== "function" || b.isCurrent() !== true)
      return fail("INPUT_BINDING", dispatched);
    const snapshot = detached(observation.snapshot, "INPUT_SNAPSHOT", dispatched);
    container(snapshot, state.id, state.scope.ownerRootIds, "INPUT_SNAPSHOT", dispatched);
    const signature = nativeContentSignature(snapshot);
    const capture: InputCapture = { binding: b, context: b.context, editor: b.editor, element: b.element,
      current: b.isCurrent, lease: model.lease, mirrorBlockId: model.mirrorBlockId, presentationKind: model.presentation.kind,
      presentationBlockId: model.presentation.blockId, epoch, signature };
    const prior = state.input;
    if (prior && (prior.binding !== b || prior.context !== b.context || prior.editor !== b.editor || prior.element !== b.element
      || prior.current !== b.isCurrent || prior.lease !== model.lease || prior.mirrorBlockId !== model.mirrorBlockId
      || prior.presentationKind !== model.presentation.kind || prior.presentationBlockId !== model.presentation.blockId
      || prior.epoch !== epoch || prior.signature !== signature)) fail("INPUT_CHANGED", dispatched);
    return { snapshot, capture };
  }
  private checked<T>(state: ClaimState, action: () => T): T {
    try { return action(); }
    catch (error) { retire(state); throw error; } // Never wrap producer/guard errors.
  }
  claim(itemId: number, requested: NativeMetadataPurpose, expectedInputEpoch?: number): NativeMetadataClaim {
    if (!id(itemId)) return fail("INVALID_ITEM");
    if (!purpose(requested)) return fail("INVALID_PURPOSE");
    const request = this.sources.request("edit");
    if (request.kind !== "ready") return fail("SOURCE_UNAVAILABLE");
    const raw = request.lease;
    const state: ClaimState = { id: itemId, purpose: requested, raw, scope: { panelId: "", sourceRootId: NaN, scopeRootId: NaN, ownerRootIds: new Set() },
      open: true, consumed: false, active: false, enqueued: false };
    return this.checked(state, () => {
      if (!this.sources.isCurrentSource(raw.source) || !raw.isCurrent()) return fail("SOURCE_CHANGED");
      // Only our captured scalar identity is retained, never the mutable Set.
      const scope = this.scope(state, false, true);
      Object.defineProperty(state, "scope", { value: scope, writable: false, configurable: false });
      if (requested === "checkpoint") state.input = this.observation(state, expectedInputEpoch, false).capture;
      this.current(state, false, false);
      const token = Object.freeze({ close: () => retire(state) }) as NativeMetadataClaim;
      this.#claims.set(token, state); return token;
    });
  }
  consume(token: NativeMetadataClaim, itemId: number, requested: NativeMetadataPurpose): NativeMetadataPermit {
    const state = this.#claims.get(token);
    if (!state) return fail("INVALID_CLAIM");
    if (!state.open) return fail("CLOSED");
    if (state.consumed) return fail("CLAIM_USED");
    return this.checked(state, () => {
      if (state.id !== itemId) return fail("TARGET_MISMATCH");
      if (state.purpose !== requested) return fail("PURPOSE_MISMATCH");
      // Reserve before calling host/bridge code: a reentrant consumer must not
      // extract a second permit while these read-only callbacks are running.
      state.consumed = true;
      this.current(state, false, false);
      if (state.input) this.observation(state, state.input.epoch, false);
      this.current(state, false, false);
      const raw = state.raw, close = () => retire(state);
      const action: NativeSourceActionLease = Object.freeze({ intent: raw.intent, source: raw.source, context: raw.context, guard: raw.guard,
        isCurrent: () => state.open && raw.isCurrent(), close,
        enqueue: <T>(callback: (guard: NativeTaskGuard) => Promise<T> | T): Promise<T> => {
          // Let the genuine lease reject repeat enqueue without closing a first
          // still-running action. No retries or extra native tasks are minted.
          if (state.enqueued) return raw.enqueue(callback);
          state.enqueued = true;
          return raw.enqueue(async guard => {
            if (!state.open) return fail("CLOSED");
            state.active = true;
            try { return await callback(guard); }
            finally { state.active = false; }
          }).finally(close);
        } });
      return Object.freeze({ action, scopeRootId: state.scope.scopeRootId, inputEpoch: state.input?.epoch, close,
        assertCurrent: (item: NativeMetadataItem, dispatched = false): void => this.checked(state, () => {
          this.current(state, dispatched, true);
          if (item?.kind !== "native-tree" || item.id !== state.id || item.metadata?.version !== 2
            || item.metadata.contentKind !== "native-tree" || item.metadata.publicationStatus !== "published"
            || item.metadata.state !== "active" || !state.scope.ownerRootIds.has(item.metadata.ownerRootId)) fail("INVALID_ITEM", dispatched);
          const snapshot = detached(item.snapshot, "INVALID_ITEM", dispatched);
          container(snapshot, state.id, state.scope.ownerRootIds, "INVALID_ITEM", dispatched);
          const root = readAnnotationMetadata(snapshot.blocks[0]);
          if (!root || root.metadata.revision !== item.metadata.revision || root.metadata.ownerRootId !== item.metadata.ownerRootId
            || root.metadata.state !== item.metadata.state || root.kind !== "native-tree"
            || root.metadata.operationId !== item.metadata.operationId || nativeContentSignature(snapshot) !== item.signature) fail("INVALID_ITEM", dispatched);
          if (state.input) this.observation(state, state.input.epoch, dispatched);
          // Recheck producer-side Source/scope changes incurred while observing.
          this.current(state, dispatched, true);
        }),
        inputSnapshot: (): NativeNoteSnapshot => this.checked(state, () => {
          this.current(state, false, true);
          if (!state.input || state.purpose !== "checkpoint") return fail("INPUT_UNAVAILABLE");
          const snapshot = this.observation(state, state.input.epoch, false).snapshot;
          this.current(state, false, true); return snapshot;
        }) });
    });
  }
}
