/**
 * The eval report's totals, split derivation / held-out, for Phase 3's before
 * and after. Reads `.cache/eval-report.json` as `npm run eval` last wrote it.
 *
 * Usage: npx tsx training/basic-pitch/eval-totals.ts [report.json]
 */

import { readFileSync } from "node:fs";

type Overall = {
  labelCount: number;
  detectionCount: number;
  matchedCount: number;
  missedCount: number;
  falsePositiveCount: number;
  exactCorrect: number;
  pitchClassCorrect: number;
  scoredLabelCount: number;
};
type Report = {
  fixtures: Array<{ stem: string; passed: boolean; required: boolean; overall: Overall }>;
  requiredFailures: unknown;
};

const path = process.argv[2] ?? ".cache/eval-report.json";
const report = JSON.parse(readFileSync(path, "utf8")) as Report;
const sum = (rows: Report["fixtures"]) => {
  const t = { labels: 0, detections: 0, matched: 0, missed: 0, falsePositives: 0, exact: 0, pitchClass: 0, scored: 0, failed: 0 };
  for (const f of rows) {
    t.labels += f.overall.labelCount;
    t.detections += f.overall.detectionCount;
    t.matched += f.overall.matchedCount;
    t.missed += f.overall.missedCount;
    t.falsePositives += f.overall.falsePositiveCount;
    t.exact += f.overall.exactCorrect;
    t.pitchClass += f.overall.pitchClassCorrect;
    t.scored += f.overall.scoredLabelCount;
    if (!f.passed) t.failed++;
  }
  return t;
};
const held = report.fixtures.filter((f) => f.stem.includes("140bpm"));
const deriv = report.fixtures.filter((f) => !f.stem.includes("140bpm"));
for (const [name, rows] of [
  ["derivation", deriv],
  ["held-out", held],
  ["all", report.fixtures],
] as const) {
  const t = sum(rows);
  console.log(
    `${name.padEnd(11)} takes ${String(rows.length).padStart(2)}  labels ${t.labels}  Notes ${t.detections}  matched ${t.matched}  ` +
      `missed ${t.missed}  false positives ${t.falsePositives}  exact ${t.exact}/${t.scored}  pitch class ${t.pitchClass}/${t.scored}  ` +
      `fixtures failing ${t.failed}`,
  );
}
const rf = report.requiredFailures;
console.log(`required failures: ${Array.isArray(rf) ? rf.length : String(rf)}`);
