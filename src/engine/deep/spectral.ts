/**
 * `ISpectralAnalyzer` over the chroma kernel.
 *
 * A thin adapter: the kernel already does whitening, peak picking and iterative
 * harmonic cancellation, and its `ChromaResult` is almost exactly the evidence
 * shape the deep lane wants. What this adds is the contract boundary, so a
 * different front end (CQT, a learned embedding) is a new file rather than a
 * rewrite of everything downstream.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { EngineConfig } from "../config.js";
import type { ISpectralAnalyzer, SpectralEvidence } from "../contracts.js";
import { ChromaAnalyzer } from "../kernels/chroma.js";

export class SpectralAnalyzer implements ISpectralAnalyzer {
  readonly windowSize: number;
  private readonly chroma: ChromaAnalyzer;
  /** Kept so `activations()` can read the register the chroma folds away. */
  private lastFundamentals: Array<{ midi: number; salience: number }> = [];

  constructor(sampleRate: number, config: EngineConfig) {
    this.windowSize = config.harmony.fftSize;
    this.chroma = new ChromaAnalyzer({
      sampleRate,
      fftSize: config.harmony.fftSize,
      minFrequencyHz: config.analysis.minFrequencyHz,
      maxFrequencyHz: config.analysis.maxFrequencyHz,
    });
  }

  analyze(window: Float32Array): SpectralEvidence {
    const result = this.chroma.analyze(window);
    this.lastFundamentals = result.fundamentals;

    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (const fundamental of result.fundamentals) {
      if (fundamental.midi < lowest) lowest = fundamental.midi;
      if (fundamental.midi > highest) highest = fundamental.midi;
    }

    return {
      chroma: result.chroma,
      bassPitchClass: result.bassPitchClass,
      bassFrequencyHz: result.bassFrequencyHz,
      salience: result.salience,
      polyphony: result.polyphony,
      voiceSpreadSemitones: result.fundamentals.length > 1 ? highest - lowest : 0,
    };
  }

  /** The fundamentals behind the most recent `analyze()`, register intact. */
  fundamentals(): ReadonlyArray<{ midi: number; salience: number }> {
    return this.lastFundamentals;
  }
}
