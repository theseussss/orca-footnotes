import type { DbId } from "../../vendor/orca";

/** The 尾注 tab under every page, drawn by the plugin into Orca's bottom tab
 * bar (引用 / 同标签 / 候选引用 …) and nothing written into the notes. Orca
 * only reads custom tabs from a page's own `_queries`, so a tab on every page
 * from the first frame has to be ours.
 *
 * Per editor: an item inside Orca's segmented bar (same classes, so it looks
 * like the others), and a panel after Orca's views. While ours is chosen the
 * panel shows and Orca's views hide; Orca's chosen item is shown unchosen by
 * taking its class off, and given back when Orca will not redraw it. Orca's
 * drag-sorting counts every element in the bar; its `end` event reaches us
 * before Orca reads the indices, so they are corrected for our item, and a
 * drag of our item itself only moves our position setting. */
export type TabStatus = "loading" | "empty" | "footer";
export interface TabsHost {
  label(): string;
  /** 1-based place among the tabs; 0 = last. */
  position(): number;
  setPosition(position: number): void;
  emptyText(rootId: DbId): string;
}
/** Orca redraws its views element (taken out, a new one put in) when its tabs change; `views` can be missing for a moment. */
interface Parts { none: HTMLElement; container: HTMLElement; bar: HTMLElement; views?: HTMLElement }
interface State {
  root: DbId; none: HTMLElement; bar: HTMLElement; item: HTMLElement; panel: HTMLElement; note: HTMLElement; mount: HTMLElement;
  active: boolean; stripped?: HTMLElement; watch?: MutationObserver; oursBefore: boolean; dragging: boolean; redrawUntil: number; detach: () => void;
}
const ITEM = "ofn-v3-tab-item";

export class FooterTabs {
  private states = new Map<HTMLElement, State>();
  constructor(private readonly host: TabsHost) {}

  /** Orca's parts of the bottom area, or nothing for editors without tabs (previews). */
  private parts(editor: HTMLElement): Parts | undefined {
    const none = editor.querySelector<HTMLElement>(":scope > .orca-block-editor-main > .orca-block-editor-none-editable");
    const container = none?.querySelector<HTMLElement>(":scope > .orca-block-editor-query-tabs-container");
    const bar = container?.querySelector<HTMLElement>(":scope > .orca-block-editor-query-tabs");
    const views = none?.querySelector<HTMLElement>(":scope > .orca-block-editor-query-views") ?? undefined;
    return none && container && bar ? { none, container, bar, views } : undefined;
  }
  private orcaItems(bar: HTMLElement): HTMLElement[] {
    return [...bar.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("orca-segmented-item")
      && !el.classList.contains(ITEM) && !el.classList.contains("orca-transition"));
  }
  /** Our tab and panel in this editor (made or repaired); undefined when it has no bottom tabs. */
  ensure(editor: HTMLElement, root: DbId): State | undefined {
    const parts = this.parts(editor);
    let state = this.states.get(editor);
    if (!parts) { if (state) this.drop(editor); return; }
    if (state && (state.bar !== parts.bar || state.none !== parts.none)) { this.drop(editor); state = undefined; }
    if (!state) state = this.create(editor, parts, root);
    if (state.root !== root) { this.activate(editor, false); state.root = root; this.opened(editor); }
    if (parts.views && (!state.panel.isConnected || state.panel.previousElementSibling !== parts.views)) parts.views.after(state.panel);
    if (state.item.textContent !== this.host.label()) state.item.textContent = this.host.label();
    this.place(state);
    // Orca redrew its views while ours is chosen (e.g. a page switch in place): keep them hidden.
    if (state.active && parts.none.dataset.ofnTab !== "on") parts.none.dataset.ofnTab = "on";
    return state;
  }
  private create(editor: HTMLElement, parts: Parts, root: DbId): State {
    const item = document.createElement("div");
    item.className = `orca-segmented-item ${ITEM}`; item.textContent = this.host.label(); item.setAttribute("role", "tab");
    const panel = document.createElement("div"); panel.className = "ofn-v3-tab-panel"; panel.contentEditable = "false"; panel.dataset.ofnTabPanel = "";
    const note = document.createElement("div"); note.className = "ofn-v3-tab-note";
    const mount = document.createElement("div"); mount.className = "ofn-v3-tab"; mount.contentEditable = "plaintext-only";
    panel.append(note, mount); if (parts.views) parts.views.after(panel); else parts.none.append(panel);
    const onItem = (event: Event) => { event.stopPropagation(); this.activate(editor, true); };
    // Orca's own items: let Orca switch, then step aside.
    const onBar = (event: Event) => {
      const state = this.states.get(editor), target = (event.target as Element | null)?.closest?.(".orca-segmented-item");
      if (!state?.active || !target || target === state.item) return;
      if (target === state.stripped) { target.classList.add("orca-selected"); state.stripped = undefined; this.activate(editor, false); }
      else setTimeout(() => this.activate(editor, false), 0);   // Orca animates from our chosen item first
    };
    const onStart = (event: Event) => { const state = this.states.get(editor), moved = (event as any).item as Element | undefined; if (!state) return;
      // While a tab is dragged, the drag moves elements around; ours is placed again only when it ends.
      state.dragging = true;
      if (moved && moved !== state.item) state.oursBefore = !!(state.item.compareDocumentPosition(moved) & Node.DOCUMENT_POSITION_FOLLOWING); };
    const onEnd = (event: Event) => {
      const state = this.states.get(editor), e = event as any; if (!state) return;
      state.dragging = false;
      if (e.item === state.item) {
        // Our tab was dragged: only our position changes; Orca sees no move.
        const before = this.orcaItems(state.bar).filter(el => el.compareDocumentPosition(state.item) & Node.DOCUMENT_POSITION_FOLLOWING).length;
        const last = before >= this.orcaItems(state.bar).length;
        e.newIndex = e.oldIndex; this.host.setPosition(last ? 0 : before + 1); return;
      }
      if (typeof e.oldIndex === "number" && state.oursBefore) e.oldIndex -= 1;
      if (typeof e.newIndex === "number" && e.item instanceof Element && state.item.compareDocumentPosition(e.item) & Node.DOCUMENT_POSITION_FOLLOWING) e.newIndex -= 1;
    };
    item.addEventListener("click", onItem);
    parts.bar.addEventListener("click", onBar, true);
    parts.bar.addEventListener("start", onStart); parts.bar.addEventListener("end", onEnd);
    const state: State = { root, none: parts.none, bar: parts.bar, item, panel, note, mount, active: false, oursBefore: false, dragging: false, redrawUntil: 0,
      detach: () => { item.removeEventListener("click", onItem); parts.bar.removeEventListener("click", onBar, true);
        parts.bar.removeEventListener("start", onStart); parts.bar.removeEventListener("end", onEnd); } };
    this.states.set(editor, state);
    this.place(state);
    this.opened(editor);
    return state;
  }
  /** A page opened in this editor: ours is chosen by default when it is the first tab, as Orca does with its first. */
  private opened(editor: HTMLElement): void { if (this.host.position() === 1) this.activate(editor, true); }
  /** Orca is about to redraw this editor's tab bar (a tab is taken away) and will choose its first tab again. */
  expectRedraw(editor: HTMLElement): void { const state = this.states.get(editor); if (state) state.redrawUntil = Date.now() + 1500; }
  /** Keep our item at its place among Orca's items. */
  private place(state: State): void {
    if (state.dragging) return;
    const items = this.orcaItems(state.bar), at = this.host.position();
    const before = at >= 1 && at <= items.length ? items[at - 1] : null;
    if (before) { if (state.item.nextElementSibling !== before) state.bar.insertBefore(state.item, before); }
    else if (state.item.parentElement !== state.bar || state.item.nextElementSibling) state.bar.append(state.item);
  }
  activate(editor: HTMLElement, on: boolean): void {
    const state = this.states.get(editor); if (!state || state.active === on) return;
    const parts = { none: state.none, bar: state.bar };
    if (on) {
      const chosen = this.orcaItems(parts.bar).find(el => el.classList.contains("orca-selected"));
      if (chosen) { chosen.classList.remove("orca-selected"); state.stripped = chosen; }
      state.item.classList.add("orca-selected"); state.item.setAttribute("aria-selected", "true");
      parts.none.dataset.ofnTab = "on"; state.active = true;
      // Orca chose one of its tabs by other means (its side buttons, a shortcut, a new query): step aside.
      state.watch = new MutationObserver(records => {
        // Only Orca's own items count (never an item of ours, old or new).
        const chosen = records.map(r => r.target).find((el): el is HTMLElement => el instanceof HTMLElement && !el.classList.contains(ITEM)
          && el.classList.contains("orca-segmented-item") && el.classList.contains("orca-selected"));
        if (!chosen) return;
        // An expected redraw (Orca dropping a tab and choosing its first): not a choice; ours stays.
        if (Date.now() < state.redrawUntil) { chosen.classList.remove("orca-selected"); state.stripped = chosen; return; }
        state.stripped = undefined; this.activate(editor, false);
      });
      state.watch.observe(parts.bar, { subtree: true, attributes: true, attributeFilter: ["class"] });
    } else {
      state.watch?.disconnect(); state.watch = undefined;
      state.item.classList.remove("orca-selected"); state.item.removeAttribute("aria-selected");
      delete parts.none.dataset.ofnTab; state.active = false;
      // Give Orca its chosen item back if it did not redraw one itself.
      if (!this.orcaItems(parts.bar).some(el => el.classList.contains("orca-selected")) && state.stripped?.isConnected) state.stripped.classList.add("orca-selected");
      state.stripped = undefined;
    }
  }
  isActive(editor: HTMLElement): boolean { return this.states.get(editor)?.active === true; }
  /** Status text under the tab while there is no footer to draw. */
  status(editor: HTMLElement, status: TabStatus): void {
    const state = this.states.get(editor); if (!state) return;
    const text = status === "empty" ? this.host.emptyText(state.root) : "尾注加载中…";
    if (state.note.textContent !== text) state.note.textContent = text;
    state.panel.dataset.status = status;
  }
  mount(editor: HTMLElement): HTMLElement | undefined { return this.states.get(editor)?.mount; }
  /** After Orca's side buttons or shortcuts for 引用/同标签/候选引用: Orca may not redraw if its choice did not change. */
  orcaChose(editor?: HTMLElement): void { for (const [ed] of this.states) if (!editor || ed === editor) setTimeout(() => this.activate(ed, false), 0); }
  drop(editor: HTMLElement): void {
    const state = this.states.get(editor); if (!state) return;
    this.activate(editor, false);
    // Whatever Orca's bottom area looks like now: no watcher, no switch left on.
    state.watch?.disconnect(); state.watch = undefined;
    if (state.none.dataset.ofnTab) delete state.none.dataset.ofnTab;
    if (state.stripped?.isConnected && !this.orcaItems(state.bar).some(el => el.classList.contains("orca-selected"))) state.stripped.classList.add("orca-selected");
    state.detach(); state.item.remove(); state.panel.remove(); this.states.delete(editor);
  }
  /** Forget editors that left the page. */
  prune(): void { for (const editor of [...this.states.keys()]) if (!editor.isConnected) { this.states.get(editor)!.detach(); this.states.delete(editor); } }
  dropAll(): void { for (const editor of [...this.states.keys()]) this.drop(editor); }
}
