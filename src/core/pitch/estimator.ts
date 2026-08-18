/**
 * The contract every monophonic pitch estimator implements.
 *
 * There is more than one way to find the period of a note, and they fail
 * differently: autocorrelation methods slip to sub-harmonics, spectral methods
 * slip to harmonics, and each is confident while doing it. Having them behind
 * one interface is what makes it possible to measure them against the same
 * recordings and to combine them, rather than arguing about which is best in
 * the abstract.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports. Implementations
 * must be allocation-free in `estimate()`: every buffer is preallocated in the
 * constructor, because this runs inside an AudioWorklet render quantum.
 */

export type PitchEstimate = {
  /** Null when no periodicity was found within the configured bounds. */
  frequencyHz: number | null;
  /**
   * 0..1, and comparable ACROSS estimators — this is the hard part of the
   * contract and the reason it is spelled out.
   *
   * It must mean "the probability that this reading is the note being played",
   * not "how deep my internal minimum was". An estimator whose confidence is
   * really a raw correlation, or one minus a normalised difference, has to map
   * that onto this scale honestly, including being LOW where the method is
   * known to be blind. A method that cannot tell a fundamental from its second
   * harmonic must not report 0.99 while doing it, or fusion is worse than any
   * single estimator.
   */
  confidence: number;
};

export type PitchEstimatorOptions = {
  sampleRate: number;
  minFrequencyHz: number;
  maxFrequencyHz: number;
};

export interface PitchEstimator {
  /** Human-readable, unique. Used in reports and in fusion diagnostics. */
  readonly name: string;
  /** Samples `estimate()` expects. The caller supplies the most recent N. */
  readonly windowSize: number;
  /** `window.length` must equal `windowSize`. */
  estimate(window: Float32Array): PitchEstimate;
}
