/**
 * Build the GitHub Pages site in docs/.
 * The Pages build is client-side: it ships the Pointercrate snapshot so the
 * game can run without a Node server. The full server-authoritative game stays
 * in the repository root.
 *
 * Run: node scripts/build-static.mjs
 */
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pairs = [
  ["index.html", "docs/index.html"],
  ["styles.css", "docs/styles.css"],
  ["js/core.js", "docs/js/core.js"],
  ["js/player.js", "docs/js/player.js"],
  ["data/demons.json", "docs/data/demons.json"],
];

for (const [from, to] of pairs) {
  const target = resolve(root, to);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(root, from), target);
}

await writeFile(resolve(root, "docs/.nojekyll"), "", "utf8");
console.log("Static Pages site written to docs/");
