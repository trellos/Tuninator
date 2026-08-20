/**
 * Does ADAPTIVE WHITENING give the re-articulation decision witnesses whose
 * scale survives a change of take?
 *
 * The measured defect (see `measure-decision-separability.ts` and
 * `docs/DETECTION-FINDINGS.md`): a twelve-witness logistic fit reads 0.808
 * in-sample and collapses to 0.434 — worse than chance — under
 * leave-one-take-out. That collapse is the signature of features whose SCALE
 * is take-dependent, and attack contrast varies 106x within a single take.
 *
 * The mechanism under test (Stowell & Plumbley, ICMC 2007): per bin, keep a
 * running peak and divide by it —
 *
 *   P[f] <- max( |X[f]| , m * P[f] , floor )        m slightly below 1
 *   Xw[f] = |X[f]| / P[f]
 *
 * so every bin occupies [0, 1] regardless of spectral roll-off and playing
 * dynamics, and flux computed over Xw is scale-free by construction.
 *
 * THE FALSIFIER, STATED BEFORE THE RUN: if leave-one-take-out AUC does not
 * move materially above 0.434 with whitened witnesses in the model, whitening
 * is not addressing the generalisation failure and should not be wired into
 * the engine. Even a large improvement is not by itself a win — it must also
 * show up in the ledger and the splits, or it is a better-behaved feature
 * that still cannot make the distinction.
 *
 * METHOD. The engine is not modified: the decision table is collected from
 * the tracker exactly as `measure-decision-separability.ts` collects it, so
 * the row population is IDENTICAL to the baseline study's, and the whitened
 * witnesses are computed by a standalone pass over the same audio at the same
 * window and hop the engine's flux kernel uses, then joined to the rows by
 * hop timestamp. The memory coefficient `m` and the floor are chosen on the
 * five derivation takes only.
 *
 * Usage:
 *   npx tsx scripts/measure-whitening-separability.ts
 */

import { readFileSync } from "node:fs";
import { RealFFT, hannWindow } from "../src/engine/kernels/fft.js";
import { DEFAULT_ENGINE_CONFIG, snapHop } from "../src/engine/config.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";
import {
  collect,
  FEATURES,
  auc,
  outOfFold,
  zeroCost,
  standardiser,
  design,
  fitLogistic,
  score,
  isHeldOut,
  type Row,
} from "./measure-decision-separability.js";

/** Whitening configurations swept; chosen on the derivation rows only. */
const CONFIGS = [
  { m: 0.9, floor: 1e-3 },
  { m: 0.95, floor: 1e-3 },
  { m: 0.99, floor: 1e-3 },
  { m: 0.997, floor: 1e-3 },
  { m: 0.99, floor: 1e-4 },
  { m: 0.99, floor: 1e-2 },
] as const;

/**
 * The four whitened readings per configuration, mirroring the split the
 * existing witnesses make: flux against a short reference ("arrived just
 * now") and against a decaying peak hold ("new since the note began"), each
 * raw and normalised by the frame's own whitened magnitude.
 */
const WITNESSES = ["wFlux", "wFluxNorm", "wHeldFlux", "wHeldNorm"] as const;

type HopReadings = { at: number; values: Float64Array };

/**
 * One pass over the audio at the engine's flux window and hop, computing all
 * whitening configurations at once. Reference shapes mirror the kernel: the
 * short reference is the per-bin maximum over the last `referenceFrames`
 * whitened spectra, the held reference a 0.95-per-hop decaying peak hold.
 */
function whitenedPass(mono: Float32Array, sampleRate: number): HopReadings[] {
  const config = DEFAULT_ENGINE_CONFIG;
  const fftSize = config.transient.fluxFftSize;
  const hop = snapHop(config.analysis.hopMs, sampleRate);
  const hopMs = (hop / sampleRate) * 1000;
  const referenceFrames = Math.max(1, Math.round(config.transient.fluxReferenceMs / hopMs));

  const fft = new RealFFT(fftSize);
  const hann = hannWindow(fftSize);
  const windowed = new Float32Array(fftSize);
  const magnitude = new Float32Array(fft.bins);
  let windowSum = 0;
  for (let i = 0; i < fftSize; i++) windowSum += hann[i] as number;
  const magnitudeScale = windowSum > 0 ? 2 / windowSum : 1;

  const bins = fft.bins;
  const n = CONFIGS.length;
  const peaks = CONFIGS.map(({ floor }) => new Float64Array(bins).fill(floor));
  const whitened = CONFIGS.map(() => new Float64Array(bins));
  const history = CONFIGS.map(() => new Float64Array(bins * referenceFrames));
  const held = CONFIGS.map(() => new Float64Array(bins));
  let historyIndex = 0;
  let historyFilled = 0;

  const out: HopReadings[] = [];
  for (let start = 0; start + fftSize <= mono.length; start += hop) {
    for (let i = 0; i < fftSize; i++) windowed[i] = (mono[start + i] as number) * (hann[i] as number);
    fft.magnitudes(windowed, magnitude);
    for (let k = 0; k < bins; k++) magnitude[k] = (magnitude[k] as number) * magnitudeScale;

    const values = new Float64Array(n * WITNESSES.length);
    for (let c = 0; c < n; c++) {
      const { m } = CONFIGS[c] as (typeof CONFIGS)[number];
      const floor = (CONFIGS[c] as (typeof CONFIGS)[number]).floor;
      const P = peaks[c] as Float64Array;
      const W = whitened[c] as Float64Array;
      const H = history[c] as Float64Array;
      const HeldRef = held[c] as Float64Array;
      let flux = 0;
      let heldFlux = 0;
      let total = 0;
      for (let k = 0; k < bins; k++) {
        const mag = magnitude[k] as number;
        const decayed = m * (P[k] as number);
        const peak = mag > decayed ? (mag > floor ? mag : floor) : decayed > floor ? decayed : floor;
        P[k] = peak;
        const w = mag / peak;
        W[k] = w;
        total += w;
        let reference = 0;
        for (let f = 0; f < historyFilled; f++) {
          const past = H[f * bins + k] as number;
          if (past > reference) reference = past;
        }
        const delta = w - reference;
        if (delta > 0) flux += delta;
        const heldDelta = w - (HeldRef[k] as number);
        if (heldDelta > 0) heldFlux += heldDelta;
      }
      values[c * WITNESSES.length + 0] = flux;
      values[c * WITNESSES.length + 1] = flux / Math.max(total, 1e-9);
      values[c * WITNESSES.length + 2] = heldFlux;
      values[c * WITNESSES.length + 3] = heldFlux / Math.max(total, 1e-9);
      // Advance the references.
      const slot = historyIndex * bins;
      for (let k = 0; k < bins; k++) {
        H[slot + k] = W[k] as number;
        const dec = (HeldRef[k] as number) * 0.95;
        HeldRef[k] = (W[k] as number) > dec ? (W[k] as number) : dec;
      }
    }
    historyIndex = (historyIndex + 1) % referenceFrames;
    if (historyFilled < referenceFrames) historyFilled++;
    out.push({ at: ((start + fftSize) / sampleRate) * 1000, values });
  }
  return out;
}

function main(): void {
  console.log("\n  collecting the decision table (unchanged engine)...");
  const rows = collect();

  console.log("  whitened pass over every take...");
  const hopMs = 12;
  const byStem = new Map<string, HopReadings[]>();
  for (const fixture of decodeFixtures({ quiet: true })) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    byStem.set(fixture.stem, whitenedPass(mono, wav.sampleRate));
  }

  // Join: each row's `at` is a hop timestamp on the same grid.
  type Joined = Row & { w: Float64Array };
  const joined: Joined[] = [];
  let unmatched = 0;
  for (const row of rows) {
    const hops = byStem.get(row.stem);
    if (hops === undefined) continue;
    // Binary search would be nicer; linear from a moving cursor is fine here.
    let best: HopReadings | null = null;
    for (const h of hops) {
      if (best === null || Math.abs(h.at - row.at) < Math.abs(best.at - row.at)) best = h;
    }
    if (best === null || Math.abs(best.at - row.at) > hopMs / 2 + 0.5) {
      unmatched++;
      continue;
    }
    joined.push({ ...row, w: best.values });
  }
  if (unmatched > 0) console.log(`  ${unmatched} rows had no hop within half a hop — dropped`);

  const derive = joined.filter((r) => !isHeldOut(r.stem));
  const held = joined.filter((r) => isHeldOut(r.stem));
  const y = derive.map((r) => r.y);
  const stems = [...new Set(derive.map((r) => r.stem))];
  const takeFold = derive.map((r) => stems.indexOf(r.stem));
  const LAMBDA = 0.01;

  const f3 = (x: number): string => x.toFixed(3);
  const table = (head: readonly string[], body: readonly (readonly string[])[]): void => {
    const all = [head, ...body];
    const width: number[] = [];
    for (const row of all) row.forEach((c, i) => (width[i] = Math.max(width[i] ?? 0, c.length)));
    const line = (row: readonly string[]): string =>
      "  " +
      row.map((c, i) => (i === 0 ? c.padEnd(width[i] as number) : c.padStart(width[i] as number))).join("  ");
    console.log(line(head));
    console.log("  " + width.map((w) => "-".repeat(w)).join("  "));
    for (const row of body) console.log(line(row));
  };

  /**
   * Rows carry the twelve original witnesses in `x`; a "virtual row" view maps
   * whitened columns in after them so the fitting helpers can be reused.
   */
  const withColumns = (rs: readonly Joined[], cols: readonly number[]): Row[] =>
    rs.map((r) => ({ ...r, x: [...r.x, ...cols.map((c) => r.w[c] as number)] }));

  console.log(`\n  ${joined.length} decisions joined (${derive.length} derivation, ${held.length} held out)\n`);

  /* ---- Single whitened witnesses, per configuration ----------------------- */

  console.log("  1. SINGLE-WITNESS AUC OF THE WHITENED READINGS (derivation)\n");
  const body: string[][] = [];
  for (let c = 0; c < CONFIGS.length; c++) {
    const cfg = CONFIGS[c] as (typeof CONFIGS)[number];
    for (let wi = 0; wi < WITNESSES.length; wi++) {
      const col = c * WITNESSES.length + wi;
      const scores = derive.map((r) => r.w[col] as number);
      const a = auc(scores, y);
      body.push([
        `m=${cfg.m} floor=${cfg.floor} ${WITNESSES[wi]}`,
        f3(a),
        f3(Math.max(a, 1 - a)),
      ]);
    }
  }
  body.sort((p, q) => Number(q[2]) - Number(p[2]));
  table(["whitened witness", "AUC", "oriented"], body.slice(0, 12));

  /* ---- The models: baseline, whitened-only, augmented --------------------- */

  console.log("\n\n  2. THE MODELS (derivation; LOTO is the number that matters)\n");
  const originalCols = FEATURES.map((_, i) => i);
  const modelRows: string[][] = [];

  const evaluateModel = (name: string, rs: Row[], cols: number[]): { loto: number } => {
    const yy = rs.map((r) => r.y);
    const folds5: number[] = (() => {
      // Stratified 5-fold, same construction as the baseline script.
      const fold = new Array<number>(yy.length).fill(0);
      let p = 0;
      let n = 0;
      for (let i = 0; i < yy.length; i++) {
        if (yy[i] === 1) fold[i] = p++ % 5;
        else fold[i] = n++ % 5;
      }
      return fold;
    })();
    const s = standardiser(rs, cols);
    const w = fitLogistic(design(rs, cols, s), yy, LAMBDA);
    const inSample = auc(score(design(rs, cols, s), w), yy);
    const cv5 = auc(outOfFold(rs, cols, folds5, LAMBDA), yy);
    const lotoScores = outOfFold(rs, cols, takeFold, LAMBDA);
    const loto = auc(lotoScores, yy);
    const zc = zeroCost(lotoScores, yy);
    modelRows.push([name, f3(inSample), f3(cv5), f3(loto), `${zc.falseAccepts} / ${zc.negatives}`]);
    return { loto };
  };

  evaluateModel("baseline: twelve witnesses", derive.map((r) => ({ ...r })), originalCols);

  let bestConfig = 0;
  let bestLoto = -1;
  for (let c = 0; c < CONFIGS.length; c++) {
    const cfg = CONFIGS[c] as (typeof CONFIGS)[number];
    const cols = WITNESSES.map((_, wi) => c * WITNESSES.length + wi);
    const rs = withColumns(derive, cols);
    const extra = cols.map((_, i) => FEATURES.length + i);
    const { loto } = evaluateModel(`whitened only, m=${cfg.m} floor=${cfg.floor}`, rs, extra);
    if (loto > bestLoto) {
      bestLoto = loto;
      bestConfig = c;
    }
  }
  for (let c = 0; c < CONFIGS.length; c++) {
    const cfg = CONFIGS[c] as (typeof CONFIGS)[number];
    const cols = WITNESSES.map((_, wi) => c * WITNESSES.length + wi);
    const rs = withColumns(derive, cols);
    const all = [...originalCols, ...cols.map((_, i) => FEATURES.length + i)];
    evaluateModel(`twelve + whitened, m=${cfg.m} floor=${cfg.floor}`, rs, all);
  }
  table(
    ["model", "in-sample AUC", "5-fold AUC", "leave-one-take-out AUC", "FP at zero cost (LOTO)"],
    modelRows
  );

  /* ---- Held out, LAST, for the best derivation configuration -------------- */

  const cfg = CONFIGS[bestConfig] as (typeof CONFIGS)[number];
  console.log(
    `\n\n  3. HELD OUT (twelve 140bpm takes), best derivation config m=${cfg.m} floor=${cfg.floor}\n`
  );
  const cols = WITNESSES.map((_, wi) => bestConfig * WITNESSES.length + wi);
  const extra = cols.map((_, i) => FEATURES.length + i);
  const heldRows: string[][] = [];
  for (const [name, cs] of [
    ["whitened only", extra],
    ["twelve + whitened", [...originalCols, ...extra]],
    ["twelve (baseline)", originalCols],
  ] as const) {
    const trainRows = withColumns(derive, cols);
    const testRows = withColumns(held, cols);
    const yy = trainRows.map((r) => r.y);
    const s = standardiser(trainRows, cs);
    const w = fitLogistic(design(trainRows, cs, s), yy, LAMBDA);
    const dScores = score(design(trainRows, cs, s), w);
    const hScores = score(design(testRows, cs, s), w);
    const yh = testRows.map((r) => r.y);
    const cut = zeroCost(dScores, yy).threshold;
    let kept = 0;
    let lost = 0;
    let fp = 0;
    for (let i = 0; i < testRows.length; i++) {
      const above = (hScores[i] as number) >= cut;
      if (yh[i] === 1) {
        if (above) kept++;
        else lost++;
      } else if (above) fp++;
    }
    heldRows.push([
      name,
      f3(auc(dScores, yy)),
      f3(auc(hScores, yh)),
      `${kept} / ${kept + lost}`,
      String(lost),
      `${fp} / ${yh.filter((v) => v === 0).length}`,
    ]);
  }
  table(
    ["rule", "derivation AUC", "held-out AUC", "positives kept", "labels lost", "false accepts"],
    heldRows
  );

  /* ---- The ledger question: a veto on ACTED decisions --------------------- */

  // The AUC tables say whether the witness ranks; this says what wiring it in
  // as a veto would do to the ledger. The tracker acts on `accepted &&
  // settled` rows — those become splits, i.e. extra Notes when wrong. A veto
  // clears a decision only when the whitened score sits below a bar chosen on
  // the derivation takes at zero cost: the loosest bar keeping every
  // derivation positive. Counted on the held-out takes, per signal path.
  console.log(
    `\n\n  4. AS A VETO ON ACTED DECISIONS (m=${cfg.m} floor=${cfg.floor}, fit on derivation)\n`
  );
  {
    const trainRows = withColumns(derive, cols);
    const testRows = withColumns(held, cols);
    const cs = extra;
    const yy = trainRows.map((r) => r.y);
    const s = standardiser(trainRows, cs);
    const w = fitLogistic(design(trainRows, cs, s), yy, LAMBDA);
    const dScores = score(design(trainRows, cs, s), w);
    const hScores = score(design(testRows, cs, s), w);
    // Loosest bar that keeps every derivation positive (acted or not: losing
    // an unacted positive costs nothing today but poisons later recovery).
    const cut = zeroCost(dScores, yy).threshold;

    const path = (stem: string): string =>
      stem.includes("amped") ? "amp sim" : stem.includes("-di-") ? "DI" : stem.includes("mic") ? "room mic" : "mic (default)";
    const byPath = new Map<string, { fpVetoed: number; fpKept: number; tpVetoed: number; tpKept: number }>();
    for (let i = 0; i < testRows.length; i++) {
      const r = testRows[i] as Row;
      const acted = r.accepted && r.settled;
      if (!acted) continue;
      const p = path(r.stem);
      const entry = byPath.get(p) ?? { fpVetoed: 0, fpKept: 0, tpVetoed: 0, tpKept: 0 };
      const vetoed = (hScores[i] as number) < cut;
      if (r.y === 1) {
        if (vetoed) entry.tpVetoed++;
        else entry.tpKept++;
      } else {
        if (vetoed) entry.fpVetoed++;
        else entry.fpKept++;
      }
      byPath.set(p, entry);
    }
    const body: string[][] = [];
    let fpV = 0;
    let tpV = 0;
    for (const [p, e] of byPath) {
      body.push([
        p,
        `${e.fpVetoed} of ${e.fpVetoed + e.fpKept}`,
        `${e.tpVetoed} of ${e.tpVetoed + e.tpKept}`,
      ]);
      fpV += e.fpVetoed;
      tpV += e.tpVetoed;
    }
    body.push(["TOTAL", String(fpV), String(tpV)]);
    table(["held-out path", "false splits vetoed (good)", "true splits vetoed (labels lost)"], body);
    // The same veto on the derivation acted rows, for honesty: by construction
    // it loses nothing there; what does it clear?
    let dFp = 0;
    let dFpAll = 0;
    for (let i = 0; i < trainRows.length; i++) {
      const r = trainRows[i] as Row;
      if (!(r.accepted && r.settled) || r.y === 1) continue;
      dFpAll++;
      if ((dScores[i] as number) < cut) dFp++;
    }
    console.log(`\n  derivation acted false splits vetoed: ${dFp} of ${dFpAll} (zero positives lost, by construction)`);
  }
  console.log("");
}

main();
