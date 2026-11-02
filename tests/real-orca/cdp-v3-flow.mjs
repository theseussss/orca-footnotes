// End-to-end v3 flow in the real Orca test library, driven like a user.
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-v3-flow.mjs
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page;
for (const candidate of browser.contexts().flatMap(c => c.pages())) if (await candidate.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = candidate; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library; nothing done."); }
const logs = [];
page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on("pageerror", e => logs.push(`pageerror: ${String(e).slice(0, 300)}`));
const out = {}, shot = async name => page.screenshot({ path: `test-results/v3-${name}.png` });
const wait = ms => page.waitForTimeout(ms);
const ids = await page.evaluate(async () => {
  const stamp = new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19), cmd = (...a) => orca.commands.invokeEditorCommand(...a), t = v => [{ t: "t", v }];
  const o = {};
  await orca.commands.invokeGroup(async () => {
    o.page = await cmd("core.editor.insertBlock", null, null, null, t(`尾注 v3 测试 ${stamp}`));
    o.p1 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", t("第一段正文"));
    o.p2 = await cmd("core.editor.insertBlock", null, orca.state.blocks[o.page], "lastChild", t("第二段正文"));
  });
  return o;
});
await page.evaluate(id => orca.nav.goTo("block", { blockId: id }), ids.page);
await wait(1200);
const caretEnd = async blockId => { const el = page.locator(`.orca-block[data-id="${blockId}"] > .orca-repr .orca-repr-main-content`).first(); await el.click(); await page.keyboard.press("End"); await wait(150); };
const startInsert = async () => { await page.evaluate(() => orca.commands.invokeEditorCommand("orca-footnotes.insert", null)); await wait(300); };
// 1) new footnote in paragraph 1
await caretEnd(ids.p1); await startInsert(); await page.keyboard.type("甲文献，第 3 页"); await wait(400);
out.popup1 = await page.evaluate(() => [...document.querySelectorAll("[data-ofn-input-popup] .orca-menu-text")].map(n => n.textContent));
await shot("01-typing");
await page.keyboard.press("Enter"); await wait(1500);
if (process.env.OFN_STOP_AFTER_FIRST) {
  out.first = await page.evaluate(ids => { const b = id => orca.state.blocks[id]; return { pageChildren: b(ids.page)?.children, p1: b(ids.p1)?.content, p1refs: b(ids.p1)?.refs,
    popup: [...document.querySelectorAll("[data-ofn-input-popup] .orca-menu-text")].map(n => n.textContent), notices: [...document.querySelectorAll(".orca-notification, .orca-toast, [class*=notif]")].map(n => n.textContent).slice(0, 5) }; }, ids);
  await shot("01b-after-enter"); console.log(JSON.stringify({ ids, ...out, logs }, null, 1)); await browser.close(); process.exit(0);
}
// 2) new footnote in paragraph 2
await caretEnd(ids.p2); await startInsert(); await page.keyboard.type("乙文献"); await wait(400); await page.keyboard.press("Enter"); await wait(1500);
// 3) cite the existing first entry again at the end of paragraph 2
await caretEnd(ids.p2); await startInsert(); await page.keyboard.type("甲"); await wait(400);
out.popup3 = await page.evaluate(() => [...document.querySelectorAll("[data-ofn-input-popup] .orca-menu-text")].map(n => n.textContent));
// A matching footnote already in this page is preselected.
await page.keyboard.press("Enter"); await wait(1800);
await shot("02-after-inserts");
out.data = await page.evaluate(ids => {
  const b = id => orca.state.blocks[id], pageBlock = b(ids.page);
  const kids = pageBlock?.children ?? [], section = kids.map(b).find(x => x?.properties?.some(p => p.name === "_repr" && p.value?.type === "orca-footnotes.section"));
  const frag = id => (b(id)?.content ?? []).map(f => f.t === "r" ? `[r${f.f ? ":" + f.f : ""}→${b(id).refs.find(r => r.id === f.v)?.to}]` : f.v).join("");
  return { pageChildren: kids, section: section ? { id: section.id, text: section.text, children: section.children.map(id => ({ id, text: b(id)?.text, repr: b(id)?.properties?.find(p => p.name === "_repr")?.value })) } : null,
    p1: frag(ids.p1), p2: frag(ids.p2) };
}, ids);
out.dom = await page.evaluate(ids => {
  const editor = [...document.querySelectorAll(".orca-block-editor[data-block-id]")].find(e => e.dataset.blockId === String(ids.page) && !e.closest(".orca-hideable-hidden"));
  const sups = [...editor.querySelectorAll(".orca-inline.ofn-vnext-note")].map(n => n.querySelector(".orca-inline-r-content")?.getAttribute("data-ofn-number"));
  const section = editor.querySelector(".ofn-v3-section-footer"), rows = section ? [...section.querySelectorAll(":scope > .orca-repr-children > .orca-block")].map(r => ({ id: r.dataset.id, mirror: r.dataset.mirrorId ?? null,
    icon: r.querySelector(".orca-block-handle")?.getAttribute("data-icon"), tagsVisible: !!r.querySelector(".orca-tags") && r.querySelector(".orca-tags").getBoundingClientRect().width > 0 && getComputedStyle(r.querySelector(".orca-tags")).opacity !== "0" })) : null;
  const header = editor.querySelector(".ofn-v3-section-header")?.textContent;
  const directory = [...document.querySelectorAll(".ofn-v3-dir .ofn-v3-dir-item")].map(n => n.textContent);
  return { sups, rows, header, directory };
}, ids);
// 4) click the second superscript -> jump to footer row
const sup = page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .orca-inline.ofn-vnext-note`).nth(1); await sup.click(); await wait(800);
out.afterClick = await page.evaluate(() => ({ highlighted: [...document.querySelectorAll(".ofn-next-footer-highlight")].map(n => n.dataset.id) }));
await shot("03-after-click");
if (process.env.OFN_OPS) {
  const info = await page.evaluate(ids => { const pageBlock = orca.state.blocks[ids.page]; const section = pageBlock.children.map(id => orca.state.blocks[id]).find(b => b?.properties?.some(p => p.name === "_repr" && p.value?.type === "orca-footnotes.section"));
    return { section: section.id, e1: section.children[0], e2: section.children[1] }; }, ids);
  out.info = info;
  const rowContent = id => page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .orca-block[data-id="${id}"] > .orca-repr .orca-repr-main-content`).first();
  const texts = () => page.evaluate(info => ({ e1: orca.state.blocks[info.e1]?.text, e2: orca.state.blocks[info.e2]?.text, e2Parent: orca.state.blocks[info.e2]?.parent, section: [...(orca.state.blocks[info.section]?.children ?? [])] }), info);
  // (a) Backspace at the start of entry 2 must not merge it into entry 1
  await rowContent(info.e2).click(); await page.keyboard.press("Home"); await page.keyboard.press("Backspace"); await wait(700); out.guardBackspace = await texts();
  // (b) Delete at the end of entry 1 must not pull entry 2 in
  await rowContent(info.e1).click(); await page.keyboard.press("End"); await page.keyboard.press("Delete"); await wait(700); out.guardDelete = await texts();
  // (c) ordinary native typing inside an entry
  await page.keyboard.type("，再版"); await wait(800); out.typed = await texts();
  // (d) click the [2] handle -> back to the citation in the body
  await page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .orca-block[data-id="${info.e2}"] .orca-block-handle`).first().click(); await wait(700);
  out.handleClick = await page.evaluate(() => ({ highlighted: [...document.querySelectorAll(".ofn-next-navigation-highlight")].map(n => n.closest(".orca-block")?.dataset.id), locations: !!document.querySelector(".ofn-next-locations") }));
  await shot("04-handle-click");
  // (e) right-click a superscript -> our menu -> edit content puts the caret into the entry
  await page.locator(`.orca-block-editor[data-block-id="${ids.page}"] .orca-inline.ofn-vnext-note`).first().click({ button: "right" }); await wait(400);
  out.markerMenu = await page.evaluate(() => [...document.querySelectorAll(".orca-context-menu .orca-menu-text")].map(n => n.textContent));
  await page.locator(".orca-context-menu .orca-menu-text").getByText("编辑注释内容", { exact: true }).click(); await wait(700);
  out.caretAfterEdit = await page.evaluate(() => { const s = document.getSelection(); const el = s?.anchorNode instanceof Element ? s.anchorNode : s?.anchorNode?.parentElement; return el?.closest(".orca-block")?.dataset.id ?? null; });
  // (f) delete entry 2 via actions (directory row menu path) -> recycle bin
  await page.locator(".ofn-v3-dir .ofn-v3-dir-row").nth(1).hover(); await page.locator(".ofn-v3-dir .ofn-v3-dir-more").nth(1).click(); await wait(300);
  await page.locator(".orca-context-menu .orca-menu-text").getByText("删除尾注", { exact: true }).click(); await wait(400);
  out.deletionDialog = await page.evaluate(() => document.querySelector(".ofn-v3-confirm")?.textContent ?? null);
  await page.locator(".ofn-v3-confirm").getByRole("button", { name: "确定", exact: true }).click(); await wait(1500);
  out.afterDelete = await page.evaluate(({ ids, info }) => { const b = id => orca.state.blocks[id];
    const frag = id => (b(id)?.content ?? []).map(f => f.t === "r" ? `[r→${b(id).refs.find(r => r.id === f.v)?.to}]` : f.v).join("");
    const bin = b(info.e2)?.parent; return { p1: frag(ids.p1), p2: frag(ids.p2), e2Parent: bin, binText: b(bin)?.text, binAlias: b(bin)?.aliases, state: b(info.e2)?.properties?.find(p => p.name === "orca-footnotes.state")?.value,
      directory: [...document.querySelectorAll(".ofn-v3-dir .ofn-v3-dir-item")].map(n => n.textContent) }; }, { ids, info });
  await shot("05-after-delete");
}
console.log(JSON.stringify({ ids, ...out, logs }, null, 1));
await browser.close();
