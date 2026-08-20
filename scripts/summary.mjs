// Compact eval summary for A/B comparison. Not part of the library.
import fs from "node:fs";
const path = process.argv[2] ?? ".cache/eval-report.json";
const r = JSON.parse(fs.readFileSync(path, "utf8"));
const rows = [];
for (const f of r.fixtures) {
  const o = f.overall;
  if (!o) { rows.push([f.stem, "ERROR"]); continue; }
  rows.push([
    f.stem,
    `${o.detectionCount}/${o.labelCount}`,
    `miss ${o.missedCount}`,
    `fp ${o.falsePositiveCount}`,
    `pc ${(o.pitchClassAccuracy * 100).toFixed(1)}%`,
    `ex ${(o.exactAccuracy * 100).toFixed(1)}%`,
    `gpc ${((f.gated?.pitchClassAccuracy ?? o.pitchClassAccuracy) * 100).toFixed(1)}%`,
    `on ${o.onsetErrorMs.medianAbs.toFixed(0)}`,
    f.passed ? "pass" : "FAIL",
  ]);
}
const w = [];
for (const row of rows) row.forEach((c, i) => (w[i] = Math.max(w[i] ?? 0, String(c).length)));
for (const row of rows) console.log(row.map((c, i) => String(c).padEnd(w[i])).join("  "));
console.log("requiredFailures:", r.requiredFailures?.length ?? r.requiredFailures);
