// v3.2 in the real Orca test library: with a chapter's footer bound up to the
// book, a citation that lives in another chapter is reached by focusing the
// block that holds it (from the footer [n], from the directory, from the
// location list). Also captures the directory for a visual check.
// Stays in the current panel and returns to where it started.
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-v32-jump.mjs
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page; for (const c of browser.contexts().flatMap(x => x.pages())) if (await c.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = c; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library; nothing done."); }
const logs = []; page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
const wait = ms => page.waitForTimeout(ms), out = {}, shot = n => page.screenshot({ path: `test-results/v32-${n}.png` });
const panel = await page.evaluate(() => orca.state.activePanel);
const back = await page.evaluate(p => { const v = orca.nav.findViewPanel(p, orca.state.panels); return { view: v?.view, args: v?.viewArgs }; }, panel);
const go = async id => { await page.evaluate(({ panel, id }) => orca.nav.goTo("block", { blockId: id }, panel), { panel, id }); await wait(1300); };
const root = () => page.evaluate(p => orca.nav.findViewPanel(p, orca.state.panels)?.viewArgs?.blockId ?? null, panel);
const ids = await page.evaluate(async () => {
  const cmd = (...a) => orca.commands.invokeEditorCommand(...a), t = v => [{ t: "t", v }], o = {}, stamp = new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19);
  await orca.commands.invokeGroup(async () => {
    o.book = await cmd("core.editor.insertBlock", null, null, null, t(`跳转测试 ${stamp}`));
    o.a = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.book], "lastChild", t("第一章 A"));
    o.aBody = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.a], "lastChild", t("A 的正文"));
    o.b = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.book], "lastChild", t("第二章 B"));
    o.bBody = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.b], "lastChild", t("B 的正文"));
    o.bMore = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.b], "lastChild", t("B 的第二段"));
  }); return o; });
const content = (rootId, id) => page.locator(`.orca-block-editor[data-block-id="${rootId}"] .orca-block[data-id="${id}"] > .orca-repr .orca-repr-main-content`).first();
const insert = async (rootId, id, text, pick = false) => {
  await content(rootId, id).click(); await page.keyboard.press("End"); await wait(150);
  await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(300);
  // pick: a matching footnote already in this range is preselected; nothing to press.
  await page.keyboard.type(text); await wait(600); void pick;
  await page.keyboard.press("Enter"); await wait(1800);
};
const footerRows = rootId => page.evaluate(rootId => {
  const editor = [...document.querySelectorAll(".orca-block-editor[data-block-id]")].find(e => e.dataset.blockId === String(rootId) && !e.closest(".orca-hideable-hidden"));
  const own = (orca.state.blocks[rootId]?.children ?? []).find(c => orca.state.blocks[c]?.properties?.some(p => p.name === "_repr" && p.value?.type === "orca-footnotes.section"));
  const section = own != null ? editor?.querySelector(`.orca-block[data-id="${own}"]`) : null;
  return section ? [...section.querySelectorAll(":scope > .orca-repr > .orca-repr-children > .orca-block")].map(r => ({ id: r.dataset.id, icon: r.querySelector(".orca-block-handle")?.getAttribute("data-icon") ?? null, text: (r.querySelector(".orca-repr-main-content")?.textContent ?? "").trim().slice(0, 20) })) : null;
}, rootId);
// The highlight lasts under a second; record every superscript that gets it.
await page.evaluate(() => { window.__ofnSeen = []; window.__ofnObs?.disconnect();
  window.__ofnObs = new MutationObserver(records => { for (const r of records) { const n = r.target; if (n instanceof Element && n.classList.contains("ofn-next-navigation-highlight") && !(r.oldValue ?? "").includes("ofn-next-navigation-highlight"))
    window.__ofnSeen.push({ block: n.closest(".orca-block")?.dataset.id, number: n.querySelector(".orca-inline-r-content")?.getAttribute("data-ofn-number") ?? null, root: n.closest(".orca-block-editor")?.dataset.blockId }); } });
  window.__ofnObs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true }); });
const landed = () => page.evaluate(p => { const seen = window.__ofnSeen.splice(0); return { root: orca.nav.findViewPanel(p, orca.state.panels)?.viewArgs?.blockId ?? null,
  highlighted: seen, locations: !!document.querySelector(".ofn-next-locations") }; }, panel);
const clickHandle = async (rootId, icon) => {
  const rows = await footerRows(rootId), row = rows?.find(r => r.icon === icon); if (!row) return `no row ${icon}`;
  await page.locator(`.orca-block-editor[data-block-id="${rootId}"] .orca-block[data-id="${row.id}"] .orca-block-handle`).first().click(); await wait(2200); return "clicked";
};
const goBack = async () => { await page.evaluate(() => orca.commands.invokeCommand("core.goBack")); await wait(1300); };

await go(ids.a); await insert(ids.a, ids.aBody, "甲·来自 A");
await go(ids.b); await insert(ids.b, ids.bBody, "乙·来自 B");
// Bind A's footer up to the book.
await go(ids.a);
await page.locator(`.orca-block-editor[data-block-id="${ids.a}"] .ofn-v3-section-footer .ofn-next-scope-button`).first().click(); await wait(400);
out.scopeOptions = await page.evaluate(() => [...document.querySelectorAll(".orca-context-menu .orca-menu-text")].map(n => n.textContent));
await page.locator(".orca-context-menu .orca-menu-text").nth(1).click(); await wait(2600);
out.boundA = await footerRows(ids.a);
await shot("01-bound-A");
// (1) footer [2] (乙, cited only in B) -> focus bBody, highlight its superscript.
out.handleClick = await clickHandle(ids.a, "[2]"); out.afterHandle = await landed(); await shot("02-after-handle");
await goBack(); out.afterBack = await root();
// (2) directory row 2 -> same, when the directory click goes to the body.
const dirRows = await page.evaluate(() => [...document.querySelectorAll(".ofn-v3-dir-row")].map(r => r.textContent.trim().slice(0, 20)));
out.directoryRows = dirRows;
await page.locator(".ofn-v3-dir-row .ofn-v3-dir-item").nth(1).click(); await wait(2200); out.afterDirectory = await landed();
await goBack();
// (3) cite 乙 again in A: two locations; choose the one in B from the list.
await insert(ids.a, ids.aBody, "乙", true);
out.boundA2 = await footerRows(ids.a);
const row2 = (out.boundA2 ?? []).find(r => r.text.startsWith("乙"));
if (row2) {
  await page.locator(`.orca-block-editor[data-block-id="${ids.a}"] .orca-block[data-id="${row2.id}"] .orca-block-handle`).first().click(); await wait(800);
  out.locationRows = await page.evaluate(() => [...document.querySelectorAll(".ofn-next-locations .ofn-next-location")].map(n => n.textContent.trim().slice(0, 40)));
  await shot("03-locations");
  const inB = page.locator(".ofn-next-locations .ofn-next-location", { hasText: "B 的正文" }).first();
  if (await inB.count()) { await inB.click(); await wait(2200); out.afterLocation = await landed(); await goBack(); }
}
// Shortcut setting: change, unreadable text, a key taken by another command, back.
const setShortcut = async value => { await page.evaluate(async value => { const s = { ...orca.state.plugins["orca-footnotes"]?.settings, insertShortcut: value }; await orca.plugins.setSettings("repo", "orca-footnotes", s); }, value); await wait(700);
  return page.evaluate(() => orca.state.shortcuts?.["orca-footnotes.insert"] ?? null); };
const toasts = () => page.evaluate(() => [...document.querySelectorAll(".orca-notification, .orca-notify, [class*=notification]")].map(n => n.textContent.trim()).filter(Boolean).slice(-3));
out.shortcut = { start: await page.evaluate(() => orca.state.shortcuts?.["orca-footnotes.insert"] ?? null) };
out.shortcut.changed = await setShortcut("Alt + Shift + J");
out.shortcut.unreadable = await setShortcut("ctrl+"); out.shortcut.unreadableToast = await toasts();
out.shortcut.taken = await setShortcut("ctrl+f"); out.shortcut.takenToast = await toasts();
out.shortcut.cleared = await setShortcut("");
out.shortcut.restored = await setShortcut("alt+ctrl+f");
out.shortcut.findStill = await page.evaluate(() => orca.state.shortcuts?.["core.editor.toggleFindReplace"] ?? null);
// Directory close-up for the visual check.
await go(ids.a); await wait(800);
const box = await page.locator(".ofn-v3-dir").boundingBox().catch(() => null);
if (box) await page.screenshot({ path: "test-results/v32-04-directory.png", clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: box.height + 32 } });
await page.locator(".ofn-v3-dir-row").first().hover(); await wait(200);
if (box) await page.screenshot({ path: "test-results/v32-05-directory-hover.png", clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: box.height + 32 } });
out.directoryBox = box;
await page.evaluate(({ panel, back }) => { if (back.view && back.args) orca.nav.goTo(back.view, back.args, panel); }, { panel, back }); await wait(500);
console.log(JSON.stringify({ ids, ...out, logs }, null, 1)); await browser.close();
