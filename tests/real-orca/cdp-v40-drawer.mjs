// The drawer directory (real Orca, test library): lines on the editor's right
// edge between the text and Orca's side buttons, no box; the pointer near the
// edge floats the nearby entries out (nearest most, with its text; neighbours
// less), resting shows the full text, leaving springs everything back; a
// floated entry is clickable; a menu keeps it out; mode 整条滑出 shows every
// entry; follow 阅读位置 floats the entries cited mid-screen a little.
//   OFN_TEST_REPO=<repo> [OFN_CDP=http://127.0.0.1:9223] node tests/real-orca/cdp-v40-drawer.mjs
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page; for (const c of browser.contexts().flatMap(x => x.pages())) if (await c.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = c; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library; nothing done."); }
const logs = []; page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on("pageerror", e => logs.push(`pageerror: ${String(e).slice(0, 300)}`));
const wait = ms => page.waitForTimeout(ms), out = {}, shot = n => page.screenshot({ path: `test-results/v40-drawer-${n}.png` });
const name = "orca-footnotes";
const panel = await page.evaluate(() => orca.state.activePanel);
const back = await page.evaluate(p => { const v = orca.nav.findViewPanel(p, orca.state.panels); return { view: v?.view, args: v?.viewArgs }; }, panel);
const setSetting = (key, value) => page.evaluate(async ({ name, key, value }) => { await orca.plugins.setSettings("repo", name, { ...orca.state.plugins[name]?.settings, [key]: value }); }, { name, key, value });
for (const [k, v] of [["directoryStyle", "drawer"], ["drawerMode", "local"], ["drawerFollow", "pointer"]]) await setSetting(k, v);
await page.evaluate(() => { const rt = window.__ofnV3; if (rt && !document.querySelector(".ofn-v3-drawer")) rt.toggleNavigator(); }); await wait(300);
const stamp = await page.evaluate(() => new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19).replace(/:/g, ""));
const ids = await page.evaluate(async stamp => { const cmd = (...a) => orca.commands.invokeEditorCommand(...a), o = {};
  await orca.commands.invokeGroup(async () => { o.page = await cmd("core.editor.insertBlock", null, null, null, [{ t: "t", v: `抽屉测试 ${stamp}` }]);
    for (const k of [1, 2, 3, 4, 5]) o[`p${k}`] = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", [{ t: "t", v: `正文第${k}段` }]); }); return o; }, stamp);
await page.evaluate(({ panel, id }) => orca.nav.goTo("block", { blockId: id }, panel), { panel, id: ids.page }); await wait(1300);
const ed = `.orca-block-editor[data-block-id="${ids.page}"]`;
const content = id => page.locator(`${ed} .orca-block-editor-blocks .orca-block[data-id="${id}"] > .orca-repr .orca-repr-main-content`).first();
const insert = async (id, text) => { await content(id).click(); await page.keyboard.press("End"); await wait(150);
  await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(300);
  await page.keyboard.type(text); await wait(700); await page.keyboard.press("Enter"); await wait(1300); };
// Distinct texts: the input preselects an existing footnote of this page that matches what is typed.
const long = `长条目 张三, 李四. 竞合视角下的内卷式竞争: 概念、测度与空间格局. 地理学报, 2024. 这一条故意写长，用来看展开后的全文。`;
for (const [k, text] of [[1, `甲${stamp}`], [2, `乙文献`], [3, long], [4, `丁报告`], [5, `戊资料`]]) await insert(ids[`p${k}`], text);
await page.mouse.move(400, 650); await wait(1200);
const drawer = () => page.evaluate(() => {
  const root = document.querySelector(".ofn-v3-drawer"); if (!root) return { drawer: false };
  const tx = el => { if (!el) return null; const m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return Math.round(m.m41); };
  const rows = [...root.querySelectorAll(".ofn-v3-drawer-row")].map(row => { const line = row.querySelector(".ofn-v3-drawer-line"), label = row.querySelector(".ofn-v3-drawer-label"), b = line?.getBoundingClientRect();
    return { x: tx(row.querySelector(".ofn-v3-drawer-mover")), line: b ? [Math.round(b.left), Math.round(b.top)] : null, label: label ? `${label.classList.contains("is-full") ? "full" : label.classList.contains("is-num") ? "num" : "text"}:${label.textContent.slice(0, 14)}` : null }; });
  const cs = getComputedStyle(root), tools = document.querySelector(".orca-block-editor-sidetools")?.getBoundingClientRect(), main = document.querySelector(".orca-panel .orca-hideable:not(.orca-hideable-hidden) > .orca-block-editor > .orca-block-editor-main")?.getBoundingClientRect();
  return { drawer: true, bg: cs.backgroundColor, border: cs.borderTopWidth, shadow: cs.boxShadow, pointer: cs.pointerEvents, rows, textRight: main ? Math.round(main.right) : null, toolsLeft: tools ? Math.round(tools.left) : null };
});
const lineY = async i => (await drawer()).rows[i]?.line?.[1];
// Aim at an entry's place at rest (while floating, the entries around the focus move apart).
let restLines = null;
const toEdge = async (i, dx = 6) => { const r = restLines?.[i] ?? (await drawer()).rows[i]?.line; if (!r) return; await page.mouse.move(r[0] + dx, r[1] + 1, { steps: 6 }); };
try {
  // Keyboard focus inside the drawer keeps it out (for keyboard users); note it and let it go before measuring rest.
  out.focusInDrawer = await page.evaluate(() => { const a = document.activeElement; const inside = !!a?.closest?.(".ofn-v3-drawer"); if (inside) a.blur(); return inside; });
  if (out.focusInDrawer) await wait(800);
  out.rest = await drawer(); restLines = out.rest.rows.map(r => r.line); await shot("01-rest");
  await toEdge(2); await wait(350); out.near3 = await drawer(); await shot("02-near-3");
  await wait(700); out.dwell3 = await drawer(); await shot("03-full-3");
  await toEdge(0); await wait(400); out.near1 = await drawer();
  await page.mouse.move(400, 650, { steps: 4 }); await wait(900); out.left = await drawer();
  // A floated entry is clickable: to its citation in the body.
  await toEdge(4); await wait(900); const label = page.locator(".ofn-v3-drawer-label").filter({ hasText: "戊资料" }).first();
  if (await label.count()) { await label.click(); await wait(900); }
  out.clicked = await page.evaluate(() => (document.getSelection()?.anchorNode?.parentElement?.closest(".orca-repr-main-content")?.textContent ?? "").slice(0, 20));
  // A menu keeps it out; Escape and leaving let it go.
  await toEdge(1); await wait(500); const hit = page.locator(".ofn-v3-drawer-hit").nth(1); await hit.click({ button: "right" }); await wait(400);
  out.menu = { open: await page.locator(".orca-context-menu").count() }; await page.mouse.move(400, 650, { steps: 3 }); await wait(700);
  out.menu.heldX = (await drawer()).rows[1]?.x; await page.keyboard.press("Escape"); await wait(900); out.menu.afterEsc = (await drawer()).rows.map(r => r.x);
  // Mode 整条滑出.
  await setSetting("drawerMode", "slide"); await wait(500); await toEdge(2); await wait(300); out.slideMoving = await drawer(); await shot("04-slide-moving");
  await wait(600); out.slide = await drawer(); await shot("04-slide");
  await page.mouse.move(400, 650, { steps: 4 }); await wait(900); await setSetting("drawerMode", "local");
  // Follow 阅读位置: with the pointer away, entries cited mid-screen float a little.
  await setSetting("drawerFollow", "reading"); await wait(700); await page.mouse.move(400, 650); await wait(900);
  out.reading = (await drawer()).rows.map(r => r.x); await shot("05-reading");
  await setSetting("drawerFollow", "pointer"); await wait(500);
} catch (error) { out.error = String(error).slice(0, 500); await shot("09-error").catch(() => {}); }
for (const [k, v] of [["drawerMode", "local"], ["drawerFollow", "pointer"]]) await setSetting(k, v).catch(() => {});
await page.evaluate(({ panel, back }) => { if (back.view && back.args) orca.nav.goTo(back.view, back.args, panel); }, { panel, back }); await wait(300);
console.log(JSON.stringify({ ids, ...out, logs }, null, 1)); await browser.close();
