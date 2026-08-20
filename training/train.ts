/**
 * Trains the onset head on the extracted GuitarSet rows.
 *
 * Split discipline, stated up front because it is the whole reason this
 * project gets to trust the numbers:
 *
 *  - The split is GROUPED BY PLAYER (GuitarSet's six performers), mirroring
 *    leave-one-take-out: all rows from players `--val-players` (default
 *    04,05) are validation, the rest train. No row of a validation player is
 *    ever trained on.
 *  - Early stopping and every architecture/input choice read the EXTERNAL
 *    validation AUC only.
 *  - The five derivation takes of this repo's corpus may be printed as an
 *    additional curve (pass --corpus); they influence nothing here.
 *  - The twelve 140bpm held-out takes are NEVER LOADED. `--corpus` loads the
 *    corpus row file and filters to non-140bpm stems before anything else
 *    touches it.
 *
 * Usage:
 *   bun training/train.ts --rows training/out/rows [--corpus training/out/corpus]
 *       [--out training/out/model] [--epochs 40] [--batch 128] [--lr 1e-3]
 *       [--seed 7] [--max-rows 160000] [--val-players 04,05]
 *       [--scalar-mode full|wflux|none] [--selftest]
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auc } from "../scripts/measure-decision-separability.js";
import {
  PATCH_SIZE,
  ROW_FLOATS,
  WITNESS_COUNT,
  readRowFile,
  type RowMeta,
} from "./features.js";
import { mulberry32 } from "./dsp.js";
import {
  Activations,
  PARAM_COUNT,
  backward,
  forward,
  initParams,
  makeScratch,
  transformScalars,
  SCALARS,
} from "./model.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] as string) : fallback;
}

const rowsDir = arg("rows", "training/out/rows");
const corpusDir = arg("corpus", "");
const outDir = arg("out", "training/out/model");
const epochs = Number(arg("epochs", "40"));
const batchSize = Number(arg("batch", "128"));
const lr = Number(arg("lr", "1e-3"));
const seed = Number(arg("seed", "7"));
const maxRows = Number(arg("max-rows", "160000"));
const valPlayers = new Set(arg("val-players", "04,05").split(","));
const scalarMode = arg("scalar-mode", "full") as "full" | "wflux" | "none";
const selftest = process.argv.includes("--selftest");

type Sample = {
  patch: Float32Array;
  scalars: Float32Array;
  y: number;
  group: string;
  chain: string;
  flavor: string;
};

function maskScalars(s: Float32Array): void {
  if (scalarMode === "full") return;
  if (scalarMode === "wflux") for (let i = 0; i < WITNESS_COUNT; i++) s[i] = 0;
  if (scalarMode === "none") s.fill(0);
}

function loadSamples(dir: string, filter: (m: RowMeta) => boolean): Sample[] {
  const out: Sample[] = [];
  const bases = new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith(".x.f32"))
      .map((f) => f.replace(/\.x\.f32$/, ""))
  );
  for (const base of [...bases].sort()) {
    const file = readRowFile(join(dir, base));
    file.meta.forEach((m, i) => {
      if (!filter(m)) return;
      const off = i * ROW_FLOATS;
      const patch = file.x.subarray(off, off + PATCH_SIZE);
      const raw = file.x.subarray(off + PATCH_SIZE, off + ROW_FLOATS);
      const scalars = new Float32Array(SCALARS);
      transformScalars(raw, scalars);
      maskScalars(scalars);
      out.push({ patch, scalars, y: m.y, group: m.group, chain: m.chain, flavor: m.flavor });
    });
  }
  return out;
}

/* ---- gradient self-test --------------------------------------------------- */

if (selftest) {
  const rng = mulberry32(1234);
  const params = initParams(rng);
  const patch = new Float32Array(PATCH_SIZE);
  for (let i = 0; i < patch.length; i++) patch[i] = rng();
  const scalars = new Float32Array(SCALARS);
  for (let i = 0; i < scalars.length; i++) scalars[i] = rng() * 2 - 1;
  const y = 1;
  const act = new Activations();
  const scratch = makeScratch();
  const grad = new Float32Array(PARAM_COUNT);
  forward(params, patch, scalars, act);
  backward(params, patch, act, act.p - y, grad, scratch);
  const loss = (): number => {
    forward(params, patch, scalars, act);
    const p = Math.min(Math.max(act.p, 1e-9), 1 - 1e-9);
    return y === 1 ? -Math.log(p) : -Math.log(1 - p);
  };
  // eps must be small: a ReLU kink or a maxpool argmax switch inside the
  // difference interval makes the numeric derivative disagree at the point
  // even when the analytic one is exact (verified: the offenders converge to
  // the analytic value as eps shrinks). The residual is float32 noise, so the
  // bar is the 95th percentile rather than the worst case.
  const eps = 1e-4;
  const rels: number[] = [];
  const rngIdx = mulberry32(99);
  for (let n = 0; n < 200; n++) {
    const i = Math.floor(rngIdx() * PARAM_COUNT);
    const keep = params[i] as number;
    params[i] = keep + eps;
    const up = loss();
    params[i] = keep - eps;
    const down = loss();
    params[i] = keep;
    const numeric = (up - down) / (2 * eps);
    const analytic = grad[i] as number;
    const denom = Math.max(Math.abs(numeric) + Math.abs(analytic), 1e-6);
    rels.push(Math.abs(numeric - analytic) / denom);
  }
  rels.sort((a, b) => a - b);
  const p95 = rels[Math.floor(rels.length * 0.95)] as number;
  const median = rels[rels.length >> 1] as number;
  console.log(
    `gradient self-test over 200 params: median ${median.toExponential(2)}, p95 ${p95.toExponential(2)}, worst ${(rels[rels.length - 1] as number).toExponential(2)}`
  );
  if (p95 > 5e-2) throw new Error("gradient check failed");
  process.exit(0);
}

/* ---- data ----------------------------------------------------------------- */

console.log(`loading rows from ${rowsDir} ...`);
const all = loadSamples(rowsDir, () => true);
console.log(`  ${all.length} rows`);

const rng = mulberry32(seed);
let train = all.filter((s) => !valPlayers.has(s.group));
const val = all.filter((s) => valPlayers.has(s.group));

if (train.length > maxRows) {
  // Seeded downsample, preserving order otherwise.
  const keep = new Set<number>();
  const idx = train.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = idx[i] as number;
    idx[i] = idx[j] as number;
    idx[j] = tmp;
  }
  for (let i = 0; i < maxRows; i++) keep.add(idx[i] as number);
  train = train.filter((_, i) => keep.has(i));
}

const nPos = train.filter((s) => s.y === 1).length;
const nNeg = train.length - nPos;
const wPos = train.length / (2 * Math.max(nPos, 1));
const wNeg = train.length / (2 * Math.max(nNeg, 1));
console.log(
  `  train ${train.length} (${nPos} pos, base rate ${(nPos / train.length).toFixed(3)}), ` +
    `val ${val.length} (players ${[...valPlayers].join(",")}), ` +
    `class weights +${wPos.toFixed(2)} / -${wNeg.toFixed(2)}, scalar-mode ${scalarMode}`
);

let derivation: Sample[] = [];
if (corpusDir !== "") {
  // The held-out 140bpm takes are filtered out AT LOAD. Nothing below this
  // line ever sees them.
  derivation = loadSamples(corpusDir, (m) => !m.take.includes("140bpm"));
  console.log(`  derivation curve: ${derivation.length} corpus rows (140bpm excluded at load)`);
}

/* ---- training loop -------------------------------------------------------- */

const params = initParams(rng);
const grad = new Float32Array(PARAM_COUNT);
const m = new Float32Array(PARAM_COUNT);
const v = new Float32Array(PARAM_COUNT);
const act = new Activations();
const scratch = makeScratch();

function evalAuc(samples: readonly Sample[]): number {
  if (samples.length === 0) return NaN;
  const scores: number[] = [];
  const ys: number[] = [];
  for (const s of samples) {
    scores.push(forward(params, s.patch, s.scalars, act));
    ys.push(s.y);
  }
  return auc(scores, ys);
}

const order = train.map((_, i) => i);
let best = { auc: -1, epoch: -1, params: new Float32Array(PARAM_COUNT) };
let sinceBest = 0;
let adamT = 0;
const beta1 = 0.9;
const beta2 = 0.999;
const epsA = 1e-8;

const history: Array<{ epoch: number; trainLoss: number; valAuc: number; derivationAuc: number | null }> = [];

for (let epoch = 1; epoch <= epochs; epoch++) {
  const t0 = Date.now();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i] as number;
    order[i] = order[j] as number;
    order[j] = tmp;
  }
  let lossSum = 0;
  let lossN = 0;
  for (let start = 0; start < order.length; start += batchSize) {
    const end = Math.min(start + batchSize, order.length);
    grad.fill(0);
    for (let k = start; k < end; k++) {
      const s = train[order[k] as number] as Sample;
      forward(params, s.patch, s.scalars, act);
      const w = s.y === 1 ? wPos : wNeg;
      const p = Math.min(Math.max(act.p, 1e-9), 1 - 1e-9);
      lossSum += -w * (s.y === 1 ? Math.log(p) : Math.log(1 - p));
      lossN++;
      backward(params, s.patch, act, (w * (act.p - s.y)) / (end - start), grad, scratch);
    }
    adamT++;
    const bc1 = 1 - Math.pow(beta1, adamT);
    const bc2 = 1 - Math.pow(beta2, adamT);
    for (let i = 0; i < PARAM_COUNT; i++) {
      const g = grad[i] as number;
      m[i] = beta1 * (m[i] as number) + (1 - beta1) * g;
      v[i] = beta2 * (v[i] as number) + (1 - beta2) * g * g;
      params[i] =
        (params[i] as number) - (lr * ((m[i] as number) / bc1)) / (Math.sqrt((v[i] as number) / bc2) + epsA);
    }
  }
  const valAuc = evalAuc(val);
  const derivationAuc = derivation.length > 0 ? evalAuc(derivation) : null;
  history.push({ epoch, trainLoss: lossSum / Math.max(lossN, 1), valAuc, derivationAuc });
  const flag = valAuc > best.auc ? "  <- best" : "";
  console.log(
    `epoch ${String(epoch).padStart(2)}  loss ${(lossSum / Math.max(lossN, 1)).toFixed(4)}  ` +
      `val AUC ${valAuc.toFixed(4)}` +
      (derivationAuc !== null ? `  derivation AUC ${derivationAuc.toFixed(4)}` : "") +
      `  ${((Date.now() - t0) / 1000).toFixed(0)}s${flag}`
  );
  if (valAuc > best.auc) {
    best = { auc: valAuc, epoch, params: Float32Array.from(params) };
    sinceBest = 0;
  } else if (++sinceBest >= 6) {
    console.log(`early stop: no val improvement for ${sinceBest} epochs`);
    break;
  }
}

/* ---- report + save -------------------------------------------------------- */

params.set(best.params);
console.log(`\nbest epoch ${best.epoch}: external val AUC ${best.auc.toFixed(4)}`);

// Per-slice validation report.
const slices = new Map<string, Sample[]>();
for (const s of val) {
  const key = `${s.flavor}-${s.chain}`;
  const list = slices.get(key);
  if (list === undefined) slices.set(key, [s]);
  else list.push(s);
}
for (const [key, samples] of [...slices.entries()].sort()) {
  console.log(`  val ${key}: AUC ${evalAuc(samples).toFixed(4)} over ${samples.length} rows`);
}

mkdirSync(outDir, { recursive: true });

// Reference vectors for the shipped-inference parity test: the network's
// inputs (patch + TRANSFORMED scalars — the transform itself is covered by
// its own unit test) and the trainer's logits, on a handful of validation
// rows.
const refRng = mulberry32(4242);
const references: Array<{ patch: number[]; scalars: number[]; logit: number }> = [];
for (let n = 0; n < 8 && val.length > 0; n++) {
  const s = val[Math.floor(refRng() * val.length)] as Sample;
  const logit = forward(params, s.patch, s.scalars, act);
  references.push({
    patch: Array.from(s.patch),
    scalars: Array.from(s.scalars),
    logit,
  });
}

writeFileSync(
  join(outDir, "model.json"),
  JSON.stringify(
    {
      paramCount: PARAM_COUNT,
      params: Array.from(best.params),
      seed,
      lr,
      batchSize,
      scalarMode,
      valPlayers: [...valPlayers],
      bestEpoch: best.epoch,
      valAuc: best.auc,
      history,
    },
    null,
    1
  )
);
writeFileSync(join(outDir, "references.json"), JSON.stringify(references));
console.log(`saved ${outDir}/model.json (+references.json)`);
