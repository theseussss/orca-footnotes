// Build the plugin into build/orca-footnotes; with --zip also pack
// release/orca-footnotes-v<version>.zip (package.json, LICENSE, icons, dist/)
// as the Orca Note plugin marketplace expects.
import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const meta = JSON.parse(await readFile("package.json", "utf8")), version = meta.version, output = "build/orca-footnotes";
await rm(output, { recursive: true, force: true });
await mkdir(`${output}/dist`, { recursive: true });
const result = await build({ entryPoints: ["src/v3/main.tsx"], outfile: `${output}/dist/index.js`, bundle: true, format: "esm",
  target: "chrome120", platform: "browser", jsx: "transform", jsxFactory: "React.createElement", jsxFragment: "React.Fragment",
  loader: { ".css": "text" }, metafile: true, legalComments: "none", define: { "process.env.NODE_ENV": '"production"' } });
const product = result.metafile.outputs[`${output}/dist/index.js`];
// React and Valtio come from Orca itself (window.React / window.Valtio); nothing is imported at runtime.
if (product.imports.length) throw new Error(`Runtime imports: ${JSON.stringify(product.imports)}`);
await writeFile(`${output}/package.json`, JSON.stringify({ name: meta.name, version, description: meta.description, license: meta.license, author: meta.author, type: "module" }, null, 2) + "\n");
for (const file of ["LICENSE", "icon.png", "icon.svg"]) await copyFile(file, `${output}/${file}`);
console.log(`Built ${version}: ${output} (${product.bytes} bytes)`);
if (process.argv.includes("--zip")) {
  await mkdir("release", { recursive: true });
  const zip = `release/orca-footnotes-v${version}.zip`; await rm(zip, { force: true });
  execFileSync("zip", ["-q", "-r", `../../${zip}`, "package.json", "LICENSE", "icon.png", "icon.svg", "dist"], { cwd: output });
  console.log(`Packed ${zip}`);
}
