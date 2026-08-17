/**
 * Block-in -> PitchFrame-out. Drives YIN, onset, and chroma at the hop.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the integration
 * workstream.
 *
 * Window and hop are decoupled: a ring buffer accumulates input, and every hop
 * the detector analyses the most recent N samples. That is what gives a 12ms
 * update rate without breaking low E (one period of 82.4Hz is ~582 samples).
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports. This exact code
 * runs in the AudioWorklet, in Node, and in Vitest; the offline eval is
 * trustworthy only because there is no separate offline detector.
 */

import type { PitchFrame } from "../types.js";
import type { Policy } from "./policy.js";
import type { ChordMatch } from "./chords.js";
import type { ChromaResult } from "./chroma.js";

/** One hop's worth of analysis: the public frame plus tracker-only detail. */
export type EngineFrame = {
  frame: PitchFrame;
  /** True when the onset detector fired on this hop. */
  onset: boolean;
  onsetFlux: number;
  /** Null when chord detection is disabled by policy. */
  chroma: ChromaResult | null;
  chord: ChordMatch | null;
};

export class PitchEngine {
  readonly sampleRate: number;
  /** Hop in samples, snapped to a whole number of 128-sample render quanta. */
  readonly hopSamples: number;

  constructor(_sampleRate: number, _policy: Policy) {
    this.sampleRate = _sampleRate;
    this.hopSamples = 0;
    throw new Error("PitchEngine: not implemented");
  }

  /** Swaps policy in place. Never reallocates the audio graph or ring buffer. */
  setPolicy(_policy: Policy): void {
    throw new Error("PitchEngine.setPolicy: not implemented");
  }

  /**
   * Push one render quantum (128 samples in the browser; the offline analyzer
   * uses the same size deliberately). Returns a frame only on hop boundaries.
   *
   * `timestampMs` is the time of the *first* sample in `block`.
   */
  push(_block: Float32Array, _timestampMs: number): EngineFrame | null {
    throw new Error("PitchEngine.push: not implemented");
  }

  reset(): void {
    throw new Error("PitchEngine.reset: not implemented");
  }
}
