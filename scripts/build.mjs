import { build } from "esbuild";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/jsonviewer.mjs"],
  outfile: "jsonviewer.js",
  bundle: true,
  format: "iife",
  target: ["chrome102", "edge102"],
  minify: true,
  legalComments: "eof",
  metafile: true,
});

const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.replaceAll("\\", "/").match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (match) packages.add(match[1]);
}

const notices = ["Third-party packages bundled in jsonviewer.js\n"];
for (const name of [...packages].sort()) {
  const directory = resolve(root, "node_modules", name);
  const metadata = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  const licenseFile = (await readdir(directory)).find((file) => /^licen[sc]e(?:\.|$)/i.test(file));
  if (!licenseFile) throw new Error(`Missing license for ${name}`);
  const license = await readFile(resolve(directory, licenseFile), "utf8");
  notices.push(`${name} ${metadata.version} (${metadata.license})\n${license.trim()}\n`);
}
await writeFile(resolve(root, "THIRD_PARTY_NOTICES.txt"), notices.join("\n---\n\n"));
console.log("Built local JSON viewer and third-party notices.");
