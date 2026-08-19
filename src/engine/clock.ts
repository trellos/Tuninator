/**
 * Sample-indexed time.
 *
 * Every timestamp in the recognizer is derived from a sample count, never from
 * a wall clock. That is what makes an offline run over a WAV bit-identical to a
 * live run over the same audio: there is no "now" anywhere in `src/engine/`.
 *
 * The public surface speaks milliseconds (`SourceTimeMs`, epoch = the first
 * processed sample). Internally the engine passes integer sample indices around
 * and converts only at the boundary, so accumulated float error cannot drift a
 * note's start time.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { SourceTimeMs, Timebase } from "../types.js";

export class SampleClock {
  readonly sampleRate: number;
  /** Optional `AudioContext.currentTime` of sample 0, for host correlation. */
  readonly originContextTime: number | undefined;

  constructor(sampleRate: number, originContextTime?: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError(`SampleClock: sampleRate must be positive, got ${sampleRate}`);
    }
    this.sampleRate = sampleRate;
    this.originContextTime = originContextTime;
  }

  /** Sample index -> ms since the first processed sample. */
  toMs(sampleIndex: number): SourceTimeMs {
    return (sampleIndex / this.sampleRate) * 1000;
  }

  /** ms -> the sample index that time falls on. Rounds to the nearest sample. */
  toSamples(ms: SourceTimeMs): number {
    return Math.round((ms / 1000) * this.sampleRate);
  }

  /** A duration in ms expressed as a whole number of samples, rounded up. */
  durationSamples(ms: number): number {
    return Math.ceil((ms / 1000) * this.sampleRate);
  }

  timebase(): Timebase {
    return this.originContextTime === undefined
      ? { sampleRate: this.sampleRate }
      : { sampleRate: this.sampleRate, originContextTime: this.originContextTime };
  }
}
