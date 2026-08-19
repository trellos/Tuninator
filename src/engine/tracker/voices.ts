/**
 * What is still ringing, and how loud it should be by now.
 *
 * A restrum is not "louder than before" — a muted upstrum over a ringing chord
 * is quieter than what it interrupts — and it is not "louder than the recent
 * baseline" either, because a decaying chord's baseline falls with it and
 * ordinary ripple keeps clearing any fixed multiple of it. What a restrum
 * actually is: *more energy than the strings that are already sounding could
 * possibly still have*.
 *
 * That is answerable, because a plucked string decays exponentially and the
 * decay is measurable from the note's own first few hundred milliseconds. This
 * tracker fits one time constant per Note from its observed envelope and
 * predicts forward. Energy above the prediction had to come from somewhere.
 *
 * Deliberately one decay per Note rather than one per string: separating six
 * simultaneous decays from a single envelope is not identifiable, and pretending
 * otherwise would produce six confident numbers with nothing behind them.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { SourceTimeMs } from "../../types.js";

/** Hops before the fit is trusted. Below this the attack still dominates. */
const MIN_OBSERVATIONS = 4;
/** Slowest decay the model will fit, in ms to 1/e. Longer reads as sustain. */
const MAX_TAU_MS = 4000;
/** Fastest decay the model will fit. Shorter is a transient, not a string. */
const MIN_TAU_MS = 80;

export class VoiceDecay {
  /** Peak level observed, and when. The decay is measured from there. */
  private peak = 0;
  private peakAt: SourceTimeMs = 0;
  /** Accumulators for a least-squares fit of log(level) against time. */
  private n = 0;
  private sumT = 0;
  private sumL = 0;
  private sumTT = 0;
  private sumTL = 0;
  private lastAt: SourceTimeMs = 0;

  observe(at: SourceTimeMs, rms: number): void {
    this.lastAt = at;
    if (rms > this.peak) {
      // A new peak restarts the fit: whatever came before described a decay
      // that has just been overtaken by fresh energy.
      this.peak = rms;
      this.peakAt = at;
      this.n = 0;
      this.sumT = 0;
      this.sumL = 0;
      this.sumTT = 0;
      this.sumTL = 0;
      return;
    }
    if (rms <= 0 || this.peak <= 0) return;

    const t = at - this.peakAt;
    const l = Math.log(rms / this.peak);
    this.n++;
    this.sumT += t;
    this.sumL += l;
    this.sumTT += t * t;
    this.sumTL += t * l;
  }

  /** Fitted time constant in ms, or null while the fit is not yet trustworthy. */
  tauMs(): number | null {
    if (this.n < MIN_OBSERVATIONS) return null;
    const denominator = this.n * this.sumTT - this.sumT * this.sumT;
    if (denominator === 0) return null;
    const slope = (this.n * this.sumTL - this.sumT * this.sumL) / denominator;
    if (!(slope < 0)) return null;
    const tau = -1 / slope;
    if (!Number.isFinite(tau)) return null;
    return Math.min(MAX_TAU_MS, Math.max(MIN_TAU_MS, tau));
  }

  /**
   * The loudest this Note could still be at `at`, on its own measured decay.
   * Null while there is not enough evidence to predict anything.
   */
  predict(at: SourceTimeMs): number | null {
    const tau = this.tauMs();
    if (tau === null || this.peak <= 0) return null;
    return this.peak * Math.exp(-(at - this.peakAt) / tau);
  }

  /**
   * How far above its own predicted decay the signal is. 1 means exactly on the
   * curve, and anything well above it is energy that was put in from outside.
   * Null while the decay is not yet measurable.
   */
  excess(at: SourceTimeMs, rms: number): number | null {
    const predicted = this.predict(at);
    if (predicted === null || predicted <= 0) return null;
    return rms / predicted;
  }

  get observations(): number {
    return this.n;
  }

  get lastObservedAt(): SourceTimeMs {
    return this.lastAt;
  }
}
