import type { Block, ContentFragment, DbId } from "../../vendor/orca";
import type { BodyReference } from "./domain";
import type { NativeSnapshotBlock } from "./native-content-snapshot";

export const NATIVE_NOTE_FORMAT = "ofn-vnext-note";
export const NATIVE_INLINE_REFERENCE_TYPE = 1;
export const NATIVE_PREVIEW_CONTEXT = ".orca-popup,.orca-block-preview,.orca-inline-reference-preview,.orca-block-popup-preview,.orca-link-dialog-preview";
type SourceBlock = Pick<NativeSnapshotBlock, "id" | "content" | "refs">;
export function isNativeNoteFragment(fragment: ContentFragment): boolean {
  return fragment.t === "r" && typeof fragment.f === "string" && fragment.f.split("+").includes(NATIVE_NOTE_FORMAT);
}
/** Native r.v is a RELATION ROW ID. Only create a marker from an existing,
 * source-owned relation; callers must first use the native createRef command.
 */
export function makeNativeNoteFragment(source: Pick<Block, "id" | "refs">, targetId: DbId): ContentFragment {
  const relation = source.refs.find((ref) => ref.from === source.id && ref.to === targetId && ref.type === NATIVE_INLINE_REFERENCE_TYPE);
  if (!relation || !Number.isSafeInteger(relation.id)) throw new Error("Create the source-owned native reference before inserting a footnote marker");
  return { t: "r", v: relation.id, f: `sup+${NATIVE_NOTE_FORMAT}` };
}
/** Normalize marked native fragments for the independent projection. Portable
 * clipboard payloads must go through native pasteFragments, not this function.
 */
export function nativeNoteReferences(source: SourceBlock): BodyReference[] {
  const result: BodyReference[] = [];
  for (const [fragmentIndex, fragment] of (source.content ?? []).entries()) {
    if (!isNativeNoteFragment(fragment)) continue;
    const relation = source.refs.find((ref) => ref.id === fragment.v && ref.from === source.id && ref.type === NATIVE_INLINE_REFERENCE_TYPE);
    if (!relation || !Number.isSafeInteger(relation.to)) throw new Error(`Unresolved native note relation at ${source.id}:${fragmentIndex}`);
    if (fragment.to != null || fragment.alias != null) throw new Error("Portable reference payload must be pasted through the native reference-copy protocol first");
    result.push({ targetId: relation.to, fragmentIndex });
  }
  return result;
}

type Attributes = { styleAbsent: boolean; size: string; sizePriority: string; active: string | null; aria: string | null; role: string | null; tab: string | null; number: string | null; inner: HTMLElement };
function restoreAttribute(element: HTMLElement, name: string, value: string | null): void {
  if (value == null) element.removeAttribute(name); else element.setAttribute(name, value);
}
/** Number-only prototype adapter. Does not install a renderer, alter fragment
 * data, edit textContent/innerHTML, or implement the final click/preview UX.
 * Each instance belongs to exactly one editor, not the whole document.
 */
export class NativeMarkerNumbers {
  private originals = new Map<HTMLElement, Attributes>();
  private disposed = false;
  constructor(private readonly editor: HTMLElement) {
    if (!editor.classList.contains("orca-block-editor")) throw new Error("Native marker numbers require one owning editor");
  }
  private restore(outer: HTMLElement, value: Attributes): void {
    if (value.size) outer.style.setProperty("--ofn-mark-size", value.size, value.sizePriority);
    else outer.style.removeProperty("--ofn-mark-size");
    if (value.styleAbsent && outer.getAttribute("style") === "") outer.removeAttribute("style");
    restoreAttribute(outer, "data-ofn-active", value.active);
    restoreAttribute(outer, "aria-label", value.aria);
    if (outer.getAttribute("role") === "link") restoreAttribute(outer, "role", value.role);
    if (outer.getAttribute("tabindex") === "0") restoreAttribute(outer, "tabindex", value.tab);
    restoreAttribute(value.inner, "data-ofn-number", value.number);
    this.originals.delete(outer);
  }
  update(numbers: ReadonlyMap<DbId, number>): number {
    if (this.disposed) throw new Error("Number projection has been disposed");
    const touched = new Set<HTMLElement>();
    let count = 0;
    for (const outer of this.editor.querySelectorAll<HTMLElement>(`.orca-inline[data-type="r"].${NATIVE_NOTE_FORMAT}`)) {
      const body = outer.closest<HTMLElement>(".orca-block-editor-blocks[data-hl-container]");
      if (outer.closest(".orca-block-editor") !== this.editor || outer.closest(".orca-block[data-mirror-id]") || outer.closest(NATIVE_PREVIEW_CONTEXT)
        || body?.parentElement?.parentElement !== this.editor || !body.parentElement.classList.contains("orca-block-editor-main")) continue;
      const inner = outer.querySelector<HTMLElement>(":scope > .orca-inline-r-content");
      const number = numbers.get(Number(outer.dataset.ref));
      if (!inner || !number || !Number.isSafeInteger(number) || number < 1) continue;
      const previous = this.originals.get(outer);
      if (previous && previous.inner !== inner) this.restore(outer, previous);
      if (!this.originals.has(outer)) this.originals.set(outer, {
        styleAbsent: !outer.hasAttribute("style"), size: outer.style.getPropertyValue("--ofn-mark-size"),
        sizePriority: outer.style.getPropertyPriority("--ofn-mark-size"), active: outer.getAttribute("data-ofn-active"),
        aria: outer.getAttribute("aria-label"), role: outer.getAttribute("role"), tab: outer.getAttribute("tabindex"), number: inner.getAttribute("data-ofn-number"), inner,
      });
      // The number's size comes from CSS (a registered --ofn-mark-size of 1em on
      // the marker). Reading each marker's computed size here forced a style
      // recalculation per marker: ~1.5 s on a 400-paragraph page.
      // Attributes are written only when they change, for the same reason.
      const set = (node: HTMLElement, name: string, value: string) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
      set(outer, "data-ofn-active", "true");
      set(outer, "aria-label", `注释 ${number}`);
      set(outer, "role", "link"); set(outer, "tabindex", "0");
      set(inner, "data-ofn-number", `[${number}]`);
      touched.add(outer); count++;
    }
    for (const [outer, original] of [...this.originals]) if (!touched.has(outer)) this.restore(outer, original);
    return count;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [outer, original] of [...this.originals]) this.restore(outer, original);
  }
}
