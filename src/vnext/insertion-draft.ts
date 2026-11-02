import type { DbId } from "../../vendor/orca";
import type { DurableValues } from "./types";

export interface InsertionDraftSource {
  readonly viewRootId: DbId;
  readonly scopeRootId: DbId;
}
export interface PreparedInsertionBase {
  readonly revision: number;
  readonly text: string;
  readonly comment: string;
}
export interface InsertionDraftSnapshot {
  readonly text: string;
  readonly comment: string;
  readonly preparedItemId?: DbId;
  readonly preparedBase?: PreparedInsertionBase;
  readonly state: "saved" | "saving" | "error";
  readonly error?: string;
  readonly recovered: boolean;
}
interface StoredDraft {
  readonly schema: 1;
  readonly kind: "insertion-draft";
  readonly source: InsertionDraftSource;
  readonly text: string;
  readonly comment: string;
  readonly at: number;
  readonly preparedItemId?: DbId;
  readonly preparedBase?: PreparedInsertionBase;
}

/** Unsupported recovery data must never be treated as an empty composer. */
export class InsertionDraftDataError extends Error {
  constructor(readonly key: string, cause: unknown) {
    super(`Invalid insertion draft at ${key}: malformed JSON or unsupported schema`, { cause });
    this.name = "InsertionDraftDataError";
  }
}
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !required.every((key) => Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError("Unexpected insertion draft object shape");
  }
}
function id(value: unknown): asserts value is DbId {
  // DbId is a number in the vendor contract; do not invent a positive-only rule.
  if (!Number.isSafeInteger(value)) throw new TypeError("Invalid insertion draft ID");
}
function content(text: unknown, comment: unknown): void {
  // Limit is UTF-16 code units, as for the editor's JS strings. No trimming,
  // normalization, excerpting or newline conversion occurs in storage.
  if (typeof text !== "string" || typeof comment !== "string" || text.length > 50_000 || comment.length > 50_000) {
    throw new TypeError("Insertion draft text and comment must each be strings of at most 50000 code units");
  }
}
function preparedBase(value: unknown): asserts value is PreparedInsertionBase {
  shape(value, ["revision", "text", "comment"]);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new TypeError("Invalid prepared insertion revision");
  content(value.text, value.comment);
}
function time(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError("Invalid insertion draft timestamp");
}
function message(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); }
  catch { return "Unknown insertion draft storage failure"; }
}

/** A durable composer, NOT an annotation repository: search input writes only
 * this source's recovery key. It never creates/reads/updates/deletes annotations.
 *
 * FIFO and generation protection apply within ONE session. Validating before
 * mutation protects corrupt/unknown data, but read+write/remove is NOT CAS, nor
 * an atomic transaction with item creation or reference insertion. The caller
 * coordinates other sessions/windows and calls clear only for the composition
 * whose insertion (or explicit candidate creation) it has actually confirmed.
 */
export class InsertionDraftSession {
  readonly source: InsertionDraftSource;
  private readonly key: string;
  private readonly listeners = new Set<() => void>();
  private snapshot: InsertionDraftSnapshot;
  private current: StoredDraft | null;
  private generation = 0;
  private savedGeneration = 0;
  private clearGeneration?: number;
  private ioTail: Promise<void> = Promise.resolve();
  private flushTask?: Promise<void>;
  private closeTask?: Promise<void>;
  private abandonTask?: Promise<void>;
  private closing = false;
  private closed = false;
  private abandoning = false;

  private constructor(private readonly values: DurableValues, source: InsertionDraftSource,
    private readonly now: () => number, recovered: StoredDraft | null) {
    this.source = Object.freeze({ ...source });
    this.key = `composer:1:${source.viewRootId}:${source.scopeRootId}`;
    this.current = recovered;
    this.snapshot = Object.freeze({ text: recovered?.text ?? "", comment: recovered?.comment ?? "",
      ...(recovered?.preparedItemId !== undefined ? { preparedItemId: recovered.preparedItemId } : {}),
      ...(recovered?.preparedBase ? { preparedBase: recovered.preparedBase } : {}),
      state: "saved", recovered: recovered !== null });
  }

  static async open(values: DurableValues, source: InsertionDraftSource,
    options: { now?: () => number } = {}): Promise<InsertionDraftSession> {
    if (!values || typeof values.read !== "function" || typeof values.write !== "function" || typeof values.remove !== "function") {
      throw new TypeError("Insertion draft DurableValues adapter is required");
    }
    shape(source, ["viewRootId", "scopeRootId"]); id(source.viewRootId); id(source.scopeRootId);
    shape(options, [], ["now"]);
    if (options.now !== undefined && typeof options.now !== "function") throw new TypeError("Invalid insertion draft clock");
    // Capture before the first await; callers cannot retarget an opening session.
    const copy = Object.freeze({ viewRootId: source.viewRootId, scopeRootId: source.scopeRootId });
    const clock = options.now ?? Date.now, key = `composer:1:${copy.viewRootId}:${copy.scopeRootId}`;
    const recovered = InsertionDraftSession.decode(key, copy, await values.read(key));
    return new InsertionDraftSession(values, copy, clock, recovered);
  }

  private static decode(key: string, source: InsertionDraftSource, raw: string | null): StoredDraft | null {
    if (raw === null) return null;
    try {
      if (typeof raw !== "string") throw new TypeError("Expected a JSON string");
      const value: unknown = JSON.parse(raw);
      shape(value, ["schema", "kind", "source", "text", "comment", "at"], ["preparedItemId", "preparedBase"]);
      if (value.schema !== 1 || value.kind !== "insertion-draft") throw new TypeError("Wrong insertion draft schema");
      shape(value.source, ["viewRootId", "scopeRootId"]);
      id(value.source.viewRootId); id(value.source.scopeRootId);
      if (value.source.viewRootId !== source.viewRootId || value.source.scopeRootId !== source.scopeRootId) {
        throw new TypeError("Wrong insertion draft source");
      }
      content(value.text, value.comment); time(value.at);
      if (Object.hasOwn(value, "preparedItemId")) id(value.preparedItemId);
      if (Object.hasOwn(value, "preparedBase")) {
        if (!Object.hasOwn(value, "preparedItemId")) throw new TypeError("Prepared insertion base requires an item identity");
        preparedBase(value.preparedBase);
      }
      return Object.freeze({ ...(value as unknown as StoredDraft), source,
        ...(value.preparedBase ? { preparedBase: Object.freeze({ ...(value.preparedBase as PreparedInsertionBase) }) } : {}) });
    } catch (cause) { throw new InsertionDraftDataError(key, cause); }
  }
  private async read(): Promise<StoredDraft | null> {
    return InsertionDraftSession.decode(this.key, this.source, await this.values.read(this.key));
  }

  /** Bound, immutable and referentially stable until observable fields change. */
  readonly getSnapshot = (): InsertionDraftSnapshot => this.snapshot;
  readonly subscribe = (fn: () => void): (() => void) => {
    if (typeof fn !== "function") throw new TypeError("Insertion draft observer must be a function");
    if (this.closed) return () => undefined;
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  private publish(patch: Partial<InsertionDraftSnapshot>): void {
    const next = { ...this.snapshot, ...patch }, previous = this.snapshot;
    if (next.text === previous.text && next.comment === previous.comment && next.preparedItemId === previous.preparedItemId && next.preparedBase === previous.preparedBase
      && next.state === previous.state && next.error === previous.error && next.recovered === previous.recovered) return;
    this.snapshot = Object.freeze(next);
    for (const listener of [...this.listeners]) {
      // Neither throwing renderers nor rejected async observers can break IO.
      try { void Promise.resolve(listener()).catch(() => undefined); } catch { /* Observer-owned error. */ }
    }
  }
  private assertEditable(): void {
    if (this.closing || this.closed || this.abandoning) throw new Error("Insertion draft session is closing or closed");
  }
  private assertDispatchable(): void {
    if (this.abandoning) throw new Error("Insertion draft session was abandoned before storage dispatch");
  }
  private fail(error: unknown, generation: number): void {
    this.savedGeneration = -1; // Adapter errors may have applied partially.
    if (generation === this.generation && !this.abandoning) this.publish({ state: "error", error: message(error) });
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.ioTail.then(operation);
    // Keep FIFO alive after failure and handle void change()'s rejection.
    this.ioTail = task.then(() => undefined, () => undefined);
    return task;
  }
  private draft(text: string, comment: string, preparedItemId = this.snapshot.preparedItemId, base = this.snapshot.preparedBase): StoredDraft {
    const at = this.now(); time(at);
    return Object.freeze({ schema: 1, kind: "insertion-draft", source: this.source, text, comment, at,
      ...(preparedItemId !== undefined ? { preparedItemId } : {}), ...(base ? { preparedBase: base } : {}) });
  }
  private write(draft: StoredDraft, generation: number): Promise<void> {
    return this.enqueue(async () => {
      try {
        this.assertDispatchable();
        // Revalidate before EVERY overwrite, including explicit retries.
        await this.read(); this.assertDispatchable();
        await this.values.write(this.key, JSON.stringify(draft));
        this.savedGeneration = generation;
        // A delayed acknowledgement never replaces newer text, identity or state.
        if (generation === this.generation && this.clearGeneration !== generation) this.publish({ state: "saved", error: undefined });
      } catch (error) { this.fail(error, generation); throw error; }
    });
  }

  change(text: string, comment: string): void {
    this.assertEditable(); content(text, comment);
    if (text === this.snapshot.text && comment === this.snapshot.comment) return;
    const draft = this.draft(text, comment), generation = ++this.generation;
    this.current = draft; this.clearGeneration = undefined;
    // Enqueue before notifying: observers can synchronously edit, flush or close.
    void this.write(draft, generation);
    this.publish({ text, comment, state: "saving", error: undefined });
  }

  /** The caller has ALREADY explicitly created this new item. Retain its identity
   * in memory even on storage failure, and never replace it with another item.
   * This method performs no item lookup/creation/overwrite of its own.
   */
  async bindItem(itemId: DbId, base?: PreparedInsertionBase): Promise<void> {
    this.assertEditable(); id(itemId); if (base !== undefined) preparedBase(base);
    const previous = this.snapshot.preparedBase;
    if (this.snapshot.preparedItemId !== undefined) {
      if (this.snapshot.preparedItemId !== itemId) throw new Error("Insertion draft is already bound to a different prepared item");
      if (base === undefined || (previous && previous.revision === base.revision && previous.text === base.text && previous.comment === base.comment)) { await this.flush(); return; }
    }
    const copied = base ? Object.freeze({ ...base }) : previous;
    const draft = this.draft(this.snapshot.text, this.snapshot.comment, itemId, copied), generation = ++this.generation;
    this.current = draft; this.clearGeneration = undefined;
    const task = this.write(draft, generation);
    this.publish({ preparedItemId: itemId, ...(copied ? { preparedBase: copied } : {}), state: "saving", error: undefined });
    await task;
  }

  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.abandoning) return this.abandonTask ?? this.ioTail;
    if (this.flushTask) return this.flushTask;
    const task = Promise.resolve().then(() => this.drain());
    this.flushTask = task;
    void task.then(() => { if (this.flushTask === task) this.flushTask = undefined; },
      () => { if (this.flushTask === task) this.flushTask = undefined; });
    return task;
  }
  private async drain(): Promise<void> {
    for (;;) {
      const tail = this.ioTail;
      await tail;
      if (this.abandoning || this.closed) return;
      if (tail !== this.ioTail) continue; // Include edits queued during an await.
      const generation = this.generation;
      if (this.clearGeneration !== generation && this.savedGeneration === generation) return;
      const task = this.clearGeneration === generation ? this.remove(generation)
        : this.write(this.current!, generation);
      this.publish({ state: "saving", error: undefined });
      try { await task; }
      catch (error) {
        if (this.abandoning) return;
        if (generation === this.generation) throw error;
        // An obsolete failed write is not the outcome of newer queued input.
      }
    }
  }

  /** Only after confirmed insertion / explicit candidate creation. A generation
   * changed while this operation waits must survive, both in memory and storage.
   * A failed clear remains retryable by clear() or flush(); it is never green.
   */
  async clear(): Promise<void> {
    this.assertEditable();
    const generation = this.generation;
    this.clearGeneration = generation;
    const task = this.remove(generation);
    this.publish({ state: "saving", error: undefined });
    await task;
  }
  private remove(generation: number): Promise<void> {
    return this.enqueue(async () => {
      try {
        this.assertDispatchable();
        if (generation !== this.generation || this.clearGeneration !== generation) return;
        const previous = await this.read(); this.assertDispatchable();
        if (generation !== this.generation || this.clearGeneration !== generation) return;
        if (previous !== null) await this.values.remove(this.key);
        this.savedGeneration = -1;
        // Edits arriving during remove are already queued AFTER it in the FIFO.
        if (generation !== this.generation) return;
        this.current = null; this.clearGeneration = undefined;
        this.savedGeneration = ++this.generation;
        this.publish({ text: "", comment: "", preparedItemId: undefined, ...(this.snapshot.preparedBase ? { preparedBase: undefined } : {}), state: "saved", error: undefined, recovered: false });
      } catch (error) { this.fail(error, generation); throw error; }
    });
  }

  /** Flush before stopping, but NEVER clear an unconfirmed composition. Failure
   * leaves the session editable/retryable, with its content and prepared ID intact.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.abandoning) return this.abandonTask!;
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    const task = this.flush().then(() => {
      this.closed = true; this.closing = false; this.listeners.clear();
    }, (error) => { if (!this.abandoning) this.closing = false; throw error; });
    this.closeTask = task;
    void task.then(() => { if (this.closeTask === task) this.closeTask = undefined; },
      () => { if (this.closeTask === task) this.closeTask = undefined; });
    return task;
  }

  /** Stop without retries, writes or recovery removal. Wait for already dispatched
   * adapter IO; queued operations not yet dispatched (including a write following
   * an in-flight validation read) are cancelled, never replayed into another library.
   * An adapter write/remove already in flight cannot be cancelled or rolled back.
   */
  abandon(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.abandonTask) return this.abandonTask;
    this.abandoning = true; this.closing = true;
    this.abandonTask = (async () => {
      await this.flushTask?.catch(() => undefined);
      await this.ioTail;
      this.closed = true; this.closing = false; this.listeners.clear();
    })();
    return this.abandonTask;
  }
}
