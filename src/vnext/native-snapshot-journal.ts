import type { DbId } from "../../vendor/orca";
import type { DurableValues, HistoryVersion } from "./types";
import {
  encodeNativeNoteSnapshot, decodeNativeNoteSnapshot,
  type NativeNoteSnapshot, type NativeNoteSnapshotWire,
} from "./native-content-snapshot";

/** Descriptive checkpoint labels only; this module defines no operation state machine. */
export type NativeSnapshotReason = HistoryVersion["reason"];
export interface NativeSnapshotCheckpoint {
  readonly rootId: DbId;
  readonly operationId: string;
  readonly revision: number;
  readonly at: number;
  readonly comment: string;
  readonly reason: NativeSnapshotReason;
  readonly snapshot: NativeNoteSnapshot;
}
/** A recovery copy of real native backing, never a second canonical document. */
export interface RetainedNativeSnapshot {
  readonly rootId: DbId;
  readonly operationId: string;
  /** Caller-supplied baseline token, not verified against live canonical storage. */
  readonly baseSignature: string;
  readonly at: number;
  readonly comment: string;
  readonly snapshot: NativeNoteSnapshot;
}
export type AppendCheckpointResult = "appended" | "duplicate";
export type ClearRetainedResult = "cleared" | "missing" | "operation-mismatch";
/** Bounded SAME-INSTANCE history observation, not a Source/edit permission or
 * cross-process CAS. Release after the caller's final synchronous check. A local
 * history write invalidates before dispatch, including commit-then-reject. */
export interface NativeSnapshotHistoryObservation {
  readonly entries: readonly NativeSnapshotCheckpoint[];
  isCurrent(): boolean;
  close(): void;
}

export class NativeSnapshotJournalDataError extends Error {
  constructor(readonly key: string, options?: ErrorOptions) {
    super(`Invalid native snapshot journal at ${key}: malformed JSON or unsupported schema/tree`, options);
    this.name = "NativeSnapshotJournalDataError";
  }
}
export class NativeSnapshotOperationConflictError extends Error {
  constructor(readonly rootId: DbId, readonly operationId: string) {
    super(`Native snapshot checkpoint operation conflict at root ${rootId}: ${operationId}`);
    this.name = "NativeSnapshotOperationConflictError";
  }
}

const FORMAT = "orca-footnotes.native-snapshot-journal";
const MAX_HISTORY = 2000;
type RootWire = number | "-0";
type CheckpointWire = [string, number, number, string, NativeSnapshotReason, NativeNoteSnapshotWire];
type RetainedWire = [string, string, number, string, NativeNoteSnapshotWire];
// All envelopes/entries are tuples, so duplicate JSON object keys cannot hide fields.
// [FORMAT, 2, "history" | "retained", root token, entries | retained entry]
const invalid = (message: string): never => { throw new TypeError(message); };
function id(value: unknown): asserts value is DbId {
  if (!Number.isSafeInteger(value)) invalid("Invalid root ID");
}
function rootToken(rootId: DbId): RootWire { return Object.is(rootId, -0) ? "-0" : rootId; }
function text(value: unknown): asserts value is string {
  if (typeof value !== "string") invalid("Expected string");
}
function token(value: unknown): asserts value is string {
  text(value); if (value.length === 0) invalid("Expected nonempty token");
}
function at(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || Object.is(value, -0)) invalid("Invalid timestamp");
}
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) invalid("Invalid revision");
}
function reason(value: unknown): asserts value is NativeSnapshotReason {
  if (!["save", "restore", "recycle", "recover"].includes(value as string)) invalid("Invalid checkpoint reason");
}
function limitValue(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HISTORY) invalid("History limit must be an integer in 1..2000");
}
function tuple(value: unknown, size: number): unknown[] {
  if (!Array.isArray(value) || value.length !== size) invalid("Unexpected tuple shape");
  return value as unknown[];
}
/** Copy own data fields without invoking accessors/toJSON on caller input. */
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Unexpected input shape");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || !names.every(key => keys.includes(key))) invalid("Unexpected input fields");
  const copy: Record<string, unknown> = {};
  for (const key of names) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d)) invalid("Input accessors are unsupported");
    copy[key] = d!.value;
  }
  return copy;
}
function snapshotForRoot(wire: unknown, rootId: DbId): NativeNoteSnapshot {
  const snapshot = decodeNativeNoteSnapshot(wire);
  if (!Object.is(snapshot.rootId, rootId)) invalid("Snapshot root mismatch");
  return snapshot;
}
function encodeForRoot(snapshot: unknown, rootId: DbId): NativeNoteSnapshotWire {
  const wire = encodeNativeNoteSnapshot(snapshot as NativeNoteSnapshot);
  if (wire[2] !== rootToken(rootId)) invalid("Snapshot root mismatch");
  return wire;
}
function prepareCheckpoint(value: NativeSnapshotCheckpoint): { rootId: DbId; entry: CheckpointWire } {
  const v = fields(value, ["rootId", "operationId", "revision", "at", "comment", "reason", "snapshot"]);
  id(v.rootId); token(v.operationId); revision(v.revision); at(v.at); text(v.comment); reason(v.reason);
  return { rootId: v.rootId, entry: [v.operationId, v.revision, v.at, v.comment, v.reason, encodeForRoot(v.snapshot, v.rootId)] };
}
function prepareRetained(value: RetainedNativeSnapshot): { rootId: DbId; entry: RetainedWire } {
  const v = fields(value, ["rootId", "operationId", "baseSignature", "at", "comment", "snapshot"]);
  id(v.rootId); token(v.operationId); token(v.baseSignature); at(v.at); text(v.comment);
  return { rootId: v.rootId, entry: [v.operationId, v.baseSignature, v.at, v.comment, encodeForRoot(v.snapshot, v.rootId)] };
}
function checkpoint(rootId: DbId, raw: unknown): NativeSnapshotCheckpoint {
  const v = tuple(raw, 6);
  token(v[0]); revision(v[1]); at(v[2]); text(v[3]); reason(v[4]);
  return { rootId, operationId: v[0], revision: v[1], at: v[2], comment: v[3], reason: v[4], snapshot: snapshotForRoot(v[5], rootId) };
}
function retained(rootId: DbId, raw: unknown): RetainedNativeSnapshot {
  const v = tuple(raw, 5);
  token(v[0]); token(v[1]); at(v[2]); text(v[3]);
  return { rootId, operationId: v[0], baseSignature: v[1], at: v[2], comment: v[3], snapshot: snapshotForRoot(v[4], rootId) };
}

/** Independent schema-2 value journal. Nested snapshots use the existing complete
 * native wire codec (its own version remains 1); no plain converter/JournalStore.
 * New keys: orca-footnotes:native-snapshot-journal:v2:<encoded namespace>:root:<id>:<kind>.
 * Every operation rereads backing. Reads never prune; writes/removes first validate
 * the entire value they touch. No automatic restore, migration, or N/C deletion.
 *
 * FIFO is per root and instance, including reads, with failures isolated. There is
 * NO cross-instance/process CAS, native/value transaction, successful native flush,
 * cryptographic signature check, or arbitrary-fault zero-loss guarantee. A backing
 * write/remove can succeed and then reject; callers must reconcile by rereading.
 * Storage/input-size quotas beyond each snapshot's codec budget belong to the
 * DurableValues host. Nothing here authorizes recovery, upgrade, or publication.
 */
export class NativeSnapshotJournal {
  private readonly prefix: string;
  private readonly tails = new Map<string, Promise<void>>();
  // Retained only while observations are open, not an unbounded per-root cache.
  private readonly historyClocks = new Map<string, { token: object; observers: number }>();
  constructor(private readonly values: DurableValues, namespace: string, private limit = 40) {
    token(namespace); limitValue(limit);
    this.prefix = `orca-footnotes:native-snapshot-journal:v2:${encodeURIComponent(namespace)}:root:`;
  }
  /** Affects subsequently invoked appends only, not reads or already queued calls. */
  setLimit(limit: number): void { limitValue(limit); this.limit = limit; }
  private key(rootId: DbId, kind: "history" | "retained"): string {
    return `${this.prefix}${rootToken(rootId)}:${kind}`;
  }
  private enqueue<T>(rootId: DbId, operation: () => Promise<T>): Promise<T> {
    const key = String(rootToken(rootId));
    const job = (this.tails.get(key) ?? Promise.resolve()).then(operation);
    const tail = job.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return job;
  }
  private async readValue<T>(rootId: DbId, kind: "history" | "retained", validate: (value: unknown) => T, fence?: () => void): Promise<T | null> {
    // Each fenced caller already checked inside its queued action; this call
    // starts IO synchronously without another await or user callback in between.
    const key = this.key(rootId, kind), raw = await this.values.read(key);
    // Outside the parser catch: a retired action keeps its original error even
    // if the now-irrelevant successful read returned malformed bytes. A rejected
    // storage Promise still propagates its own original transport error.
    fence?.();
    if (raw === null) return null;
    try {
      const envelope = tuple(JSON.parse(raw), 5);
      if (envelope[0] !== FORMAT || envelope[1] !== 2 || envelope[2] !== kind || !Object.is(envelope[3], rootToken(rootId))) {
        invalid("Wrong journal envelope");
      }
      return validate(envelope[4]);
    } catch (cause) { throw new NativeSnapshotJournalDataError(key, { cause }); }
  }
  private async readHistoryValue(rootId: DbId, fence?: () => void): Promise<{ entries: NativeSnapshotCheckpoint[]; wires: CheckpointWire[] }> {
    return await this.readValue(rootId, "history", (raw) => {
      if (!Array.isArray(raw) || raw.length > MAX_HISTORY) invalid("Invalid history list");
      const wires = raw as CheckpointWire[], entries = wires.map(entry => checkpoint(rootId, entry)), seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.operationId)) invalid("Duplicate persisted operation ID");
        seen.add(entry.operationId);
      }
      return { entries, wires };
    }, fence) ?? { entries: [], wires: [] };
  }
  private readRetainedValue(rootId: DbId): Promise<RetainedNativeSnapshot | null> {
    return this.readValue(rootId, "retained", raw => retained(rootId, raw));
  }
  async history(rootId: DbId, fence?: () => void): Promise<NativeSnapshotCheckpoint[]> {
    id(rootId);
    return this.enqueue(rootId, async () => {
      fence?.(); const value = await this.readHistoryValue(rootId, fence); fence?.(); return value.entries;
    });
  }
  /** Observe a fresh history and local write generation atomically within this
   * root's FIFO. No copies of other roots/history and no new persistence. */
  async observeHistory(rootId: DbId, fence?: () => void): Promise<NativeSnapshotHistoryObservation> {
    id(rootId);
    return this.enqueue(rootId, async () => {
      fence?.(); const value = await this.readHistoryValue(rootId, fence); fence?.();
      const key = String(rootToken(rootId));
      let clock = this.historyClocks.get(key);
      if (!clock) { clock = { token: {}, observers: 0 }; this.historyClocks.set(key, clock); }
      const captured = clock, token = clock.token; clock.observers++;
      let open = true;
      return Object.freeze({ entries: value.entries,
        isCurrent: () => open && captured.token === token,
        close: () => {
          if (!open) return; open = false;
          if (--captured.observers === 0 && this.historyClocks.get(key) === captured) this.historyClocks.delete(key);
        } });
    });
  }
  /** Detaches/encodes synchronously BEFORE entering the FIFO. Full wire payload,
   * not nativeContentSignature, determines duplicate/conflict. Deduplication only
   * covers still-retained history; pruning forgets older operation IDs. */
  async appendCheckpoint(value: NativeSnapshotCheckpoint, fence?: () => void): Promise<AppendCheckpointResult> {
    const { rootId, entry } = prepareCheckpoint(value), limit = this.limit;
    return this.enqueue(rootId, async () => {
      fence?.();
      const previous = await this.readHistoryValue(rootId, fence);
      // The generic journal owns no Source authority. Native callers provide
      // their actual synchronous action fence so retirement DURING the read
      // cannot issue a later write/prune. Already-issued writes cannot be undone.
      fence?.();
      const same = previous.wires.find(old => old[0] === entry[0]);
      if (same) {
        if (JSON.stringify(same) !== JSON.stringify(entry)) throw new NativeSnapshotOperationConflictError(rootId, entry[0]);
        return "duplicate";
      }
      const wires = [...previous.wires, entry].slice(-limit);
      const raw = JSON.stringify([FORMAT, 2, "history", rootToken(rootId), wires]);
      // The post-await fence above is still current: between it and this write
      // there are only validated, detached tuples and synchronous pure work.
      // Keep the established start/read/pre-write/post-write fence sequence.
      const clock = this.historyClocks.get(String(rootToken(rootId)));
      if (clock) clock.token = {}; // Invalidate BEFORE IO: a rejected write may have committed.
      await this.values.write(this.key(rootId, "history"), raw);
      fence?.();
      return "appended";
    });
  }
  async readRetained(rootId: DbId): Promise<RetainedNativeSnapshot | null> {
    id(rootId);
    return this.enqueue(rootId, () => this.readRetainedValue(rootId));
  }
  /** Replaces only a valid retained value. Same-operation updates are allowed;
   * operationId identifies the caller's generation for conditional clearing. */
  async retain(value: RetainedNativeSnapshot): Promise<void> {
    const { rootId, entry } = prepareRetained(value);
    return this.enqueue(rootId, async () => {
      await this.readRetainedValue(rootId);
      await this.values.write(this.key(rootId, "retained"), JSON.stringify([FORMAT, 2, "retained", rootToken(rootId), entry]));
    });
  }
  /** Omit expectedOperationId only for an intentional unconditional clear. A
   * mismatch preserves the newer copy; this check is NOT cross-instance CAS. */
  async clearRetained(rootId: DbId, expectedOperationId?: string): Promise<ClearRetainedResult> {
    id(rootId); if (expectedOperationId !== undefined) token(expectedOperationId);
    return this.enqueue(rootId, async () => {
      const value = await this.readRetainedValue(rootId);
      if (value === null) return "missing";
      if (expectedOperationId !== undefined && value.operationId !== expectedOperationId) return "operation-mismatch";
      await this.values.remove(this.key(rootId, "retained"));
      return "cleared";
    });
  }
}
