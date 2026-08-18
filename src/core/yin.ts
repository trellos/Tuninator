/**
 * YIN pitch detection with guitar-specific octave-error mitigation.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the DSP-core
 * workstream.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports. `detect()` must be
 * allocation-free: every buffer is preallocated in the constructor.
 */

export type YinOptions = {
  sampleRate: number;
  /** Analysis window length in samples. Must be >= 2 periods of minFrequencyHz. */
  windowSize: number;
  minFrequencyHz: number;
  maxFrequencyHz: number;
  /** Absolute threshold on the CMND curve. Typically 0.10-0.15. */
  threshold?: number;
};

export type YinResult = {
  /** Null when no periodicity was found within the frequency bounds. */
  frequencyHz: number | null;
  /** 0..1, derived as `1 - cmnd[tau]`. */
  confidence: number;
  /** Chosen lag in samples, or null. */
  tau: number | null;
  /** CMND value at `tau`, or null. */
  cmnd: number | null;
};

/** Default absolute threshold on the CMND curve (matches `policy.pitch.yinThreshold`). */
const DEFAULT_THRESHOLD = 0.13;


/**
 * How much better a longer lag must fit before it is preferred. See step 4b.
 *
 * A ratio, not a difference, and well below 1: the whole safety of the rule is
 * that a near-tie changes nothing. On a genuinely periodic signal every
 * multiple of the true period fits about as well as the period itself, so only
 * a decisive improvement can mean the shorter lag was a harmonic.
 */
/**
 * Octave relatives of the accepted lag that are examined. Negative entries are
 * divisors: -2 is tau/2, one octave up.
 */
const OCTAVE_FAMILY: readonly number[] = [-2, 2, 3, 4];

/**
 * How much worse than the best octave relative a lag may fit and still be
 * preferred for being shorter.
 *
 * Above 1, and not by much. Every multiple of a true period fits a periodic
 * signal about equally well, so a generous tolerance is what lets the SHORTEST
 * such lag -- the actual period -- win. Too generous and a genuinely weak
 * higher-frequency dip starts to qualify.
 */
const OCTAVE_TOLERANCE = 2.5;

/**
 * A difference at or below this fraction of the mean counts as "already a
 * period", whatever fits better.
 *
 * The ratio alone cannot decide this. Both a clean tone and a tone whose true
 * period is twice the accepted lag show the longer lag fitting better; what
 * separates them is whether the SHORTER lag was ever a good fit to begin with.
 * This is the bar for "good enough to be the period", and being relative to the
 * frame's own mean difference it means the same thing at any level.
 */
const OCTAVE_PERIODIC_DIFF = 0.015;

/** Lag at which `OCTAVE_PERIODIC_DIFF` is taken literally. ~113Hz at 44.1kHz. */
const OCTAVE_FLOOR_REFERENCE_TAU = 200;

/** Ceiling on the scaled floor, so a very short lag is not accepted outright. */
const OCTAVE_FLOOR_MAX = 0.25;

/** Search bracket around a relative, as a fraction of it. */
const OCTAVE_BRACKET = 0.04;

/**
 * Periods of a candidate lag the integration window must contain before that
 * lag's fit is worth comparing.
 *
 * YIN integrates over half the window, so a lag near that limit is measured
 * from a couple of repetitions and its difference is mostly noise. Believing
 * such a number is how a clean 988Hz tone read as 494Hz through the short
 * 384-sample window: two periods of the doubled lag fitted "better" by accident.
 */
const OCTAVE_MIN_PERIODS = 1.8;


/**
 * Zero-crossing hysteresis, as a fraction of the window's DC-removed RMS.
 * A Schmitt trigger at +/- this level is what stops harmonic ripple and DC
 * drift from multiplying the crossing count.
 */
const ZC_HYSTERESIS = 0.2;

function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

export class YinDetector {
  readonly sampleRate: number;
  readonly windowSize: number;
  readonly minFrequencyHz: number;
  readonly maxFrequencyHz: number;
  readonly threshold: number;

  /** Smallest searched lag: `ceil(sampleRate / maxFrequencyHz)`, at least 2. */
  readonly minTau: number;
  /**
   * Largest searched lag: `floor(sampleRate / minFrequencyHz)`, clamped to the
   * longest lag the window can support. A window shorter than two periods of
   * `minFrequencyHz` therefore raises the lowest detectable frequency instead
   * of throwing — the engine legitimately runs a short window at a high
   * `shortWindowMinHz`.
   */
  readonly maxTau: number;

  /** Squared-difference function d(tau). Preallocated; never resized. */
  private readonly diff: Float64Array;
  /** Cumulative mean normalised difference d'(tau). Preallocated. */
  private readonly cmnd: Float64Array;
  /** Prefix sums of sample energy, for the octave comparison. */
  private readonly energyPrefix: Float64Array;
  /** Scratch for the octave family, so `detect()` stays allocation-free. */
  private readonly octaveTaus: Int32Array;
  private readonly octaveCmnds: Float64Array;

  constructor(options: YinOptions) {
    const { sampleRate, windowSize, minFrequencyHz, maxFrequencyHz } = options;

    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error(`YinDetector: sampleRate must be > 0, got ${sampleRate}`);
    }
    if (!Number.isInteger(windowSize) || windowSize < 4) {
      throw new Error(`YinDetector: windowSize must be an integer >= 4, got ${windowSize}`);
    }
    if (!(minFrequencyHz > 0) || !(maxFrequencyHz > minFrequencyHz)) {
      throw new Error(
        `YinDetector: require 0 < minFrequencyHz < maxFrequencyHz, got ` +
          `${minFrequencyHz}..${maxFrequencyHz}`
      );
    }

    this.sampleRate = sampleRate;
    this.windowSize = windowSize;
    this.minFrequencyHz = minFrequencyHz;
    this.maxFrequencyHz = maxFrequencyHz;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;

    // Textbook YIN integrates over half the window, so lags are bounded by it.
    const halfWindow = windowSize >> 1;
    this.minTau = Math.max(2, Math.ceil(sampleRate / maxFrequencyHz));
    this.maxTau = Math.min(halfWindow - 1, Math.floor(sampleRate / minFrequencyHz));

    this.diff = new Float64Array(halfWindow);
    this.cmnd = new Float64Array(halfWindow);
    this.energyPrefix = new Float64Array(windowSize + 1);
    this.octaveTaus = new Int32Array(OCTAVE_FAMILY.length);
    this.octaveCmnds = new Float64Array(OCTAVE_FAMILY.length);
  }

  /**
   * `window.length` must equal `windowSize`.
   *
   * Allocation-free apart from the returned `YinResult`, which the fixed
   * signature requires. Every buffer is preallocated in the constructor; a
   * shared, mutated result object was rejected deliberately, because a caller
   * that holds on to one frame's result would silently see the next frame's.
   */
  detect(window: Float32Array): YinResult {
    if (window.length !== this.windowSize) {
      throw new Error(
        `YinDetector.detect: expected ${this.windowSize} samples, got ${window.length}`
      );
    }

    const { minTau, maxTau, threshold, diff, cmnd } = this;
    if (maxTau < minTau) {
      return { frequencyHz: null, confidence: 0, tau: null, cmnd: null };
    }

    const integration = this.windowSize >> 1;

    /* --- 1. Squared difference function ------------------------------------ */
    diff[0] = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      let sum = 0;
      for (let i = 0; i < integration; i++) {
        const delta = window[i]! - window[i + tau]!;
        sum += delta * delta;
      }
      diff[tau] = sum;
    }

    /* --- 1b. Prefix sums of energy, for the octave comparison -------------- */
    // `diff[tau]` alone measures how far apart two segments are in absolute
    // terms, which conflates "different shape" with "different loudness" and
    // with "fewer periods fitted in the window". Dividing by the energy of the
    // two segments being compared removes both: the result is 0 for a perfect
    // match at any level, and 1 for no relationship, whatever the lag.
    const energy = this.energyPrefix;
    energy[0] = 0;
    for (let i = 0; i < this.windowSize; i++) {
      energy[i + 1] = energy[i]! + window[i]! * window[i]!;
    }

    /* --- 2. Cumulative mean normalised difference -------------------------- */
    cmnd[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      runningSum += diff[tau]!;
      cmnd[tau] = runningSum > 0 ? (diff[tau]! * tau) / runningSum : 1;
    }

    // Digital silence (or any perfectly constant window) has no periodicity at
    // all: every difference is zero, so there is nothing to interpolate.
    if (!(runningSum > 0)) {
      return { frequencyHz: null, confidence: 0, tau: null, cmnd: null };
    }

    /* --- 3. Absolute threshold: FIRST dip, not the global minimum ---------- */
    let tau = -1;
    for (let t = minTau; t <= maxTau; t++) {
      if (cmnd[t]! < threshold) {
        // Walk down to the bottom of this dip rather than stopping on its edge.
        while (t + 1 <= maxTau && cmnd[t + 1]! < cmnd[t]!) t++;
        tau = t;
        break;
      }
    }

    const crossedThreshold = tau >= 0;

    if (!crossedThreshold) {
      /* --- 4. Fallback: global minimum, proportionally lower confidence ---- */
      let bestTau = minTau;
      let bestCmnd = cmnd[minTau]!;
      for (let t = minTau + 1; t <= maxTau; t++) {
        const v = cmnd[t]!;
        if (v < bestCmnd) {
          bestCmnd = v;
          bestTau = t;
        }
      }

      if (!(bestCmnd < 1)) {
        return { frequencyHz: null, confidence: 0, tau: null, cmnd: null };
      }

      const refinedTau = this.interpolate(bestTau);
      // Scale confidence by how far past the threshold the CMND sits, so a
      // barely-missed dip stays usable while noise collapses to ~0.
      const penalty = Math.min(1, threshold / bestCmnd);
      return {
        frequencyHz: this.sampleRate / refinedTau,
        confidence: clamp01(1 - bestCmnd) * penalty,
        tau: refinedTau,
        cmnd: bestCmnd,
      };
    }

    /* --- 5. Octave resolution ---------------------------------------------- */
    // One decision about which octave, made once.
    //
    // Two rules used to make it, in opposite directions, and they fought. The
    // absolute threshold takes the FIRST lag under it, which biases high: when
    // a string's second harmonic is stronger than its fundamental the dip at
    // T/2 clears the threshold too, and being first it wins. A separate
    // sub-harmonic guard then pushed the estimate UP again whenever the half
    // lag was any good at all -- and its test, "the half lag is itself under
    // the threshold", is satisfied by almost every accepted dip, so it fired
    // constantly. Measured on the lead fixture's low B at 4200ms:
    //
    //     tau=195  246.2Hz  B3  cmnd=0.0174   <- accepted, being first
    //     tau=391  122.8Hz  B2  cmnd=0.0024   <- seven times better
    //
    // The evidence for B2 is overwhelming, and no amount of tuning either rule
    // reached it, because each undid the other.
    //
    // The single rule: among the octave relatives of the accepted lag, find the
    // best fit, then take the SHORTEST lag that fits nearly as well. Shortest
    // because every multiple of a true period also fits a periodic signal, so
    // the true period is the smallest lag that does -- which is the same
    // principle the absolute threshold is reaching for, applied to the octave
    // family instead of to the whole curve. On the B2 above, only 391 comes
    // near the best, so the estimate moves. On the A3 at 7400ms, where YIN was
    // already right, 219 and all its multiples fit within tolerance and the
    // shortest of them is 219, so nothing moves.
    if (crossedThreshold) {
      const halfWindow = this.windowSize >> 1;
      const baseEnergy = energy[halfWindow]!;
      /**
       * `diff[tau]` divided by the energy of the two segments it compares.
       * 0 is a perfect match at any amplitude; 1 is no relationship.
       */
      const rawFit = (t: number): number => {
        const lagEnergy = energy[t + halfWindow]! - energy[t]!;
        const total = baseEnergy + lagEnergy;
        return total > 0 ? diff[t]! / total : 1;
      };

      /**
       * The fit at the true, sub-sample lag rather than at the nearest integer.
       *
       * Lags are whole samples and periods are not, and the rounding error
       * costs a SHORT lag proportionally more than a long one: a 1318Hz tone
       * has a period of 36.4 samples, so lag 36 is 0.4 samples wrong while its
       * double, 73, is only 0.2 wrong. Measured on a clean synthetic sawtooth
       * that alone made the doubled lag fit four times better -- 4.4e-3 against
       * 2.0e-2 -- and an octave comparison reading those integers dropped a
       * correct 1318Hz reading to 659Hz. Interpolating the minimum removes the
       * artefact, which is the same reason the final estimate is interpolated.
       */
      const fitAt = (t: number): number => {
        const here = rawFit(t);
        if (t <= minTau || t >= maxTau) return here;
        const before = rawFit(t - 1);
        const after = rawFit(t + 1);
        const curvature = before - 2 * here + after;
        if (!(curvature > 0)) return here;
        const shift = (before - after) / (2 * curvature);
        if (!(shift > -1) || !(shift < 1)) return here;
        return Math.max(0, here - 0.25 * (before - after) * shift);
      };
      // Compared on the RAW difference function, not on the CMND.
      //
      // `cmnd[tau] = diff[tau] * tau / sum(diff[1..tau])`, and that denominator
      // grows with tau, so the CMND of a perfectly periodic signal keeps
      // falling as the lag lengthens. Comparing octaves by CMND therefore
      // rewards the longer lag for being longer -- on a clean synthetic B3 the
      // fit reads 1e-5 at T and 1e-6 at 2T, and a rule reading those numbers
      // drops a correct note an octave. The difference function carries no such
      // bias: for a true period every multiple reads about the same, and only a
      // lag that is NOT a period reads high.
      let bestDiff = fitAt(tau);
      let count = 0;
      for (const multiple of OCTAVE_FAMILY) {
        const target = multiple > 0 ? tau * multiple : Math.round(tau / -multiple);
        if (target < minTau || target > maxTau) continue;
        if (halfWindow / target < OCTAVE_MIN_PERIODS) continue;
        // A period estimate is a few samples uncertain and the error grows with
        // the multiple, so search a proportional bracket for the actual dip.
        const slack = Math.max(1, Math.round(target * OCTAVE_BRACKET));
        let candidate = -1;
        let candidateDiff = Infinity;
        for (let t = Math.max(minTau, target - slack); t <= Math.min(maxTau, target + slack); t++) {
          const value = fitAt(t);
          if (value < candidateDiff) {
            candidateDiff = value;
            candidate = t;
          }
        }
        if (candidate < 0) continue;
        this.octaveTaus[count] = candidate;
        this.octaveCmnds[count] = candidateDiff;
        count++;
        if (candidateDiff < bestDiff) bestDiff = candidateDiff;
      }

      // The "already a period" bar, scaled to the lag it is judging.
      //
      // Lags are whole samples, so every fit carries a rounding error of up to
      // half a sample -- and half a sample is 1.5% of a 33-sample period but
      // 0.13% of a 391-sample one. The fit degrades with the square of that
      // relative error, so a single fixed bar cannot serve both ends of the
      // range: set for the low strings it declares every high note aperiodic,
      // and set for the high notes it never fires at all. Scaling it the way
      // the artefact scales lets one constant mean the same thing everywhere.
      const relative = OCTAVE_FLOOR_REFERENCE_TAU / tau;
      const floor = Math.min(OCTAVE_PERIODIC_DIFF * relative * relative, OCTAVE_FLOOR_MAX);
      const acceptable = Math.max(bestDiff * OCTAVE_TOLERANCE, floor);
      let chosen = fitAt(tau) <= acceptable ? tau : Number.MAX_SAFE_INTEGER;
      for (let i = 0; i < count; i++) {
        if (this.octaveCmnds[i]! <= acceptable && this.octaveTaus[i]! < chosen) {
          chosen = this.octaveTaus[i]!;
        }
      }
      if (chosen !== Number.MAX_SAFE_INTEGER) tau = chosen;
    }

    /* --- 6. Parabolic interpolation ---------------------------------------- */
    const refinedTau = this.interpolate(tau);
    const cmndAtTau = cmnd[tau]!;

    return {
      frequencyHz: this.sampleRate / refinedTau,
      confidence: clamp01(1 - cmndAtTau),
      tau: refinedTau,
      cmnd: cmndAtTau,
    };
  }

  /**
   * Parabolic interpolation of the CMND minimum around integer lag `tau`.
   * Returns a fractional lag. Falls back to `tau` at the search boundaries or
   * when the three points are collinear.
   */
  private interpolate(tau: number): number {
    const { cmnd, maxTau } = this;

    // `cmnd` is populated for every lag 1..maxTau, so a neighbour just outside
    // the *search* range is still a valid sample of the curve.
    const left = tau - 1;
    const right = tau + 1;
    if (left < 1 || right > maxTau) return tau;

    const s0 = cmnd[left]!;
    const s1 = cmnd[tau]!;
    const s2 = cmnd[right]!;

    const denominator = 2 * (2 * s1 - s2 - s0);
    if (denominator === 0) return tau;

    const shift = (s2 - s0) / denominator;
    // A true minimum puts the vertex inside the sampled bracket; anything
    // further out means the three points are not describing this dip.
    if (!(shift > -1 && shift < 1)) return tau;

    return tau + shift;
  }
}

/**
 * Independent zero-crossing frequency estimate, used as an octave sanity check
 * against YIN. Crude, but it fails in different ways than YIN does — which is
 * the entire point.
 */
export function zeroCrossingRateHz(window: Float32Array, sampleRate: number): number {
  const n = window.length;
  if (n < 2 || !(sampleRate > 0)) return 0;

  // Remove DC so a drifting baseline cannot park the signal on one side of
  // zero (which would suppress crossings) or straddle it (which would inflate).
  let mean = 0;
  for (let i = 0; i < n; i++) mean += window[i]!;
  mean /= n;

  let sumSquares = 0;
  for (let i = 0; i < n; i++) {
    const v = window[i]! - mean;
    sumSquares += v * v;
  }
  const centredRms = Math.sqrt(sumSquares / n);
  if (!(centredRms > 0)) return 0;

  const hysteresis = ZC_HYSTERESIS * centredRms;

  // Schmitt trigger: the signal must travel past -h to +h (or back) to count.
  let state = 0;
  let anchor = -1;
  let last = -1;
  let transitions = 0;

  for (let i = 0; i < n; i++) {
    const v = window[i]! - mean;
    let next = state;
    if (v > hysteresis) next = 1;
    else if (v < -hysteresis) next = -1;

    if (next !== state) {
      if (state === 0) {
        // First side we can be sure about — the reference, not a crossing.
        anchor = i;
      } else {
        transitions++;
        last = i;
      }
      state = next;
    }
  }

  if (transitions === 0 || anchor < 0 || last <= anchor) return 0;

  // `transitions` half-periods span `last - anchor` samples.
  return (transitions * sampleRate) / (2 * (last - anchor));
}

/** RMS of a window. */
export function rms(window: Float32Array): number {
  const n = window.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = window[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** Peak absolute sample of a window. */
export function peak(window: Float32Array): number {
  let max = 0;
  for (let i = 0; i < window.length; i++) {
    const v = Math.abs(window[i]!);
    if (v > max) max = v;
  }
  return max;
}
