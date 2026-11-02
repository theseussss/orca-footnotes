import type { DbId } from "../../vendor/orca";

/** Narrow capability of an ACTUAL BlockEditorContext. addTask is present in the
 * inspected host but not declared by vendor/orca.d.ts. A caller must obtain the
 * real Provider value and prove its physical/source ownership; this interface
 * does not construct a context or claim a public flush/drain API. */
export interface NativeTaskContext {
  readonly panelId: string;
  readonly rootBlockId: DbId;
  readonly addTask: (task: () => Promise<void>) => unknown;
}
export class NativeTaskLeaseError extends Error {
  constructor(message: string, readonly started: boolean) { super(message); this.name = "NativeTaskLeaseError"; }
}
export interface NativeTaskGuard { assertCurrent(): void }
type Pending = { started: boolean; done: boolean; reject: (error: unknown) => void };

/** Queues ONLY plugin-owned, bounded note actions behind the native input
 * attempts already queued by the real context. Callback completion is NOT
 * proof that earlier commits succeeded, nor a barrier against future input.
 * No sleeps, history-queue probes, global editor pointers or kernel patches. */
export class NativeTaskLease {
  private open = true;
  private readonly pending = new Set<Pending>();
  constructor(private readonly context: NativeTaskContext, private readonly expected: {
    readonly panelId: string;
    readonly rootBlockId: DbId;
    /** Must revalidate repository/source/physical editor/owned rendering lease. */
    readonly current: () => boolean;
    readonly composing?: () => boolean;
  }) {
    if (!this.matches()) throw new NativeTaskLeaseError("未取得当前正文的原生任务队列。", false);
  }
  private matches(): boolean {
    return this.open && typeof this.context.addTask === "function"
      && this.context.panelId === this.expected.panelId && this.context.rootBlockId === this.expected.rootBlockId
      && this.expected.current();
  }
  private assertCurrent(started: boolean): void {
    if (!this.matches()) throw new NativeTaskLeaseError(started
      ? "原生操作期间宿主已变化；已发出的命令可能已完成，未自动重试。"
      : "原生编辑宿主已变化，排队操作未执行。", started);
    if (this.expected.composing?.()) throw new NativeTaskLeaseError(started
      ? "原生操作期间输入法正在合成；已发出的命令可能已完成，未继续执行后续操作。"
      : "输入法正在合成，请完成输入法合成后再执行注释操作。", started);
  }
  enqueue<T>(action: (guard: NativeTaskGuard) => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        this.assertCurrent(false);
      } catch (error) { reject(error); return; }
      const pending: Pending = { started: false, done: false, reject };
      this.pending.add(pending);
      const finish = () => { pending.done = true; this.pending.delete(pending); };
      const task = async () => {
        if (pending.done) return; // Closed while queued: native may still call it.
        try {
          this.assertCurrent(false);
          pending.started = true;
          const result = await action({ assertCurrent: () => this.assertCurrent(true) });
          this.assertCurrent(true);
          if (!pending.done) { finish(); resolve(result); }
        } catch (error) {
          // Native AutoTaskQueue catches callback errors. Reject OUR promise
          // explicitly; otherwise a thrown callback could strand it forever.
          if (!pending.done) { finish(); reject(error); }
        }
      };
      try {
        const addTask = this.context.addTask;
        addTask(task); // Its undefined return value is intentionally NOT awaited.
      } catch (error) {
        if (!pending.done) { finish(); reject(error); }
      }
    });
  }
  /** Retires only queued plugin work. An action already dispatched cannot be
   * undone/aborted here: its guarded completion still settles its own promise.
   * This neither flushes nor discards native input or persisted draft content. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    for (const pending of this.pending) if (!pending.started && !pending.done) {
      pending.done = true; this.pending.delete(pending);
      pending.reject(new NativeTaskLeaseError("原生编辑宿主已结束，排队操作未执行。", false));
    }
  }
}
