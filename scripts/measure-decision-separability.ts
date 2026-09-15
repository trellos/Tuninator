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
 * READING THE ROW AGAINST THE PACE
 *
 * Every witness above is read AT the boundary, and every one of them tops out
 * near 0.70 AUC — including a 19,833-parameter conv net over a spectrogram
 * patch ending at the decision hop (DECISION-021, 0.7157). What finally moved
 * the same-pitch decision (DECISION-030) was not a better reading of the
 * boundary but a different question: a fragment's span over the LOCAL
 * INTER-ONSET INTERVAL scores 0.926 with an oracle rate and 0.826 with a causal
 * estimate, against 0.788 for the span alone. That framing had never been
 * offered to a fitted model, so this script now carries it, in two groups that
 * are reported SEPARATELY because they imply different products:
 *
 *   GROUP P, PROSPECTIVE — computable at the instant the decision is taken, so
 *   a model over them could run in the fast lane: `localIoiMs` (the tracker's
 *   own rate estimate, re-implemented exactly, no fallback), `soundedOverIoi`,
 *   `gapBeforeOverIoi`, `gapCv8`, and the missingness indicator `rateMissing`.
 *
 *   GROUP R, RETROSPECTIVE — knowable only afterwards, so a model over them
 *   could only run in the deep lane, announcing a Note and sometimes retracting
 *   it: `nextBoundaryMs` and `nextBoundaryOverIoi`.
 *
 * P failing while R passes would be a real finding rather than a failure: it
 * would say the evidence does not exist at decision time and that a
 * retraction-based design is the only one that could use it.
 *
 * MISSING VALUES ARE MISSING, NOT ZERO. `localIoiMs` has no fallback — with no
 * usable gap between recent openings there is no pace to judge against. A 500ms
 * fallback is the measured regression in `docs/DETECTION-FINDINGS.md`, so the
 * feature is NaN on those rows, the regression mean-imputes from the training
 * half of each fold and carries `rateMissing` alongside, and a single-feature
 * AUC is taken over the present rows only with its n printed next to it.
 *
 * AUC is the headline because the classes are wildly imbalanced (see the base
 * rates it prints): accuracy would be beaten by "reject everything".
 *
 * AUC ALSO DOES NOT SHIP ANYTHING. It answers "does the information exist at
 * all", which is what this gate is for. This project has had an offline bench
 * number disagree with the real pipeline five times; no claim of a recognizer
 * improvement may rest on a figure from this file.
 *
 * WHAT WOULD FALSIFY THE VERDICT
 *
 *  - A combination whose leave-one-take-out AUC clears the best single witness
 *    by a margin larger than the spread across folds, AND holds on the twelve
 *    held-out takes. Then the combination is real and worth building. For the
 *    rhythm groups that bar is stated as a number in advance: LOTO above 0.702,
 *    by more than the spread across the thirteen LOTO folds, and materially
 *    more than 0 of 635 false positives removed at zero label cost.
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
import { fileURLToPath } from "node:url";
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
export const FEATURES = [
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

/* -------------------------------------------------------------------------- */
/* Rhythm features. See the header, "READING THE ROW AGAINST THE PACE".         */
/* -------------------------------------------------------------------------- */

/**
 * GROUP P — PROSPECTIVE. Every one of these is computable at the instant the
 * decision is taken, from openings the tracker has already emitted. A model
 * over these could run in the fast lane.
 *
 * `rateMissing` is the missingness INDICATOR, not a rhythm reading: it is 1 on
 * a row where no local rate could be measured at all. It is listed here because
 * every other column in this group is undefined on exactly those rows, and
 * mean-imputing them without an indicator would tell the regression those rows
 * are average when what is true of them is that they are unknown.
 */
export const PROSPECTIVE_FEATURES = [
  "localIoiMs",
  "soundedOverIoi",
  "gapBeforeOverIoi",
  "gapCv8",
  "rateMissing",
] as const;

/**
 * GROUP R — RETROSPECTIVE. Not knowable when the decision is taken. A model
 * over these can only run in the deep lane, which means announcing a Note and
 * sometimes retracting it. Kept separate from group P for exactly that reason:
 * the two groups imply different products, so a gain that lives only here is a
 * different finding from a gain that lives in P.
 */
export const RETROSPECTIVE_FEATURES = ["nextBoundaryMs", "nextBoundaryOverIoi"] as const;

export const RHYTHM_FEATURES = [...PROSPECTIVE_FEATURES, ...RETROSPECTIVE_FEATURES] as const;

/**
 * Every column of a WIDE row: the twelve witnesses then the seven rhythm
 * columns. `FEATURES` itself deliberately stays twelve long and `Row.x` stays
 * twelve wide, because four other scripts index `Row.x` by `FEATURES` position
 * and one of them appends its own columns at `FEATURES.length`.
 */
export const WIDE_FEATURES = [...FEATURES, ...RHYTHM_FEATURES] as const;

/** How many recent gaps the rate estimate reads. `NoteTracker.RATE_GAPS`. */
const RATE_GAPS = 8;
/** `NoteTracker.RATE_PERCENTILE` — 0.5, the median. */
const RATE_PERCENTILE = 0.5;
/** `NoteTracker.RATE_MIN_INTERVAL_MS`. */
const RATE_MIN_INTERVAL_MS = 50;
/** `NoteTracker.RATE_RESET_MS`. */
const RATE_RESET_MS = 1500;
/** `NoteTracker` keeps this many openings; the walk cannot see past them. */
const OPEN_TIMES_KEPT = RATE_GAPS * 4;

/**
 * The gaps `NoteTracker.localIoiMs` would collect, and the median it would
 * return — re-implemented here over the `opened` trace events rather than
 * imported, because the tracker's copy is private and this script must not
 * change `src/`.
 *
 * Deliberately faithful down to the details that look like accidents:
 *
 *  - the walk runs backwards from the newest opening and takes at most eight
 *    gaps, over a ring that holds only the last thirty-two openings;
 *  - an opening at or after `at` is SKIPPED, not stopped at, and its gap to the
 *    one before it is never formed — the opening being judged must not enter
 *    its own estimate;
 *  - the 1500ms reset is tested BEFORE the 50ms floor, so a long gap ends the
 *    walk even when the gap after it was too short to count;
 *  - **there is no fallback.** With no usable gap this returns null and the
 *    feature is MISSING. A 500ms fallback — a whole note at 120bpm, applied at
 *    3.7s into a take playing 107ms sixteenths — is the measured regression
 *    recorded in `docs/DETECTION-FINDINGS.md`, and substituting any constant
 *    here would put that same lie into the design matrix.
 */
function localIoi(openTimes: readonly number[], at: number): { ioi: number | null; gaps: number[] } {
  const gaps: number[] = [];
  for (let i = openTimes.length - 1; i > 0 && gaps.length < RATE_GAPS; i--) {
    const later = openTimes[i] as number;
    if (later >= at) continue;
    const gap = later - (openTimes[i - 1] as number);
    if (gap > RATE_RESET_MS) break;
    if (gap < RATE_MIN_INTERVAL_MS) continue;
    gaps.push(gap);
  }
  if (gaps.length === 0) return { ioi: null, gaps };
  const sorted = [...gaps].sort((a, b) => a - b);
  const ioi = sorted[
    Math.min(sorted.length - 1, Math.round((sorted.length - 1) * RATE_PERCENTILE))
  ] as number;
  return { ioi, gaps };
}

/**
 * The most recent opening-to-opening gap strictly before `at`, unfiltered.
 *
 * Unfiltered on purpose. `localIoi` throws away gaps under 50ms because a
 * median wants to describe the pace; this feature wants to describe the LAST
 * thing that happened, and a 30ms gap is a real and highly informative event —
 * it is what a burst of phantom boundaries looks like from the inside.
 */
function lastGapMs(openTimes: readonly number[], at: number): number | null {
  for (let i = openTimes.length - 1; i > 0; i--) {
    if ((openTimes[i] as number) >= at) continue;
    return (openTimes[i] as number) - (openTimes[i - 1] as number);
  }
  return null;
}

/** Coefficient of variation of a gap list; undefined below two gaps. */
function cv(values: readonly number[]): number {
  if (values.length < 2) return NaN;
  let m = 0;
  for (const v of values) m += v;
  m /= values.length;
  if (Math.abs(m) < 1e-9) return NaN;
  let s = 0;
  for (const v of values) s += (v - m) ** 2;
  return Math.sqrt(s / (values.length - 1)) / m;
}

export type Row = {
  stem: string;
  at: number;
  noteId: string;
  accepted: boolean;
  reason: string;
  settled: boolean;
  x: number[];
  /**
   * The rhythm columns, in `RHYTHM_FEATURES` order. A SEPARATE field rather
   * than more of `x`, so that every other script indexing `x` by `FEATURES`
   * position keeps reading what it read before. `NaN` means MISSING — see
   * `standardiser`/`design`, which mean-impute it.
   *
   * Optional because `training/score-falsifiers.ts` builds synthetic rows that
   * carry one score and no witnesses at all; `collectFixture` always sets it.
   */
  rhythm?: number[];
  y: 0 | 1;
  /** The label this row is the decision for, when it is a positive. */
  labelId: string | null;
  /** Whether the matcher gave that label a detection in the end. */
  labelMatched: boolean | null;
  /**
   * The nearest label within the window, positive or not. A negative row with
   * a label here is a decision AT a labelled stroke that some open Note
   * already accounts for — the population `build-relabel-kit.ts` needs for
   * "detector and target disagree at a label".
   */
  nearLabelId: string | null;
  nearLabelStartMs: number | null;
  /**
   * The Note this decision opened, and whether the MATCHER paired that Note
   * with a label — `measure-rate-relative-merge.ts`'s target, carried here so
   * the two studies can be read against each other on identical rows. Null on a
   * decision that opened nothing, and on every row when `collect` was not given
   * the paired set.
   */
  childId?: string | null;
  childPaired?: boolean | null;
};

/* -------------------------------------------------------------------------- */
/* Collection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The decision rows of ONE fixture, from its trace and labels. Extracted from
 * `collect` unchanged so `build-relabel-kit.ts` can build the identical row
 * population inside its own single pass over the corpus.
 */
export function collectFixture(
  stem: string,
  labels: readonly LabeledEvent[],
  events: readonly TrackerTraceEvent[],
  matched: ReadonlySet<string>,
  /** Ids of the DETECTIONS the matcher paired. Optional; see `Row.childPaired`. */
  paired?: ReadonlySet<string>
): Row[] {
  const rows: Row[] = [];

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

  /**
   * The tracker's own `openTimes` ring, mirrored exactly: push order, capped at
   * thirty-two. Separate from `openedSoFar` above, which is uncapped because
   * the TARGET rule needs every opening of the take and the RATE estimate must
   * see only what the tracker would have had.
   */
  const openTimes: number[] = [];

  for (let k = 0; k < events.length; k++) {
    const event = events[k] as TrackerTraceEvent;
    if (event.kind === "opened") {
      openedSoFar.push(event.at);
      openTimes.push(event.at);
      if (openTimes.length > OPEN_TIMES_KEPT) openTimes.shift();
      continue;
    }
    if (event.kind !== "rearticulation") continue;
    const t = event.at;

    /* ---- Group P: what the pace looks like from here, looking back --------- */

    const { ioi, gaps } = localIoi(openTimes, t);
    const gapBefore = lastGapMs(openTimes, t);
    const prospective = [
      ioi ?? NaN,
      ioi === null ? NaN : event.soundedMs / ioi,
      ioi === null || gapBefore === null ? NaN : gapBefore / ioi,
      cv(gaps),
      ioi === null ? 1 : 0,
    ];

    /* ---- Group R: what the pace looks like from here, looking forward ------ */

    /*
     * The next Note boundary of any kind: the first `opened` or `ended` that
     * comes after this decision in TRACE order AND carries a timestamp after
     * it.
     *
     * Both halves of that are load-bearing, and both exist to keep the feature
     * defined on the same terms for an accepted row and a rejected one. A split
     * ends the old Note and opens the new one at the BURST, which is at or
     * before the deciding hop — so an accepted decision's own two boundary
     * events both fail `at > t` and are skipped, and what is found instead is
     * the end of the Note that decision opened. That is the span of the new
     * Note, which is what the feature is supposed to mean. Trace order alone
     * would return the decision's own consequences and read ~0 on every accept;
     * timestamp alone would let a backdated boundary from before the decision
     * count as its future.
     */
    let nextBoundaryMs = NaN;
    for (let j = k + 1; j < events.length; j++) {
      const later = events[j] as TrackerTraceEvent;
      if (later.kind !== "opened" && later.kind !== "ended") continue;
      if (later.at <= t) continue;
      nextBoundaryMs = later.at - t;
      break;
    }
    const retrospective = [
      nextBoundaryMs,
      ioi === null ? NaN : nextBoundaryMs / ioi,
    ];

    // The Note this decision opened: the next `opened`, before any further
    // decision. Same rule `measure-rate-relative-merge.ts` uses to find its
    // candidate child.
    let childId: string | null = null;
    for (let j = k + 1; j < events.length; j++) {
      const later = events[j] as TrackerTraceEvent;
      if (later.kind === "opened") {
        childId = later.noteId;
        break;
      }
      if (later.kind === "rearticulation") break;
    }

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
      stem,
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
      rhythm: [...prospective, ...retrospective],
      y: positive ? 1 : 0,
      labelId: positive && near !== null ? near.id : null,
      labelMatched: positive && near !== null ? matched.has(near.id) : null,
      nearLabelId: near !== null ? near.id : null,
      nearLabelStartMs: near !== null ? near.startMs : null,
      childId,
      childPaired: paired === undefined || childId === null ? null : paired.has(childId),
    });
  }
  return rows;
}

export function collect(): Row[] {
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
    const m = matchEvents(labels, detections);
    const matched = new Set(m.matches.map((x) => x.label.id));
    const paired = new Set(m.matches.map((x) => x.detection.id));
    rows.push(...collectFixture(fixture.stem, labels, events, matched, paired));
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Statistics. Deliberately hand-rolled: this is a script, not engine code, and */
/* it must not add a dependency to measure something that may be dropped.       */
/* -------------------------------------------------------------------------- */

/** Rank-based ROC AUC, ties averaged. 0.5 is a coin toss, 1.0 is perfect. */
export function auc(scores: readonly number[], y: readonly number[]): number {
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

export type Standardiser = { mean: number[]; sd: number[] };

/**
 * Column means and spreads, over the rows where the column is PRESENT.
 *
 * A rhythm column is `NaN` on a row where the tracker had no gaps to read, and
 * a mean taken over NaN is NaN, which would silently take every downstream AUC
 * with it. Skipping the missing rows here and imputing the mean in `design` is
 * the standard mean-imputation pair; the missingness itself is carried as its
 * own column (`rateMissing`) rather than being smuggled into the value.
 *
 * Every one of the twelve original witnesses is always present, so this is
 * identical to the previous behaviour on them.
 */
export function standardiser(rows: readonly Row[], cols: readonly number[]): Standardiser {
  const mean: number[] = [];
  const sd: number[] = [];
  for (const c of cols) {
    let m = 0;
    let n = 0;
    for (const r of rows) {
      const v = r.x[c] as number;
      if (Number.isFinite(v)) {
        m += v;
        n++;
      }
    }
    m /= Math.max(n, 1);
    let v = 0;
    for (const r of rows) {
      const value = r.x[c] as number;
      if (Number.isFinite(value)) v += (value - m) ** 2;
    }
    v /= Math.max(n - 1, 1);
    mean.push(m);
    sd.push(Math.sqrt(v) > 1e-9 ? Math.sqrt(v) : 1);
  }
  return { mean, sd };
}

/**
 * The standardised design matrix. A missing cell becomes 0 — the TRAINING
 * mean in standardised units, refitted inside each fold, so imputation never
 * reads the held-out take's own statistics.
 */
export function design(rows: readonly Row[], cols: readonly number[], s: Standardiser): number[][] {
  return rows.map((r) =>
    cols.map((c, k) => {
      const v = r.x[c] as number;
      if (!Number.isFinite(v)) return 0;
      return (v - (s.mean[k] as number)) / (s.sd[k] as number);
    })
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
export function fitLogistic(
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

export function score(X: readonly number[][], w: readonly number[]): number[] {
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
export function zeroCost(
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
export function outOfFold(
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

/** Pairwise-complete Pearson r: a pair is dropped when either side is missing. */
function pearson(a: readonly number[], b: readonly number[]): number {
  const idx: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (Number.isFinite(a[i] as number) && Number.isFinite(b[i] as number)) idx.push(i);
  }
  const n = idx.length;
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (const i of idx) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (const i of idx) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  if (saa < 1e-12 || sbb < 1e-12) return 0;
  return sab / Math.sqrt(saa * sbb);
}

/**
 * Single-feature AUC over the rows where the feature is PRESENT, with the size
 * of that subset.
 *
 * Reported this way rather than by imputing first, because imputing a missing
 * value to the mean and then ranking it puts a third of the rows on one tied
 * score, and the AUC that comes out is a statement about the tie rather than
 * about the feature. The subset figure answers "does this feature separate
 * where it exists", which is the question a single-witness table is for. Every
 * comparison against it in the report below is made on the same subset.
 */
function presentAuc(
  values: readonly number[],
  y: readonly number[]
): { auc: number; n: number; pos: number } {
  const s: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i] as number)) continue;
    s.push(values[i] as number);
    ys.push(y[i] as number);
  }
  return { auc: auc(s, ys), n: s.length, pos: ys.filter((v) => v === 1).length };
}

/**
 * A row with the rhythm columns appended, so `cols` can index all nineteen.
 *
 * Throws rather than padding a row that has none: a short design matrix would
 * silently shift every column index past `FEATURES.length` and the AUCs that
 * came out would be real numbers describing the wrong features.
 */
export function widen(rows: readonly Row[]): Row[] {
  return rows.map((r) => {
    const rhythm = r.rhythm;
    if (rhythm === undefined || rhythm.length !== RHYTHM_FEATURES.length) {
      throw new Error(`row ${r.stem}@${r.at} has no rhythm columns to widen`);
    }
    return { ...r, x: [...r.x, ...rhythm] };
  });
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
export const isHeldOut = (stem: string): boolean => stem.includes("140bpm");

function main(): void {
  const dumpRows = process.argv.includes("--rows");
  const rows = widen(collect());
  const derive = rows.filter((r) => !isHeldOut(r.stem));
  const held = rows.filter((r) => isHeldOut(r.stem));
  const cols = FEATURES.map((_, i) => i);

  // Column indices of the two rhythm groups inside a widened row.
  const wideIndex = (name: string): number => WIDE_FEATURES.indexOf(name as never);
  const P = PROSPECTIVE_FEATURES.map((n) => wideIndex(n));
  const R = RETROSPECTIVE_FEATURES.map((n) => wideIndex(n));
  /*
   * `rateMissing` is the missingness indicator for EVERY rate-dependent column,
   * and `nextBoundaryOverIoi` is one of those — so a group-R run that omitted
   * it would be mean-imputing without an indicator on the same rows group P
   * marks. It is listed under P because that is where the rest of its group
   * lives, and it joins any run carrying a rate-dependent column.
   */
  const Rx = [...R, wideIndex("rateMissing")];
  const RHYTHM = RHYTHM_FEATURES.map((n) => wideIndex(n));

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

  /* ---- 0. Rhythm coverage ------------------------------------------------- */

  // Reported BEFORE any AUC, because a feature that is absent on a third of the
  // rows and a feature that is absent on none are not the same instrument, and
  // the reader has to know which one every number below came from.
  console.log("\n\n  0. RHYTHM FEATURE COVERAGE: WHERE THERE IS NO RATE TO READ\n");
  console.log(
    "  `localIoiMs` has NO fallback: with no usable gap between recent Note\n" +
      "  openings there is no pace to judge against, so the feature is MISSING\n" +
      "  rather than defaulted. The regression mean-imputes a missing cell from\n" +
      "  the TRAINING half of each fold and carries `rateMissing` as its own\n" +
      "  column; a single-witness AUC below is taken over the present rows only,\n" +
      "  with its n given.\n"
  );
  const missingOf = (rs: readonly Row[], col: number): number =>
    rs.filter((r) => !Number.isFinite(r.x[col] as number)).length;
  table(
    ["feature", "derivation missing", "held-out missing", "total missing"],
    RHYTHM.map((c) => [
      WIDE_FEATURES[c] as string,
      `${missingOf(derive, c)} / ${derive.length}`,
      `${missingOf(held, c)} / ${held.length}`,
      `${missingOf(rows, c)} / ${rows.length}`,
    ])
  );
  const ioiCol = wideIndex("localIoiMs");

  /*
   * `nextBoundaryMs` has to mean the same thing on an accepted row and a
   * rejected one or the comparison is meaningless, and the way it could fail is
   * specific: a split's own `ended`/`opened` land at the BURST, which is at or
   * before the deciding hop, so if the exclusion rule were wrong every accepted
   * row would read ~0 and the feature would be measuring "was this accepted".
   * The distribution below is the check. A near-zero median on accepts, or a
   * different order of magnitude between the two rows, means the definition is
   * broken rather than the feature informative.
   */
  const nbCol = wideIndex("nextBoundaryMs");
  const quantiles = (v: readonly number[]): string => {
    const s = [...v].sort((a, b) => a - b);
    const q = (p: number): string =>
      s.length === 0 ? "-" : (s[Math.min(s.length - 1, Math.round((s.length - 1) * p))] as number).toFixed(0);
    return `n ${String(s.length).padStart(4)}   min ${q(0)}   p25 ${q(0.25)}   median ${q(0.5)}   p75 ${q(0.75)}   max ${q(1)}`;
  };
  const nb = (rs: readonly Row[]): number[] =>
    rs.map((r) => r.x[nbCol] as number).filter((v) => Number.isFinite(v));
  console.log("\n  nextBoundaryMs must be defined on BOTH halves and mean the same thing\n");
  console.log(`    accepted rows   ${quantiles(nb(rows.filter((r) => r.accepted)))}`);
  console.log(`    rejected rows   ${quantiles(nb(rows.filter((r) => !r.accepted)))}`);
  console.log(`    positives       ${quantiles(nb(rows.filter((r) => r.y === 1)))}`);
  console.log(`    negatives       ${quantiles(nb(rows.filter((r) => r.y === 0)))}`);

  console.log("\n  rows with no rate at all, per take (these are a take's opening bars)\n");
  table(
    ["take", "rows", "no rate", "share", "pos among no-rate"],
    stemsOf(rows).map((stem) => {
      const rs = rows.filter((r) => r.stem === stem);
      const none = rs.filter((r) => !Number.isFinite(r.x[ioiCol] as number));
      return [
        stem,
        String(rs.length),
        String(none.length),
        f3(none.length / Math.max(rs.length, 1)),
        String(none.filter((r) => r.y === 1).length),
      ];
    })
  );

  /* ---- 1. Single witnesses ------------------------------------------------ */

  console.log("\n\n  1. SINGLE-WITNESS SEPARATION (derivation)\n");
  const yAll = derive.map((r) => r.y);
  const single = (
    c: number
  ): { c: number; a: number; oriented: number; n: number; zc: ReturnType<typeof zeroCost> } => {
    const raw = derive.map((r) => r.x[c] as number);
    const present = presentAuc(raw, yAll);
    // A witness that separates by being LOW is as useful as one that separates
    // by being high; report the oriented figure alongside the raw one.
    const oriented = Math.max(present.auc, 1 - present.auc);
    // Zero-cost is scored over the WHOLE derivation set, with a missing cell
    // sent to -Infinity — i.e. "this rule cannot vouch for this row". Scoring it
    // on the present rows only would quietly compare operating points taken on
    // different populations.
    const signed = raw.map((v) =>
      Number.isFinite(v) ? (present.auc >= 0.5 ? v : -v) : Number.NEGATIVE_INFINITY
    );
    return { c, a: present.auc, oriented, n: present.n, zc: zeroCost(signed, yAll) };
  };
  const baseSingles = cols.map(single).sort((p, q) => q.oriented - p.oriented);
  table(
    ["witness", "AUC", "oriented", "dir", "n", "FP at zero label cost"],
    baseSingles.map((s) => [
      WIDE_FEATURES[s.c] as string,
      f3(s.a),
      f3(s.oriented),
      s.a >= 0.5 ? "high" : "low",
      String(s.n),
      `${s.zc.falseAccepts} / ${s.zc.negatives}`,
    ])
  );
  const bestSingle = baseSingles[0] as (typeof baseSingles)[number];

  console.log("\n  the rhythm features, same test\n");
  const rhythmSingles = RHYTHM.map(single).sort((p, q) => q.oriented - p.oriented);
  table(
    ["feature", "group", "AUC", "oriented", "dir", "n", "FP at zero label cost"],
    rhythmSingles.map((s) => [
      WIDE_FEATURES[s.c] as string,
      (P.includes(s.c) ? "P" : "R") + (s.c === wideIndex("rateMissing") ? " (indicator)" : ""),
      f3(s.a),
      f3(s.oriented),
      s.a >= 0.5 ? "high" : "low",
      String(s.n),
      `${s.zc.falseAccepts} / ${s.zc.negatives}`,
    ])
  );

  // A rhythm feature scored on the rows where it exists is not comparable to a
  // witness scored on all of them, so here is the incumbent on each subset.
  console.log(
    "\n  like for like: the best existing witness restricted to each feature's own\n" +
      "  present-rows subset, so the two figures describe the same population\n"
  );
  table(
    ["feature", "its AUC", "n", `${WIDE_FEATURES[bestSingle.c]} on the same rows`, "difference"],
    RHYTHM.map((c) => {
      const keep = derive.filter((r) => Number.isFinite(r.x[c] as number));
      const ys = keep.map((r) => r.y);
      const mine = auc(keep.map((r) => r.x[c] as number), ys);
      const theirs = auc(keep.map((r) => r.x[bestSingle.c] as number), ys);
      return [
        WIDE_FEATURES[c] as string,
        f3(Math.max(mine, 1 - mine)),
        String(keep.length),
        f3(Math.max(theirs, 1 - theirs)),
        f3(Math.max(mine, 1 - mine) - Math.max(theirs, 1 - theirs)),
      ];
    })
  );

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

  // Whether the rhythm columns are a new reading or a restatement of an old
  // one. Pairwise-complete, so a rhythm column's r is taken over its own rows.
  console.log("\n  each rhythm feature against its nearest of the twelve, and against each other\n");
  table(
    ["feature", "closest of the twelve", "r", "closest rhythm feature", "r"],
    RHYTHM.map((c) => {
      const mine = derive.map((r) => r.x[c] as number);
      const rank = (candidates: readonly number[]): { name: string; r: number } => {
        let best = { name: "-", r: 0 };
        for (const o of candidates) {
          if (o === c) continue;
          const r = pearson(mine, derive.map((row) => row.x[o] as number));
          if (Math.abs(r) > Math.abs(best.r)) best = { name: WIDE_FEATURES[o] as string, r };
        }
        return best;
      };
      const base = rank(cols);
      const other = rank(RHYTHM);
      return [WIDE_FEATURES[c] as string, base.name, f3(base.r), other.name, f3(other.r)];
    })
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

  /* ---- 3r. The rhythm groups --------------------------------------------- */

  /*
   * The question this section exists for: does the rate move the CROSS-TAKE
   * number, which is the one that has collapsed on every previous attempt.
   *
   * Lambda is pinned at 0.01 for the headline of every configuration — the
   * control's own best, fixed before any rhythm column was fitted — so that no
   * configuration can be rescued by choosing a different one for it. The full
   * sweep is printed underneath for each, read but not selected on.
   */
  const HEADLINE_LAMBDA = 0.01;
  type Config = { name: string; cols: number[] };
  const CONFIGS: Config[] = [
    { name: "1  twelve witnesses (control)", cols },
    { name: "2  twelve + P (prospective)", cols: [...cols, ...P] },
    { name: "3  twelve + R (retrospective)", cols: [...cols, ...Rx] },
    { name: "4  twelve + P + R", cols: [...cols, ...P, ...R] },
    { name: "5a P alone", cols: P },
    { name: "5b R alone", cols: Rx },
  ];

  const runConfig = (
    c: Config,
    lambda: number
  ): {
    inSample: number;
    cv5: number;
    loto: number;
    zc: ReturnType<typeof zeroCost>;
    perTake: Array<{ stem: string; auc: number | null }>;
    w: number[];
    s: Standardiser;
  } => {
    const s = standardiser(derive, c.cols);
    const w = fitLogistic(design(derive, c.cols, s), y, lambda);
    const inSample = auc(score(design(derive, c.cols, s), w), y);
    const cv5 = auc(outOfFold(derive, c.cols, kFold, lambda), y);
    const loo = outOfFold(derive, c.cols, takeFold, lambda);
    const perTake = stems.map((stem) => {
      const idx = derive.map((r, i) => [r, i] as const).filter(([r]) => r.stem === stem);
      const ys = idx.map(([r]) => r.y);
      const p = ys.filter((v) => v === 1).length;
      if (p === 0 || p === ys.length) return { stem, auc: null };
      return { stem, auc: auc(idx.map(([, i]) => loo[i] as number), ys) };
    });
    return { inSample, cv5, loto: auc(loo, y), zc: zeroCost(loo, y), perTake, w, s };
  };

  console.log("\n\n  3r. DO RHYTHM FEATURES MOVE THE CROSS-TAKE NUMBER? (derivation)\n");
  console.log(
    "  GROUP P is available AT the decision; group R is not, and a model over R\n" +
      "  could only run in the deep lane as announce-then-retract. They are kept\n" +
      "  apart because a gain that lives only in R is a different product.\n" +
      `  Every row here is lambda ${HEADLINE_LAMBDA}.\n`
  );
  const headline = CONFIGS.map((c) => ({ c, r: runConfig(c, HEADLINE_LAMBDA) }));
  const spreadOf = (per: Array<{ stem: string; auc: number | null }>): string => {
    const v = per.filter((p) => p.auc !== null).map((p) => p.auc as number);
    if (v.length < 2) return "-";
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
    return `${f3(Math.min(...v))}-${f3(Math.max(...v))}  sd ${f3(sd)}`;
  };
  table(
    [
      "configuration",
      "cols",
      "in-sample",
      "5-fold",
      "leave-one-take-out",
      "FP at zero label cost",
      "per-take LOTO spread",
    ],
    headline.map(({ c, r }) => [
      c.name,
      String(c.cols.length),
      f3(r.inSample),
      f3(r.cv5),
      f3(r.loto),
      `${r.zc.falseAccepts} / ${r.zc.negatives}`,
      spreadOf(r.perTake),
    ])
  );
  console.log(
    `\n    the bar stated in advance: leave-one-take-out must clear ${f3(bestSingle.oriented)}\n` +
      `    (the best single witness, ${WIDE_FEATURES[bestSingle.c]}, in sample) by more than the\n` +
      "    spread across the folds, and must remove materially more than 0 of the\n" +
      `    ${fits[0]?.zc.negatives ?? 0} false positives at a threshold costing zero labels.`
  );

  console.log("\n  the same, at every lambda (read, not selected on)\n");
  table(
    ["configuration", ...LAMBDAS.map((l) => `LOTO @ ${l}`)],
    CONFIGS.map((c) => [c.name, ...LAMBDAS.map((l) => f3(runConfig(c, l).loto))])
  );

  console.log("\n  per-take leave-one-take-out AUC, every configuration\n");
  table(
    ["take", "pos", "neg", ...CONFIGS.map((c) => c.name.slice(0, 2).trim())],
    stems.map((stem, k) => {
      const rs = derive.filter((r) => r.stem === stem);
      const p = rs.filter((r) => r.y === 1).length;
      return [
        stem,
        String(p),
        String(rs.length - p),
        ...headline.map(({ r }) => {
          const a = (r.perTake[k] as { auc: number | null }).auc;
          return a === null ? "-" : f3(a);
        }),
      ];
    })
  );

  console.log(`\n  fitted weights of the full P+R model, standardised units (lambda ${HEADLINE_LAMBDA})\n`);
  const full = headline[3] as (typeof headline)[number];
  table(
    ["feature", "group", "weight"],
    full.c.cols
      .map((c, k) => ({ c, w: full.r.w[k] as number }))
      .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
      .map((p) => [
        WIDE_FEATURES[p.c] as string,
        p.c < D ? "existing" : P.includes(p.c) ? "P" : "R",
        f2(p.w),
      ])
  );

  /* ---- 3s. Reconciling with the rate-relative study ------------------------ */

  /*
   * `measure-rate-relative-merge.ts` reports a rate-relative span at 0.83 AUC
   * causal and 0.93 with an oracle rate. Nothing in this section is meant to
   * rescue that figure; it is here so the two cannot be confused, because they
   * are not the same measurement and reading them as one would be the fifth
   * "bench ranking is not a pipeline ranking" in this repository.
   *
   * That script asks: given a Note that an accepted, settled, SAME-PITCH
   * re-articulation opened, is that Note spurious? Its population is 1,237
   * children and its feature is the child's own span.
   *
   * This table asks: given a re-articulation decision, should it have been
   * taken? Its population is every such decision — accepted or rejected, same
   * pitch or not — and on a REJECTED row no child exists, so the feature that
   * carried the other study is undefined there in substance even where it is
   * defined in arithmetic.
   *
   * Restricting to the other study's sub-population is therefore the honest
   * comparison, and it separates two very different conclusions: "the rate
   * carries nothing" from "the rate carries something, but not about the
   * question this table asks".
   */
  const sub = derive.filter(
    (r) => r.accepted && r.settled && (r.x[FEATURES.indexOf("pitchDiffers")] as number) === 0
  );
  const subY = sub.map((r) => r.y);
  console.log("\n\n  3s. THE SAME FEATURES ON THE RATE-RELATIVE STUDY'S OWN POPULATION\n");
  console.log(
    "  Accepted AND settled AND same pitch, on derivation: the decisions that\n" +
      "  actually opened a child Note, which is what `measure-rate-relative-merge.ts`\n" +
      "  measures. On these rows `nextBoundaryMs` IS that child's span.\n"
  );
  console.log(
    `    ${sub.length} rows, ${subY.filter((v) => v === 1).length} positives ` +
      `(base rate ${f3(subY.filter((v) => v === 1).length / Math.max(sub.length, 1))})\n`
  );
  /*
   * TWO TARGETS, NOT TWO POPULATIONS. Target A is this table's: a labelled
   * stroke starts within 70ms of the decision and no open Note accounts for it,
   * so the boundary SHOULD have been cut. Target B is the rate study's: the
   * matcher paired the child Note with a label, so removing that Note would
   * cost one. They are both defined on every row below, and they are not the
   * same question — A is about the boundary, B is about whether the emitted
   * Note is surplus to the labels.
   */
  const subB = sub.map((r) => (r.childPaired === true ? 1 : 0));
  const definedB = sub.filter((r) => r.childPaired !== null).length;
  const agree = sub.filter((r, i) => r.y === (subB[i] as number)).length;
  console.log(
    `    target A (this table)  positives ${subY.filter((v) => v === 1).length}` +
      `   negatives ${subY.filter((v) => v === 0).length}`
  );
  console.log(
    `    target B (rate study)  child paired ${subB.filter((v) => v === 1).length}` +
      `   child UNPAIRED ${subB.filter((v) => v === 0).length}   (defined on ${definedB})`
  );
  console.log(
    `\n    the two targets agree on ${agree} / ${sub.length} of these rows (${f3(agree / Math.max(sub.length, 1))})`
  );
  console.log(
    `      A=1, child paired      ${sub.filter((r, i) => r.y === 1 && subB[i] === 1).length}\n` +
      `      A=1, child UNPAIRED    ${sub.filter((r, i) => r.y === 1 && subB[i] === 0).length}\n` +
      `      A=0, child paired      ${sub.filter((r, i) => r.y === 0 && subB[i] === 1).length}\n` +
      `      A=0, child UNPAIRED    ${sub.filter((r, i) => r.y === 0 && subB[i] === 0).length}`
  );
  console.log("");
  table(
    ["feature", "group", "AUC vs target A", "AUC vs target B", "n", "A on the full table"],
    [...RHYTHM, ...cols].map((c) => {
      const keep = sub.map((r, i) => [r, i] as const).filter(([r]) => Number.isFinite(r.x[c] as number));
      const v = keep.map(([r]) => r.x[c] as number);
      const a = auc(v, keep.map(([r]) => r.y));
      const b = auc(v, keep.map(([, i]) => subB[i] as number));
      const all = presentAuc(derive.map((r) => r.x[c] as number), yAll);
      return [
        WIDE_FEATURES[c] as string,
        c < D ? "existing" : P.includes(c) ? "P" : "R",
        f3(Math.max(a, 1 - a)),
        f3(Math.max(b, 1 - b)),
        String(keep.length),
        f3(Math.max(all.auc, 1 - all.auc)),
      ];
    })
  );
  console.log(
    "\n    On these rows `nextBoundaryMs` IS the child Note's span, so its target-B\n" +
      "    figure is directly comparable with the 0.79 the rate study reports for\n" +
      "    the span alone, and `nextBoundaryOverIoi` with its 0.81 for the span over\n" +
      "    a causal median rate. Reproducing those two numbers here is what says the\n" +
      "    rate is implemented correctly; the target-A column beside them is what\n" +
      "    says the decision table is asking a different question."
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

  const W = WIDE_FEATURES.length;
  console.log("\n\n  4. EXHAUSTIVE TWO-FEATURE SWEEP (derivation, leave-one-take-out)\n");
  console.log(
    `  All ${(W * (W - 1)) / 2} pairs over the twelve witnesses AND the seven rhythm columns.\n` +
      "  Two features doing the job is far more useful than nineteen.\n"
  );
  const pairScores: Array<{ i: number; j: number; loto: number; fp: number; neg: number }> = [];
  for (let i = 0; i < W; i++) {
    for (let j = i + 1; j < W; j++) {
      const oof = outOfFold(derive, [i, j], takeFold, best.lambda);
      const zc = zeroCost(oof, y);
      pairScores.push({ i, j, loto: auc(oof, y), fp: zc.falseAccepts, neg: zc.negatives });
    }
  }
  pairScores.sort((p, q) => q.loto - p.loto);
  const pairName = (p: { i: number; j: number }): string =>
    `${WIDE_FEATURES[p.i]} + ${WIDE_FEATURES[p.j]}`;
  table(
    ["pair", "leave-one-take-out AUC", "FP at zero label cost"],
    pairScores
      .slice(0, 12)
      .map((p) => [pairName(p), f3(p.loto), `${p.fp} / ${p.neg}`])
  );
  const bestPair = pairScores[0] as (typeof pairScores)[number];
  const bestOldPair = pairScores.find((p) => p.i < D && p.j < D) as (typeof pairScores)[number];
  const bestNewPair = pairScores.find((p) => p.j >= D) as (typeof pairScores)[number] | undefined;
  console.log(
    `\n    best pair with no rhythm column: ${pairName(bestOldPair)} at ${f3(bestOldPair.loto)}\n` +
      (bestNewPair === undefined
        ? "    no pair involving a rhythm column was scored."
        : `    best pair WITH one:              ${pairName(bestNewPair)} at ${f3(bestNewPair.loto)}`)
  );

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
  for (const c of CONFIGS.slice(1)) evaluate(c.name, c.cols, HEADLINE_LAMBDA);
  evaluate(`best pair: ${pairName(bestPair)}`, [bestPair.i, bestPair.j], best.lambda);
  evaluate(`best single: ${WIDE_FEATURES[bestSingle.c]}`, [bestSingle.c], best.lambda);
  table(
    ["rule", "derivation AUC", "held-out AUC", "positives kept", "labels lost", "false accepts"],
    heldRuns
  );

  if (dumpRows) {
    console.log("\n\n  EVERY ROW\n");
    table(
      ["take", "at", "note", "y", "accepted", "reason", ...WIDE_FEATURES],
      rows.map((r) => [
        r.stem,
        r.at.toFixed(0),
        r.noteId,
        String(r.y),
        r.accepted ? "yes" : "no",
        r.reason,
        ...r.x.map((v) => (Number.isFinite(v) ? f2(v) : "-")),
      ])
    );
  }
  console.log("");
}

// Runs when invoked, stays quiet when imported: `measure-rig-profile.ts`
// reuses the decision table above to test a calibrated normaliser against the
// same leave-one-take-out fit, and importing this file must not re-run it.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
