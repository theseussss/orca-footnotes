// v3 in the real Orca test library: undo of an insertion and an upper
// collection level with mirrors.
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-v3-more.mjs
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page;
for (const candidate of browser.contexts().flatMap(c => c.pages())) if (await candidate.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = candidate; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library; nothing done."); }
const logs = []; page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
const wait = ms => page.waitForTimeout(ms), out = {}, shot = n => page.screenshot({ path: `test-results/v3-more-${n}.png` });
const make = (titles) => page.evaluate(async titles => {
  const cmd = (...a) => orca.commands.invokeEditorCommand(...a), t = v => [{ t: "t", v }], stamp = new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19), o = {};
  await orca.commands.invokeGroup(async () => {
    for (const [key, parentKey, text] of titles) o[key] = await cmd("core.editor.insertBlock", null, parentKey ? orca.state.blocks[o[parentKey]] : null, parentKey ? "lastChild" : null, t(text.replace("{t}", stamp)));
  }); return o;
}, titles);
const go = async id => { await page.evaluate(id => orca.nav.goTo("block", { blockId: id }), id); await wait(1200); };
const insertAtEnd = async (rootId, blockId, text, pick = false) => {
  const el = page.locator(`.orca-block-editor[data-block-id="${rootId}"] .orca-block[data-id="${blockId}"] > .orca-repr .orca-repr-main-content`).first();
  await el.click(); await page.keyboard.press("End"); await wait(150);
  await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(250);
  await page.keyboard.type(text); await wait(500); if (pick) { await page.keyboard.press("ArrowDown"); await wait(100); }
  await page.keyboard.press("Enter"); await wait(1600);
};
const frag = (id) => page.evaluate(id => { const b = orca.state.blocks[id]; return (b?.content ?? []).map(f => f.t === "r" ? `[r→${b.refs.find(r => r.id === f.v)?.to}]` : f.v).join(""); }, id);
const sectionOf = id => page.evaluate(id => { const b = x => orca.state.blocks[x]; const s = (b(id)?.children ?? []).map(b).find(x => x?.properties?.some(p => p.name === "_repr" && p.value?.type === "orca-footnotes.section"));
  return s ? { id: s.id, rows: s.children.map(c => ({ id: c, text: b(c)?.text, mirrorOf: b(c)?.properties?.find(p => p.name === "_repr")?.value?.mirroredId ?? null })) } : null; }, id);
const rowsDom = rootId => page.evaluate(rootId => { const editor = [...document.querySelectorAll(".orca-block-editor[data-block-id]")].find(e => e.dataset.blockId === String(rootId) && !e.closest(".orca-hideable-hidden"));
  const section = editor?.querySelector(".ofn-v3-section-footer"); return section ? [...section.querySelectorAll(":scope > .orca-repr-children > .orca-block")].map(r => `${r.querySelector(".orca-block-handle")?.getAttribute("data-icon") ?? "·"} ${r.textContent.trim().slice(0, 30)}`) : null; }, rootId);

// ---- A: undo of one insertion ----
const u = await make([["page", null, "撤销测试 {t}"], ["p1", "page", "一段正文"]]);
await go(u.page); await insertAtEnd(u.page, u.p1, "撤销用引文");
out.undoBefore = { body: await frag(u.p1), section: await sectionOf(u.page) };
await page.keyboard.press("Control+z"); await wait(1200);
out.undoAfter1 = { body: await frag(u.p1), section: await sectionOf(u.page) };
await page.keyboard.press("Control+z"); await wait(1200);
out.undoAfter2 = { body: await frag(u.p1), section: await sectionOf(u.page) };

// ---- B: recovering from the recycle bin is in cdp-v35-bin.mjs (the bin is a page now) ----

// ---- C: upper collection level ----
const c = await make([["book", null, "书 P {t}"], ["a", "book", "第一章 A"], ["aBody", "a", "A 的正文"], ["b", "book", "第二章 B"], ["bBody", "b", "B 的正文"]]);
await go(c.a); await insertAtEnd(c.a, c.aBody, "甲·来自 A");
await go(c.b); await insertAtEnd(c.b, c.bBody, "乙·来自 B");
out.beforeScope = { a: await sectionOf(c.a), b: await sectionOf(c.b), bDom: await rowsDom(c.b) };
// choose P in B's footer scope picker
const editorB = `.orca-block-editor[data-block-id="${c.b}"]`;
await page.locator(`${editorB} .ofn-v3-section-footer .ofn-next-scope-button`).click(); await wait(400);
out.scopeOptions = await page.evaluate(() => [...document.querySelectorAll(".orca-context-menu .orca-menu-text")].map(n => n.textContent));
await page.locator(".orca-context-menu .orca-menu-text").nth(1).click(); await wait(2500);
out.afterScopeB = { section: await sectionOf(c.b), dom: await rowsDom(c.b), bodyB: await frag(c.bBody) };
await shot("01-scope-B");
await go(c.a); await wait(1500);
out.afterScopeA = { section: await sectionOf(c.a), dom: await rowsDom(c.a) };
await shot("02-scope-A");
console.log(JSON.stringify({ u, c, ...out, logs }, null, 1));
await browser.close();
