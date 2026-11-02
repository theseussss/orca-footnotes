// v3.3 in the real Orca test library: the footnote popup is there as soon as
// it is called; typing prefers an existing footnote (also one from another
// page); Orca's search finds material anywhere (pinyin too) and citing it
// makes a footnote that refers to it; Enter with nothing typed stays a line
// break; "新建尾注" with nothing typed opens the footer row (as in Word).
// In the footer: Enter without Tab makes a new footnote, Enter+Tab a comment,
// a blank row is dropped; after Ctrl+Z the footer is not re-tidied until the
// next edit. Stays in the current panel and returns.
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-v33-input.mjs
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page; for (const c of browser.contexts().flatMap(x => x.pages())) if (await c.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = c; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library; nothing done."); }
const logs = []; page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
const wait = ms => page.waitForTimeout(ms), out = {}, shot = n => page.screenshot({ path: `test-results/v33-${n}.png` });
const panel = await page.evaluate(() => orca.state.activePanel);
const back = await page.evaluate(p => { const v = orca.nav.findViewPanel(p, orca.state.panels); return { view: v?.view, args: v?.viewArgs }; }, panel);
const go = async id => { await page.evaluate(({ panel, id }) => orca.nav.goTo("block", { blockId: id }, panel), { panel, id }); await wait(1300); };
const stamp = await page.evaluate(() => new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19));
const ids = await page.evaluate(async stamp => {
  const cmd = (...a) => orca.commands.invokeEditorCommand(...a), t = v => [{ t: "t", v }], o = {};
  await orca.commands.invokeGroup(async () => {
    o.material = await cmd("core.editor.insertBlock", null, null, null, t(`资料页 ${stamp}`));
    o.study = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.material], "lastChild", t(`张三${stamp.replace(/:/g, "")} 某研究报告`));
    o.other = await cmd("core.editor.insertBlock", null, null, null, t(`另一页 ${stamp}`));
    o.o1 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.other], "lastChild", t("另一页正文"));
    o.page = await cmd("core.editor.insertBlock", null, null, null, t(`输入测试 ${stamp}`));
    o.p1 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", t("第一段"));
    o.p2 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", t("第二段"));
    o.p3 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", t("第三段"));
  }); return o; }, stamp);
const content = (rootId, id) => page.locator(`.orca-block-editor[data-block-id="${rootId}"] .orca-block[data-id="${id}"] > .orca-repr .orca-repr-main-content`).first();
const atEnd = async (rootId, id) => { await content(rootId, id).click(); await page.keyboard.press("End"); await wait(150); };
const trigger = async () => { await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(400); };
const popup = () => page.evaluate(() => { const p = document.querySelector("[data-ofn-input-popup]"); if (!p) return null;
  return [...p.querySelectorAll(".orca-menu-text")].map(r => `${r.classList.contains("orca-key-selected") ? "▶" : " "} ${r.textContent.trim().slice(0, 48)}`); });
const cites = id => page.evaluate(id => { const b = orca.state.blocks[id]; return (b?.content ?? []).filter(f => f.t === "r").map(f => b.refs.find(r => r.id === f.v)?.to); }, id);
const sectionRows = rootId => page.evaluate(rootId => { const b = x => orca.state.blocks[x];
  const s = (b(rootId)?.children ?? []).map(b).find(x => x?.properties?.some(p => p.name === "_repr" && p.value?.type === "orca-footnotes.section"));
  return s ? s.children.map(c => { const r = b(c)?.properties?.find(p => p.name === "_repr")?.value; const e = b(r?.mirroredId ?? c);
    return { row: c, mirrorOf: r?.mirroredId ?? null, text: (e?.text ?? "").trim().slice(0, 40), tagged: (e?.refs ?? []).some(x => x.type === 2), parent: b(e?.parent)?.text?.trim().slice(0, 12) ?? null, children: (e?.children ?? []).map(k => (b(k)?.text ?? "").trim()) }; }) : null; }, rootId);

// A footnote on another page, to be found from this one.
await go(ids.other); await atEnd(ids.other, ids.o1); await trigger(); await page.keyboard.type("李四：《另一本书》"); await wait(700); await page.keyboard.press("Enter"); await wait(1800);
out.otherEntry = (await cites(ids.o1))[0];
await go(ids.page);
// (1) the popup is there at once; nothing selected; Enter is a line break.
await atEnd(ids.page, ids.p3); await trigger(); out.openEmpty = await popup(); await shot("01-open-empty");
await page.keyboard.press("Enter"); await wait(800);
out.enterWithNothing = { popup: await popup(), p3Cites: await cites(ids.p3), pageChildren: await page.evaluate(id => orca.state.blocks[id].children.length, ids.page) };
await page.keyboard.press("Backspace"); await wait(500);
// (2) a footnote of another page is offered (not preselected); choosing it reuses it.
await atEnd(ids.page, ids.p1); await trigger(); await page.keyboard.type("李四"); await wait(900); out.typedLisi = await popup(); await shot("02-typed-lisi");
{ const rows = out.typedLisi ?? [], target = rows.findIndex(r => r.includes(`另一页 ${stamp}`)), at = rows.findIndex(r => r.startsWith("▶"));
  for (let i = 0; i < (target - at + rows.length) % rows.length; i++) { await page.keyboard.press("ArrowDown"); await wait(80); } }
await page.keyboard.press("Enter"); await wait(1800); out.p1Cites = await cites(ids.p1);
// (2b) the same source again in this page: preselected.
await atEnd(ids.page, ids.p3); await trigger(); await page.keyboard.type("李四"); await wait(900); out.typedLisiHere = await popup();
await page.keyboard.press("Escape"); await wait(300); for (let i = 0; i < 2; i++) { await page.keyboard.press("Backspace"); await wait(80); } await wait(400);
// (3) material from the whole library, found by pinyin; citing it makes a footnote that refers to it.
await atEnd(ids.page, ids.p2); await trigger(); out.openWithOne = await popup();
await page.keyboard.type("zhangsan"); await wait(1200); out.typedPinyin = await popup(); await shot("03-typed-pinyin");
const rows3 = out.typedPinyin ?? [], target = rows3.findIndex(r => r.includes(`资料页 ${stamp}`)), selected = rows3.findIndex(r => r.startsWith("▶"));
for (let i = 0; i < (target - selected + rows3.length) % rows3.length; i++) { await page.keyboard.press("ArrowDown"); await wait(80); }
await page.keyboard.press("Enter"); await wait(2000);
out.p2 = await page.evaluate(id => { const b = orca.state.blocks[id], rel = b.refs.find(r => r.type === 1), e = orca.state.blocks[rel?.to];
  return e ? { entryContent: e.content, entryRefsTo: e.refs.filter(r => r.type === 1).map(r => r.to), tagged: e.refs.some(r => r.type === 2), text: b.text } : null; }, ids.p2);
out.studyUntouched = await page.evaluate(id => ({ text: orca.state.blocks[id]?.text, tags: (orca.state.blocks[id]?.refs ?? []).filter(r => r.type === 2).length }), ids.study);
// (4) "新建尾注" with nothing typed: cite here, write it in the footer.
await atEnd(ids.page, ids.p3); await trigger(); await page.keyboard.press("ArrowDown"); await wait(100); out.pickNew = await popup();
await page.keyboard.press("Enter"); await wait(2200);
out.caretAfterNew = await page.evaluate(() => { const s = document.getSelection(), el = s?.anchorNode instanceof Element ? s.anchorNode : s?.anchorNode?.parentElement; const blk = el?.closest(".orca-block"); return { id: blk?.dataset.id, mirror: blk?.dataset.mirrorId ?? null, inFooter: !!el?.closest(".ofn-v3-section-footer") }; });
await page.keyboard.type("王五：《文章》"); await wait(800);
out.footerAfterWord = await sectionRows(ids.page);
// (5) footer: Enter without Tab -> a new footnote once the caret leaves.
// Orca syncs its own cursor a moment after a key; a person's pace is enough.
await page.keyboard.press("End"); await wait(200); await page.keyboard.press("Enter"); await wait(500); await page.keyboard.type("赵六：资料", { delay: 40 }); await wait(600);
out.whileTyping = await sectionRows(ids.page);
await content(ids.page, ids.p1).click(); await wait(2600);
out.afterLeave = await sectionRows(ids.page); await shot("04-footer-new");
// (6) undo the adoption: it is not redone until the next edit.
await page.keyboard.press("Control+z"); await wait(2600); out.afterUndo = await sectionRows(ids.page);
// (Playwright types non-ASCII without key events; a real keystroke is "a".)
await content(ids.page, ids.p1).click(); await wait(200); await page.keyboard.press("End"); await wait(200); await page.keyboard.type("a"); await wait(3000); out.afterNextEdit = await sectionRows(ids.page);
await page.keyboard.press("Backspace"); await wait(300);
// (7) footer: Enter + Tab -> a comment; a blank row -> dropped.
const rowLocator = text => page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .ofn-v3-section-footer .orca-repr-main-content`, { hasText: text }).first();
{ const row = rowLocator("赵六"); const box = await row.boundingBox(); await row.click({ position: { x: Math.max(2, (box?.width ?? 10) - 4), y: (box?.height ?? 10) / 2 } }); }
await wait(150); await page.keyboard.press("End"); await wait(150); await page.keyboard.press("Enter"); await wait(500); await page.keyboard.press("Tab"); await wait(500); await page.keyboard.type("这是批注"); await wait(500);
{ const row = rowLocator("王五"); const box = await row.boundingBox(); await row.click({ position: { x: Math.max(2, (box?.width ?? 10) - 4), y: (box?.height ?? 10) / 2 } }); }
await wait(150); await page.keyboard.press("End"); await wait(150); await page.keyboard.press("Enter"); await wait(500);
await content(ids.page, ids.p1).click(); await wait(2800);
out.afterCommentAndBlank = await sectionRows(ids.page); await shot("05-footer-final");
await page.evaluate(({ panel, back }) => { if (back.view && back.args) orca.nav.goTo(back.view, back.args, panel); }, { panel, back }); await wait(500);
console.log(JSON.stringify({ ids, ...out, logs }, null, 1)); await browser.close();
