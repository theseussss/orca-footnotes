import type { DbId } from "../../vendor/orca";

/** Normalized prototype inputs, not a persistence format or an Orca backend adapter.
 * The caller supplies a complete body snapshot for the reference counts it claims.
 * Annotation storage blocks must not be included in this body tree.
 */
export interface BodyReference { readonly targetId: DbId; readonly fragmentIndex: number }
export interface BodyBlock {
  readonly id: DbId;
  readonly parent?: DbId | null;
  readonly children: readonly DbId[];
  readonly references: readonly BodyReference[];
  readonly folded?: boolean;
}
export type AnnotationState = "active" | "recycled" | "archived";
export interface AnnotationItem {
  readonly id: DbId;
  /** Original body owner, not the physical storage block's parent. */
  readonly ownerRootId: DbId;
  readonly text: string;
  readonly comment: string;
  readonly state: AnnotationState;
}
export interface ScopeResolution {
  readonly viewRootId: DbId;
  readonly rootId: DbId;
  readonly configured: boolean;
  readonly inherited: boolean;
}
export interface Occurrence extends BodyReference {
  readonly blockId: DbId;
  readonly key: string;
  readonly number?: number;
}
export interface ReferencedEntry {
  readonly item: AnnotationItem;
  readonly number: number;
  readonly references: readonly Occurrence[];
}
export interface ProjectionIssue {
  readonly kind: "missing-item" | "inactive-item";
  readonly blockId: DbId;
  readonly fragmentIndex: number;
  readonly targetId: DbId;
}
export interface AnnotationProjection {
  readonly scope: ScopeResolution;
  readonly bodyIds: readonly DbId[];
  readonly entries: readonly ReferencedEntry[];
  readonly candidates: readonly AnnotationItem[];
  /** Owned here, but used outside this projection: not a zero-reference candidate. */
  readonly usedElsewhere: readonly AnnotationItem[];
  readonly occurrences: readonly Occurrence[];
  readonly issues: readonly ProjectionIssue[];
}
export interface ProjectionInput {
  readonly viewRootId: DbId;
  readonly blocks: readonly BodyBlock[];
  readonly items: readonly AnnotationItem[];
  readonly configuredRoots?: ReadonlySet<DbId>;
}
function keyed<T extends { readonly id: DbId }>(rows: readonly T[], name: string): Map<DbId, T> {
  const map = new Map<DbId, T>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.id) || map.has(row.id)) throw new Error(`Invalid or duplicate ${name} ID: ${row.id}`);
    map.set(row.id, row);
  }
  return map;
}
function ancestors(id: DbId, blocks: ReadonlyMap<DbId, BodyBlock>): DbId[] {
  const chain: DbId[] = [], seen = new Set<DbId>();
  let current: DbId | null | undefined = id;
  while (current != null) {
    if (seen.has(current)) throw new Error("Cyclic body ancestry");
    seen.add(current);
    const block = blocks.get(current);
    if (!block) throw new Error(`Missing body ancestor: ${current}`);
    chain.push(current); current = block.parent;
  }
  return chain;
}
/** Current candidate engineering default: nearest explicit ancestor wins.
 * The controller supplies explicit-root configuration; nested overrides and page
 * moves still need UX/live-host validation, not a claim of finalized semantics.
 */
export function resolveScope(viewRootId: DbId, rows: readonly BodyBlock[], configuredRoots: ReadonlySet<DbId> = new Set()): ScopeResolution {
  const blocks = keyed(rows, "body");
  const chain = ancestors(viewRootId, blocks);
  for (const root of configuredRoots) if (!blocks.has(root)) throw new Error(`Missing configured scope root: ${root}`);
  const selected = chain.find((id) => configuredRoots.has(id));
  return { viewRootId, rootId: selected ?? viewRootId, configured: selected != null,
    inherited: selected != null && selected !== viewRootId };
}
function orderedSubtree(rootId: DbId, blocks: ReadonlyMap<DbId, BodyBlock>): BodyBlock[] {
  const result: BodyBlock[] = [], seen = new Set<DbId>();
  const stack: Array<{ id: DbId; parent?: DbId }> = [{ id: rootId }];
  while (stack.length) {
    const { id, parent } = stack.pop()!;
    if (seen.has(id)) throw new Error(`Repeated or cyclic body child: ${id}`);
    seen.add(id);
    const block = blocks.get(id);
    if (!block) throw new Error(`Missing body child: ${id}`);
    if (parent != null && block.parent !== parent) throw new Error(`Inconsistent body parent: ${id}`);
    result.push(block);
    for (let i = block.children.length - 1; i >= 0; i--) stack.push({ id: block.children[i], parent: id });
  }
  return result;
}
function orderedReferences(block: BodyBlock): BodyReference[] {
  const result = [...block.references].sort((a, b) => a.fragmentIndex - b.fragmentIndex);
  const seen = new Set<number>();
  for (const ref of result) {
    if (!Number.isSafeInteger(ref.fragmentIndex) || ref.fragmentIndex < 0 || seen.has(ref.fragmentIndex)
      || !Number.isSafeInteger(ref.targetId)) throw new Error(`Invalid normalized reference in block ${block.id}`);
    seen.add(ref.fragmentIndex);
  }
  return result;
}
/** Derives one shared root's FULL list and numbering, not a child-page filter.
 * Pure: no model/DOM edits, no Markdown rewriting, no navigation or persistence.
 * Global candidate counts are only as complete as the supplied body snapshot.
 */
export function projectAnnotations(input: ProjectionInput): AnnotationProjection {
  const blocks = keyed(input.blocks, "body"), items = keyed(input.items, "annotation");
  const scope = resolveScope(input.viewRootId, input.blocks, input.configuredRoots);
  const body = orderedSubtree(scope.rootId, blocks), bodyIds = body.map((block) => block.id);
  const ownedHere = new Set(bodyIds), totalCounts = new Map<DbId, number>();
  for (const block of input.blocks) for (const ref of orderedReferences(block)) {
    totalCounts.set(ref.targetId, (totalCounts.get(ref.targetId) ?? 0) + 1);
  }
  const entries = new Map<DbId, { item: AnnotationItem; number: number; references: Occurrence[] }>();
  const occurrences: Occurrence[] = [], issues: ProjectionIssue[] = [];
  for (const block of body) for (const ref of orderedReferences(block)) {
    const item = items.get(ref.targetId);
    let entry = entries.get(ref.targetId);
    if (!item || item.state !== "active") {
      issues.push({ kind: item ? "inactive-item" : "missing-item", blockId: block.id,
        fragmentIndex: ref.fragmentIndex, targetId: ref.targetId });
    } else if (!entry) {
      entry = { item, number: entries.size + 1, references: [] }; entries.set(item.id, entry);
    }
    const occurrence: Occurrence = { ...ref, blockId: block.id, key: `${block.id}:${ref.fragmentIndex}`,
      ...(entry ? { number: entry.number } : {}) };
    occurrences.push(occurrence); entry?.references.push(occurrence);
  }
  const candidates: AnnotationItem[] = [], usedElsewhere: AnnotationItem[] = [];
  for (const item of input.items) if (item.state === "active" && ownedHere.has(item.ownerRootId) && !entries.has(item.id)) {
    if ((totalCounts.get(item.id) ?? 0) === 0) candidates.push(item);
    else usedElsewhere.push(item);
  }
  // Candidate ordering is an engineering default only; numbering never uses it.
  candidates.sort((a, b) => a.id - b.id); usedElsewhere.sort((a, b) => a.id - b.id);
  return { scope, bodyIds, entries: [...entries.values()], candidates, usedElsewhere, occurrences, issues };
}

/** Read-only selector snippets: truncate around the marker, never expose the full
 * block merely because one reference is selected. maxLength counts Unicode codepoints.
 */
export function referenceExcerpt(before: string, marker: string, after: string, maxLength: number): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) throw new Error("Excerpt length must be a positive integer");
  const left = Array.from(before), mid = Array.from(marker), right = Array.from(after);
  if (left.length + mid.length + right.length <= maxLength) return before + marker + after;
  if (maxLength < mid.length) throw new Error("Excerpt length cannot be shorter than its reference marker");
  // Reserve ellipses only for sides that actually omit text, retaining the whole marker.
  let l = Math.min(left.length, Math.floor((maxLength - mid.length) / 2));
  let r = Math.min(right.length, maxLength - mid.length - l);
  l = Math.min(left.length, maxLength - mid.length - r);
  while (l + r + mid.length + Number(l < left.length) + Number(r < right.length) > maxLength) {
    if (l >= r && l > 0) l--; else if (r > 0) r--; else break;
  }
  // Very small budgets keep the complete marker; ellipses are lower priority.
  let prefix = l < left.length ? "…" : "", suffix = r < right.length ? "…" : "";
  if (prefix.length + suffix.length + mid.length + l + r > maxLength) { prefix = ""; suffix = ""; }
  return prefix + left.slice(left.length - l).join("") + marker + right.slice(0, r).join("") + suffix;
}
