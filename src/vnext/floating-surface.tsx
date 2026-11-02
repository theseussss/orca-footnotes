import type { ReactElement } from "react";
import { directoryCssPosition, resolveDirectoryPosition, type DirectoryLayout, type DirectoryPosition } from "./directory-layout";
import { anchoredPosition } from "./navigation-feedback";

type Props = {
  visible?: boolean;
  directory?: boolean;
  /** Temporary drag position lives only for this mount; never directory storage. */
  draggable?: boolean;
  dismissible?: boolean;
  onDismiss?: (reason?: "escape" | "outside") => void;
  rect?: DOMRect;
  children: ReactElement;
  className?: string;
  layout?: DirectoryLayout;
  onLayoutChange?: (next: DirectoryLayout) => void;
  defaultInset?: number;
};
type Options = Pick<Props, "rect" | "layout" | "onLayoutChange" | "defaultInset" | "draggable" | "dismissible" | "onDismiss">;
// Plugin-owned instance ordering only; not Orca's Popup stack or pointer state.
const dismissOwners = new WeakMap<Document, Set<HTMLElement>>();
const dismissedPointers = new WeakSet<Event>();
type Mounted = { update: (options: Options) => void; dispose: () => void };
type Drag = {
  pointerId: number;
  startPointer: DirectoryPosition;
  startPosition: DirectoryPosition;
  preview: DirectoryPosition | null;
  started: boolean;
};

const DRAG_THRESHOLD = 4; // rendered/client pixels, independent of CSS zoom
const INTERACTIVE = [
  "button", "input", "textarea", "select", "option", "optgroup", "a", "area", "label", "summary",
  "iframe", "object", "embed", "audio[controls]", "video[controls]", "[tabindex]", '[draggable="true"]',
  '[contenteditable]:not([contenteditable="false"])', "[data-ofn-no-drag]", ".orca-popup", ".orca-menu",
  ...["button", "link", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio",
    "combobox", "textbox", "searchbox", "listbox", "option", "slider", "spinbutton", "switch", "tab", "treeitem"]
    .map(role => `[role="${role}"]`),
].join(",");
const copyLayout = (value: DirectoryLayout): DirectoryLayout => ({
  position: value.position === null ? null : { left: value.position.left, top: value.position.top }, locked: value.locked,
});
const samePosition = (a: DirectoryPosition | null, b: DirectoryPosition | null) =>
  a === null || b === null ? a === b : a.left === b.left && a.top === b.top;
const sameLayout = (a: DirectoryLayout | undefined, b: DirectoryLayout | undefined) =>
  a === undefined || b === undefined ? a === b : a.locked === b.locked && samePosition(a.position, b.position);

/** Only physical descendants before the marked header count. This also catches
 * a button's SVG/text child and controls in a composed/shadow event path. Native
 * menus portaled elsewhere never become drag handles through React bubbling. */
function blankHandle(event: PointerEvent, node: HTMLElement): boolean {
  const path = event.composedPath().filter((part): part is Element => part instanceof Element);
  const index = path.findIndex(part => part.hasAttribute("data-ofn-drag-handle"));
  return index >= 0 && node.contains(path[index]) && !path.slice(0, index + 1).some(part => part.matches(INTERACTIVE));
}

/** Bottom of the window's top chrome: Orca's headbar plus any fixed bar laid
 * over the top of the panels (another plugin's tab bar, for instance). */
function topChromeBottom(own: HTMLElement): number | undefined {
  const doc = own.ownerDocument, win = doc.defaultView!;
  let bottom = doc.getElementById("headbar")?.getBoundingClientRect().bottom;
  if (typeof doc.elementsFromPoint !== "function") return bottom;
  for (let pass = 0; pass < 3; pass++) {
    const y = (bottom ?? 0) + 2, bar = doc.elementsFromPoint(win.innerWidth - 80, y).find(element => {
      if (own.contains(element) || element.closest(".orca-popup")) return false;
      const box = element.getBoundingClientRect();
      return win.getComputedStyle(element).position === "fixed" && box.height < 120 && box.width > win.innerWidth * 0.3;
    });
    const next = bar?.getBoundingClientRect().bottom;
    if (next === undefined || !(next > (bottom ?? 0))) break;
    bottom = next;
  }
  return bottom;
}

function mountSurface(node: HTMLDivElement, directory: boolean, initial: Options,
  memory: { current: DirectoryLayout }): Mounted {
  let options = initial, external = initial.layout === undefined ? undefined : copyLayout(initial.layout);
  let layout = copyLayout(initial.layout ?? memory.current);
  memory.current = copyLayout(layout);
  let drag: Drag | null = null, suppressClick = false, disposed = false, composing = false;
  let temporaryPosition: DirectoryPosition | null = null;
  const doc = node.ownerDocument, win = doc.defaultView!;
  const owners = dismissOwners.get(doc) ?? new Set<HTMLElement>();
  dismissOwners.set(doc, owners);
  const isDismissible = () => !directory && options.dismissible === true && !!options.onDismiss;
  const syncDismissible = () => { if (isDismissible()) owners.add(node); else owners.delete(node); };
  const isTop = () => [...owners].filter(owner => owner.isConnected).at(-1) === node;
  // Read visible native portal DOM before native handlers can remove it. A
  // nested menu gets this Escape/outside press first. Never close/mutate it.
  const nativeAbove = () => [...doc.querySelectorAll<HTMLElement>(".orca-popup:not(.ofn-next-floating-tool)")].some(popup => {
    const css = win.getComputedStyle(popup);
    // Native ContextMenu removes its contents immediately but leaves an empty
    // Popup during its exit animation. That closed shell must not eat the next
    // Escape meant for our still-open selector.
    return popup.childNodes.length > 0 && popup.isConnected && popup.getClientRects().length > 0 && css.display !== "none" && css.visibility !== "hidden"
      && (Number.parseFloat(css.zIndex) || 99) >= (Number.parseFloat(win.getComputedStyle(node).zIndex) || 98);
  });
  const escape = (event: KeyboardEvent) => {
    if (disposed || drag || !isDismissible() || !isTop() || event.defaultPrevented || event.key !== "Escape"
      || composing || event.isComposing || event.keyCode === 229 || nativeAbove()) return;
    event.preventDefault(); event.stopPropagation(); options.onDismiss?.("escape");
  };
  const outside = (event: PointerEvent) => {
    if (disposed || drag || !isDismissible() || !isTop() || composing || event.defaultPrevented || dismissedPointers.has(event)
      || event.composedPath().includes(node) || nativeAbove()) return;
    // Only one owned surface per press, even if its callback unmounts it
    // synchronously. The original body/other-tool pointer operation stays live.
    dismissedPointers.add(event); options.onDismiss?.("outside");
  };
  const compositionStart = () => { composing = true; };
  const compositionEnd = () => { composing = false; };

  const measure = () => {
    const box = node.getBoundingClientRect(), css = getComputedStyle(node);
    const width = Number.parseFloat(css.width), height = Number.parseFloat(css.height);
    const sx = width > 0 ? box.width / width : 1, sy = height > 0 ? box.height / height : 1;
    const header = directory || options.draggable ? node.querySelector<HTMLElement>("[data-ofn-drag-handle]")?.getBoundingClientRect() : undefined;
    return { box, sx, sy, geometry: {
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, width: box.width, height: box.height,
      headbarBottom: topChromeBottom(node),
      headerHeight: header ? Math.max(0, header.bottom - box.top) : undefined, defaultInset: options.defaultInset,
    } };
  };
  function place(): DirectoryPosition | undefined {
    if (disposed || !node.isConnected) return;
    const { sx, sy, geometry } = measure();
    let viewportPosition: DirectoryPosition;
    if (directory) viewportPosition = resolveDirectoryPosition(drag?.preview ?? layout.position, geometry);
    else viewportPosition = anchoredPosition(options.rect, geometry, drag?.preview ?? temporaryPosition);
    const cssPosition = directoryCssPosition(viewportPosition, sx, sy);
    node.style.left = `${cssPosition.left}px`; node.style.top = `${cssPosition.top}px`;
    return viewportPosition;
  }

  function detachDragListeners() {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
  }
  function finish(commit: boolean, guardClick = true) {
    const ended = drag; if (!ended) return;
    // Clear first: releasePointerCapture may synchronously emit lostcapture.
    drag = null; detachDragListeners();
    if (guardClick && ended.started) suppressClick = true;
    try { if (node.hasPointerCapture(ended.pointerId)) node.releasePointerCapture(ended.pointerId); } catch { /* detached/revoked capture */ }
    let next: DirectoryLayout | undefined;
    if (commit && ended.started && ended.preview && !(directory && layout.locked) && !disposed) {
      const geometry = measure().geometry;
      const resolve = (position: DirectoryPosition) => directory ? resolveDirectoryPosition(position, geometry) : anchoredPosition(options.rect, geometry, position);
      const displayed = resolve(ended.preview);
      const startDisplayed = resolve(ended.startPosition);
      // A boundary/no-op drag is not a preference change. Compare under the
      // same current geometry so a mid-gesture resize alone cannot save a clamp.
      if (!samePosition(displayed, startDisplayed)) {
        if (directory) {
          layout = { position: displayed, locked: layout.locked };
          memory.current = copyLayout(layout); next = copyLayout(layout);
        } else temporaryPosition = displayed;
      }
    }
    place();
    // No storage, focus or selection operation here. The parent persists only
    // this successful pointer-up; resize/cancel/lock never call the callback.
    if (next) options.onLayoutChange?.(next);
  }
  function preview(event: PointerEvent) {
    if (!drag) return;
    const dx = event.clientX - drag.startPointer.left, dy = event.clientY - drag.startPointer.top;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) { finish(false); return; }
    if (!drag.started && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.started = true;
    drag.preview = { left: drag.startPosition.left + dx, top: drag.startPosition.top + dy };
    place();
  }
  function onMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if ((event.buttons & 1) === 0) { finish(false); return; }
    preview(event);
  }
  function onUp(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (event.button !== 0) { finish(false); return; }
    preview(event); finish(true);
  }
  function onCancel(event: PointerEvent) {
    if (drag && event.pointerId === drag.pointerId) finish(false);
  }
  function onLostCapture(event: PointerEvent) {
    if (drag && event.pointerId === drag.pointerId) finish(false);
  }
  function onKey(event: KeyboardEvent) {
    if (!drag || event.key !== "Escape" || event.isComposing || event.keyCode === 229 || composing) return;
    event.preventDefault(); event.stopPropagation(); finish(false);
  }
  function onBlur() { finish(false); }
  function onDown(event: PointerEvent) {
    // A fresh pointer press is new intent, not the click following a past drag.
    suppressClick = false;
    if (disposed || drag || (!directory && !options.draggable) || (directory && layout.locked) || event.defaultPrevented || !event.isPrimary || event.button !== 0
      || !blankHandle(event, node)) return;
    const startPosition = place(); if (!startPosition) return;
    try { node.setPointerCapture(event.pointerId); } catch { return; }
    // Do not let a title press focus this tool or collapse a body's selection.
    // Interactive descendants returned above without cancelling any event.
    event.preventDefault(); event.stopPropagation();
    drag = { pointerId: event.pointerId, startPointer: { left: event.clientX, top: event.clientY },
      startPosition, preview: null, started: false };
    window.addEventListener("pointermove", onMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onUp, { capture: true, passive: false });
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
  }
  function onClick(event: MouseEvent) {
    if (!suppressClick || event.detail === 0) return; // preserve keyboard activation
    suppressClick = false;
    event.preventDefault(); event.stopImmediatePropagation();
  }

  place();
  const resize = new ResizeObserver(() => { place(); }); resize.observe(node);
  const headbar = directory ? document.getElementById("headbar") : null;
  if (headbar) resize.observe(headbar);
  window.addEventListener("resize", place);
  node.addEventListener("pointerdown", onDown, { capture: true, passive: false });
  node.addEventListener("lostpointercapture", onLostCapture);
  node.addEventListener("click", onClick, true);
  syncDismissible();
  if (!directory) {
    win.addEventListener("keydown", escape, true);
    win.addEventListener("pointerdown", outside, true);
    win.addEventListener("compositionstart", compositionStart, true);
    win.addEventListener("compositionend", compositionEnd, true);
  }
  return {
    update(next) {
      options = next; syncDismissible();
      // Compare values, not object identity: React/content updates must not
      // replace a user's placement. Keep an optimistic local copy until the
      // controller feeds the pointer-up result back, including without a prop.
      if (directory && !sameLayout(external, next.layout)) {
        external = next.layout === undefined ? undefined : copyLayout(next.layout);
        layout = copyLayout(next.layout ?? memory.current); memory.current = copyLayout(layout);
        finish(false); // includes a lock change or explicit reset-to-default
      }
      place();
    },
    dispose() {
      disposed = true; owners.delete(node); finish(false, false); detachDragListeners();
      win.removeEventListener("keydown", escape, true);
      win.removeEventListener("pointerdown", outside, true);
      win.removeEventListener("compositionstart", compositionStart, true);
      win.removeEventListener("compositionend", compositionEnd, true);
      resize.disconnect(); window.removeEventListener("resize", place);
      node.removeEventListener("pointerdown", onDown, true);
      node.removeEventListener("lostpointercapture", onLostCapture);
      node.removeEventListener("click", onClick, true);
    },
  };
}

/** A persistent NON-MODAL tool surface, not a native Popup-stack entry.
 * Native Popup's shared pointer gate clears only when its entire stack empties;
 * keeping a noPointerLogic Popup alive strands the gate after other native menus.
 * We therefore own only mount/viewport placement, and keep native popup/menu CSS
 * plus actual host controls. Never edit _orcaPopupIds, body pointer classes or
 * another popup. The verified host's native Popup layer is 99; tools sit below it.
 */
export function createFloatingSurface(React: typeof import("react")) {
  return function FloatingSurface({ visible = true, directory = false, draggable = false, dismissible = false, onDismiss, rect, children, className = "",
    layout, onLayoutChange, defaultInset = 60 }: Props) {
    const host = React.useRef<HTMLDivElement>(null), mounted = React.useRef<Mounted | null>(null);
    const memory = React.useRef<DirectoryLayout>({ position: null, locked: false });
    const options = React.useRef<Options>({ rect, layout, onLayoutChange, defaultInset, draggable, dismissible, onDismiss });
    React.useLayoutEffect(() => {
      options.current = { rect, layout, onLayoutChange, defaultInset, draggable, dismissible, onDismiss };
      mounted.current?.update(options.current);
    });
    React.useLayoutEffect(() => {
      const node = host.current; if (!node || !visible) return;
      const surface = mountSurface(node, directory, options.current, memory);
      mounted.current = surface;
      return () => { surface.dispose(); if (mounted.current === surface) mounted.current = null; };
    }, [visible, directory]);
    if (!visible) return null;
    return <div ref={host} contentEditable={false} className={`orca-popup ofn-next-floating-tool ${className}`}
      style={{ position: "fixed", zIndex: 98 }} onClick={event => event.stopPropagation()}>{children}</div>;
  };
}
