// Set one orca-footnotes setting in the agreed test library (for regression runs).
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-set-setting.mjs <key> <value>
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const [key, value] = process.argv.slice(2); if (!key) throw new Error("Usage: cdp-set-setting.mjs <key> <value>");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page; for (const c of browser.contexts().flatMap(x => x.pages())) if (await c.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = c; break; }
if ((await page.evaluate(() => orca.state.repo)) !== expectedRepo) { await browser.close(); throw new Error("Not the test library; nothing done."); }
const result = await page.evaluate(async ({ key, value }) => { const name = "orca-footnotes";
  await orca.plugins.setSettings("repo", name, { ...orca.state.plugins[name]?.settings, [key]: value }); return orca.state.plugins[name]?.settings?.[key]; }, { key, value });
console.log(JSON.stringify({ [key]: result })); await browser.close();
