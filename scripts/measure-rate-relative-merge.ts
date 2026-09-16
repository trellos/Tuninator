/**
 * Is a same-pitch fragment's span, RELATIVE TO THE LOCAL NOTE RATE, the test
 * that separates a phantom boundary from a real re-pick?
 *
 * `measure-restrike-oracle.ts` found that it is, and then measured it on a
 * candidate set narrow enough to hide most of the defect. Its candidates had to
 * end "by a pitch step", and on the same-pitch material — which is where 294 of
 * the corpus's 318 same-pitch contiguous extras live — the next event is the
 * SAME pitch, so almost none of them qualified. It reported 218 candidates
 * against a corpus carrying roughly 400 extra Notes.
 *
 * This widens the candidate set to every Note opened by an accepted, settled,
 * same-pitch re-articulation, and asks four questions the narrow version could
 * not:
 *
 *  1. Does the discriminator hold on the WHOLE population, or was it an
 *     artifact of the pitch-step subset?
 *  2. Does a CAUSAL rate estimate work, or only the oracle? The estimator here
 *     is the one the engine could actually build: the median gap between the
 *     Note openings strictly BEFORE the candidate, which is corrupted by the
 *     very phantoms it would remove. `measure-restrike-oracle.ts` showed that
 *     corruption runs in the SAFE direction — scaling the rate down to 0.5x
 *     costs no labels — and this measures it directly rather than by proxy.
 *  3. Is the test available PROSPECTIVELY? The fragment's own span needs the
 *     fragment to have ended, so a gate on it is a deep-lane retraction. The
 *     age of the predecessor AT THE BOUNDARY is in the fast lane's hand at the
 *     moment it decides. If that separates as well, the phantom can be refused
 *     instead of announced and withdrawn.
 *  4. Does it hold on the DERIVATION fixtures, separately reported, so the
 *     bar is not fitted to held-out data?
 *
 * WHAT WOULD FALSIFY IT, stated before running:
 *
 *  - Missed labels rising at all above the rule-off baseline. The standing
 *    project bar is that a rule which removes phantoms by losing played notes
 *    is not an improvement, and every gate in DECISION-028 died here.
 *  - Removing no more emitted Notes than the narrow candidate set's 72.
 *  - The causal estimator costing labels where the oracle does not. Then the
 *    rule is real and unbuildable, which is the "a bench ranking is not a
 *    pipeline ranking" failure this repository has hit four times.
 *  - A derivation-set regression at the bar chosen on the whole corpus.
 *
 * Nothing here changes engine behaviour; the merge is simulated on the
 * detection list and the matcher re-run over it, exactly as
 * `measure-restrike-oracle.ts` does, because the survivor's span grows and the
 * matcher re-pairs around it.
 *
 * Usage:
 *   npx tsx scripts/measure-rate-relative-merge.ts
 *   npx tsx scripts/measure-rate-relative-merge.ts --detail
 */

import { readFileSync } from "node:fs";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { matchEvents, type DetectedEvent, type LabeledEvent } from "../src/offline/matcher.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/** Half-width of the window the ORACLE takes its median gap from. */
const ORACLE_WINDOW_MS = 700;
/** How many recent gaps the CAUSAL estimator holds. The pace work used eight. */
const CAUSAL_GAPS = 8;
/** Two openings closer than this are one articulation, not two notes. */
const MIN_INTERVAL_MS = 50;
/** Falls back to the reference after this much silence. */
const CAUSAL_RESET_MS = 1500;
/** Used only when the causal estimator has no history yet. A whole note at 120. */
const REFERENCE_IOI_MS = 500;
/** Percentiles of the recent-gap ring the estimator is swept over. */
const PERCENTILES = [0.5, 0.6, 0.75, 0.9, 1.0];

/**
 * Derivation material: the five originals, plus the 120bpm same-pitch takes the
 * owner assigned as calibration material in DECISION-028. Every bar below is
 * chosen on THIS list and the held-out column is reported afterwards, never
 * consulted while choosing. The twelve 140bpm takes are the held-out set.
 */
const DERIVATION = [
  "chords-a-bm-g-d-2x-120bpm",
  "clean-lead-120bpm",
  "cowboy-chords-c-d-em-g-c-d-em-am-120bpm",
  "power-chords-c-a-g-e-c-d-fsharp-e-120bpm",
  "spicy-chords-cmaj9-g-am11",
  "same-pitch-quarters-a3-e5-120bpm-di",
  "same-pitch-quarters-a3-e5-120bpm-amped",
  "same-pitch-eighths-a3-120bpm-di",
  "same-pitch-eighths-a3-120bpm-amped",
  "same-pitch-eighths-sixteenths-e5-120bpm-di",
  "same-pitch-eighths-sixteenths-e5-120bpm-amped",
  "held-then-picked-six-strings-120bpm-di",
  "held-then-picked-six-strings-120bpm-amped",
];

type Candidate = {
  stem: string;
  id: string;
  previousId: string;
  startedAt: number;
  /** The fragment's own span. Retroactive: needs the fragment to have ended. */
  fragmentMs: number;
  /** How long the predecessor had sounded AT the boundary. Prospective. */
  boundaryAgeMs: number;
  previousSpanMs: number;
  /**
   * Predecessor's ONSET to the next Note's onset after this fragment.
   *
   * The structural question, and the reason it is better than the fragment's
   * own span: if one played note of length IOI was split at any point, the
   * predecessor and the fragment together still occupy ONE interval, so this
   * reads ~1 IOI wherever the split fell. Two real notes occupy two. It needs
   * no note-END estimate, which ring-out and the release grace make the
   * noisiest number in the tracker, and it is compared against 1.5 rather than
   * a tuned bar, so a 20% rate error cannot flip it.
   */
  pairSpanMs: number;
  oracleIoiMs: number;
  /** Keyed by the percentile of recent gaps the estimator took. */
  causal: Record<string, number>;
  causalIoiMs: number;
  /** Read from the audio envelope's own periodicity. Causal, and uncorrupted. */
  envIoiMs: number;
  /**
   * The dip witness AT the boundary that made this fragment.
   *
   * Near 1 means nothing fell before the transient: the boundary landed inside
   * a note still sounding at full strength. Small means the signal died away
   * first, which is what a real re-pick looks like. Independent of the rate
   * test — one reads energy, the other reads time — which is why the pair is
   * worth measuring rather than either alone. See `AttackEvidence.dipRatio`.
   */
  dipRatio: number;
  /**
   * The gap to the Note before this one, and to the Note after it.
   *
   * The owner's observation, and it needs no rate estimate at all: fast notes
   * come in GROUPS. A phantom fragment sits close behind its predecessor and is
   * then followed by a full interval of silence before the next real pick, so
   * `gapAfter / gapBefore` is large. A real fast note has neighbours the same
   * distance away on both sides, so the ratio is near 1. A very quick note
   * immediately before a long one is musically implausible.
   */
  gapBeforeMs: number;
  gapAfterMs: number;
  /**
   * How many consecutive gaps around this one are the same length as its own,
   * within 40%. The owner's "fast notes only count if there are more than three
   * of them", measured rather than assumed.
   */
  runLength: number;
  /** The fragment ended on a pitch step — the narrow script's whole filter. */
  steppedAway: boolean;
  /** The matcher paired this Note with a label, so removing it costs one. */
  paired: boolean;
};

type Take = {
  stem: string;
  derivation: boolean;
  labels: readonly LabeledEvent[];
  detections: DetectedEvent[];
  candidates: Candidate[];
  /** Every Note opening, so the rate can be re-estimated after a merge pass. */
  openings: number[];
};

function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
}

/** Median gap between labels whose starts sit within the window of `at`. */
function oracleIoi(labels: readonly LabeledEvent[], at: number): number {
  const near = labels
    .filter((l) => Math.abs(l.startMs - at) <= ORACLE_WINDOW_MS)
    .map((l) => l.startMs)
    .sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < near.length; i++) gaps.push((near[i] as number) - (near[i - 1] as number));
  return median(gaps);
}

/**
 * The estimate the engine could actually hold: a percentile of the last
 * `CAUSAL_GAPS` gaps between Note openings STRICTLY BEFORE `at`.
 *
 * Deliberately built from the detector's own output, phantoms and all, because
 * that is the only thing a causal estimator has. Its error is therefore the
 * error the shipped gate would carry.
 *
 * **Why a percentile and not the median.** A phantom boundary INSERTS an onset
 * inside a real note. That splits one true gap into two short ones: it adds
 * short gaps to the distribution and removes none of the long ones. A median
 * over a run with many phantoms therefore reads the rate systematically FAST —
 * measured here at 0.88x the truth, low on 821 of 1171 candidates — and that is
 * the whole reason the causal version of this gate underperforms its oracle.
 * An upper percentile is the natural repair, because the corruption is
 * one-directional by construction rather than as a matter of luck.
 */
function causalIoi(openings: readonly number[], at: number, percentile: number): number {
  const before = openings.filter((t) => t < at);
  if (before.length < 2) return REFERENCE_IOI_MS;
  const gaps: number[] = [];
  for (let i = before.length - 1; i > 0 && gaps.length < CAUSAL_GAPS; i--) {
    const gap = (before[i] as number) - (before[i - 1] as number);
    if (gap > CAUSAL_RESET_MS) break;
    if (gap < MIN_INTERVAL_MS) continue;
    gaps.push(gap);
  }
  if (gaps.length === 0) return REFERENCE_IOI_MS;
  const v = [...gaps].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.round((v.length - 1) * percentile))] as number;
}

/** RMS envelope hop for the audio-side rate estimator, ms. */
const ENV_HOP_MS = 10;
const ENV_WIN_MS = 20;
/** How much recent envelope the rate estimator reads. Causal: strictly behind. */
const ENV_LOOKBACK_MS = 2000;
/** The band of note periods searched. 60ms is faster than any pick in the corpus. */
const ENV_MIN_LAG_MS = 60;
const ENV_MAX_LAG_MS = 800;
/**
 * A lag qualifies if its correlation reaches this fraction of the best lag's.
 *
 * The SHORTEST qualifying lag wins, not the strongest. Standard practice in
 * tempo tracking, and this corpus documents exactly why it is needed: on the A3
 * take "the strongest envelope periodicity sits at twice the note period, on
 * the accent", while on the E5 take it sits at the note period
 * (`docs/SAME-PITCH-MATERIAL.md`). Taking the strongest lag would read the A3
 * take an octave slow, and slow is the dangerous direction here — a longer IOI
 * makes every fragment look relatively shorter and merges more.
 */
const ENV_LAG_TOLERANCE = 0.85;

function rmsEnvelope(x: Float32Array, sampleRate: number): Float64Array {
  const win = Math.max(1, Math.round((ENV_WIN_MS / 1000) * sampleRate));
  const hop = Math.max(1, Math.round((ENV_HOP_MS / 1000) * sampleRate));
  const n = Math.max(0, Math.floor((x.length - win) / hop));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const o = i * hop;
    for (let j = 0; j < win; j++) sum += (x[o + j] as number) * (x[o + j] as number);
    out[i] = Math.sqrt(sum / win);
  }
  return out;
}

/**
 * The local note period read from the AUDIO, not from the detector's output.
 *
 * This is the whole point of the experiment. Every estimator built on Note
 * openings is corrupted by the segmentation errors it exists to correct — a
 * phantom boundary inserts an onset, which inserts a short gap, which drags the
 * estimate toward the phantom's own spacing. Measured here: the pair-span test
 * scores 0.867 AUC against the true rate and 0.749 against a rate estimated
 * from openings, and the gap between those two numbers IS the circularity.
 *
 * Autocorrelation of the recent envelope has no such feedback path. It reads
 * the same evenly-spaced picks a listener hears, whatever the tracker made of
 * them. Strictly causal: only envelope behind `at` is read.
 */
function envelopeIoi(env: Float64Array, at: number): number {
  const end = Math.min(env.length, Math.floor(at / ENV_HOP_MS));
  const start = Math.max(0, end - Math.floor(ENV_LOOKBACK_MS / ENV_HOP_MS));
  const n = end - start;
  const minLag = Math.floor(ENV_MIN_LAG_MS / ENV_HOP_MS);
  const maxLag = Math.floor(ENV_MAX_LAG_MS / ENV_HOP_MS);
  if (n < maxLag + minLag) return NaN;
  let mean = 0;
  for (let i = start; i < end; i++) mean += env[i] as number;
  mean /= n;
  const scores: Array<{ lag: number; r: number }> = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = start + lag; i < end; i++) {
      const a = (env[i] as number) - mean;
      const b = (env[i - lag] as number) - mean;
      num += a * b;
      da += a * a;
      db += b * b;
    }
    const r = da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
    scores.push({ lag, r });
  }
  let best = 0;
  for (const s of scores) if (s.r > best) best = s.r;
  if (best <= 0.05) return NaN;
  for (const s of scores) {
    if (s.r >= best * ENV_LAG_TOLERANCE) return s.lag * ENV_HOP_MS;
  }
  return NaN;
}

/**
 * The local gap pattern around an opening: what came just before it, what came
 * just after, and how long a run of same-length gaps it sits in.
 *
 * Deliberately free of any rate estimate. The estimator is the binding
 * constraint on everything else measured in this file, so a discriminator that
 * does not need one is worth knowing about even if it is weaker.
 */
function gapShape(
  openings: readonly number[],
  at: number
): { gapBeforeMs: number; gapAfterMs: number; runLength: number } {
  const i = openings.findIndex((t) => Math.abs(t - at) < 1);
  if (i < 1) return { gapBeforeMs: NaN, gapAfterMs: NaN, runLength: 0 };
  const gapBeforeMs = (openings[i] as number) - (openings[i - 1] as number);
  const gapAfterMs =
    i + 1 < openings.length ? (openings[i + 1] as number) - (openings[i] as number) : NaN;
  // Consecutive gaps within 40% of this one, walked both ways.
  const like = (g: number): boolean => Math.abs(g - gapBeforeMs) <= 0.4 * gapBeforeMs;
  let runLength = 1;
  for (let j = i - 1; j >= 1; j--) {
    if (!like((openings[j] as number) - (openings[j - 1] as number))) break;
    runLength++;
  }
  for (let j = i + 1; j < openings.length; j++) {
    if (!like((openings[j] as number) - (openings[j - 1] as number))) break;
    runLength++;
  }
  return { gapBeforeMs, gapAfterMs, runLength };
}

function collect(): Take[] {
  const takes: Take[] = [];
  for (const fixture of decodeFixtures({ quiet: true })) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const env = rmsEnvelope(mono, wav.sampleRate);
    const events: TrackerTraceEvent[] = [];
    const analysis = analyzeSamples(mono, wav.sampleRate, {
      trackerTrace: (e) => events.push(e),
    });
    const detections = projectEmissions(analysis.emissions).final;
    const labels = fixture.label.events as LabeledEvent[];
    const paired = new Set(matchEvents(labels, detections).matches.map((m) => m.detection.id));

    const opened = new Map<string, Extract<TrackerTraceEvent, { kind: "opened" }>>();
    const ended = new Map<string, Extract<TrackerTraceEvent, { kind: "ended" }>>();
    for (const e of events) {
      if (e.kind === "opened") opened.set(e.noteId, e);
      else if (e.kind === "ended") ended.set(e.noteId, e);
    }
    const openings = events
      .filter((e): e is Extract<TrackerTraceEvent, { kind: "opened" }> => e.kind === "opened")
      .map((e) => e.at)
      .sort((a, b) => a - b);

    const out: Candidate[] = [];
    for (let i = 0; i < events.length; i++) {
      const split = events[i] as TrackerTraceEvent;
      if (split.kind !== "rearticulation") continue;
      if (!split.accepted || !split.settled || split.pitchDiffers) continue;
      let child: Extract<TrackerTraceEvent, { kind: "opened" }> | null = null;
      for (let j = i + 1; j < events.length && j < i + 8; j++) {
        const next = events[j] as TrackerTraceEvent;
        if (next.kind !== "opened") continue;
        if (Math.abs(next.at - split.at) > 30) continue;
        child = next;
        break;
      }
      if (child === null) continue;
      const death = ended.get(child.noteId);
      if (death === undefined) continue;

      // Reported, NOT filtered on: this is the narrow script's whole candidate
      // rule and the thing being widened.
      let steppedAway = false;
      for (const e of events) {
        if (e.kind !== "opened") continue;
        if (Math.abs(e.at - death.at) > 5) continue;
        if (e.noteId === child.noteId) continue;
        if (e.trigger === "pitchChange") steppedAway = true;
      }

      const previousOpen = opened.get(split.noteId);
      const previousEnd = ended.get(split.noteId);
      const nextOnset = openings.find((t) => t > child.at + 1);
      out.push({
        pairSpanMs:
          previousOpen === undefined || nextOnset === undefined
            ? NaN
            : nextOnset - previousOpen.at,
        stem: fixture.stem,
        id: child.noteId,
        previousId: split.noteId,
        startedAt: child.at,
        fragmentMs: death.soundedMs,
        boundaryAgeMs: split.soundedMs,
        previousSpanMs:
          previousOpen === undefined || previousEnd === undefined
            ? NaN
            : previousEnd.at - previousOpen.at,
        oracleIoiMs: oracleIoi(labels, child.at),
        causal: Object.fromEntries(
          PERCENTILES.map((p) => [p.toFixed(2), causalIoi(openings, child.at, p)])
        ),
        causalIoiMs: causalIoi(openings, child.at, 0.5),
        envIoiMs: envelopeIoi(env, child.at),
        dipRatio: split.dipRatio,
        ...gapShape(openings, child.at),
        steppedAway,
        paired: paired.has(child.noteId),
      });
    }
    takes.push({
      stem: fixture.stem,
      derivation: DERIVATION.includes(fixture.stem),
      labels,
      detections: [...detections],
      candidates: out,
      openings,
    });
  }
  return takes;
}

type Outcome = { missed: number; falsePositives: number; removed: number; removedEmitted: number };

/**
 * The rule's end-to-end cost, simulated on the detection list.
 *
 * Merges chain: a fragment whose predecessor is itself merged away has to land
 * on the ultimate survivor, or the simulation invents a Note the rule would
 * never have left standing.
 */
function endToEnd(
  takes: readonly Take[],
  gate: (c: Candidate) => boolean,
  only?: (t: Take) => boolean,
  /**
   * False models the SIMPLER implementation: the fragment is never announced,
   * so it vanishes, but its predecessor's end is NOT stretched over it. That
   * matters because dropping a Note the tracker never announced is machinery
   * that already exists (`end()` discards a Note under its announce bar), while
   * stretching a neighbour after the fact needs a new retraction path.
   */
  extendSurvivor = true
): Outcome {
  let missed = 0;
  let falsePositives = 0;
  let removed = 0;
  let removedEmitted = 0;
  for (const take of takes) {
    if (only !== undefined && !only(take)) continue;
    const drop = new Set<string>();
    const parent = new Map<string, string>();
    for (const c of take.candidates) {
      if (!gate(c)) continue;
      drop.add(c.id);
      parent.set(c.id, c.previousId);
      removed++;
      if (take.detections.some((d) => d.id === c.id)) removedEmitted++;
    }
    const survivor = (id: string): string => {
      let at = id;
      const seen = new Set<string>();
      while (parent.has(at) && !seen.has(at)) {
        seen.add(at);
        at = parent.get(at) as string;
      }
      return at;
    };
    const extend = new Map<string, number>();
    for (const c of take.candidates) {
      if (!drop.has(c.id)) continue;
      const fragment = take.detections.find((d) => d.id === c.id);
      const end = fragment?.endedAt ?? null;
      if (end === null) continue;
      const into = survivor(c.previousId);
      extend.set(into, Math.max(extend.get(into) ?? 0, end));
    }
    const after = take.detections
      .filter((d) => !drop.has(d.id))
      .map((d) => {
        const extended = extendSurvivor ? extend.get(d.id) : undefined;
        return extended === undefined ? d : { ...d, endedAt: Math.max(d.endedAt ?? 0, extended) };
      });
    const result = matchEvents(take.labels, after);
    missed += result.missed.length;
    falsePositives += result.falsePositives.length;
  }
  return { missed, falsePositives, removed, removedEmitted };
}

/**
 * The rate estimate, re-taken after a first merge pass has removed the onsets
 * it judged phantom.
 *
 * The measured obstacle to every causal version of this gate is that a phantom
 * boundary inserts an onset, which inserts a short gap, which drags the rate
 * estimate toward the phantom's own spacing — so the estimate is corrupted by
 * exactly the errors it exists to correct, and the pair-span test falls from
 * 0.867 AUC against the true rate to 0.749 against an estimated one.
 *
 * A first pass at a deliberately STRICT bar removes only the fragments it is
 * most sure of, which de-contaminates the gap distribution; the rate is then
 * re-read from what survives and the real bar applied to that. The deep lane
 * revisits buffered audio by design, so a two-pass decision is available to it
 * in a way it is not to the fast lane.
 */
function refinedIoi(take: Take, dropped: ReadonlySet<string>, at: number, percentile: number): number {
  const removedAt = new Set(
    take.candidates.filter((c) => dropped.has(c.id)).map((c) => c.startedAt)
  );
  const surviving = take.openings.filter((t) => !removedAt.has(t));
  return causalIoi(surviving, at, percentile);
}

function span(values: number[]): string {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return "none";
  const q = (p: number): string => (v[Math.round((v.length - 1) * p)] as number).toFixed(2);
  return `n=${String(v.length).padStart(4)}  min ${q(0)}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}  max ${q(1)}`;
}

/** Area under the ROC, positives = should be REMOVED (unpaired). Lower score = remove. */
function auc(spurious: readonly number[], matched: readonly number[]): number {
  const a = spurious.filter(Number.isFinite);
  const b = matched.filter(Number.isFinite);
  if (a.length === 0 || b.length === 0) return NaN;
  let wins = 0;
  for (const x of a) for (const y of b) wins += x < y ? 1 : x === y ? 0.5 : 0;
  return wins / (a.length * b.length);
}

function main(): void {
  const detail = process.argv.includes("--detail");
  const takes = collect();
  const candidates = takes.flatMap((t) => t.candidates);
  const spurious = candidates.filter((c) => !c.paired);
  const matched = candidates.filter((c) => c.paired);

  console.log(
    `\n  WIDENED candidate set: every Note opened by an accepted, settled, same-pitch re-articulation\n`
  );
  console.log(
    `  candidates ${candidates.length}   spurious (should be removed) ${spurious.length}` +
      `   matched to a label (must be KEPT) ${matched.length}`
  );
  const narrow = candidates.filter((c) => c.steppedAway);
  console.log(
    `  of which the narrow script's "ended on a pitch step" subset: ${narrow.length}` +
      ` (${narrow.filter((c) => !c.paired).length} spurious) — the rest is what it could not see\n`
  );

  console.log("  DISCRIMINATORS (AUC: 1.0 = the spurious always score lower)\n");
  const rows: Array<[string, (c: Candidate) => number]> = [
    ["fragment span / oracle IOI", (c) => c.fragmentMs / c.oracleIoiMs],
    ["fragment span alone (control)", (c) => c.fragmentMs],
    ["boundary age / oracle IOI", (c) => c.boundaryAgeMs / c.oracleIoiMs],
    ["boundary age alone (control)", (c) => c.boundaryAgeMs],
    ["fragment / predecessor span", (c) => c.fragmentMs / c.previousSpanMs],
    ["PAIR span / oracle IOI", (c) => c.pairSpanMs / c.oracleIoiMs],
    ["PAIR span alone (control)", (c) => c.pairSpanMs],
  ];
  for (const [name, key] of rows) {
    console.log(
      `    ${name.padEnd(34)} AUC ${auc(spurious.map(key), matched.map(key)).toFixed(3)}`
    );
  }
  console.log("\n  the same, with the CAUSAL estimator at each percentile of the recent-gap ring");
  for (const p of PERCENTILES) {
    const k = p.toFixed(2);
    const key = (c: Candidate): number => c.fragmentMs / (c.causal[k] as number);
    const ratio = candidates
      .filter((c) => Number.isFinite(c.oracleIoiMs))
      .map((c) => (c.causal[k] as number) / c.oracleIoiMs);
    const fast = ratio.filter((r) => r < 1).length;
    console.log(
      `    gaps p${(p * 100).toFixed(0).padStart(3)}                          AUC ${auc(spurious.map(key), matched.map(key)).toFixed(3)}` +
        `   causal/oracle median ${median(ratio).toFixed(2)}  reads FAST on ${fast}/${ratio.length}`
    );
  }
  console.log("\n  PAIR span / causal IOI at each percentile — is this pair ONE played note or TWO?");
  for (const p of PERCENTILES) {
    const k = p.toFixed(2);
    const key = (c: Candidate): number => c.pairSpanMs / (c.causal[k] as number);
    console.log(
      `    gaps p${(p * 100).toFixed(0).padStart(3)}                          AUC ${auc(spurious.map(key), matched.map(key)).toFixed(3)}`
    );
  }
  console.log("\n  THE AUDIO-SIDE RATE: envelope autocorrelation, causal, no detector output in it");
  const env = candidates.filter((c) => Number.isFinite(c.envIoiMs) && Number.isFinite(c.oracleIoiMs));
  console.log(`    available on ${env.length} of ${candidates.length} candidates`);
  console.log(`    envelope / oracle  ${span(env.map((c) => c.envIoiMs / c.oracleIoiMs))}`);
  console.log(
    `    reads FAST (safe) on ${env.filter((c) => c.envIoiMs < c.oracleIoiMs).length}` +
      `, SLOW (dangerous) on ${env.filter((c) => c.envIoiMs > c.oracleIoiMs).length}`
  );
  console.log(
    `    fragment / envelope IOI            AUC ${auc(
      spurious.map((c) => c.fragmentMs / c.envIoiMs),
      matched.map((c) => c.fragmentMs / c.envIoiMs)
    ).toFixed(3)}`
  );
  console.log(
    `    PAIR span / envelope IOI          AUC ${auc(
      spurious.map((c) => c.pairSpanMs / c.envIoiMs),
      matched.map((c) => c.pairSpanMs / c.envIoiMs)
    ).toFixed(3)}`
  );
  console.log("\n  PAIR span / envelope IOI, distribution");
  console.log(`    spurious  ${span(spurious.map((c) => c.pairSpanMs / c.envIoiMs))}`);
  console.log(`    matched   ${span(matched.map((c) => c.pairSpanMs / c.envIoiMs))}`);

  console.log("\n  PAIR span / oracle IOI, distribution (1.0 = one note split in two, 2.0 = two notes)");
  console.log(`    spurious  ${span(spurious.map((c) => c.pairSpanMs / c.oracleIoiMs))}`);
  console.log(`    matched   ${span(matched.map((c) => c.pairSpanMs / c.oracleIoiMs))}`);
  console.log("\n  PAIR span / causal(p75), distribution");
  console.log(`    spurious  ${span(spurious.map((c) => c.pairSpanMs / (c.causal["0.75"] as number)))}`);
  console.log(`    matched   ${span(matched.map((c) => c.pairSpanMs / (c.causal["0.75"] as number)))}`);

  const base = endToEnd(takes, () => false);
  const baseD = endToEnd(takes, () => false, (t) => t.derivation);
  const baseH = endToEnd(takes, () => false, (t) => !t.derivation);
  console.log(
    `\n  END TO END, matcher re-run over the merged detections. The bar is chosen on DERIV;` +
      `\n  HELD-OUT is reported afterwards and never consulted while choosing.` +
      `\n    rule off: DERIV missed ${baseD.missed} fp ${baseD.falsePositives}` +
      `  |  HELD-OUT missed ${baseH.missed} fp ${baseH.falsePositives}\n`
  );
  const report = (name: string, gate: (c: Candidate) => boolean): void => {
    const d = endToEnd(takes, gate, (t) => t.derivation);
    const h = endToEnd(takes, gate, (t) => !t.derivation);
    const dm = d.missed - baseD.missed;
    const hm = h.missed - baseH.missed;
    console.log(
      `    ${name.padEnd(44)}` +
        ` DERIV missed ${dm >= 0 ? "+" : ""}${String(dm).padEnd(3)} fp ${String(d.falsePositives - baseD.falsePositives).padEnd(5)} emitted-removed ${String(d.removedEmitted).padStart(3)}` +
        `  |  HELD-OUT missed ${hm >= 0 ? "+" : ""}${String(hm).padEnd(3)} fp ${String(h.falsePositives - baseH.falsePositives).padEnd(5)} emitted-removed ${String(h.removedEmitted).padStart(3)}`
    );
  };
  for (const p of [0.5, 0.75, 0.9]) {
    const k = p.toFixed(2);
    for (const bar of [1.2, 1.35, 1.5, 1.65]) {
      report(
        `PAIR span/causal(p${(p * 100).toFixed(0)}) <= ${bar.toFixed(2)}`,
        (c) => c.pairSpanMs / (c.causal[k] as number) <= bar
      );
    }
    console.log("");
  }
  for (const bar of [1.2, 1.35, 1.5, 1.65]) {
    report(
      `PAIR span/ENVELOPE <= ${bar.toFixed(2)}`,
      (c) => Number.isFinite(c.envIoiMs) && c.pairSpanMs / c.envIoiMs <= bar
    );
  }
  console.log("");
  for (const bar of [0.2, 0.25, 0.3, 0.35, 0.4, 0.5]) {
    report(
      `fragment/ENVELOPE <= ${bar.toFixed(2)}`,
      (c) => Number.isFinite(c.envIoiMs) && c.fragmentMs / c.envIoiMs <= bar
    );
  }
  console.log("");
  for (const bar of [1.2, 1.35, 1.5, 1.65]) {
    report(`PAIR span/ORACLE <= ${bar.toFixed(2)} (not buildable)`, (c) => c.pairSpanMs / c.oracleIoiMs <= bar);
  }
  console.log("");

  // Two-pass: a strict first bar de-contaminates the gap distribution, the rate
  // is re-read from the survivors, and the real bar is applied to that.
  console.log("  TWO-PASS: strict pass removes the certain fragments, rate re-read from survivors\n");
  const twoPass = (seedBar: number, bar: number, percentile: number): void => {
    let missed = 0;
    let falsePositives = 0;
    let removed = 0;
    let removedEmitted = 0;
    let derivMissed = 0;
    let baseDerivMissed = 0;
    for (const take of takes) {
      const seed = new Set(
        take.candidates
          .filter((c) => c.fragmentMs / (c.causal["0.50"] as number) <= seedBar)
          .map((c) => c.id)
      );
      const drop = new Set<string>();
      const parent = new Map<string, string>();
      for (const c of take.candidates) {
        const ioi = refinedIoi(take, seed, c.startedAt, percentile);
        if (!(c.fragmentMs / ioi <= bar)) continue;
        drop.add(c.id);
        parent.set(c.id, c.previousId);
        removed++;
        if (take.detections.some((d) => d.id === c.id)) removedEmitted++;
      }
      const survivor = (id: string): string => {
        let x = id;
        const seen = new Set<string>();
        while (parent.has(x) && !seen.has(x)) {
          seen.add(x);
          x = parent.get(x) as string;
        }
        return x;
      };
      const extend = new Map<string, number>();
      for (const c of take.candidates) {
        if (!drop.has(c.id)) continue;
        const end = take.detections.find((d) => d.id === c.id)?.endedAt ?? null;
        if (end === null) continue;
        const into = survivor(c.previousId);
        extend.set(into, Math.max(extend.get(into) ?? 0, end));
      }
      const after = take.detections
        .filter((d) => !drop.has(d.id))
        .map((d) => {
          const e = extend.get(d.id);
          return e === undefined ? d : { ...d, endedAt: Math.max(d.endedAt ?? 0, e) };
        });
      const r = matchEvents(take.labels, after);
      missed += r.missed.length;
      falsePositives += r.falsePositives.length;
      if (take.derivation) {
        derivMissed += r.missed.length;
        baseDerivMissed += matchEvents(take.labels, take.detections).missed.length;
      }
    }
    console.log(
      `    seed ${seedBar.toFixed(2)} -> p${(percentile * 100).toFixed(0)} bar ${bar.toFixed(2)}`.padEnd(42) +
        ` missed ${String(missed).padStart(3)} (${missed - base.missed >= 0 ? "+" : ""}${missed - base.missed})` +
        `  fp ${String(falsePositives).padStart(3)} (${falsePositives - base.falsePositives})` +
        `  merged ${String(removed).padStart(3)} of which emitted ${String(removedEmitted).padStart(3)}` +
        `  [deriv ${derivMissed - baseDerivMissed >= 0 ? "+" : ""}${derivMissed - baseDerivMissed} missed]`
    );
  };
  for (const seed of [0.15, 0.2]) {
    for (const p of [0.5, 0.75]) {
      for (const bar of [0.2, 0.25, 0.3, 0.35]) twoPass(seed, bar, p);
    }
  }
  console.log("");
  for (const bar of [0.2, 0.3, 0.35]) {
    report(
      `fragment/causal(p50) <= ${bar.toFixed(2)}`,
      (c) => c.fragmentMs / (c.causal["0.50"] as number) <= bar
    );
  }
  console.log("");

  console.log("  THE TWO WITNESSES TOGETHER: short for the rate AND no dip before the boundary\n");
  console.log(`    dipRatio at the boundary, spurious  ${span(spurious.map((c) => c.dipRatio))}`);
  console.log(`    dipRatio at the boundary, matched   ${span(matched.map((c) => c.dipRatio))}`);
  console.log(
    `    dipRatio alone                     AUC ${auc(
      matched.map((c) => c.dipRatio),
      spurious.map((c) => c.dipRatio)
    ).toFixed(3)}   (spurious score HIGH here, so the arguments are swapped)\n`
  );
  // THE CEILING. With a PERFECT rate the gate is bounded by this; anything a
  // better estimator could buy lies between the causal rows and these.
  console.log("\n  GAP SHAPE — the owner's idea, and it uses NO rate estimate\n");
  const shapeRows: Array<[string, (c: Candidate) => number]> = [
    ["gapAfter / gapBefore (low = fake)", (c) => c.gapAfterMs / c.gapBeforeMs],
    ["gapBefore alone (control)", (c) => c.gapBeforeMs],
    ["run length of same-size gaps", (c) => c.runLength],
    ["run length (short = fake)", (c) => c.runLength],
  ];
  for (const [name, key] of shapeRows) {
    console.log(`    ${name.padEnd(34)} AUC ${auc(spurious.map(key), matched.map(key)).toFixed(3)}`);
  }
  console.log("\n    gapAfter/gapBefore  spurious  " + span(spurious.map((c) => c.gapAfterMs / c.gapBeforeMs)));
  console.log("    gapAfter/gapBefore  matched   " + span(matched.map((c) => c.gapAfterMs / c.gapBeforeMs)));
  console.log("    run length          spurious  " + span(spurious.map((c) => c.runLength)));
  console.log("    run length          matched   " + span(matched.map((c) => c.runLength)));
  console.log("");
  for (const r of [2, 3, 4]) {
    report(`run length < ${r} (a lone fast note is fake)`, (c) => c.runLength < r);
  }
  console.log("");
  // The phantom is the TAIL of a played note, not its head: it sits LATE in the
  // note it was cut out of, so the gap AFTER it is short and the gap BEFORE it
  // is nearly a whole interval. Spurious median 0.36 against 1.00 for real
  // notes. The test is therefore "followed too soon", not "preceded too soon".
  for (const bar of [0.3, 0.4, 0.5, 0.6]) {
    report(`gapAfter/gapBefore <= ${bar}`, (c) => c.gapAfterMs / c.gapBeforeMs <= bar);
  }
  console.log("");
  for (const bar of [0.3, 0.4, 0.5, 0.6]) {
    report(`gapAfter/gapBefore <= ${bar} AND dip >= 0.85`, (c) => c.gapAfterMs / c.gapBeforeMs <= bar && c.dipRatio >= 0.85);
  }
  console.log("");
  for (const bar of [0.4, 0.5, 0.6]) {
    report(
      `SHIPPED OR gapAfter/gapBefore <= ${bar} AND dip >= 0.85`,
      (c) =>
        (c.fragmentMs / (c.causal["0.50"] as number) <= 0.35 && c.dipRatio >= 0.85) ||
        (c.gapAfterMs / c.gapBeforeMs <= bar && c.dipRatio >= 0.85)
    );
  }
  console.log("");
  // And with NO rate estimate anywhere in it, which is the interesting version.
  for (const bar of [0.4, 0.5]) {
    for (const dip of [0.7, 0.85]) {
      report(
        `RATE-FREE gapAfter/gapBefore <= ${bar} AND dip >= ${dip}`,
        (c) => c.gapAfterMs / c.gapBeforeMs <= bar && c.dipRatio >= dip
      );
    }
  }
  console.log("");

  // Does a DIFFERENT way of reading the recent gaps beat the median? The median
  // is what ships. p75 and p90 score higher as rankings (0.837 and 0.851
  // against 0.826), so the question is whether that survives the zero-cost
  // constraint once the span bar is re-chosen for the larger denominator.
  console.log("  A DIFFERENT READING OF THE RECENT GAPS, each with the dip condition\n");
  for (const p of ["0.50", "0.75", "0.90"]) {
    for (const bar of [0.15, 0.2, 0.25, 0.3, 0.35]) {
      report(
        `p${(Number(p) * 100).toFixed(0)} gaps, span <= ${bar.toFixed(2)}, dip >= 0.85`,
        (c) => c.fragmentMs / (c.causal[p] as number) <= bar && c.dipRatio >= 0.85
      );
    }
    console.log("");
  }

  console.log("  CEILING: the same gate with an ORACLE rate, which no causal estimator can have\n");
  for (const dip of [0.7, 0.85]) {
    for (const bar of [0.35, 0.5, 0.7, 0.9]) {
      report(
        `ORACLE fragment/IOI <= ${bar.toFixed(2)} AND dip >= ${dip.toFixed(2)}`,
        (c) => c.fragmentMs / c.oracleIoiMs <= bar && c.dipRatio >= dip
      );
    }
    console.log("");
  }
  // And with no dip condition at all, to show what the dip is costing in reach.
  for (const bar of [0.5, 0.7, 0.9]) {
    report(`ORACLE fragment/IOI <= ${bar.toFixed(2)}, no dip condition`, (c) => c.fragmentMs / c.oracleIoiMs <= bar);
  }
  console.log("");

  console.log("  THE SIMPLER IMPLEMENTATION: fragment never announced, predecessor NOT stretched\n");
  const reportNoExtend = (name: string, gate: (c: Candidate) => boolean): void => {
    const d = endToEnd(takes, gate, (t) => t.derivation, false);
    const h = endToEnd(takes, gate, (t) => !t.derivation, false);
    console.log(
      `    ${name.padEnd(44)}` +
        ` DERIV missed ${d.missed - baseD.missed >= 0 ? "+" : ""}${String(d.missed - baseD.missed).padEnd(3)} fp ${String(d.falsePositives - baseD.falsePositives).padEnd(5)} emitted-removed ${String(d.removedEmitted).padStart(3)}` +
        `  |  HELD-OUT missed ${h.missed - baseH.missed >= 0 ? "+" : ""}${String(h.missed - baseH.missed).padEnd(3)} fp ${String(h.falsePositives - baseH.falsePositives).padEnd(5)} emitted-removed ${String(h.removedEmitted).padStart(3)}`
    );
  };
  for (const bar of [0.3, 0.35, 0.4]) {
    reportNoExtend(
      `NO-EXTEND fragment/causal(p50) <= ${bar.toFixed(2)} AND dip >= 0.85`,
      (c) => c.fragmentMs / (c.causal["0.50"] as number) <= bar && c.dipRatio >= 0.85
    );
  }
  console.log("");

  for (const dip of [0.5, 0.7, 0.85]) {
    for (const bar of [0.25, 0.3, 0.35, 0.4, 0.5]) {
      report(
        `fragment/causal(p50) <= ${bar.toFixed(2)} AND dip >= ${dip.toFixed(2)}`,
        (c) => c.fragmentMs / (c.causal["0.50"] as number) <= bar && c.dipRatio >= dip
      );
    }
    console.log("");
  }
  for (const bar of [0.3, 0.35, 0.4, 0.5]) {
    report(`fragment/ORACLE IOI <= ${bar.toFixed(2)} (not buildable)`, (c) => c.fragmentMs / c.oracleIoiMs <= bar);
  }
  console.log("");
  for (const bar of [60, 80, 100]) {
    report(`fragment span <= ${bar}ms (control, no rate)`, (c) => c.fragmentMs <= bar);
  }

  if (detail) {
    // The decisive question for any gate here, and the one that rejected the
    // dip gate in DECISION-028: WHICH labels does it cost, and are they on
    // hand-annotated audio or on the provisional generated set?
    const BAR = 0.2;
    console.log(`\n  LABELS LOST at fragment/causal(p50) <= ${BAR}\n`);
    for (const take of takes) {
      const before = new Set(matchEvents(take.labels, take.detections).missed.map((m) => m.label.id));
      const drop = new Set<string>();
      const parent = new Map<string, string>();
      for (const c of take.candidates) {
        if (!(c.fragmentMs / (c.causal["0.50"] as number) <= BAR)) continue;
        drop.add(c.id);
        parent.set(c.id, c.previousId);
      }
      const survivor = (id: string): string => {
        let x = id;
        const seen = new Set<string>();
        while (parent.has(x) && !seen.has(x)) { seen.add(x); x = parent.get(x) as string; }
        return x;
      };
      const extend = new Map<string, number>();
      for (const c of take.candidates) {
        if (!drop.has(c.id)) continue;
        const end = take.detections.find((d) => d.id === c.id)?.endedAt ?? null;
        if (end === null) continue;
        const into = survivor(c.previousId);
        extend.set(into, Math.max(extend.get(into) ?? 0, end));
      }
      const after = take.detections
        .filter((d) => !drop.has(d.id))
        .map((d) => {
          const e = extend.get(d.id);
          return e === undefined ? d : { ...d, endedAt: Math.max(d.endedAt ?? 0, e) };
        });
      const now = matchEvents(take.labels, after).missed.map((m) => m.label);
      const newly = now.filter((l) => !before.has(l.id));
      const recovered = [...before].filter((id) => !now.some((l) => l.id === id));
      if (newly.length === 0 && recovered.length === 0) continue;
      console.log(`    ${take.stem}`);
      for (const l of newly) console.log(`      LOST      ${l.id} ${l.label} @${l.startMs}`);
      for (const id of recovered) console.log(`      RECOVERED ${id}`);
    }

    console.log("\n  per fixture, at fragment/causal IOI <= 0.35\n");
    for (const take of takes) {
      const r = endToEnd([take], (c) => c.fragmentMs / c.causalIoiMs <= 0.35);
      const b = endToEnd([take], () => false);
      if (take.candidates.length === 0) continue;
      console.log(
        `    ${take.stem.padEnd(48)} candidates ${String(take.candidates.length).padStart(3)}` +
          `  missed ${b.missed} -> ${r.missed}   fp ${b.falsePositives} -> ${r.falsePositives}` +
          `   emitted removed ${r.removedEmitted}`
      );
    }
    console.log("\n  every candidate the rule would KEEP but a tighter bar would lose\n");
    for (const c of matched.sort((a, b) => a.fragmentMs / a.causalIoiMs - b.fragmentMs / b.causalIoiMs).slice(0, 25)) {
      console.log(
        `    KEEP ${c.stem.replace("same-pitch-", "").padEnd(40)} ${c.id.padEnd(5)} @${c.startedAt.toFixed(0).padStart(6)}` +
          `  fragment ${c.fragmentMs.toFixed(0).padStart(4)}  causal IOI ${c.causalIoiMs.toFixed(0).padStart(4)}` +
          `  ratio ${(c.fragmentMs / c.causalIoiMs).toFixed(2)}`
      );
    }
  }
  console.log("");
}

main();
