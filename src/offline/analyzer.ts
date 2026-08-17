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
import { resolvePolicy } from "../core/policy.js";
import { PitchEngine } from "../core/pitch-engine.js";
import { EventTracker } from "../core/event-tracker.js";

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

/**
 * One hop of detector internals, flattened for CSV tracing. Everything here is
 * already on `EngineFrame`; this type only exists so `eval.ts --trace` does not
 * have to import the engine's own types.
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

function run(
  samples: Float32Array,
  sampleRate: number,
  options: AnalyzeOptions | undefined,
  captureTrace: boolean
): DetailedAnalyzeResult {
  const policy = resolvePolicy(options ?? {});
  const engine = new PitchEngine(sampleRate, policy);
  const tracker = new EventTracker(policy);

  const captureFrames = options?.captureFrames === true;
  const frames: PitchFrame[] = [];
  const trace: TraceRow[] = [];
  const events: MusicEvent[] = [];

  // The worklet always hands over exactly RENDER_QUANTUM samples, so the final
  // partial block is zero-padded rather than shortened. Feeding a short block
  // would be an offline-only behaviour, which is exactly what this file avoids.
  const block = new Float32Array(RENDER_QUANTUM);

  for (let offset = 0; offset < samples.length; offset += RENDER_QUANTUM) {
    const available = Math.min(RENDER_QUANTUM, samples.length - offset);
    if (available === RENDER_QUANTUM) {
      block.set(samples.subarray(offset, offset + RENDER_QUANTUM));
    } else {
      block.fill(0);
      block.set(samples.subarray(offset, offset + available));
    }

    const timestampMs = (offset / sampleRate) * 1000;
    const engineFrame = engine.push(block, timestampMs);
    if (engineFrame === null) continue;

    if (captureFrames) frames.push(engineFrame.frame);
    if (captureTrace) {
      const { frame } = engineFrame;
      trace.push({
        timestampMs: frame.timestamp,
        frequencyHz: frame.frequencyHz,
        confidence: frame.confidence,
        rms: frame.amplitude.rms,
        tau: frame.detector.tau ?? null,
        cmnd: frame.detector.cmnd ?? null,
        zeroCrossingHz: frame.detector.zeroCrossingHz ?? null,
        onset: engineFrame.onset,
        onsetFlux: engineFrame.onsetFlux,
        nearestNote: frame.nearest?.name ?? null,
      });
    }

    for (const emission of tracker.process(engineFrame)) {
      if (emission.type === "end") events.push(emission.event);
    }
  }

  const durationMs = (samples.length / sampleRate) * 1000;
  for (const emission of tracker.flush(durationMs)) {
    if (emission.type === "end") events.push(emission.event);
  }

  events.sort((a, b) => a.startedAt - b.startedAt);

  return { events, frames, durationMs, sampleRate, trace };
}

export function analyzeSamples(
  samples: Float32Array,
  sampleRate: number,
  options?: AnalyzeOptions
): AnalyzeResult {
  return run(samples, sampleRate, options, false);
}

/**
 * Same chain, plus per-hop detector internals for the `--trace` CSV.
 *
 * Additive sibling of `analyzeSamples`, which delegates here. The fixed
 * `analyzeSamples` signature and `AnalyzeResult` shape are untouched — the
 * trace is the debugging surface for the detector iteration loop and has no
 * business widening the contract everything else depends on.
 */
export function analyzeSamplesDetailed(
  samples: Float32Array,
  sampleRate: number,
  options?: AnalyzeOptions
): DetailedAnalyzeResult {
  return run(samples, sampleRate, options, true);
}
