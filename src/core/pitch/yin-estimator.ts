/**
 * The incumbent, behind the shared estimator contract.
 *
 * This is the detector the library ships: YIN's cumulative mean normalised
 * difference, plus the octave resolution added after it was measured taking
 * the first lag under its threshold and so reading a low B an octave high.
 * It exists here so every other method is compared against what we actually
 * have rather than against a textbook YIN nobody runs.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import { YinDetector } from "../yin.js";
import type { PitchEstimate, PitchEstimator, PitchEstimatorOptions } from "./estimator.js";

/** Two periods of the lowest note, rounded up to a power of two. */
const WINDOW = 2048;

export class YinEstimator implements PitchEstimator {
  readonly name = "yin";
  readonly windowSize = WINDOW;
  private readonly detector: YinDetector;

  constructor(options: PitchEstimatorOptions) {
    this.detector = new YinDetector({
      sampleRate: options.sampleRate,
      windowSize: WINDOW,
      minFrequencyHz: options.minFrequencyHz,
      maxFrequencyHz: options.maxFrequencyHz,
    });
  }

  estimate(window: Float32Array): PitchEstimate {
    const result = this.detector.detect(window);
    return { frequencyHz: result.frequencyHz, confidence: result.confidence };
  }
}

export default function create(options: PitchEstimatorOptions): PitchEstimator {
  return new YinEstimator(options);
}
