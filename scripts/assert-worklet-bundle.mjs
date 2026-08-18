/**
 * Build assertion: the worklet bundle must be a single self-contained file.
 *
 * AudioWorkletGlobalScope has no module loader on older targets, so a stray
 * `import` in dist/tuninator-worklet.js fails only at runtime, in the browser,
 * with an error that points nowhere useful. Catch it at build time instead.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(root, "dist", "tuninator-worklet.js");

let source;
try {
  source = await readFile(bundlePath, "utf8");
} catch {
  console.error(`FAIL: ${bundlePath} was not produced by the build.`);
  process.exit(1);
}

// Strip comments and string literals before scanning, so the word "import"
// inside a doc comment or a message never trips the assertion.
const stripped = source
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/`(?:[^`\\]|\\.)*`/g, "``");

const problems = [];
if (/(^|[\s;}])import\s*[({*'"]/.test(stripped) || /\bimport\s+[\w{*]/.test(stripped)) {
  problems.push("contains an `import` statement");
}
if (/(^|[\s;}])export\s+/.test(stripped)) {
  problems.push("contains an `export` statement");
}
if (!/registerProcessor\s*\(/.test(stripped)) {
  problems.push("never calls registerProcessor()");
}

if (problems.length > 0) {
  console.error(`FAIL: dist/tuninator-worklet.js ${problems.join(", ")}.`);
  console.error("The worklet build must be a single self-contained IIFE.");
  process.exit(1);
}

const kb = (source.length / 1024).toFixed(1);
console.log(`OK: dist/tuninator-worklet.js is self-contained (${kb} kB).`);
