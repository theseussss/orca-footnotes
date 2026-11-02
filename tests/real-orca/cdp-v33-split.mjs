// v3.3 in the real Orca test library: Enter in the middle of a footnote row
// splits it; the tail becomes a new footnote of this view (Orca puts it in the
// store, out of sight; the plugin brings it and the caret back to the footer).
// Enter at the start of a row; nothing is left behind in the store.
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-v33-split.mjs
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page; for (const c of browser.contexts().flatMap(x => x.pages())) if (await c.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = c; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library; nothing done."); }
const logs = []; page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
const wait = ms => page.waitForTimeout(ms), out = {};
const panel = await page.evaluate(() => orca.state.activePanel);
const back = await page.evaluate(p => { const v = orca.nav.findViewPanel(p, orca.state.panels); return { view: v?.view, args: v?.viewArgs }; }, panel);
const go = async id => { await page.evaluate(({ panel, id }) => orca.nav.goTo("block", { blockId: id }, panel), { panel, id }); await wait(1300); };
const stamp = await page.evaluate(() => new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19).replace(/:/g, ""));
const ids = await page.evaluate(async stamp => { const cmd = (...a) => orca.commands.invokeEditorCommand(...a), o = {};
  await orca.commands.invokeGroup(async () => { o.page = await cmd("core.editor.insertBlock", null, null, null, [{ t: "t", v: `拆分测试 ${stamp}` }]); o.p1 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", [{ t: "t", v: "正文" }]); }); return o; }, stamp);
const strays = () => page.evaluate(async () => { const f = await orca.invokeBackend("get-blockid-by-alias", "尾注库"); const id = typeof f === "number" ? f : f?.id; const s = orca.state.blocks[id];
  return s.children.filter(c => { const b = orca.state.blocks[c]; return b && !(b.refs ?? []).some(r => r.type === 2) && (b.content ?? []).some(f => f.t !== "t" || String(f.v).trim()); }).map(c => `${c} ${JSON.stringify(orca.state.blocks[c]?.text ?? "")}`); });
out.straysAtStart = await strays();
const rows = () => page.evaluate(rootId => { const b = x => orca.state.blocks[x];
  const s = (b(rootId)?.children ?? []).map(b).find(x => x?.properties?.some(p => p.name === "_repr" && p.value?.type === "orca-footnotes.section"));
  return s ? s.children.map(c => { const r = b(c)?.properties?.find(p => p.name === "_repr")?.value; const e = b(r?.mirroredId ?? c);
    return `${r?.mirroredId ? "note" : "plain"} ${(e?.content ?? []).map(f => f.t === "t" ? f.v : `[${f.t}]`).join("")}`; }) : null; }, ids.page);
const caret = () => page.evaluate(() => { const s = document.getSelection(), el = s?.anchorNode instanceof Element ? s.anchorNode : s?.anchorNode?.parentElement; const blk = el?.closest(".orca-block");
  return blk ? { block: blk.dataset.id, inFooter: !!el.closest(".ofn-v3-section-footer"), text: (blk.querySelector(".orca-repr-main-content")?.textContent ?? "").slice(0, 20), offset: s.anchorOffset } : null; });
await go(ids.page);
const content = id => page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .orca-block[data-id="${id}"] > .orca-repr .orca-repr-main-content`).first();
await content(ids.p1).click(); await page.keyboard.press("End"); await wait(150);
await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(300);
await page.keyboard.type(`甲乙${stamp}丙丁`); await wait(700); await page.keyboard.press("Enter"); await wait(1800);
out.before = await rows();
const row = page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .ofn-v3-section-footer .orca-repr-main-content`, { hasText: "甲乙" }).first();
await row.click(); await wait(200); await page.keyboard.press("Home"); await wait(150); await page.keyboard.press("ArrowRight"); await wait(80); await page.keyboard.press("ArrowRight"); await wait(250);
await page.keyboard.press("Enter"); await wait(1500);
out.afterSplit = { rows: await rows(), caret: await caret(), strays: await strays() };
await page.keyboard.type("XY", { delay: 40 }); await wait(600);
out.typedAfterSplit = { rows: await rows(), caret: await caret() };
// Enter at the start of the first row.
await row.click(); await wait(200); await page.keyboard.press("Home"); await wait(250); await page.keyboard.press("Enter"); await wait(1200);
out.enterAtStart = { rows: await rows(), caret: await caret(), strays: await strays() };
await content(ids.p1).click(); await wait(2800);
out.afterLeave = { rows: await rows(), strays: await strays() };
await page.evaluate(({ panel, back }) => { if (back.view && back.args) orca.nav.goTo(back.view, back.args, panel); }, { panel, back }); await wait(400);
console.log(JSON.stringify({ ids, ...out, logs }, null, 1)); await browser.close();
