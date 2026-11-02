// v3.2 in the real Orca test library: hovering a directory row lights its
// superscripts; one undo brings a deleted footnote back with its citation;
// a typed web address / DOI becomes a native link; a bound directory names
// its numbering scope. Stays in the current panel and returns.
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-v32-more.mjs
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
const ids = await page.evaluate(async () => {
  const cmd = (...a) => orca.commands.invokeEditorCommand(...a), t = v => [{ t: "t", v }], o = {}, stamp = new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19);
  await orca.commands.invokeGroup(async () => {
    o.book = await cmd("core.editor.insertBlock", null, null, null, t(`杂项测试 ${stamp}`));
    o.a = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.book], "lastChild", t("甲章"));
    o.p1 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.a], "lastChild", t("第一段"));
    o.p2 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.a], "lastChild", t("第二段"));
  }); return o; });
const content = (rootId, id) => page.locator(`.orca-block-editor[data-block-id="${rootId}"] .orca-block[data-id="${id}"] > .orca-repr .orca-repr-main-content`).first();
const insert = async (rootId, id, text) => {
  await content(rootId, id).click(); await page.keyboard.press("End"); await wait(150);
  await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(300);
  await page.keyboard.type(text); await wait(600); await page.keyboard.press("Enter"); await wait(1800);
};
const body = id => page.evaluate(id => { const b = orca.state.blocks[id]; return (b?.content ?? []).map(f => f.t === "r" ? `[r→${b.refs.find(r => r.id === f.v)?.to}]` : f.v).join(""); }, id);
const rows = rootId => page.evaluate(rootId => {
  const editor = [...document.querySelectorAll(".orca-block-editor[data-block-id]")].find(e => e.dataset.blockId === String(rootId) && !e.closest(".orca-hideable-hidden"));
  const own = (orca.state.blocks[rootId]?.children ?? []).find(c => orca.state.blocks[c]?.properties?.some(p => p.name === "_repr" && p.value?.type === "orca-footnotes.section"));
  const section = own != null ? editor?.querySelector(`.orca-block[data-id="${own}"]`) : null;
  return section ? [...section.querySelectorAll(":scope > .orca-repr > .orca-repr-children > .orca-block")].map(r => `${r.querySelector(".orca-block-handle")?.getAttribute("data-icon") ?? "·"} ${(r.querySelector(".orca-repr-main-content")?.textContent ?? "").trim().slice(0, 40)}`) : null;
}, rootId);

await go(ids.a);
await insert(ids.a, ids.p1, "见 https://example.org/paper 与 doi:10.1000/abc123");
await insert(ids.a, ids.p2, "乙文献");
// (1) the link: entry content and what the mirror row renders.
out.link = await page.evaluate(id => {
  const b = orca.state.blocks[id], rel = b.refs.find(r => r.type === 1); const entry = orca.state.blocks[rel?.to];
  const links = [...document.querySelectorAll(".ofn-v3-section-footer .orca-inline[data-type='l']")].map(n => ({ text: n.textContent, href: n.querySelector("a")?.getAttribute("href") ?? n.getAttribute("data-link") ?? null, html: n.outerHTML.slice(0, 200) }));
  return { content: entry?.content, links };
}, ids.p1);
// (2) hover a directory row: only its superscript lights up.
await page.locator(".ofn-v3-dir-row").nth(1).hover(); await wait(300);
out.hover = await page.evaluate(() => [...document.querySelectorAll(".ofn-next-highlight")].map(n => `${n.closest(".orca-block")?.dataset.id}:${n.querySelector(".orca-inline-r-content")?.getAttribute("data-ofn-number")}`));
await page.mouse.move(5, 500); await wait(300);
out.hoverAfterLeave = await page.evaluate(() => document.querySelectorAll(".ofn-next-highlight").length);
// (3) delete 乙 from the directory, then one undo.
out.beforeDelete = { p2: await body(ids.p2), rows: await rows(ids.a) };
await page.locator(".ofn-v3-dir-row").nth(1).hover(); await page.locator(".ofn-v3-dir-more").nth(1).click(); await wait(300);
await page.locator(".orca-context-menu .orca-menu-text").getByText("删除尾注", { exact: true }).click(); await wait(400);
await page.locator(".ofn-v3-confirm").getByRole("button", { name: "确定", exact: true }).click(); await wait(1800);
out.afterDelete = { p2: await body(ids.p2), rows: await rows(ids.a) };
await content(ids.a, ids.p1).click(); await wait(200); await page.keyboard.press("Control+z"); await wait(2200);
out.afterUndo = { p2: await body(ids.p2), rows: await rows(ids.a), state: await page.evaluate(id => { const b = orca.state.blocks[id], rel = b.refs.find(r => r.type === 1); const e = orca.state.blocks[rel?.to]; return e ? { parent: orca.state.blocks[e.parent]?.text, state: e.properties?.find(p => p.name === "orca-footnotes.state")?.value ?? null } : null; }, ids.p2) };
// (4) bind 甲章 to the book: the directory names the scope.
await page.locator(`.orca-block-editor[data-block-id="${ids.a}"] .ofn-v3-section-footer .ofn-next-scope-button`).first().click(); await wait(400);
await page.locator(".orca-context-menu .orca-menu-text").nth(1).click(); await wait(2400);
out.directoryTitle = await page.evaluate(() => document.querySelector(".ofn-v3-dir-title")?.textContent);
const box = await page.locator(".ofn-v3-dir").boundingBox().catch(() => null);
if (box) await page.screenshot({ path: "test-results/v32-07-directory-bound.png", clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: box.height + 32 } });
const footer = await page.locator(`.orca-block-editor[data-block-id="${ids.a}"] .ofn-v3-section-footer`).first().boundingBox().catch(() => null);
if (footer) await page.screenshot({ path: "test-results/v32-08-footer-links.png", clip: { x: Math.max(0, footer.x - 16), y: Math.max(0, footer.y - 16), width: footer.width + 32, height: Math.min(footer.height + 32, 300) } });
await page.evaluate(({ panel, back }) => { if (back.view && back.args) orca.nav.goTo(back.view, back.args, panel); }, { panel, back }); await wait(500);
console.log(JSON.stringify({ ids, ...out, logs }, null, 1)); await browser.close();
