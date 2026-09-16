/**
 * What the DIRECT-INPUT audio supports for onset detection, before any tracker
 * rule runs: a ceiling study over causal detection functions at a fine hop.
 *
 * The downstream ledger says the six strokes still lost on the DI sixteenths
 * take are lost at the onset kernel — `kernels/onset.ts` never fired within
 * the window — and nowhere else. That is a claim about one detector at one
 * hop (13.3ms) with one dead time (60ms). This asks the prior question: does
 * ANY cheap causal function see every labelled stroke on the DI takes without
 * also firing where nothing was played?
 *
 * Several functions are swept over their whole threshold range and scored two
 * ways at every threshold:
 *
 *  - **coverage**: labelled onsets with a candidate within `WINDOW_MS`, under
 *    NEAREST-label attribution. A candidate belongs to the label it is nearest
 *    to and to no other, so a neighbour's onset cannot cover this label. The
 *    window is ±30ms, well under the 107ms sixteenth at 140bpm and under the
 *    63ms rushed pair on this take — a ±60ms window has produced a false
 *    "48/48" on this material before (see `docs/DETECTION-FINDINGS.md`).
 *  - **off-label**: candidates inside the played span that are nearest to no
 *    label within the window. Reported with the fraction that are "mute-
 *    shaped" — the 20ms envelope FELL after the transient — because a muting
 *    hand is a transient the audio genuinely contains and a tracker can reject
 *    on the energy that follows, where a false alarm inside a sustain cannot
 *    be told apart from a real quiet stroke by anything after it.
 *
 * Every function is causal apart from the ±13ms local-maximum test in peak
 * picking, which is a 13ms latency and not a look into the next stroke.
 *
 * This is a CEILING reading on HELD-OUT material. Nothing here is fitted into
 * the engine; the thresholds reported are the best operating point on the
 * take being measured, which is exactly the fit-on-test number the project
 * forbids as a result. Its use is the other way round: a function that cannot
 * reach a label at ANY threshold here cannot reach it once tuned honestly.
 *
 * Usage:
 *   npx tsx scripts/measure-di-onset-ceiling.ts               the four DI takes
 *   npx tsx scripts/measure-di-onset-ceiling.ts sixteenths    one subset
 *   npx tsx scripts/measure-di-onset-ceiling.ts --all         every fixture
 *   npx tsx scripts/measure-di-onset-ceiling.ts --detail      per missed label
 *   npx tsx scripts/measure-di-onset-ceiling.ts --contextual  reject by what follows
 *   npx tsx scripts/measure-di-onset-ceiling.ts --candidates=superflux   list them
 */

import { readFileSync } from "node:fs";
import { RealFFT, hannWindow } from "../src/engine/kernels/fft.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/** Attribution window, half-width. */
const WINDOW_MS = 30;
/** Analysis hop for every function. 128 samples is 2.67ms at 48kHz. */
const HOP = 128;
/** Dead time after a candidate, in ms. Under the 63ms rushed pair on the DI sixteenths. */
const DEAD_MS = 40;
/** Local-maximum half-width for peak picking, in hops (5 hops = 13ms). */
const PEAK_HALF_HOPS = 5;
/** Padding around the labelled span inside which off-label firings are counted. */
const PLAYED_PAD_MS = 300;

type Labels = { onsets: number[]; ends: number[] };

type Curve = {
  name: string;
  /** One value per hop, indexed by hop; `times[i]` is the hop's END in ms. */
  values: Float64Array;
};

type Candidate = { at: number; value: number };

/* -------------------------------------------------------------------------- */
/* Detection functions                                                         */
/* -------------------------------------------------------------------------- */

function hopTimesMs(sampleCount: number, sampleRate: number): Float64Array {
  const hops = Math.floor(sampleCount / HOP);
  const out = new Float64Array(hops);
  for (let i = 0; i < hops; i++) out[i] = ((i + 1) * HOP * 1000) / sampleRate;
  return out;
}

/**
 * Spectral-flux family at N=1024. Three readings from one transform sequence:
 *  - linear rectified flux over a frame's own magnitude (the engine's shape),
 *  - log-compressed rectified flux (Böck's log(1 + γ|X|), level-independent),
 *  - the same with the reference max-filtered over ±1 bin (SuperFlux).
 * The reference is the per-bin maximum over the frames ending 8–24ms ago.
 */
function fluxFamily(
  samples: Float32Array,
  sampleRate: number,
  hops: number
): { linRel: Float64Array; log: Float64Array; superflux: Float64Array; band: Float64Array } {
  const N = 1024;
  const fft = new RealFFT(N);
  const hann = hannWindow(N);
  const bins = fft.bins;
  const frame = new Float32Array(N);
  const mag = new Float32Array(bins);
  const binHz = sampleRate / N;
  const lo = Math.max(1, Math.round(80 / binHz));
  const hi = Math.min(bins, Math.round(8000 / binHz));
  const bandLo = Math.round(1500 / binHz);
  const bandHi = Math.min(bins, Math.round(6000 / binHz));
  const refFrom = 3; // hops back, inclusive: 8ms
  const refTo = 9; // hops back, inclusive: 24ms
  const history: Float32Array[] = [];
  for (let i = 0; i <= refTo; i++) history.push(new Float32Array(bins));
  const logHistory: Float32Array[] = [];
  for (let i = 0; i <= refTo; i++) logHistory.push(new Float32Array(bins));

  const linRel = new Float64Array(hops);
  const log = new Float64Array(hops);
  const superflux = new Float64Array(hops);
  const band = new Float64Array(hops);
  const logMag = new Float32Array(bins);
  const gamma = 20;
  const scale = 2 / hann.reduce((a, b) => a + b, 0);

  for (let h = 0; h < hops; h++) {
    const end = (h + 1) * HOP;
    const start = end - N;
    frame.fill(0);
    if (start >= 0) frame.set(samples.subarray(start, end));
    else frame.set(samples.subarray(0, end), N - end);
    for (let i = 0; i < N; i++) frame[i] = (frame[i] as number) * (hann[i] as number);
    fft.magnitudes(frame, mag);
    for (let k = 0; k < bins; k++) {
      mag[k] = (mag[k] as number) * scale;
      logMag[k] = Math.log(1 + gamma * (mag[k] as number));
    }

    let flux = 0;
    let total = 0;
    let lflux = 0;
    let sflux = 0;
    let bflux = 0;
    let btotal = 0;
    for (let k = lo; k < hi; k++) {
      let ref = 0;
      let lref = 0;
      let sref = 0;
      for (let d = refFrom; d <= refTo; d++) {
        const slot = ((h - d) % (refTo + 1) + (refTo + 1)) % (refTo + 1);
        const past = history[slot] as Float32Array;
        const lpast = logHistory[slot] as Float32Array;
        if (h - d < 0) continue;
        const v = past[k] as number;
        if (v > ref) ref = v;
        const lv = lpast[k] as number;
        if (lv > lref) lref = lv;
        for (let j = Math.max(0, k - 1); j <= Math.min(bins - 1, k + 1); j++) {
          const sv = lpast[j] as number;
          if (sv > sref) sref = sv;
        }
      }
      const m = mag[k] as number;
      total += m;
      const d = m - ref;
      if (d > 0) flux += d;
      const ld = (logMag[k] as number) - lref;
      if (ld > 0) lflux += ld;
      const sd = (logMag[k] as number) - sref;
      if (sd > 0) sflux += sd;
      if (k >= bandLo && k < bandHi) {
        btotal += m;
        if (d > 0) bflux += d;
      }
    }
    linRel[h] = total > 1e-6 ? flux / total : 0;
    log[h] = lflux;
    superflux[h] = sflux;
    band[h] = btotal > 1e-7 ? bflux / btotal : 0;

    const slot = h % (refTo + 1);
    (history[slot] as Float32Array).set(mag);
    (logHistory[slot] as Float32Array).set(logMag);
  }
  return { linRel, log, superflux, band };
}

/** RBJ high-pass biquad, applied twice (four poles). */
function highpass(samples: Float32Array, sampleRate: number, hz: number): Float32Array {
  const w0 = (2 * Math.PI * hz) / sampleRate;
  const q = Math.SQRT1_2;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const b0 = (1 + cos) / 2;
  const b1 = -(1 + cos);
  const b2 = (1 + cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let out = samples;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(out.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const x0 = out[i] as number;
      const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      next[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
    out = next;
  }
  return out;
}

/**
 * The labeller's own witness, made causal: a 1.5kHz-highpassed 1ms RMS
 * envelope, read as its rise in dB over the quietest millisecond of the
 * preceding 40ms. A pick is broadband and lands in a few milliseconds; the
 * ringing string's partials are almost all below the highpass.
 */
function highpassEnvelopeRise(samples: Float32Array, sampleRate: number, hops: number): Float64Array {
  const hp = highpass(samples, sampleRate, 1500);
  const msSamples = Math.round(sampleRate / 1000);
  const envHops = Math.floor(hp.length / msSamples);
  const env = new Float64Array(envHops);
  for (let i = 0; i < envHops; i++) {
    let e = 0;
    for (let j = i * msSamples; j < (i + 1) * msSamples; j++) e += (hp[j] as number) * (hp[j] as number);
    env[i] = Math.sqrt(e / msSamples) + 1e-7;
  }
  const out = new Float64Array(hops);
  const hopMs = (HOP * 1000) / sampleRate;
  for (let h = 0; h < hops; h++) {
    const tMs = (h + 1) * hopMs;
    const iTo = Math.min(envHops - 1, Math.floor(tMs));
    const iFrom = Math.max(0, Math.floor(tMs - hopMs));
    let peak = 0;
    for (let i = iFrom; i <= iTo; i++) if ((env[i] as number) > peak) peak = env[i] as number;
    let floor = Number.POSITIVE_INFINITY;
    for (let i = Math.max(0, iFrom - 40); i < Math.max(0, iFrom - 4); i++) {
      if ((env[i] as number) < floor) floor = env[i] as number;
    }
    out[h] = Number.isFinite(floor) && floor > 0 ? 20 * Math.log10(peak / floor) : 0;
  }
  return out;
}

/**
 * Linear-prediction residual: how unpredictable the newest samples are given
 * the previous 10ms. A decaying string is a sum of damped sinusoids and an
 * order-16 predictor fitted to the last 512 samples explains the next 128 to
 * within a few percent; a pick is an impulse and explains nothing. Read as the
 * prediction error of the NEW samples in dB over the median error of the
 * preceding 80ms, so it is level-independent by construction.
 */
function lpcResidual(samples: Float32Array, hops: number): Float64Array {
  const order = 16;
  const frameLen = 512;
  const r = new Float64Array(order + 1);
  const a = new Float64Array(order + 1);
  const prev = new Float64Array(order + 1);
  const errors = new Float64Array(hops);
  for (let h = 0; h < hops; h++) {
    const end = h * HOP; // predictor is fitted on samples BEFORE this hop's samples
    const start = end - frameLen;
    if (start < 0) {
      errors[h] = 0;
      continue;
    }
    // Autocorrelation of the fitting frame.
    for (let lag = 0; lag <= order; lag++) {
      let s = 0;
      for (let i = start; i < end - lag; i++) s += (samples[i] as number) * (samples[i + lag] as number);
      r[lag] = s;
    }
    if ((r[0] as number) <= 1e-12) {
      errors[h] = 0;
      continue;
    }
    // Levinson-Durbin.
    a.fill(0);
    a[0] = 1;
    let err = r[0] as number;
    for (let i = 1; i <= order; i++) {
      let acc = r[i] as number;
      for (let j = 1; j < i; j++) acc += (a[j] as number) * (r[i - j] as number);
      const k = -acc / err;
      prev.set(a);
      for (let j = 1; j < i; j++) a[j] = (prev[j] as number) + k * (prev[i - j] as number);
      a[i] = k;
      err *= 1 - k * k;
      if (err <= 0) break;
    }
    // Prediction error over the hop's new samples.
    let e = 0;
    let sig = 0;
    for (let n = end; n < end + HOP && n < samples.length; n++) {
      let p = samples[n] as number;
      for (let j = 1; j <= order; j++) p += (a[j] as number) * (samples[n - j] as number);
      e += p * p;
      sig += (samples[n] as number) * (samples[n] as number);
    }
    errors[h] = e;
    void sig;
  }
  const out = new Float64Array(hops);
  const back = 30; // hops of median memory (80ms)
  const scratch: number[] = [];
  for (let h = 0; h < hops; h++) {
    scratch.length = 0;
    for (let d = 1; d <= back && h - d >= 0; d++) scratch.push(errors[h - d] as number);
    if (scratch.length < 8) {
      out[h] = 0;
      continue;
    }
    scratch.sort((x, y) => x - y);
    const median = scratch[scratch.length >> 1] as number;
    const e = errors[h] as number;
    out[h] = median > 1e-14 && e > 0 ? 10 * Math.log10(e / median) : 0;
  }
  return out;
}

/**
 * The pick's contact, then its release: a dip followed by a rebound.
 *
 * Measured on the DI sixteenths, every quiet re-pick is preceded by the
 * string being DAMPED as the pick lands on it — the 5ms envelope drops 13 to
 * 26dB inside ~15ms — and the stroke is the rebound out of that dip. A hand
 * mute is the dip without the rebound; sustain ripple and polarisation beating
 * never dip that far that fast. This is not an energy-increase detector
 * against a decaying baseline, which is what every witness in the tracker's
 * re-articulation decision is; it keys on the contact that precedes the
 * energy, which is why it is measured here as its own function.
 *
 * Value: the rebound in dB — the 5ms envelope now over its minimum in the
 * preceding 2–18ms — when that minimum sits at least `DIP_DB` below the
 * envelope's maximum over the 18–45ms before it; zero otherwise.
 */
const DIP_DB = 6;
/** The engine's `rmsGate`: a dip is only a dip when the string was audible before it. */
const DIP_LEVEL_FLOOR = 0.008;

function dipRebound(samples: Float32Array, sampleRate: number, hops: number): Float64Array {
  const msSamples = Math.round(sampleRate / 1000);
  const envHops = Math.floor(samples.length / msSamples);
  // 5ms RMS at 1ms steps.
  const env = new Float64Array(envHops);
  for (let i = 0; i < envHops; i++) {
    let e = 0;
    const end = (i + 1) * msSamples;
    const start = Math.max(0, end - 5 * msSamples);
    for (let j = start; j < end; j++) e += (samples[j] as number) * (samples[j] as number);
    env[i] = Math.sqrt(e / Math.max(1, end - start)) + 1e-7;
  }
  const out = new Float64Array(hops);
  const hopMs = (HOP * 1000) / sampleRate;
  for (let h = 0; h < hops; h++) {
    const tMs = (h + 1) * hopMs;
    const t = Math.min(envHops - 1, Math.floor(tMs));
    if (t < 50) continue;
    const now = env[t] as number;
    let dipMin = Number.POSITIVE_INFINITY;
    for (let i = t - 18; i <= t - 2; i++) dipMin = Math.min(dipMin, env[i] as number);
    let priorMax = 0;
    for (let i = t - 45; i <= t - 18; i++) priorMax = Math.max(priorMax, env[i] as number);
    // A dip has to be a dip in playing, not in room tone: below the engine's
    // own amplitude gate there is nothing for a pick to damp.
    if (priorMax < DIP_LEVEL_FLOOR) continue;
    const dip = 20 * Math.log10(dipMin / priorMax);
    if (dip > -DIP_DB) continue;
    out[h] = Math.max(0, 20 * Math.log10(now / dipMin));
  }
  return out;
}

/**
 * The level-adaptive form of a detection function: the value over the median
 * of the preceding `back` hops (38 hops is 100ms). This is the peak-picking
 * rule of the onset literature (Böck et al.), and it is what makes a threshold
 * mean the same thing at two input gains.
 */
function minusTrailingMedian(curve: Float64Array, back: number): Float64Array {
  const out = new Float64Array(curve.length);
  const scratch: number[] = [];
  for (let h = 0; h < curve.length; h++) {
    scratch.length = 0;
    for (let d = 1; d <= back && h - d >= 0; d++) scratch.push(curve[h - d] as number);
    if (scratch.length < 8) {
      out[h] = 0;
      continue;
    }
    scratch.sort((x, y) => x - y);
    out[h] = (curve[h] as number) - (scratch[scratch.length >> 1] as number);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Peak picking and scoring                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Contextual rejection of a candidate by what FOLLOWS it — the two shapes
 * every off-label firing on the DI takes turned out to have:
 *
 *  - **preparation**: a stronger candidate lands within `PREP_MS` and is at
 *    least `PREP_RATIO` times this one. The pick touching the string before
 *    the stroke, 30–65ms ahead of it on these takes.
 *  - **mute**: the 20ms envelope 35ms after the candidate is below half of
 *    what it was 5ms before. A transient that REMOVED energy is a hand, not a
 *    pick.
 *
 * Both need a short look past the candidate (65ms and 45ms), so in the engine
 * they are a deep-lane veto on a fast-lane proposal, not a fast-lane decision.
 */
const PREP_MS = 65;
const PREP_RATIO = 4;
const MUTE_RATIO = 0.5;

function contextualFilter(candidates: Candidate[], samples: Float32Array, sampleRate: number): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i] as Candidate;
    let preparation = false;
    if (CONTEXTUAL_PREP) {
      for (let j = i + 1; j < candidates.length; j++) {
        const n = candidates[j] as Candidate;
        if (n.at - c.at > PREP_MS) break;
        if (n.value >= PREP_RATIO * c.value) {
          preparation = true;
          break;
        }
      }
    }
    if (preparation) continue;
    if (CONTEXTUAL_MUTE) {
      // A mute removes energy and never adds any. A staccato stroke — picked
      // and damped within tens of milliseconds — also collapses, but its fine
      // envelope RISES first. So the collapse alone is not a mute; the
      // collapse with no rise at all in the 5ms envelope is.
      const before = rms20At(samples, sampleRate, c.at - 5);
      const after = rms20At(samples, sampleRate, c.at + 35);
      if (after < MUTE_RATIO * before) {
        const fineBefore = rmsAt(samples, sampleRate, c.at - 4, 5);
        let finePeak = 0;
        for (let ms = c.at + 2; ms <= c.at + 16; ms += 1) {
          finePeak = Math.max(finePeak, rmsAt(samples, sampleRate, ms, 5));
        }
        if (finePeak < 1.15 * fineBefore) continue;
      }
    }
    out.push(c);
  }
  return out;
}

let CONTEXTUAL = false;
let CONTEXTUAL_PREP = true;
let CONTEXTUAL_MUTE = true;

function pickPeaks(curve: Float64Array, times: Float64Array, threshold: number, sampleRate: number, samples?: Float32Array): Candidate[] {
  const out: Candidate[] = [];
  const deadHops = Math.round((DEAD_MS / 1000) * sampleRate / HOP);
  let last = -Infinity;
  for (let i = 0; i < curve.length; i++) {
    const v = curve[i] as number;
    if (v < threshold) continue;
    let isMax = true;
    for (let j = Math.max(0, i - PEAK_HALF_HOPS); j <= Math.min(curve.length - 1, i + PEAK_HALF_HOPS); j++) {
      if (j !== i && (curve[j] as number) > v) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    if (i - last < deadHops) continue;
    last = i;
    out.push({ at: times[i] as number, value: v });
  }
  return CONTEXTUAL && samples !== undefined ? contextualFilter(out, samples, sampleRate) : out;
}

/** RMS of the `windowMs` of signal ending at `ms`. */
function rmsAt(samples: Float32Array, sampleRate: number, ms: number, windowMs: number): number {
  const n = Math.round((sampleRate * windowMs) / 1000);
  const end = Math.min(samples.length, Math.round((ms / 1000) * sampleRate));
  const start = Math.max(0, end - n);
  let e = 0;
  for (let i = start; i < end; i++) e += (samples[i] as number) * (samples[i] as number);
  return Math.sqrt(e / Math.max(1, end - start));
}

/** 20ms RMS of the signal ending at `ms`. */
function rms20At(samples: Float32Array, sampleRate: number, ms: number): number {
  return rmsAt(samples, sampleRate, ms, 20);
}

type Score = {
  covered: number;
  offLabel: number;
  muteShaped: number;
  /** Signed candidate-minus-label offsets of the covering candidates. */
  offsets: number[];
  coveredIds: Set<number>;
};

function score(
  candidates: Candidate[],
  labels: Labels,
  samples: Float32Array,
  sampleRate: number
): Score {
  const first = (labels.onsets[0] as number) - PLAYED_PAD_MS;
  const last = (labels.ends[labels.ends.length - 1] as number) + PLAYED_PAD_MS;
  const coveredIds = new Set<number>();
  const offsets: number[] = [];
  const bestFor = new Map<number, number>();
  let offLabel = 0;
  let muteShaped = 0;
  for (const c of candidates) {
    if (c.at < first || c.at > last) continue;
    let nearest = -1;
    let nearestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < labels.onsets.length; i++) {
      const d = Math.abs(c.at - (labels.onsets[i] as number));
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    }
    if (nearest >= 0 && nearestDist <= WINDOW_MS) {
      const prior = bestFor.get(nearest);
      if (prior === undefined || nearestDist < prior) {
        bestFor.set(nearest, nearestDist);
      }
      coveredIds.add(nearest);
      continue;
    }
    offLabel++;
    const before = rms20At(samples, sampleRate, c.at - 10);
    const after = rms20At(samples, sampleRate, c.at + 50);
    if (after < before) muteShaped++;
  }
  for (const [i] of bestFor) {
    // Recover the signed offset of the nearest covering candidate.
    let best: Candidate | null = null;
    for (const c of candidates) {
      const d = Math.abs(c.at - (labels.onsets[i] as number));
      if (d <= WINDOW_MS && (best === null || d < Math.abs(best.at - (labels.onsets[i] as number)))) best = c;
    }
    if (best !== null) offsets.push(best.at - (labels.onsets[i] as number));
  }
  return { covered: coveredIds.size, offLabel, muteShaped, offsets, coveredIds };
}

function quantile(values: Float64Array, q: number): number {
  const sorted = Float64Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[idx] as number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1] as number;
}

type Operating = {
  threshold: number;
  score: Score;
};

/**
 * Sweep thresholds over the curve's own distribution inside the played span.
 * Returns the operating point with the most coverage (ties: fewest off-label)
 * and the best coverage reachable with zero off-label firings.
 */
function sweep(
  curve: Float64Array,
  times: Float64Array,
  labels: Labels,
  samples: Float32Array,
  sampleRate: number
): { best: Operating; clean: Operating | null; sweepRows: Array<{ threshold: number; covered: number; offLabel: number }> } {
  const first = (labels.onsets[0] as number) - PLAYED_PAD_MS;
  const last = (labels.ends[labels.ends.length - 1] as number) + PLAYED_PAD_MS;
  const inSpan: number[] = [];
  for (let i = 0; i < curve.length; i++) {
    const t = times[i] as number;
    if (t >= first && t <= last) inSpan.push(curve[i] as number);
  }
  const span = Float64Array.from(inSpan);
  const lo = quantile(span, 0.5);
  const hi = quantile(span, 0.9995);
  const steps = 120;
  let best: Operating | null = null;
  let clean: Operating | null = null;
  const sweepRows: Array<{ threshold: number; covered: number; offLabel: number }> = [];
  for (let s = 0; s <= steps; s++) {
    const threshold = lo + ((hi - lo) * s) / steps;
    const candidates = pickPeaks(curve, times, threshold, sampleRate, samples);
    const sc = score(candidates, labels, samples, sampleRate);
    sweepRows.push({ threshold, covered: sc.covered, offLabel: sc.offLabel });
    if (
      best === null ||
      sc.covered > best.score.covered ||
      (sc.covered === best.score.covered && sc.offLabel < best.score.offLabel)
    ) {
      best = { threshold, score: sc };
    }
    if (sc.offLabel === 0 && (clean === null || sc.covered > clean.score.covered)) {
      clean = { threshold, score: sc };
    }
  }
  return { best: best as Operating, clean, sweepRows };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

function main(): void {
  const args = process.argv.slice(2);
  const detail = args.includes("--detail");
  const all = args.includes("--all");
  const contextualArg = args.find((a) => a.startsWith("--contextual"));
  CONTEXTUAL = contextualArg !== undefined;
  if (CONTEXTUAL) {
    const mode = contextualArg?.split("=")[1] ?? "both";
    CONTEXTUAL_PREP = mode === "both" || mode === "prep";
    CONTEXTUAL_MUTE = mode === "both" || mode === "mute";
    console.log(
      `  --contextual=${mode}:` +
        (CONTEXTUAL_PREP ? ` reject when a >=${PREP_RATIO}x stronger candidate follows within ${PREP_MS}ms;` : "") +
        (CONTEXTUAL_MUTE ? ` reject when the 20ms envelope 35ms later is under ${MUTE_RATIO}x the one 5ms before;` : "")
    );
  }
  const fixedArg = args.find((a) => a.startsWith("--threshold="));
  const fixedThreshold = fixedArg === undefined ? null : Number(fixedArg.slice("--threshold=".length));
  const filter = args.find((a) => !a.startsWith("--"));
  const fixtures = decodeFixtures({ quiet: true }).filter((f) => {
    if (filter !== undefined) return f.stem.includes(filter);
    if (all) return true;
    return f.stem.includes("-di-");
  });

  const totals = new Map<string, { labels: number; covered: number; offLabel: number; cleanCovered: number }>();

  for (const fixture of fixtures) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const sampleRate = wav.sampleRate;
    const labels: Labels = {
      onsets: fixture.label.events.map((e) => e.startMs),
      ends: fixture.label.events.map((e) => e.endMs),
    };
    const times = hopTimesMs(mono.length, sampleRate);
    const hops = times.length;

    const flux = fluxFamily(mono, sampleRate, hops);
    const curves: Curve[] = [
      { name: "lin-flux/mag", values: flux.linRel },
      { name: "band-flux 1.5-6k", values: flux.band },
      { name: "log-flux", values: flux.log },
      { name: "superflux", values: flux.superflux },
      { name: "superflux-median", values: minusTrailingMedian(flux.superflux, 38) },
      { name: "dip-rebound dB", values: dipRebound(mono, sampleRate, hops) },
      { name: "hp1.5k env rise dB", values: highpassEnvelopeRise(mono, sampleRate, hops) },
      { name: "lpc16 residual dB", values: lpcResidual(mono, hops) },
    ];

    console.log(`\n  ${fixture.stem}  (${labels.onsets.length} labels)`);
    console.log(
      "    " +
        "function".padEnd(20) +
        "max cov".padStart(9) +
        "off-label".padStart(11) +
        "mute-shaped".padStart(13) +
        "offset med".padStart(12) +
        "cov @0 off".padStart(12) +
        "  threshold"
    );
    const missedByAll = new Set<number>(labels.onsets.map((_, i) => i));
    const perLabelPeak: Map<string, number[]> = new Map();
    for (const curve of curves) {
      let { best, clean } = sweep(curve.values, times, labels, mono, sampleRate);
      if (fixedThreshold !== null) {
        // One operating point for every take, instead of the take's own best.
        const candidates = pickPeaks(curve.values, times, fixedThreshold, sampleRate, mono);
        const sc = score(candidates, labels, mono, sampleRate);
        best = { threshold: fixedThreshold, score: sc };
        clean = sc.offLabel === 0 ? best : null;
      }
      for (const id of best.score.coveredIds) missedByAll.delete(id);
      const med = median(best.score.offsets);
      console.log(
        "    " +
          curve.name.padEnd(20) +
          `${best.score.covered}/${labels.onsets.length}`.padStart(9) +
          String(best.score.offLabel).padStart(11) +
          String(best.score.muteShaped).padStart(13) +
          (med === null ? "-" : `${med >= 0 ? "+" : ""}${med.toFixed(0)}ms`).padStart(12) +
          (clean === null ? "-" : `${clean.score.covered}/${labels.onsets.length}`).padStart(12) +
          `  ${best.threshold.toFixed(3)}`
      );
      const t = totals.get(curve.name) ?? { labels: 0, covered: 0, offLabel: 0, cleanCovered: 0 };
      t.labels += labels.onsets.length;
      t.covered += best.score.covered;
      t.offLabel += best.score.offLabel;
      t.cleanCovered += clean === null ? 0 : clean.score.covered;
      totals.set(curve.name, t);

      // Per-label peak of this function within the window, for the detail view.
      const peaks: number[] = [];
      for (let i = 0; i < labels.onsets.length; i++) {
        let peak = 0;
        for (let h = 0; h < hops; h++) {
          const d = (times[h] as number) - (labels.onsets[i] as number);
          if (d < -WINDOW_MS || d > WINDOW_MS) continue;
          if ((curve.values[h] as number) > peak) peak = curve.values[h] as number;
        }
        peaks.push(peak);
      }
      perLabelPeak.set(curve.name, peaks);
    }

    const wantCandidates = args.find((a) => a.startsWith("--candidates="))?.slice("--candidates=".length);
    if (wantCandidates !== undefined) {
      const curve = curves.find((c) => c.name.includes(wantCandidates));
      if (curve !== undefined) {
        const { best } = sweep(curve.values, times, labels, mono, sampleRate);
        const candidates = pickPeaks(curve.values, times, best.threshold, sampleRate, mono);
        console.log(`    candidates of ${curve.name} at threshold ${best.threshold.toFixed(3)}:`);
        const hpCurve = curves.find((c) => c.name.startsWith("hp1.5k"))?.values;
        for (const c of candidates) {
          let nearest = -1;
          let dist = Number.POSITIVE_INFINITY;
          for (let i = 0; i < labels.onsets.length; i++) {
            const d = Math.abs(c.at - (labels.onsets[i] as number));
            if (d < dist) {
              dist = d;
              nearest = i;
            }
          }
          const label = fixture.label.events[nearest];
          const signed = c.at - (labels.onsets[nearest] as number);
          const before = rms20At(mono, sampleRate, c.at - 10);
          const after = rms20At(mono, sampleRate, c.at + 50);
          const hop = Math.min(times.length - 1, Math.max(0, Math.round((c.at * sampleRate) / 1000 / HOP) - 1));
          const hp = hpCurve === undefined ? 0 : (hpCurve[hop] as number);
          const flag = dist <= WINDOW_MS ? "" : "   OFF-LABEL";
          console.log(
            `      ${c.at.toFixed(0).padStart(7)}ms  value ${c.value.toFixed(2).padStart(6)}  nearest ${(label?.id ?? "").padEnd(4)} ${signed >= 0 ? "+" : ""}${signed.toFixed(0).padStart(4)}ms` +
              `  rms20 ${before.toExponential(1)} -> ${after.toExponential(1)} (${(after / Math.max(before, 1e-9)).toFixed(2)}x)  hpRise ${hp.toFixed(1)}dB${flag}`
          );
        }
      }
    }

    if (detail) {
      console.log("    per label: peak of each function within ±30ms (and the take's best threshold)");
      for (let i = 0; i < labels.onsets.length; i++) {
        const event = fixture.label.events[i];
        const parts: string[] = [];
        for (const curve of curves) {
          const peaks = perLabelPeak.get(curve.name) as number[];
          parts.push(`${curve.name.split(" ")[0]}=${(peaks[i] as number).toFixed(2)}`);
        }
        const mark = missedByAll.has(i) ? "  <- reached by NO function" : "";
        console.log(`      ${(event?.id ?? "").padEnd(5)} @${String(event?.startMs ?? 0).padStart(6)}  ${parts.join("  ")}${mark}`);
      }
    } else if (missedByAll.size > 0) {
      console.log(
        `    reached by NO function at its best point: ${[...missedByAll]
          .map((i) => fixture.label.events[i]?.id ?? String(i))
          .join(", ")}`
      );
    }
  }

  console.log("\n  TOTAL over the takes above (best point per take, summed)");
  console.log(
    "    " + "function".padEnd(20) + "covered".padStart(10) + "off-label".padStart(11) + "cov @0 off".padStart(12)
  );
  for (const [name, t] of totals) {
    console.log(
      "    " +
        name.padEnd(20) +
        `${t.covered}/${t.labels}`.padStart(10) +
        String(t.offLabel).padStart(11) +
        `${t.cleanCovered}/${t.labels}`.padStart(12)
    );
  }
  console.log(
    `\n  covered = labelled onsets with a candidate within ±${WINDOW_MS}ms under nearest-label\n` +
      `  attribution; off-label = candidates inside the played span nearest to no label.\n` +
      `  Thresholds are chosen ON the take measured: these are ceilings, not results.`
  );
}

main();
