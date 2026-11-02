import type { Block, ContentFragment, DbId } from "../../vendor/orca";

/** Footnotes are ordinary native blocks carrying the footnote tag. The body cites
 * them with native inline references in our superscript format. A page's footer
 * section is a real block at the end of that page; recycle/archive are pages. */
export const NOTE_FORMAT = "ofn-vnext-note";
export const SECTION_REPR = "orca-footnotes.section";
export const SECTION_PROPERTY = "orca-footnotes.section";
export const STATE_PROPERTY = "orca-footnotes.state";
/** Where an entry was created/collected: the view root whose footer shows it while uncited. */
export const OWNER_PROPERTY = "orca-footnotes.owner";
export const DEFAULT_TAG = "尾注";
export const REF_INLINE = 1;
export const REF_PROPERTY = 2;
export const REF_MIRROR = 5;
export type SectionKind = "footer" | "store" | "recycle" | "archive";
export type EntryState = "active" | "recycled" | "archived";
export interface StateMarker { readonly state: "recycled" | "archived"; readonly at: number; readonly homeId?: DbId }
type Readable = Pick<Block, "id" | "properties"> & Partial<Pick<Block, "refs" | "content" | "parent" | "children" | "text">>;

export function property(block: Pick<Block, "properties"> | undefined, name: string): any {
  return block?.properties?.find(item => item.name === name)?.value;
}
export function reprType(block: Pick<Block, "properties"> | undefined): unknown { return property(block, "_repr")?.type; }
export function sectionKind(block: Pick<Block, "properties"> | undefined): SectionKind | undefined {
  if (reprType(block) !== SECTION_REPR) return;
  const kind = property(block, SECTION_PROPERTY)?.kind;
  return kind === "footer" || kind === "store" || kind === "recycle" || kind === "archive" ? kind : undefined;
}
export function stateOf(block: Pick<Block, "properties"> | undefined): EntryState {
  const value = property(block, STATE_PROPERTY)?.state;
  return value === "recycled" || value === "archived" ? value : "active";
}
export function stateMarker(block: Pick<Block, "properties"> | undefined): StateMarker | undefined {
  const value = property(block, STATE_PROPERTY);
  return value && (value.state === "recycled" || value.state === "archived") && Number.isFinite(value.at) ? value : undefined;
}
export function isMirror(block: Pick<Block, "properties"> | undefined): boolean { return reprType(block) === "mirror"; }
export function mirroredId(block: Pick<Block, "properties"> | undefined): DbId | undefined {
  const id = property(block, "_repr")?.mirroredId;
  return Number.isSafeInteger(id) ? id : undefined;
}
export function isNoteFragment(fragment: ContentFragment): boolean {
  return fragment.t === "r" && typeof fragment.f === "string" && fragment.f.split("+").includes(NOTE_FORMAT);
}
export function noteFragment(relationId: DbId): ContentFragment { return { t: "r", v: relationId, f: `sup+${NOTE_FORMAT}` }; }
/** Superscript references of one body block, in fragment order. A relation that
 * no longer resolves is skipped, never guessed. */
export function noteReferences(block: Readable): { targetId: DbId; fragmentIndex: number; relationId: DbId }[] {
  const out: { targetId: DbId; fragmentIndex: number; relationId: DbId }[] = [];
  for (const [fragmentIndex, fragment] of (block.content ?? []).entries()) {
    if (!isNoteFragment(fragment)) continue;
    const relation = block.refs?.find(ref => ref.id === fragment.v && ref.from === block.id && ref.type === REF_INLINE);
    if (relation && Number.isSafeInteger(relation.to)) out.push({ targetId: relation.to, fragmentIndex, relationId: relation.id });
  }
  return out;
}
/** Display text of an entry: its own inline text only. Tag pills are not text;
 * children (comments, further paragraphs) are shown natively in the footer. */
export function entryText(block: (Pick<Block, "content" | "text"> & Partial<Pick<Block, "refs">>) | undefined, resolve?: (id: DbId) => string | undefined): string {
  if (!block) return "";
  // A reference inside an entry (e.g. to cited material) reads as its target's name.
  if (Array.isArray(block.content)) return block.content.map(fragment => {
    if (fragment.t === "t" || fragment.t === "l") return String(fragment.v ?? "");
    if (fragment.t !== "r" || !resolve || isNoteFragment(fragment)) return "";
    const to = block.refs?.find(ref => ref.id === fragment.v)?.to; return to != null ? resolve(to) ?? "" : "";
  }).join("").trim();
  return (block.text ?? "").replace(/\s+#\S+/g, "").trim();
}
export function hasTag(block: Pick<Block, "refs"> | undefined, tagId: DbId | undefined): boolean {
  return tagId != null && !!block?.refs?.some(ref => ref.to === tagId && ref.type === REF_PROPERTY);
}
export function ownerOf(block: Pick<Block, "properties"> | undefined): DbId | undefined {
  const owner = property(block, OWNER_PROPERTY)?.owner; return Number.isSafeInteger(owner) ? owner : undefined;
}
/** "Ctrl + Alt + F" -> "alt+ctrl+f", the form Orca keeps in its keymap. */
export function normalizeShortcut(raw: string): string {
  const alias: Record<string, string> = { control: "ctrl", ctl: "ctrl", option: "alt", opt: "alt", cmd: "meta", command: "meta", win: "meta", super: "meta" };
  const parts = raw.toLowerCase().split("+").map(part => part.trim()).filter(Boolean).map(part => alias[part] ?? part);
  const order = ["alt", "ctrl", "meta", "shift"], mods = order.filter(mod => parts.includes(mod)), keys = parts.filter(part => !order.includes(part));
  return keys.length === 1 ? [...mods, keys[0]].join("+") : "";
}
/** Typed citation text as block content: web addresses and DOIs become native
 * links (a DOI opens at doi.org); everything else stays as typed. */
export function citationFragments(text: string): ContentFragment[] {
  const out: ContentFragment[] = [], body = "[^\\s<>\"'\\u3000-\\u303f\\uff00-\\uffef]+";
  const pattern = new RegExp(`(https?:\\/\\/${body})|(?:\\bdoi:\\s*)?\\b(10\\.\\d{4,9}\\/${body})`, "gi");
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    let shown = match[0].replace(/[.,;:!?]+$/, "");
    if (shown.endsWith(")") && !shown.includes("(")) shown = shown.slice(0, -1);
    const start = match.index!, address = match[1] ? shown : `https://doi.org/${shown.replace(/^doi:\s*/i, "")}`;
    if (start > last) out.push({ t: "t", v: text.slice(last, start) });
    out.push({ t: "l", v: shown, l: address });
    last = start + shown.length;
  }
  if (last < text.length) out.push({ t: "t", v: text.slice(last) });
  return out;
}
/** Empty enough to drop: no text, no links, no references, no children. */
export function isBlank(block: Pick<Block, "content" | "children"> | undefined): boolean {
  return !!block && !(block.children?.length) && (block.content ?? []).every(fragment => fragment.t === "t" && !String(fragment.v ?? "").trim());
}
