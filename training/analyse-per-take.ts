/**
 * How much of the per-take AUC ordering is real, and where do the positives
 * actually live?
 *
 * Two questions the headline falsifier numbers cannot answer. First, a
 * per-take AUC on a take with two positives is 48 pairs and no measurement;
 * this bootstraps every cell so the uninformative ones are visibly so
 * (`docs/DETECTION-FINDINGS.md` records the result: the power-chords and
 * spicy-chords cells carry no signal). Second, grouping the rows by the
 * branch of `rearticulation.ts` that decided them shows how many positives
 * a decision-level fusion could reach at all — which on the derivation set
 * is six of 59, a ceiling worth knowing BEFORE training rather than after.
 *
 * Reads the derivation rows only; the 140bpm takes are filtered at load.
 * Nothing here fits or tunes anything.
 *
 * Usage:  bun training/analyse-per-take.ts [--model DIR] [--corpus DIR]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] as string) : fallback;
}

const modelDir = arg("model", "training/out/model");
const corpusDir = arg("corpus", "training/out/corpus");
import { auc } from "../scripts/measure-decision-separability.js";
import { PATCH_SIZE, ROW_FLOATS, readRowFile } from "./features.js";
import { Activations, forward, transformScalars, SCALARS } from "./model.js";
import { mulberry32 } from "./dsp.js";

const model = JSON.parse(
  readFileSync(join(modelDir, "model.json"), "utf8")
) as { params: number[] };
const params = Float32Array.from(model.params);

const file = readRowFile(join(corpusDir, "corpus"));
const act = new Activations();
type Scored = { take: string; y: 0 | 1; score: number; sharpness: number; reason: string; accepted: boolean };
const rows: Scored[] = [];
file.meta.forEach((m, i) => {
  if (m.take.includes("140bpm")) return;
  const off = i * ROW_FLOATS;
  const patch = file.x.subarray(off, off + PATCH_SIZE);
  const raw = file.x.subarray(off + PATCH_SIZE, off + ROW_FLOATS);
  const scalars = new Float32Array(SCALARS);
  transformScalars(raw, scalars);
  rows.push({
    take: m.take,
    y: m.y,
    score: forward(params, patch, scalars, act),
    sharpness: raw[0] as number,
    reason: m.reason,
    accepted: m.accepted,
  });
});

const rng = mulberry32(20260820);
function bootstrapCi(rs: Scored[], key: (r: Scored) => number): [number, number] | null {
  const pos = rs.filter((r) => r.y === 1).length;
  if (pos === 0 || pos === rs.length) return null;
  const draws: number[] = [];
  for (let b = 0; b < 2000; b++) {
    const s: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < rs.length; i++) {
      const r = rs[Math.floor(rng() * rs.length)] as Scored;
      s.push(key(r));
      y.push(r.y);
    }
    if (y.some((v) => v === 1) && y.some((v) => v === 0)) draws.push(auc(s, y));
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(draws.length * 0.025)] as number, draws[Math.floor(draws.length * 0.975)] as number];
}

const takes = [...new Set(rows.map((r) => r.take))];
console.log("per take: AUC with a 2000-draw bootstrap 95% interval\n");
console.log("take                                       rows  pos  neg  pairs   model AUC  [95% CI]           sharpness");
for (const take of takes) {
  const rs = rows.filter((r) => r.take === take);
  const pos = rs.filter((r) => r.y === 1).length;
  const neg = rs.length - pos;
  if (pos === 0) {
    console.log(`${take.padEnd(42)} ${String(rs.length).padStart(4)} ${String(pos).padStart(4)} ${String(neg).padStart(4)}      -          -`);
    continue;
  }
  const a = auc(rs.map((r) => r.score), rs.map((r) => r.y));
  const sh = auc(rs.map((r) => r.sharpness), rs.map((r) => r.y));
  const ci = bootstrapCi(rs, (r) => r.score);
  console.log(
    `${take.padEnd(42)} ${String(rs.length).padStart(4)} ${String(pos).padStart(4)} ${String(neg).padStart(4)} ` +
      `${String(pos * neg).padStart(6)}      ${a.toFixed(3)}  [${(ci?.[0] ?? NaN).toFixed(3)}, ${(ci?.[1] ?? NaN).toFixed(3)}]` +
      `      ${sh.toFixed(3)}`
  );
}

console.log("\nwhich branch produced each take's rows (cascade reason, positives in brackets)\n");
for (const take of takes) {
  const rs = rows.filter((r) => r.take === take);
  const byReason = new Map<string, { n: number; pos: number }>();
  for (const r of rs) {
    const e = byReason.get(r.reason) ?? { n: 0, pos: 0 };
    e.n++;
    if (r.y === 1) e.pos++;
    byReason.set(r.reason, e);
  }
  const parts = [...byReason.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([reason, e]) => `${reason} ${e.n}[${e.pos}]`);
  console.log(`  ${take}\n    ${parts.join(", ")}`);
}
