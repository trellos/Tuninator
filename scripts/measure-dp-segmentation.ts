/**
 * Choosing a region's cuts JOINTLY, instead of one boundary at a time.
 *
 * Four directions closed before this one failed the same way: the accept/reject
 * decision at a single candidate boundary is not locally separable. The best
 * single witness reads 0.73 AUC, a fitted twelve-witness model reads 0.808
 * in-sample and 0.434 leave-one-take-out, and at the operating point that loses
 * no labels it still admits 94 of 102 false candidates. The evidence, meanwhile,
 * is nearly complete: the onset kernel covers 372 of 381 held-out labels within
 * 60ms. So the problem is SELECTION, and selection is currently done boundary by
 * boundary in `deep/resegment.ts`.
 *
 * This script asks whether the same evidence separates when a whole region is
 * segmented at once. For every region the deep lane actually analyses, it finds
 * the provably optimal partition of
 *
 *     sum over segments of (how badly this span is explained as ONE note)
 *       + price * (number of cuts)
 *
 * by optimal partitioning: `best[x] = min over y of best[y] + cost(y,x) + price`
 * with back-pointers, O(N^2), no greedy shortcut — because the whole claim under
 * test is that a locally plausible cut can lose to a globally better answer, and
 * a greedy sweep is by construction unable to discover that.
 *
 * The mechanism it is meant to exploit, on the dominant defect: a 190ms played
 * event that comes out as a ~130ms Note plus a ~70ms SAME-PITCH tail. Both
 * halves are the same pitch and the tail is the head's own decay continuing, so
 * the cut buys almost no reduction in misfit and cannot pay its price. A genuine
 * re-pick cannot be explained by any single monotonic decay, so cutting at its
 * envelope trough reduces misfit a lot and pays easily. One rule, opposite
 * answers, no threshold on flux.
 *
 * THREE STREAMS, EACH AT THE RESOLUTION WHERE IT IS STRONG. A longer transform
 * buys frequency resolution and costs time resolution, and these terms do not
 * want the same trade:
 *
 *   envelope   fine RMS over the region's raw audio, 21ms window / 5.3ms hop.
 *              The decay-residual term has to see a trough and a rise inside
 *              70ms, so it gets the finest stream there is.
 *   pitch      the fast lane's own per-hop estimates. Dual-window YIN, and
 *              84-91% of voiced hops on the lead takes use the SHORT 512-sample
 *              window — 10.7ms, shorter than the hop — with octave arbitration
 *              already done. Re-deriving pitch from an 85ms deep window would be
 *              strictly worse on exactly the material this is about.
 *   chroma     the 85ms deep readings. Chord-scale judgement about events that
 *              last seconds, where smearing costs nothing.
 *
 * `deep.minSegmentMs: 90` is deliberately NOT inherited. The fragments the
 * greedy rule emits and this is asked to reject are 67-70ms long; a partition
 * that cannot express them cannot be asked whether they are worth their price.
 *
 * WHAT THE NUMBERS MEAN. Every variant is scored by one rule: a segment start is
 * a detection, a label is found when some detection lands within `MATCH_MS` of
 * its annotated onset, and every detection matching no label is an extra.
 * `--controls` puts the recognizer's own emitted Notes and the current greedy
 * `segmentRegion()` through that identical scorer over those identical regions,
 * so the DP is never compared against a number produced a different way.
 *
 * Every price-sweep row is a CEILING: the price is chosen fit-on-test against
 * the whole corpus, which no deployed system may do. The derivation/held-out
 * split at the end is the honest number, and the gap is the part of any gain
 * that is not real.
 *
 * WHAT WOULD FALSIFY THE DIRECTION, stated before the run: if no point on the
 * fit-on-test price curve is strictly inside 32 missed and 107 extras on both
 * axes, joint segmentation buys nothing the greedy rule does not already have.
 *
 * IT WAS FALSIFIED. No price comes near: the best point holding extras under the
 * baseline misses 234 labels of 454. The search is not what failed — the
 * partition is provably optimal and the whole corpus costs 7.9s over 22 prices.
 * The COST failed, and the mechanism table says where: the cut gain of
 * the decay-residual term separates on-label from off-label candidates at 0.469
 * AUC, chance, over 815 candidates and from a 5.3ms envelope. The pitch and
 * chroma terms reach 0.689 and 0.713 — the same band as the best single LOCAL
 * witness, which is exactly the information a joint decision was supposed to
 * escape. See `docs/DETECTION-FINDINGS.md`.
 *
 * No engine behaviour is changed. The script observes `DeepLane`'s region
 * analysis through a prototype wrapper it installs on itself and removes again,
 * so the recognizer under measurement is the one the library ships.
 *
 * Usage:
 *   npx tsx scripts/measure-dp-segmentation.ts              sweep + held-out
 *   npx tsx scripts/measure-dp-segmentation.ts --controls   also the baselines
 *   npx tsx scripts/measure-dp-segmentation.ts --weights    cost-term sensitivity
 *   npx tsx scripts/measure-dp-segmentation.ts --detail     per fixture
 */

import { readFileSync } from "node:fs";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { resolveEngineConfig } from "../src/engine/config.js";
import { SampleClock } from "../src/engine/clock.js";
import { SpectralAnalyzer } from "../src/engine/deep/spectral.js";
import { MultiPitchAnalyzer } from "../src/engine/deep/multi-pitch.js";
import { HarmonicInterpreter } from "../src/engine/deep/harmonic.js";
import { DeepLane } from "../src/engine/deep/deep-lane.js";
import { segmentRegion } from "../src/engine/deep/resegment.js";
import type { RegionSegment, RegionWindowReading } from "../src/engine/contracts.js";
import { chainOf, type Chain } from "./measure-rig-profile.js";
import { decodeFixtures } from "./decode-fixtures.js";

/**
 * How near a label a segment start has to be to have found it.
 *
 * Two thirds of a 107ms sixteenth at 140bpm — the window
 * `measure-downstream-ledger.ts` attributes a decision to a stroke with, and
 * wider than the 60ms the onset-coverage ceiling is quoted at. Wider still would
 * start crediting a segment to the stroke after the one it describes.
 */
const MATCH_MS = 70;

/**
 * Shortest span the DP may call an event.
 *
 * Below `deep.minSegmentMs: 90` on purpose: the fragments this has to judge are
 * 67-70ms. 45ms is under half a sixteenth at 140bpm, so nothing anybody played
 * in this corpus is excluded either.
 */
const MIN_SEGMENT_MS = 45;

/** Fine envelope: 21ms window, 5.3ms hop — four times the fast lane's rate. */
const ENV_WINDOW = 1024;
const ENV_HOP = 256;

/**
 * Residual, in natural-log units of level, at which a span counts as fully
 * unexplained by one decay.
 *
 * ln(2): off the fitted curve by a factor of two on average is not a decaying
 * string. This is the constant that makes the misfit dimensionless, which is
 * what lets one price be swept against it.
 */
const LOG_TOLERANCE = Math.LN2;

/** Fast-lane hops below this confidence are not evidence about pitch. */
const PITCH_CONFIDENCE = 0.5;

/** Cost-term weights. Sum to one, so a segment's misfit is in [0, 1]. */
type Weights = { envelope: number; pitch: number; chroma: number };
const WEIGHTS: Weights = { envelope: 0.5, pitch: 0.3, chroma: 0.2 };

/** The five takes any constant in this project is allowed to be derived on. */
const DERIVATION = [
  "chords-a-bm-g-d",
  "clean-lead",
  "cowboy-chords-c-d-em-g-c-d-em-am",
  "power-chords-c-a-g-e",
  "spicy-chords",
];

/** Price, in seconds-of-misfit per cut. Geometric, so the curve is readable. */
const PRICES = [
  0.001, 0.002, 0.004, 0.006, 0.009, 0.012, 0.016, 0.02, 0.026, 0.033, 0.042,
  0.053, 0.067, 0.085, 0.107, 0.135, 0.17, 0.215, 0.27, 0.34, 0.43, 0.54,
];

type EnvPoint = { atMs: number; logLevel: number };
type PitchPoint = { atMs: number; pitchClass: number; weight: number };

type RegionData = {
  /** Candidate boundary positions, absolute samples, ascending. N+1 of them. */
  positions: number[];
  /** Deep readings, one per candidate position except the last. */
  windows: RegionWindowReading[];
  /** Fine envelope over this region only. */
  env: EnvPoint[];
  /** Fast-lane pitch, one entry per voiced hop inside this region. */
  pitch: PitchPoint[];
  /** The greedy answer, for the control row. */
  greedy: RegionSegment[];
  fromSample: number;
  toSample: number;
  /** Distinct spans the DP evaluated the cost function on. */
  evaluations: number;
};

type FixtureData = {
  stem: string;
  chain: Chain;
  sampleRate: number;
  labels: Array<{ id: string; startMs: number }>;
  regions: RegionData[];
  /** Onsets of the Notes the shipped recognizer actually emitted. */
  noteStarts: number[];
  /** Regions the deep lane itself refused. */
  refused: number;
  /** Regions with too few candidate positions to have a choice to make. */
  tooSparse: number;
};

type Score = { found: number; missed: number; extras: number; detections: number };

function emptyScore(): Score {
  return { found: 0, missed: 0, extras: 0, detections: 0 };
}

function add(into: Score, from: Score): void {
  into.found += from.found;
  into.missed += from.missed;
  into.extras += from.extras;
  into.detections += from.detections;
}

/** Score detection onsets against labels: nearest within `MATCH_MS`, one each. */
function score(detections: readonly number[], labels: readonly number[]): Score {
  const used = new Array<boolean>(detections.length).fill(false);
  let found = 0;
  for (const label of labels) {
    let best = -1;
    let bestGap = MATCH_MS;
    for (let i = 0; i < detections.length; i++) {
      if (used[i] === true) continue;
      const gap = Math.abs((detections[i] as number) - label);
      if (gap <= bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    if (best >= 0) {
      used[best] = true;
      found++;
    }
  }
  const extras = used.filter((u) => u === false).length;
  return { found, missed: labels.length - found, extras, detections: detections.length };
}

/**
 * How badly one monotonic decay explains this envelope.
 *
 * Measured from the span's PEAK forward, the way `VoiceDecay` measures a Note's
 * decay: the attack is a rise no decay curve fits, and charging every segment
 * for its own attack would turn the term into a duration measure. A slope that
 * comes out positive is clamped flat — "this span got louder throughout" is not
 * a decaying string either, and should not be rewarded with a good fit.
 *
 * Returns 0 when too little of the span follows its peak to fit anything. That
 * is an abstention, not a claim that the span is one clean note.
 */
function decayMisfit(env: readonly EnvPoint[], fromMs: number, toMs: number): number {
  let peak = -Infinity;
  let peakIndex = -1;
  let last = -1;
  for (let i = 0; i < env.length; i++) {
    const point = env[i] as EnvPoint;
    if (point.atMs < fromMs) continue;
    if (point.atMs >= toMs) break;
    last = i;
    if (point.logLevel > peak) {
      peak = point.logLevel;
      peakIndex = i;
    }
  }
  if (peakIndex < 0 || last - peakIndex < 4) return 0;

  let n = 0;
  let sumT = 0;
  let sumL = 0;
  let sumTT = 0;
  let sumTL = 0;
  const t0 = (env[peakIndex] as EnvPoint).atMs;
  for (let i = peakIndex; i <= last; i++) {
    const point = env[i] as EnvPoint;
    const t = point.atMs - t0;
    n++;
    sumT += t;
    sumL += point.logLevel;
    sumTT += t * t;
    sumTL += t * point.logLevel;
  }
  const denominator = n * sumTT - sumT * sumT;
  let slope = denominator === 0 ? 0 : (n * sumTL - sumT * sumL) / denominator;
  if (slope > 0) slope = 0;
  const intercept = (sumL - slope * sumT) / n;

  let sse = 0;
  for (let i = peakIndex; i <= last; i++) {
    const point = env[i] as EnvPoint;
    const residual = point.logLevel - (intercept + slope * (point.atMs - t0));
    sse += residual * residual;
  }
  return Math.min(1, Math.sqrt(sse / n) / LOG_TOLERANCE);
}

/**
 * How much of the span's voiced energy does NOT belong to its leading pitch.
 *
 * By pitch CLASS, for the reason `resegment.ts` compares by class: an
 * octave-sized jump is the best known failure of every pitch estimator, and
 * reading a flip as a second event splits a sustained note in two.
 */
function pitchInstability(pitch: readonly PitchPoint[], fromMs: number, toMs: number): number {
  const weight = new Float64Array(12);
  let total = 0;
  let count = 0;
  for (const point of pitch) {
    if (point.atMs < fromMs) continue;
    if (point.atMs >= toMs) break;
    weight[point.pitchClass] = (weight[point.pitchClass] as number) + point.weight;
    total += point.weight;
    count++;
  }
  if (count < 3 || total <= 0) return 0;
  let leader = 0;
  for (let i = 0; i < 12; i++) leader = Math.max(leader, weight[i] as number);
  return 1 - leader / total;
}

/** How far the span's chroma wanders from its own mean. 0 means one chord. */
function chromaInstability(
  windows: readonly RegionWindowReading[],
  from: number,
  to: number
): number {
  const mean = new Float64Array(12);
  let used = 0;
  for (let i = from; i < to && i < windows.length; i++) {
    const chroma = (windows[i] as RegionWindowReading).evidence.chroma;
    for (let k = 0; k < 12; k++) mean[k] = (mean[k] as number) + (chroma[k] as number);
    used++;
  }
  if (used < 2) return 0;
  let meanNorm = 0;
  for (let k = 0; k < 12; k++) {
    mean[k] = (mean[k] as number) / used;
    meanNorm += (mean[k] as number) * (mean[k] as number);
  }
  meanNorm = Math.sqrt(meanNorm);
  if (meanNorm <= 0) return 0;

  let sum = 0;
  for (let i = from; i < to && i < windows.length; i++) {
    const chroma = (windows[i] as RegionWindowReading).evidence.chroma;
    let dot = 0;
    let norm = 0;
    for (let k = 0; k < 12; k++) {
      dot += (chroma[k] as number) * (mean[k] as number);
      norm += (chroma[k] as number) * (chroma[k] as number);
    }
    norm = Math.sqrt(norm);
    sum += norm <= 0 ? 1 : 1 - dot / (norm * meanNorm);
  }
  return Math.min(1, sum / used);
}

/**
 * The provably optimal partition of one region at one price.
 *
 * Returns the segment START samples, region start included. Every admissible
 * pair of candidate positions is evaluated; the span costs are memoised across
 * the price sweep, because the cost of a span does not depend on the price.
 */
function partition(
  region: RegionData,
  price: number,
  weights: Weights,
  samplesPerMs: number,
  cache: Map<number, number>
): number[] {
  const positions = region.positions;
  const n = positions.length - 1;
  const minSamples = MIN_SEGMENT_MS * samplesPerMs;
  const best = new Float64Array(n + 1).fill(Infinity);
  const back = new Int32Array(n + 1).fill(-1);
  best[0] = 0;

  for (let x = 1; x <= n; x++) {
    for (let y = 0; y < x; y++) {
      if ((best[y] as number) === Infinity) continue;
      const fromSample = positions[y] as number;
      const toSample = positions[x] as number;
      if (toSample - fromSample < minSamples) continue;
      const key = y * 4096 + x;
      let misfit = cache.get(key);
      if (misfit === undefined) {
        const fromMs = fromSample / samplesPerMs;
        const toMs = toSample / samplesPerMs;
        misfit =
          (weights.envelope * decayMisfit(region.env, fromMs, toMs) +
            weights.pitch * pitchInstability(region.pitch, fromMs, toMs) +
            weights.chroma * chromaInstability(region.windows, y, x)) *
          ((toMs - fromMs) / 1000);
        cache.set(key, misfit);
        region.evaluations++;
      }
      const candidate = (best[y] as number) + misfit + (y === 0 ? 0 : price);
      if (candidate < (best[x] as number)) {
        best[x] = candidate;
        back[x] = y;
      }
    }
  }

  if ((best[n] as number) === Infinity) return [positions[0] as number];
  const starts: number[] = [];
  let at = n;
  while (at > 0) {
    const previous = back[at] as number;
    starts.push(positions[previous] as number);
    at = previous;
  }
  starts.reverse();
  return starts;
}

/**
 * Gather what every region needs, without touching the engine.
 *
 * The region spans come from the deep lane itself: `analyzeRegion` is wrapped
 * for the duration of the run and restored after, so the regions measured here
 * are exactly the ones the shipped recognizer ruled on, in the order it ruled
 * on them, and nothing about its behaviour changes.
 */
function gather(): FixtureData[] {
  const out: FixtureData[] = [];
  const config = resolveEngineConfig();
  const prototype = DeepLane.prototype as unknown as Record<string, unknown>;
  const original = prototype["analyzeRegion"] as (...args: unknown[]) => unknown;

  for (const fixture of decodeFixtures({ quiet: true })) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const sampleRate = wav.sampleRate;
    const samplesPerMs = sampleRate / 1000;
    const clock = new SampleClock(sampleRate);
    const spectral = new SpectralAnalyzer(sampleRate, config);
    const multiPitch = new MultiPitchAnalyzer(spectral);
    const harmonic = new HarmonicInterpreter(config);
    const windowSize = spectral.windowSize;
    const scratch = new Float32Array(windowSize);

    const env: EnvPoint[] = [];
    for (let from = 0; from + ENV_WINDOW <= mono.length; from += ENV_HOP) {
      let sum = 0;
      for (let i = from; i < from + ENV_WINDOW; i++) {
        sum += (mono[i] as number) * (mono[i] as number);
      }
      env.push({
        atMs: (from + ENV_WINDOW / 2) / samplesPerMs,
        logLevel: Math.log(Math.max(Math.sqrt(sum / ENV_WINDOW), 1e-7)),
      });
    }

    const seen: Array<{ from: number; to: number; attacks: readonly number[] }> = [];
    let refused = 0;
    prototype["analyzeRegion"] = function patched(this: unknown, ...args: unknown[]): unknown {
      const request = args[0] as {
        fromSample: number;
        toSample: number;
        attackSamples: readonly number[];
      };
      const result = original.apply(this, args);
      if (result === null) refused++;
      else {
        seen.push({
          from: request.fromSample,
          to: request.toSample,
          attacks: request.attackSamples,
        });
      }
      return result;
    };
    let analysis;
    try {
      analysis = analyzeSamples(mono, sampleRate, { captureFrames: true });
    } finally {
      prototype["analyzeRegion"] = original;
    }

    const pitch: PitchPoint[] = [];
    for (const frame of analysis.frames) {
      if (frame.frequencyHz === null || frame.confidence < PITCH_CONFIDENCE) continue;
      const midi = Math.round(69 + 12 * Math.log2(frame.frequencyHz / 440));
      pitch.push({
        atMs: frame.timestamp,
        pitchClass: ((midi % 12) + 12) % 12,
        weight: frame.amplitude.rms,
      });
    }

    const regions: RegionData[] = [];
    let tooSparse = 0;
    for (const request of seen) {
      const span = request.to - request.from;
      const available = span - windowSize;
      const hop = Math.max(1, config.deep.regionHopSamples);
      let count = Math.floor(available / hop) + 1;
      let stride = hop;
      if (count > config.deep.maxRegionWindows) {
        stride = Math.ceil(available / Math.max(1, config.deep.maxRegionWindows - 1));
        count = Math.floor(available / stride) + 1;
      }

      const windows: RegionWindowReading[] = [];
      for (let i = 0; i < count; i++) {
        const from = request.from + i * stride;
        if (from < 0 || from + windowSize > mono.length) break;
        scratch.set(mono.subarray(from, from + windowSize));
        const evidence = spectral.analyze(scratch);
        const activations = multiPitch.activations(evidence);
        const reading = harmonic.interpret(evidence, activations);
        let dominantMidi: number | null = null;
        let leader = -1;
        let runnerUp = 0;
        for (const activation of activations) {
          if (activation.salience > leader) {
            runnerUp = leader < 0 ? 0 : leader;
            leader = activation.salience;
            dominantMidi = activation.midi;
          } else if (activation.salience > runnerUp) {
            runnerUp = activation.salience;
          }
        }
        let sum = 0;
        for (let k = 0; k < windowSize; k++) {
          sum += (scratch[k] as number) * (scratch[k] as number);
        }
        windows.push({
          fromSample: from,
          toSample: from + windowSize,
          at: clock.toMs(from + windowSize),
          dominantMidi,
          runnerUpSalience: runnerUp,
          rms: Math.sqrt(sum / windowSize),
          activations,
          evidence,
          reading,
        });
      }
      // Two candidate positions is one segment with no choice to make.
      if (windows.length < 3) {
        tooSparse++;
        continue;
      }

      const positions = windows.map((w) => Math.max(0, w.toSample - windowSize));
      positions.push((windows[windows.length - 1] as RegionWindowReading).toSample);
      const fromMs = (positions[0] as number) / samplesPerMs;
      const toMs = (positions[positions.length - 1] as number) / samplesPerMs;
      regions.push({
        positions,
        windows,
        env: env.filter((p) => p.atMs >= fromMs && p.atMs < toMs),
        pitch: pitch.filter((p) => p.atMs >= fromMs && p.atMs < toMs),
        greedy: segmentRegion(windows, {
          minSegmentMs: config.deep.minSegmentMs,
          holdWindows: config.deep.segmentHoldWindows,
          riseRatio: config.deep.segmentRiseRatio,
          attackSamples: request.attacks,
          attackRiseRatio: config.deep.segmentAttackRiseRatio,
          windowSize,
          samplesPerMs,
        }),
        fromSample: request.from,
        toSample: request.to,
        evaluations: 0,
      });
    }

    out.push({
      stem: fixture.stem,
      chain: chainOf(fixture.stem),
      sampleRate,
      labels: fixture.label.events.map((e) => ({ id: e.id, startMs: e.startMs })),
      regions,
      noteStarts: projectEmissions(analysis.emissions).final.map((d) => d.startedAt),
      refused,
      tooSparse,
    });
  }
  return out;
}

/**
 * Only the labels a region could possibly answer for.
 *
 * Anything outside every analysed region is a label no version of this method
 * could ever reach, and counting it as missed would charge the DP for a failure
 * that happened before the deep lane was involved. It is reported separately.
 */
function labelsInRegions(fixture: FixtureData): number[] {
  const samplesPerMs = fixture.sampleRate / 1000;
  const out: number[] = [];
  for (const label of fixture.labels) {
    const at = label.startMs * samplesPerMs;
    const covered = fixture.regions.some(
      (r) => at >= r.fromSample - MATCH_MS * samplesPerMs && at < r.toSample
    );
    if (covered) out.push(label.startMs);
  }
  return out;
}

/** Detections inside the analysed regions, deduplicated across any overlap. */
function dedupe(times: readonly number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  for (const time of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && time - last < 20) continue;
    out.push(time);
  }
  return out;
}

function scoreDp(
  fixtures: readonly FixtureData[],
  price: number,
  weights: Weights,
  caches: Map<RegionData, Map<number, number>>
): { total: Score; perChain: Map<Chain, Score>; perFixture: Map<string, Score> } {
  const perChain = new Map<Chain, Score>();
  const perFixture = new Map<string, Score>();
  const total = emptyScore();
  for (const fixture of fixtures) {
    const samplesPerMs = fixture.sampleRate / 1000;
    const starts: number[] = [];
    for (const region of fixture.regions) {
      let cache = caches.get(region);
      if (cache === undefined) {
        cache = new Map<number, number>();
        caches.set(region, cache);
      }
      for (const start of partition(region, price, weights, samplesPerMs, cache)) {
        starts.push(start / samplesPerMs);
      }
    }
    const result = score(dedupe(starts), labelsInRegions(fixture));
    perFixture.set(fixture.stem, result);
    add(total, result);
    const chain = perChain.get(fixture.chain) ?? emptyScore();
    add(chain, result);
    perChain.set(fixture.chain, chain);
  }
  return { total, perChain, perFixture };
}

function scoreControl(
  fixtures: readonly FixtureData[],
  pick: (f: FixtureData) => number[]
): { total: Score; perChain: Map<Chain, Score> } {
  const total = emptyScore();
  const perChain = new Map<Chain, Score>();
  for (const fixture of fixtures) {
    const result = score(dedupe(pick(fixture)), labelsInRegions(fixture));
    add(total, result);
    const chain = perChain.get(fixture.chain) ?? emptyScore();
    add(chain, result);
    perChain.set(fixture.chain, chain);
  }
  return { total, perChain };
}

function greedyStarts(fixture: FixtureData): number[] {
  const samplesPerMs = fixture.sampleRate / 1000;
  const out: number[] = [];
  for (const region of fixture.regions) {
    for (const segment of region.greedy) out.push(segment.fromSample / samplesPerMs);
  }
  return out;
}

function row(label: string, s: Score): string {
  return (
    `  ${label.padEnd(30)} ${String(s.missed).padStart(7)} ${String(s.found).padStart(7)} ` +
    `${String(s.extras).padStart(7)} ${String(s.detections).padStart(8)}`
  );
}

function header(): string {
  return (
    `  ${"variant".padEnd(30)} ${"MISSED".padStart(7)} ${"found".padStart(7)} ` +
    `${"extras".padStart(7)} ${"segments".padStart(8)}\n  ${"-".repeat(30)} ${"-".repeat(7)} ` +
    `${"-".repeat(7)} ${"-".repeat(7)} ${"-".repeat(8)}`
  );
}

/** Fewer missed labels is worth more than fewer extras: a miss is unrecoverable. */
function objective(s: Score): number {
  return s.missed * 3 + s.extras;
}

/**
 * The mechanism, asked directly rather than through the DP's answer.
 *
 * The claim is not that a DP is a better search — it provably is, the partition
 * it returns is optimal. The claim is that the QUANTITY separates: that cutting
 * at a real re-pick buys a large reduction in misfit and cutting a same-pitch
 * tail off its own head buys almost none. That is a statement about the cost
 * function alone, and it can be measured without any price at all.
 *
 * For every candidate position the greedy rule proposes, this reports the
 * misfit its cut buys against its two neighbouring boundaries —
 * `cost(prev,here) + cost(here,next) - cost(prev,next)` — split by whether a
 * label is annotated within `MATCH_MS`. If the mechanism is real these two
 * populations separate. The number to compare it against is the 0.73 AUC of the
 * best single local witness already measured.
 */
function mechanism(
  fixtures: readonly FixtureData[],
  weights: Weights
): { onLabel: number[]; offLabel: number[] } {
  const onLabel: number[] = [];
  const offLabel: number[] = [];
  for (const fixture of fixtures) {
    const samplesPerMs = fixture.sampleRate / 1000;
    const labels = fixture.labels.map((l) => l.startMs);
    for (const region of fixture.regions) {
      const cache = new Map<number, number>();
      const span = (y: number, x: number): number => {
        const key = y * 4096 + x;
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        const fromMs = (region.positions[y] as number) / samplesPerMs;
        const toMs = (region.positions[x] as number) / samplesPerMs;
        const value =
          (weights.envelope * decayMisfit(region.env, fromMs, toMs) +
            weights.pitch * pitchInstability(region.pitch, fromMs, toMs) +
            weights.chroma * chromaInstability(region.windows, y, x)) *
          ((toMs - fromMs) / 1000);
        cache.set(key, value);
        return value;
      };
      // The greedy rule's own boundaries, snapped to the candidate grid.
      const cuts = region.greedy
        .slice(1)
        .map((segment) => {
          let index = 0;
          let bestGap = Infinity;
          for (let i = 1; i < region.positions.length - 1; i++) {
            const gap = Math.abs((region.positions[i] as number) - segment.fromSample);
            if (gap < bestGap) {
              bestGap = gap;
              index = i;
            }
          }
          return index;
        })
        .filter((index) => index > 0);
      const bounds = [0, ...cuts, region.positions.length - 1];
      for (let k = 1; k < bounds.length - 1; k++) {
        const previous = bounds[k - 1] as number;
        const here = bounds[k] as number;
        const next = bounds[k + 1] as number;
        if (here - previous < 1 || next - here < 1) continue;
        // How much misfit the cut BUYS: positive means splitting explains the
        // audio better than one note does. This is exactly the quantity the DP
        // compares against the price, so its separation is the DP's separation.
        const gain = span(previous, next) - (span(previous, here) + span(here, next));
        const atMs = (region.positions[here] as number) / samplesPerMs;
        const near = labels.some((l) => Math.abs(l - atMs) <= MATCH_MS);
        (near ? onLabel : offLabel).push(gain);
      }
    }
  }
  return { onLabel, offLabel };
}

/** Probability a randomly drawn positive outranks a randomly drawn negative. */
function auc(positive: readonly number[], negative: readonly number[]): number {
  if (positive.length === 0 || negative.length === 0) return NaN;
  let wins = 0;
  for (const p of positive) {
    for (const n of negative) wins += p > n ? 1 : p === n ? 0.5 : 0;
  }
  return wins / (positive.length * negative.length);
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[at] as number;
}

function main(): void {
  const args = process.argv.slice(2);
  const detail = args.includes("--detail");
  const controls = args.includes("--controls");
  const weightSweep = args.includes("--weights");

  const startedAt = Date.now();
  const fixtures = gather();
  const gatherMs = Date.now() - startedAt;

  const totalLabels = fixtures.reduce((n, f) => n + f.labels.length, 0);
  const coveredLabels = fixtures.reduce((n, f) => n + labelsInRegions(f).length, 0);
  const regionCount = fixtures.reduce((n, f) => n + f.regions.length, 0);
  const refused = fixtures.reduce((n, f) => n + f.refused, 0);
  const tooSparse = fixtures.reduce((n, f) => n + f.tooSparse, 0);

  console.log(
    `\n  ${regionCount} regions over ${fixtures.length} takes, covering ${coveredLabels} ` +
      `of ${totalLabels} labels.`
  );
  console.log(
    `  ${refused} regions the deep lane itself refused, ${tooSparse} with fewer than three ` +
      `candidate positions.`
  );
  console.log(
    `  The ${totalLabels - coveredLabels} labels outside every region are unreachable by ` +
      `any segmentation rule and are excluded from every row below.\n`
  );

  const caches = new Map<RegionData, Map<number, number>>();

  if (controls) {
    console.log("  CONTROLS — identical scorer, identical regions\n");
    console.log(header());
    console.log(row("shipped recognizer Notes", scoreControl(fixtures, (f) => f.noteStarts).total));
    console.log(row("greedy segmentRegion()", scoreControl(fixtures, greedyStarts).total));
    console.log("");
  }

  console.log("  PRICE SWEEP — CEILING. Price chosen fit-on-test against the whole corpus.\n");
  console.log(header());
  const sweep: Array<{ price: number; total: Score }> = [];
  for (const price of PRICES) {
    const result = scoreDp(fixtures, price, WEIGHTS, caches);
    sweep.push({ price, total: result.total });
    console.log(row(`price ${price.toFixed(3)}`, result.total));
  }
  console.log("");

  const inside = sweep.filter((s) => s.total.missed < 32 && s.total.extras < 107);
  if (inside.length === 0) {
    const nearest = sweep.reduce((a, b) => (objective(a.total) <= objective(b.total) ? a : b));
    console.log(
      `  FALSIFIED: no price is strictly inside 32 missed / 107 extras on both axes.\n` +
        `  Nearest point: price ${nearest.price.toFixed(3)}, ${nearest.total.missed} missed / ` +
        `${nearest.total.extras} extras.\n`
    );
  } else {
    const best = inside.reduce((a, b) => (objective(a.total) <= objective(b.total) ? a : b));
    console.log(
      `  Best point strictly inside the baseline: price ${best.price.toFixed(3)}, ` +
        `${best.total.missed} missed / ${best.total.extras} extras.\n`
    );
  }

  {
    const variants: Array<[string, Weights]> = [
      ["as chosen .5/.3/.2", WEIGHTS],
      ["envelope only", { envelope: 1, pitch: 0, chroma: 0 }],
      ["pitch only", { envelope: 0, pitch: 1, chroma: 0 }],
      ["chroma only", { envelope: 0, pitch: 0, chroma: 1 }],
    ];
    console.log(
      "  THE MECHANISM, asked directly: misfit a cut buys, at the greedy rule's own\n" +
        "  candidate boundaries, split by whether a label is annotated within 70ms.\n" +
        "  The bar to clear is the 0.73 AUC of the best single LOCAL witness.\n"
    );
    console.log(
      `  ${"cost".padEnd(22)} ${"n on".padStart(6)} ${"n off".padStart(6)} ` +
        `${"median on".padStart(10)} ${"median off".padStart(11)} ${"AUC".padStart(6)}`
    );
    console.log(`  ${"-".repeat(22)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(10)} ${"-".repeat(11)} ${"-".repeat(6)}`);
    for (const [name, weights] of variants) {
      const { onLabel, offLabel } = mechanism(fixtures, weights);
      console.log(
        `  ${name.padEnd(22)} ${String(onLabel.length).padStart(6)} ` +
          `${String(offLabel.length).padStart(6)} ` +
          `${quantile(onLabel, 0.5).toFixed(5).padStart(10)} ` +
          `${quantile(offLabel, 0.5).toFixed(5).padStart(11)} ` +
          `${auc(onLabel, offLabel).toFixed(3).padStart(6)}`
      );
    }
    console.log("");
  }

  if (weightSweep) {
    console.log("  COST-TERM SENSITIVITY — each variant at its own best price\n");
    console.log(header());
    const variants: Array<[string, Weights]> = [
      ["envelope only", { envelope: 1, pitch: 0, chroma: 0 }],
      ["pitch only", { envelope: 0, pitch: 1, chroma: 0 }],
      ["chroma only", { envelope: 0, pitch: 0, chroma: 1 }],
      ["envelope + pitch", { envelope: 0.6, pitch: 0.4, chroma: 0 }],
      ["equal thirds", { envelope: 1 / 3, pitch: 1 / 3, chroma: 1 / 3 }],
      ["as chosen .5/.3/.2", WEIGHTS],
    ];
    for (const [name, weights] of variants) {
      const local = new Map<RegionData, Map<number, number>>();
      let best: Score | null = null;
      let bestPrice = 0;
      let leastMissedUnder107 = Infinity;
      for (const price of PRICES) {
        const result = scoreDp(fixtures, price, weights, local).total;
        if (result.extras < 107) leastMissedUnder107 = Math.min(leastMissedUnder107, result.missed);
        if (best === null || objective(result) < objective(best)) {
          best = result;
          bestPrice = price;
        }
      }
      if (best !== null) console.log(row(`${name} @ ${bestPrice.toFixed(3)}`, best));
      console.log(
        `  ${"".padEnd(30)} fewest missed at under 107 extras: ` +
          `${Number.isFinite(leastMissedUnder107) ? leastMissedUnder107 : "never under 107"}`
      );
    }
    console.log("");
  }

  // Reported whatever the ceiling said. A price derived on five takes and
  // applied to twelve is the only number that could ever be deployed, and the
  // gap between it and the ceiling is the part of any gain that is not real.
  const derivation = fixtures.filter((f) => DERIVATION.some((d) => f.stem.startsWith(d)));
  const heldOut = fixtures.filter((f) => !DERIVATION.some((d) => f.stem.startsWith(d)));
  let derivedPrice = PRICES[0] as number;
  let bestObjective = Infinity;
  for (const price of PRICES) {
    const result = scoreDp(derivation, price, WEIGHTS, caches).total;
    if (objective(result) < bestObjective) {
      bestObjective = objective(result);
      derivedPrice = price;
    }
  }
  console.log(`  DERIVED on the five 120bpm takes: price ${derivedPrice.toFixed(3)}\n`);
  console.log(header());
  console.log(row("derivation five", scoreDp(derivation, derivedPrice, WEIGHTS, caches).total));
  const held = scoreDp(heldOut, derivedPrice, WEIGHTS, caches);
  console.log(row("held-out twelve", held.total));
  const heldGreedy = scoreControl(heldOut, greedyStarts);
  const heldNotes = scoreControl(heldOut, (f) => f.noteStarts);
  console.log(row("held-out greedy control", heldGreedy.total));
  console.log(row("held-out shipped Notes", heldNotes.total));
  console.log("");

  console.log("  Held out, per signal chain — DP at the derived price / greedy / shipped\n");
  console.log(header());
  for (const chain of [...held.perChain.keys()].sort((a, b) => a.localeCompare(b))) {
    console.log(row(`${chain}  DP`, held.perChain.get(chain) as Score));
    console.log(row(`${chain}  greedy`, heldGreedy.perChain.get(chain) as Score));
    console.log(row(`${chain}  shipped`, heldNotes.perChain.get(chain) as Score));
  }
  console.log("");

  if (detail) {
    const perFixture = scoreDp(fixtures, derivedPrice, WEIGHTS, caches).perFixture;
    console.log("  Per fixture, at the derived price\n");
    console.log(header());
    for (const [stem, s] of perFixture) console.log(row(stem, s));
    console.log("");
  }

  const evaluations = fixtures.reduce(
    (n, f) => n + f.regions.reduce((m, r) => m + r.evaluations, 0),
    0
  );
  const positions = fixtures.reduce(
    (n, f) => n + f.regions.reduce((m, r) => m + r.positions.length, 0),
    0
  );
  const dpMs = Date.now() - startedAt - gatherMs;
  console.log(
    `  Cost: ${(positions / Math.max(1, regionCount)).toFixed(1)} candidate positions per ` +
      `region, ${(evaluations / Math.max(1, regionCount)).toFixed(0)} distinct span ` +
      `evaluations per region.`
  );
  console.log(
    `  ${dpMs}ms of DP for the whole sweep (${PRICES.length} prices over ${regionCount} ` +
      `regions); gathering took ${(gatherMs / 1000).toFixed(1)}s.\n`
  );
}

main();
