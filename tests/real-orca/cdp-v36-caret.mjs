// v3.6 in the real Orca test library: deleting characters in a footer row
// keeps the caret where it is (it used to jump to the start); deleting a
// footnote's text key by key and pressing Backspace once more deletes it
// (asks first when it is cited). Also counts how often the footnotes are
// recounted while typing. Stays in the current panel and returns.
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-v36-caret.mjs
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page; for (const c of browser.contexts().flatMap(x => x.pages())) if (await c.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = c; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library; nothing done."); }
const logs = []; page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
const wait = ms => page.waitForTimeout(ms), out = {};
const panel = await page.evaluate(() => orca.state.activePanel);
const back = await page.evaluate(p => { const v = orca.nav.findViewPanel(p, orca.state.panels); return { view: v?.view, args: v?.viewArgs }; }, panel);
const stamp = await page.evaluate(() => new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19).replace(/:/g, ""));
const ids = await page.evaluate(async stamp => { const cmd = (...a) => orca.commands.invokeEditorCommand(...a), o = {};
  await orca.commands.invokeGroup(async () => { o.page = await cmd("core.editor.insertBlock", null, null, null, [{ t: "t", v: `光标测试 ${stamp}` }]);
    o.p1 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", [{ t: "t", v: "正文一" }]);
    o.p2 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", [{ t: "t", v: "正文二" }]); }); return o; }, stamp);
await page.evaluate(({ panel, id }) => orca.nav.goTo("block", { blockId: id }, panel), { panel, id: ids.page }); await wait(1300);
const content = id => page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .orca-block[data-id="${id}"] > .orca-repr .orca-repr-main-content`).first();
await content(ids.p1).click(); await page.keyboard.press("End"); await wait(150);
await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(300);
await page.keyboard.type(`gb${stamp}`); await wait(700); await page.keyboard.press("Enter"); await wait(1800);
const rowEl = text => page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .ofn-v3-section-footer .orca-repr-main-content`, { hasText: text }).first();
const clickEnd = async text => { const row = rowEl(text), box = await row.boundingBox(); await row.click({ position: { x: Math.max(2, (box?.width ?? 10) - 4), y: (box?.height ?? 10) / 2 } }); await wait(250); await page.keyboard.press("End"); await wait(250); };
await clickEnd(`gb${stamp}`); await page.keyboard.press("Enter"); await wait(500); await page.keyboard.type("wyz", { delay: 120 }); await wait(400);
await content(ids.p2).click(); await wait(2600);
const caret = () => page.evaluate(() => { const s = document.getSelection(); const el = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement; return el?.closest(".orca-repr-main-content") ? s.anchorOffset : null; });
const rows = () => page.evaluate(id => [...document.querySelectorAll(`.orca-block-editor[data-block-id="${id}"] .ofn-v3-section-footer > .orca-repr-children > .orca-block`)].map(r => `${r.querySelector(".orca-block-handle")?.getAttribute("data-icon")} ${(r.querySelector(".orca-repr-main-content")?.textContent ?? "").replace("尾注​", "")}`), ids.page);
// Count recounts while typing.
await page.evaluate(() => { const rt = window.__ofnV3; window.__ofnCount = 0; window.__ofnRefreshNow = rt.refreshNow; rt.refreshNow = function (...a) { window.__ofnCount++; return window.__ofnRefreshNow.apply(this, a); }; });
// (1) cited row: type and delete, caret stays at the end.
await clickEnd(`gb${stamp}`); const cited = [await caret()];
for (const k of ["a", "b", "Backspace", "Backspace", "Backspace"]) { if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k); await wait(300); cited.push(await caret()); }
out.citedCaret = cited;
// (2) uncited row: Backspace key by key until empty, then once more: gone, no question.
await clickEnd("wyz"); const uncited = [await caret()];
for (let i = 0; i < 3; i++) { await page.keyboard.press("Backspace"); await wait(300); uncited.push(await caret()); }
out.uncitedCaret = uncited; out.uncitedEmptied = await rows();
await page.keyboard.press("Backspace"); await wait(1500); out.afterUncitedBackspace = { rows: await rows(), dialog: await page.evaluate(() => !!document.querySelector(".ofn-v3-confirm")) };
out.recounts = await page.evaluate(() => { const rt = window.__ofnV3; rt.refreshNow = window.__ofnRefreshNow; return window.__ofnCount; });
await page.evaluate(({ panel, back }) => { if (back.view && back.args) orca.nav.goTo(back.view, back.args, panel); }, { panel, back }); await wait(300);
console.log(JSON.stringify({ ids, ...out, logs }, null, 1)); await browser.close();
