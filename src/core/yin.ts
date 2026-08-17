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
 * Sub-harmonic (octave-down) guard. If the CMND at half the chosen lag is
 * within this fraction of the CMND at the chosen lag, the half lag describes
 * essentially the same periodicity and is the true period: prefer it.
 *
 * Deliberately a *relative* tolerance. An absolute one (`cmnd[t/2] - cmnd[t] <=
 * 0.15`) fires on lags that are an order of magnitude less periodic and causes
 * exactly the octave-*up* errors this detector is trying to avoid.
 */
const SUBHARMONIC_TOLERANCE = 0.15;

/** Safety bound on repeated halving, so the guard can never walk to `minTau`. */
const MAX_SUBHARMONIC_STEPS = 3;

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
  }

  /** `window.length` must equal `windowSize`. Allocation-free. */
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

    /* --- 5. Sub-harmonic guard: prefer the higher octave ------------------- */
    // A strong 2nd harmonic can make the true period's dip merely *good* while
    // the octave-down lag dips slightly lower. If half the lag is essentially
    // as periodic, half the lag is the real period.
    for (let step = 0; step < MAX_SUBHARMONIC_STEPS; step++) {
      const halfTau = Math.round(tau / 2);
      if (halfTau < minTau) break;
      if (cmnd[halfTau]! > cmnd[tau]! * (1 + SUBHARMONIC_TOLERANCE)) break;
      tau = halfTau;
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
