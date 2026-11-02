// v3.5 in the real Orca test library: no management window; the recycle bin
// and the archive are pages. "尾注回收站" opens the bin; the block menu there
// has "恢复尾注"; deleting again in the bin moves to the archive; the archive
// page tells its retention; deleting there deletes. Stays in the current
// panel and returns.
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-v35-bin.mjs
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page; for (const c of browser.contexts().flatMap(x => x.pages())) if (await c.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = c; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library; nothing done."); }
const logs = []; page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
const wait = ms => page.waitForTimeout(ms), out = {}, shot = n => page.screenshot({ path: `test-results/v35-${n}.png` });
const panel = await page.evaluate(() => orca.state.activePanel);
const back = await page.evaluate(p => { const v = orca.nav.findViewPanel(p, orca.state.panels); return { view: v?.view, args: v?.viewArgs }; }, panel);
const go = async id => { await page.evaluate(({ panel, id }) => orca.nav.goTo("block", { blockId: id }, panel), { panel, id }); await wait(1300); };
const root = () => page.evaluate(p => orca.nav.findViewPanel(p, orca.state.panels)?.viewArgs?.blockId ?? null, panel);
const stamp = await page.evaluate(() => new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19).replace(/:/g, ""));
const ids = await page.evaluate(async stamp => { const cmd = (...a) => orca.commands.invokeEditorCommand(...a), o = {};
  await orca.commands.invokeGroup(async () => { o.page = await cmd("core.editor.insertBlock", null, null, null, [{ t: "t", v: `回收站测试 ${stamp}` }]); o.p1 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", [{ t: "t", v: "正文" }]); }); return o; }, stamp);
await go(ids.page);
const content = id => page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .orca-block[data-id="${id}"] > .orca-repr .orca-repr-main-content`).first();
await content(ids.p1).click(); await page.keyboard.press("End"); await wait(150);
await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(300);
await page.keyboard.type(`回收${stamp}`); await wait(700); await page.keyboard.press("Enter"); await wait(1800);
const entry = await page.evaluate(id => { const b = orca.state.blocks[id]; return b.refs.find(r => r.type === 1)?.to; }, ids.p1);
const where = () => page.evaluate(id => { const b = orca.state.blocks[id], parent = orca.state.blocks[b?.parent];
  return b ? { parent: (parent?.text ?? "").trim(), state: b.properties?.find(p => p.name === "orca-footnotes.state")?.value?.state ?? "active" } : "gone"; }, entry);
// Delete it from the directory: cited, so it asks.
await page.locator(`.ofn-v3-dir-row[data-item-id="${entry}"]`).hover(); await page.locator(`.ofn-v3-dir-row[data-item-id="${entry}"] .ofn-v3-dir-more`).click(); await wait(300);
await page.locator(".orca-context-menu .orca-menu-text").getByText("删除尾注", { exact: true }).click(); await wait(500);
await page.locator(".ofn-v3-confirm").getByRole("button", { name: "确定", exact: true }).click(); await wait(1500);
out.afterDelete = await where();
// "尾注回收站" (also in the footer menu as "回收站") opens the bin page.
await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.open-bin", null)); await wait(1500);
const binId = await root(); out.binTitle = await page.evaluate(id => orca.state.blocks[id]?.text?.trim(), binId); await shot("01-bin");
// Block menu on the entry in the bin: "恢复尾注".
// Plugin items sit in Orca's "插件命令" submenu of the block menu.
const openBlockMenu = async (rootId, blockId) => { const handle = page.locator(`.orca-block-editor[data-block-id="${rootId}"] .orca-block[data-id="${blockId}"] .orca-block-handle`).first();
  await page.locator(`.orca-block-editor[data-block-id="${rootId}"] .orca-block[data-id="${blockId}"] .orca-repr-main-content`).first().hover(); await wait(250);
  await handle.click({ button: "right", force: true }); await wait(500); };
await openBlockMenu(binId, entry);
// The submenu opens on hover after a short delay; hover until its item shows.
{ const plugins = page.locator(".orca-block-handle-menu .orca-menu-text").getByText("插件命令", { exact: true }).first(), target = page.locator(".orca-context-menu .orca-menu-text").getByText("恢复尾注", { exact: true }).first();
  for (let i = 0; i < 6 && !(await target.isVisible().catch(() => false)); i++) { await plugins.hover({ position: { x: 20 + i, y: 6 } }); await wait(500); } }
out.binMenu = await page.evaluate(() => [...document.querySelectorAll(".orca-context-menu .orca-menu-text")].map(n => n.textContent.trim()).filter(t => /尾注/.test(t)));
await page.locator(".orca-context-menu .orca-menu-text").getByText("恢复尾注", { exact: true }).first().click(); await wait(1500);
out.afterRecover = await where();
await go(ids.page); await wait(800);
out.footerAfterRecover = await page.evaluate(rootId => [...document.querySelectorAll(`.orca-block-editor[data-block-id="${rootId}"] .ofn-v3-section-footer > .orca-repr-children > .orca-block`)].map(r => `${r.querySelector(".orca-block-handle")?.getAttribute("data-icon")} ${(r.querySelector(".orca-repr-main-content")?.textContent ?? "").slice(0, 16)}`), ids.page);
// Uncited now: Orca's delete of its footer row sends it straight to the bin.
const mirror = await page.evaluate(({ rootId, entry }) => { const b = x => orca.state.blocks[x]; const s = (b(rootId)?.children ?? []).map(b).find(x => x?.properties?.some(p => p.name === "_repr" && p.value?.type === "orca-footnotes.section"));
  return s?.children.find(c => b(c)?.properties?.find(p => p.name === "_repr")?.value?.mirroredId === entry) ?? null; }, { rootId: ids.page, entry });
// (Orca's own "删除块" in the row's block menu.)
await openBlockMenu(ids.page, mirror);
await page.locator(".orca-block-handle-menu .orca-menu-text").getByText("删除块", { exact: true }).first().click(); await wait(1800);
out.afterRowDelete = await where();
// Deleting again inside the bin: to the archive.
await page.evaluate(id => orca.commands.invokeEditorCommand("core.editor.deleteBlocks", null, [id]), entry); await wait(1500);
out.afterBinDelete = await where();
const archiveId = await page.evaluate(async () => { const f = await orca.invokeBackend("get-blockid-by-alias", "尾注待清理归档"); return typeof f === "number" ? f : f?.id; });
await go(archiveId); await wait(800);
out.archiveNote = await page.evaluate(() => document.querySelector(".ofn-v3-section-note")?.textContent ?? null); await shot("02-archive");
// Deleting in the archive deletes.
await page.evaluate(id => orca.commands.invokeEditorCommand("core.editor.deleteBlocks", null, [id]), entry); await wait(1200);
out.afterArchiveDelete = await where();
out.libraryCommandGone = await page.evaluate(() => !orca.state.commands?.["orca-footnotes.open-library"] && !!orca.state.commands?.["orca-footnotes.open-bin"]);
await page.evaluate(({ panel, back }) => { if (back.view && back.args) orca.nav.goTo(back.view, back.args, panel); }, { panel, back }); await wait(400);
console.log(JSON.stringify({ ids, entry, ...out, logs }, null, 1)); await browser.close();
