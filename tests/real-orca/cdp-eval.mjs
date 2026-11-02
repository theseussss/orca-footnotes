// Evaluate a JS expression file in the Orca window of the agreed test library.
//   OFN_TEST_REPO=<repo> node tests/real-orca/cdp-eval.mjs <file.js>   (file exports an async function body)
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
const expectedRepo = process.env.OFN_TEST_REPO; if (!expectedRepo) throw new Error("Set OFN_TEST_REPO.");
const code = await readFile(process.argv[2], "utf8");
const browser = await chromium.connectOverCDP(process.env.OFN_CDP ?? "http://127.0.0.1:9222");
let page;
for (const candidate of browser.contexts().flatMap(c => c.pages())) if (await candidate.evaluate(() => typeof window.orca === "object").catch(() => false)) { page = candidate; break; }
if (!page) throw new Error("No Orca window.");
const repo = await page.evaluate(() => orca.state.repo);
if (repo !== expectedRepo) { await browser.close(); throw new Error(`Open library ${repo} is not ${expectedRepo}; nothing done.`); }
const result = await page.evaluate(`(async () => { ${code} })()`);
console.log(typeof result === "string" ? result : JSON.stringify(result, null, 1));
if (process.env.OFN_SHOT) await page.screenshot({ path: process.env.OFN_SHOT });
await browser.close();
