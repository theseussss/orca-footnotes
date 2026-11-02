// v3.4 in the real Orca test library: deleting footnotes where they are.
// An uncited footnote shows [·]. Backspace in an emptied footnote row deletes
// it (asks first when it is cited). Deleting a footer row the Orca way deletes
// that footnote instead of the row coming back. An uncited footnote left empty
// is dropped. The popup separates this range from other pages and material.
// Stays in the current panel and returns.
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-v34-delete.mjs
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page; for (const c of browser.contexts().flatMap(x => x.pages())) if (await c.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = c; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library; nothing done."); }
const logs = []; page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
const wait = ms => page.waitForTimeout(ms), out = {}, shot = n => page.screenshot({ path: `test-results/v34-${n}.png` });
const panel = await page.evaluate(() => orca.state.activePanel);
const back = await page.evaluate(p => { const v = orca.nav.findViewPanel(p, orca.state.panels); return { view: v?.view, args: v?.viewArgs }; }, panel);
const stamp = await page.evaluate(() => new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19).replace(/:/g, ""));
const ids = await page.evaluate(async stamp => { const cmd = (...a) => orca.commands.invokeEditorCommand(...a), t = v => [{ t: "t", v }], o = {};
  await orca.commands.invokeGroup(async () => {
    o.page = await cmd("core.editor.insertBlock", null, null, null, t(`删除测试 ${stamp}`));
    o.p1 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", t("第一段"));
    o.p2 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", t("第二段"));
  }); return o; }, stamp);
await page.evaluate(({ panel, id }) => orca.nav.goTo("block", { blockId: id }, panel), { panel, id: ids.page }); await wait(1300);
const content = id => page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .orca-block[data-id="${id}"] > .orca-repr .orca-repr-main-content`).first();
const insert = async (id, text) => { await content(id).click(); await page.keyboard.press("End"); await wait(150);
  await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(300);
  await page.keyboard.type(text); await wait(700); await page.keyboard.press("Enter"); await wait(1800); };
const rows = () => page.evaluate(rootId => { const b = x => orca.state.blocks[x];
  const s = (b(rootId)?.children ?? []).map(b).find(x => x?.properties?.some(p => p.name === "_repr" && p.value?.type === "orca-footnotes.section"));
  const dom = [...document.querySelectorAll(`.orca-block-editor[data-block-id="${rootId}"] .ofn-v3-section-footer > .orca-repr-children > .orca-block`)];
  return s ? s.children.map(c => { const r = b(c)?.properties?.find(p => p.name === "_repr")?.value, e = b(r?.mirroredId ?? c), el = dom.find(n => n.dataset.id === String(c));
    return `${el?.querySelector(".orca-block-handle")?.getAttribute("data-icon") ?? "·"} ${r?.mirroredId ? "" : "(plain) "}${(e?.content ?? []).map(f => f.t === "t" ? f.v : `[${f.t}]`).join("")}`; }) : null; }, ids.page);
const rowEl = text => page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .ofn-v3-section-footer .orca-repr-main-content`, { hasText: text }).first();
const clickEnd = async text => { const row = rowEl(text), box = await row.boundingBox(); await row.click({ position: { x: Math.max(2, (box?.width ?? 10) - 4), y: (box?.height ?? 10) / 2 } }); await wait(200); await page.keyboard.press("End"); await wait(200); };
const emptyRow = async text => { await clickEnd(text); await page.keyboard.press("Shift+Home"); await wait(150); await page.keyboard.press("Backspace"); await wait(600); };
const sups = id => page.evaluate(id => (orca.state.blocks[id]?.content ?? []).filter(f => f.t === "r").length, id);
const binHas = text => page.evaluate(async text => { const f = await orca.invokeBackend("get-blockid-by-alias", "尾注回收站"); const id = typeof f === "number" ? f : f?.id; return (orca.state.blocks[id]?.children ?? []).some(c => (orca.state.blocks[c]?.text ?? "").includes(text)); }, text);
const caret = () => page.evaluate(() => { const s = document.getSelection(), el = s?.anchorNode instanceof Element ? s.anchorNode : s?.anchorNode?.parentElement; return (el?.closest(".orca-block")?.querySelector(".orca-repr-main-content")?.textContent ?? "").slice(0, 16); });
const mirrorOf = text => page.evaluate(({ rootId, text }) => { const b = x => orca.state.blocks[x];
  const s = (b(rootId)?.children ?? []).map(b).find(x => x?.properties?.some(p => p.name === "_repr" && p.value?.type === "orca-footnotes.section"));
  return s?.children.find(c => (b(b(c)?.properties?.find(p => p.name === "_repr")?.value?.mirroredId)?.text ?? "").includes(text)) ?? null; }, { rootId: ids.page, text });

await insert(ids.p1, `删测甲${stamp}`); await insert(ids.p2, `删测乙${stamp}`);
// An uncited one, written in the footer.
await clickEnd("删测乙"); await page.keyboard.press("Enter"); await wait(500); await page.keyboard.type(`dc${stamp}`, { delay: 30 }); await wait(500);
await content(ids.p1).click(); await wait(2600);
out.marks = await rows(); await shot("01-marks");
// (1) Backspace in the emptied uncited row: gone; caret at the end of the row above.
await emptyRow(`dc${stamp}`); out.uncitedEmptied = await rows();
await page.keyboard.press("Backspace"); await wait(1500); out.afterBackspaceUncited = { rows: await rows(), caret: await caret() };
// (2) Backspace in the emptied cited row: asks first.
await emptyRow("删测乙"); await page.keyboard.press("Backspace"); await wait(800);
out.dialog = await page.evaluate(() => document.querySelector(".ofn-v3-confirm")?.textContent ?? null); await shot("02-dialog");
if (out.dialog) { await page.locator(".ofn-v3-confirm").getByRole("button", { name: "确定", exact: true }).click(); await wait(1500); }
out.afterCitedDelete = { rows: await rows(), p2Sups: await sups(ids.p2) };
// (3) Orca's own delete of a footer row (as the block menu or Delete on a selected row does).
await clickEnd("删测甲"); await page.keyboard.press("Enter"); await wait(500); await page.keyboard.type(`dd${stamp}`, { delay: 30 }); await wait(500);
await content(ids.p2).click(); await wait(2600); out.beforeNativeDelete = await rows();
const ddRow = await mirrorOf(`dd${stamp}`);
await page.evaluate(id => orca.commands.invokeEditorCommand("core.editor.deleteBlocks", null, [id]), ddRow); await wait(2600);
out.afterNativeDeleteUncited = { rows: await rows(), inBin: await binHas(`dd${stamp}`) };
const jiaRow = await mirrorOf("删测甲");
await page.evaluate(id => orca.commands.invokeEditorCommand("core.editor.deleteBlocks", null, [id]), jiaRow); await wait(800);
out.nativeDeleteCitedDialog = await page.evaluate(() => document.querySelector(".ofn-v3-confirm")?.textContent ?? null);
if (out.nativeDeleteCitedDialog) { await page.locator(".ofn-v3-confirm").getByRole("button", { name: "确定", exact: true }).click(); await wait(1800); }
out.afterNativeDeleteCited = { rows: await rows(), p1Sups: await sups(ids.p1), inBin: await binHas("删测甲") };
// (4) An uncited footnote left empty is dropped once the caret leaves.
await insert(ids.p1, `删测丁${stamp}`);
await clickEnd("删测丁"); await page.keyboard.press("Enter"); await wait(500); await page.keyboard.type(`de${stamp}`, { delay: 30 }); await wait(500);
await content(ids.p2).click(); await wait(2600); out.beforeBlank = await rows();
await emptyRow(`de${stamp}`); await content(ids.p2).click(); await wait(2800); out.afterBlankLeft = await rows();
// (5) The popup: a rule and a title between this range and the rest.
await content(ids.p2).click(); await page.keyboard.press("End"); await wait(150);
await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(300);
await page.keyboard.type("删测"); await wait(1400);
out.popup = await page.evaluate(() => { const p = document.querySelector("[data-ofn-input-popup]"); return p ? [...p.children].map(n => n.classList.contains("orca-menu-text") ? `${n.classList.contains("orca-key-selected") ? "▶" : " "} ${n.textContent.trim().slice(0, 30)}` : `— ${n.className.slice(0, 30)} ${n.textContent.trim()}`) : null; });
await shot("03-popup");
await page.keyboard.press("Escape"); await wait(200); for (let i = 0; i < 2; i++) { await page.keyboard.press("Backspace"); await wait(80); }
await page.evaluate(({ panel, back }) => { if (back.view && back.args) orca.nav.goTo(back.view, back.args, panel); }, { panel, back }); await wait(400);
console.log(JSON.stringify({ ids, ...out, logs }, null, 1)); await browser.close();
