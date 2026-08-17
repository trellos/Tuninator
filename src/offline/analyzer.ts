/**
 * Runs the real detection chain over a Float32Array, in Node.
 *
 * This feeds `core/pitch-engine` and `core/event-tracker` in 128-sample blocks
 * — the same quantum the AudioWorklet delivers — with timestamps derived from
 * sample position. Same code, same block size, same hop, so eval results
 * predict live behaviour.
 *
 * There is deliberately no separate "offline" detector. If this file ever needs
 * to special-case offline behaviour, the architecture has broken.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the harness
 * workstream.
 */

import type { MusicEvent, PitchFrame, TuninatorOptions } from "../types.js";

/** Matches the AudioWorklet render quantum. Do not change to "go faster". */
export const RENDER_QUANTUM = 128;

export type AnalyzeOptions = TuninatorOptions & {
  /** Collect every PitchFrame. Off by default — 20s at 12ms is ~1700 frames. */
  captureFrames?: boolean;
};

export type AnalyzeResult = {
  /** Every event the tracker completed, in start order. Includes the flush. */
  events: MusicEvent[];
  /** Populated only when `captureFrames` is set. */
  frames: PitchFrame[];
  durationMs: number;
  sampleRate: number;
};

export function analyzeSamples(
  _samples: Float32Array,
  _sampleRate: number,
  _options?: AnalyzeOptions
): AnalyzeResult {
  throw new Error("analyzeSamples: not implemented");
}
