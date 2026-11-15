import type { Orca } from "../../vendor/orca";
import type { WorkspaceActions, WorkspaceItem, WorkspaceView } from "../vnext/ui-contract";

type Components = Pick<Orca["components"], "Button" | "MenuText" | "ContextMenu">;
type Id = WorkspaceItem["item"]["id"];
const textOf = (row: WorkspaceItem): string => "text" in row.item ? String((row.item as { text: string }).text) : "";

export interface DrawerAnchor {
  /** Where the drawer sits: its right edge is rect.right; it stays within rect.top..rect.bottom (viewport coords). null = hide. */
  rect(): DOMRect | null;
  /** Called whenever rect() or reading() may have changed (scroll, resize, page switch). Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Reading focus: weight 0..1 per footnote item id (how close its citations are to the middle of what is on screen). */
  reading(): ReadonlyMap<number, number>;
}
/** font: "editor" the note's own typeface (default), "serif" Georgia for Latin and digits with the note's typeface for Chinese, "sans" PingFang-like sans. */
export interface DrawerProps { view: WorkspaceView; actions: WorkspaceActions; mode: "local" | "slide"; follow: "pointer" | "reading"; anchor: DrawerAnchor; font?: "editor" | "serif" | "sans" }

interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface Spring { x: number; v: number; t: number }
/** While floating, the gaps near the focus open up to GAP px so labels do not touch (the rest spacing stays compact). */
const GAP = 26;
const STRIP = 28, APPROACH = 40, REACH = 24, STIFF = 380, DAMP = 2 * 0.75 * Math.sqrt(STIFF), DWELL = 450, LEAVE = 200;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const sameBox = (a: Box | null, b: Box | null) => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom);
/** Our own layout model: the column starts at the top of the rect (upper right) and grows down; spacing
 * tightens as entries are added, so the column never takes more than 70% of the height. */
function layoutOf(b: Box | null, n: number) {
  if (!b || !n) return null;
  const s = clamp(b.height * 0.7 / n, 4, 14), col = (n - 1) * s, top = b.top + 8;
  return { s, top, col, y: (i: number) => top + i * s };
}

/** The right-side directory as a drawer on the editor's right edge: lines at rest;
 * a focus point (pointer, keyboard or reading position) pulls nearby entries out
 * with spring motion. No box of its own: only the lines and visible labels take pointer events. */
export function createDrawerDirectoryUI(React: typeof import("react"), components: Components) {
  const { Button, MenuText, ContextMenu } = components;
  const menuContainer = { current: document.body };
  const keep = { onMouseDown: (event: import("react").MouseEvent<HTMLElement>) => event.preventDefault() };
  /** Rendered inside a ContextMenu's render prop: reports shown/hidden, and
   * releases the claim if the row unmounts while its menu is open. */
  const MenuWatch = ({ shown, report }: { shown: boolean; report: (delta: number) => void }) => {
    React.useEffect(() => { if (!shown) return; report(1); return () => report(-1); }, [shown]);
    return null;
  };
  const menuFor = (actions: WorkspaceActions, id: Id) => (close: () => void) => <>
    <MenuText title="编辑" preIcon="ti ti-pencil" onClick={() => { close(); actions.edit(id); }} />
    <MenuText title="引用此条" preIcon="ti ti-link" onClick={() => { close(); actions.use(id); }} />
    <MenuText title="正文引用" preIcon="ti ti-arrow-back-up" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); close(); actions.locate(id, rect); }} />
    <MenuText title="复制" preIcon="ti ti-copy" onClick={() => { close(); actions.copyItem(id); }} />
    <MenuText title="删除尾注" preIcon="ti ti-trash" dangerous onClick={() => { close(); actions.recycle(id); }} />
  </>;

  function DrawerDirectory(props: DrawerProps) {
    const { view, actions, mode, follow, anchor } = props;
    const n = view.entries.length;
    const [box, setBox] = React.useState<Box | null>(null);
    const [lv, setLv] = React.useState<readonly number[]>([]);
    // Everything the animation loop reads lives in refs, so frames never re-render React.
    const cfg = React.useRef(props); cfg.current = props;
    const boxRef = React.useRef<Box | null>(null), root = React.useRef<HTMLDivElement>(null);
    const movers = React.useRef<(HTMLElement | null)[]>([]), lines = React.useRef<(HTMLElement | null)[]>([]);
    const rowEls = React.useRef<(HTMLElement | null)[]>([]), spy = React.useRef<Spring[]>([]); // vertical spread per entry
    const sp = React.useRef<Spring[]>([]), act = React.useRef<Spring>({ x: 0, v: 0, t: 0 }); // act is scaled x30 so it shares the px thresholds
    const levels = React.useRef<number[]>([]), sig = React.useRef(""), near = React.useRef(0), full = React.useRef<Id | null>(null);
    const ptr = React.useRef<{ fy: number; str: number } | null>(null), foc = React.useRef<number | null>(null), last = React.useRef<{ fy: number; str: number } | null>(null);
    const menus = React.useRef(0), raf = React.useRef(0), lastT = React.useRef(0);
    const dwell = React.useRef<{ near: number; fy: number } | null>(null);
    const timers = React.useRef({ leave: 0, idle: 0, dwell: 0 });
    const amp = () => cfg.current.mode === "slide" ? 22 : 30;

    const gOf = (i: number) => cfg.current.mode === "slide" ? (sp.current[i].x - (act.current.x / 30) * 16) / 22 : sp.current[i].x / 30;
    const syncLevels = () => {
      const { view: v, mode: m } = cfg.current, L = layoutOf(boxRef.current, v.entries.length);
      if (!L) return;
      const stride = Math.ceil(12 / L.s), a = act.current.x / 30, out: number[] = [];
      v.entries.forEach((row, i) => {
        const prev = levels.current[i] ?? 0, g = gOf(i);
        let level = 0;
        if (full.current === row.item.id) level = 3;
        else if (full.current != null) level = 0; // the full text stands alone; the others keep only their lines (both modes: text peeking out from under the card is worse)
        else {
          if (m === "slide" && a > (prev ? 0.04 : 0.08)) level = 2; else if (g >= (prev ? 0.15 : 0.3)) level = 1;
          if (m === "local" && i === near.current && g >= (prev >= 2 ? 0.6 : 0.8)) level = 2;
          if (level && i !== near.current && (i - near.current) % stride) level = 0; // keep neighbouring labels from overlapping
        }
        out.push(level);
      });
      levels.current = out;
      const key = out.join("");
      if (key !== sig.current) { sig.current = key; setLv(out); }
    };
    const paint = () => {
      const m = cfg.current.mode, a = clamp(act.current.x / 30, 0, 1);
      sp.current.forEach((s, i) => {
        const level = levels.current[i] ?? 0, g = clamp(gOf(i), 0, 1.2);
        movers.current[i]?.style.setProperty("--o", String(level === 3 ? 1 : m === "slide" && level === 2 ? Math.min(1, a * 1.5) : clamp(g, 0, 1)));
        if (movers.current[i]) movers.current[i]!.style.transform = `translate3d(${-s.x}px,-50%,0)`;
        if (lines.current[i]) lines.current[i]!.style.transform = `translate3d(${-s.x}px,0,0) scaleX(${1 + 0.67 * clamp(g, 0, 1)})`;
        if (rowEls.current[i]) rowEls.current[i]!.style.transform = `translate3d(0,${spy.current[i]?.x ?? 0}px,0)`;
      });

    };
    const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const integrate = (s: Spring, dt: number) => {
      for (let left = dt; left > 0; left -= 1 / 120) {
        const h = Math.min(left, 1 / 120);
        s.v += (STIFF * (s.t - s.x) - DAMP * s.v) * h; s.x += s.v * h;
      }
      if (Math.abs(s.t - s.x) < 0.1 && Math.abs(s.v) < 0.1) { s.x = s.t; s.v = 0; return false; }
      return true;
    };
    const frame = (now: number) => {
      raf.current = 0;
      const dt = Math.min(0.05, (now - lastT.current) / 1000); lastT.current = now;
      let moving = integrate(act.current, dt);
      for (const s of sp.current) if (integrate(s, dt)) moving = true;
      for (const s of spy.current) if (integrate(s, dt)) moving = true;
      syncLevels(); paint();
      if (moving) raf.current = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (reduced()) { for (const s of [act.current, ...sp.current, ...spy.current]) { s.x = s.t; s.v = 0; } syncLevels(); paint(); return; }
      if (!raf.current) { lastT.current = performance.now(); raf.current = requestAnimationFrame(frame); }
    };
    const setFull = (id: Id | null) => { if (full.current === id) return; full.current = id; syncLevels(); };
    /** Recompute spring targets from the current focus source. */
    const retarget = () => {
      const { view: v, mode: m, follow: f, anchor: an } = cfg.current, rows = v.entries, L = layoutOf(boxRef.current, rows.length);
      while (sp.current.length < rows.length) sp.current.push({ x: 0, v: 0, t: 0 });
      sp.current.length = rows.length;
      while (spy.current.length < rows.length) spy.current.push({ x: 0, v: 0, t: 0 });
      spy.current.length = rows.length;
      if (!L) { for (const s of [...sp.current, ...spy.current]) s.t = 0; act.current.t = 0; setFull(null); kick(); return; }
      const eff = ptr.current ?? (foc.current != null && foc.current < rows.length ? { fy: L.y(foc.current), str: 1 } : menus.current > 0 ? last.current : null);
      last.current = eff;
      window.clearTimeout(timers.current.dwell);
      if (eff) {
        const sigma = 2.2 * L.s, base = m === "slide" ? 16 * eff.str : 0;
        let best = 0;
        sp.current.forEach((s, i) => {
          const d = L.y(i) - eff.fy;
          s.t = base + amp() * eff.str * Math.exp(-((d / sigma) ** 2));
          if (Math.abs(d) < Math.abs(L.y(best) - eff.fy)) best = i;
        });
        near.current = best; act.current.t = 30 * eff.str;
        // Vertical breathing room: each gap opens by up to GAP − spacing, most near the focus (in 整条滑出
        // all gaps open, since every entry shows a line of text), limited so the column stays in the rect.
        // fy itself is a fixed point: an entry moves by the extra room lying between it and fy, so
        // entries above the focus move up, those below move down, and nothing jumps as the focus moves.
        const n = rows.length, sv = 2.6 * L.s, room = Math.max(0, (boxRef.current!.height * 0.9 - L.col) / Math.max(1, n - 1));
        const open = Math.min(Math.max(0, GAP - L.s), room) * eff.str;
        const extra = (k: number) => { const w = Math.exp(-((((L.y(k) + L.y(k + 1)) / 2 - eff.fy) / sv) ** 2)); return open * (m === "slide" ? Math.max(0.65, w) : w); };
        const overlap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
        spy.current.forEach((s, i) => {
          let dy = 0; const yi = L.y(i);
          for (let k = 0; k < n - 1; k++) {
            const part = yi > eff.fy ? overlap(L.y(k), L.y(k + 1), eff.fy, yi) : -overlap(L.y(k), L.y(k + 1), yi, eff.fy);
            if (part) dy += part / L.s * extra(k);
          }
          s.t = dy;
        });
        const moved = !dwell.current || dwell.current.near !== best || Math.abs(dwell.current.fy - eff.fy) > 3;
        if (moved) { dwell.current = { near: best, fy: eff.fy }; if (full.current != null) setFull(null); }
        if (full.current == null && eff.str >= 0.5) { const id = rows[best].item.id; timers.current.dwell = window.setTimeout(() => setFull(id), DWELL); }
      } else {
        dwell.current = null; setFull(null);
        const rd = f === "reading" ? an.reading() : null;
        let best = 0, bw = -1;
        sp.current.forEach((s, i) => { const w = rd?.get(rows[i].item.id) ?? 0; s.t = amp() * 0.35 * w; if (w > bw) { bw = w; best = i; } });
        for (const s of spy.current) s.t = 0;
        near.current = best; act.current.t = 0;
      }
      syncLevels(); kick();
    };
    const retargetSoon = () => { window.clearTimeout(timers.current.idle); timers.current.idle = window.setTimeout(retarget, LEAVE); };
    const report = (delta: number) => { menus.current += delta; if (!menus.current) retargetSoon(); };

    React.useEffect(() => {
      const refresh = () => {
        const r = anchor.rect(), next = r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null;
        if (!sameBox(boxRef.current, next)) { boxRef.current = next; setBox(next); }
        retarget();
      };
      const leaveSoon = () => {
        if (!ptr.current || timers.current.leave) return;
        timers.current.leave = window.setTimeout(() => { timers.current.leave = 0; ptr.current = null; retarget(); }, LEAVE);
      };
      const onMove = (event: PointerEvent) => {
        const b = boxRef.current, L = layoutOf(b, cfg.current.view.entries.length), target = event.target as Element | null;
        if (!b || !L) return;
        const over = !!target && !!root.current?.contains(target);
        const dx = b.right - event.clientX, inY = event.clientY >= L.top - REACH && event.clientY <= L.top + L.col + REACH;
        const str = over ? 1 : inY && dx >= -4 && dx <= STRIP + APPROACH ? clamp(1 - (dx - STRIP) / APPROACH, 0, 1) : 0;
        if (!str) return leaveSoon();
        window.clearTimeout(timers.current.leave); timers.current.leave = 0;
        // While the pointer is on the full text, the focus point stays put so the text does not jump away.
        if (target?.closest?.(".ofn-v3-drawer-label.is-full, .ofn-v3-drawer-more") && ptr.current) return;
        if (ptr.current && Math.abs(ptr.current.fy - event.clientY) < 0.5 && ptr.current.str === str) return;
        ptr.current = { fy: event.clientY, str }; retarget();
      };
      const out = () => leaveSoon();
      refresh();
      const off = anchor.subscribe(refresh);
      window.addEventListener("resize", refresh);
      window.addEventListener("pointermove", onMove, { passive: true });
      document.documentElement.addEventListener("pointerleave", out);
      return () => { off(); window.removeEventListener("resize", refresh); window.removeEventListener("pointermove", onMove); document.documentElement.removeEventListener("pointerleave", out); };
    }, [anchor]);
    React.useEffect(() => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      for (const k of ["leave", "idle", "dwell"] as const) window.clearTimeout(timers.current[k]);
      actions.hover(null);
    }, []);
    const key = view.entries.map(row => row.item.id).join(",");
    React.useLayoutEffect(() => { retarget(); }, [box, mode, follow, key]);
    React.useLayoutEffect(() => { paint(); }, [lv, box, key]);

    if (!box) return null;
    const L = layoutOf(box, n), empty = view.loading ? "加载中…" : "暂无尾注";
    const rel = (y: number) => y - box.top;
    return <div ref={root} className="ofn-v3-drawer" data-mode={mode} data-font={props.font ?? "editor"} aria-label="尾注目录" aria-busy={view.loading}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node | null)) { foc.current = null; retargetSoon(); } }}>
      {L ? <>
        <div className="ofn-v3-drawer-strip" style={{ top: rel(L.top) - REACH - L.s / 2, height: L.col + L.s + 2 * REACH }} />
        {view.entries.map((row, i) => {
          const text = textOf(row), level = lv[i] ?? 0, selected = view.selectedItemId === row.item.id;
          return <div key={row.item.id} ref={el => { rowEls.current[i] = el; }} className={`ofn-v3-drawer-row${selected ? " is-selected" : ""}${level ? " is-lit" : ""}`} data-item-id={row.item.id}
            style={{ top: rel(L.y(i)) - L.s / 2, height: L.s, zIndex: level + 1 }}
            onMouseEnter={() => actions.hover(row.item.id)} onMouseLeave={() => actions.hover(null)}>
            <ContextMenu container={menuContainer} noPointerLogic menuAttr={keep} menu={menuFor(actions, row.item.id)}>
              {(openMenu, _close, shown) => <>
                <MenuWatch shown={shown} report={report} />
                <div ref={el => { movers.current[i] = el; }} className="ofn-v3-drawer-mover">
                  {level > 0 && <button type="button" tabIndex={-1} aria-hidden="true" className={`ofn-v3-drawer-label${level === 3 ? " is-full" : level === 1 ? " is-num" : ""}`}
                    onMouseDown={keep.onMouseDown} onContextMenu={openMenu} onClick={event => actions.select(row.item.id, event.currentTarget.getBoundingClientRect())}>
                    <b>{row.number ?? ""}</b>{level >= 2 && <span>{text || "（空）"}</span>}
                  </button>}
                  {level === 3 && <Button type="button" variant="plain" className="ofn-v3-tool ofn-v3-drawer-more" aria-label={`尾注 ${row.number ?? ""} 操作`} title="尾注操作" onMouseDown={keep.onMouseDown} onClick={openMenu}><i className="ti ti-dots" aria-hidden="true" /></Button>}
                  <i className="ofn-v3-drawer-pad" />
                </div>
                <button type="button" className="ofn-v3-drawer-hit" aria-current={selected ? "true" : undefined} aria-label={`尾注 ${row.number ?? ""}：${text}`}
                  onMouseDown={keep.onMouseDown} onContextMenu={openMenu} onClick={event => actions.select(row.item.id, event.currentTarget.getBoundingClientRect())}
                  onFocus={() => { foc.current = i; window.clearTimeout(timers.current.leave); timers.current.leave = 0; retarget(); }}>
                  <i ref={el => { lines.current[i] = el; }} className="ofn-v3-drawer-line" />
                </button>
              </>}
            </ContextMenu>
          </div>;
        })}
      </> : <span className="ofn-v3-drawer-empty" title={empty} style={{ top: box.height / 2 - 1 }}><i /></span>}
    </div>;
  }
  return { DrawerDirectory };
}
