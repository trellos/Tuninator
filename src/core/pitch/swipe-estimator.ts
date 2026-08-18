/**
 * SWIPE' — Camacho & Harris, "A sawtooth waveform inspired pitch estimator for
 * speech and music", JASA 124(3), 2008 — behind the shared estimator contract.
 *
 * WHY IT IS WORTH HAVING ALONGSIDE YIN
 *
 * YIN compares the waveform with itself. When a note's second period is not
 * quite a copy of its first — a plucked string whose upper partials decay
 * faster than its fundamental, or two strings beating — the difference function
 * dips again at twice the lag and the reading falls an octave. That failure is
 * a property of the time domain, and no amount of thresholding removes it.
 *
 * SWIPE scores a candidate pitch by how well the observed spectrum matches the
 * spectrum of a sawtooth at that pitch. It fails the other way: a harmonic comb
 * laid over a harmonic series fits the sub-harmonics too, because every
 * harmonic of f0 is also a harmonic of f0/2. Three things in this method are
 * there to fight precisely that, and none of them is optional:
 *
 *   - SQUARE ROOT of the magnitude spectrum. The score is an inner product, and
 *     an inner product against raw magnitudes is dominated by whichever single
 *     partial happens to be loudest, so a candidate that explains one strong
 *     partial and nothing else outscores one that explains ten. Square-rooting
 *     compresses that range, which is what turns the inner product into
 *     something that behaves like a normalised correlation over the whole
 *     series rather than a vote by the loudest partial.
 *
 *   - FIRST AND PRIME harmonics only — the apostrophe in SWIPE'. The
 *     sub-harmonic f0/2 has harmonics at f0/2, f0, 3f0/2, 2f0, ... Every
 *     harmonic of f0 is in that set, so a full comb cannot separate them; the
 *     only evidence against f0/2 is the energy MISSING at its odd harmonics.
 *     Restricting to 1, 2, 3, 5, 7, 11, ... makes that evidence the whole
 *     score: the kernel of f0/2 places lobes at 3f0/2, 5f0/2, 7f0/2 — the
 *     half-integer multiples of f0, where a note at f0 puts nothing.
 *
 *   - NEGATIVE VALLEYS between the lobes, and a unit-norm kernel. The valleys
 *     charge a candidate for energy sitting BETWEEN its harmonics, which is
 *     what stops a dense chord or broadband noise from scoring well everywhere;
 *     the normalisation stops a low candidate — which fits more harmonics under
 *     the band limit, and so has more places to look — from winning on count.
 *
 * SHAPE
 *
 *   1. Hann window -> magnitude spectrum -> resampled onto an ERB-spaced
 *      frequency axis -> square root -> normalised to unit length.
 *   2. Inner product against one precomputed kernel per candidate pitch, on a
 *      log-spaced grid over the configured range.
 *   3. Parabolic interpolation of the winner in log-f0, which is what buys
 *      sub-semitone accuracy from a grid this coarse.
 *
 * DEPARTURES FROM THE PUBLISHED METHOD
 *
 * The paper computes each candidate's score from the window whose length is
 * about eight of its own periods, interpolating between two power-of-two window
 * sizes per candidate. That is the right thing for a method that has to cover
 * speech from 40Hz to 1kHz, and it is not available here: this contract fixes
 * one window size for the whole estimator, and the caller hands over exactly
 * that many samples. One window is used for every candidate, which costs
 * resolution at the bottom of the range.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports. Every buffer,
 * including the whole kernel bank, is allocated in the constructor.
 */

import { RealFFT, hannWindow } from "../fft.js";
import type { PitchEstimate, PitchEstimator, PitchEstimatorOptions } from "./estimator.js";

/**
 * 85ms at 48kHz.
 *
 * A spectral method wants a long window — at 2048 the bins are 23Hz apart and
 * the bottom of the range is a semitone wide — but the fixture's fastest notes
 * are ~110ms, and the bench cannot take a frame until the window lies wholly
 * inside the note, so 8192 would make a third of the material unseeable.
 * Measured on the lead fixture: 2048 reads 26/43 notes, 4096 reads 33.
 */
const WINDOW = 4096;

/**
 * Transform length. Zero-padding to twice the window costs one extra radix-2
 * stage and halves the bin spacing, which matters because the ERB axis below
 * ~1kHz is finer than the bins and would otherwise be interpolating straight
 * lines between them.
 */
const FFT_SIZE = 8192;

/** Candidate spacing. 24 = half a semitone of grid per parabolic fit. */
const CANDIDATES_PER_SEMITONE = 24;

/**
 * Spacing of the warped frequency axis, in ERB units. 0.1 is the paper's.
 *
 * The warp is what makes the inner product weight the spectrum the way hearing
 * does: an ERB-uniform axis is dense where partials are resolvable and sparse
 * up top, so the hundreds of bins above 3kHz — mostly pick noise and hiss —
 * cannot outvote the twenty bins that carry the fundamental.
 */
const ERB_STEP = 0.03;

/**
 * Top of the modelled band. Nyquist, i.e. no band limit — measured, not assumed.
 *
 * Capping it looked obviously right: above 5kHz a guitar has little partial
 * energy and plenty of hiss, the spectrum is normalised to unit length so that
 * hiss scales every real correlation down, and the kernel's cosine aliases on
 * the ERB axis once the grid step passes half a candidate's spacing. Every one
 * of those arguments is true and the cap still loses notes — 3kHz reads 30/43,
 * 5kHz 35, 8kHz 35, Nyquist 35 with the best frame agreement of the four. The
 * ERB warp already discounts the top of the spectrum by sampling it sparsely,
 * and what remains up there is the prime harmonics of the high candidates,
 * which are exactly the evidence that separates a note from its octave.
 */
const SPECTRUM_MAX_HZ = Infinity;

/** Bins below this are excluded outright: DC offset and rumble, never pitch. */
const SPECTRUM_MIN_HZ = 25;

/** Input RMS below this counts as silence. */
const SILENCE_RMS = 1e-6;

/**
 * Pitch strength that maps to zero confidence, and the one that maps to full
 * confidence before the ambiguity penalty.
 *
 * Strength is a unit-norm inner product, so it lives on a fixed scale whatever
 * the input level — but it is NOT an accuracy, and the two ends of the range
 * are the reason this needs calibrating rather than reporting raw. Measured
 * over the lead fixture's 488 interior frames, binned by strength: 0.14..0.26
 * reads the labelled note 30% of the time, 0.30..0.40 65%, and above 0.50 86%.
 * The band below C4 sits at a median 0.60 and is 82% right; above it the median
 * is 0.32 and it is 56% right, because a high note has fewer harmonics under
 * Nyquist for the kernel to find. So the ramp spans the range where the two
 * populations actually separate, and a low note reading 0.6 says so.
 */
const STRENGTH_FLOOR = 0.15;
const STRENGTH_CONFIDENT = 0.5;

/**
 * How far clear of its best rival the winner must stand before the ambiguity
 * penalty lifts, as a fraction of the winner's own strength.
 *
 * Two ramps because two failure modes, and the numbers are not guesses. When
 * the rival is an octave or a fifth away — SWIPE guessing between a note and
 * its own harmonic series, this method's blind spot — frames with a margin
 * under 0.3 are right 20% of the time and frames over 0.5 are right 81% of the
 * time. When the rival is at some unrelated interval, usually a second note
 * still ringing, the cliff is at a much smaller margin: under 0.1 is right 10%
 * of the time, over 0.1 is right 75%. Reporting a confident answer inside
 * either cliff is exactly what would poison a fusion of several estimators.
 */
const HARMONIC_TIE_MIN = 0.2;
const HARMONIC_TIE_CLEAR = 0.45;
const OTHER_TIE_MIN = 0.05;
const OTHER_TIE_CLEAR = 0.15;

/** Intervals at which a rival counts as the harmonic kind, in cents. */
const HARMONIC_INTERVALS_CENTS = [-2400, -1902, -1200, -702, 702, 1200, 1902, 2400];
/** Tolerance around those, in cents. Wide enough for a mistuned string. */
const HARMONIC_INTERVAL_TOLERANCE_CENTS = 60;

/** Below this the spectrum matched nothing; report no pitch rather than noise. */
const MIN_REPORTED_STRENGTH = 0.06;

export class SwipeEstimator implements PitchEstimator {
  readonly name = "swipe-prime";
  readonly windowSize = WINDOW;

  private readonly fft: RealFFT;
  private readonly hann: Float32Array;
  private readonly windowed: Float32Array;
  private readonly magnitude: Float32Array;

  /** Frequency of each point of the warped axis, ascending. */
  private readonly gridHz: Float64Array;
  /** Square-rooted, unit-normalised spectrum on that axis. */
  private readonly loudness: Float64Array;

  /*
   * Resampling of the magnitude spectrum onto the warped axis, and the kernel
   * bank, both in compressed-column form: point/candidate `k` occupies
   * `[start[k], start[k + 1])` of the paired index/weight arrays. The kernel
   * bank is ~1200 candidates over ~400 points and is mostly the gaps between
   * used harmonics, which dense storage would walk through on every frame.
   */
  private readonly resampleStart: Int32Array;
  private readonly resampleBin: Int32Array;
  private readonly resampleWeight: Float64Array;

  private readonly candidateHz: Float64Array;
  private readonly kernelStart: Int32Array;
  private readonly kernelPoint: Int32Array;
  private readonly kernelWeight: Float64Array;
  /** Pitch strength per candidate. */
  private readonly strength: Float64Array;
  /** Ratio between adjacent candidates, for the log-domain interpolation. */
  private readonly candidateRatio: number;

  constructor(options: PitchEstimatorOptions) {
    const { sampleRate, minFrequencyHz, maxFrequencyHz } = options;
    if (!(sampleRate > 0)) {
      throw new Error(`SwipeEstimator: sampleRate must be > 0, got ${sampleRate}`);
    }
    if (!(maxFrequencyHz > minFrequencyHz) || !(minFrequencyHz > 0)) {
      throw new Error(
        `SwipeEstimator: need 0 < minFrequencyHz < maxFrequencyHz, got ` +
          `${minFrequencyHz}..${maxFrequencyHz}`
      );
    }

    this.fft = new RealFFT(FFT_SIZE);
    this.hann = hannWindow(WINDOW);
    this.windowed = new Float32Array(FFT_SIZE);
    this.magnitude = new Float32Array(this.fft.bins);

    const binHz = sampleRate / FFT_SIZE;
    const nyquist = sampleRate / 2;

    /* --- Warped frequency axis --------------------------------------------- */
    // Starts a quarter of the lowest candidate, because that candidate's first
    // kernel lobe reaches down to 0.25 f0 and the axis has to carry it.
    const gridMinHz = Math.max(minFrequencyHz / 4, SPECTRUM_MIN_HZ);
    const gridMaxHz = Math.min(SPECTRUM_MAX_HZ, nyquist);
    const erbLo = erbsOf(gridMinHz);
    const erbHi = erbsOf(gridMaxHz);
    const points = Math.max(2, Math.floor((erbHi - erbLo) / ERB_STEP) + 1);
    this.gridHz = new Float64Array(points);
    for (let g = 0; g < points; g++) this.gridHz[g] = hzOfErbs(erbLo + g * ERB_STEP);
    this.loudness = new Float64Array(points);

    const resampled = buildResampler(this.gridHz, binHz, this.fft.bins);
    this.resampleStart = resampled.start;
    this.resampleBin = resampled.bin;
    this.resampleWeight = resampled.weight;

    /* --- Candidate grid and kernel bank ------------------------------------ */
    const semitones = 12 * Math.log2(maxFrequencyHz / minFrequencyHz);
    const count = Math.max(3, Math.round(semitones * CANDIDATES_PER_SEMITONE) + 1);
    this.candidateRatio = Math.pow(2, 1 / (12 * CANDIDATES_PER_SEMITONE));
    this.candidateHz = new Float64Array(count);
    for (let c = 0; c < count; c++) {
      this.candidateHz[c] = minFrequencyHz * Math.pow(this.candidateRatio, c);
    }
    this.strength = new Float64Array(count);

    const bank = buildKernelBank(this.candidateHz, this.gridHz);
    this.kernelStart = bank.start;
    this.kernelPoint = bank.point;
    this.kernelWeight = bank.weight;
  }

  estimate(window: Float32Array): PitchEstimate {
    if (window.length !== WINDOW) {
      throw new Error(`SwipeEstimator.estimate: expected ${WINDOW} samples, got ${window.length}`);
    }

    let sumSquares = 0;
    for (let i = 0; i < WINDOW; i++) {
      const s = window[i]!;
      sumSquares += s * s;
      this.windowed[i] = s * this.hann[i]!;
    }
    // The zero-padding tail is never written, so it stays zero from allocation.
    if (!(Math.sqrt(sumSquares / WINDOW) > SILENCE_RMS)) return SILENT;

    this.fft.magnitudes(this.windowed, this.magnitude);
    if (!this.buildLoudness()) return SILENT;

    return this.score();
  }

  /* ------------------------------------------------------------------ */

  /**
   * Resamples, square-roots and normalises the spectrum. False when the
   * modelled band holds no energy at all.
   *
   * The unit-length normalisation is what makes the pitch strength comparable
   * between frames — and so between estimators. Both vectors in the inner
   * product have norm one, so the score is a cosine similarity: it cannot be
   * raised by playing louder, only by the spectrum looking more like a sawtooth
   * at that pitch.
   */
  private buildLoudness(): boolean {
    const start = this.resampleStart;
    const bin = this.resampleBin;
    const weight = this.resampleWeight;
    const loudness = this.loudness;
    const magnitude = this.magnitude;

    let norm = 0;
    for (let g = 0; g < loudness.length; g++) {
      let sum = 0;
      for (let e = start[g]!; e < start[g + 1]!; e++) sum += weight[e]! * magnitude[bin[e]!]!;
      const value = sum > 0 ? Math.sqrt(sum) : 0;
      loudness[g] = value;
      norm += value * value;
    }
    if (!(norm > 0)) return false;

    const scale = 1 / Math.sqrt(norm);
    for (let g = 0; g < loudness.length; g++) loudness[g] = loudness[g]! * scale;
    return true;
  }

  /** Correlates every kernel, then interprets the winner. */
  private score(): PitchEstimate {
    const start = this.kernelStart;
    const point = this.kernelPoint;
    const weight = this.kernelWeight;
    const loudness = this.loudness;
    const strength = this.strength;
    const count = strength.length;

    let best = -Infinity;
    let bestIndex = 0;
    for (let c = 0; c < count; c++) {
      let dot = 0;
      for (let e = start[c]!; e < start[c + 1]!; e++) dot += weight[e]! * loudness[point[e]!]!;
      strength[c] = dot;
      if (dot > best) {
        best = dot;
        bestIndex = c;
      }
    }
    if (!(best > MIN_REPORTED_STRENGTH)) return SILENT;

    /* --- Sub-semitone refinement ------------------------------------------- */
    // In log-f0, because the candidates are log-spaced: the parabola is fitted
    // over indices and the offset is applied as a ratio, so the same fit is as
    // accurate at 1400Hz as at 70Hz.
    let delta = 0;
    if (bestIndex > 0 && bestIndex < count - 1) {
      const a = strength[bestIndex - 1]!;
      const b = strength[bestIndex]!;
      const c = strength[bestIndex + 1]!;
      const denominator = a - 2 * b + c;
      if (denominator < 0) {
        const d = (0.5 * (a - c)) / denominator;
        if (d > -1 && d < 1) delta = d;
      }
    }
    const frequencyHz = this.candidateHz[bestIndex]! * Math.pow(this.candidateRatio, delta);

    /* --- The best rival OUTSIDE the winner's own peak ----------------------- */
    // Two exclusions, and both are needed. Walking downhill finds where the
    // curve turns back up, which is where a second explanation of the frame
    // begins; but on a grid this fine the curve wobbles by a thousandth right
    // beside the peak, and taking that wobble for a rival reported near-zero
    // confidence on 107 of 488 frames that were 78% correct. A candidate under
    // a semitone away is the same note by any reading, so it is never a rival.
    const ownPeakHalfWidth = CANDIDATES_PER_SEMITONE;
    let lo = bestIndex;
    while (lo > 0 && strength[lo - 1]! <= strength[lo]!) lo--;
    lo = Math.min(lo, bestIndex - ownPeakHalfWidth);
    let hi = bestIndex;
    while (hi < count - 1 && strength[hi + 1]! <= strength[hi]!) hi++;
    hi = Math.max(hi, bestIndex + ownPeakHalfWidth);

    let rival = 0;
    let rivalIndex = -1;
    for (let c = 0; c < count; c++) {
      if (c >= lo && c <= hi) continue;
      if (strength[c]! > rival) {
        rival = strength[c]!;
        rivalIndex = c;
      }
    }

    return { frequencyHz, confidence: this.confidenceOf(best, rival, bestIndex, rivalIndex) };
  }

  /**
   * Maps pitch strength onto the contract's 0..1 scale.
   *
   * The raw inner product is not a probability and must not be reported as one.
   * It is a cosine similarity between a real spectrum and an idealised sawtooth,
   * so even a clean, correctly identified guitar note only reaches about 0.4 —
   * the rest is inharmonicity, the pick, and the room. Reporting 0.4 as 0.4
   * would understate a reading that is certainly right; reporting the argmax as
   * 0.99 would overstate every one of them. So strength is mapped through the
   * band where correct and incorrect readings actually separate on this
   * material, and then cut by how close the runner-up came.
   *
   * The cut is the honest part. SWIPE's characteristic error is naming a note's
   * octave or its fifth, and when it does, the two candidates score within a
   * few percent of each other: the frame genuinely does not distinguish them.
   * A fused estimator needs that stated, not hidden behind the argmax.
   */
  private confidenceOf(best: number, rival: number, bestIndex: number, rivalIndex: number): number {
    // DEBUG
    (this as unknown as Record<string, number>).dbgBest = best;
    (this as unknown as Record<string, number>).dbgRival = rival;
    (this as unknown as Record<string, number>).dbgCents =
      rivalIndex < 0 ? 0 : 1200 * Math.log2(this.candidateHz[rivalIndex]! / this.candidateHz[bestIndex]!);
    const level = clamp01((best - STRENGTH_FLOOR) / (STRENGTH_CONFIDENT - STRENGTH_FLOOR));
    if (level <= 0 || rivalIndex < 0 || rival <= 0) return level;

    const cents =
      1200 * Math.log2(this.candidateHz[rivalIndex]! / this.candidateHz[bestIndex]!);
    let harmonic = false;
    for (const interval of HARMONIC_INTERVALS_CENTS) {
      if (Math.abs(cents - interval) <= HARMONIC_INTERVAL_TOLERANCE_CENTS) {
        harmonic = true;
        break;
      }
    }

    const margin = 1 - rival / best;
    const min = harmonic ? HARMONIC_TIE_MIN : OTHER_TIE_MIN;
    const clear = harmonic ? HARMONIC_TIE_CLEAR : OTHER_TIE_CLEAR;
    return level * clamp01((margin - min) / (clear - min));
  }
}

export default function create(options: PitchEstimatorOptions): PitchEstimator {
  return new SwipeEstimator(options);
}

/* -------------------------------------------------------------------------- */

/** Frozen because `estimate()` must not allocate, and nobody may mutate it. */
const SILENT: PitchEstimate = Object.freeze({ frequencyHz: null, confidence: 0 });

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Glasberg & Moore's ERB-rate scale. */
function erbsOf(hz: number): number {
  return 21.4 * Math.log10(1 + hz / 229);
}
function hzOfErbs(erbs: number): number {
  return 229 * (Math.pow(10, erbs / 21.4) - 1);
}

/**
 * Weights that take the magnitude spectrum onto the warped axis.
 *
 * Two regimes, because the ERB axis crosses the bin spacing partway up. Below
 * that crossing a grid point falls between bins and is interpolated; above it a
 * grid point spans several bins and averages them, which is a resampling rather
 * than a sample. Point-sampling the whole axis would be cheaper and wrong: at
 * 5kHz one grid point covers five bins, so a harmonic landing in a bin the grid
 * happens not to sit on would simply not be seen.
 */
function buildResampler(
  gridHz: Float64Array,
  binHz: number,
  bins: number
): { start: Int32Array; bin: Int32Array; weight: Float64Array } {
  const points = gridHz.length;
  const start = new Int32Array(points + 1);
  const bin: number[] = [];
  const weight: number[] = [];
  const minBin = Math.max(1, Math.floor(SPECTRUM_MIN_HZ / binHz));

  for (let g = 0; g < points; g++) {
    start[g] = bin.length;
    const hz = gridHz[g]!;
    const below = g > 0 ? gridHz[g - 1]! : hz;
    const above = g < points - 1 ? gridHz[g + 1]! : hz;
    const loHz = (hz + below) / 2;
    const hiHz = (hz + above) / 2;

    const first = Math.ceil(loHz / binHz);
    const last = Math.floor(hiHz / binHz);
    if (last >= first && hiHz - loHz > binHz) {
      const share = 1 / (last - first + 1);
      for (let b = first; b <= last; b++) {
        if (b < minBin || b >= bins) continue;
        bin.push(b);
        weight.push(share);
      }
      continue;
    }

    const exact = hz / binHz;
    const low = Math.floor(exact);
    const fraction = exact - low;
    if (low >= minBin && low < bins) {
      bin.push(low);
      weight.push(1 - fraction);
    }
    if (low + 1 >= minBin && low + 1 < bins) {
      bin.push(low + 1);
      weight.push(fraction);
    }
  }
  start[points] = bin.length;

  return { start, bin: Int32Array.from(bin), weight: Float64Array.from(weight) };
}

/**
 * One kernel per candidate: a cosine lobe on the first and prime harmonics,
 * half-amplitude negative cosine in the valleys between them, tapered by
 * `1/sqrt(f)` because a sawtooth's partials fall as `1/h` and the spectrum has
 * been square-rooted.
 *
 * Normalised by the norm of its POSITIVE part alone, which is Camacho's and is
 * not the same as normalising the whole kernel: the valleys are a penalty, and
 * a candidate whose valleys happen to be wide should not have its penalty
 * shrunk by the very normalisation that is supposed to equalise its reach.
 */
function buildKernelBank(
  candidateHz: Float64Array,
  gridHz: Float64Array
): { start: Int32Array; point: Int32Array; weight: Float64Array } {
  const count = candidateHz.length;
  const points = gridHz.length;
  const start = new Int32Array(count + 1);
  const point: number[] = [];
  const weight: number[] = [];

  const kernel = new Float64Array(points);
  const topHz = gridHz[points - 1]!;

  for (let c = 0; c < count; c++) {
    start[c] = point.length;
    const f0 = candidateHz[c]!;
    kernel.fill(0);

    // The kernel of a candidate is only ever consulted where a harmonic it uses
    // could sit, so the harmonic list stops at the top of the modelled band.
    const maxHarmonic = Math.floor(topHz / f0 - 0.75);
    for (let h = 1; h <= maxHarmonic; h++) {
      if (h > 1 && !isPrime(h)) continue;
      const loHz = (h - 0.75) * f0;
      const hiHz = (h + 0.75) * f0;
      for (let g = 0; g < points; g++) {
        const hz = gridHz[g]!;
        if (hz < loHz) continue;
        if (hz > hiHz) break;
        const q = hz / f0;
        const distance = Math.abs(q - h);
        const lobe = Math.cos(2 * Math.PI * q);
        // Regions of different harmonics never overlap — each covers exactly
        // 1.5 periods — so accumulating and assigning are the same thing here.
        kernel[g] = kernel[g]! + (distance < 0.25 ? lobe : lobe / 2);
      }
    }

    let norm = 0;
    for (let g = 0; g < points; g++) {
      const value = kernel[g]!;
      if (value === 0) continue;
      const tapered = value / Math.sqrt(gridHz[g]!);
      kernel[g] = tapered;
      if (tapered > 0) norm += tapered * tapered;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let g = 0; g < points; g++) {
        const value = kernel[g]!;
        if (value === 0) continue;
        point.push(g);
        weight.push(value / norm);
      }
    }
  }
  start[count] = point.length;

  return { start, point: Int32Array.from(point), weight: Float64Array.from(weight) };
}

function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let d = 3; d * d <= n; d += 2) {
    if (n % d === 0) return false;
  }
  return true;
}
