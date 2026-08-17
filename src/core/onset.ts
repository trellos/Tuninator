/**
 * Spectral-flux onset detection with an adaptive median threshold.
 *
 * RMS envelope alone misses a re-picked same-pitch note, which the eval scores
 * as a missed event. Spectral flux is what catches it.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the DSP-core
 * workstream.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

export type OnsetOptions = {
  sampleRate: number;
  fftSize: number;
  /** Minimum inter-onset interval, ms. 120bpm sixteenths are 125ms apart. */
  minIntervalMs: number;
  /** Frames in the adaptive median window. */
  medianWindow: number;
  /** Multiplier on the adaptive median. Higher = fewer onsets. */
  sensitivity: number;
};

export type OnsetResult = {
  isOnset: boolean;
  /** Positive half-wave rectified spectral flux for this hop. */
  flux: number;
  /** The adaptive threshold flux was compared against. */
  threshold: number;
};

export class OnsetDetector {
  /** Number of samples `process()` expects. Equals `fftSize`. */
  readonly windowSize: number;

  constructor(_options: OnsetOptions) {
    this.windowSize = _options.fftSize;
    throw new Error("OnsetDetector: not implemented");
  }

  /**
   * Call once per analysis hop with the most recent `windowSize` samples.
   * `timestampMs` gates the minimum inter-onset interval.
   */
  process(_window: Float32Array, _timestampMs: number): OnsetResult {
    throw new Error("OnsetDetector.process: not implemented");
  }

  reset(): void {
    throw new Error("OnsetDetector.reset: not implemented");
  }
}
