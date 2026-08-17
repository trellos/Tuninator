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

export class YinDetector {
  readonly sampleRate: number;
  readonly windowSize: number;

  constructor(_options: YinOptions) {
    this.sampleRate = _options.sampleRate;
    this.windowSize = _options.windowSize;
    throw new Error("YinDetector: not implemented");
  }

  /** `window.length` must equal `windowSize`. Allocation-free. */
  detect(_window: Float32Array): YinResult {
    throw new Error("YinDetector.detect: not implemented");
  }
}

/**
 * Independent zero-crossing frequency estimate, used as an octave sanity check
 * against YIN. Crude, but it fails in different ways than YIN does — which is
 * the entire point.
 */
export function zeroCrossingRateHz(_window: Float32Array, _sampleRate: number): number {
  throw new Error("zeroCrossingRateHz: not implemented");
}

/** RMS of a window. */
export function rms(_window: Float32Array): number {
  throw new Error("rms: not implemented");
}

/** Peak absolute sample of a window. */
export function peak(_window: Float32Array): number {
  throw new Error("peak: not implemented");
}
