// Orca Note's plugin API declarations, used only for type checking. They come
// from the official plugin template at a fixed commit and are not committed here.
import { mkdir, writeFile } from "node:fs/promises";
const url = "https://raw.githubusercontent.com/sethyuan/orca-plugin-template/ecb5f00fd5c0e2b620e0854efc7fc940b4a0ae9a/src/orca.d.ts";
const response = await fetch(url);
if (!response.ok) throw new Error(`${response.status} ${url}`);
await mkdir("vendor", { recursive: true });
await writeFile("vendor/orca.d.ts", await response.text());
console.log("vendor/orca.d.ts ready");
