/** Pure navigation geometry/feedback leases; no note, selection or host state. */
export type RectEdges = { left: number; top: number; bottom: number };
export type SurfaceGeometry = { viewportWidth: number; viewportHeight: number; width: number; height: number; headbarBottom?: number; headerHeight?: number };
export function anchoredPosition(rect: RectEdges | undefined, geometry: SurfaceGeometry, preferred?: { left: number; top: number } | null) {
  const { viewportWidth: vw, viewportHeight: vh, width, height } = geometry;
  const gx = Math.min(12, Math.max(0, vw / 2)), gy = Math.min(12, Math.max(0, vh / 2));
  const minTop = Math.min(Math.max(gy, (geometry.headbarBottom ?? 0) + 8), Math.max(0, vh - Math.min(height, geometry.headerHeight ?? 32) - gy));
  const maxLeft = Math.max(gx, vw - width - gx), maxTop = Math.max(minTop, vh - height - gy);
  const below = rect ? rect.bottom + 6 : (vh - height) / 3;
  const above = rect ? rect.top - height - 6 : below;
  // Only flip when below cannot fit and above has more usable room.
  const top = rect && below + height > vh - gy && rect.top - minTop > vh - gy - rect.bottom ? above : below;
  return { left: Math.max(gx, Math.min(maxLeft, preferred?.left ?? rect?.left ?? (vw - width) / 2)),
    top: Math.max(minTop, Math.min(maxTop, preferred?.top ?? top)) };
}

export type ScrollAlignment = "start" | "center";
export function footerScrollTop(input: { scrollTop: number; scrollHeight: number; clientHeight: number; scaleY: number;
  targetTop: number; targetBottom: number; clipTop: number; clipBottom: number }, align: ScrollAlignment = "start"): number {
  const { scrollTop, scrollHeight, clientHeight, scaleY, targetTop, targetBottom, clipTop, clipBottom } = input;
  if (![scrollTop, scrollHeight, clientHeight, scaleY, targetTop, targetBottom, clipTop, clipBottom].every(Number.isFinite) || scaleY <= 0) return scrollTop;
  // A row taller than the effective viewport starts at its readable beginning;
  // centering its midpoint would hide both the number and the start of the text.
  const delta = align === "center" && targetBottom - targetTop <= clipBottom - clipTop
    ? (targetTop + targetBottom - clipTop - clipBottom) / 2 : targetTop - clipTop;
  return Math.max(0, Math.min(scrollTop + delta / scaleY, Math.max(0, scrollHeight - clientHeight)));
}

type ClassTarget = { classList: Pick<DOMTokenList, "contains" | "add" | "remove"> };
/** An old timeout can neither erase a newer target nor a foreign preexisting class. */
export class TransientFeedback {
  private lease?: { nodes: ClassTarget[]; className: string; timer?: ReturnType<typeof setTimeout>; source: string };
  constructor(private readonly schedule: typeof setTimeout = setTimeout, private readonly cancel: typeof clearTimeout = clearTimeout) {}
  show(nodes: readonly ClassTarget[], className: string, source: string, duration = 950): void {
    this.clear();
    const owned = nodes.filter(node => !node.classList.contains(className));
    const lease = { nodes: owned, className, source, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.lease = lease;
    for (const node of owned) node.classList.add(className);
    // Window timer functions reject a helper instance as their receiver. Invoke
    // the injected/default port as a plain function, not this.schedule(...).
    const schedule = this.schedule;
    try { lease.timer = schedule(() => { if (this.lease === lease) this.clear(); }, duration); }
    catch (error) { this.clear(); throw error; }
  }
  clear(): void {
    const lease = this.lease; this.lease = undefined;
    if (!lease) return;
    if (lease.timer !== undefined) { const cancel = this.cancel; cancel(lease.timer); }
    for (const node of lease.nodes) node.classList.remove(lease.className);
  }
}
