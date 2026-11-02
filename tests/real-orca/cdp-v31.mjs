// v3.1 in the real Orca test library: entries in the store, footers of mirrors,
// a zoomed sub-block with its own footer, comments by Enter+Tab, quick syntax,
// shortcut, migration of an older footer. Stays in the current panel.
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-v31.mjs
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
let page; for (const c of browser.contexts().flatMap(x => x.pages())) if (await c.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = c; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library."); }
const logs = []; page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
const wait = ms => page.waitForTimeout(ms), out = {}, shot = n => page.screenshot({ path: `test-results/v31-${n}.png` });
const panel = await page.evaluate(() => orca.state.activePanel);
const back = await page.evaluate(p => { const v = orca.nav.findViewPanel(p, orca.state.panels); return { view: v?.view, args: v?.viewArgs }; }, panel);
const go = async id => { await page.evaluate(({ panel, id }) => orca.nav.goTo("block", { blockId: id }, panel), { panel, id }); await wait(1300); };
const ids = await page.evaluate(async () => { const cmd = (...a) => orca.commands.invokeEditorCommand(...a), t = v => [{ t: "t", v }], o = {};
  await orca.commands.invokeGroup(async () => {
    o.page = await cmd("core.editor.insertBlock", null, null, null, t("v3.1 测试"));
    o.p1 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", t("第一段"));
    o.p2 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", t("第二段"));
    o.p2a = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.p2], "lastChild", t("子段"));
    o.p3 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", t("第三段"));
  }); return o; });
const content = (root, id) => page.locator(`.orca-block-editor[data-block-id="${root}"] .orca-block[data-id="${id}"] > .orca-repr .orca-repr-main-content`).first();
const insert = async (root, id, text, how = "shortcut") => {
  await content(root, id).click(); await page.keyboard.press("End"); await wait(120);
  if (how === "shortcut") await page.keyboard.press("Control+Alt+f"); else await page.keyboard.type(how);
  await wait(300); await page.keyboard.type(text); await wait(500); await page.keyboard.press("Enter"); await wait(1800);
};
const state = root => page.evaluate(({ root, ids }) => {
  const b = x => orca.state.blocks[x], rep = x => b(x)?.properties?.find(p => p.name === "_repr")?.value;
  const section = (b(root)?.children ?? []).map(b).find(x => rep(x?.id)?.type === "orca-footnotes.section");
  const editor = [...document.querySelectorAll(".orca-block-editor[data-block-id]")].find(e => e.dataset.blockId === String(root) && !e.closest(".orca-hideable-hidden"));
  const own = editor?.querySelector(`.orca-block[data-id="${section?.id}"]`);
  return { section: section ? section.children.map(c => ({ c, mirrorOf: rep(c)?.mirroredId ?? null, text: (b(rep(c)?.mirroredId ?? c)?.text ?? "").trim() })) : null,
    sups: editor ? [...editor.querySelectorAll(".orca-inline.ofn-vnext-note")].filter(n => !n.closest('[data-ofn-foreign="true"]')).map(n => n.querySelector(".orca-inline-r-content")?.getAttribute("data-ofn-number")) : null,
    rows: own ? [...own.querySelectorAll(":scope > .orca-repr > .orca-repr-children > .orca-block")].map(r => `${r.querySelector(".orca-block-handle")?.getAttribute("data-icon") ?? "·"} ${(r.querySelector(".orca-repr-main-content")?.textContent ?? "").slice(0, 12)}`) : null,
    foreign: editor ? [...editor.querySelectorAll('[data-ofn-foreign="true"]')].map(n => n.dataset.id) : null };
}, { root, ids });
const storePage = () => page.evaluate(async () => { const f = await orca.invokeBackend("get-blockid-by-alias", "尾注库"); const id = typeof f === "number" ? f : f?.id; const s = orca.state.blocks[id] ?? await orca.invokeBackend("get-block", id); return s ? { id: s.id, children: s.children.length } : null; });
await go(ids.page);
out.shortcut = await page.evaluate(() => orca.state.shortcuts?.["orca-footnotes.insert"] ?? null);
await insert(ids.page, ids.p1, "甲");
await insert(ids.page, ids.p2a, "乙");
out.afterTwo = { ...(await state(ids.page)), store: await storePage() };
// One undo removes the whole second insertion (entry, citation, mirror).
await page.keyboard.press("Control+z"); await wait(1500); out.afterUndo = { ...(await state(ids.page)), store: await storePage() };
await insert(ids.page, ids.p2a, "乙");
out.afterRedoByHand = await state(ids.page);
// Zoom into 第二段: its own numbering and footer.
await go(ids.p2); await wait(2600); out.zoomP2 = await state(ids.p2); await shot("01-zoom-p2");
await go(ids.page); await wait(1500); out.backToPage = await state(ids.page); await shot("02-page");
// Comment: Enter at the end of mirrored 甲, type, Tab.
const ownSection = await page.evaluate(id => (orca.state.blocks[id]?.children ?? []).find(c => orca.state.blocks[c]?.properties?.some(p => p.value?.type === "orca-footnotes.section")), ids.page);
const firstRow = page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .orca-block[data-id="${ownSection}"] > .orca-repr > .orca-repr-children > .orca-block`).first().locator(".orca-repr-main-content").first();
{ const box = await firstRow.boundingBox(); await firstRow.click({ position: { x: Math.max(2, (box?.width ?? 10) - 4), y: (box?.height ?? 10) / 2 } }); } await wait(150); await page.keyboard.press("End"); await wait(150); await page.keyboard.press("Enter"); await wait(500); await page.keyboard.type("批注一"); await wait(500); await page.keyboard.press("Tab"); await wait(1500);
out.comment = await page.evaluate(() => { const s = document.getSelection(), el = s?.anchorNode instanceof Element ? s.anchorNode : s?.anchorNode?.parentElement; const blk = el?.closest(".orca-block"); const b = blk && orca.state.blocks[blk.dataset.id];
  const parent = b && orca.state.blocks[b.parent]; return b ? { text: b.text, parentText: parent?.text, parentTagged: (parent?.refs ?? []).some(r => r.type === 2) } : null; });
out.afterComment = await state(ids.page);
// Quick syntax ^^
await page.evaluate(async () => { const s = { ...orca.state.plugins["orca-footnotes"]?.settings, triggerSymbol: "^^" }; await orca.plugins.setSettings("repo", "orca-footnotes", s); }); await wait(500);
await insert(ids.page, ids.p3, "丙", "^^"); out.quick = await state(ids.page);
await page.evaluate(async () => { const s = { ...orca.state.plugins["orca-footnotes"]?.settings, triggerSymbol: "" }; await orca.plugins.setSettings("repo", "orca-footnotes", s); });
await shot("03-final");
// Older layout migration: the reorder test page from earlier, if present.
const old = await page.evaluate(() => { const t = Object.values(orca.state.blocks).find(b => b && b.parent == null && /^重排测试/.test(b.text ?? "")); return t?.id ?? null; });
if (old) { await go(old); await wait(2600); out.migrated = await state(old); }
await page.evaluate(({ panel, back }) => { if (back.view && back.args) orca.nav.goTo(back.view, back.args, panel); }, { panel, back }); await wait(500);
console.log(JSON.stringify({ ids, ...out, logs }, null, 1)); await browser.close();
