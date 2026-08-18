/**
 * The McLeod Pitch Method, behind the shared estimator contract.
 *
 * MPM exists here because it is wrong in different places than YIN is. Both
 * look at the same lag axis, but YIN's cumulative mean normalisation divides by
 * a running sum that grows with the lag, which quietly rewards long lags, while
 * MPM's normalised square difference divides each lag by the energy of the two
 * segments that lag actually compares. That leaves n(tau) in [-1, 1] with no
 * length bias at all, and the octave is then decided by an explicit rule --
 * take the FIRST key maximum within `k` of the tallest -- rather than by a
 * threshold on a curve that was never flat to begin with.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports. `estimate()` is
 * allocation-free apart from the returned object the contract requires.
 */

import type { PitchEstimate, PitchEstimator, PitchEstimatorOptions } from "./estimator.js";

/**
 * Two periods of the lowest note, rounded up to a power of two — the same
 * window YIN runs, so the comparison is between the methods and not between
 * their integration times.
 *
 * Measured on the lead fixture, 1024 is not the trade it looks like: it sees
 * more of each short note but reads the sixteenths WORSE (28/43 against 34/43),
 * because half a window of a plucked string is mostly attack transient and the
 * NSDF of a transient has no tall key maximum to anchor the octave rule.
 */
const WINDOW = 2048;

/**
 * How close to the tallest key maximum a shorter-lag maximum must come before
 * it is preferred. McLeod & Wyvill give 0.8-0.9.
 *
 * This one constant IS the octave decision. Every multiple of a true period is
 * also a maximum of the NSDF and, because the NSDF has no length bias, they are
 * all about equally tall — so the true period is the shortest lag that comes
 * near the best, and `k` says how near. Below ~0.8 a second-harmonic ridge on a
 * plucked string qualifies and the note reads an octave high; above ~0.9 a
 * fundamental that has decayed below its own harmonic no longer qualifies and
 * the note reads an octave low. Swept on the lead fixture: 0.80 -> 32/43,
 * 0.85 -> 34/43, 0.90 -> 34/43, 0.95 -> 31/43.
 */
const PEAK_THRESHOLD = 0.87;

/**
 * NSDF height below which a frame is not called voiced.
 *
 * Deliberately low. The bench counts an unvoiced frame as a miss, and so does
 * fusion, so refusing to answer is only right where there is genuinely no
 * periodicity — room noise between notes, or the tail of a decayed string. A
 * weak but real peak is better reported with a small confidence.
 */
const MIN_CLARITY = 0.3;

/**
 * Confidence multiplier at a knife-edge octave decision.
 *
 * When the chosen key maximum sits exactly on `k * tallest`, an infinitesimal
 * change in the signal moves the estimate a whole octave, and there is nothing
 * in the NSDF that says which side is right. Half is the honest number for a
 * coin flip between two octaves; it must not be near 1, or fusion will believe
 * MPM precisely where MPM knows least.
 */
const AMBIGUITY_FLOOR = 0.5;

/**
 * Margin, in units of the tallest key maximum, at which the octave decision is
 * considered settled rather than knife-edge.
 *
 * The whole accept/reject band is only `1 - k` wide (0.13 here), so this has to
 * be a fraction of that band to discriminate at all.
 */
const AMBIGUITY_MARGIN = 0.08;

function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

export type MpmOptions = PitchEstimatorOptions & {
  /** Analysis window length in samples. Must be >= 2 periods of minFrequencyHz. */
  windowSize?: number;
  /** Fraction of the tallest key maximum a shorter lag must reach. 0.8-0.9. */
  peakThreshold?: number;
};

export class MpmEstimator implements PitchEstimator {
  readonly name = "mpm";
  readonly windowSize: number;
  readonly sampleRate: number;
  readonly peakThreshold: number;

  /** Smallest searched lag: `ceil(sampleRate / maxFrequencyHz)`, at least 2. */
  readonly minTau: number;
  /**
   * Largest searched lag. The NSDF is defined out to `windowSize - 1`, but the
   * overlap it averages over shrinks with the lag, so past half the window a
   * maximum is computed from a handful of samples and is mostly noise — and
   * noise near 1.0 is exactly what the `k` rule cannot survive. Clamping here
   * raises the lowest detectable frequency on a short window rather than
   * answering from a lag nothing supports.
   */
  readonly maxTau: number;

  /** n(tau) for 0..maxTau. Preallocated; never resized. */
  private readonly nsdf: Float64Array;
  /** Lags of the key maxima found this frame, ascending. */
  private readonly peakTaus: Int32Array;
  /** Their heights, parallel to `peakTaus`. */
  private readonly peakValues: Float64Array;
  /** Output of `interpolate`, as fields rather than a returned pair, so that
   * refining a peak does not allocate on every render quantum. */
  private refinedTau = 0;
  private refinedValue = 0;

  constructor(options: MpmOptions) {
    const { sampleRate, minFrequencyHz, maxFrequencyHz } = options;
    const windowSize = options.windowSize ?? WINDOW;

    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error(`MpmEstimator: sampleRate must be > 0, got ${sampleRate}`);
    }
    if (!Number.isInteger(windowSize) || windowSize < 4) {
      throw new Error(`MpmEstimator: windowSize must be an integer >= 4, got ${windowSize}`);
    }
    if (!(minFrequencyHz > 0) || !(maxFrequencyHz > minFrequencyHz)) {
      throw new Error(
        `MpmEstimator: require 0 < minFrequencyHz < maxFrequencyHz, got ` +
          `${minFrequencyHz}..${maxFrequencyHz}`
      );
    }

    this.sampleRate = sampleRate;
    this.windowSize = windowSize;
    this.peakThreshold = options.peakThreshold ?? PEAK_THRESHOLD;

    const halfWindow = windowSize >> 1;
    this.minTau = Math.max(2, Math.ceil(sampleRate / maxFrequencyHz));
    this.maxTau = Math.min(halfWindow - 1, Math.floor(sampleRate / minFrequencyHz));

    this.nsdf = new Float64Array(halfWindow);
    // A key maximum needs a positive run and the negative run that closes it,
    // so there can be no more than one per two lags.
    const capacity = (halfWindow >> 1) + 2;
    this.peakTaus = new Int32Array(capacity);
    this.peakValues = new Float64Array(capacity);
  }

  /** `window.length` must equal `windowSize`. */
  estimate(window: Float32Array): PitchEstimate {
    if (window.length !== this.windowSize) {
      throw new Error(
        `MpmEstimator.estimate: expected ${this.windowSize} samples, got ${window.length}`
      );
    }

    const { minTau, maxTau, nsdf, peakTaus, peakValues } = this;
    if (maxTau < minTau) return { frequencyHz: null, confidence: 0 };

    /* --- 1. Normalised square difference ----------------------------------- */
    // n(tau) = 2 * r(tau) / m(tau): the raw autocorrelation over the overlap,
    // divided by the energy of the two segments it compares. That divisor is
    // the whole point — it makes 1.0 mean "these two segments are the same
    // shape at any amplitude" for EVERY lag, so heights at different lags can
    // be compared directly, which the octave rule below depends on.
    const n = this.windowSize;
    let m = 0;
    for (let i = 0; i < n; i++) m += window[i]! * window[i]!;
    m *= 2;

    // Digital silence has no periodicity to normalise; every lag would be 0/0.
    if (!(m > 0)) return { frequencyHz: null, confidence: 0 };

    nsdf[0] = 1;
    for (let tau = 1; tau <= maxTau; tau++) {
      let r = 0;
      const limit = n - tau;
      for (let i = 0; i < limit; i++) r += window[i]! * window[i + tau]!;
      // m(tau) drops the two samples that fall out of the shrinking overlap,
      // which keeps the whole curve O(1) per lag instead of a second inner sum.
      m -= window[n - tau]! * window[n - tau]! + window[tau - 1]! * window[tau - 1]!;
      nsdf[tau] = m > 0 ? (2 * r) / m : 0;
    }

    /* --- 2. Key maxima: one per positive-going interval --------------------- */
    // Taking every local maximum would hand the octave rule the ripple that
    // sits on the flank of a real peak; taking one per zero-crossing interval
    // is what makes "the first tall one" mean "the first candidate period".
    let tau = 1;
    while (tau <= maxTau && nsdf[tau]! > 0) tau++; // walk off the peak at tau=0
    let count = 0;
    let runTau = -1;
    let runMax = 0;
    for (; tau <= maxTau; tau++) {
      const value = nsdf[tau]!;
      if (value > 0) {
        if (runTau < 0 || value > runMax) {
          runMax = value;
          runTau = tau;
        }
      } else if (runTau >= 0) {
        if (runTau >= minTau) {
          peakTaus[count] = runTau;
          peakValues[count] = runMax;
          count++;
        }
        runTau = -1;
      }
    }
    // A run still open at maxTau was cut off by the search bound, not by the
    // signal, so its maximum is only trustworthy if the curve had already
    // turned over before the bound.
    if (runTau >= minTau && runTau < maxTau) {
      peakTaus[count] = runTau;
      peakValues[count] = runMax;
      count++;
    }

    if (count === 0) return { frequencyHz: null, confidence: 0 };

    /* --- 3. Octave decision: the first key maximum within k of the best ----- */
    let highest = 0;
    for (let i = 0; i < count; i++) if (peakValues[i]! > highest) highest = peakValues[i]!;
    if (!(highest > 0)) return { frequencyHz: null, confidence: 0 };

    const cutoff = this.peakThreshold * highest;
    let chosen = 0;
    for (let i = 0; i < count; i++) {
      if (peakValues[i]! >= cutoff) {
        chosen = i;
        break;
      }
    }

    const chosenValue = peakValues[chosen]!;
    if (chosenValue < MIN_CLARITY) return { frequencyHz: null, confidence: 0 };

    /* --- 4. Sub-sample refinement ------------------------------------------ */
    this.interpolate(peakTaus[chosen]!);
    const clarity = clamp01(Math.max(chosenValue, this.refinedValue));

    /* --- 5. Confidence ------------------------------------------------------ */
    // Two independent things have to be true for a reading to be the note.
    //
    // The first is that the window is periodic at all, and the NSDF height says
    // so directly: 1.0 is a segment repeating itself exactly, 0.0 is noise.
    // That is a clarity, not a probability, but it is the same quantity YIN's
    // `1 - cmnd` reports, which is what makes the two comparable at all.
    //
    // The second is that the OCTAVE is right, and there the height says nothing
    // — a second harmonic read as the fundamental scores just as high. What
    // decides it is the `k` rule, so what measures the risk is how close that
    // rule came to going the other way. Two ways it can:
    //
    //   * the chosen maximum only just cleared `k * highest`, so a hair less
    //     and the estimate would have jumped to a longer lag (an octave down);
    //   * a SHORTER-lag maximum came close to clearing it, so a hair more and
    //     the estimate would have jumped up.
    //
    // Whichever is nearer the boundary is the fragility of this frame, and it
    // is scaled by `highest` so it means the same thing at any signal level.
    // At the boundary the method is choosing between two octaves with no
    // evidence, and the confidence has to say that.
    let rivalBelow = 0;
    for (let i = 0; i < chosen; i++) if (peakValues[i]! > rivalBelow) rivalBelow = peakValues[i]!;
    const marginAbove = (chosenValue - cutoff) / highest;
    const marginBelow = (cutoff - rivalBelow) / highest;
    const margin = Math.min(marginAbove, marginBelow);
    const settled =
      AMBIGUITY_FLOOR + (1 - AMBIGUITY_FLOOR) * clamp01(margin / AMBIGUITY_MARGIN);

    return { frequencyHz: this.sampleRate / this.refinedTau, confidence: clarity * settled };
  }

  /**
   * Parabolic interpolation of the NSDF maximum at integer lag `tau`, leaving
   * the fractional lag and the height at it in `refinedTau`/`refinedValue`.
   * Falls back to `tau` at the search boundaries or when the three points do
   * not describe a maximum.
   */
  private interpolate(tau: number): void {
    const { nsdf, maxTau } = this;
    this.refinedTau = tau;
    this.refinedValue = nsdf[tau]!;

    const left = tau - 1;
    const right = tau + 1;
    if (left < 1 || right > maxTau) return;

    const s0 = nsdf[left]!;
    const s1 = nsdf[tau]!;
    const s2 = nsdf[right]!;

    const curvature = 2 * s1 - s0 - s2;
    if (!(curvature > 0)) return;

    const shift = (s2 - s0) / (2 * curvature);
    if (!(shift > -1 && shift < 1)) return;

    this.refinedTau = tau + shift;
    this.refinedValue = s1 + 0.25 * (s2 - s0) * shift;
  }
}

export default function create(options: PitchEstimatorOptions): PitchEstimator {
  return new MpmEstimator(options);
}
