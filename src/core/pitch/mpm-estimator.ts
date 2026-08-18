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
 * Swept on the lead fixture, the shorter windows are not the trade they look
 * like. 1024 does buy frames — every note is longer than it, so nothing is
 * unseeable and the bench takes 703 frames instead of 617 — but it reads them
 * less decisively (mean agreement 70.3% against 75.2%, same 35/43 notes),
 * because a 21ms window of a plucked string is mostly attack and the NSDF of an
 * attack has no tall key maximum for the octave rule to work from. Longer than
 * 2048 the decay and vibrato inside one window start to smear the peaks: 3072
 * and 4096 lose notes (34/43 and 33/43) and buy a few tenths of a percent of
 * frames, out of a fifth fewer frames to begin with.
 */
const WINDOW = 2048;

/**
 * How close to the tallest key maximum a shorter-lag maximum must come before
 * it is preferred. McLeod & Wyvill give 0.8-0.9.
 *
 * This one constant IS the octave decision. Every multiple of a true period is
 * also a maximum of the NSDF and, because the NSDF has no length bias, they are
 * all about equally tall — so the true period is the shortest lag that comes
 * near the best, and `k` says how near. Lower it and a second-harmonic ridge on
 * a plucked string qualifies, so the note reads an octave high; raise it and a
 * fundamental that has decayed below its own harmonic stops qualifying, so the
 * note reads an octave low. Swept on the lead fixture at 2048: 0.80 -> 34/43
 * notes and 66.1% of frames, 0.85 -> 35/43 and 67.1%, 0.90 -> 35/43 and 69.0%,
 * 0.95 -> 35/43 and 69.2%. Flat enough not to be worth tuning further, and 0.90
 * is the top of the published range, which is where it is left: past it the
 * rule stops discriminating at all and only the tallest maximum can ever win.
 */
const PEAK_THRESHOLD = 0.9;

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
    // Two independent things have to be true for a reading to be the note, and
    // the NSDF height only speaks to one of them.
    //
    // It says whether the window is periodic at all: 1.0 is a segment repeating
    // itself exactly, 0.0 is noise. That is a clarity and not a probability,
    // but it is the same quantity YIN reports as `1 - cmnd`, which is what
    // makes the two numbers comparable at all.
    //
    // It says nothing about the OCTAVE — a second harmonic read as the
    // fundamental scores just as high, and on this fixture that is exactly what
    // happens to the low B, where the maxima stand at 0.977 (lag 196) and 0.997
    // (lag 391) and the true period is the longer one. What decided that frame
    // was not the height but the `k` tolerance, so the risk is measured by how
    // much of that tolerance the reading had to spend. Frames are split by it
    // on the lead fixture, over the notes that are not drowned out:
    //
    //     chosen maximum IS the tallest    495 frames   80% right   0% an octave high
    //     spent up to 2% of the tolerance   23 frames   57% right  35% an octave high
    //     spent 2-5%                        16 frames   44% right  38% an octave high
    //     spent more                         6 frames   17% right  33% an octave high
    //
    // Every octave error MPM makes is on the far side of that line, and none is
    // on the near side, so the multiplier is 1 when nothing was spent and falls
    // steeply -- as the square root, because the damage is done by the first
    // couple of percent -- to a coin flip when the whole band was.
    //
    // The mirror case counts the same way: a SHORTER-lag maximum that came
    // close to clearing the cutoff would have moved the estimate an octave UP,
    // so its distance below the cutoff is spent tolerance too. Both are divided
    // by the tallest maximum, so they mean the same thing at any signal level.
    let rivalBelow = 0;
    for (let i = 0; i < chosen; i++) if (peakValues[i]! > rivalBelow) rivalBelow = peakValues[i]!;
    const band = 1 - this.peakThreshold;
    const gap = Math.min((chosenValue - cutoff) / highest, (cutoff - rivalBelow) / highest);
    const spent = 1 - clamp01(gap / band);
    const settled = 1 - (1 - AMBIGUITY_FLOOR) * Math.sqrt(spent);

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
