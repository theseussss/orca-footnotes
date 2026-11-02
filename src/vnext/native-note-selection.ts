import type { CursorData, DbId } from "../../vendor/orca";
import type { NativeNoteTree } from "./native-note-tree";

export interface NativeNoteInputOwner {
  readonly editor: HTMLElement;
  readonly panelId: string;
  readonly rootBlockId: DbId;
  /** Fresh native coordinate projection of the supplied actual Selection. */
  readonly readCursor: (selection: Selection) => CursorData | null | undefined;
}
export interface NativeNoteRangeOwner extends Omit<NativeNoteInputOwner, "readCursor"> {
  /** Public native projection of this genuine DOM Range. May be unselected. */
  readonly readRange: (range: Range) => CursorData | null | undefined;
}
type PhysicalOwner = Pick<NativeNoteInputOwner, "editor" | "panelId" | "rootBlockId">;
/** A live element lease supplied by our actual native renderer, not discovered
 * or authorized by matching arbitrary data-* attributes in a document scan. */
export interface ManagedNativeNoteSurface {
  readonly element: HTMLElement;
  readonly mirrorBlockId: DbId;
  readonly tree: NativeNoteTree;
}
export type ManagedNativeNoteSelection =
  | { readonly kind: "body" }
  | { readonly kind: "note"; readonly surface: ManagedNativeNoteSurface; readonly cursor: CursorData;
      readonly anchorCanonicalId: DbId; readonly focusCanonicalId: DbId }
  | { readonly kind: "cross-boundary" }
  | { readonly kind: "unresolved" };

const elementOf = (node: Node | null): Element | null => node?.nodeType === 1 ? node as Element : node?.parentElement ?? null;
const safeId = (raw: string | undefined): DbId | undefined => {
  if (raw === undefined || !/^-?(?:0|[1-9]\d*)$/.test(raw)) return;
  const value = Number(raw); return Number.isSafeInteger(value) ? value : undefined;
};
/** Shared physical exclusion fence for native note rendering and Selection.
 * Matching a canonical ID never authorizes a query/preview copy. */
export const NATIVE_NOTE_FOREIGN_VIEW = ".orca-hideable-hidden,.orca-popup,.orca-block-preview,.orca-inline-reference-preview,.orca-block-popup-preview,.orca-link-dialog-preview,.orca-block-preview-popup,.orca-reference-preview,.orca-block-preview-container,.orca-query-editor,.orca-block-editor-query-views";
const FOREIGN_VIEW = NATIVE_NOTE_FOREIGN_VIEW;
function nativeBody(owner: PhysicalOwner): HTMLElement | null {
  return owner.editor.querySelector<HTMLElement>(":scope > .orca-block-editor-main > .orca-block-editor-blocks[data-hl-container]");
}
function physicalOwner(owner: PhysicalOwner): boolean {
  return owner.editor.isConnected && owner.editor.matches(".orca-block-editor")
    && safeId(owner.editor.dataset.blockId) === owner.rootBlockId
    && owner.editor.closest<HTMLElement>(".orca-panel[data-panel-id]")?.dataset.panelId === owner.panelId;
}
function validSurface(owner: PhysicalOwner, body: HTMLElement, surface: ManagedNativeNoteSurface): boolean {
  const node = surface.element;
  return node.isConnected && body.contains(node) && node.closest(".orca-block-editor-blocks[data-hl-container]") === body
    && !node.closest(FOREIGN_VIEW) && node.closest(".orca-block-editor") === owner.editor
    && node.matches(".orca-block[data-id][data-mirror-id]")
    && safeId(node.dataset.id) === surface.mirrorBlockId && safeId(node.dataset.mirrorId) === surface.tree.rootId;
}
function sameNativeCursor(a: CursorData, b: CursorData): boolean {
  const samePoint = (x: CursorData["anchor"], y: CursorData["anchor"]) =>
    x.blockId === y.blockId && x.isInline === y.isInline && x.index === y.index && x.offset === y.offset
    && Number.isSafeInteger(x.index) && x.index >= 0 && Number.isSafeInteger(x.offset) && x.offset >= 0;
  return a.panelId === b.panelId && a.rootBlockId === b.rootBlockId && a.isForward === b.isForward
    && a.mirror?.blockId === b.mirror?.blockId && a.mirror?.mirrorId === b.mirror?.mirrorId
    && samePoint(a.anchor, b.anchor) && samePoint(a.focus, b.focus);
}
function pointOwner(node: Node | null, active: readonly ManagedNativeNoteSurface[]): ManagedNativeNoteSurface | undefined | null {
  const candidates = active.filter(surface => !!node && surface.element.contains(node));
  if (candidates.length > 1) return null; // Overlapping/nested managed instances.
  return candidates[0];
}
function canonicalPoint(owner: PhysicalOwner, surface: ManagedNativeNoteSurface, node: Node | null,
  nativeId: DbId): DbId | undefined {
  const element = elementOf(node);
  if (!element || element.closest(".orca-block-editor") !== owner.editor || element.closest(FOREIGN_VIEW)
    || element.closest(".orca-block-editor-blocks[data-hl-container]") !== nativeBody(owner)) return;
  // A nested foreign mirror can point outside the note even when its wrapper
  // is one of N's children. Never infer canonical ownership just from that ID.
  if (element.closest(".orca-block[data-mirror-id]") !== surface.element) return;
  const block = element.closest<HTMLElement>(".orca-block[data-id]");
  const physicalId = block && safeId(block.dataset.id);
  if (physicalId === undefined || physicalId !== nativeId || !surface.element.contains(block)) return;
  const canonicalId = physicalId === surface.mirrorBlockId ? surface.tree.rootId : physicalId;
  return surface.tree.has(canonicalId) ? canonicalId : undefined;
}

/** Shared physical fence for real selected or unselected DOM Ranges. No
 * Selection facade is constructed and no prospective Range is selected. */
function inspectPhysicalRange(owner: PhysicalOwner, surfaces: readonly ManagedNativeNoteSurface[], range: Range,
  anchorNode: Node, focusNode: Node, cursor: CursorData | null | undefined): ManagedNativeNoteSelection {
  const body = nativeBody(owner);
  if (!body || !physicalOwner(owner)) return { kind: "unresolved" };
  const connected = surfaces.filter(surface => surface.element.isConnected && owner.editor.contains(surface.element));
  const active = connected.filter(surface => validSurface(owner, body, surface));
  const touched: ManagedNativeNoteSurface[] = [];
  try {
    for (const surface of connected) if (range.intersectsNode(surface.element)) {
      if (!active.includes(surface)) return { kind: "unresolved" };
      touched.push(surface);
    }
  } catch { return { kind: "unresolved" }; }
  const anchorSurface = pointOwner(anchorNode, active), focusSurface = pointOwner(focusNode, active);
  if (anchorSurface === null || focusSurface === null) return { kind: "unresolved" };
  if (!anchorSurface && !focusSurface && !touched.length) return { kind: "body" };
  if (!anchorSurface || !focusSurface || anchorSurface !== focusSurface
    || touched.some(surface => surface !== anchorSurface)) return { kind: "cross-boundary" };
  // Legal endpoints do not make an entire range legal: a foreign mirror,
  // nested editor, or unowned block can lie strictly between them.
  try {
    for (const inner of anchorSurface.element.querySelectorAll<HTMLElement>(`.orca-block[data-id],.orca-block-editor,.orca-block-editor-blocks[data-hl-container],${FOREIGN_VIEW}`)) {
      if (!range.intersectsNode(inner)) continue;
      const id = safeId(inner.dataset.id);
      if (inner.matches(`.orca-block-editor,.orca-block-editor-blocks[data-hl-container],.orca-block[data-mirror-id],${FOREIGN_VIEW}`) || id === undefined || !anchorSurface.tree.has(id))
        return { kind: "unresolved" };
    }
  } catch { return { kind: "unresolved" }; }
  // Native CursorData.mirror is derived from anchor only. Checking BOTH actual
  // endpoints above is essential when two physical mirrors share canonical N.
  if (!cursor || cursor.panelId !== owner.panelId || cursor.rootBlockId !== owner.rootBlockId
    || cursor.mirror?.blockId !== String(anchorSurface.mirrorBlockId)
    || cursor.mirror?.mirrorId !== String(anchorSurface.tree.rootId)) return { kind: "unresolved" };
  const anchorCanonicalId = canonicalPoint(owner, anchorSurface, anchorNode, cursor.anchor.blockId);
  const focusCanonicalId = canonicalPoint(owner, focusSurface, focusNode, cursor.focus.blockId);
  if (anchorCanonicalId === undefined || focusCanonicalId === undefined) return { kind: "unresolved" };
  return { kind: "note", surface: anchorSurface, cursor, anchorCanonicalId, focusCanonicalId };
}
/** Read-only interpretation of ACTUAL Selection + native CursorData. Physical
 * and fresh coordinate checks are necessary, never catalog/write authority. */
export function inspectManagedNativeNoteSelection(owner: NativeNoteInputOwner,
  surfaces: readonly ManagedNativeNoteSurface[], selection: Selection | null, cursor: CursorData | null | undefined): ManagedNativeNoteSelection {
  if (!selection || selection.rangeCount !== 1 || !selection.anchorNode || !selection.focusNode) return { kind: "unresolved" };
  const result = inspectPhysicalRange(owner, surfaces, selection.getRangeAt(0), selection.anchorNode, selection.focusNode, cursor);
  if (result.kind !== "note") return result;
  try {
    const readCursor = owner.readCursor, current = readCursor(selection);
    if (!current || !cursor || !sameNativeCursor(cursor, current)) return { kind: "unresolved" };
  } catch { return { kind: "unresolved" }; }
  return result;
}
/** Checks a genuine DOM Range BEFORE a public SDK setter is dispatched. A
 * matching native endpoint projection alone cannot authorize an interior
 * foreign mirror/editor/preview. Does not change the document's Selection. */
export function inspectManagedNativeNoteRange(owner: NativeNoteRangeOwner,
  surfaces: readonly ManagedNativeNoteSurface[], range: Range, cursor: CursorData | null | undefined): ManagedNativeNoteSelection {
  const result = inspectPhysicalRange(owner, surfaces, range, range.startContainer, range.endContainer, cursor);
  if (result.kind !== "note") return result;
  try {
    const readRange = owner.readRange, current = readRange(range);
    if (!current || !cursor || !sameNativeCursor(cursor, current)) return { kind: "unresolved" };
  } catch { return { kind: "unresolved" }; }
  return result;
}
