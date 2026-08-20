/**
 * Falsifiers 1 and 2 from `docs/learned-onset-head-prompt.md` §4, scored with
 * the model FROZEN. Nothing here fits, tunes, or selects anything on corpus
 * rows; the corpus row file is loaded with every 140bpm take filtered out, so
 * the twelve held-out takes cannot leak into this read no matter what.
 *
 *  1. RANKING: the learned score must clear 0.73 AUC (the best existing
 *     single witness, sharpness at 0.728) on THIS repo's derivation decision
 *     table. Fail -> the external-data bet failed; write it up and stop.
 *
 *  2. GENERALISATION SHAPE: the baseline defect was take-dependent feature
 *     scale — a twelve-witness fit reads 0.808 in-sample and 0.434
 *     leave-one-take-out. The frozen model fits nothing on these rows, so
 *     the analogous failure would be score DISTRIBUTIONS that shift per take
 *     while ranking within takes: measured here as (a) per-take AUC, (b) the
 *     pooled out-of-fold AUC of a leave-one-take-out single-feature logistic
 *     over the learned score — the exact machinery the baseline collapse was
 *     measured with, handed one feature. If per-take calibration transfers,
 *     this sits near the pooled AUC; if the take sets the scale, it collapses
 *     exactly as 0.434 did. The whitened-feature study's 0.723 -> 0.608 is
 *     the shape to beat.
 *
 * Usage:  bun training/score-falsifiers.ts [--model training/out/model] [--corpus training/out/corpus]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auc, zeroCost, outOfFold, type Row } from "../scripts/measure-decision-separability.js";
import { PATCH_SIZE, ROW_FLOATS, WITNESS_COUNT, readRowFile } from "./features.js";
import { Activations, forward, transformScalars, SCALARS } from "./model.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] as string) : fallback;
}

const modelDir = arg("model", "training/out/model");
const corpusDir = arg("corpus", "training/out/corpus");

const model = JSON.parse(readFileSync(join(modelDir, "model.json"), "utf8")) as {
  params: number[];
  scalarMode: "full" | "wflux" | "none";
  valAuc: number;
  bestEpoch: number;
};
const params = Float32Array.from(model.params);

const file = readRowFile(join(corpusDir, "corpus"));
// The held-out takes leave the table HERE, before any scoring.
const kept = file.meta
  .map((m, i) => ({ m, i }))
  .filter(({ m }) => !m.take.includes("140bpm"));

const act = new Activations();
type Scored = { take: string; y: 0 | 1; score: number; sharpness: number };
const rows: Scored[] = kept.map(({ m, i }) => {
  const off = i * ROW_FLOATS;
  const patch = file.x.subarray(off, off + PATCH_SIZE);
  const raw = file.x.subarray(off + PATCH_SIZE, off + ROW_FLOATS);
  const scalars = new Float32Array(SCALARS);
  transformScalars(raw, scalars);
  if (model.scalarMode === "wflux") for (let k = 0; k < WITNESS_COUNT; k++) scalars[k] = 0;
  if (model.scalarMode === "none") scalars.fill(0);
  return {
    take: m.take,
    y: m.y,
    score: forward(params, patch, scalars, act),
    sharpness: raw[0] as number,
  };
});

const y = rows.map((r) => r.y);
const scores = rows.map((r) => r.score);
const pos = y.filter((v) => v === 1).length;
console.log(
  `derivation decision table: ${rows.length} rows, ${pos} positives ` +
    `(external val AUC at freeze: ${model.valAuc.toFixed(4)}, epoch ${model.bestEpoch}, scalar-mode ${model.scalarMode})`
);

const learnedAuc = auc(scores, y);
const sharpnessAuc = auc(rows.map((r) => r.sharpness), y);
const zc = zeroCost(scores, y);
console.log(`\nFALSIFIER 1 — ranking on the derivation table, model frozen`);
console.log(`  learned score AUC   ${learnedAuc.toFixed(4)}   (bar: 0.73)`);
console.log(`  sharpness, same rows ${sharpnessAuc.toFixed(4)}`);
console.log(`  zero-label-cost operating point: ${zc.falseAccepts} / ${zc.negatives} false accepts`);
console.log(`  verdict: ${learnedAuc > 0.73 ? "PASSED" : "FAILED — the external-data bet did not clear the bar"}`);

console.log(`\nFALSIFIER 2 — generalisation shape across takes`);
const takes = [...new Set(rows.map((r) => r.take))];
for (const take of takes) {
  const rs = rows.filter((r) => r.take === take);
  const p = rs.filter((r) => r.y === 1).length;
  const a =
    p === 0 || p === rs.length ? NaN : auc(rs.map((r) => r.score), rs.map((r) => r.y));
  console.log(
    `  ${take.padEnd(45)} ${String(rs.length).padStart(4)} rows  ${String(p).padStart(3)} pos  AUC ${Number.isNaN(a) ? "  -  " : a.toFixed(4)}`
  );
}

// The baseline machinery, handed one feature: LOTO logistic over the score.
const pseudo: Row[] = rows.map((r) => ({
  stem: r.take,
  at: 0,
  noteId: "",
  accepted: false,
  reason: "",
  settled: false,
  x: [r.score],
  y: r.y,
  labelId: null,
  labelMatched: null,
}));
const takeFold = pseudo.map((r) => takes.indexOf(r.stem));
const lotoScores = outOfFold(pseudo, [0], takeFold, 0.01);
const lotoAuc = auc(lotoScores, y);
console.log(`  pooled AUC ${learnedAuc.toFixed(4)}  |  LOTO-calibrated pooled AUC ${lotoAuc.toFixed(4)}`);
console.log(`  the collapse to beat: 0.808 -> 0.434 (twelve witnesses); 0.723 -> 0.608 (whitened)`);
