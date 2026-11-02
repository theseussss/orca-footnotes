/** Local UI preference only. Coordinates are viewport/client pixels,
 * not CSS style offsets, a note/repository identifier, or a document selection. */
export interface DirectoryPosition { left: number; top: number }
export interface DirectoryLayout { position: DirectoryPosition | null; locked: boolean }

const VERSION = 1;
const MAX_COORDINATE = 100_000;
const GUTTER = 12;
const HEADBAR_GAP = 8;
const DEFAULT_INSET = 60;

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function coordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_COORDINATE;
}
function position(value: unknown): value is DirectoryPosition {
  return record(value, ["left", "top"]) && coordinate(value.left) && coordinate(value.top);
}
function copyPosition(value: DirectoryPosition): DirectoryPosition {
  // Canonicalize -0 as well as copying; callers never share parser-owned state.
  return { left: value.left || 0, top: value.top || 0 };
}

/** Unknown versions, extra/missing fields, coercions and unreasonable coordinates
 * fail as a whole. A bad saved lock flag must not override the current default.
 * The small size bound also avoids parsing an unrelated/oversized stored value. */
export function parseDirectoryLayout(raw: string | null, defaultLocked = false): DirectoryLayout {
  const fallback = (): DirectoryLayout => ({ position: null, locked: defaultLocked === true });
  if (typeof raw !== "string" || raw.length > 1_024) return fallback();
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value, ["version", "position", "locked"]) || value.version !== VERSION
      || typeof value.locked !== "boolean" || (value.position !== null && !position(value.position))) return fallback();
    return { position: value.position === null ? null : copyPosition(value.position), locked: value.locked };
  } catch { return fallback(); }
}

/** Never silently serialize NaN/Infinity as null or save a partial bad layout.
 * This deliberately throws for invalid in-memory input; storage error handling
 * belongs to the controller, not this pure data contract. */
export function serializeDirectoryLayout(layout: DirectoryLayout): string {
  if (!record(layout, ["position", "locked"]) || typeof layout.locked !== "boolean"
    || (layout.position !== null && !position(layout.position))) throw new TypeError("Invalid directory layout");
  return JSON.stringify({ version: VERSION, position: layout.position === null ? null : copyPosition(layout.position), locked: layout.locked });
}

/** JSON quoting makes every plugin-name string (including Unicode, control
 * characters and lone surrogates) an unambiguous suffix. No storage is accessed. */
export function directoryStorageKey(pluginName: string): string {
  return `ofn:ui:directory-layout:v1:${JSON.stringify(pluginName)}`;
}

export interface DirectoryGeometry {
  /** All dimensions below are rendered viewport pixels, before style conversion. */
  viewportWidth: number;
  viewportHeight: number;
  width: number;
  height: number;
  headbarBottom?: number;
  /** Visible header extent from the tool's top; defaults to at most 32 pixels. */
  headerHeight?: number;
  /** Default right-side clearance only; a manually placed tool may use the gutter. */
  defaultInset?: number;
}

function dimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(MAX_COORDINATE, value) : 0;
}
function nonnegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.min(MAX_COORDINATE, value) : fallback;
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Resolve a *display* position, without mutating/persisting the preferred one.
 * Full-fit bounds are used when possible. An oversized tool keeps its title
 * accessible below the headbar instead of being pulled up underneath it. Only
 * an impossibly short viewport relaxes headbar clearance to keep the title in
 * view; no geometry can satisfy both constraints in that case. */
export function resolveDirectoryPosition(preferred: DirectoryPosition | null, geometry: DirectoryGeometry): DirectoryPosition {
  const vw = dimension(geometry.viewportWidth), vh = dimension(geometry.viewportHeight);
  const width = dimension(geometry.width), height = dimension(geometry.height);
  const gx = Math.min(GUTTER, vw / 2), gy = Math.min(GUTTER, vh / 2);
  const minLeft = gx, maxLeft = Math.max(minLeft, vw - width - gx);
  const header = Math.min(height, nonnegative(geometry.headerHeight, Math.min(height, 32)));
  const headbar = nonnegative(geometry.headbarBottom, 42);
  const minTop = Math.min(Math.max(gy, headbar + HEADBAR_GAP), Math.max(0, vh - header - gy));
  const maxTop = Math.max(minTop, vh - height - gy);
  const inset = nonnegative(geometry.defaultInset, DEFAULT_INSET);
  // A live drag may extend past the viewport, unlike a persisted coordinate.
  const desired = preferred && Number.isFinite(preferred.left) && Number.isFinite(preferred.top)
    ? preferred : { left: vw - width - inset, top: minTop };
  return { left: clamp(desired.left, minLeft, maxLeft), top: clamp(desired.top, minTop, maxTop) };
}

/** The existing fixed-tool positioning model measures independent rendered/CSS
 * x/y ratios. Drag and saved positions remain in client pixels; divide once at
 * the final style boundary, never divide a pointer delta twice. */
export function directoryCssPosition(viewportPosition: DirectoryPosition, scaleX = 1, scaleY = 1): DirectoryPosition {
  const divide = (value: number, scale: number) => {
    const result = value / (Number.isFinite(scale) && scale > 0 ? scale : 1);
    return Number.isFinite(result) ? result : value;
  };
  return { left: divide(viewportPosition.left, scaleX), top: divide(viewportPosition.top, scaleY) };
}
