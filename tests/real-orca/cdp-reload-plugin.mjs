// Reload one plugin in the agreed test library and report console errors.
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-reload-plugin.mjs [name]
import { chromium } from "playwright";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const name = process.argv[2] ?? "orca-footnotes";
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page;
for (const candidate of browser.contexts().flatMap(c => c.pages())) if (await candidate.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = candidate; break; }
const repo = await page.evaluate(() => orca.state.repo);
if (repo !== expectedRepo) { await browser.close(); throw new Error(`Open library ${repo} is not ${expectedRepo}; nothing done.`); }
const logs = [];
page.on("console", message => { if (["error", "warning"].includes(message.type())) logs.push(`${message.type()}: ${message.text().slice(0, 400)}`); });
page.on("pageerror", error => logs.push(`pageerror: ${String(error).slice(0, 400)}`));
const result = await page.evaluate(async name => {
  try { await orca.plugins.disable(name); await new Promise(r => setTimeout(r, 400)); await orca.plugins.enable(name); await new Promise(r => setTimeout(r, 1500));
    return { enabled: orca.state.plugins[name]?.enabled, version: document.querySelector("style[data-ofn-v3]")?.dataset.ofnV3 ?? null };
  } catch (error) { return { error: String(error) }; }
}, name);
await page.waitForTimeout(800);
console.log(JSON.stringify({ result, logs }, null, 1));
await browser.close();
