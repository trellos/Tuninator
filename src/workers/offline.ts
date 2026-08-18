/**
 * WorkerOffline: the Node worker for the `Tuninator` library.
 *
 * Feeds a `Float32Array` through the very same `Tuninator` the browser worklet
 * runs, in the same 128-sample blocks the AudioWorklet delivers, with
 * timestamps derived from sample position instead of a clock. Same code, same
 * block size, same hop, so eval results predict live behaviour.
 *
 * There is deliberately no separate "offline" detector. If this file ever needs
 * to special-case offline behaviour, the architecture has broken.
 */

import type { MusicEvent, PitchFrame, TuninatorOptions } from "../types.js";
import type { Policy } from "../core/policy.js";
import { Tuninator } from "../tuninator.js";

/**
 * Matches the AudioWorklet render quantum. Do not change to "go faster".
 *
 * `Tuninator.analyze()` accepts any block length, so a larger block would give
 * identical *results* — but not identical *timestamps*, because a frame is
 * stamped from the block it completed on. Feeding the worklet's block size is
 * what keeps the eval's onset numbers comparable with the browser's.
 */
export const RENDER_QUANTUM = 128;

export type AnalyzeOptions = TuninatorOptions & {
  /** Collect every PitchFrame. Off by default — 20s at 12ms is ~1700 frames. */
  captureFrames?: boolean;
  /**
   * A fully-resolved policy, bypassing mode defaults. The parameter sweep in
   * `scripts/sweep.ts` uses this to vary one field at a time.
   */
  policy?: Policy;
};

export type AnalyzeResult = {
  /** Every event the tracker completed, in start order. Includes the flush. */
  events: MusicEvent[];
  /** Populated only when `captureFrames` is set. */
  frames: PitchFrame[];
  durationMs: number;
  sampleRate: number;
};

/**
 * One hop of detector internals, flattened for CSV tracing. Everything here is
 * already on an `AnalysisResult`; this type only exists so `eval.ts --trace`
 * does not have to import the engine's own types.
 */
export type TraceRow = {
  timestampMs: number;
  frequencyHz: number | null;
  confidence: number;
  rms: number;
  tau: number | null;
  cmnd: number | null;
  zeroCrossingHz: number | null;
  onset: boolean;
  onsetFlux: number;
  nearestNote: string | null;
};

export type DetailedAnalyzeResult = AnalyzeResult & {
  /** One row per hop. Only `analyzeSamplesDetailed` populates this. */
  trace: TraceRow[];
};

export class WorkerOffline {
  private readonly tuninator: Tuninator;
  private readonly sampleRate: number;

  constructor(sampleRate: number, options: AnalyzeOptions = {}) {
    this.sampleRate = sampleRate;
    this.tuninator = new Tuninator({ ...options, sampleRate });
  }

  /** Runs `samples` to completion, including the final flush. */
  run(samples: Float32Array, captureFrames: boolean, captureTrace: boolean): DetailedAnalyzeResult {
    const frames: PitchFrame[] = [];
    const trace: TraceRow[] = [];
    const events: MusicEvent[] = [];

    // The worklet always hands over exactly RENDER_QUANTUM samples, so the final
    // partial block is zero-padded rather than shortened. Feeding a short block
    // would be an offline-only behaviour, which is exactly what this avoids.
    const block = new Float32Array(RENDER_QUANTUM);

    for (let offset = 0; offset < samples.length; offset += RENDER_QUANTUM) {
      const available = Math.min(RENDER_QUANTUM, samples.length - offset);
      if (available === RENDER_QUANTUM) {
        block.set(samples.subarray(offset, offset + RENDER_QUANTUM));
      } else {
        block.fill(0);
        block.set(samples.subarray(offset, offset + available));
      }

      const timestampMs = (offset / this.sampleRate) * 1000;
      for (const result of this.tuninator.analyze(block, timestampMs)) {
        if (captureFrames) frames.push(result.frame);
        if (captureTrace) trace.push(traceRow(result));
        for (const emission of result.emissions) {
          if (emission.type === "end") events.push(emission.event);
        }
      }
    }

    const durationMs = (samples.length / this.sampleRate) * 1000;
    for (const emission of this.tuninator.flush(durationMs)) {
      if (emission.type === "end") events.push(emission.event);
    }

    events.sort((a, b) => a.startedAt - b.startedAt);

    return { events, frames, durationMs, sampleRate: this.sampleRate, trace };
  }
}

function traceRow(result: {
  frame: PitchFrame;
  onset: boolean;
  onsetFlux: number;
}): TraceRow {
  const { frame } = result;
  return {
    timestampMs: frame.timestamp,
    frequencyHz: frame.frequencyHz,
    confidence: frame.confidence,
    rms: frame.amplitude.rms,
    tau: frame.detector.tau ?? null,
    cmnd: frame.detector.cmnd ?? null,
    zeroCrossingHz: frame.detector.zeroCrossingHz ?? null,
    onset: result.onset,
    onsetFlux: result.onsetFlux,
    nearestNote: frame.nearest?.name ?? null,
  };
}

export function analyzeSamples(
  samples: Float32Array,
  sampleRate: number,
  options?: AnalyzeOptions
): AnalyzeResult {
  return new WorkerOffline(sampleRate, options ?? {}).run(
    samples,
    options?.captureFrames === true,
    false
  );
}

/**
 * Same chain, plus per-hop detector internals for the `--trace` CSV.
 *
 * Additive sibling of `analyzeSamples`. The `AnalyzeResult` shape is untouched
 * — the trace is the debugging surface for the detector iteration loop and has
 * no business widening the contract everything else depends on.
 */
export function analyzeSamplesDetailed(
  samples: Float32Array,
  sampleRate: number,
  options?: AnalyzeOptions
): DetailedAnalyzeResult {
  return new WorkerOffline(sampleRate, options ?? {}).run(
    samples,
    options?.captureFrames === true,
    true
  );
}
