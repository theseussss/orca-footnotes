// Journal pages (real Orca, test library): the drawn 尾注 tab is on every day,
// first and chosen; a day with footnotes shows them in it; a day without says
// 这一天没有尾注; 0.7.0-dev's entry in the journals' shared custom queries is
// gone. Writes one footnote into today's journal of the test library.
//   OFN_TEST_REPO=<repo> [OFN_CDP=http://127.0.0.1:9223] node tests/real-orca/cdp-v40-journal.mjs
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page; for (const c of browser.contexts().flatMap(x => x.pages())) if (await c.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = c; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library; nothing done."); }
const logs = []; page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on("pageerror", e => logs.push(`pageerror: ${String(e).slice(0, 300)}`));
const wait = ms => page.waitForTimeout(ms), out = {}, shot = n => page.screenshot({ path: `test-results/v40-journal-${n}.png` });
const panel = await page.evaluate(() => orca.state.activePanel);
const back = await page.evaluate(p => { const v = orca.nav.findViewPanel(p, orca.state.panels); return { view: v?.view, args: v?.viewArgs }; }, panel);
const stamp = await page.evaluate(() => new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19).replace(/:/g, ""));
const goJournal = async date => { await page.evaluate(({ panel, date }) => orca.nav.goTo("journal", { date: new Date(date) }, panel), { panel, date }); await wait(1500); };
const editorId = () => page.evaluate(() => document.querySelector(".orca-panel .orca-hideable:not(.orca-hideable-hidden) > .orca-block-editor")?.dataset.blockId ?? null);
const view = id => page.evaluate(id => { const ed = document.querySelector(`.orca-panel .orca-hideable:not(.orca-hideable-hidden) > .orca-block-editor[data-block-id="${id}"]`), panelEl = ed?.querySelector(".ofn-v3-tab-panel"), note = panelEl?.querySelector(".ofn-v3-tab-note");
  return { tabs: [...(ed?.querySelectorAll(".orca-block-editor-query-tabs .orca-segmented-item") ?? [])].filter(x => !x.classList.contains("orca-transition")).map(x => `${x.classList.contains("orca-selected") ? "*" : ""}${x.classList.contains("ofn-v3-tab-item") ? "+" : ""}${x.textContent.trim()}`),
    note: note && getComputedStyle(note).display !== "none" ? note.textContent : null, rows: [...(panelEl?.querySelectorAll(".ofn-v3-section-footer > .orca-repr-children > .orca-block .orca-repr-main-content") ?? [])].map(n => n.textContent.replace("尾注​", "")) }; }, id);
const today = await page.evaluate(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); });
await goJournal(today);
// Only the shown editor: Orca keeps hidden editors of the same day in its panel tabs.
const todayId = await editorId(), ed = `.orca-panel .orca-hideable:not(.orca-hideable-hidden) > .orca-block-editor[data-block-id="${todayId}"]`;
const para = await page.evaluate(async ({ id, stamp }) => orca.commands.invokeEditorCommand("core.editor.insertBlock", null, orca.state.blocks[id], "firstChild", [{ t: "t", v: `日志段落 ${stamp}` }]), { id: Number(todayId), stamp });
await wait(800);
await page.locator(`${ed} .orca-block-editor-blocks .orca-block[data-id="${para}"] > .orca-repr .orca-repr-main-content`).first().click(); await page.keyboard.press("End"); await wait(150);
await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(300);
await page.keyboard.type(`日志尾注${stamp}`); await wait(800); await page.keyboard.press("Enter"); await wait(2500);
out.today = { ...(await view(todayId)), sharedQueries: await page.evaluate(() => (orca.state.settings[1004] ?? []).map(q => `${q.name}:${q.view}`)) };
await shot("01-today");
await goJournal(today - 86400_000 * 3); const otherId = await editorId(); out.otherDay = await view(otherId); await shot("02-other-day");
await page.evaluate(({ panel, back }) => { if (back.view && back.args) orca.nav.goTo(back.view, back.args, panel); }, { panel, back }); await wait(300);
console.log(JSON.stringify({ ...out, logs }, null, 1)); await browser.close();
