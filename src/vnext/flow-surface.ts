/**
 * Read-only, scroll-coordinate footer. No note model, editor command, or write API.
 *
 * The verified renderer/CSS hierarchy is main > (blocks, none-editable). The
 * latter contains the native add-block placeholder, reference/query controls
 * and toolbars. Main's large bottom padding belongs AFTER those controls; its
 * bottom is therefore NOT the semantic end of the document body.
 *
 * A reversible padding-TOP lease on that native NON-EDITABLE container creates
 * real layout space between the complete blocks extent and native controls.
 * The body portal occupies that space, with a gap on each side, and is clipped
 * to the owner viewport. Long lists increase main/scrollHeight and push native
 * controls down; they do not expand the editor viewport, cover controls, insert
 * a native child, or change any body/main/editor attribute, text or input hook.
 * No z-index/negative-margin substitute for layout is used. Only the borrowed
 * non-editable padding longhand may differ while mounted; cleanup preserves
 * unrelated writes and foreign ownership of the same property.
 *
 * This is a gated native DOM/CSS adapter, NOT a public Orca footer slot or a
 * real-host acceptance claim. Unknown, collapsed/overflowing, preview or
 * ambiguous cached layouts fail closed. Windowing is supported only while the
 * native blocks container retains its COMPLETE layout extent.
 */
import { footerScrollTop, type ScrollAlignment } from "./navigation-feedback";

const GAP = 16;
const owners = new WeakMap<HTMLElement, FlowFooterSurface>();
type Shape = { panel: HTMLElement; wrapper: HTMLElement; main: HTMLElement; blocks: HTMLElement; end: HTMLElement; placeholder: HTMLElement };
type Box = { left: number; top: number; right: number; bottom: number };
const finite = (...values: number[]) => values.every(Number.isFinite);
const px = (value: string) => Number.parseFloat(value) || 0;

/**
 * CSSOM offset/client sizes are integer CSS pixels. Deriving a zoom scale from
 * them compounds their rounding over a many-thousand-pixel footer. Use the
 * floating-point used CSS border box instead, and keep that basis for clipping,
 * portal sizing, wheel deltas and bounded scrollTo.
 */
function layoutBox(element: HTMLElement) {
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const left = px(style.borderLeftWidth), right = px(style.borderRightWidth);
  const top = px(style.borderTopWidth), bottom = px(style.borderBottomWidth);
  let width = Number.parseFloat(style.width), height = Number.parseFloat(style.height);
  if (style.boxSizing !== 'border-box') {
    width += left + right + px(style.paddingLeft) + px(style.paddingRight);
    height += top + bottom + px(style.paddingTop) + px(style.paddingBottom);
  }
  if (!finite(width, height, rect.width, rect.height) || width <= 0 || height <= 0) return null;
  const sx = rect.width / width, sy = rect.height / height;
  if (!finite(sx, sy) || sx <= 0 || sy <= 0) return null;
  // Integer client sizes are used ONLY to identify the scrollbar gutter, never
  // as a scale or a long-distance layout measurement. The border/client edges
  // themselves retain the computed box's fractional CSS pixels.
  const gutterX = Math.max(0, Math.round(width - left - right) - element.clientWidth);
  const gutterY = Math.max(0, Math.round(height - top - bottom) - element.clientHeight);
  return { rect, style, width, height, sx, sy, borderTop: top,
    client: { left: rect.left + left * sx, top: rect.top + top * sy,
      right: rect.right - (right + gutterX) * sx,
      bottom: rect.bottom - (bottom + gutterY) * sy } satisfies Box };
}
/** Scroll an already-mounted native footer row inside its own Source only.
 * This does not load a virtualized row, change Selection, or open another view. */
export function scrollMountedNativeFooter(editor: HTMLElement, target: HTMLElement): boolean {
  const doc = editor.ownerDocument, win = doc?.defaultView;
  if (!win || !editor.isConnected || !target.isConnected || target.ownerDocument !== doc
      || !editor.contains(target) || target.closest('.orca-block-editor') !== editor) return false;
  const box = layoutBox(editor);
  const visible = (style: CSSStyleDeclaration) => style.display !== 'none' && style.visibility === 'visible'
    && style.contentVisibility !== 'hidden' && style.opacity !== '0' && (!style.transform || style.transform === 'none');
  if (!box || !visible(box.style) || !/^(auto|scroll)$/.test(box.style.overflowY)
      || !finite(editor.scrollTop, editor.scrollHeight, editor.clientHeight)) return false;
  const movesWithEditor = (style: CSSStyleDeclaration) => visible(style) && style.position !== 'fixed' && style.position !== 'sticky';
  if (!movesWithEditor(win.getComputedStyle(target))) return false;
  const row = target.getBoundingClientRect();
  if (!finite(row.top, row.bottom, row.left, row.right) || row.bottom <= row.top || row.right <= row.left) return false;
  // An inner clipping ancestor moves with its row when the outer editor scrolls;
  // if the row is already clipped out there, scrolling the editor cannot reveal it.
  let inside = target.parentElement;
  while (inside && inside !== editor) {
    const style = win.getComputedStyle(inside);
    if (!movesWithEditor(style)) return false;
    const clipX = /hidden|clip|auto|scroll/.test(style.overflowX), clipY = /hidden|clip|auto|scroll/.test(style.overflowY);
    if (clipX || clipY) {
      const innerBox = layoutBox(inside); if (!innerBox) return false;
      if (clipX && (row.right <= innerBox.client.left || row.left >= innerBox.client.right)
        || clipY && (row.bottom <= innerBox.client.top || row.top >= innerBox.client.bottom)) return false;
    }
    inside = inside.parentElement;
  }
  if (inside !== editor) return false;
  const vv = win.visualViewport;
  let left = Math.max(vv?.offsetLeft ?? 0, box.client.left), right = Math.min((vv?.offsetLeft ?? 0) + (vv?.width ?? win.innerWidth), box.client.right);
  let top = Math.max(vv?.offsetTop ?? 0, box.client.top), bottom = Math.min((vv?.offsetTop ?? 0) + (vv?.height ?? win.innerHeight), box.client.bottom);
  let panelFound = false;
  for (let ancestor = editor.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = win.getComputedStyle(ancestor), panel = ancestor.matches('.orca-panel');
    if (!visible(style)) return false;
    const clipX = panel || /hidden|clip|auto|scroll/.test(style.overflowX), clipY = panel || /hidden|clip|auto|scroll/.test(style.overflowY);
    if (clipX || clipY) {
      const ancestorBox = layoutBox(ancestor); if (!ancestorBox) return false;
      if (clipX) { left = Math.max(left, ancestorBox.client.left); right = Math.min(right, ancestorBox.client.right); }
      if (clipY) { top = Math.max(top, ancestorBox.client.top); bottom = Math.min(bottom, ancestorBox.client.bottom); }
    }
    if (panel) panelFound = true;
  }
  const headbar = doc.getElementById('headbar');
  if (headbar) {
    const head = headbar.getBoundingClientRect();
    if (head.right > left && head.left < right) top = Math.max(top, head.bottom);
  }
  if (!panelFound || !finite(left, right, top, bottom) || right <= left || bottom <= top || row.right <= left || row.left >= right) return false;
  const desired = footerScrollTop({ scrollTop: editor.scrollTop, scrollHeight: editor.scrollHeight, clientHeight: editor.clientHeight,
    scaleY: box.sy, targetTop: row.top, targetBottom: row.bottom, clipTop: top, clipBottom: bottom }, 'center');
  const delta = (desired - editor.scrollTop) * box.sy;
  if (row.bottom - delta <= top || row.top - delta >= bottom) return false;
  editor.scrollTop = desired;
  return true;
}

const direct = (node: HTMLElement, selector: string) =>
  [...node.children].filter((child): child is HTMLElement => child instanceof node.ownerDocument.defaultView!.HTMLElement && child.matches(selector));

function shape(editor: HTMLElement): Shape | null {
  const win = editor.ownerDocument.defaultView;
  if (!win || !editor.isConnected || !win.ResizeObserver || !win.MutationObserver ||
      !editor.matches('.orca-block-editor[data-block-id]') ||
      editor.closest('.orca-exporting,.orca-block-preview,.orca-inline-reference-preview,.orca-block-popup-preview,.orca-link-dialog-preview') ||
      !['plaintext-only', 'true', 'false'].includes(editor.getAttribute('contenteditable') ?? '')) return null;
  const wrapper = editor.parentElement;
  const panel = wrapper?.parentElement;
  if (!wrapper?.matches('.orca-hideable:not(.orca-hideable-hidden)') || !panel?.matches('.orca-panel[data-panel-id]')) return null;
  const candidates = [...panel.querySelectorAll(':scope > .orca-hideable:not(.orca-hideable-hidden) > .orca-block-editor')];
  if (candidates.length !== 1 || candidates[0] !== editor) return null;
  for (let node: HTMLElement | null = editor; node; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (style.display === 'none' || style.visibility !== 'visible' || style.contentVisibility === 'hidden' ||
        Number(style.opacity) !== 1 || style.transform !== 'none' || style.perspective !== 'none' || style.filter !== 'none') return null;
    // The body portal itself must have a viewport containing block and unit CSS zoom.
    if ((node === editor.ownerDocument.body || node === editor.ownerDocument.documentElement) && Number(style.zoom || '1') !== 1) return null;
  }
  const es = win.getComputedStyle(editor);
  if (es.display !== 'grid' || es.boxSizing !== 'border-box' || !/^(scroll|auto)$/.test(es.overflowY) ||
      es.writingMode !== 'horizontal-tb' ||
      !['none', 'normal'].includes(win.getComputedStyle(editor, '::before').content) ||
      !['none', 'normal'].includes(win.getComputedStyle(editor, '::after').content)) return null;
  const mains = direct(editor, '.orca-block-editor-main');
  if (mains.length !== 1 || direct(editor, ':not(.orca-block-editor-main):not(.orca-block-editor-go-btns)').length) return null;
  const main = mains[0];
  const blocksList = direct(main, '.orca-block-editor-blocks[data-hl-container]');
  const ends = direct(main, '.orca-block-editor-none-editable[contenteditable="false"]');
  if (blocksList.length !== 1 || ends.length !== 1 || main.lastElementChild !== ends[0] || ends[0].previousElementSibling !== blocksList[0]) return null;
  const blocks = blocksList[0], end = ends[0];
  const placeholders = direct(end, '.orca-block-editor-placeholder');
  if (placeholders.length !== 1 || end.firstElementChild !== placeholders[0]) return null;
  const placeholder = placeholders[0];
  // Only a normal block-flow seam is understood. In particular a flex/grid,
  // fixed-size or overflowing native controls region is not an insertion slot.
  for (const node of [main, blocks, end, placeholder]) {
    const style = win.getComputedStyle(node);
    if (style.display !== 'block' || style.float !== 'none' || style.columnCount !== 'auto' ||
        style.writingMode !== 'horizontal-tb' || style.maxHeight !== 'none' ||
        !['none', 'normal'].includes(win.getComputedStyle(node, '::before').content) ||
        !['none', 'normal'].includes(win.getComputedStyle(node, '::after').content)) return null;
  }
  if (end.style.height || end.style.blockSize || px(win.getComputedStyle(end).marginTop) !== 0 ||
      px(win.getComputedStyle(end).marginBottom) !== 0 || px(win.getComputedStyle(placeholder).marginTop) !== 0) return null;
  const roots = direct(blocks, '.orca-block[data-id][data-rnd-id]');
  // Reject an unmounted root, invented spacer siblings, or an unknown virtualizer.
  if (roots.length !== 1 || blocks.children.length !== 1 || roots[0].dataset.id !== editor.dataset.blockId) return null;
  for (const node of [main, blocks, roots[0], end, placeholder]) {
    const style = win.getComputedStyle(node);
    if (!['relative', 'static'].includes(style.position) || style.transform !== 'none' || style.contentVisibility === 'hidden' ||
        style.contain.includes('size') || !['visible', 'clip'].includes(style.overflowY)) return null;
    // An absolutely positioned window without a full native extent is not a footer anchor.
    if (node.offsetHeight <= 0 || node.scrollHeight > node.clientHeight + 2) return null;
  }
  const er = editor.getBoundingClientRect(), mr = main.getBoundingClientRect(), br = blocks.getBoundingClientRect();
  const rr = roots[0].getBoundingClientRect(), tail = end.getBoundingClientRect();
  if (!finite(er.width, er.height, mr.bottom, br.bottom, rr.bottom) || er.width < 80 || er.height < 60 || mr.width < 40 ||
      br.top < mr.top - 2 || br.bottom > mr.bottom + 2 || rr.top < br.top - 2 || rr.bottom > br.bottom + 2 ||
      tail.top < br.bottom - 2 || tail.bottom > mr.bottom + 2) return null;
  return { panel, wrapper, main, blocks, end, placeholder };
}

/** Compare styles without the sole owned longhand; do not lose unrelated writes. */
function otherStyle(doc: Document, text: string | null): string {
  const style = doc.createElement('div').style;
  style.cssText = text ?? '';
  style.removeProperty('padding-top');
  return [...style].sort().map(name => `${name}:${style.getPropertyValue(name)}!${style.getPropertyPriority(name)}`).join(';');
}

export class FlowFooterSurface {
  readonly host: HTMLElement;
  private readonly editor: HTMLElement;
  private readonly clip: HTMLElement;
  private readonly win: Window;
  private readonly ro: ResizeObserver;
  private readonly mo: MutationObserver;
  private observed = new Set<Element>();
  private ancestors: HTMLElement[] = [];
  private frame: number | null = null;
  private disposed = false;
  private updating = false;
  private acquired = false;
  private originalStyle: string | null = null;
  private leaseTarget: HTMLElement | null = null;
  private originalTop = '';
  private originalPriority = '';
  private baseTop = '0px';
  private ownedTop = '';
  private lastLeaseStyle: string | null = null;
  private lastHostStyle = '';
  private ready = false;

  static isSupported(editor: HTMLElement): boolean { return shape(editor) !== null; }

  constructor(editor: HTMLElement) {
    if (owners.has(editor)) throw new Error('FlowFooterSurface: editor already has an owner');
    const win = editor.ownerDocument.defaultView;
    if (!win || !win.ResizeObserver || !win.MutationObserver) throw new Error('FlowFooterSurface: observers unavailable');
    this.editor = editor;
    this.win = win;
    const doc = editor.ownerDocument;
    this.clip = doc.createElement('div');
    this.clip.dataset.ofnFlowClip = '';
    this.clip.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:clip;pointer-events:none;visibility:hidden;contain:layout style;';
    this.host = doc.createElement('section');
    this.host.dataset.ofnFlowHost = '';
    this.host.contentEditable = 'false';
    this.host.style.cssText = 'position:absolute;left:0;top:0;display:flow-root;box-sizing:border-box;margin:0;pointer-events:auto;transform-origin:0 0;overflow:visible;';
    this.clip.append(this.host);
    doc.body.append(this.clip);
    this.ro = new win.ResizeObserver(this.schedule);
    this.mo = new win.MutationObserver(records => {
      if (this.disposed) return;
      if (records.every(record =>
        (record.type === 'attributes' && record.attributeName === 'style' && record.target === this.leaseTarget && this.leaseTarget?.getAttribute('style') === this.lastLeaseStyle) ||
        (record.type === 'attributes' && record.attributeName === 'style' && record.target === this.host && this.host.style.cssText === this.lastHostStyle) ||
        (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node === this.clip)))) return;
      this.schedule();
    });
    this.mo.observe(editor, { childList: true, subtree: true, attributes: true, characterData: true });
    this.mo.observe(this.host, { childList: true, subtree: true, attributes: true, characterData: true });
    for (let node = editor.parentElement; node; node = node.parentElement) {
      this.ancestors.push(node);
      this.mo.observe(node, { childList: true, attributes: true });
    }
    this.win.addEventListener('scroll', this.schedule, true);
    this.win.addEventListener('resize', this.schedule);
    this.win.visualViewport?.addEventListener('resize', this.schedule);
    this.win.visualViewport?.addEventListener('scroll', this.schedule);
    this.host.addEventListener('wheel', this.wheel, { passive: false });
    owners.set(editor, this);
    this.observe([editor, this.host, ...this.ancestors]);
    this.update();
  }

  private schedule = (): void => {
    if (!this.disposed && this.frame === null) this.frame = this.win.requestAnimationFrame(() => {
      this.frame = null;
      this.update();
    });
  };

  private wheel = (event: WheelEvent): void => {
    if (!this.ready || event.ctrlKey || event.defaultPrevented) return;
    const box = layoutBox(this.editor);
    if (!box) return;
    const { sx, sy } = box;
    const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? this.editor.clientHeight : 1;
    this.editor.scrollTop += event.deltaY * unit / (event.deltaMode ? 1 : sy);
    this.editor.scrollLeft += event.deltaX * unit / (event.deltaMode ? 1 : sx);
    // Never chain the portal's wheel to an outer document/panel.
    event.preventDefault();
    this.schedule();
  };

  private observe(elements: Element[]): void {
    const next = new Set(elements);
    for (const node of this.observed) if (!next.has(node)) this.ro.unobserve(node);
    for (const node of next) if (!this.observed.has(node)) this.ro.observe(node);
    this.observed = next;
  }

  private releasePadding(): void {
    const target = this.leaseTarget;
    if (!this.acquired || !target) return;
    const style = target.style;
    // A foreign writer of the SAME property owns the new value; leave it alone.
    if (style.getPropertyValue('padding-top') === this.ownedTop && style.getPropertyPriority('padding-top') === 'important') {
      const current = target.getAttribute('style');
      if (otherStyle(target.ownerDocument, current) === otherStyle(target.ownerDocument, this.originalStyle)) {
        if (this.originalStyle === null) target.removeAttribute('style');
        else target.setAttribute('style', this.originalStyle);
      } else {
        if (this.originalTop) style.setProperty('padding-top', this.originalTop, this.originalPriority);
        else style.removeProperty('padding-top');
      }
    }
    this.lastLeaseStyle = target.getAttribute('style');
    this.acquired = false;
    this.ownedTop = '';
  }

  private fail(): false {
    this.ready = false;
    this.clip.style.visibility = 'hidden';
    this.releasePadding();
    return false;
  }

  /** Synchronous geometry refresh; event/RO/MO refreshes are rAF-coalesced. */
  update(): boolean {
    if (this.disposed || this.updating) return false;
    if (this.frame !== null) { this.win.cancelAnimationFrame(this.frame); this.frame = null; }
    if (!this.editor.isConnected) { this.dispose(); return false; }
    this.updating = true;
    try {
      const native = shape(this.editor);
      if (!native) return this.fail();
      const { main, panel, blocks, end, placeholder } = native;
      if (this.leaseTarget !== end) this.releasePadding();
      this.observe([this.editor, this.host, main, blocks, end, placeholder, panel, ...this.ancestors]);
      const editorBox = layoutBox(this.editor);
      if (!editorBox) return this.fail();
      const { rect: editorRect, sx, sy, client } = editorBox;
      if (!finite(sx, sy) || sx < 0.1 || sy < 0.1 || Math.abs(sx - sy) > 0.03) return this.fail();
      const vv = this.win.visualViewport;
      const clip: Box = {
        left: Math.max(vv?.offsetLeft ?? 0, client.left),
        top: Math.max(vv?.offsetTop ?? 0, client.top),
        right: Math.min((vv?.offsetLeft ?? 0) + (vv?.width ?? this.win.innerWidth), client.right),
        bottom: Math.min((vv?.offsetTop ?? 0) + (vv?.height ?? this.win.innerHeight), client.bottom),
      };
      for (const ancestor of this.ancestors) {
        const box = layoutBox(ancestor);
        if (!box) return this.fail();
        if (/hidden|clip|auto|scroll/.test(box.style.overflowX) || ancestor === panel) {
          clip.left = Math.max(clip.left, box.client.left);
          clip.right = Math.min(clip.right, box.client.right);
        }
        if (/hidden|clip|auto|scroll/.test(box.style.overflowY) || ancestor === panel) {
          clip.top = Math.max(clip.top, box.client.top);
          clip.bottom = Math.min(clip.bottom, box.client.bottom);
        }
      }
      const headbar = this.editor.ownerDocument.getElementById('headbar');
      if (headbar) {
        const head = headbar.getBoundingClientRect();
        if (head.right > clip.left && head.left < clip.right) clip.top = Math.max(clip.top, head.bottom);
      }
      if (clip.right - clip.left < 40 || clip.bottom - clip.top < 40) return this.fail();
      const mainRect = main.getBoundingClientRect();
      const font = this.win.getComputedStyle(this.editor);
      const hs = this.host.style;
      hs.width = `${mainRect.width / sx}px`;
      hs.fontFamily = font.fontFamily; hs.fontSize = font.fontSize;
      hs.fontWeight = font.fontWeight; hs.lineHeight = font.lineHeight; hs.color = font.color;
      hs.transform = `scale(${sx}, ${sy})`;
      // Reading host, never a mounted body row, determines the required extra range.
      const height = layoutBox(this.host)?.height ?? NaN;
      if (!finite(height) || height <= 0 || height > 1e7) return this.fail();
      if (this.acquired && (end.style.getPropertyValue('padding-top') !== this.ownedTop || end.style.getPropertyPriority('padding-top') !== 'important')) {
        this.acquired = false; // rebase a foreign same-property write, preserving its new restoration state
      }
      if (!this.acquired) {
        this.leaseTarget = end;
        this.originalStyle = end.getAttribute('style');
        this.originalTop = end.style.getPropertyValue('padding-top');
        this.originalPriority = end.style.getPropertyPriority('padding-top');
        this.baseTop = this.originalTop || this.win.getComputedStyle(end).paddingTop || '0px';
        this.acquired = true;
      }
      const extra = Math.ceil(height) + 2 * GAP;
      const beforeTop = px(this.win.getComputedStyle(end).paddingTop);
      const beforeEnd = end.getBoundingClientRect(), beforeBlocks = blocks.getBoundingClientRect();
      const beforePlaceholder = placeholder.getBoundingClientRect(), beforeScroll = this.editor.scrollTop;
      const top = `calc(${this.baseTop} + ${extra}px)`;
      // This is padding on an AUTO-HEIGHT NON-EDITABLE block, not on the
      // viewport-sized contenteditable. Its full height participates in flow.
      end.style.setProperty('padding-top', top, 'important');
      this.ownedTop = end.style.getPropertyValue('padding-top');
      this.lastLeaseStyle = end.getAttribute('style');
      const after = main.getBoundingClientRect(), afterEnd = end.getBoundingClientRect();
      const afterBlocks = blocks.getBoundingClientRect(), afterPlaceholder = placeholder.getBoundingClientRect();
      const endStyle = this.win.getComputedStyle(end), afterTop = px(endStyle.paddingTop);
      const delta = (afterTop - beforeTop) * sy;
      const scrollDelta = (this.editor.scrollTop - beforeScroll) * sy;
      const afterEditor = this.editor.getBoundingClientRect();
      const footerTop = afterEnd.top + (px(endStyle.borderTopWidth) + afterTop - extra + GAP) * sy;
      const nativeEnd = (after.bottom - client.top) / sy + this.editor.scrollTop;
      // Verify actual reflow, not merely a desired CSS declaration. A fixed-size
      // controls/main area, collapsed seam, overflow or shifted prose fails shut.
      if (!finite(afterTop, footerTop, nativeEnd) || afterTop < extra ||
          Math.abs(after.height - mainRect.height - delta) > 2 ||
          Math.abs(afterEnd.height - beforeEnd.height - delta) > 2 ||
          Math.abs(afterPlaceholder.top - beforePlaceholder.top + scrollDelta - delta) > 2 ||
          Math.abs(afterBlocks.top - beforeBlocks.top + scrollDelta) > 2 ||
          Math.abs(afterBlocks.height - beforeBlocks.height) > 2 ||
          Math.abs(afterEditor.height - editorRect.height) > 2 || Math.abs(afterEditor.width - editorRect.width) > 2 ||
          footerTop < afterBlocks.bottom + GAP * sy - 2 ||
          afterPlaceholder.top < footerTop + (height + GAP) * sy - 2 ||
          this.editor.scrollHeight + 2 < nativeEnd) return this.fail();
      const cs = this.clip.style;
      cs.left = `${clip.left}px`; cs.top = `${clip.top}px`;
      cs.width = `${clip.right - clip.left}px`; cs.height = `${clip.bottom - clip.top}px`;
      hs.left = `${after.left - clip.left}px`;
      hs.top = `${footerTop - clip.top}px`;
      this.lastHostStyle = hs.cssText;
      cs.visibility = 'visible';
      this.ready = true;
      return true;
    } finally {
      this.lastHostStyle = this.host.style.cssText;
      this.updating = false;
    }
  }

  /** Bounded scroll of the owner editor only; foreign targets are ignored. */
  scrollTo(element?: HTMLElement, align: ScrollAlignment = "start"): void {
    if (!this.update() || (element && element !== this.host && !this.host.contains(element))) return;
    const target = (element ?? this.host).getBoundingClientRect(), clip = this.clip.getBoundingClientRect();
    const box = layoutBox(this.editor);
    if (!box) return;
    this.editor.scrollTop = footerScrollTop({ scrollTop: this.editor.scrollTop, scrollHeight: this.editor.scrollHeight,
      clientHeight: this.editor.clientHeight, scaleY: box.sy, targetTop: target.top, targetBottom: target.bottom,
      clipTop: clip.top, clipBottom: clip.bottom }, align);
    this.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.ro.disconnect();
    this.mo.disconnect();
    this.observed.clear();
    this.win.removeEventListener('scroll', this.schedule, true);
    this.win.removeEventListener('resize', this.schedule);
    this.win.visualViewport?.removeEventListener('resize', this.schedule);
    this.win.visualViewport?.removeEventListener('scroll', this.schedule);
    this.host.removeEventListener('wheel', this.wheel);
    this.releasePadding();
    this.clip.remove();
    owners.delete(this.editor);
    this.ancestors = [];
  }
}
