import type { DbId } from "../../vendor/orca";
import { NATIVE_NOTE_FOREIGN_VIEW } from "./native-note-selection";
import { NativeTaskLease, NativeTaskLeaseError, type NativeTaskContext, type NativeTaskGuard } from "./native-task-lease";

/** Original public function references, never bound/copied implementations.
 * The host's undeclared publication boundary intentionally leaves args/results
 * open; this module verifies identity, not command/catalog/DB authorization. */
export interface NativeSourcePublication {
  readonly invokeCommand: (...args: any[]) => unknown;
  readonly invokeTopCommand: (...args: any[]) => unknown;
  readonly invokeGroup: (...args: any[]) => unknown;
  readonly undo: (...args: any[]) => unknown;
  readonly redo: (...args: any[]) => unknown;
}
/** The ORIGINAL Provider value obtained by a real menu component's useContext
 * (or a mounted F/T consumer). Runtime fields exceed the SDK's typed four.
 * Shape validation cannot establish provenance; the integration owns that. */
export interface NativeSourceContext extends NativeTaskContext {
  readonly editor: { readonly current: HTMLElement | null };
  readonly active: boolean;
  readonly rootViewStateId: string;
}
export interface NativeSourceDescription {
  readonly libraryIdentity: string;
  /** Fresh on library leave/reopen, even if the library name is unchanged. */
  readonly librarySession: object;
  readonly panelId: string;
  /** Actual physical Source root, NOT necessarily panel.viewArgs.blockId. */
  readonly rootBlockId: DbId;
  readonly rootViewStateId: string;
  /** Original direct, visible, normal Source editor, selected from the current
   * active panel. The callback must exclude noneditable/foreign view modes;
   * this module additionally checks physical root/panel/direct-HL ancestry. */
  readonly editor: HTMLElement;
  /** Public panel.viewState.editor, never a private owner registry/Fiber. */
  readonly owner: NativeSourcePublication;
  /** Public panel.viewState[rootViewStateId], read fresh with owner. */
  readonly rootPublication: NativeSourcePublication;
  /** Actual Source composition state, maintained by host/runtime events. */
  readonly composing: boolean;
}
/** Frozen identity metadata; actual DOM/owner/library token remain original
 * objects. This stable object can also identify a caret's Source session. */
export type NativeSourceIdentity = Readonly<Omit<NativeSourceDescription, "rootPublication" | "composing">>;
export type NativeSourceIntent = "add" | "edit";
export interface NativeSourceActionLease {
  readonly intent: NativeSourceIntent;
  readonly context: NativeSourceContext;
  readonly source: NativeSourceIdentity;
  /** Read/pre-dispatch guard only. Inside enqueue use its supplied native guard,
   * whose error.started accurately describes an already dispatched action. */
  readonly guard: NativeTaskGuard;
  isCurrent(): boolean;
  /** ONE bounded action per request, with no auto-retry. Queue completion is
   * neither durable-success proof nor a barrier against future native input. */
  enqueue<T>(action: (guard: NativeTaskGuard) => Promise<T> | T): Promise<T>;
  close(): void;
}
export type NativeSourceRequest =
  | { readonly kind: "ready"; readonly lease: NativeSourceActionLease }
  | { readonly kind: "needs-native-menu" }
  | { readonly kind: "unavailable"; readonly reason: "no-source" | "composing" | "closed" };

const names = ["invokeCommand", "invokeTopCommand", "invokeGroup", "undo", "redo"] as const;
type ReadSource = { source: NativeSourceIdentity; functions: readonly NativeSourcePublication[typeof names[number]][]; composing: boolean };
type Session = ReadSource & { context: NativeSourceContext; addTask: NativeTaskContext["addTask"]; actions: Set<() => void> };
const object = (value: unknown): value is object => value !== null && typeof value === "object";
function physical(editor: HTMLElement, panelId: string, root: DbId): boolean {
  if (editor.isConnected !== true || !editor.matches(".orca-block-editor") || editor.dataset.blockId !== String(root)
    || editor.closest(NATIVE_NOTE_FOREIGN_VIEW)) return false;
  const hideable = editor.parentElement, panel = hideable?.parentElement;
  if (!hideable?.matches(".orca-hideable:not(.orca-hideable-hidden)") || !panel?.matches(".orca-panel")
    || panel.dataset.panelId !== panelId || editor.closest(".orca-panel") !== panel) return false;
  const bodies = editor.querySelectorAll<HTMLElement>(":scope > .orca-block-editor-main > .orca-block-editor-blocks[data-hl-container]");
  return bodies.length === 1 && bodies[0].isConnected && bodies[0].closest(".orca-block-editor") === editor
    && !bodies[0].closest(NATIVE_NOTE_FOREIGN_VIEW);
}
function read(value: NativeSourceDescription | null | undefined): ReadSource | null {
  if (!value) return null;
  const { libraryIdentity, librarySession, panelId, rootBlockId, rootViewStateId, editor, owner, rootPublication, composing } = value;
  if (typeof libraryIdentity !== "string" || !libraryIdentity || !object(librarySession)
    || typeof panelId !== "string" || !panelId || !Number.isSafeInteger(rootBlockId)
    || typeof rootViewStateId !== "string" || !rootViewStateId || !object(editor)
    || !object(owner) || !object(rootPublication) || typeof composing !== "boolean") return null;
  const functions = names.map(name => rootPublication[name]);
  if (!functions.every((fn, index) => typeof fn === "function" && fn === owner[names[index]])
    || !physical(editor, panelId, rootBlockId)) return null;
  return { source: Object.freeze({ libraryIdentity, librarySession, panelId, rootBlockId, rootViewStateId, editor, owner }), functions, composing };
}
function contextMatches(value: unknown, source: NativeSourceIdentity): value is NativeSourceContext {
  if (!object(value)) return false;
  const context = value as Partial<NativeSourceContext>;
  return context.panelId === source.panelId && context.rootBlockId === source.rootBlockId && context.active === true
    && context.rootViewStateId === source.rootViewStateId && typeof context.addTask === "function"
    && object(context.editor) && context.editor.current === source.editor;
}
function same(session: Session, now: ReadSource): boolean {
  const a = session.source, b = now.source;
  return a.libraryIdentity === b.libraryIdentity && a.librarySession === b.librarySession && a.panelId === b.panelId
    && a.rootBlockId === b.rootBlockId && a.rootViewStateId === b.rootViewStateId && a.editor === b.editor && a.owner === b.owner
    && session.functions.every((fn, i) => fn === now.functions[i])
    && contextMatches(session.context, b) && session.context.addTask === session.addTask;
}

/** Source actor, independent of any note/F/T render binding. The callback must
 * select the CURRENT actual production Source and read original public state;
 * return null when unavailable. It owns real library/session/active-panel and
 * view-mode discovery, not guesses from navigation args or synthetic ports.
 * No Context fabrication, render probes, carrier
 * creation, permanent enablement or subscription to a consumer's lifetime.
 *
 * Caller drives invalidate() from real Source/library lifecycle subscriptions;
 * revoke() on a known exit prevents leave/return revival even if every visible
 * identity is reused. Unobserved disappear-and-return transitions cannot be
 * detected here. Caller owns subscription teardown; close() retires our work.
 * No cross-instance CAS, global queue drain, persistence or save scheduling. */
export class NativeSourceSessions {
  private session: Session | undefined;
  private closed = false;
  constructor(private readonly readCurrentSource: () => NativeSourceDescription | null | undefined) {}
  private retire(): void {
    const old = this.session; this.session = undefined;
    if (old) for (const close of old.actions) close();
  }
  private refresh(): ReadSource | null {
    if (this.closed) return null;
    try {
      const now = read(this.readCurrentSource());
      if (!now || this.session && !same(this.session, now)) this.retire();
      return now;
    } catch {
      // Fail closed on transient host/read errors; queued plugin promises are
      // rejected by retire, not stranded in the native queue's swallowed errors.
      this.retire(); return null;
    }
  }
  /** Read-only registration of the original context reference. No cleanup is
   * returned: an F/T consumer unmount must NOT revoke a still-current Source. */
  observe(context: unknown): boolean {
    const now = this.refresh();
    if (!now) return false;
    try {
      if (!contextMatches(context, now.source)) return false;
      if (this.session?.context === context) return true;
      this.retire();
      this.session = { ...now, context, addTask: context.addTask, actions: new Set() };
      return true;
    } catch { return false; }
  }
  /** Read-only continuity check for an input's ORIGINAL observed Source. A
   * completed action lease is not retained as permission, and an equal-shaped
   * or retired identity cannot revive without a new genuine observation. */
  isCurrentSource(source: NativeSourceIdentity): boolean {
    const now = this.refresh();
    return !!now && !now.composing && this.session?.source === source;
  }
  request(intent: NativeSourceIntent): NativeSourceRequest {
    if (intent !== "add" && intent !== "edit") throw new TypeError("Unknown native Source intent");
    const now = this.refresh();
    if (!now) return Object.freeze({ kind: "unavailable", reason: this.closed ? "closed" : "no-source" });
    const session = this.session;
    if (!session) return Object.freeze({ kind: "needs-native-menu" });
    if (now.composing) return Object.freeze({ kind: "unavailable", reason: "composing" });
    let open = true, used = false, composing = false, task: NativeTaskLease | undefined;
    const current = () => {
      const latest = this.refresh(); composing = latest?.composing ?? false;
      return open && !!latest && this.session === session;
    };
    const close = () => {
      if (!open) return;
      open = false; session.actions.delete(close); task?.close();
    };
    const guard = Object.freeze({ assertCurrent: () => {
      if (!current()) throw new NativeTaskLeaseError("正文 Source 会话或本次动作已结束。", false);
      if (composing) throw new NativeTaskLeaseError("输入法正在合成，请完成输入法合成后再执行注释操作。", false);
    } });
    const lease: NativeSourceActionLease = Object.freeze({ intent, context: session.context, source: session.source, guard,
      isCurrent: () => current() && !composing,
      enqueue: <T>(action: (guard: NativeTaskGuard) => Promise<T> | T): Promise<T> => {
        if (used) return Promise.reject(new NativeTaskLeaseError("本次 Source 动作已使用；未自动重试。", false));
        used = true;
        try {
          guard.assertCurrent();
          task = new NativeTaskLease(session.context, { panelId: session.source.panelId, rootBlockId: session.source.rootBlockId,
            current, composing: () => composing });
          return task.enqueue(action).finally(close);
        } catch (error) { close(); return Promise.reject(error); }
      }, close });
    session.actions.add(close);
    return Object.freeze({ kind: "ready", lease });
  }
  /** Fresh validation, safe on ordinary state notifications with no change. */
  invalidate(): void { this.refresh(); }
  /** Explicit Source exit/authorization retirement; a later genuine observe
   * can start a new session. Old action leases can never revive. */
  revoke(): void { this.retire(); }
  /** Terminal instance shutdown; does not cancel native input or roll back any
   * already dispatched command. Unfinished actions reject at their next guard. */
  close(): void { this.closed = true; this.retire(); }
}
