/**
 * Harmonic-whitened chroma (HPCP) for chord detection.
 *
 * A strummed guitar's overtones swamp its fundamentals in a raw magnitude
 * spectrum, so the spectrum is whitened / salience-weighted before folding into
 * 12 bins.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the chord
 * workstream. Depends on `RealFFT` and `hannWindow` from `./fft.js`.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

export type ChromaOptions = {
  sampleRate: number;
  fftSize: number;
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  /** Number of harmonics folded in, with decaying weight. */
  harmonics?: number;
};

export type ChromaResult = {
  /** 12 bins, index 0 = C, normalised so max = 1 (all zeros when silent). */
  chroma: Float32Array;
  /**
   * Lowest confidently-detected partial, as a pitch class index (0 = C).
   * This is what separates C5 from G5, and Am11 from C6/9.
   */
  bassPitchClass: number | null;
  bassFrequencyHz: number | null;
  /** 0..1 measure of how tonal (vs. noisy) the spectrum is. */
  salience: number;
  /** Estimated number of simultaneous fundamentals. */
  polyphony: number;
};

export class ChromaAnalyzer {
  /** Number of samples `analyze()` expects. Equals `fftSize`. */
  readonly windowSize: number;

  constructor(_options: ChromaOptions) {
    this.windowSize = _options.fftSize;
    throw new Error("ChromaAnalyzer: not implemented");
  }

  /** `window.length` must equal `windowSize`. Applies its own Hann window. */
  analyze(_window: Float32Array): ChromaResult {
    throw new Error("ChromaAnalyzer.analyze: not implemented");
  }
}
