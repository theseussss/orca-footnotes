// The 尾注 tab drawn into Orca's bottom tab bar (real Orca, test library):
// on every page from the first frame (加载中… / 本页无尾注), first and chosen by
// default; nothing written into the page; the footer drawn in it works as the
// old footer (numbers, typing, Enter -> footnote, Enter+Tab -> comment,
// Backspace between rows, ArrowDown from the body); Orca's tabs and ours switch
// both ways; a jump brings ours back; the position setting (3rd, last); a drag
// of Orca's tabs still saves the right order, a drag of ours moves its
// position; 0.7.0-dev leftovers (`_queries`) are taken off; 正文末尾 setting.
//   OFN_TEST_REPO=<repo> [OFN_CDP=http://127.0.0.1:9223] node tests/real-orca/cdp-v40-tab.mjs
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page; for (const c of browser.contexts().flatMap(x => x.pages())) if (await c.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = c; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library; nothing done."); }
const logs = []; page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
let step = "setup"; page.on("pageerror", e => logs.push(`pageerror [${step}]: ${String(e).slice(0, 200)}`));
const wait = ms => page.waitForTimeout(ms), out = {}, shot = n => page.screenshot({ path: `test-results/v40-${n}.png` });
const name = "orca-footnotes";
const panel = await page.evaluate(() => orca.state.activePanel);
const back = await page.evaluate(p => { const v = orca.nav.findViewPanel(p, orca.state.panels); return { view: v?.view, args: v?.viewArgs }; }, panel);
const setSetting = (key, value) => page.evaluate(async ({ name, key, value }) => { await orca.plugins.setSettings("repo", name, { ...orca.state.plugins[name]?.settings, [key]: value }); }, { name, key, value });
await setSetting("footerPlacement", "tab"); await setSetting("tabPosition", 1); await wait(500);
const stamp = await page.evaluate(() => new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19).replace(/:/g, ""));
const newPage = title => page.evaluate(async ({ title }) => { const cmd = (...a) => orca.commands.invokeEditorCommand(...a), o = {};
  await orca.commands.invokeGroup(async () => { o.page = await cmd("core.editor.insertBlock", null, null, null, [{ t: "t", v: title }]);
    o.p1 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", [{ t: "t", v: "正文一" }]);
    o.p2 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", [{ t: "t", v: "正文二" }]); }); return o; }, { title });
const ids = await newPage(`标签测试 ${stamp}`);
const go = async (id, ms = 1300) => { await page.evaluate(({ panel, id }) => orca.nav.goTo("block", { blockId: id }, panel), { panel, id }); await wait(ms); };
const ed = `.orca-block-editor[data-block-id="${ids.page}"]`;
const tabsOf = pageId => page.evaluate(id => [...document.querySelectorAll(`.orca-block-editor[data-block-id="${id}"] .orca-block-editor-query-tabs .orca-segmented-item`)]
  .filter(x => !x.classList.contains("orca-transition")).map(x => `${x.classList.contains("orca-selected") ? "*" : ""}${x.classList.contains("ofn-v3-tab-item") ? "+" : ""}${x.textContent.trim()}`), pageId);
const state = () => page.evaluate(({ pageId }) => {
  const editor = document.querySelector(`.orca-block-editor[data-block-id="${pageId}"]`); if (!editor) return { error: "no editor" };
  const none = editor.querySelector(":scope > .orca-block-editor-main > .orca-block-editor-none-editable"), panelEl = none?.querySelector(":scope > .ofn-v3-tab-panel");
  const section = window.__ofnV3?.store.sectionOf(orca.state.blocks[pageId])?.id;
  const rowsOf = sec => [...sec.querySelectorAll(":scope > .orca-repr > .orca-repr-children > .orca-block")].map(r => {
    const c = r.querySelector(":scope > .orca-repr > .orca-repr-main > .orca-repr-main-content"), kids = r.querySelectorAll(":scope > .orca-repr > .orca-repr-children > .orca-block").length;
    return `${r.querySelector(":scope > .orca-repr > .orca-repr-main > .orca-repr-main-none-editable > .orca-block-handle")?.getAttribute("data-icon") ?? "-"} ${r.dataset.mirrorId ? "" : "(plain) "}${(c?.textContent ?? "").replace("尾注​", "")}${c?.isContentEditable ? "" : " (not editable)"}${kids ? ` +${kids} child` : ""}`; });
  const inTab = section != null ? panelEl?.querySelector(`.orca-block[data-id="${section}"]`) : null, inBody = section != null ? editor.querySelector(`.orca-block-editor-blocks .orca-block[data-id="${section}"]`) : null;
  const views = none?.querySelector(":scope > .orca-block-editor-query-views"), marker = editor.querySelector(".orca-block-editor-blocks .orca-inline.ofn-vnext-note");
  const prop = n => orca.state.blocks[pageId]?.properties?.find(p => p.name === n)?.value ?? null;
  return { on: none?.dataset.ofnTab ?? null, panelShown: !!panelEl && getComputedStyle(panelEl).display !== "none", orcaViewsShown: !!views && getComputedStyle(views).display !== "none",
    note: panelEl?.querySelector(".ofn-v3-tab-note") && getComputedStyle(panelEl.querySelector(".ofn-v3-tab-note")).display !== "none" ? panelEl.querySelector(".ofn-v3-tab-note").textContent : null,
    tabRows: inTab ? rowsOf(inTab) : null, body: inBody ? (inBody.querySelector(":scope > .orca-repr") ? rowsOf(inBody) : "empty shell") : null,
    marker: marker ? `${marker.dataset.ofnActive ?? "-"} ${marker.querySelector(".orca-inline-r-content")?.dataset.ofnNumber ?? "-"}` : null,
    queries: prop("_queries"), queryOrder: prop("_queryOrder") };
}, { pageId: ids.page });
const caret = () => page.evaluate(() => { const s = document.getSelection(), el = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement;
  return `${el?.closest(".ofn-v3-tab") ? "tab" : el?.closest(".orca-block-editor-blocks") ? "body" : "elsewhere"}: ${(el?.closest(".orca-repr-main-content")?.textContent ?? "").replace("尾注​", "")}`; });
const content = id => page.locator(`${ed} .orca-block-editor-blocks .orca-block[data-id="${id}"] > .orca-repr .orca-repr-main-content`).first();
const tabRow = text => page.locator(`${ed} .ofn-v3-tab .orca-repr-main-content`, { hasText: text }).first();
const clickEnd = async row => { const box = await row.boundingBox(); await row.click({ timeout: 8000, position: { x: Math.max(2, (box?.width ?? 10) - 4), y: (box?.height ?? 10) / 2 } }); await wait(250); await page.keyboard.press("End"); await wait(250); };
const item = text => page.locator(`${ed} .orca-block-editor-query-tabs .orca-segmented-item`).filter({ hasText: new RegExp(`^${text}$`) }).first();
const insert = async (id, text) => { await content(id).click(); await page.keyboard.press("End"); await wait(150);
  await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(300);
  await page.keyboard.type(text); await wait(800); await page.keyboard.press("Enter"); await wait(1800); };
try {
  step = "1"; // (1) A page without footnotes: the tab is there at once, first and chosen.
  await go(ids.page, 120); out.firstFrame = { tabs: await tabsOf(ids.page), note: (await state()).note };
  await wait(1500); out.noFootnotes = { tabs: await tabsOf(ids.page), ...(await state()) }; await shot("01-empty");
  step = "2"; // (2) A footnote: the footer is drawn in the tab; nothing is written into the page's properties.
  await insert(ids.p1, `tab${stamp}`); await wait(1200);
  out.withFootnote = { tabs: await tabsOf(ids.page), ...(await state()) }; await shot("02-footer");
  step = "3"; // (3) Editing in the tab, as in the old footer.
  await clickEnd(tabRow(`tab${stamp}`)); await page.keyboard.type("改", { delay: 40 }); await wait(900);
  out.typed = { caret: await caret(), body: await page.evaluate(id => orca.state.blocks[id]?.text ?? null, ids.p1) };
  await page.keyboard.press("Enter"); await wait(500); out.afterEnter = { caret: await caret(), rows: (await state()).tabRows };
  await page.keyboard.type(`zl${stamp}`, { delay: 40 }); await wait(300); await page.keyboard.press("ArrowUp"); await wait(1500);
  out.afterLeave = { caret: await caret(), rows: (await state()).tabRows };
  await clickEnd(tabRow(`tab${stamp}`)); await page.keyboard.press("Enter"); await wait(400); await page.keyboard.press("Tab"); await wait(400);
  await page.keyboard.type(`pz${stamp}`, { delay: 40 }); await wait(1200); out.afterComment = { caret: await caret(), rows: (await state()).tabRows };
  await tabRow(`zl${stamp}`).click(); await wait(200); await page.keyboard.press("Home"); await wait(200);
  await page.keyboard.press("Backspace"); await wait(1200); out.afterBackspace = { caret: await caret(), rows: (await state()).tabRows };
  await content(ids.p2).click(); await page.keyboard.press("End"); await wait(200); await page.keyboard.press("ArrowDown"); await wait(500);
  out.arrowDownFromBody = await caret();
  step = "4"; // (4) Orca's tab and ours, both ways.
  await item("引用").click(); await wait(700); out.referencesChosen = { tabs: await tabsOf(ids.page), ...(({ on, panelShown, orcaViewsShown }) => ({ on, panelShown, orcaViewsShown }))(await state()) };
  await item("尾注").click(); await wait(600); out.oursAgain = { tabs: await tabsOf(ids.page), ...(({ on, panelShown, orcaViewsShown }) => ({ on, panelShown, orcaViewsShown }))(await state()) };
  await item("同标签").click(); await wait(700); out.sameTagsChosen = { tabs: await tabsOf(ids.page) };
  step = "5"; // (5) A jump (directory 编辑) brings ours to the front with the caret in the row.
  const entry = await page.evaluate(id => [...window.__ofnV3.panes.values()].find(p => p.rootId === id)?.projection.entries[0]?.item.id ?? null, ids.page);
  await page.evaluate(id => window.__ofnV3.actions.edit(id), entry); await wait(1500);
  out.editJump = { tabs: await tabsOf(ids.page), caret: await caret() }; await shot("03-after-ops");
  step = "6"; // (6) Position setting: third, last, first.
  await setSetting("tabPosition", 3); await wait(900); out.position3 = await tabsOf(ids.page);
  await setSetting("tabPosition", 0); await wait(900); out.position0 = await tabsOf(ids.page);
  await setSetting("tabPosition", 1); await wait(900); out.position1 = await tabsOf(ids.page);
  step = "7"; // (7) Drag Orca's 引用 after 同标签: Orca saves the right order (our tab not counted).
  const drag = async (from, to) => { const a = await item(from).boundingBox(), b = await item(to).boundingBox(); if (!a || !b) return "no box";
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down(); await wait(320);
    for (let k = 1; k <= 8; k++) { await page.mouse.move(a.x + a.width / 2 + (b.x + b.width * 0.8 - a.x - a.width / 2) * k / 8, a.y + a.height / 2); await wait(40); }
    await page.mouse.up(); await wait(1200); return "dragged"; };
  out.dragOrca = { action: await drag("引用", "同标签"), tabs: await tabsOf(ids.page), queryOrder: (await state()).queryOrder };
  step = "8"; // (8) Drag our tab after 同标签: only our position changes.
  out.dragOurs = { action: await drag("尾注", "同标签"), tabs: await tabsOf(ids.page), setting: await page.evaluate(name => orca.state.plugins[name]?.settings?.tabPosition, name), queryOrder: (await state()).queryOrder };
  await setSetting("tabPosition", 1); await wait(600);
  step = "9"; // (9) A 0.7.0-dev leftover (`_queries` with our old view) is taken off when the page is seen.
  const legacy = await newPage(`旧标签 ${stamp}`);
  await page.evaluate(async id => { await orca.commands.invokeEditorCommand("core.editor.setProperties", null, [id], [
    { name: "_queries", type: 0, value: [{ name: "尾注", q: { q: { kind: 100, conditions: [] } }, view: "orca-footnotes.footer", viewOpts: {} }] }, { name: "_queryOrder", type: 0, value: ["尾注"] }]); }, legacy.page);
  await go(legacy.page, 2500);
  out.legacy = { queries: await page.evaluate(id => orca.state.blocks[id]?.properties?.find(p => p.name === "_queries")?.value ?? null, legacy.page), tabs: await tabsOf(legacy.page) };
  await go(ids.page);
  step = "10"; // (10) Setting 正文末尾: no tab, the footer at the end of the body; then back.
  await setSetting("footerPlacement", "body"); await wait(1800); out.placementBody = { tabs: await tabsOf(ids.page), ...(await state()) }; await shot("04-body");
  await setSetting("footerPlacement", "tab"); await wait(1800); out.placementTab = { tabs: await tabsOf(ids.page), ...(await state()) };
} catch (error) { out.error = String(error).slice(0, 500); await shot("09-error").catch(() => {}); }
await setSetting("footerPlacement", "tab").catch(() => {}); await setSetting("tabPosition", 1).catch(() => {});
await page.evaluate(({ panel, back }) => { if (back.view && back.args) orca.nav.goTo(back.view, back.args, panel); }, { panel, back }); await wait(300);
console.log(JSON.stringify({ ids, ...out, logs }, null, 1)); await browser.close();
