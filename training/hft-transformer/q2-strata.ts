/**
 * Q2 read within strata: descriptive, after the fact, and moving no bar.
 *
 * `phase2.ts` scored Q2 on the derivation takes pooled, as its header fixed
 * in advance, and the model cleared the bar there (0.710 against 0.698). Its
 * per-path lines read lower than the pooled figure on both large paths (DI
 * 0.648, amp 0.652), which is what a pooled AUC does when the signal paths
 * differ both in how often a cut is right and in how high the score sits. A
 * pooled AUC then partly ranks PATHS rather than cuts.
 *
 * This reads the same rows (`rows-<stage>.json`) with the AUC restricted to
 * pairs inside one stratum — a positive and a negative from the same signal
 * path, or from the same take — which is the model's ranking of cuts with the
 * path (or the take) held fixed. The engine's own witnesses get the same
 * treatment on the same rows, so the comparison stays on one target (y_b,
 * the boundary target) and one population.
 *
 * Usage:
 *   npx tsx training/hft-transformer/q2-strata.ts [--stage derivation|heldout]
 */

import { readFileSync } from "node:fs";

const i = process.argv.indexOf("--stage");
const stage = i >= 0 ? (process.argv[i + 1] ?? "derivation") : "derivation";
type Row = {
  stem: string; path: string; yb: 0 | 1; gatePassed: boolean; deep: number; full: number;
  sharpness: number; fluxRatio: number; dipRatio: number; spanOverIoi: number;
};
const rows = (JSON.parse(readFileSync(`training/out/hft-transformer/rows-${stage}.json`, "utf8")) as { q2: Row[] }).q2;

/** AUC over positive/negative pairs that share a stratum; ties count half. */
function stratifiedAuc(sel: Row[], score: (r: Row) => number, stratum: (r: Row) => string): { auc: number; pairs: number } {
  const groups = new Map<string, Row[]>();
  for (const r of sel) {
    if (!Number.isFinite(score(r))) continue;
    groups.set(stratum(r), [...(groups.get(stratum(r)) ?? []), r]);
  }
  let win = 0;
  let pairs = 0;
  for (const g of groups.values()) {
    const pos = g.filter((r) => r.yb === 1).map(score);
    const neg = g.filter((r) => r.yb === 0).map(score);
    for (const p of pos) {
      for (const n of neg) {
        pairs++;
        if (p > n) win += 1;
        else if (p === n) win += 0.5;
      }
    }
  }
  return { auc: pairs > 0 ? win / pairs : NaN, pairs };
}

const scores: Array<[string, (r: Row) => number]> = [
  ["model S2, deep", (r) => r.deep],
  ["model S2, full", (r) => r.full],
  ["sharpness", (r) => r.sharpness],
  ["fluxRatio", (r) => r.fluxRatio],
  ["-dipRatio", (r) => -r.dipRatio],
];
const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : "  -  ");
console.log(`Q2 rows (${stage}): ${rows.length}, ${rows.filter((r) => r.yb === 1).length} y_b=1`);
console.log(`  ${"score".padEnd(16)} ${"pooled".padStart(7)} ${"within path".padStart(12)} ${"within take".padStart(12)}   (gate-passed rows: pooled / within path / within take)`);
for (const [name, score] of scores) {
  const pooled = stratifiedAuc(rows, score, () => "all");
  const byPath = stratifiedAuc(rows, score, (r) => r.path);
  const byTake = stratifiedAuc(rows, score, (r) => r.stem);
  const g = rows.filter((r) => r.gatePassed);
  const gPooled = stratifiedAuc(g, score, () => "all");
  const gPath = stratifiedAuc(g, score, (r) => r.path);
  const gTake = stratifiedAuc(g, score, (r) => r.stem);
  console.log(
    `  ${name.padEnd(16)} ${f3(pooled.auc).padStart(7)} ${f3(byPath.auc).padStart(12)} ${f3(byTake.auc).padStart(12)}   ${f3(gPooled.auc)} / ${f3(gPath.auc)} / ${f3(gTake.auc)}`,
  );
}
console.log("\n  per take, model S2 deep against fluxRatio (y_b):");
for (const stem of [...new Set(rows.map((r) => r.stem))]) {
  const sel = rows.filter((r) => r.stem === stem);
  const m = stratifiedAuc(sel, (r) => r.deep, () => "t");
  const f = stratifiedAuc(sel, (r) => r.fluxRatio, () => "t");
  console.log(`    ${stem.padEnd(48)} n=${String(sel.length).padStart(4)} (${String(sel.filter((r) => r.yb === 1).length).padStart(3)} y_b=1)  model ${f3(m.auc)}  fluxRatio ${f3(f.auc)}`);
}
