import test from "node:test";
import assert from "node:assert/strict";
import { entryText, hasTag, isNoteFragment, noteFragment, noteReferences, sectionKind, stateOf, SECTION_PROPERTY, SECTION_REPR, STATE_PROPERTY } from "../src/v3/model";

const block = (over: any = {}) => ({ id: 1, properties: [], refs: [], content: [], children: [], ...over });

test("v3 superscript fragments carry our format; ordinary references are not footnotes", () => {
  assert.ok(isNoteFragment(noteFragment(7)));
  assert.ok(isNoteFragment({ t: "r", v: 7, f: "ofn-vnext-note+sup" } as any), "Orca may reorder format parts");
  assert.equal(isNoteFragment({ t: "r", v: 7, f: "sup" } as any), false);
  assert.equal(isNoteFragment({ t: "t", v: "x" } as any), false);
});
test("v3 citations resolve through the source's own relations, in fragment order; unresolved ones are skipped", () => {
  const b = block({ id: 5, content: [{ t: "t", v: "a" }, noteFragment(11), { t: "t", v: "b" }, noteFragment(12), noteFragment(99)],
    refs: [{ id: 11, from: 5, to: 100, type: 1 }, { id: 12, from: 5, to: 200, type: 1 }] });
  assert.deepEqual(noteReferences(b as any), [{ targetId: 100, fragmentIndex: 1, relationId: 11 }, { targetId: 200, fragmentIndex: 3, relationId: 12 }]);
});
test("v3 entry text is the block's own inline text; tag pills and children are not part of it", () => {
  assert.equal(entryText(block({ content: [{ t: "t", v: "甲文献，" }, { t: "r", v: 3 }, { t: "t", v: "第 3 页" }] }) as any), "甲文献，第 3 页");
  assert.equal(entryText({ text: "乙文献 #尾注\n" } as any), "乙文献");
});
test("v3 sections are recognized only by repr AND marker; entry state defaults to active", () => {
  const repr = { name: "_repr", type: 0, value: { type: SECTION_REPR } };
  assert.equal(sectionKind(block({ properties: [repr, { name: SECTION_PROPERTY, type: 0, value: { version: 3, kind: "footer" } }] }) as any), "footer");
  assert.equal(sectionKind(block({ properties: [repr] }) as any), undefined);
  assert.equal(sectionKind(block({ properties: [{ name: SECTION_PROPERTY, type: 0, value: { kind: "footer" } }] }) as any), undefined);
  assert.equal(stateOf(block() as any), "active");
  assert.equal(stateOf(block({ properties: [{ name: STATE_PROPERTY, type: 0, value: { state: "recycled", at: 1 } }] }) as any), "recycled");
});
test("v3 tag membership is a Property relation to the tag block", () => {
  assert.equal(hasTag(block({ refs: [{ id: 1, from: 1, to: 9, type: 2 }] }) as any, 9), true);
  assert.equal(hasTag(block({ refs: [{ id: 1, from: 1, to: 9, type: 1 }] }) as any, 9), false);
  assert.equal(hasTag(block() as any, undefined), false);
});

test("shortcut setting is normalized to Orca's keymap form", async () => {
  const { normalizeShortcut } = await import("../src/v3/model");
  assert.equal(normalizeShortcut("Ctrl + Alt + F"), "alt+ctrl+f");
  assert.equal(normalizeShortcut("shift+cmd+n"), "meta+shift+n");
  assert.equal(normalizeShortcut(""), "");
  assert.equal(normalizeShortcut("ctrl+"), "");
});

test("typed citations keep their text; web addresses and DOIs become native links", async () => {
  const { citationFragments, entryText } = await import("../src/v3/model");
  assert.deepEqual(citationFragments("张三：《书》，第 3 页"), [{ t: "t", v: "张三：《书》，第 3 页" }]);
  assert.deepEqual(citationFragments("见 https://example.org/a?b=1。"), [{ t: "t", v: "见 " }, { t: "l", v: "https://example.org/a?b=1", l: "https://example.org/a?b=1" }, { t: "t", v: "。" }]);
  assert.deepEqual(citationFragments("Smith 2020, doi:10.1000/xyz123."), [{ t: "t", v: "Smith 2020, " }, { t: "l", v: "doi:10.1000/xyz123", l: "https://doi.org/10.1000/xyz123" }, { t: "t", v: "." }]);
  assert.deepEqual(citationFragments("（10.1234/abc.5）"), [{ t: "t", v: "（" }, { t: "l", v: "10.1234/abc.5", l: "https://doi.org/10.1234/abc.5" }, { t: "t", v: "）" }]);
  assert.deepEqual(citationFragments("https://doi.org/10.1000/x"), [{ t: "l", v: "https://doi.org/10.1000/x", l: "https://doi.org/10.1000/x" }]);
  assert.equal(entryText({ content: citationFragments("见 https://example.org/a"), text: "" }), "见 https://example.org/a");
});

test("an entry that cites material reads as the material's name; blank rows are only empty text", async () => {
  const { entryText, isBlank } = await import("../src/v3/model");
  const entry = { content: [{ t: "r", v: 9 }, { t: "t", v: "，第 3 页" }], refs: [{ id: 9, from: 1, to: 50, type: 1 }], text: "" } as any;
  assert.equal(entryText(entry, id => id === 50 ? "张三 2020" : undefined), "张三 2020，第 3 页");
  assert.equal(entryText(entry), "，第 3 页");
  // Our own superscripts inside an entry are not read as text.
  assert.equal(entryText({ content: [{ t: "r", v: 9, f: "sup+ofn-vnext-note" }], refs: entry.refs, text: "" } as any, () => "X"), "");
  assert.equal(isBlank({ content: [], children: [] } as any), true);
  assert.equal(isBlank({ content: [{ t: "t", v: "  " }], children: [] } as any), true);
  assert.equal(isBlank({ content: [{ t: "r", v: 9 }], children: [] } as any), false);
  assert.equal(isBlank({ content: [], children: [3] } as any), false);
});

test("0.7.0-dev tab leftovers: our custom query is found by its view and removed cleanly", async () => {
  const { tabEntry, withoutTab, isJournal } = await import("../src/v3/model");
  const view = "orca-footnotes.footer", q = { q: { kind: 100, conditions: [] } };
  const mine = [{ name: "尾注", q, view: "list" }], ours = { name: "尾注 2", q, view, viewOpts: {} };
  // Found by its view, even renamed; a user's own query named 尾注 is not ours.
  assert.equal(tabEntry([...mine, ours], view)?.name, "尾注 2"); assert.equal(tabEntry(mine, view), undefined);
  // Removed: only ours and its name go; nothing to remove leaves the lists as they were.
  assert.deepEqual(withoutTab([...mine, ours], ["尾注 2", "_samekind", "尾注"], view), { queries: mine, order: ["_samekind", "尾注"] });
  assert.deepEqual(withoutTab(mine, ["尾注"], view), { queries: mine, order: ["尾注"] });
  // Junk in the property is tolerated.
  assert.equal(tabEntry("x", view), undefined); assert.equal(tabEntry([null, 3, { view }], view), undefined);
  assert.deepEqual(withoutTab(undefined, null, view), { queries: [], order: [] });
  // Journals are recognized by their repr.
  assert.equal(isJournal({ properties: [{ name: "_repr", type: 0, value: { type: "journal", date: new Date() } }] } as any), true);
  assert.equal(isJournal({ properties: [] } as any), false);
});
