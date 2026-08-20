/**
 * `IFastPitchEstimator` over the YIN kernel, dual-window.
 *
 * Window and hop are decoupled, and *two* windows run every hop. The timing
 * pressure and the pitch range in real playing are inversely correlated: slow
 * low notes need a long window (one period of low E is ~582 samples and YIN
 * needs roughly two), while a fast run is usually high, where two periods is
 * ~200 samples. Running both and letting the short one win when it is confident
 * and high enough to be trustworthy is what makes 125ms sixteenths resolvable
 * without losing low E.
 *
 * Ported from `core/pitch-engine.ts`, which conflated this with hop scheduling,
 * onset detection and frame assembly. Here it does one thing.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { EngineConfig } from "../config.js";
import type { IFastPitchEstimator, PitchEvidence } from "../contracts.js";
import { describeFrequency } from "../kernels/notes.js";
import { YinDetector, zeroCrossingRateHz } from "../kernels/yin.js";

/**
 * How close to a whole number of octaves a disagreement must be before it is
 * treated as an octave error rather than two detectors seeing different notes.
 * ~0.12 octaves is a little over a semitone.
 */
const OCTAVE_TOLERANCE = 0.12;

export class YinEstimator implements IFastPitchEstimator {
  readonly longWindowSize: number;
  readonly shortWindowSize: number;

  private readonly config: EngineConfig;
  private readonly sampleRate: number;
  private readonly long: YinDetector;
  private readonly short: YinDetector;
  /** Circular buffer of recent voiced frequencies, for the temporal median. */
  private readonly medianBuf: number[] = [];

  constructor(sampleRate: number, config: EngineConfig) {
    this.sampleRate = sampleRate;
    this.config = config;
    this.longWindowSize = config.pitch.longWindow;
    this.shortWindowSize = config.pitch.shortWindow;

    this.long = new YinDetector({
      sampleRate,
      windowSize: config.pitch.longWindow,
      minFrequencyHz: config.analysis.minFrequencyHz,
      maxFrequencyHz: config.analysis.maxFrequencyHz,
      threshold: config.pitch.yinThreshold,
    });

    // The short window physically cannot resolve two periods of a low note, so
    // its search is bounded below. Asking it for low E would only produce
    // confident nonsense.
    this.short = new YinDetector({
      sampleRate,
      windowSize: config.pitch.shortWindow,
      minFrequencyHz: Math.max(
        config.analysis.minFrequencyHz,
        (2 * sampleRate) / config.pitch.shortWindow
      ),
      maxFrequencyHz: config.analysis.maxFrequencyHz,
      threshold: config.pitch.yinThreshold,
    });
  }

  /** Clears the temporal median. Called on an attack: the history is stale. */
  clearHistory(): void {
    this.medianBuf.length = 0;
  }

  reset(): void {
    this.medianBuf.length = 0;
  }

  estimate(longWindow: Float32Array, shortWindow: Float32Array): PitchEvidence {
    const config = this.config;
    const long = this.long.detect(longWindow);
    const short = this.short.detect(shortWindow);
    const zeroCrossingHz = zeroCrossingRateHz(longWindow, this.sampleRate);

    const shortUsable =
      short.frequencyHz !== null &&
      short.frequencyHz >= config.pitch.shortWindowMinHz &&
      short.confidence >= config.analysis.confidenceGate;

    let chosen = shortUsable ? short : long;
    let source: PitchEvidence["source"] = shortUsable ? "short" : "long";

    // The two windows are independent witnesses and they fail differently. The
    // long window searches lags all the way down to minFrequencyHz, so on a
    // high note its CMND dips at every multiple of the true period and it can
    // lock onto one — E5 read as E2 is a real observed failure, a clean 8x. The
    // short window's search range physically excludes those lags, so when the
    // long window reports an exact octave-multiple BELOW the short one, the
    // short one is the trustworthy witness.
    if (
      short.frequencyHz !== null &&
      long.frequencyHz !== null &&
      short.frequencyHz >= config.pitch.shortWindowMinHz &&
      chosen === long
    ) {
      const octaves = Math.log2(short.frequencyHz / long.frequencyHz);
      const nearest = Math.round(octaves);
      if (nearest >= 1 && Math.abs(octaves - nearest) < OCTAVE_TOLERANCE) {
        chosen = short;
        source = "short";
      }
    }

    let frequencyHz = chosen.frequencyHz;
    let confidence = chosen.confidence;
    let tau = chosen.tau;

    // Zero crossing is crude, but it fails in different ways than YIN does,
    // which is what makes it usable as an arbiter. Rather than merely
    // distrusting an octave disagreement, correct it: move the reading onto the
    // octave ZCR supports. Halving confidence instead just pushed the frame
    // under the gate, which read as a dropout and split the note in two.
    //
    // Only multi-octave gaps qualify. Zero-crossing counts run HIGH on a
    // harmonic-rich string, so a one-octave disagreement is genuinely
    // ambiguous — acting on those turned correct readings into octave-up errors
    // (C#5 reported as B5). A 3-octave gap has no such excuse.
    if (frequencyHz !== null && zeroCrossingHz > 0) {
      const octaves = Math.log2(zeroCrossingHz / frequencyHz);
      const nearest = Math.round(octaves);
      if (Math.abs(nearest) >= 2 && Math.abs(octaves - nearest) < OCTAVE_TOLERANCE) {
        const corrected = frequencyHz * Math.pow(2, nearest);
        if (
          corrected >= config.analysis.minFrequencyHz &&
          corrected <= config.analysis.maxFrequencyHz
        ) {
          frequencyHz = corrected;
          if (tau !== null) tau /= Math.pow(2, nearest);
        } else {
          confidence *= 0.5;
        }
      }
    }

    if (confidence < config.analysis.confidenceGate) frequencyHz = null;

    // Temporal median over recent voiced frames. Median, not mean, so the value
    // stays one that was actually observed: a single octave-flipped frame is
    // discarded rather than averaged into a pitch nobody played.
    if (frequencyHz !== null && config.pitch.medianFrames > 1) {
      this.medianBuf.push(frequencyHz);
      if (this.medianBuf.length > config.pitch.medianFrames) this.medianBuf.shift();
      frequencyHz = medianOf(this.medianBuf);
    } else if (frequencyHz === null) {
      this.medianBuf.length = 0;
    }

    return {
      frequencyHz,
      confidence,
      nearest: frequencyHz === null ? null : describeFrequency(frequencyHz),
      tau,
      cmnd: chosen.cmnd,
      zeroCrossingHz,
      source: frequencyHz === null ? "none" : source,
    };
  }
}

/** Median of a small array. Copies, so it never reorders the caller's buffer. */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
