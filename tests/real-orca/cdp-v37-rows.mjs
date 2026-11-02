// v3.7 in the real Orca test library: a row written into the footer shows
// [·] at once and becomes a footnote the moment the caret leaves that row,
// in place; uncited rows stay where they were written (only numbered rows
// are sorted); the delete question is Orca's confirm box (Esc keeps, Enter
// deletes). Stays in the current panel and returns.
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-v37-rows.mjs
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page; for (const c of browser.contexts().flatMap(x => x.pages())) if (await c.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = c; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library; nothing done."); }
const logs = []; page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
const wait = ms => page.waitForTimeout(ms), out = {}, shot = n => page.screenshot({ path: `test-results/v37-${n}.png` });
const panel = await page.evaluate(() => orca.state.activePanel);
const back = await page.evaluate(p => { const v = orca.nav.findViewPanel(p, orca.state.panels); return { view: v?.view, args: v?.viewArgs }; }, panel);
const stamp = await page.evaluate(() => new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19).replace(/:/g, ""));
const ids = await page.evaluate(async stamp => { const cmd = (...a) => orca.commands.invokeEditorCommand(...a), o = {};
  await orca.commands.invokeGroup(async () => { o.page = await cmd("core.editor.insertBlock", null, null, null, [{ t: "t", v: `行测试 ${stamp}` }]);
    o.p1 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", [{ t: "t", v: "正文一" }]);
    o.p2 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", [{ t: "t", v: "正文二" }]); }); return o; }, stamp);
await page.evaluate(({ panel, id }) => orca.nav.goTo("block", { blockId: id }, panel), { panel, id: ids.page }); await wait(1300);
const content = id => page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .orca-block[data-id="${id}"] > .orca-repr .orca-repr-main-content`).first();
const insert = async (id, text) => { await content(id).click(); await page.keyboard.press("End"); await wait(150);
  await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(300);
  await page.keyboard.type(text); await wait(800); await page.keyboard.press("Enter"); await wait(1800); };
await insert(ids.p1, `hj${stamp}`);
const rows = () => page.evaluate(id => [...document.querySelectorAll(`.orca-block-editor[data-block-id="${id}"] .ofn-v3-section-footer > .orca-repr-children > .orca-block`)].map(r =>
  `${r.querySelector(":scope > .orca-repr > .orca-repr-main > .orca-repr-main-none-editable > .orca-block-handle")?.getAttribute("data-icon") ?? "-"} ${r.dataset.mirrorId ? "" : "(plain) "}${(r.querySelector(".orca-repr-main-content")?.textContent ?? "").replace("尾注​", "")}`), ids.page);
const caretText = () => page.evaluate(() => { const s = document.getSelection(), el = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement; return (el?.closest(".orca-repr-main-content")?.textContent ?? "").replace("尾注​", ""); });
const rowEl = text => page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .ofn-v3-section-footer .orca-repr-main-content`, { hasText: text }).first();
const clickEnd = async text => { const row = rowEl(text), box = await row.boundingBox(); await row.click({ position: { x: Math.max(2, (box?.width ?? 10) - 4), y: (box?.height ?? 10) / 2 } }); await wait(250); await page.keyboard.press("End"); await wait(250); };
// (1) Enter at the end of a row: the new row shows [·] at once.
await clickEnd(`hj${stamp}`); await page.keyboard.press("Enter"); await wait(400); out.newRow = await rows();
await page.keyboard.type(`zl1${stamp}`, { delay: 40 }); await wait(300);
// (2) Enter again: the row just written is a footnote right away, in place.
await page.keyboard.press("Enter"); await wait(700); out.afterEnter = { rows: await rows(), caret: await caretText() };
await page.keyboard.type(`zl2${stamp}`, { delay: 40 }); await wait(300);
await page.keyboard.press("ArrowUp"); await wait(700); out.afterArrowUp = { rows: await rows(), caret: await caretText() };
// (3) Leaving the footer: nothing jumps.
await content(ids.p2).click(); await wait(2500); out.afterLeave = await rows(); await shot("01-rows");
// (4) Cite the first written one: numbered rows sort, the uncited one stays.
await insert(ids.p2, `zl1${stamp}`); out.afterCite = await rows();
// (5) The delete question: Orca's confirm box; Esc keeps, Enter deletes.
await clickEnd(`zl1${stamp}`); await page.keyboard.press("Shift+Home"); await wait(150); await page.keyboard.press("Backspace"); await wait(600);
await page.keyboard.press("Backspace"); await wait(800);
out.box = await page.evaluate(() => { const b = document.querySelector(".ofn-v3-confirm"); return b ? { text: b.textContent, classes: b.className, buttons: [...b.querySelectorAll("button")].map(x => `${x.textContent}:${x.className}`) } : null; });
const box = await page.locator(".ofn-v3-confirm").boundingBox().catch(() => null);
if (box) await page.screenshot({ path: "test-results/v37-02-confirm.png", clip: { x: Math.max(0, box.x - 30), y: Math.max(0, box.y - 60), width: box.width + 60, height: box.height + 90 } });
await page.keyboard.press("Escape"); await wait(500); out.afterEsc = { box: await page.evaluate(() => !!document.querySelector(".ofn-v3-confirm")), rows: await rows() };
await page.keyboard.press("Backspace"); await wait(800); out.boxAgain = await page.evaluate(() => !!document.querySelector(".ofn-v3-confirm"));
await page.keyboard.press("Enter"); await wait(1800); out.afterEnterConfirm = { box: await page.evaluate(() => !!document.querySelector(".ofn-v3-confirm")), rows: await rows(), p2: await page.evaluate(id => (orca.state.blocks[id]?.content ?? []).filter(f => f.t === "r").length, ids.p2) };
// (6) 收集引文 from the footer menu: a new row with the caret; written and left, a footnote.
await page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .ofn-v3-section-footer [aria-label="文末尾注操作"]`).first().click(); await wait(400);
await page.locator(".orca-context-menu .orca-menu-text").getByText("收集引文", { exact: true }).click(); await wait(900);
out.collectCaret = { caret: await caretText(), rows: await rows(), error: await page.evaluate(() => (orca.state.notifications ?? []).slice(-1).map(n => n.title ?? n.message ?? "")[0] ?? null) };
await page.keyboard.type(`sj${stamp}`, { delay: 40 }); await wait(300); await content(ids.p1).click(); await wait(1500);
out.afterCollect = await rows();
await page.evaluate(({ panel, back }) => { if (back.view && back.args) orca.nav.goTo(back.view, back.args, panel); }, { panel, back }); await wait(300);
console.log(JSON.stringify({ ids, ...out, logs }, null, 1)); await browser.close();
