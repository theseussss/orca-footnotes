import type { Block, DbId } from "../../vendor/orca";
import { readNativeNoteTree, type NativeNoteNode } from "./native-note-tree";
import { ITEM_PROPERTY } from "./types";

type ReadonlyData<T> = T extends Date ? Date : T extends readonly (infer V)[] ? readonly ReadonlyData<V>[]
  : T extends object ? { readonly [K in keyof T]: ReadonlyData<T[K]> } : T;
export type NativeSnapshotBlock = ReadonlyData<Block> & Readonly<Record<string, unknown>>;
export interface NativeNoteSnapshot {
  readonly version: 1;
  readonly rootId: DbId;
  /** Detached complete canonical preorder. Dates are detached, not immutable. */
  readonly blocks: readonly NativeSnapshotBlock[];
}
export interface NativeSnapshotLimits {
  readonly maxDepth: number;
  readonly maxValues: number;
  readonly maxEntries: number;
  readonly maxArraySlots: number;
  readonly maxStringCodeUnits: number;
  readonly maxRows: number;
}
/** Limits may only be lowered. Exceeding any limit throws; nothing is truncated. */
export const NATIVE_SNAPSHOT_LIMITS: NativeSnapshotLimits = Object.freeze({
  maxDepth: 96, maxValues: 100_000, maxEntries: 100_000, maxArraySlots: 100_000,
  maxStringCodeUnits: 8_000_000, maxRows: 20_000,
});
type Options = Partial<NativeSnapshotLimits>;
type NumberWire = number | "-0" | "NaN" | "+Infinity" | "-Infinity";
/** Descriptor flags: enumerable=1, writable=2, configurable=4. */
type Entry = [string, ValueWire, number];
type ValueWire = ["undefined"] | ["null"] | ["boolean", boolean] | ["string", string]
  | ["number", NumberWire] | ["object", "plain" | "null", Entry[]]
  | ["array", number, boolean, Entry[]] | ["date", number | "invalid", Entry[]];
/** Tuples only: duplicate object keys in a JSON parser cannot hide wire fields. */
export type NativeNoteSnapshotWire = ["orca-footnotes.native-note-snapshot", 1, number | "-0", ValueWire[]];
const FORMAT = "orca-footnotes.native-note-snapshot" as const;
const fail = (message: string): never => { throw new TypeError(`Native snapshot: ${message}`); };
const isId = (value: unknown): value is DbId => Number.isSafeInteger(value);
const own = (object: object, key: string): unknown => {
  const d = Object.getOwnPropertyDescriptor(object, key);
  if (!d) return undefined;
  if (!("value" in d)) return fail(`accessor is unsupported (${key})`);
  return d.value;
};
function flags(d: PropertyDescriptor): number {
  return (d.enumerable ? 1 : 0) | (d.writable ? 2 : 0) | (d.configurable ? 4 : 0);
}
function define(object: object, key: string, value: unknown, bits: number): void {
  Object.defineProperty(object, key, { value, enumerable: !!(bits & 1), writable: !!(bits & 2), configurable: !!(bits & 4) });
}
class Budget {
  readonly limits: NativeSnapshotLimits;
  private values = 0;
  private entries = 0;
  private arraySlots = 0;
  private strings = 0;
  constructor(options: Options = {}) {
    const result = { ...NATIVE_SNAPSHOT_LIMITS };
    for (const key of Reflect.ownKeys(options)) {
      if (typeof key !== "string" || !Object.hasOwn(result, key)) fail("unknown resource limit");
      const value = own(options, key as string), name = key as keyof NativeSnapshotLimits;
      if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > result[name]) fail(`invalid resource limit ${String(key)}`);
      result[name] = value as number;
    }
    this.limits = result;
  }
  node(depth: number): void {
    if (depth > this.limits.maxDepth || ++this.values > this.limits.maxValues) fail("depth/value resource limit exceeded");
  }
  countEntries(count: number): void {
    this.entries += count;
    if (this.entries > this.limits.maxEntries) fail("entry resource limit exceeded");
  }
  string(value: string): void {
    this.strings += value.length;
    if (this.strings > this.limits.maxStringCodeUnits) fail("string resource limit exceeded");
  }
  rows(count: number): void { if (count > this.limits.maxRows) fail("row resource limit exceeded"); }
  slots(count: number): void {
    this.arraySlots += count;
    if (this.arraySlots > this.limits.maxArraySlots) fail("array slot resource limit exceeded");
  }
}
function keys(object: object, budget: Budget): string[] {
  // Array length is encoded in the tuple header, not an own data entry. Count
  // the same logical entries/strings as unpack(), including sparse arrays.
  const result = Reflect.ownKeys(object).filter(key => !(Array.isArray(object) && key === "length"));
  budget.countEntries(result.length);
  return result.map(key => {
    if (typeof key !== "string") return fail("symbol keys are unsupported");
    budget.string(key);
    return key;
  });
}
function numberWire(value: number): NumberWire {
  return Object.is(value, -0) ? "-0" : Number.isNaN(value) ? "NaN" : value === Infinity ? "+Infinity" : value === -Infinity ? "-Infinity" : value;
}
function unpackNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (value === "-0") return -0;
  if (value === "NaN") return NaN;
  if (value === "+Infinity") return Infinity;
  if (value === "-Infinity") return -Infinity;
  return fail("invalid number tag");
}
function pack(value: unknown, budget: Budget, depth = 0, ancestors = new Set<object>()): ValueWire {
  budget.node(depth);
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") return ["number", numberWire(value)];
  if (typeof value === "string") { budget.string(value); return ["string", value]; }
  if (typeof value !== "object") return fail(`unsupported value type ${typeof value}`);
  if (ancestors.has(value)) return fail("cyclic value graph");
  const proto = Object.getPrototypeOf(value);
  const array = Array.isArray(value), date = proto === Date.prototype;
  if (!(array ? proto === Array.prototype : date || proto === Object.prototype || proto === null)) return fail("custom object/prototype is unsupported");
  ancestors.add(value);
  try {
    const entries: Entry[] = [];
    let length = 0, lengthWritable = true, time: number | "invalid" = "invalid";
    if (array) {
      length = own(value, "length") as number;
      if (!Number.isSafeInteger(length) || length < 0 || length > budget.limits.maxEntries) fail("array length resource limit exceeded");
      budget.slots(length);
      lengthWritable = !!Object.getOwnPropertyDescriptor(value, "length")!.writable;
    } else if (date) {
      try { const n = Date.prototype.getTime.call(value); time = Number.isNaN(n) ? "invalid" : n; }
      catch { return fail("unreadable Date object (including a Date proxy)"); }
    }
    for (const key of keys(value, budget)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !("value" in d)) fail(`accessor or unstable own property (${key})`);
      if (array && key === "length") continue;
      entries.push([key, pack(d!.value, budget, depth + 1, ancestors), flags(d!)]);
    }
    return array ? ["array", length, lengthWritable, entries] : date ? ["date", time, entries] : ["object", proto === null ? "null" : "plain", entries];
  } finally { ancestors.delete(value); }
}
/** Strict dense wire tuples: no extra own fields, holes, symbols, or accessors. */
function tuple(value: unknown, size?: number, max = 100_000): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail("wire must contain ordinary arrays");
  const length = own(value, "length") as number;
  if (!Number.isSafeInteger(length) || length < 0 || length > max || (size !== undefined && length !== size)) fail("invalid wire tuple length");
  const ks = Reflect.ownKeys(value);
  if (ks.length !== length + 1) fail("extra or missing wire tuple field");
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !("value" in d) || !d.enumerable) fail("sparse/accessor wire tuple");
    result.push(d!.value);
  }
  return result;
}
function arrayIndex(key: string): number | undefined {
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n < 0xffff_ffff && String(n) === key ? n : undefined;
}
function unpack(value: unknown, budget: Budget, depth = 0, ancestors = new Set<object>()): unknown {
  budget.node(depth);
  const node = tuple(value, undefined, 4);
  if (ancestors.has(value as object)) fail("cyclic wire");
  ancestors.add(value as object);
  try {
    const [tag, arg] = node;
    if (tag === "undefined" || tag === "null") { if (node.length !== 1) fail("invalid unit tag"); return tag === "null" ? null : undefined; }
    if (tag === "boolean" || tag === "string" || tag === "number") {
      if (node.length !== 2) fail("invalid primitive tuple");
      if (tag === "number") return unpackNumber(arg);
      if (typeof arg !== tag) fail("primitive type mismatch");
      if (typeof arg === "string") budget.string(arg);
      return arg;
    }
    let output: object, rawEntries: unknown;
    if (tag === "object") {
      if (node.length !== 3 || (arg !== "plain" && arg !== "null")) fail("invalid object tag");
      output = arg === "null" ? Object.create(null) : {}; rawEntries = node[2];
    } else if (tag === "array") {
      if (node.length !== 4 || !Number.isSafeInteger(arg) || (arg as number) < 0 || (arg as number) > budget.limits.maxEntries || typeof node[2] !== "boolean") fail("invalid array tag/length resource limit");
      budget.slots(arg as number); // Aggregate BEFORE allocating, not per array only.
      output = new Array(arg as number); rawEntries = node[3];
    } else if (tag === "date") {
      if (node.length !== 3 || !(arg === "invalid" || (typeof arg === "number" && Number.isInteger(arg) && !Object.is(arg, -0) && Math.abs(arg) <= 8_640_000_000_000_000))) fail("invalid Date tag");
      output = new Date(arg === "invalid" ? NaN : arg as number); rawEntries = node[2];
    } else return fail("unknown value tag");
    const entries = tuple(rawEntries, undefined, budget.limits.maxEntries);
    budget.countEntries(entries.length);
    const seen = new Set<string>();
    for (const raw of entries) {
      const [key, child, bits] = tuple(raw, 3);
      if (typeof key !== "string" || seen.has(key) || !Number.isInteger(bits) || (bits as number) < 0 || (bits as number) > 7) fail("invalid/duplicate object entry");
      const name = key as string; budget.string(name); seen.add(name);
      if (tag === "array" && (name === "length" || (arrayIndex(name) !== undefined && arrayIndex(name)! >= (arg as number)))) fail("array entry exceeds declared length");
      define(output, name, unpack(child, budget, depth + 1, ancestors), bits as number);
    }
    if (tag === "array") Object.defineProperty(output, "length", { writable: node[2] as boolean });
    return output;
  } finally { ancestors.delete(value as object); }
}
function dense(value: unknown, budget: Budget): unknown[] {
  if (!Array.isArray(value)) return fail("native field must be an array");
  const length = own(value, "length") as number;
  if (!Number.isSafeInteger(length) || length < 0 || length > budget.limits.maxEntries) fail("array length resource limit exceeded");
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(value, String(i))) fail("sparse native structural field");
    result.push(own(value, String(i)));
  }
  return result;
}
function structural(row: unknown, budget: Budget): NativeNoteNode {
  if (row === null || typeof row !== "object") return fail("invalid block");
  const id = own(row, "id"), parent = own(row, "parent"), children = dense(own(row, "children"), budget);
  if (!isId(id) || (parent !== undefined && parent !== null && !isId(parent)) || !children.every(isId)) fail("invalid block identity/parent/children");
  budget.countEntries(children.length);
  return { id: id as DbId, parent: parent as DbId | null | undefined, children: children as DbId[] };
}
function block(value: unknown, budget: Budget): NativeSnapshotBlock {
  structural(value, budget);
  const row = value as Record<string, unknown>;
  for (const key of ["aliases", "properties", "refs", "backRefs"]) dense(own(row, key), budget);
  for (const key of ["created", "modified"]) if (!(own(row, key) instanceof Date)) fail(`missing native Date ${key}`);
  if (own(row, "left") !== undefined && own(row, "left") !== null && !isId(own(row, "left"))) fail("invalid left identity");
  // Native empty-paragraph commands may return null rather than an omitted
  // field. Preserve that payload exactly; do not replace it with [] or "".
  if (own(row, "content") != null) dense(own(row, "content"), budget);
  if (own(row, "text") != null && typeof own(row, "text") !== "string") fail("invalid derived text");
  return row as NativeSnapshotBlock;
}
function finish(rootId: DbId, values: readonly unknown[], budget: Budget): NativeNoteSnapshot {
  budget.rows(values.length);
  const blocks = values.map(value => block(value, budget));
  const tree = readNativeNoteTree(rootId, blocks);
  if (tree.ids.length !== blocks.length || tree.ids.some((id, index) => blocks[index].id !== id)) fail("wire/snapshot must contain exactly the canonical preorder, without foreign blocks");
  return Object.freeze({ version: 1, rootId, blocks: Object.freeze(blocks) });
}
/** Read only: no converter, reference traversal, adoption, DB call, or source
 * mutation. Accepts ordinary Valtio object/array proxies via data descriptors,
 * never structuredClone(proxy). All own data fields (even non-enumerable) survive.
 * Supported values: primitives except bigint/symbol, plain/null-prototype objects,
 * arrays (including holes/extra fields), and Dates with own data fields. Custom
 * prototypes/functions/accessors/cycles fail. Shared values are copied per
 * occurrence: JS pointer identity and extensibility are not persistent data.
 * A synchronous read is NOT an atomic Store snapshot or ownership proof. */
export function captureNativeNoteSnapshot(rootId: DbId, rows: Iterable<Readonly<Block>>, options?: Options): NativeNoteSnapshot {
  const budget = new Budget(options), source = new Map<DbId, Readonly<Block>>(), structure: NativeNoteNode[] = [];
  for (const row of rows) {
    budget.rows(structure.length + 1);
    const node = structural(row, budget);
    if (source.has(node.id)) fail("duplicate block identity");
    source.set(node.id, row); structure.push(node);
  }
  const tree = readNativeNoteTree(rootId, structure);
  const values = tree.ids.map(id => unpack(pack(source.get(id), budget), new Budget(options)));
  return finish(rootId, values, budget);
}
/** JSON.stringify(encode(...)) is safe without invoking native toJSON methods.
 * The returned tuples contain only JSON-safe primitives/arrays. */
export function encodeNativeNoteSnapshot(snapshot: NativeNoteSnapshot, options?: Options): NativeNoteSnapshotWire {
  const budget = new Budget(options);
  if (snapshot === null || typeof snapshot !== "object") return fail("invalid snapshot envelope");
  const ks = Reflect.ownKeys(snapshot);
  if (ks.length !== 3 || !["version", "rootId", "blocks"].every(key => ks.includes(key)) || own(snapshot, "version") !== 1) fail("invalid snapshot envelope");
  const rootId = own(snapshot, "rootId");
  if (!isId(rootId)) fail("invalid snapshot root identity");
  const values = dense(own(snapshot, "blocks"), budget); budget.rows(values.length);
  const packed = values.map(value => pack(value, budget));
  finish(rootId as DbId, packed.map(value => unpack(value, new Budget(options))), budget);
  return [FORMAT, 1, numberWire(rootId as DbId) as number | "-0", packed];
}
/** Accepts a parsed tuple wire, NOT JSON source text. Parsing/file-size limits
 * belong to the caller. Strict validation rejects unknown versions/tags/fields,
 * duplicate entries, invalid structural ownership, and non-preorder/foreign rows. */
export function decodeNativeNoteSnapshot(wire: unknown, options?: Options): NativeNoteSnapshot {
  const budget = new Budget(options), envelope = tuple(wire, 4);
  if (envelope[0] !== FORMAT || envelope[1] !== 1) fail("invalid snapshot wire envelope");
  const rootId = unpackNumber(envelope[2]);
  if (!isId(rootId)) fail("invalid snapshot wire root identity");
  const rows = tuple(envelope[3], undefined, budget.limits.maxRows);
  budget.rows(rows.length);
  return finish(rootId, rows.map(value => unpack(value, budget)), budget);
}
const DERIVED = new Set(["created", "modified", "text", "backRefs"]);
/** Only these KNOWN root metadata keys are checkpoints. Unknown semantic fields
 * in the property wrapper/value remain conservative signature inputs. */
const CHECKPOINT = new Set(["version", "ownerRootId", "revision", "comment", "state", "createdAt", "updatedAt", "recycledAt", "archivedAt", "contentStamp"]);
function objectEntry(value: ValueWire, key: string): ValueWire | undefined {
  return value[0] === "object" ? value[2].find(entry => entry[0] === key)?.[1] : undefined;
}
function canonical(value: ValueWire, context: "block" | "root" | "root-properties" | "root-property" | "checkpoint" | "value" = "value"): unknown {
  if (value[0] === "object") {
    const annotation = context === "root-property" && objectEntry(value, "name")?.[0] === "string"
      && (objectEntry(value, "name") as ["string", string])[1] === ITEM_PROPERTY;
    return ["object", value[1], value[2].filter(([key]) => !((context === "block" || context === "root") && DERIVED.has(key))
      && !(context === "checkpoint" && CHECKPOINT.has(key)))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonical(child, context === "root" && key === "properties" ? "root-properties"
        : annotation && key === "value" ? "checkpoint" : "value")])];
  }
  if (value[0] === "array") return ["array", value[1], [...value[3]].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => [key, canonical(child, context === "root-properties" && arrayIndex(key) !== undefined ? "root-property" : "value")])];
  if (value[0] === "date") return ["date", value[1], [...value[2]].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])];
  return value;
}
/** Deterministic string, NOT a cryptographic hash, CAS, write permission,
 * migration, recovery, or cross-ID equivalence. IDs/left links/outgoing ref IDs
 * and r.v are retained verbatim; new identities require caller-owned remapping
 * and source-owned ref reconstruction. Check revision/comment/state/owner etc.
 * separately. Object key order/descriptor flags are not content; array order is.
 * Only block-level derived fields and known root ITEM_PROPERTY checkpoint keys
 * are excluded; nested Dates/text/backRefs or unknown fields remain semantic. */
export function nativeContentSignature(snapshot: NativeNoteSnapshot, options?: Options): string {
  const wire = encodeNativeNoteSnapshot(snapshot, options);
  return JSON.stringify(["orca-footnotes.native-content-signature", 1, wire[2], wire[3].map((row, i) => canonical(row, i === 0 ? "root" : "block"))]);
}
