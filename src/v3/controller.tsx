import type { Block, CursorData, DbId, Orca } from "../../vendor/orca";
import { projectAnnotations, referenceExcerpt, type AnnotationItem, type AnnotationProjection, type BodyBlock, type Occurrence } from "../vnext/domain";
import { createFloatingSurface } from "../vnext/floating-surface";
import { directoryStorageKey, parseDirectoryLayout, serializeDirectoryLayout, type DirectoryLayout } from "../vnext/directory-layout";
import { NativeMarkerNumbers } from "../vnext/native-reference";
import { TransientFeedback } from "../vnext/navigation-feedback";
import { scrollMountedNativeFooter } from "../vnext/flow-surface";
import { createWorkspaceUI, type MarkerMenuActions } from "../vnext/workspace";
import type { AnnotationRecord, ScopePreferences } from "../vnext/types";
import { DEFAULT_PREFERENCES } from "../vnext/types";
import type { LocationView, WorkspaceActions, WorkspaceItem, WorkspaceView } from "../vnext/ui-contract";
import { NOTE_FORMAT, OWNER_PROPERTY, REF_INLINE, entryText, hasTag, isBlank, isMirror, isNoteFragment, mirroredId, noteReferences, ownerOf, sectionKind, stateMarker, stateOf, type StateMarker } from "./model";
import { FootnoteStore, type PanelEditor } from "./store";
import { createDeleteConfirm, createDirectoryUI, createInputPopup, type InputOption } from "./ui";

type UiRoot = { render(value: import("react").ReactNode): void; unmount(): void };
type Pane = {
  key: string; panelId: string; rootId: DbId; editor: HTMLElement; page: Block; scopeRootId: DbId; ancestors: Block[];
  projection: AnnotationProjection; numbers: Map<DbId, number>; section?: Block; body: Map<DbId, Block>; view: WorkspaceView;
  markers: NativeMarkerNumbers; allEntries: Map<DbId, Block>; tagId?: DbId;
};
type Overlay = "locations" | "deletion";
/** An inline footnote input: from `start` (plain-text offset over the block's
 * text inlines) to the caret. `lead` chars at the start are a typed trigger,
 * replaced together with the query; a command start has no lead. */
export type InputSession = { panelId: string; rootId: DbId; blockId: DbId; start: number; lead: number;
  query: string; selected: number; rect?: DOMRect; token: number; confirming?: boolean;
  /** The user moved the selection; later search results keep it. */
  picked?: boolean;
  /** Orca's own search over the whole library for this query (pinyin included). */
  remote?: { query: string; notes: DbId[]; materials: { id: DbId; text: string; hint: string }[] } };
type MarkerMenuState = { token: number; element: HTMLElement; occurrence: Occurrence; paneKey: string };
const label = (block: Pick<Block, "aliases" | "text" | "content"> | undefined): string =>
  block?.aliases?.[0] || entryText(block as Block).split(/\r?\n/)[0]?.slice(0, 48) || "未命名";
const keyOf = (panelId: string, rootId: DbId) => `${panelId}:${rootId}`;
export { keyOf };
const asRecord = (item: AnnotationItem, block?: Block): AnnotationRecord => ({ ...item, revision: 1, createdAt: block?.created ? +new Date(block.created) : 0,
  updatedAt: block?.modified ? +new Date(block.modified) : 0, ...(stateMarker(block)?.state === "recycled" ? { recycledAt: stateMarker(block)!.at } : {}),
  ...(stateMarker(block)?.state === "archived" ? { archivedAt: stateMarker(block)!.at } : {}) });

/** Runtime of the native-tag footnotes. Data lives in ordinary blocks; this
 * class only reads it, numbers it, decorates it and runs explicit user actions. */
export class FootnoteController {
  readonly store: FootnoteStore;
  readonly actions: WorkspaceActions;
  private readonly React: typeof import("react");
  private readonly ui: ReturnType<typeof createWorkspaceUI>;
  private readonly InputPopup: ReturnType<typeof createInputPopup>;
  private readonly directory: ReturnType<typeof createDirectoryUI>;
  private readonly DeleteConfirm: ReturnType<typeof createDeleteConfirm>;
  private readonly Float: ReturnType<typeof createFloatingSurface>;
  private panes = new Map<string, Pane>();
  private currentKey?: string;
  private listeners = new Set<() => void>();
  private state: WorkspaceView = { loading: true, sourceLabel: "", scopeLabel: "", inherited: false, scopeOptions: [], preferences: DEFAULT_PREFERENCES,
    entries: [], candidates: [], recycled: [], archived: [] };
  private overlay?: Overlay;
  private anchor?: DOMRect;
  private overlayRoot: UiRoot;
  private overlayElement: HTMLElement;
  private navigatorOpen = true;
  private directoryLayout: DirectoryLayout = { position: null, locked: false };
  private markerMenu?: MarkerMenuState;
  private markerToken = 0;
  private input?: InputSession;
  private inputToken = 0;
  private locationTarget?: { itemId: DbId; paneKey: string };
  private deletion?: { itemId: DbId; text: string; references: number; pages: number };
  private deletionIds: DbId[] = [];
  /** Where the caret goes once a footnote deleted from its emptied row is gone. */
  private deletionCaret?: HTMLElement;
  private placeDeletionCaret(): void { const target = this.deletionCaret; this.deletionCaret = undefined; if (target?.isConnected) this.caretToEnd(target); }
  private notice?: string;
  private feedback = new TransientFeedback();
  private hovered = new Set<HTMLElement>();
  private serial: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private observer?: MutationObserver;
  private unsubscribe?: () => void;
  private purgeTimer?: ReturnType<typeof setInterval>;
  private lastBody = new Map<string, CursorData>();
  private active = true;
  private roots: DbId[] = [];
  private readonly events = ["click", "keydown", "keyup", "contextmenu", "input", "pointerdown", "pointerup", "compositionend"] as const;

  constructor(readonly api: Orca, readonly pluginName: string, private readonly subscribeState: (state: object, fn: (ops?: any[]) => void, sync?: boolean) => () => void) {
    this.React = window.React as unknown as typeof import("react");
    this.store = new FootnoteStore(api, () => this.setting("tagName"));
    this.ui = createWorkspaceUI(this.React, api.components);
    this.InputPopup = createInputPopup(this.React, api.components);
    this.directory = createDirectoryUI(this.React, api.components);
    this.DeleteConfirm = createDeleteConfirm(this.React, api.components);
    this.Float = createFloatingSurface(this.React);
    this.actions = this.makeActions();
    try { this.directoryLayout = parseDirectoryLayout(window.localStorage.getItem(directoryStorageKey(pluginName)), this.setting("directoryDefaultLocked") === true); }
    catch { this.directoryLayout = parseDirectoryLayout(null, false); }
    this.overlayElement = document.createElement("div"); this.overlayElement.dataset.ofnNextOverlay = "";
    document.body.append(this.overlayElement);
    this.overlayRoot = window.createRoot(this.overlayElement) as UiRoot;
    const React = this.React, runtime = this;
    const Root = () => { const view = React.useSyncExternalStore(runtime.subscribe, runtime.getSnapshot); return <>{runtime.renderDirectory(view)}{runtime.renderOverlay(view)}{runtime.renderMarkerMenu()}{runtime.renderInput()}</>; };
    this.overlayRoot.render(<Root />);
  }
  // ---------------- state plumbing ----------------
  readonly getSnapshot = (): WorkspaceView => this.state;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<WorkspaceView> = {}): void {
    if (!this.active) return;
    this.state = { ...this.state, ...patch, directoryLayout: this.directoryLayout, footerDisplayed: true, loading: this.busy > 0 || this.switching,
      deletion: this.deletion, notice: this.notice };
    for (const listener of [...this.listeners]) { try { listener(); } catch (error) { console.warn("[footnotes] view listener", error); } }
  }
  private setting(key: string): any { return this.api.state.plugins[this.pluginName]?.settings?.[key]; }
  private preferences(): ScopePreferences {
    const s = this.api.state.plugins[this.pluginName]?.settings ?? {};
    return { ...DEFAULT_PREFERENCES, roots: this.roots, navigatorVisible: s.navigatorVisible !== false, directoryClick: s.directoryClick === "footer" ? "footer" : "body",
      footerStyle: s.footerStyle === "heading" ? "heading" : "rule", title: typeof s.footerTitle === "string" && s.footerTitle.trim() ? s.footerTitle.trim() : "尾注",
      excerptLength: Number.isFinite(s.excerptLength) ? Math.max(24, Math.min(500, s.excerptLength)) : 100,
      archiveDays: Number.isSafeInteger(s.archiveDays) && s.archiveDays > 0 ? s.archiveDays : null };
  }
  report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[footnotes]", error); this.emit({ error: message }); this.api.notify("error", message);
  }
  /** Writes made by the plugin itself; Orca's delete of a footer row by the
   * user is told apart from the plugin's own tidying by this. */
  private ownWrites = 0;
  private tagIdCache?: DbId;
  private run(action: () => Promise<void>): Promise<void> {
    const task = this.serial.then(async () => {
      if (!this.active) return; this.busy++; this.ownWrites++; this.emit({ error: undefined });
      try { await action(); } finally { this.busy--; this.ownWrites--; this.emit(); }
    });
    this.serial = task.catch(error => { if (this.active) this.report(error); });
    return task;
  }
  private rootsKey(): string { return `v3:${this.api.state.repo}:roots`; }
  /** Dialogs opened from a command have no trigger: show them top-center. */
  private centerAnchor(): DOMRect { return new DOMRect(Math.max(16, window.innerWidth / 2 - 220), 72, 0, 0); }
  // ---------------- lifecycle ----------------
  async start(): Promise<void> {
    try { const raw = await this.api.plugins.getData(this.pluginName, this.rootsKey()); const parsed = typeof raw === "string" ? JSON.parse(raw) : [];
      this.roots = Array.isArray(parsed) ? parsed.filter(Number.isSafeInteger) : []; } catch { this.roots = []; }
    this.navigatorOpen = this.preferences().navigatorVisible !== false;
    // Recount when the data changes: right away after switching pages, and
    // once typing pauses while editing (not on every keystroke).
    this.unsubscribe = this.subscribeState(this.api.state, ops => {
      const roots = (ops ?? []).map(op => String((op?.[1] as any[])?.[0]));
      if (!ops || roots.some(root => root === "panels" || root === "activePanel")) { this.showSwitching(); this.scheduleRefresh(30); }
      else if (roots.some(root => root === "blocks" || root === "plugins")) this.scheduleRefresh();
    });
    // DOM changes only need the cheap decoration, unless an editor appeared or left.
    this.observer = new MutationObserver(records => {
      if (!records.some(record => !(record.target as Element).closest?.("[data-ofn-next-overlay]"))) return;
      this.decorate();
      const visible = this.visibleEditors().map(({ panelId, rootId }) => keyOf(panelId, rootId)).sort().join("|");
      if (visible !== [...this.panes.keys()].sort().join("|")) this.scheduleRefresh(30);
    });
    this.observer.observe(document.body, { subtree: true, childList: true });
    for (const type of this.events) document.addEventListener(type, this.onEvent, true);
    this.api.commands.registerBeforeCommand("core.editor.deleteBlocks", this.beforeDelete);
    document.addEventListener("keydown", this.onInputKey, true);
    document.addEventListener("selectionchange", this.onSelection);
    this.purgeTimer = setInterval(() => { if (this.preferences().archiveDays != null) void this.run(() => this.purge(false)).catch(() => {}); }, 3_600_000);
    await this.refresh();
  }
  async stop(): Promise<void> {
    if (!this.active) return;
    this.api.commands.unregisterBeforeCommand("core.editor.deleteBlocks", this.beforeDelete);
    for (const type of this.events) document.removeEventListener(type, this.onEvent, true);
    document.removeEventListener("keydown", this.onInputKey, true);
    document.removeEventListener("selectionchange", this.onSelection);
    this.observer?.disconnect(); this.unsubscribe?.(); if (this.refreshTimer) clearTimeout(this.refreshTimer); if (this.purgeTimer) clearInterval(this.purgeTimer);
    for (const timer of this.tidyTimers.values()) clearTimeout(timer); this.tidyTimers.clear();
    await this.serial.catch(() => {});
    for (const pane of this.panes.values()) { pane.markers.dispose(); this.clearRowNumbers(pane); }
    this.feedback.clear(); this.clearHover(); this.active = false; this.listeners.clear();
    this.overlayRoot.unmount(); this.overlayElement.remove();
  }
  /** Recount `delay` ms after the last change, but at least once a second
   * while changes keep coming. */
  private scheduleRefresh(delay = 300): void {
    if (!this.active) return;
    const now = Date.now(); if (!this.refreshDue) this.refreshDue = now + 1000;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; this.refreshDue = 0; void this.refresh().catch(error => console.warn("[footnotes] refresh", error)); },
      Math.max(0, Math.min(now + delay, this.refreshDue) - now));
  }
  private refreshDue = 0;
  /** After switching pages the directory says "加载中…" until the new page is counted. */
  private switching = false;
  private showSwitching(): void {
    const panel = this.api.state.activePanel, root = this.api.nav.findViewPanel(panel, this.api.state.panels)?.viewArgs?.blockId;
    if (root == null || this.panes.has(keyOf(panel, root)) || this.switching) return;
    this.switching = true; this.emit({ entries: [], candidates: [], usedElsewhere: [], loading: true });
  }
  // ---------------- reading & projection ----------------
  refresh(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
    const task = this.refreshNow().finally(() => { this.refreshing = undefined; if (this.refreshAgain) { this.refreshAgain = false; this.scheduleRefresh(); } });
    this.refreshing = task; return task;
  }
  private visibleEditors(): { editor: HTMLElement; panelId: string; rootId: DbId }[] {
    const out: { editor: HTMLElement; panelId: string; rootId: DbId }[] = [];
    for (const editor of document.querySelectorAll<HTMLElement>(".orca-panel > .orca-hideable:not(.orca-hideable-hidden) > .orca-block-editor[data-block-id]")) {
      const panelId = editor.closest<HTMLElement>(".orca-panel")?.dataset.panelId, rootId = Number(editor.dataset.blockId);
      const native = panelId ? this.api.nav.findViewPanel(panelId, this.api.state.panels) : undefined;
      if (panelId && Number.isSafeInteger(rootId) && native && ["block", "journal"].includes(native.view)) out.push({ editor, panelId, rootId });
    }
    return out;
  }
  /** Fresh reading of one view root: entries, scope, body and numbering. */
  private async compute(rootId: DbId) {
    const tagId = await this.store.tagId();
    const tagged = tagId == null ? [] : await this.store.entries();
    const entries = new Map<DbId, Block>(), inactive: Block[] = [];
    for (const block of tagged) { if (stateOf(block) === "active") entries.set(block.id, block); else inactive.push(block); }
    const ancestors = await this.store.ancestors(rootId);
    const scopeRootId = ancestors.find(block => this.roots.includes(block.id))?.id ?? rootId;
    const rows = await this.store.tree(scopeRootId), all = new Map(rows.map(row => [row.id, row]));
    // Body = scope subtree without footer/store/recycle sections and mirrors.
    const body = new Map<DbId, Block>(), stack = [scopeRootId];
    while (stack.length) {
      const id = stack.pop()!, block = all.get(id); if (!block || body.has(id)) continue;
      if (id !== scopeRootId && (sectionKind(block) || isMirror(block))) continue;
      body.set(id, block); for (const child of block.children ?? []) stack.push(child);
    }
    const blocks: BodyBlock[] = [...body.values()].map(block => ({ id: block.id, parent: block.id === scopeRootId ? null : block.parent,
      children: (block.children ?? []).filter(child => body.has(child)), references: noteReferences(block).map(({ targetId, fragmentIndex }) => ({ targetId, fragmentIndex })) }));
    const items: AnnotationItem[] = [...entries.values()].map(block => ({ id: block.id, ownerRootId: this.ownerOf(block), text: this.textOf(block), comment: "", state: "active" }));
    const projection = projectAnnotations({ viewRootId: scopeRootId, blocks, items });
    return { tagId, entries, inactive, ancestors, scopeRootId, all, body, projection };
  }
  private async refreshNow(): Promise<void> {
    const prefs = this.preferences(), next = new Map<string, Pane>();
    for (const { editor, panelId, rootId } of this.visibleEditors()) {
      const key = keyOf(panelId, rootId), page = await this.store.block(rootId);
      if (!page || sectionKind(page)) continue;
      const { tagId, entries, inactive, ancestors, scopeRootId, all, body, projection } = await this.compute(rootId); this.tagIdCache = tagId;
      const numbers = new Map(projection.entries.map(entry => [entry.item.id, entry.number]));
      const section = this.store.sectionOf(page);
      const previous = this.panes.get(key);
      const markers = previous?.editor === editor ? previous.markers : new NativeMarkerNumbers(editor);
      if (previous && previous.editor !== editor) previous.markers.dispose();
      const row = (item: AnnotationItem, number?: number): WorkspaceItem => {
        const refs = projection.occurrences.filter(occ => occ.targetId === item.id);
        return { item: asRecord(item, entries.get(item.id)), number, referenceCount: refs.length, pageCount: new Set(refs.map(ref => ref.blockId)).size };
      };
      const scopeBlock = all.get(scopeRootId) ?? page;
      const view: WorkspaceView = { loading: false, sourceLabel: label(page), sourceRootId: rootId, scopeRootId, scopeLabel: label(scopeBlock),
        inherited: scopeRootId !== rootId, scopeOptions: ancestors.filter(block => !sectionKind(block)).map(block => ({ id: block.id, label: label(block) })),
        preferences: prefs, entries: projection.entries.map(entry => row(entry.item, entry.number)), candidates: projection.candidates.map(item => row(item)),
        usedElsewhere: projection.usedElsewhere.map(item => row(item)),
        recycled: inactive.filter(block => stateOf(block) === "recycled").map(block => row({ id: block.id, ownerRootId: this.ownerOf(block), text: this.textOf(block), comment: "", state: "recycled" })),
        archived: inactive.filter(block => stateOf(block) === "archived").map(block => row({ id: block.id, ownerRootId: this.ownerOf(block), text: this.textOf(block), comment: "", state: "archived" })) };
      next.set(key, { key, panelId, rootId, editor, page, scopeRootId, ancestors, projection, numbers, section, body, view, markers, allEntries: entries, tagId });
    }
    for (const [key, pane] of this.panes) if (!next.has(key)) { pane.markers.dispose(); this.clearRowNumbers(pane); }
    this.panes = next;
    const active = [...next.values()].find(pane => pane.panelId === this.api.state.activePanel) ?? (this.currentKey ? next.get(this.currentKey) : undefined) ?? next.values().next().value;
    this.currentKey = active?.key;
    this.decorate(); this.switching = false;
    if (active) this.emit({ ...active.view, error: this.state.error });
    else this.emit({ sourceLabel: "未选择正文页面", entries: [], candidates: [], usedElsewhere: [], recycled: [], archived: [], scopeOptions: [] });
    // Keep each footer in number order. Writes only when something is off, and
    // only while the user is not typing in that footer or a footnote input.
    for (const pane of next.values()) if (this.needsTidy(pane)) this.scheduleTidy(pane.key);
    void this.adoptStray().catch(error => console.warn("[footnotes] adopt", error));
  }
  private tidyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** After Ctrl+Z/Ctrl+Y the footer is left as the undo made it, until the next
   * edit; otherwise tidying would redo what the user just undid. */
  private tidyPaused = false;
  private scheduleTidy(key: string): void {
    if (this.tidyTimers.has(key)) return;
    this.tidyTimers.set(key, setTimeout(() => {
      this.tidyTimers.delete(key);
      const pane = this.panes.get(key); if (!pane || !this.active || this.input || this.tidyPaused || !this.needsTidy(pane) || this.editingIn(pane)) return;
      void this.run(() => this.reconcile(key)).catch(() => {});
    }, 1200));
  }
  /** Is the caret inside this pane's footer section right now? */
  private editingIn(pane: Pane): boolean {
    const node = document.getSelection()?.anchorNode, element = node instanceof Element ? node : node?.parentElement;
    return !!element && !!pane.section && !!element.closest(`.orca-block[data-id="${pane.section.id}"]`);
  }
  /** The rows a view root's footer should hold, in order: numbered entries of
   * its scope, then uncited candidates collected under it. */
  private wantedRows(projection: AnnotationProjection): DbId[] {
    return [...projection.entries.map(entry => entry.item.id), ...projection.candidates.map(item => item.id)];
  }
  /** Footer disagrees with what it should show: missing footer/rows, a stale or
   * duplicate mirror, an entry still living inside it, or wrong order. */
  private needsTidy(pane: Pane): boolean {
    const wanted = this.wantedRows(pane.projection), section = pane.section && (this.store.live(pane.section.id) ?? pane.section);
    const caret = this.caretBlockId();
    if (pane.projection.candidates.some(item => { const entry = this.store.live(item.id); return !!entry && isBlank(entry) && item.id !== caret && !this.store.mirrorsOf(entry).includes(caret!); })) return true;
    if (!section) return wanted.length > 0;
    const wantedSet = new Set(wanted), seen: DbId[] = [];
    for (const child of section.children ?? []) {
      const block = this.store.live(child); if (!block) return false; // not loaded yet: decide later
      if (!isMirror(block)) { if (!sectionKind(block) && block.id !== this.caretBlockId()) return true; continue; }
      const target = mirroredId(block);
      if (target == null || !wantedSet.has(target) || seen.includes(target)) return true;
      seen.push(target);
    }
    const order = pane.projection.entries.map(entry => entry.item.id), numberedSeen = seen.filter(id => order.includes(id));
    return wanted.length !== seen.length || numberedSeen.some((id, index) => order[index] !== id);
  }
  /** Where an entry "belongs": the page of its footer section, else its parent. */
  private ownerOf(block: Block): DbId {
    const owner = ownerOf(block); if (owner != null) return owner;
    const marker: StateMarker | undefined = stateMarker(block);
    const parentId = marker?.homeId ?? block.parent;
    const parent = parentId != null ? this.store.live(parentId) : undefined;
    if (parent && sectionKind(parent) === "footer") return parent.parent ?? parent.id;
    return parentId ?? block.id;
  }
  private pane(key = this.currentKey): Pane {
    const pane = key ? this.panes.get(key) : undefined;
    if (!pane || !pane.editor.isConnected) throw new Error("请先打开一篇正文页面。");
    return pane;
  }
  paneOfSection(sectionId: DbId): Pane | undefined { for (const pane of this.panes.values()) if (pane.section?.id === sectionId) return pane; }
  viewOfSection(sectionId: DbId): WorkspaceView | undefined { return this.paneOfSection(sectionId)?.view; }
  actionsOfSection(sectionId: DbId): WorkspaceActions {
    const pane = this.paneOfSection(sectionId);
    return pane ? Object.fromEntries(Object.entries(this.actions).map(([name, fn]) => [name, (...args: any[]) => { this.currentKey = pane.key; (fn as any)(...args); }])) as unknown as WorkspaceActions : this.actions;
  }
  // ---------------- decoration ----------------
  private sectionRows(pane: Pane): HTMLElement[] {
    if (!pane.section) return [];
    const section = [...pane.editor.querySelectorAll<HTMLElement>(`.orca-block[data-id="${pane.section.id}"]`)].find(node => !node.closest(".orca-popup,.orca-block-preview"));
    return section ? [...section.querySelectorAll<HTMLElement>(":scope > .orca-repr > .orca-repr-children > .orca-block[data-id]")] : [];
  }
  private rowEntryId(row: HTMLElement): DbId { return Number(row.dataset.mirrorId ?? row.dataset.id); }
  private decorate(): void {
    for (const pane of this.panes.values()) {
      if (!pane.editor.isConnected) continue;
      // One footer per view: a sub-block's own footer is hidden while an ancestor is viewed.
      for (const repr of pane.editor.querySelectorAll<HTMLElement>(".orca-repr.ofn-v3-section-footer")) {
        const block = repr.closest<HTMLElement>(".orca-block[data-id]"); if (!block) continue;
        const foreign = block.dataset.id !== String(pane.section?.id) && !block.closest(".orca-popup,.orca-block-preview");
        if (foreign) { if (block.dataset.ofnForeign !== "true") block.dataset.ofnForeign = "true"; } else if (block.dataset.ofnForeign) delete block.dataset.ofnForeign;
      }
      try { pane.markers.update(pane.numbers); } catch { /* editor left */ }
      for (const row of this.sectionRows(pane)) {
        const number = pane.numbers.get(this.rowEntryId(row));
        const handle = row.querySelector<HTMLElement>(":scope > .orca-repr > .orca-repr-main > .orca-repr-main-none-editable > .orca-block-handle");
        // Orca draws a handle's data-icon text itself (native style, hover keeps the drag icon).
        // A footnote not cited in this range shows a quiet dot instead of a number.
        const icon = number != null ? `[${number}]` : "[·]";
        if (icon) { row.dataset.ofnNumbered = "true"; if (handle?.getAttribute("data-icon") !== icon) handle?.setAttribute("data-icon", icon); }
        else if (row.dataset.ofnNumbered) { delete row.dataset.ofnNumbered; handle?.removeAttribute("data-icon"); }
      }
    }
  }
  private clearRowNumbers(pane: Pane): void {
    for (const row of this.sectionRows(pane)) if (row.dataset.ofnNumbered) { delete row.dataset.ofnNumbered; row.querySelector(".orca-block-handle")?.removeAttribute("data-icon"); }
  }
  private markerElements(pane: Pane, occurrence: Occurrence): HTMLElement | undefined {
    const blocks = [...pane.editor.querySelectorAll<HTMLElement>(`.orca-block[data-id="${occurrence.blockId}"]`)].filter(node => !node.closest(".orca-popup,.orca-block-preview,.orca-block[data-mirror-id]"));
    for (const block of blocks) {
      const data = pane.body.get(occurrence.blockId); if (!data) continue;
      const ordinal = (data.content ?? []).slice(0, occurrence.fragmentIndex).filter(fragment => fragment.t === "r").length;
      const nodes = [...block.querySelectorAll<HTMLElement>('.orca-inline[data-type="r"]')].filter(node => node.closest(".orca-block") === block);
      const marker = nodes[ordinal]; if (marker?.classList.contains(NOTE_FORMAT)) return marker;
    }
  }
  private clearHover(): void { for (const node of this.hovered) node.classList.remove("ofn-next-highlight"); this.hovered.clear(); }
  private highlightOccurrences(pane: Pane, occurrences: Occurrence[]): void {
    this.clearHover();
    for (const occurrence of occurrences) { const node = this.markerElements(pane, occurrence); if (node) { node.classList.add("ofn-next-highlight"); this.hovered.add(node); } }
  }
  // ---------------- navigation ----------------
  private footerRow(pane: Pane, entryId: DbId): HTMLElement | undefined { return this.sectionRows(pane).find(row => this.rowEntryId(row) === entryId); }
  private async jumpFooter(entryId: DbId, pane = this.pane()): Promise<void> {
    let row = this.footerRow(pane, entryId);
    if (!row) { await this.reconcile(pane.key); await this.refresh(); pane = this.pane(pane.key); row = this.footerRow(pane, entryId); }
    if (!row) throw new Error("文末尾注区里还没有这一条。");
    scrollMountedNativeFooter(pane.editor, row) || row.scrollIntoView({ block: "center" });
    this.feedback.show([row], "ofn-next-footer-highlight", pane.key);
  }
  /** Put the caret at the end of the entry's own text in the footer section. */
  private async editInFooter(entryId: DbId, pane = this.pane(), at: "start" | "end" = "end"): Promise<void> {
    await this.jumpFooter(entryId, pane);
    const row = this.footerRow(pane, entryId), content = row?.querySelector<HTMLElement>(":scope > .orca-repr > .orca-repr-main > .orca-repr-main-content");
    if (!content) return;
    const texts = [...content.querySelectorAll<HTMLElement>('.orca-inline[data-type="t"]')], last = texts.at(-1), first = texts[0];
    const selection = document.getSelection(); if (!selection) return;
    const range = document.createRange();
    if (at === "start") { if (first?.firstChild) range.setStart(first.firstChild, 0); else range.setStart(content, 0); }
    else if (last?.firstChild) range.setStart(last.firstChild, last.firstChild.textContent?.length ?? 0); else range.setStart(content, 0);
    range.collapse(true); pane.editor.focus({ preventScroll: true }); selection.removeAllRanges(); selection.addRange(range);
  }
  /** Scroll to one citation and light it. A citation outside the current view
   * (another page under a shared upper level, or outside a zoomed block) is
   * reached by focusing its block in the same panel; Orca's back returns. */
  private async navigate(occurrence: Occurrence, pane = this.pane()): Promise<void> {
    let marker = this.markerElements(pane, occurrence);
    if (!marker) {
      this.api.nav.goTo("block", { blockId: occurrence.blockId }, pane.panelId);
      const key = keyOf(pane.panelId, occurrence.blockId);
      for (let i = 0; i < 25 && !marker; i++) {
        await new Promise(resolve => setTimeout(resolve, 80)); await this.refresh();
        const next = this.panes.get(key); if (next) { this.currentKey = key; marker = this.markerElements(next, { ...occurrence }); pane = next; }
      }
      if (!marker) throw new Error("引用所在的块没有打开。");
    }
    marker.scrollIntoView({ block: "center" });
    this.feedback.show([marker], "ofn-next-navigation-highlight", pane.key);
  }
  private async locate(id: DbId, rect?: DOMRect): Promise<void> {
    const pane = this.pane(), occurrences = pane.projection.occurrences.filter(row => row.targetId === id);
    if (!occurrences.length) throw new Error("这条尾注在当前范围里没有引用。");
    if (occurrences.length === 1) { await this.navigate(occurrences[0], pane); return; }
    this.locationTarget = { itemId: id, paneKey: pane.key }; this.overlay = "locations"; this.anchor = rect;
    this.emit({ locations: this.locations(id, pane), selectedItemId: id });
  }
  private locations(id: DbId, pane: Pane): LocationView[] {
    const length = this.preferences().excerptLength;
    return pane.projection.occurrences.filter(row => row.targetId === id).map(row => {
      const block = pane.body.get(row.blockId)!, parts = (block.content ?? []).map((fragment, index) => fragment.t === "t" ? String(fragment.v)
        : index === row.fragmentIndex ? `[${row.number ?? "?"}]` : fragment.t === "r" && fragment.f?.includes(NOTE_FORMAT)
          ? `[${pane.numbers.get(block.refs?.find(ref => ref.id === fragment.v)?.to ?? -1) ?? "·"}]` : "￼");
      // Where it is: the block's container (chapter, section), not the block itself.
      const parent = block.parent != null ? pane.body.get(block.parent) : undefined;
      return { key: row.key, blockId: row.blockId, number: row.number ?? 0, pageLabel: label(parent ?? block),
        excerpt: referenceExcerpt(parts.slice(0, row.fragmentIndex).join(""), parts[row.fragmentIndex], parts.slice(row.fragmentIndex + 1).join(""), length) };
    });
  }
  // ---------------- writes ----------------
  /** Bring a page's footer section in line with its numbering: one row per
   * numbered entry (the entry itself if it lives here, else a native mirror),
   * stale mirrors removed, numbered rows first in number order. */
  /** Bring a view root's footer in line: one native mirror per wanted entry
   * (numbered entries of its scope, then candidates collected under it), in
   * that order; stale/duplicate mirrors removed; an entry still living inside
   * a footer (older layout) moves to the store first. The user's own blocks in
   * the footer stay, after our rows. Reads fresh data, so it is correct inside
   * the same undo group as the action that changed the citations. */
  private async reconcile(key = this.currentKey, editor?: PanelEditor, grouped = false): Promise<void> {
    const pane = key ? this.panes.get(key) : undefined; if (!pane) return;
    const ed = editor ?? this.store.editor(pane.panelId);
    const work = async () => {
      await this.adoptWritten(pane, ed);
      const fresh = await this.compute(pane.rootId);
      // An uncited footnote collected here and left empty is dropped, like an
      // empty row (unless the caret is in it).
      const caret = this.caretBlockId(), blank = fresh.projection.candidates.map(item => item.id)
        .filter(id => { const entry = this.store.live(id); return !!entry && isBlank(entry) && !this.store.mirrorsOf(entry).includes(caret!) && id !== caret; });
      if (blank.length) { await this.store.remove(ed, blank.flatMap(id => [...this.store.mirrorsOf(this.store.live(id)), id])); }
      const dropped = new Set(blank), wanted = this.wantedRows(fresh.projection).filter(id => !dropped.has(id)), wantedSet = new Set(wanted);
      const page = this.store.live(pane.rootId) ?? pane.page;
      let section = this.store.sectionOf(page);
      if (!section) { if (!wanted.length) return; section = await this.ensureSection(ed, pane); }
      const rowOf = new Map<DbId, DbId>(), stale: DbId[] = [], living: DbId[] = [];
      for (const child of [...(this.store.live(section.id)?.children ?? section.children)]) {
        const block = this.store.live(child) ?? await this.store.block(child); if (!block) continue;
        if (isMirror(block)) {
          const target = mirroredId(block);
          if (target == null || !wantedSet.has(target) || rowOf.has(target)) stale.push(child); else rowOf.set(target, child);
        } else if (fresh.entries.has(block.id) || hasTag(block, fresh.tagId)) living.push(block.id);
      }
      if (living.length) {
        const store = await this.store.ensureSpecialPage(ed, "store");
        for (const id of living) if (ownerOf(this.store.live(id)) == null)
          await ed.invokeCommand("core.editor.setProperties", null, [id], [{ name: OWNER_PROPERTY, type: 0, value: { version: 3, owner: pane.rootId } }]);
        await this.store.move(ed, living, this.store.live(store.id) ?? store, "lastChild");
      }
      if (stale.length) await this.store.remove(ed, stale);
      // Missing rows are created right where they belong, so order mostly holds.
      for (let i = 0; i < wanted.length; i++) if (!rowOf.has(wanted[i])) {
        const after = i > 0 ? rowOf.get(wanted[i - 1]) ?? null : null;
        rowOf.set(wanted[i], await this.store.createMirrorAt(ed, this.store.live(section.id) ?? section, wanted[i], after));
      }
      // Numbered rows go in number order, in the places numbered rows hold now;
      // uncited footnotes and anything else stay where they were written.
      const numbered = fresh.projection.entries.map(entry => rowOf.get(entry.item.id)).filter((id): id is DbId => id != null), numberedSet = new Set(numbered);
      let next = 0; const desired = [...(this.store.live(section.id)?.children ?? [])].map(child => numberedSet.has(child) ? numbered[next++] : child);
      for (let i = 0; i < desired.length; i++) {
        const current = [...(this.store.live(section.id)?.children ?? [])];
        if (current[i] === desired[i]) continue;
        if (i === 0) await this.store.move(ed, [desired[i]], this.store.live(section.id)!, "firstChild");
        else await this.store.move(ed, [desired[i]], this.store.live(desired[i - 1])!, "after");
      }
    };
    if (grouped) await work(); else await ed.invokeGroup(work, { topGroup: true, undoable: true });
  }
  /** Rows written straight into a footer (Enter at the end of a row, without
   * Tab): a non-blank one becomes a footnote of this view (it then moves to the
   * store like any entry), a blank one is dropped. The row holding the caret
   * is left until the caret moves on. */
  private async adoptWritten(pane: Pane, ed: PanelEditor): Promise<void> {
    const page = this.store.live(pane.rootId) ?? pane.page, section = this.store.sectionOf(page); if (!section) return;
    const tagId = await this.store.tagId(), caret = this.caretBlockId();
    for (const child of [...(this.store.live(section.id)?.children ?? section.children)]) {
      const block = this.store.live(child) ?? await this.store.block(child);
      if (!block || child === caret || isMirror(block) || sectionKind(block) || hasTag(block, tagId)) continue;
      if (isBlank(block)) await this.store.remove(ed, [child]); else await this.store.tagAsEntry(ed, child, pane.rootId);
    }
  }
  private writingRow?: { paneKey: string; id: DbId };
  /** The plain row (not yet a footnote) of a footer that holds the caret. */
  private caretFooterRow(): { paneKey: string; id: DbId } | undefined {
    const id = this.caretBlockId(), block = id != null ? this.store.live(id) : undefined; if (!block || isMirror(block) || block.parent == null) return;
    const pane = [...this.panes.values()].find(candidate => candidate.section?.id === block.parent);
    return pane ? { paneKey: pane.key, id: block.id } : undefined;
  }
  /** Make a written footer row a footnote of this view, in place: tagged, moved
   * to the store, its mirror where the row was. */
  private async adoptRow(paneKey: string, id: DbId): Promise<void> {
    const pane = this.panes.get(paneKey), block = this.store.live(id), section = pane?.section && this.store.live(pane.section.id);
    if (!pane || !block || !section || this.tidyPaused || block.parent !== section.id || isMirror(block) || isBlank(block) || hasTag(block, pane.tagId) || this.caretBlockId() === id) return;
    const editor = this.store.editor(pane.panelId), index = section.children.indexOf(id), before = index > 0 ? section.children[index - 1] : null;
    await editor.invokeGroup(async () => {
      await this.store.tagAsEntry(editor, id, pane.rootId);
      const store = await this.store.ensureSpecialPage(editor, "store");
      await this.store.move(editor, [id], this.store.live(store.id) ?? store, "lastChild");
      await this.store.createMirrorAt(editor, this.store.live(section.id) ?? section, id, before);
    }, { topGroup: true, undoable: true });
    await this.refresh();
  }
  private storeId?: DbId;
  private adopting = false;
  /** Enter in the middle of a footnote (one without comments) splits it through
   * its footer row, and Orca puts the tail into the store, out of sight; text
   * written into the store page directly lands there too. Each such block
   * becomes a footnote of the same view as the footnote before it; a tail no
   * one can see brings the caret along to its new footer row. */
  private async adoptStray(): Promise<void> {
    if (this.adopting || this.tidyPaused || this.input || !this.active) return;
    if (this.storeId == null) { const found = await this.store.specialPage("store"); if (!found) return; this.storeId = found.id; }
    const store = this.store.live(this.storeId); if (!store || sectionKind(store) !== "store") { this.storeId = undefined; return; }
    const pane = this.currentKey ? this.panes.get(this.currentKey) : undefined; if (!pane) return;
    const stray = (store.children ?? []).map(id => this.store.live(id))
      .filter((block): block is Block => !!block && !isMirror(block) && !sectionKind(block) && !hasTag(block, pane.tagId) && !isBlank(block));
    if (!stray.length) return;
    const unseen = stray.find(block => !document.querySelector(`.orca-block[data-id="${block.id}"]`));
    this.adopting = true;
    try {
      await this.run(async () => {
        const editor = this.store.editor(pane.panelId);
        await editor.invokeGroup(async () => {
          for (const block of stray) {
            const index = store.children.indexOf(block.id), left = index > 0 ? this.store.live(store.children[index - 1]) : undefined;
            await this.store.tagAsEntry(editor, block.id, (left && ownerOf(left)) ?? pane.rootId);
          }
          await this.reconcile(pane.key, editor, true);
        }, { topGroup: true, undoable: true });
        await this.refresh();
        if (unseen && this.panes.has(pane.key)) await this.editInFooter(unseen.id, this.pane(pane.key), "start");
      });
    } finally { this.adopting = false; }
  }
  private caretToEnd(content: HTMLElement): void {
    const last = [...content.querySelectorAll<HTMLElement>('.orca-inline[data-type="t"]')].at(-1), selection = document.getSelection(); if (!selection) return;
    const range = document.createRange();
    if (last?.firstChild) range.setStart(last.firstChild, last.firstChild.textContent?.length ?? 0); else range.setStart(content, 0);
    range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
  }
  private caretBlockId(): DbId | undefined {
    const node = document.getSelection()?.anchorNode, element = node instanceof Element ? node : node?.parentElement;
    const id = Number(element?.closest<HTMLElement>(".orca-block[data-id]")?.dataset.id); return Number.isSafeInteger(id) ? id : undefined;
  }
  /** Entry text with references read as their targets' names. */
  private textOf(block: Block | undefined): string { return entryText(block, id => label(this.store.live(id))); }
  private async ensureSection(editor: PanelEditor, pane: Pane): Promise<Block> {
    const page = this.store.live(pane.rootId) ?? pane.page;
    const existing = this.store.sectionOf(page); if (existing) return existing;
    const id = await this.store.createSection(editor, page, this.preferences().title);
    return this.store.live(id) ?? (await this.store.block(id))!;
  }
  /** Delete = remove all its citations + move it to the recycle page. */
  /** Delete footnotes in one undoable step: citations removed, the footnotes
   * moved to the recycle bin. An empty one (no text, no comments) is simply
   * removed; there is nothing to keep. */
  private async recycle(ids: DbId[]): Promise<void> {
    const pane = this.pane(), editor = this.store.editor(pane.panelId);
    const entries = (await Promise.all(ids.map(id => this.store.block(id)))).filter((block): block is Block => !!block);
    if (!entries.length) throw new Error("这条尾注已不存在。");
    await editor.invokeGroup(async () => {
      for (const entry of entries) {
        await this.store.uncite(editor, entry.id);
        await this.store.remove(editor, this.store.mirrorsOf(this.store.live(entry.id) ?? entry));
        if (isBlank(this.store.live(entry.id) ?? entry)) { await this.store.remove(editor, [entry.id]); continue; }
        const bin = await this.store.ensureSpecialPage(editor, "recycle");
        await this.store.setState(editor, entry.id, { state: "recycled", at: Date.now(), homeId: entry.parent ?? undefined });
        await this.store.move(editor, [entry.id], this.store.live(bin.id) ?? bin, "lastChild");
      }
      await this.reconcile(pane.key, editor, true);
    }, { topGroup: true, undoable: true });
  }
  /** Deleting asked for in place (a footer row deleted the Orca way, Backspace
   * in an emptied row, a menu): when citations would go too, ask first;
   * otherwise delete at once (one undo brings it back). */
  private async requestDelete(ids: DbId[], rect?: DOMRect, caretAfter?: HTMLElement): Promise<void> {
    const entries = (await Promise.all(ids.map(id => this.store.block(id)))).filter((block): block is Block => !!block);
    if (!entries.length) return;
    const refs = entries.flatMap(entry => (entry.backRefs ?? []).filter(ref => ref.type === REF_INLINE));
    this.deletionCaret = caretAfter;
    if (!refs.length) { await this.recycle(entries.map(entry => entry.id)); await this.refresh(); this.placeDeletionCaret(); return; }
    const first = this.textOf(entries[0]) || "（空）";
    this.deletion = { itemId: entries[0].id, text: first, references: refs.length, pages: new Set(refs.map(ref => ref.from)).size };
    this.deletionIds = entries.map(entry => entry.id); this.overlay = "deletion"; this.anchor = rect ?? this.centerAnchor(); this.emit();
  }
  /** 删除「…」和正文里的 N 处引用？ */
  private deletionQuestion(): string {
    const deletion = this.deletion; if (!deletion) return "";
    const count = Math.max(1, this.deletionIds.length), text = deletion.text.replace(/\s+/g, " ").trim();
    const what = count > 1 ? `这 ${count} 条尾注` : text && text !== "（空）" ? `「${text.length > 24 ? `${text.slice(0, 24)}…` : text}」` : "这条空尾注";
    return `删除${what}和正文里的 ${deletion.references} 处引用？`;
  }
  /** Orca's own delete of footer rows (select the row and Delete, or the block
   * menu) means deleting those footnotes; otherwise the plugin would just put
   * the rows back. Other blocks in the same deletion go ahead as asked. */
  private beforeDelete = (_command: string, ids: unknown): boolean => {
    if (this.ownWrites > 0 || !this.active || !Array.isArray(ids)) return true;
    const notes: DbId[] = [], others: DbId[] = [], binned: DbId[] = []; let footer = false;
    for (const id of ids) {
      const block = typeof id === "number" ? this.store.live(id) : undefined; if (!block) { if (typeof id === "number") others.push(id); continue; }
      const parent = block.parent != null ? this.store.live(block.parent) : undefined;
      if (sectionKind(block) === "footer") footer = true;
      // Deleting again in the recycle bin moves to the archive (the agreed order).
      else if (sectionKind(parent) === "recycle" && stateOf(block) === "recycled") binned.push(block.id);
      else if (isMirror(block) && sectionKind(parent) === "footer" && mirroredId(block) != null) notes.push(mirroredId(block)!);
      else others.push(block.id);
    }
    if (!notes.length && !binned.length && !footer) return true;
    if (footer && !notes.length && !binned.length) { this.api.notify("info", "尾注区由插件维护；要删尾注，删它里面的行。"); return false; }
    void this.run(async () => {
      if (others.length) await this.activeEditor().invokeCommand("core.editor.deleteBlocks", null, others);
      for (const id of binned) await this.archive(id);
      if (notes.length) await this.requestDelete(notes);
    }).catch(() => {});
    return false;
  };
  /** The active panel's editor, also when it shows one of our pages (the bin). */
  private activeEditor(): PanelEditor { return this.store.editor(this.api.state.activePanel); }
  private async recover(id: DbId): Promise<void> {
    const editor = this.activeEditor(), entry = await this.store.block(id);
    if (!entry) throw new Error("这条尾注已不存在。");
    await editor.invokeGroup(async () => {
      // Back into the store; its owner's footer shows it again, uncited.
      const store = await this.store.ensureSpecialPage(editor, "store");
      await this.store.setState(editor, id, null);
      await this.store.move(editor, [id], this.store.live(store.id) ?? store, "lastChild");
      const pane = this.currentKey ? this.panes.get(this.currentKey) : undefined;
      if (pane && pane.panelId === this.api.state.activePanel) await this.reconcile(pane.key, editor, true);
    }, { topGroup: true, undoable: true });
  }
  private async archive(id: DbId): Promise<void> {
    const editor = this.activeEditor(), entry = await this.store.block(id);
    if (!entry) throw new Error("这条尾注已不存在。");
    await editor.invokeGroup(async () => {
      const page = await this.store.ensureSpecialPage(editor, "archive");
      await this.store.setState(editor, id, { state: "archived", at: Date.now(), homeId: stateMarker(entry)?.homeId });
      await this.store.move(editor, [id], this.store.live(page.id) ?? page, "lastChild");
    }, { topGroup: true, undoable: true });
  }
  private async purge(explicit: boolean): Promise<void> {
    const days = this.preferences().archiveDays; if (days == null) { if (explicit) throw new Error("请先在设置里选择归档保留天数。"); return; }
    const pane = [...this.panes.values()][0]; if (!pane) return;
    const editor = this.store.editor(pane.panelId), cutoff = Date.now() - days * 86_400_000;
    const expired = (await this.store.entries()).filter(block => stateOf(block) === "archived" && (stateMarker(block)?.at ?? Infinity) < cutoff && !(block.backRefs ?? []).some(ref => ref.type === 1));
    if (expired.length) await editor.invokeGroup(() => this.store.remove(editor, expired.map(block => block.id)), { topGroup: true, undoable: true });
    if (explicit) this.api.notify("success", `已清理 ${expired.length} 条到期归档。`);
  }
  // ---------------- inline insertion ----------------
  /** Start a footnote right at the caret. Nothing is inserted: the user types
   * the citation in the body itself while candidates follow below the caret. */
  async beginInsert(cursor?: CursorData | null): Promise<void> {
    if (this.input) return;
    const current = cursor ?? this.api.utils.getCursorDataFromSelection(document.getSelection());
    if (!current || current.mirror) throw new Error("请先在正文里点一下要加尾注的位置。");
    const key = keyOf(current.panelId, current.rootBlockId);
    if (!this.panes.has(key)) await this.refresh();
    if (!this.panes.has(key)) throw new Error("请在正文页面里添加尾注。");
    const pane = this.panes.get(key)!;
    if (cursor) { pane.editor.focus({ preventScroll: true }); await this.api.utils.setSelectionFromCursorData(cursor); }
    this.startSession(key, 0);
  }
  private startSession(key: string, lead: number): void {
    const cursor = this.api.utils.getCursorDataFromSelection(document.getSelection()), pane = this.panes.get(key);
    if (!cursor || !pane || cursor.mirror || keyOf(cursor.panelId, cursor.rootBlockId) !== key) return;
    const at = cursor.isForward ? cursor.focus : cursor.anchor, content = this.contentOf(pane, at.blockId), caret = content && this.caretPlain(content);
    if (caret == null || caret < lead) return;
    this.input = { panelId: cursor.panelId, rootId: cursor.rootBlockId, blockId: at.blockId, start: caret - lead, lead, query: "", selected: -1,
      rect: this.caretRect(), token: ++this.inputToken };
    this.emit();
  }
  private caretRect(): DOMRect | undefined {
    const range = document.getSelection()?.rangeCount ? document.getSelection()!.getRangeAt(0) : undefined;
    const rect = range?.getBoundingClientRect(); return rect && (rect.width || rect.height) ? rect : undefined;
  }
  /** The block's own content element in the body (not a mirror/preview copy). */
  private contentOf(pane: Pane, blockId: DbId): HTMLElement | undefined {
    const block = [...pane.editor.querySelectorAll<HTMLElement>(`.orca-block[data-id="${blockId}"]`)].find(node => !node.closest(".orca-popup,.orca-block-preview,.orca-block[data-mirror-id]"));
    return block?.querySelector<HTMLElement>(":scope > .orca-repr > .orca-repr-main > .orca-repr-main-content") ?? undefined;
  }
  private textInlines(content: HTMLElement): HTMLElement[] { return [...content.children].filter((node): node is HTMLElement => node.matches('.orca-inline[data-type="t"]')); }
  private domPlain(content: HTMLElement): string { return this.textInlines(content).map(node => node.textContent ?? "").join(""); }
  /** Collapsed caret as a plain-text offset over the text inlines only. */
  private caretPlain(content: HTMLElement): number | undefined {
    const selection = document.getSelection(); if (!selection?.rangeCount || !selection.isCollapsed) return;
    const caret = selection.getRangeAt(0); if (!content.contains(caret.startContainer)) return;
    let plain = 0;
    for (const inline of this.textInlines(content)) {
      const length = inline.textContent?.length ?? 0;
      if (caret.comparePoint(inline, inline.childNodes.length) < 0) { plain += length; continue; }
      if (caret.comparePoint(inline, 0) < 0) { const part = document.createRange(); part.setStart(inline, 0); part.setEnd(caret.startContainer, caret.startOffset); plain += part.toString().length; }
      break;
    }
    return plain;
  }
  /** DOM point at a plain offset; "start" prefers the inline that begins there. */
  private pointAt(content: HTMLElement, offset: number, side: "start" | "end"): { node: Node; offset: number } | undefined {
    let begin = 0;
    for (const inline of this.textInlines(content)) {
      const length = inline.textContent?.length ?? 0, end = begin + length;
      if (side === "start" ? offset >= begin && offset < end : offset > begin && offset <= end) {
        const walker = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT); let rest = offset - begin;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) { const n = node.textContent?.length ?? 0; if (rest <= n) return { node, offset: rest }; rest -= n; }
      }
      begin = end;
    }
  }
  private readLiteral(session: InputSession): { query: string; end: number; content: HTMLElement } | undefined {
    const pane = this.panes.get(keyOf(session.panelId, session.rootId)), content = pane && this.contentOf(pane, session.blockId);
    const caret = content && this.caretPlain(content);
    if (!content || caret == null || caret < session.start + session.lead) return;
    return { query: this.domPlain(content).slice(session.start + session.lead, caret), end: caret, content };
  }
  private updateSession(): void {
    const session = this.input; if (!session || session.confirming) return;
    const literal = this.readLiteral(session);
    if (!literal) { this.endSession(); return; }
    if (literal.query !== session.query) {
      const next: InputSession = { ...session, query: literal.query, picked: false, rect: this.caretRect() ?? session.rect };
      this.input = { ...next, selected: this.defaultSelected(next) }; this.scheduleSearch(this.input); this.emit();
    }
  }
  private endSession(): void { if (this.input) { this.input = undefined; this.emit(); } }
  private selectionQueued = false;
  private onSelection = (): void => {
    if (this.selectionQueued) return;
    this.selectionQueued = true; requestAnimationFrame(() => {
      this.selectionQueued = false;
      if (this.input) { this.updateSession(); return; }
      // A row written into a footer becomes a footnote the moment the caret
      // leaves it (Enter to the next row, arrows, a click elsewhere).
      const row = this.caretFooterRow(), previous = this.writingRow; this.writingRow = row;
      if (previous && previous.id !== row?.id) void this.run(() => this.adoptRow(previous.paneKey, previous.id)).catch(() => {});
      for (const pane of this.panes.values()) if (this.needsTidy(pane)) this.scheduleTidy(pane.key);
    });
  };
  /** Popup rows, in order: a new footnote; footnotes of this range (numbered,
   * then collected here); footnotes elsewhere in the library; material
   * anywhere in the library. Empty input lists this range only. */
  private inputOptions(session: InputSession): InputOption[] {
    const pane = this.panes.get(keyOf(session.panelId, session.rootId)); if (!pane) return [];
    const query = session.query.trim(), q = query.toLocaleLowerCase(), out: InputOption[] = [{ kind: "new", text: query }], seen = new Set<DbId>();
    const remote = session.remote?.query === query ? session.remote : undefined, found = new Set(remote?.notes ?? []);
    const hits = (id: DbId) => { const block = pane.allEntries.get(id); return !!block && (!q || found.has(id) || this.textOf(block).toLocaleLowerCase().includes(q)); };
    const note = (id: DbId, hint: string, here: boolean) => { const block = pane.allEntries.get(id); if (!block || seen.has(id)) return false; seen.add(id); out.push({ kind: "note", id, text: this.textOf(block), hint, here }); return true; };
    let here = 0;
    for (const entry of pane.projection.entries) if (here < 8 && hits(entry.item.id) && note(entry.item.id, `[${entry.number}]`, true)) here++;
    for (const item of pane.projection.candidates) if (here < 8 && hits(item.id) && note(item.id, "未引用", true)) here++;
    for (const item of pane.projection.usedElsewhere) if (here < 8 && hits(item.id) && note(item.id, "别处已引用", true)) here++;
    if (!q) return out;
    let elsewhere = 0;
    for (const [id, block] of [...pane.allEntries].sort(([a], [b]) => b - a)) {
      if (elsewhere >= 5) break;
      if (!seen.has(id) && hits(id)) { const owner = this.store.live(this.ownerOf(block)); if (note(id, owner ? label(owner) : "", false)) elsewhere++; }
    }
    for (const material of remote?.materials ?? []) if (!seen.has(material.id)) { seen.add(material.id); out.push({ kind: "material", ...material }); }
    return out;
  }
  /** Typing prefers a matching footnote already in this range (citing the same
   * source again); otherwise a new one. Footnotes of other pages and material
   * are offered below, never preselected. Before anything is typed nothing is
   * selected (Enter stays a line break). */
  private defaultSelected(session: InputSession): number {
    if (!session.query.trim()) return -1;
    const index = this.inputOptions(session).findIndex(option => option.kind === "note" && option.here);
    return index >= 0 ? index : 0;
  }
  private searchTimer?: ReturnType<typeof setTimeout>;
  private scheduleSearch(session: InputSession): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    const query = session.query.trim(); if (!query) return;
    this.searchTimer = setTimeout(() => { void this.search(session.token, query).catch(error => console.warn("[footnotes] search", error)); }, 160);
  }
  /** Orca's own text search (as @ uses): footnotes it finds join the matches;
   * other blocks are material, except our own pages, footers and bins, and
   * body blocks that only match through a footnote they cite. */
  private async search(token: number, query: string): Promise<void> {
    const result = await this.api.invokeBackend("search-blocks-by-text", query) as unknown;
    const current = () => { const session = this.input; return session && session.token === token && session.query.trim() === query ? session : undefined; };
    const session = current(), pane = session && this.panes.get(keyOf(session.panelId, session.rootId)); if (!session || !pane) return;
    const rows = Array.isArray(result) ? (result as unknown[]).flat() : [], q = query.toLocaleLowerCase();
    const notes: DbId[] = [], materials: { id: DbId; text: string; hint: string }[] = [], seen = new Set<DbId>();
    for (const row of rows) {
      const given = (row as { block?: Block } | null)?.block, id = given?.id ?? (row as { id?: unknown } | null)?.id;
      if (typeof id !== "number" || seen.has(id) || id === session.blockId) continue; seen.add(id);
      if (pane.allEntries.has(id)) { notes.push(id); continue; }
      if (materials.length >= 6) continue;
      const block = this.store.live(id) ?? given ?? await this.store.block(id);
      if (!block || id === pane.tagId || hasTag(block, pane.tagId) || isMirror(block) || sectionKind(block)) continue;
      if ((block.content ?? []).some(isNoteFragment) && !entryText(block).toLocaleLowerCase().includes(q)) continue;
      const chain = await this.store.ancestors(id); if (chain.some(item => sectionKind(item))) continue;
      const top = chain[chain.length - 1];
      materials.push({ id, text: label(block), hint: top && top.id !== id ? label(top) : "" });
    }
    // Other pages' footnotes are labelled with their page; load those pages' names.
    for (const [id, entry] of pane.allEntries) if (notes.includes(id) || this.textOf(entry).toLocaleLowerCase().includes(q)) { const owner = this.ownerOf(entry); if (!this.store.live(owner)) await this.store.block(owner); }
    const latest = current(); if (!latest) return;
    const next: InputSession = { ...latest, remote: { query, notes, materials } };
    this.input = latest.picked ? next : { ...next, selected: this.defaultSelected(next) }; this.emit();
  }
  private onInputKey = (event: KeyboardEvent): void => {
    if (this.overlay === "deletion" && this.deletion && event.key === "Enter" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); this.actions.confirmRecycle(); return; }
    const session = this.input; if (!session || event.isComposing || event.keyCode === 229) return;
    if (!["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"].includes(event.key)) return;
    const options = this.inputOptions(session);
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.endSession(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      const from = session.selected < 0 ? (event.key === "ArrowDown" ? -1 : 0) : session.selected;
      if (options.length) this.input = { ...session, picked: true, selected: (from + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length };
      this.emit(); return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const option = options[session.selected]; if (!option) { this.endSession(); return; }
      event.preventDefault(); event.stopPropagation(); void this.confirmInput(option);
    }
  };
  async confirmInput(option: InputOption): Promise<void> {
    const session = this.input; if (!session || session.confirming) return;
    this.input = { ...session, confirming: true }; this.emit();
    try {
      await this.run(async () => {
        const key = keyOf(session.panelId, session.rootId), pane = this.pane(key), editor = this.store.editor(session.panelId);
        // The native model commits typing a moment later; wait until it holds the same text.
        const modelPlain = () => (this.store.live(session.blockId)?.content ?? []).map(f => f.t === "t" ? String(f.v ?? "") : "").join("");
        let literal = this.readLiteral(session);
        for (let i = 0; i < 25 && literal && modelPlain() !== this.domPlain(literal.content); i++) { await new Promise(resolve => setTimeout(resolve, 60)); literal = this.readLiteral(session); }
        if (!literal || modelPlain() !== this.domPlain(literal.content)) throw new Error("正文还在保存中，请再按一次回车。");
        const query = literal.query.trim();
        // Select exactly the literal (lead + query) and let Orca map it to model positions.
        const from = this.pointAt(literal.content, session.start, "start"), to = this.pointAt(literal.content, literal.end, "end");
        const selection = document.getSelection();
        if (from && to && selection && literal.end > session.start) { const range = document.createRange(); range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset); selection.removeAllRanges(); selection.addRange(range); }
        const cursor = this.api.utils.getCursorDataFromSelection(document.getSelection());
        if (!cursor || cursor.mirror || cursor.anchor.blockId !== session.blockId || cursor.focus.blockId !== session.blockId) throw new Error("引用位置已变化，未改动正文。");
        let entryId!: DbId;
        await editor.invokeGroup(async () => {
          if (option.kind === "note") entryId = option.id;
          else {
            const store = await this.store.ensureSpecialPage(editor, "store");
            entryId = option.kind === "material" ? await this.store.createEntryFor(editor, store, option.id, pane.rootId)
              : await this.store.createEntry(editor, store, query, pane.rootId);
          }
          await this.store.cite(editor, cursor, session.blockId, entryId);
          await this.reconcile(key, editor, true);
        }, { topGroup: true, undoable: true });
        const after = this.api.utils.getCursorDataFromSelection(document.getSelection());
        if (after) { const end = after.isForward ? after.focus : after.anchor; await this.api.utils.setSelectionFromCursorData({ ...after, isForward: true, anchor: end, focus: end }); }
        this.input = undefined; this.emit();
        await this.refresh();
        // Nothing typed: the new footnote is written in the footer, as in Word.
        if (option.kind === "new" && !query) await this.editInFooter(entryId, this.pane(key));
      });
    } finally { if (this.input?.token === session.token) { this.input = { ...this.input, confirming: false }; this.emit(); } }
  }
  // ---------------- events ----------------
  private onEvent = (event: Event): void => {
    if (!this.active || !(event.target instanceof Element)) return;
    if (event.type === "keydown") {
      const key = event as KeyboardEvent;
      if ((key.ctrlKey || key.metaKey) && /^[zy]$/i.test(key.key)) this.tidyPaused = true;
      else if (!key.ctrlKey && !key.metaKey && !key.altKey && (key.key.length === 1 || key.keyCode === 229 || ["Enter", "Backspace", "Delete", "Tab"].includes(key.key))) this.tidyPaused = false;
    }
    const target = event.target, editor = target.closest<HTMLElement>(".orca-block-editor");
    if (event.type === "input" || event.type === "compositionend") { if (this.input) queueMicrotask(() => this.updateSession()); else this.maybeTrigger(event); return; }
    if (event.type === "keyup") { const key = event as KeyboardEvent; if (!this.input && key.key.length === 1 && !key.ctrlKey && !key.metaKey && !key.altKey) this.maybeTrigger(event); }
    if (event.type === "pointerdown" && this.input && !target.closest("[data-ofn-input-popup]")) { queueMicrotask(() => this.updateSession()); }
    const pane = editor ? [...this.panes.values()].find(p => p.editor === editor) : undefined;
    if (!pane) return;
    if (event.type === "pointerup" || event.type === "keydown") {
      queueMicrotask(() => { try { const cursor = this.api.utils.getCursorDataFromSelection(document.getSelection()); if (cursor && !cursor.mirror) this.lastBody.set(pane.key, cursor); } catch { /* none */ } });
      if (this.input && event.type === "pointerup") queueMicrotask(() => this.updateSession());
    }
    if (event.type === "keydown" && this.guardBoundary(event as KeyboardEvent, pane)) return;
    // The [n] on a footer row stands for "back to the citation".
    const handle = target.closest<HTMLElement>(".orca-block-handle[data-icon]");
    if (event.type === "click" && handle && (event as MouseEvent).button === 0) {
      const row = handle.closest<HTMLElement>(".orca-block[data-id]");
      if (row && this.sectionRows(pane).includes(row) && pane.numbers.has(this.rowEntryId(row))) {
        event.preventDefault(); event.stopPropagation(); this.currentKey = pane.key;
        const rect = handle.getBoundingClientRect(), id = this.rowEntryId(row);
        void this.run(() => this.locate(id, rect)).catch(() => {}); return;
      }
    }
    const marker = target.closest<HTMLElement>(`.orca-inline[data-type="r"].${NOTE_FORMAT}`);
    if (!marker || marker.closest(".orca-block[data-mirror-id],.orca-popup,.orca-block-preview")) return;
    const occurrence = this.occurrenceFrom(pane, marker); if (!occurrence) return;
    if (event.type === "contextmenu") {
      const mouse = event as MouseEvent; if (mouse.shiftKey || mouse.altKey || mouse.ctrlKey || mouse.metaKey) return;
      mouse.preventDefault(); mouse.stopPropagation(); this.currentKey = pane.key;
      this.markerMenu = { token: ++this.markerToken, element: marker, occurrence, paneKey: pane.key }; this.emit(); return;
    }
    if (event.type === "click") {
      const click = event as MouseEvent; if (click.button !== 0 || click.altKey || click.shiftKey || click.ctrlKey || click.metaKey) return;
      click.preventDefault(); click.stopPropagation(); this.currentKey = pane.key;
      const edit = this.setting("referenceClick") === "edit";
      void this.run(async () => { this.emit({ selectedItemId: occurrence.targetId }); if (edit) await this.editInFooter(occurrence.targetId, pane); else await this.jumpFooter(occurrence.targetId, pane); }).catch(() => {});
    } else if (event.type === "keydown") {
      const key = event as KeyboardEvent; if (key.isComposing || key.altKey || key.shiftKey || key.ctrlKey || key.metaKey || document.activeElement !== marker) return;
      if (["Enter", " ", "F2"].includes(key.key)) { key.preventDefault(); key.stopPropagation();
        void this.run(() => key.key === "F2" ? this.editInFooter(occurrence.targetId, pane) : this.jumpFooter(occurrence.targetId, pane)).catch(() => {}); }
    }
  };
  /** In a footer section, Backspace at the start of a row (or Delete at its end)
   * would merge two footnotes into one and break the citation of the second.
   * Only that one case is held back; every other edit stays native. */
  private guardBoundary(event: KeyboardEvent, pane: Pane): boolean {
    if ((event.key !== "Backspace" && event.key !== "Delete") || event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
    const selection = document.getSelection(); if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const rows = this.sectionRows(pane); if (!rows.length) return false;
    const node = selection.anchorNode, element = node instanceof Element ? node : node?.parentElement;
    const row = rows.find(candidate => { const content = candidate.querySelector(":scope > .orca-repr > .orca-repr-main > .orca-repr-main-content"); return !!content && !!element && content.contains(element); });
    if (!row) return false;
    const content = row.querySelector<HTMLElement>(":scope > .orca-repr > .orca-repr-main > .orca-repr-main-content")!, caret = this.caretPlain(content), index = rows.indexOf(row);
    // Only a footnote (a mirror row) must not be merged away; a row just written
    // (not a footnote yet) may be, e.g. Backspace right after an accidental Enter.
    const isNote = (candidate?: HTMLElement) => !!candidate?.hasAttribute("data-mirror-id");
    // The first row is never merged into the footer's title either.
    const atStart = caret === 0 && event.key === "Backspace" && (isNote(row) || index === 0);
    const atEnd = event.key === "Delete" && caret === this.domPlain(content).length && index < rows.length - 1 && isNote(rows[index + 1]) && !row.querySelector(":scope > .orca-repr > .orca-repr-children > .orca-block");
    if (!atStart && !atEnd) return false;
    event.preventDefault(); event.stopPropagation();
    // Backspace in a footnote whose text is all gone: delete that footnote; the
    // caret goes to the end of the row above, as with any emptied line.
    const id = this.rowEntryId(row), above = rows[index - 1]?.querySelector<HTMLElement>(":scope > .orca-repr > .orca-repr-main > .orca-repr-main-content");
    if (atStart && isNote(row) && !this.textOf(this.store.live(id))) {
      // The caret moves up only once the footnote is really deleted (not on 取消).
      const rect = row.getBoundingClientRect(); void this.run(() => this.requestDelete([id], rect, above ?? undefined)).catch(() => {});
    } else if (atStart && !isNote(row) && isBlank(this.store.live(id))) {
      void this.run(async () => { await this.store.remove(this.store.editor(pane.panelId), [id]); }).catch(() => {});
    }
    return true;
  }
  /** Optional quick syntax (e.g. "^^"): typing it in body text starts a session,
   * and the syntax itself is replaced together with the citation. */
  private maybeTrigger(event: Event): void {
    const trigger = this.setting("triggerSymbol");
    if (typeof trigger !== "string" || !trigger || this.input) return;
    if (event instanceof InputEvent && (event.isComposing || !event.data || !trigger.endsWith(event.data))) return;
    const editor = (event.target as Element).closest?.(".orca-block-editor"), pane = [...this.panes.values()].find(p => p.editor === editor);
    if (!pane) return;
    setTimeout(() => {
      if (this.input) return;
      const cursor = this.api.utils.getCursorDataFromSelection(document.getSelection());
      const at = cursor && !cursor.mirror ? (cursor.isForward ? cursor.focus : cursor.anchor) : undefined;
      const content = at && this.contentOf(pane, at.blockId), caret = content && this.caretPlain(content);
      if (!content || caret == null || caret < trigger.length || this.domPlain(content).slice(caret - trigger.length, caret) !== trigger) return;
      this.startSession(pane.key, trigger.length);
    }, 0);
  }
  private occurrenceFrom(pane: Pane, marker: HTMLElement): Occurrence | undefined {
    const blockEl = marker.closest<HTMLElement>(".orca-block[data-id]"), data = blockEl ? pane.body.get(Number(blockEl.dataset.id)) : undefined;
    if (!blockEl || !data) return;
    const nodes = [...blockEl.querySelectorAll<HTMLElement>('.orca-inline[data-type="r"]')].filter(node => node.closest(".orca-block") === blockEl);
    const ordinal = nodes.indexOf(marker), indices = (data.content ?? []).flatMap((fragment, index) => fragment.t === "r" ? [index] : []), fragmentIndex = indices[ordinal];
    return pane.projection.occurrences.find(row => row.blockId === data.id && row.fragmentIndex === fragmentIndex);
  }
  // ---------------- actions ----------------
  private makeActions(): WorkspaceActions {
    const noop = () => {};
    const a: WorkspaceActions = {
      select: (id, rect) => { void this.run(async () => { this.emit({ selectedItemId: id }); if (this.preferences().directoryClick === "footer") await this.jumpFooter(id); else await this.locate(id, rect); }).catch(noop); },
      closeNavigator: () => { this.navigatorOpen = false; this.clearHover(); this.emit(); },
      toggleDirectoryLock: () => this.setDirectoryLayout({ ...this.directoryLayout, locked: !this.directoryLayout.locked }),
      resetDirectoryPosition: () => this.setDirectoryLayout({ ...this.directoryLayout, position: null }),
      toggleFooter: noop, directoryClick: value => { void this.setSettings({ directoryClick: value }); },
      changeInput: noop, confirmInput: noop, cancelInput: noop, retryInput: noop, backToList: noop, pickReference: noop, cancelPickReference: noop, removeSelectedOccurrence: noop,
      navigatorVisible: value => { void this.setSettings({ navigatorVisible: value }); this.navigatorOpen = value; this.emit(); },
      footerVisible: noop,
      // 收集引文: the same as Enter in the footer, a new row at its end with the
      // caret in it; written and left, it becomes a footnote; left empty, it goes.
      // (Creating an empty footnote first was dropped at once as an empty one.)
      create: () => { void this.run(async () => {
        const pane = this.pane(), editor = this.store.editor(pane.panelId);
        const section = (pane.section && this.store.live(pane.section.id)) ?? await this.ensureSection(editor, pane);
        const id = await editor.invokeCommand("core.editor.insertBlock", null, section, "lastChild", null) as DbId;
        this.overlay = undefined; await this.refresh();
        let content: HTMLElement | null = null;
        for (let i = 0; i < 20 && !content; i++) { content = this.pane(pane.key).editor.querySelector<HTMLElement>(`.orca-block[data-id="${id}"] > .orca-repr > .orca-repr-main > .orca-repr-main-content`); if (!content) await new Promise(resolve => setTimeout(resolve, 50)); }
        if (!content) throw new Error("新的一行没有出现，请再试一次。");
        content.scrollIntoView({ block: "center" }); this.pane(pane.key).editor.focus({ preventScroll: true }); this.caretToEnd(content);
      }).catch(noop); },
      edit: id => { void this.run(async () => { this.overlay = undefined; await this.editInFooter(id); }).catch(noop); },
      use: id => { void this.run(async () => {
        const pane = this.pane(), cursor = this.lastBody.get(pane.key); if (!cursor) throw new Error("请先在正文里点一下要引用的位置。");
        const editor = this.store.editor(pane.panelId), at = cursor.isForward ? cursor.focus : cursor.anchor, point: CursorData = { ...cursor, anchor: at, focus: at };
        await editor.invokeGroup(async () => { await this.store.cite(editor, point, at.blockId, id); await this.reconcile(pane.key, editor, true); }, { topGroup: true, undoable: true });
        await this.refresh();
      }).catch(noop); },
      hover: id => { const pane = this.currentKey && this.panes.get(this.currentKey); if (!pane || id == null) { this.clearHover(); return; } this.highlightOccurrences(pane, pane.projection.occurrences.filter(row => row.targetId === id)); },
      hoverOccurrence: key => { const pane = this.locationTarget && this.panes.get(this.locationTarget.paneKey); if (!pane || key == null) { this.clearHover(); return; }
        this.highlightOccurrences(pane, pane.projection.occurrences.filter(row => row.key === key)); },
      locate: (id, rect) => { void this.run(() => this.locate(id, rect)).catch(noop); },
      recycle: id => { void this.run(() => this.requestDelete([id])).catch(noop); },
      confirmRecycle: () => { const deletion = this.deletion; if (!deletion) return; const ids = this.deletionIds.length ? this.deletionIds : [deletion.itemId];
        void this.run(async () => { await this.recycle(ids); this.deletion = undefined; this.deletionIds = []; this.overlay = undefined; await this.refresh(); this.placeDeletionCaret(); }).catch(noop); },
      cancelRecycle: () => { this.deletion = undefined; this.deletionIds = []; this.deletionCaret = undefined; this.overlay = undefined; this.emit(); },
      archive: id => { void this.run(async () => { await this.archive(id); await this.refresh(); }).catch(noop); },
      recover: id => { void this.run(async () => { await this.recover(id); await this.refresh(); this.notice = "已恢复为未引用的尾注，会出现在原来那页的尾注区；正文里的上标不会自动补回。"; }).catch(noop); },
      purgeExpired: () => { void this.run(async () => { await this.purge(true); await this.refresh(); }).catch(noop); },
      scope: id => { void this.run(async () => {
        const pane = this.pane(), roots = new Set(this.roots);
        if (id == null) roots.delete(pane.rootId);
        else { const index = pane.ancestors.findIndex(block => block.id === id); if (index < 0) throw new Error("只能选择本页或它的上层页面。");
          for (const block of pane.ancestors.slice(0, index)) roots.delete(block.id); roots.add(id); }
        this.roots = [...roots]; await this.api.plugins.setData(this.pluginName, this.rootsKey(), JSON.stringify(this.roots));
        await this.refresh(); await this.reconcile(pane.key);
      }).catch(noop); },
      placement: noop, footerStyle: value => { void this.setSettings({ footerStyle: value }); }, locationMode: noop,
      excerptLength: value => { void this.setSettings({ excerptLength: value }); }, archiveDays: value => { void this.setSettings({ archiveDays: value ?? 0 }); },
      changeDraft: noop, closeEditor: noop, restoreHistory: noop,
      chooseLocation: key => { const target = this.locationTarget; void this.run(async () => {
        const pane = target && this.panes.get(target.paneKey), occurrence = pane?.projection.occurrences.find(row => row.key === key);
        this.overlay = undefined; this.locationTarget = undefined; this.emit({ locations: undefined }); if (pane && occurrence) await this.navigate(occurrence, pane); }).catch(noop); },
      closeLocations: () => { this.overlay = undefined; this.locationTarget = undefined; this.clearHover(); this.emit({ locations: undefined }); },
      copyItem: id => { void this.run(async () => { await navigator.clipboard.writeText(this.textOf(await this.store.block(id))); this.api.notify("success", "已复制这条尾注。"); }).catch(noop); },
      copyDocument: () => { void this.run(async () => { await navigator.clipboard.writeText(this.exportMarkdown(this.pane())); this.api.notify("success", "已复制本范围正文和尾注（Markdown）。"); }).catch(noop); },
      importLegacy: noop,
      manage: () => { this.openBin(); },
    };
    return a;
  }
  private async setSettings(patch: Record<string, unknown>): Promise<void> {
    const settings = { ...this.api.state.plugins[this.pluginName]?.settings, ...patch };
    await this.api.plugins.setSettings("repo", this.pluginName, settings); await this.refresh();
  }
  private setDirectoryLayout(next: DirectoryLayout): void {
    this.directoryLayout = parseDirectoryLayout(serializeDirectoryLayout(next)); this.emit();
    try { window.localStorage.setItem(directoryStorageKey(this.pluginName), serializeDirectoryLayout(this.directoryLayout)); } catch { /* best effort */ }
  }
  /** For the native block menu: is this block an active footnote entry? */
  /** A footer row is a mirror; its footnote is the block it mirrors. */
  private entryOf(blockId: DbId): DbId { const block = this.store.live(blockId); return block && isMirror(block) ? mirroredId(block) ?? blockId : blockId; }
  isEntry(blockId: DbId): boolean { const id = this.entryOf(blockId), block = this.store.live(id); return !!block && stateOf(block) === "active" && [...this.panes.values()].some(p => p.allEntries.has(id)); }
  backToBody(blockId: DbId, rect?: DOMRect): void { const id = this.entryOf(blockId); void this.run(() => this.locate(id, rect)).catch(() => {}); }
  deleteEntry(blockId: DbId, rect?: DOMRect): void { const id = this.entryOf(blockId); void this.run(() => this.requestDelete([id], rect)).catch(() => {}); }
  toggleNavigator(): void { this.navigatorOpen = !this.navigatorOpen; this.clearHover(); this.emit(); }
  /** Section menu: put rows back in number order (mirrors added/removed as needed). */
  tidySection(sectionId: DbId): void { const pane = this.paneOfSection(sectionId); if (pane) void this.run(async () => { await this.reconcile(pane.key); await this.refresh(); }).catch(() => {}); }
  archiveDays(): number | null { return this.preferences().archiveDays ?? null; }
  /** The recycle bin is an ordinary page; open it in the active panel. */
  openBin(): void {
    void this.run(async () => {
      const bin = await this.store.specialPage("recycle");
      if (!bin) { this.api.notify("info", "回收站是空的。"); return; }
      this.api.nav.goTo("block", { blockId: bin.id }, this.api.state.activePanel);
    }).catch(() => {});
  }
  /** "active", "recycled", "archived", or undefined when the block (or the
   * block a footer row mirrors) is not a footnote. */
  entryState(blockId: DbId): "active" | "recycled" | "archived" | undefined {
    const id = this.entryOf(blockId), block = this.store.live(id);
    return block && hasTag(block, this.tagIdCache) ? stateOf(block) : undefined;
  }
  recoverEntry(blockId: DbId): void { const id = this.entryOf(blockId); void this.run(async () => { await this.recover(id); await this.refresh(); this.api.notify("success", "已恢复，在原来那一页的尾注区里（未引用）；正文上标不会自动补回。"); }).catch(() => {}); }
  /** Plain Markdown of the scope body, citations as [^n], definitions after. */
  private exportMarkdown(pane: Pane): string {
    const lines: string[] = [], walk = (id: DbId, depth: number) => {
      const block = pane.body.get(id); if (!block) return;
      const text = (block.content ?? []).map(fragment => {
        if (fragment.t === "t") return String(fragment.v ?? "");
        const ref = noteReferences({ ...block, content: [fragment] }).length ? block.refs.find(r => r.id === fragment.v) : undefined;
        return ref && pane.numbers.has(ref.to) ? `[^${pane.numbers.get(ref.to)}]` : "";
      }).join("");
      if (id !== pane.scopeRootId || text) lines.push(`${"  ".repeat(Math.max(0, depth - 1))}${depth > 0 ? "- " : ""}${text}`);
      for (const child of block.children ?? []) walk(child, depth + 1);
    };
    walk(pane.scopeRootId, 0);
    lines.push("");
    for (const entry of pane.projection.entries) lines.push(`[^${entry.number}]: ${entry.item.text}`);
    return lines.join("\n");
  }
  // ---------------- rendering ----------------
  private renderDirectory(view: WorkspaceView): import("react").ReactElement {
    const React = this.React, inset = this.setting("directoryDefaultInset");
    return <this.Float directory visible={this.navigatorOpen} className="ofn-next-popup ofn-next-directory-popup"
      layout={this.directoryLayout} defaultInset={Number.isFinite(inset) ? Math.max(12, Math.min(300, inset)) : 60}
      onLayoutChange={next => { if (!this.directoryLayout.locked) this.setDirectoryLayout({ ...this.directoryLayout, position: next.position }); }}>
      <this.directory.Directory view={view} actions={this.actions} />
    </this.Float>;
  }
  private renderOverlay(view: WorkspaceView): import("react").ReactElement | null {
    if (!this.overlay) return null;
    const React = this.React, mode = this.overlay;
    const close = () => { if (mode === "deletion") { this.actions.cancelRecycle(); return; } this.overlay = undefined; this.locationTarget = undefined; this.clearHover(); this.emit({ locations: undefined }); };
    const content = mode === "locations" ? <this.ui.Locations view={view} actions={this.actions} />
      : <this.DeleteConfirm text={this.deletionQuestion()} busy={view.loading} onConfirm={() => this.actions.confirmRecycle()} onCancel={() => this.actions.cancelRecycle()} />;
    return <this.Float key={mode} rect={this.anchor} draggable={mode === "locations"} dismissible onDismiss={close} className="ofn-next-popup ofn-next-input-popup">{content}</this.Float>;
  }
  private renderMarkerMenu(): import("react").ReactElement | null {
    const menu = this.markerMenu; if (!menu || !menu.element.isConnected) return null;
    const React = this.React, current = () => this.markerMenu?.token === menu.token, id = menu.occurrence.targetId;
    const actions: MarkerMenuActions = {
      close: () => { if (current()) { this.markerMenu = undefined; this.emit(); } },
      editContent: () => { void this.run(() => this.editInFooter(id, this.pane(menu.paneKey))).catch(() => {}); },
      showFooter: () => { void this.run(() => this.jumpFooter(id, this.pane(menu.paneKey))).catch(() => {}); },
      removeHere: () => { void this.run(async () => {
        const pane = this.pane(menu.paneKey), editor = this.store.editor(pane.panelId);
        await editor.invokeGroup(async () => { await this.store.uncite(editor, id, { blockId: menu.occurrence.blockId, fragmentIndex: menu.occurrence.fragmentIndex }); await this.reconcile(pane.key, editor, true); }, { topGroup: true, undoable: true });
        await this.refresh();
      }).catch(() => {}); },
    };
    return <this.ui.MarkerMenu key={menu.token} target={menu.element} number={menu.occurrence.number} actions={actions} />;
  }
  private renderInput(): import("react").ReactElement | null {
    const session = this.input; if (!session) return null;
    const React = this.React;
    const options = this.inputOptions(session);
    return <this.InputPopup key={session.token} rect={session.rect} options={options} selected={session.selected}
      busy={!!session.confirming} onChoose={index => { const option = options[index]; if (option) void this.confirmInput(option); }} />;
  }
}
