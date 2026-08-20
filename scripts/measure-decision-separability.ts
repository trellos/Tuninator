/**
 * Does ANY combination of the witnesses we already compute separate accept from
 * reject, when no single one does?
 *
 * The measured obstacle to every threshold swept so far (see
 * `docs/DETECTION-FINDINGS.md`) is that attack contrast varies 2.0x to 24.2x
 * across the corpus and up to 106x WITHIN one take, so no fixed bar on any one
 * witness separates a genuine re-pick from a decaying string's own noise
 * everywhere. `heldFluxRatio` separates cleanly on eight takes and inverts on
 * the ninth. Each witness has been swept on its own, exhaustively. What has
 * never been measured is whether the witnesses TOGETHER carry information that
 * none of them carries alone.
 *
 * This script answers that, and it is built to be able to answer NO. A negative
 * result is the valuable one: it kills a large planned effort cheaply.
 *
 * WHAT IT MEASURES
 *
 *  1. The decision table. Every `rearticulation` trace event the tracker emits
 *     is one row: the twelve witnesses `RearticulationDetector.verdict` has in
 *     its hand at the moment it decides, plus what it decided.
 *
 *     The trace fires BEFORE the tracker acts on the verdict and before the
 *     `settled` gate, so these are the decisions that COULD be taken, not only
 *     the ones that were. The population is still conditioned on the current
 *     code in one way that cannot be removed: a row exists only where the fast
 *     lane found a transient AND a Note was open to decide about. Strokes lost
 *     before that point (`no transient within the window`) are not in this
 *     table and no rule fitted here could recover them.
 *
 *  2. The target, from the ground truth rather than from the detector. A
 *     decision at time t SHOULD have been accepted when a labelled event begins
 *     within `WINDOW_MS` of t and no already-open Note accounts for that label
 *     -- the attribution `measure-downstream-ledger.ts` uses, where "a Note
 *     opened within the window means the boundary was found" (its rules 1 and
 *     3). Stated exactly, the rule used here is:
 *
 *       positive  iff  there is a label L with |L.startMs - t| <= 70ms
 *                      AND no Note opened at a time <= t that is itself within
 *                      70ms of L.startMs.
 *       negative  otherwise.
 *
 *     Only openings at or before the decision count, so an acceptance cannot
 *     label itself correct by opening its own successor. The exclusion is the
 *     whole experiment: "is there any label within 70ms" would mark the start
 *     of every correctly-open Note as an accept, and a rule that fitted that
 *     would be fitting the metronome.
 *
 *  3. Separation. Per-witness AUC first, so the single-witness baseline is on
 *     the table; then a plain L2-regularised logistic regression over the
 *     standardised witnesses, cross-validated; then an exhaustive sweep of all
 *     66 pairs, because two witnesses doing the job is far more useful than
 *     twelve. Cross-validation is reported two ways: stratified 5-fold, and
 *     leave-one-take-out -- the second is the one that matters, because
 *     cross-take variance is the defect under investigation and a fold that
 *     mixes takes lets a model memorise each take's own scale.
 *
 *  4. The operating point that costs zero labels: the loosest threshold that
 *     keeps every positive, and how many spurious accepts come with it. That is
 *     the constraint this project actually works under -- a rule that recovers
 *     four strokes and invents nine is not an improvement.
 *
 *  5. Held out, LAST. Fit on the five 120bpm derivation takes, score on the
 *     twelve 140bpm takes. Never the reverse, and nothing is tuned after
 *     looking. With of the order of eighty derivation labels against twelve
 *     features, a collapse between derivation and held-out is the expected
 *     outcome, and reporting it is the point rather than the failure.
 *
 * AUC is the headline because the classes are wildly imbalanced (see the base
 * rates it prints): accuracy would be beaten by "reject everything".
 *
 * WHAT WOULD FALSIFY THE VERDICT
 *
 *  - A combination whose leave-one-take-out AUC clears the best single witness
 *    by a margin larger than the spread across folds, AND holds on the twelve
 *    held-out takes. Then the combination is real and worth building.
 *  - A zero-label operating point whose false accepts fall materially below the
 *    best single witness's, on held-out data. Separation that does not survive
 *    that constraint buys nothing.
 *  - Correlations near zero between witnesses would mean twelve independent
 *    readings rather than a handful; the printed matrix says otherwise.
 *
 * It changes no engine behaviour. `measure-downstream-ledger.ts --all` must
 * still report MISSED 32 with this file in the tree.
 *
 * Usage:
 *   npx tsx scripts/measure-decision-separability.ts
 *   npx tsx scripts/measure-decision-separability.ts --rows   dump every row
 */

import { readFileSync } from "node:fs";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { matchEvents, type LabeledEvent } from "../src/offline/matcher.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/**
 * How near a label a decision has to be to be that label's decision. Same
 * constant and same reasoning as `measure-downstream-ledger.ts`: the matcher's
 * own 300ms window also scores overlap, while attributing a rejected transient
 * to one stroke needs the tight one, and 70ms is two thirds of a 107ms
 * sixteenth at 140bpm.
 */
const WINDOW_MS = 70;

/** The witnesses `verdict()` has in hand. Booleans enter as 0/1. */
const FEATURES = [
  "sharpness",
  "heldSharpness",
  "fluxRatio",
  "heldFluxRatio",
  "riseRatio",
  "envelopeOverBaseline",
  "decayExcess",
  "soundedMs",
  "pitchDiffers",
  "gliding",
  "kernelOnset",
  "bloomed",
] as const;

const D = FEATURES.length;

type Row = {
  stem: string;
  at: number;
  noteId: string;
  accepted: boolean;
  reason: string;
  settled: boolean;
  x: number[];
  y: 0 | 1;
  /** The label this row is the decision for, when it is a positive. */
  labelId: string | null;
  /** Whether the matcher gave that label a detection in the end. */
  labelMatched: boolean | null;
};

/* -------------------------------------------------------------------------- */
/* Collection                                                                  */
/* -------------------------------------------------------------------------- */

function collect(): Row[] {
  const rows: Row[] = [];
  for (const fixture of decodeFixtures({ quiet: true })) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const events: TrackerTraceEvent[] = [];
    const analysis = analyzeSamples(mono, wav.sampleRate, {
      trackerTrace: (event) => events.push(event),
    });
    const detections = projectEmissions(analysis.emissions).final;
    const labels = fixture.label.events as LabeledEvent[];
    const matched = new Set(matchEvents(labels, detections).matches.map((m) => m.label.id));

    /**
     * The boundaries already found when each decision is taken, accumulated in
     * TRACE ORDER rather than by timestamp.
     *
     * It has to be trace order. A split backdates its successor to the first
     * transient of the attack burst, which can be earlier than the hop that
     * decided -- so an accepted decision would find its OWN successor sitting
     * before it on the timeline and mark itself already covered. That is the
     * circularity this target exists to avoid, and it is silent: it does not
     * make the numbers look wrong, it just deletes the true positives.
     */
    const openedSoFar: number[] = [];

    for (const event of events) {
      if (event.kind === "opened") {
        openedSoFar.push(event.at);
        continue;
      }
      if (event.kind !== "rearticulation") continue;
      const t = event.at;

      // The nearest label to this decision, if any is near enough.
      let near: LabeledEvent | null = null;
      for (const label of labels) {
        const d = Math.abs(label.startMs - t);
        if (d > WINDOW_MS) continue;
        if (near === null || d < Math.abs(near.startMs - t)) near = label;
      }

      // Already accounted for? A Note opened before this decision and within
      // the window of that label IS the boundary the label needed.
      let covered = false;
      if (near !== null) {
        for (const at of openedSoFar) {
          if (Math.abs(at - near.startMs) <= WINDOW_MS) {
            covered = true;
            break;
          }
        }
      }
      const positive = near !== null && !covered;

      rows.push({
        stem: fixture.stem,
        at: t,
        noteId: event.noteId,
        accepted: event.accepted,
        reason: event.reason,
        settled: event.settled,
        x: [
          event.sharpness,
          event.heldSharpness,
          event.fluxRatio,
          event.heldFluxRatio,
          event.riseRatio,
          event.envelopeOverBaseline,
          event.decayExcess ?? 0,
          event.soundedMs,
          event.pitchDiffers ? 1 : 0,
          event.gliding ? 1 : 0,
          event.kernelOnset ? 1 : 0,
          event.bloomed ? 1 : 0,
        ],
        y: positive ? 1 : 0,
        labelId: positive && near !== null ? near.id : null,
        labelMatched: positive && near !== null ? matched.has(near.id) : null,
      });
    }
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Statistics. Deliberately hand-rolled: this is a script, not engine code, and */
/* it must not add a dependency to measure something that may be dropped.       */
/* -------------------------------------------------------------------------- */

/** Rank-based ROC AUC, ties averaged. 0.5 is a coin toss, 1.0 is perfect. */
function auc(scores: readonly number[], y: readonly number[]): number {
  const order = scores.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
  const rank = new Array<number>(scores.length).fill(0);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && (order[j + 1] as readonly [number, number])[0] === (order[i] as readonly [number, number])[0]) {
      j++;
    }
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[(order[k] as readonly [number, number])[1]] = shared;
    i = j + 1;
  }
  let pos = 0;
  let sumRank = 0;
  for (let i = 0; i < y.length; i++) {
    if (y[i] === 1) {
      pos++;
      sumRank += rank[i] as number;
    }
  }
  const neg = y.length - pos;
  if (pos === 0 || neg === 0) return 0.5;
  return (sumRank - (pos * (pos + 1)) / 2) / (pos * neg);
}

type Standardiser = { mean: number[]; sd: number[] };

function standardiser(rows: readonly Row[], cols: readonly number[]): Standardiser {
  const mean: number[] = [];
  const sd: number[] = [];
  for (const c of cols) {
    let m = 0;
    for (const r of rows) m += r.x[c] as number;
    m /= Math.max(rows.length, 1);
    let v = 0;
    for (const r of rows) v += ((r.x[c] as number) - m) ** 2;
    v /= Math.max(rows.length - 1, 1);
    mean.push(m);
    sd.push(Math.sqrt(v) > 1e-9 ? Math.sqrt(v) : 1);
  }
  return { mean, sd };
}

function design(rows: readonly Row[], cols: readonly number[], s: Standardiser): number[][] {
  return rows.map((r) =>
    cols.map((c, k) => ((r.x[c] as number) - (s.mean[k] as number)) / (s.sd[k] as number))
  );
}

/**
 * L2-regularised logistic regression by full-batch gradient descent.
 *
 * Standardised inputs, so a single step size works for every column; the bias
 * is not penalised. Returns weights with the bias last. Four thousand steps is
 * well past convergence for problems this size, and the objective is convex, so
 * there is no restart to worry about.
 *
 * The step is capped at `1 / (2 * lambda)`. Without that cap the ridge term
 * alone multiplies each weight by `1 - lr * lambda` every step, which at
 * lr 0.3 and lambda 10 is -2: the fit diverges to NaN and every downstream AUC
 * silently becomes a comparison between NaNs.
 */
function fitLogistic(
  X: readonly number[][],
  y: readonly number[],
  lambda: number,
  steps = 4000,
  step = 0.3
): number[] {
  const lr = lambda > 0 ? Math.min(step, 1 / (2 * lambda)) : step;
  const n = X.length;
  const d = n === 0 ? 0 : (X[0] as number[]).length;
  const w = new Array<number>(d + 1).fill(0);
  if (n === 0) return w;
  for (let step = 0; step < steps; step++) {
    const g = new Array<number>(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i] as number[];
      let z = w[d] as number;
      for (let j = 0; j < d; j++) z += (w[j] as number) * (xi[j] as number);
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const e = p - (y[i] as number);
      for (let j = 0; j < d; j++) g[j] = (g[j] as number) + e * (xi[j] as number);
      g[d] = (g[d] as number) + e;
    }
    for (let j = 0; j <= d; j++) {
      const reg = j < d ? lambda * (w[j] as number) : 0;
      w[j] = (w[j] as number) - lr * ((g[j] as number) / n + reg);
    }
  }
  // A diverged fit is worse than no fit: it produces NaN scores, and NaN
  // sorts arbitrarily, so the AUC that comes out looks like a real number.
  for (const v of w) {
    if (!Number.isFinite(v)) throw new Error(`logistic fit diverged at lambda ${lambda}`);
  }
  return w;
}

function score(X: readonly number[][], w: readonly number[]): number[] {
  const d = w.length - 1;
  return X.map((xi) => {
    let z = w[d] as number;
    for (let j = 0; j < d; j++) z += (w[j] as number) * (xi[j] as number);
    return z;
  });
}

/**
 * The loosest threshold that keeps every positive, and what it costs.
 *
 * Returns the count of negatives at or above the lowest-scoring positive: the
 * number of Notes a rule at that operating point would invent in order to lose
 * no labelled stroke.
 */
function zeroCost(
  scores: readonly number[],
  y: readonly number[]
): { threshold: number; falseAccepts: number; negatives: number } {
  let threshold = Infinity;
  for (let i = 0; i < y.length; i++) {
    if (y[i] === 1) threshold = Math.min(threshold, scores[i] as number);
  }
  let falseAccepts = 0;
  let negatives = 0;
  for (let i = 0; i < y.length; i++) {
    if (y[i] === 1) continue;
    negatives++;
    if ((scores[i] as number) >= threshold) falseAccepts++;
  }
  return { threshold, falseAccepts, negatives };
}

/** Stratified k-fold assignment: deterministic, no RNG, balanced by class. */
function stratifiedFolds(y: readonly number[], k: number): number[] {
  const fold = new Array<number>(y.length).fill(0);
  let p = 0;
  let n = 0;
  for (let i = 0; i < y.length; i++) {
    if (y[i] === 1) fold[i] = p++ % k;
    else fold[i] = n++ % k;
  }
  return fold;
}

/**
 * Out-of-fold scores for one feature set. `folds` names each row's held-out
 * fold; standardisation is refitted inside each fold's training half, because
 * fitting it on everything leaks the held-out take's own scale -- which is the
 * exact quantity under investigation.
 */
function outOfFold(
  rows: readonly Row[],
  cols: readonly number[],
  folds: readonly number[],
  lambda: number
): number[] {
  const ids = [...new Set(folds)];
  const out = new Array<number>(rows.length).fill(0);
  for (const id of ids) {
    const trainIdx: number[] = [];
    const testIdx: number[] = [];
    for (let i = 0; i < rows.length; i++) (folds[i] === id ? testIdx : trainIdx).push(i);
    const train = trainIdx.map((i) => rows[i] as Row);
    const test = testIdx.map((i) => rows[i] as Row);
    if (train.length === 0 || test.length === 0) continue;
    const s = standardiser(train, cols);
    const w = fitLogistic(
      design(train, cols, s),
      train.map((r) => r.y),
      lambda
    );
    const sc = score(design(test, cols, s), w);
    testIdx.forEach((i, k) => (out[i] = sc[k] as number));
  }
  return out;
}

function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  if (saa < 1e-12 || sbb < 1e-12) return 0;
  return sab / Math.sqrt(saa * sbb);
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

function table(head: readonly string[], body: readonly (readonly string[])[]): void {
  const all = [head, ...body];
  const width: number[] = [];
  for (const row of all) row.forEach((c, i) => (width[i] = Math.max(width[i] ?? 0, c.length)));
  const line = (row: readonly string[]): string =>
    "  " +
    row
      .map((c, i) => (i === 0 ? c.padEnd(width[i] as number) : c.padStart(width[i] as number)))
      .join("  ");
  console.log(line(head));
  console.log("  " + width.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}

const f2 = (x: number): string => x.toFixed(2);
const f3 = (x: number): string => x.toFixed(3);

/** The derivation set: everything that is not one of the twelve 140bpm takes. */
const isHeldOut = (stem: string): boolean => stem.includes("140bpm");

function main(): void {
  const dumpRows = process.argv.includes("--rows");
  const rows = collect();
  const derive = rows.filter((r) => !isHeldOut(r.stem));
  const held = rows.filter((r) => isHeldOut(r.stem));
  const cols = FEATURES.map((_, i) => i);

  const stemsOf = (rs: readonly Row[]): string[] => [...new Set(rs.map((r) => r.stem))];
  const posOf = (rs: readonly Row[]): number => rs.filter((r) => r.y === 1).length;
  const labelsOf = (rs: readonly Row[]): number =>
    new Set(rs.filter((r) => r.labelId !== null).map((r) => `${r.stem}/${r.labelId}`)).size;

  console.log("\n  THE DECISION TABLE");
  console.log(
    "\n  Every attack that reached RearticulationDetector.verdict over a sounding\n" +
      "  Note. Positive = a labelled stroke begins within 70ms and no already-open\n" +
      "  Note accounts for it, so the split SHOULD have been made.\n"
  );
  table(
    ["set", "takes", "rows", "positives", "base rate", "distinct labels"],
    [
      [
        "derivation (120bpm)",
        String(stemsOf(derive).length),
        String(derive.length),
        String(posOf(derive)),
        f3(posOf(derive) / Math.max(derive.length, 1)),
        String(labelsOf(derive)),
      ],
      [
        "held out (140bpm)",
        String(stemsOf(held).length),
        String(held.length),
        String(posOf(held)),
        f3(posOf(held) / Math.max(held.length, 1)),
        String(labelsOf(held)),
      ],
    ]
  );

  console.log("\n  per take\n");
  table(
    ["take", "rows", "pos", "labels", "accepted", "settled", "current TP", "current FP"],
    stemsOf(rows).map((stem) => {
      const rs = rows.filter((r) => r.stem === stem);
      return [
        stem,
        String(rs.length),
        String(posOf(rs)),
        String(labelsOf(rs)),
        String(rs.filter((r) => r.accepted).length),
        String(rs.filter((r) => r.settled).length),
        String(rs.filter((r) => r.accepted && r.y === 1).length),
        String(rs.filter((r) => r.accepted && r.y === 0).length),
      ];
    })
  );

  // What the current code scores on this same table, as the thing to beat.
  // What the tracker ACTED on is `accepted && settled`: an acceptance on a
  // Note too young to be ended is recorded here and then discarded upstream,
  // so counting it as a split the code made would overstate both columns.
  const confusion = (rs: readonly Row[], acted: boolean): string => {
    const yes = (r: Row): boolean => r.accepted && (!acted || r.settled);
    const tp = rs.filter((r) => yes(r) && r.y === 1).length;
    const fp = rs.filter((r) => yes(r) && r.y === 0).length;
    const fn = rs.filter((r) => !yes(r) && r.y === 1).length;
    const tn = rs.filter((r) => !yes(r) && r.y === 0).length;
    return `TP ${tp}  FP ${fp}  FN ${fn}  TN ${tn}`;
  };
  console.log("\n  the current rule on this table");
  console.log(`    derivation, verdict only   ${confusion(derive, false)}`);
  console.log(`    derivation, splits acted   ${confusion(derive, true)}`);
  console.log(`    held out,   verdict only   ${confusion(held, false)}`);
  console.log(`    held out,   splits acted   ${confusion(held, true)}`);
  const missedPos = derive.filter((r) => r.y === 1 && r.labelMatched === false).length;
  console.log(
    `\n    ${missedPos} of ${posOf(derive)} derivation positives sit at a label the matcher\n` +
      "    never gave a detection; the rest are strokes some other Note recovered."
  );

  /* ---- 1. Single witnesses ------------------------------------------------ */

  console.log("\n\n  1. SINGLE-WITNESS SEPARATION (derivation)\n");
  const yAll = derive.map((r) => r.y);
  const singles = cols.map((c) => {
    const s = derive.map((r) => r.x[c] as number);
    const a = auc(s, yAll);
    // A witness that separates by being LOW is as useful as one that separates
    // by being high; report the oriented figure alongside the raw one.
    const oriented = Math.max(a, 1 - a);
    const zc = zeroCost(a >= 0.5 ? s : s.map((v) => -v), yAll);
    return { c, a, oriented, zc };
  });
  singles.sort((p, q) => q.oriented - p.oriented);
  table(
    ["witness", "AUC", "oriented", "dir", "FP at zero label cost"],
    singles.map((s) => [
      FEATURES[s.c] as string,
      f3(s.a),
      f3(s.oriented),
      s.a >= 0.5 ? "high" : "low",
      `${s.zc.falseAccepts} / ${s.zc.negatives}`,
    ])
  );
  const bestSingle = singles[0] as (typeof singles)[number];

  /* ---- 2. Correlations ---------------------------------------------------- */

  console.log("\n\n  2. THE WITNESSES ARE NOT INDEPENDENT (derivation, Pearson r)\n");
  const pairsCorr: Array<{ i: number; j: number; r: number }> = [];
  for (let i = 0; i < D; i++) {
    for (let j = i + 1; j < D; j++) {
      pairsCorr.push({
        i,
        j,
        r: pearson(
          derive.map((r) => r.x[i] as number),
          derive.map((r) => r.x[j] as number)
        ),
      });
    }
  }
  pairsCorr.sort((p, q) => Math.abs(q.r) - Math.abs(p.r));
  table(
    ["pair", "r"],
    pairsCorr.slice(0, 8).map((p) => [`${FEATURES[p.i]} / ${FEATURES[p.j]}`, f3(p.r)])
  );

  /* ---- 3. The combination ------------------------------------------------- */

  const y = yAll;
  const stems = stemsOf(derive);
  const takeFold = derive.map((r) => stems.indexOf(r.stem));
  const kFold = stratifiedFolds(y, 5);
  const LAMBDAS = [0.01, 0.1, 1, 10];

  console.log("\n\n  3. ALL TWELVE TOGETHER: L2 LOGISTIC REGRESSION (derivation)\n");
  const fits = LAMBDAS.map((lambda) => {
    const s = standardiser(derive, cols);
    const w = fitLogistic(design(derive, cols, s), y, lambda);
    const inSample = auc(score(design(derive, cols, s), w), y);
    const cv5 = auc(outOfFold(derive, cols, kFold, lambda), y);
    const loo = outOfFold(derive, cols, takeFold, lambda);
    return { lambda, w, s, inSample, cv5, loto: auc(loo, y), zc: zeroCost(loo, y) };
  });
  table(
    ["lambda", "in-sample AUC", "5-fold AUC", "leave-one-take-out AUC", "FP at zero label cost"],
    fits.map((f) => [
      String(f.lambda),
      f3(f.inSample),
      f3(f.cv5),
      f3(f.loto),
      `${f.zc.falseAccepts} / ${f.zc.negatives}`,
    ])
  );
  const best = fits.reduce((a, b) => (b.loto > a.loto ? b : a));
  console.log(
    `\n    best single witness, for comparison: ${FEATURES[bestSingle.c]} at ` +
      `${f3(bestSingle.oriented)} in-sample.`
  );
  console.log(`\n    fitted weights, standardised units (lambda = ${best.lambda})\n`);
  table(
    ["witness", "weight"],
    cols
      .map((c) => ({ c, w: best.w[c] as number }))
      .sort((p, q) => Math.abs(q.w) - Math.abs(p.w))
      .map((p) => [FEATURES[p.c] as string, f2(p.w)])
  );

  /* ---- 3b. Pooled against within-take ------------------------------------- */

  // The difference between these two columns is the whole defect. A model
  // scored WITHIN the take it was fitted on shares that take's scale; scored on
  // a take it has never seen, it does not. If the combination carried real
  // information the two would move together.
  console.log("\n\n  3b. WITHIN A TAKE VERSUS ACROSS TAKES (derivation)\n");
  const loFits = outOfFold(derive, cols, takeFold, best.lambda);
  const sAll = standardiser(derive, cols);
  const inFits = score(design(derive, cols, sAll), best.w);
  table(
    ["take", "pos", "neg", "sharpness AUC", "12-witness in-sample", "12-witness held-out fold"],
    stems.map((stem) => {
      const idx = derive.map((r, i) => [r, i] as const).filter(([r]) => r.stem === stem);
      const ys = idx.map(([r]) => r.y);
      const p = ys.filter((v) => v === 1).length;
      return [
        stem,
        String(p),
        String(ys.length - p),
        p === 0 || p === ys.length
          ? "-"
          : f3(auc(idx.map(([r]) => r.x[bestSingle.c] as number), ys)),
        p === 0 || p === ys.length ? "-" : f3(auc(idx.map(([, i]) => inFits[i] as number), ys)),
        p === 0 || p === ys.length ? "-" : f3(auc(idx.map(([, i]) => loFits[i] as number), ys)),
      ];
    })
  );

  /* ---- 4. Two at a time --------------------------------------------------- */

  console.log("\n\n  4. EXHAUSTIVE TWO-WITNESS SWEEP (derivation, leave-one-take-out)\n");
  const pairScores: Array<{ i: number; j: number; loto: number; fp: number; neg: number }> = [];
  for (let i = 0; i < D; i++) {
    for (let j = i + 1; j < D; j++) {
      const oof = outOfFold(derive, [i, j], takeFold, best.lambda);
      const zc = zeroCost(oof, y);
      pairScores.push({ i, j, loto: auc(oof, y), fp: zc.falseAccepts, neg: zc.negatives });
    }
  }
  pairScores.sort((p, q) => q.loto - p.loto);
  table(
    ["pair", "leave-one-take-out AUC", "FP at zero label cost"],
    pairScores
      .slice(0, 10)
      .map((p) => [`${FEATURES[p.i]} + ${FEATURES[p.j]}`, f3(p.loto), `${p.fp} / ${p.neg}`])
  );
  const bestPair = pairScores[0] as (typeof pairScores)[number];

  /* ---- 5. Held out -------------------------------------------------------- */

  console.log("\n\n  5. HELD OUT: THE TWELVE 140bpm TAKES\n");
  console.log(
    "  Fitted on the five derivation takes only, standardised on their statistics,\n" +
      "  and scored here with nothing refitted and nothing tuned. The operating\n" +
      "  point is the derivation set's own zero-label-cost threshold.\n"
  );
  const yh = held.map((r) => r.y);
  const heldRuns: Array<readonly string[]> = [];
  const evaluate = (name: string, cs: readonly number[], lambda: number): void => {
    const s = standardiser(derive, cs);
    const w = fitLogistic(design(derive, cs, s), y, lambda);
    const dScores = score(design(derive, cs, s), w);
    const hScores = score(design(held, cs, s), w);
    const cut = zeroCost(dScores, y).threshold;
    let kept = 0;
    let lost = 0;
    let fp = 0;
    for (let i = 0; i < held.length; i++) {
      const above = (hScores[i] as number) >= cut;
      if (yh[i] === 1) {
        if (above) kept++;
        else lost++;
      } else if (above) fp++;
    }
    heldRuns.push([
      name,
      f3(auc(dScores, y)),
      f3(auc(hScores, yh)),
      `${kept} / ${kept + lost}`,
      String(lost),
      `${fp} / ${yh.filter((v) => v === 0).length}`,
    ]);
  };
  evaluate("all twelve witnesses", cols, best.lambda);
  evaluate(
    `best pair: ${FEATURES[bestPair.i]} + ${FEATURES[bestPair.j]}`,
    [bestPair.i, bestPair.j],
    best.lambda
  );
  evaluate(`best single: ${FEATURES[bestSingle.c]}`, [bestSingle.c], best.lambda);
  table(
    ["rule", "derivation AUC", "held-out AUC", "positives kept", "labels lost", "false accepts"],
    heldRuns
  );

  if (dumpRows) {
    console.log("\n\n  EVERY ROW\n");
    table(
      ["take", "at", "note", "y", "accepted", "reason", ...FEATURES],
      rows.map((r) => [
        r.stem,
        r.at.toFixed(0),
        r.noteId,
        String(r.y),
        r.accepted ? "yes" : "no",
        r.reason,
        ...r.x.map((v) => f2(v)),
      ])
    );
  }
  console.log("");
}

main();
