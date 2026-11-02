import type { Block, ContentFragment, CursorData, DbId, Orca } from "../../vendor/orca";
import { DEFAULT_TAG, OWNER_PROPERTY, citationFragments, REF_INLINE, REF_MIRROR, SECTION_PROPERTY, SECTION_REPR, STATE_PROPERTY, isMirror, mirroredId,
  noteFragment, sectionKind, stateMarker, type SectionKind } from "./model";

/** A panel's own editor: its command queue and undo history. */
export interface PanelEditor {
  invokeCommand(id: string, cursor: CursorData | null, ...args: any[]): Promise<any>;
  invokeGroup(action: () => Promise<void>, options?: any): Promise<any>;
}
export const SPECIAL_PAGES: Record<Exclude<SectionKind, "footer">, string> = { store: "尾注库", recycle: "尾注回收站", archive: "尾注待清理归档" };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

/** All reads/writes of the footnote data. Writes go through the source panel's
 * native editor commands, inside one undoable group per user action. */
export class FootnoteStore {
  constructor(readonly api: Orca, private readonly tagName: () => string = () => DEFAULT_TAG) {}
  get tag(): string { return this.tagName() || DEFAULT_TAG; }
  editor(panelId: string): PanelEditor {
    const editor = this.api.nav.findViewPanel(panelId, this.api.state.panels)?.viewState?.editor;
    if (!editor?.invokeCommand || !editor.invokeGroup) throw new Error("请先打开正文页面。");
    return editor;
  }
  // ---------- reads ----------
  live(id: DbId): Block | undefined { return this.api.state.blocks[id] ?? undefined; }
  async block(id: DbId): Promise<Block | undefined> {
    const live = this.live(id); if (live) return live;
    const block = await this.api.invokeBackend("get-block", id) as Block | null | undefined;
    if (block && block.id === id) { this.api.state.blocks[id] = block; return block; }
  }
  async tagId(): Promise<DbId | undefined> {
    const found = await this.api.invokeBackend("get-blockid-by-alias", this.tag) as { id?: DbId } | DbId | null | undefined;
    const id = typeof found === "number" ? found : found?.id;
    return Number.isSafeInteger(id) ? id : undefined;
  }
  /** Every block carrying the footnote tag, live rows preferred. */
  async entries(): Promise<Block[]> {
    const rows = await this.api.invokeBackend("get-blocks-with-tags", [this.tag]) as unknown;
    if (!Array.isArray(rows)) return [];
    const ids = rows.map(row => typeof row === "number" ? row : (row as Block | null)?.id).filter((id): id is DbId => Number.isSafeInteger(id));
    const byId = new Map(rows.filter((row): row is Block => !!row && typeof row === "object").map(row => [row.id, row]));
    const out: Block[] = [];
    for (const id of new Set(ids)) { const block = this.live(id) ?? byId.get(id) ?? await this.block(id); if (block) out.push(block); }
    return out;
  }
  /** Complete subtree, the root included; newer live rows override persisted ones. */
  async tree(rootId: DbId): Promise<Block[]> {
    const rows = await this.api.invokeBackend("get-block-tree", rootId) as unknown;
    const persisted = new Map((Array.isArray(rows) ? rows : []).filter((row): row is Block => !!row && typeof row === "object" && Number.isSafeInteger((row as Block).id)).map(row => [row.id, row]));
    // Walk from the root through live children first, so blocks created a
    // moment ago (not yet persisted) and their current order are included.
    const out = new Map<DbId, Block>(), stack = [rootId];
    while (stack.length) {
      const id = stack.pop()!; if (out.has(id)) continue;
      const block = this.live(id) ?? persisted.get(id) ?? await this.block(id); if (!block) continue;
      out.set(id, block); for (let i = (block.children?.length ?? 0) - 1; i >= 0; i--) stack.push(block.children[i]);
    }
    return [...out.values()];
  }
  async ancestors(id: DbId): Promise<Block[]> {
    const chain: Block[] = [], seen = new Set<DbId>(); let current: DbId | null | undefined = id;
    while (current != null && !seen.has(current)) { seen.add(current); const block = await this.block(current); if (!block) break; chain.push(block); current = block.parent; }
    return chain;
  }
  sectionOf(page: Block | undefined): Block | undefined {
    for (const child of page?.children ?? []) { const block = this.live(child); if (block && sectionKind(block) === "footer") return block; }
  }
  async specialPage(kind: Exclude<SectionKind, "footer">): Promise<Block | undefined> {
    const found = await this.api.invokeBackend("get-blockid-by-alias", SPECIAL_PAGES[kind]) as { id?: DbId } | DbId | null | undefined;
    const id = typeof found === "number" ? found : found?.id;
    const block = Number.isSafeInteger(id) ? await this.block(id!) : undefined;
    return block && sectionKind(block) === kind ? block : undefined;
  }
  // ---------- writes (callers wrap one user action in editor.invokeGroup) ----------
  async createSection(editor: PanelEditor, page: Block, title: string): Promise<DbId> {
    const id = await editor.invokeCommand("core.editor.insertBlock", null, page, "lastChild", [{ t: "t", v: title }], { type: SECTION_REPR });
    await editor.invokeCommand("core.editor.setProperties", null, [id], [{ name: SECTION_PROPERTY, type: 0, value: { version: 3, kind: "footer" } }]);
    return id;
  }
  async ensureSpecialPage(editor: PanelEditor, kind: Exclude<SectionKind, "footer">): Promise<Block> {
    const existing = await this.specialPage(kind); if (existing) return existing;
    const title = SPECIAL_PAGES[kind];
    const id = await editor.invokeCommand("core.editor.insertBlock", null, null, null, [{ t: "t", v: title }], { type: SECTION_REPR });
    await editor.invokeCommand("core.editor.setProperties", null, [id], [{ name: SECTION_PROPERTY, type: 0, value: { version: 3, kind } }]);
    await editor.invokeCommand("core.editor.createAlias", null, title, id);
    return (await this.block(id))!;
  }
  /** New entry in the store page, carrying the footnote tag and its owner view root. */
  async createEntry(editor: PanelEditor, store: Block, text: string, owner: DbId): Promise<DbId> {
    const id = await editor.invokeCommand("core.editor.insertBlock", null, store, "lastChild", text ? citationFragments(text) : null);
    await editor.invokeCommand("core.editor.insertTag", null, id, this.tag);
    await editor.invokeCommand("core.editor.setProperties", null, [id], [{ name: OWNER_PROPERTY, type: 0, value: { version: 3, owner } }]);
    return id;
  }
  /** New entry citing existing material: its content is one native reference
   * to that block (the form Orca's @ writes); the material is not touched. */
  async createEntryFor(editor: PanelEditor, store: Block, materialId: DbId, owner: DbId): Promise<DbId> {
    const id = await this.createEntry(editor, store, "", owner);
    const created = await editor.invokeCommand("core.editor.createRef", null, id, materialId, REF_INLINE);
    const relation = Number.isSafeInteger(created) ? created : this.live(id)?.refs.find(ref => ref.to === materialId && ref.type === REF_INLINE)?.id;
    if (!Number.isSafeInteger(relation)) throw new Error("引用关系未建立，没有改动。");
    await editor.invokeCommand("core.editor.setBlocksContent", null, [{ id, content: [{ t: "r", v: relation }] }], false);
    return id;
  }
  /** A block written straight into a footer becomes a footnote of that view. */
  async tagAsEntry(editor: PanelEditor, id: DbId, owner: DbId): Promise<void> {
    await editor.invokeCommand("core.editor.insertTag", null, id, this.tag);
    await editor.invokeCommand("core.editor.setProperties", null, [id], [{ name: OWNER_PROPERTY, type: 0, value: { version: 3, owner } }]);
  }
  async createMirrorAt(editor: PanelEditor, section: Block, entryId: DbId, after: DbId | null): Promise<DbId> {
    const anchor = after != null ? this.live(after) : undefined;
    const id = await editor.invokeCommand("core.editor.insertBlock", null, anchor ?? section, anchor ? "after" : "firstChild", null, { type: "mirror", mirroredId: entryId });
    await editor.invokeCommand("core.editor.createRef", null, id, entryId, REF_MIRROR);
    return id;
  }
  async createMirror(editor: PanelEditor, section: Block, entryId: DbId): Promise<DbId> {
    const id = await editor.invokeCommand("core.editor.insertBlock", null, section, "lastChild", null, { type: "mirror", mirroredId: entryId });
    await editor.invokeCommand("core.editor.createRef", null, id, entryId, REF_MIRROR);
    return id;
  }
  /** Replace the exact selected range (or insert at a caret) with a citation of
   * the entry: one native relation plus our superscript fragment. */
  async cite(editor: PanelEditor, cursor: CursorData, bodyBlockId: DbId, entryId: DbId): Promise<void> {
    const before = new Set((this.live(bodyBlockId)?.refs ?? []).map(ref => ref.id));
    const created = await editor.invokeCommand("core.editor.createRef", cursor, bodyBlockId, entryId, REF_INLINE);
    const body = this.live(bodyBlockId);
    const relation = Number.isSafeInteger(created) ? created
      : body?.refs.find(ref => !before.has(ref.id) && ref.to === entryId && ref.type === REF_INLINE)?.id;
    if (!Number.isSafeInteger(relation)) throw new Error("引用关系未建立，正文未改动。");
    await editor.invokeCommand("core.editor.insertFragments", cursor, [noteFragment(relation)]);
  }
  /** Remove superscripts of ONE entry from the given body blocks and drop their relations. */
  async uncite(editor: PanelEditor, entryId: DbId, only?: { blockId: DbId; fragmentIndex: number }): Promise<number> {
    const entry = this.live(entryId) ?? await this.block(entryId);
    const sources = new Set((entry?.backRefs ?? []).filter(ref => ref.type === REF_INLINE).map(ref => ref.from));
    if (only) { sources.clear(); sources.add(only.blockId); }
    let removed = 0;
    for (const sourceId of sources) {
      const source = this.live(sourceId) ?? await this.block(sourceId); if (!source) continue;
      const relations = source.refs.filter(ref => ref.to === entryId && ref.type === REF_INLINE);
      const content = clone(source.content ?? []) as ContentFragment[];
      const keep = content.filter((fragment, index) => !(fragment.t === "r" && relations.some(ref => ref.id === fragment.v)
        && (!only || index === only.fragmentIndex)));
      if (keep.length === content.length) continue;
      removed += content.length - keep.length;
      await editor.invokeCommand("core.editor.setBlocksContent", null, [{ id: sourceId, content: keep }], false);
      for (const relation of relations) if (!keep.some(fragment => fragment.t === "r" && fragment.v === relation.id))
        await editor.invokeCommand("core.editor.deleteRef", null, { refId: relation.id });
    }
    return removed;
  }
  async setState(editor: PanelEditor, entryId: DbId, value: { state: "recycled" | "archived"; at: number; homeId?: DbId } | null): Promise<void> {
    if (value) await editor.invokeCommand("core.editor.setProperties", null, [entryId], [{ name: STATE_PROPERTY, type: 0, value }]);
    else await editor.invokeCommand("core.editor.deleteProperties", null, [entryId], [STATE_PROPERTY]);
  }
  async move(editor: PanelEditor, ids: DbId[], target: Block, position: "lastChild" | "firstChild" | "before" | "after" = "lastChild"): Promise<void> {
    if (ids.length) await editor.invokeCommand("core.editor.moveBlocks", null, ids, target.id, position);
  }
  async remove(editor: PanelEditor, ids: DbId[]): Promise<void> { if (ids.length) await editor.invokeCommand("core.editor.deleteBlocks", null, ids); }
  /** Mirrors of an entry anywhere (native Mirror relations pointing at it). */
  mirrorsOf(entry: Block | undefined): DbId[] {
    return (entry?.backRefs ?? []).filter(ref => ref.type === REF_MIRROR).map(ref => ref.from)
      .filter(id => { const block = this.live(id); return !block || isMirror(block) && mirroredId(block) === entry!.id; });
  }
  homeOf(entry: Block): DbId | undefined { return stateMarker(entry)?.homeId; }
}
