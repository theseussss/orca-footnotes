import type { DbId } from "../../vendor/orca";

/** Canonical structural data only. A mirror instance must be resolved by the
 * native adapter BEFORE it reaches this module. This does not create/adopt a
 * note, follow mirror targets, flatten content, or implement editor traversal. */
export interface NativeNoteNode {
  readonly id: DbId;
  readonly parent?: DbId | null;
  readonly children: readonly DbId[];
}
export interface NativeNoteTree {
  readonly rootId: DbId;
  /** Complete structural preorder, not a visible/folded editor ordering. */
  readonly ids: readonly DbId[];
  has(id: DbId): boolean;
  /** Only parents INSIDE this note are returned; Store is never an edit parent. */
  parentOf(id: DbId): DbId | undefined;
  childrenOf(id: DbId): readonly DbId[];
}
const validId = (value: unknown): value is DbId => Number.isSafeInteger(value);

/** A read-only, detached structural fence. Caller separately verifies that
 * rootId is an owned canonical annotation in the right repository/catalog.
 * Missing/cyclic/ambiguous trees fail closed; no partial tree is returned. */
export function readNativeNoteTree(rootId: DbId, rows: Iterable<NativeNoteNode>): NativeNoteTree {
  if (!validId(rootId)) throw new Error("注释边界的根身份无效。");
  const source = new Map<DbId, NativeNoteNode>();
  for (const row of rows) {
    if (!validId(row.id) || source.has(row.id)) throw new Error("注释边界包含无效或重复的块身份。");
    source.set(row.id, row);
  }
  if (!source.has(rootId)) throw new Error("注释边界根块缺失。");
  const parents = new Map<DbId, DbId>(), children = new Map<DbId, readonly DbId[]>(), ids: DbId[] = [];
  const work: { id: DbId; parent?: DbId }[] = [{ id: rootId }], seen = new Set<DbId>();
  while (work.length) {
    const entry = work.pop()!;
    if (seen.has(entry.id)) throw new Error("注释子树发生重复或循环，未扩大编辑边界。");
    const row = source.get(entry.id);
    if (!row || !Array.isArray(row.children)) throw new Error("注释子树不完整，未使用部分内容作为编辑边界。");
    if (entry.parent !== undefined && row.parent !== entry.parent) throw new Error("注释子块的归属已变化。");
    if (!row.children.every(validId) || new Set(row.children).size !== row.children.length) throw new Error("注释子块顺序损坏，未自动整理。");
    seen.add(entry.id); ids.push(entry.id);
    if (entry.parent !== undefined) parents.set(entry.id, entry.parent);
    const copied = Object.freeze([...row.children]); children.set(entry.id, copied);
    for (let i = copied.length - 1; i >= 0; i--) work.push({ id: copied[i], parent: entry.id });
  }
  const rootParent = source.get(rootId)!.parent;
  if (rootParent !== undefined && rootParent !== null && seen.has(rootParent))
    throw new Error("注释根的归属形成自身子树循环。");
  // Also check the supplied reverse links. An omitted child whose known parent
  // is inside N is incomplete data, not permission to silently shrink N.
  for (const row of source.values()) if (row.id !== rootId && row.parent !== undefined && row.parent !== null
    && seen.has(row.parent) && !children.get(row.parent)?.includes(row.id))
    throw new Error("注释子树的反向归属不完整，未自动收养遗漏内容。");
  const ordered = Object.freeze(ids);
  return Object.freeze({ rootId, ids: ordered,
    has: (id: DbId) => seen.has(id),
    parentOf: (id: DbId) => parents.get(id),
    childrenOf: (id: DbId) => {
      const result = children.get(id);
      if (!result) throw new Error("目标块不属于当前注释。");
      return result;
    },
  });
}

export type NativeNoteSelectionScope =
  | { readonly kind: "body" }
  | { readonly kind: "note"; readonly rootId: DbId }
  | { readonly kind: "cross-boundary"; readonly roots: readonly DbId[] }
  | { readonly kind: "unresolved" };

/** Endpoint IDs alone cannot prove a range is body-only: a range whose two
 * endpoints are outside notes can still pass through one. The native DOM
 * adapter must provide ALL managed note roots actually intersected by Range.
 * A "note" result proves canonical membership only: the adapter must ALSO
 * prove one leased physical editor/mirror instance (two mirrors of one note
 * must not become one destructive range). This never authorizes a write,
 * changes Selection, or dispatches keys. */
export function nativeNoteSelectionScope(trees: readonly NativeNoteTree[], selection: {
  readonly anchorCanonicalId: DbId | null;
  readonly focusCanonicalId: DbId | null;
  readonly intersectedNoteRoots: readonly DbId[];
}): NativeNoteSelectionScope {
  const { anchorCanonicalId: anchor, focusCanonicalId: focus, intersectedNoteRoots } = selection;
  if (!validId(anchor) || !validId(focus) || !Array.isArray(intersectedNoteRoots) || !intersectedNoteRoots.every(validId)) return { kind: "unresolved" };
  const roots = new Map<DbId, NativeNoteTree>();
  for (const tree of trees) {
    if (roots.has(tree.rootId)) return { kind: "unresolved" };
    roots.set(tree.rootId, tree);
  }
  if (intersectedNoteRoots.some(id => !roots.has(id))) return { kind: "unresolved" };
  const anchorOwners = trees.filter(tree => tree.has(anchor)), focusOwners = trees.filter(tree => tree.has(focus));
  if (anchorOwners.length > 1 || focusOwners.length > 1) return { kind: "unresolved" };
  const touched = new Set(intersectedNoteRoots);
  for (const tree of [...anchorOwners, ...focusOwners]) touched.add(tree.rootId);
  if (!touched.size) return { kind: "body" };
  if (touched.size === 1 && anchorOwners.length === 1 && focusOwners.length === 1 && anchorOwners[0].rootId === focusOwners[0].rootId)
    return { kind: "note", rootId: anchorOwners[0].rootId };
  return { kind: "cross-boundary", roots: Object.freeze([...touched]) };
}

/** Generic native deletion must never remove the stable annotation identity.
 * Removing a whole annotation is a separate, confirmed repository operation.
 * This is not a command authorization/CAS or an undo implementation. */
export function assertNativeNoteChildRemoval(tree: NativeNoteTree, ids: readonly DbId[]): void {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
    || ids.some(id => !validId(id) || id === tree.rootId || !tree.has(id))) throw new Error("此删除超出当前注释的内部内容边界。");
}
