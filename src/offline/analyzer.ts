/**
 * Runs the real recognizer over a Float32Array, in Node.
 *
 * This feeds `engine/RecognitionEngine` in 128-sample blocks — the same quantum
 * the AudioWorklet delivers — and derives every timestamp from sample position.
 * Same code, same block size, same hop, so eval results predict live behaviour.
 *
 * There is deliberately no separate "offline" recognizer. If this file ever
 * needs to special-case offline behaviour, the architecture has broken.
 */

import type { Note, PitchFrame, RecognizerOptions } from "../types.js";
import { RecognitionEngine } from "../engine/engine.js";
import { RENDER_QUANTUM, resolveEngineConfig } from "../engine/config.js";
import type { RigCalibration } from "../engine/rig-profile.js";
import type { FastFrame } from "../engine/contracts.js";
import type {
  TrackerEmission,
  TrackerTraceEvent,
} from "../engine/tracker/note-tracker.js";

export { RENDER_QUANTUM };

export type AnalyzeOptions = Pick<RecognizerOptions, "engine" | "diagnostics"> & {
  /** Collect every PitchFrame. Off by default — 20s at 12ms is ~1700 frames. */
  captureFrames?: boolean;
  /**
   * Receive every segmentation decision the tracker makes. Diagnostic, and the
   * reason it is routed through here rather than through a second copy of this
   * loop: a ledger built on a re-implementation of the run is a ledger about
   * code that does not exist.
   */
  trackerTrace?: (event: TrackerTraceEvent) => void;
  /**
   * Run with the transient bars scaled to a measured signal chain.
   *
   * Offline only, and deliberately not part of `EngineTuning`: a calibration is
   * a measurement of a rig rather than a setting, and nothing in the library
   * produces one. It exists so `scripts/measure-rig-ceiling.ts` can ask what
   * the recognizer would do if it knew the chain — see
   * `EngineConfig.calibration`. Omitted, the engine runs `UNCALIBRATED`, which
   * is bit-identical to not having this parameter at all.
   */
  calibration?: RigCalibration;
};

export type AnalyzeResult = {
  /** Every Note that ended, in start order. Includes the flush. */
  notes: Note[];
  /** Every emission in order, for consumers that care about the trajectory. */
  emissions: TrackerEmission[];
  /** Populated only when `captureFrames` is set. */
  frames: PitchFrame[];
  durationMs: number;
  sampleRate: number;
};

/**
 * One hop of detector internals, flattened for CSV tracing. This type exists
 * only so `eval.ts --trace` does not have to import the engine's own types.
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
  const wantFrames = options?.captureFrames === true || captureTrace;
  const config = resolveEngineConfig(options?.engine, {
    ...options?.diagnostics,
    ...(wantFrames ? { pitchFrames: true } : {}),
  });
  if (options?.calibration !== undefined) config.calibration = { ...options.calibration };
  const engine = new RecognitionEngine(sampleRate, config);
  if (options?.trackerTrace !== undefined) engine.setTrackerTrace(options.trackerTrace);

  const frames: PitchFrame[] = [];
  const trace: TraceRow[] = [];
  const notes: Note[] = [];
  const emissions: TrackerEmission[] = [];

  // The worklet always hands over exactly RENDER_QUANTUM samples, so the final
  // partial block is zero-padded rather than shortened. Feeding a short block
  // would be an offline-only behaviour, which is exactly what this file avoids.
  const block = new Float32Array(RENDER_QUANTUM);

  const collect = (output: ReturnType<RecognitionEngine["processChunk"]>): void => {
    output.frames.forEach((frame, i) => {
      if (options?.captureFrames === true) frames.push(frame);
      if (captureTrace) trace.push(toTraceRow(frame, output.fast[i]));
    });
    for (const emission of output.emissions) {
      emissions.push(emission);
      if (emission.type === "ended") notes.push(emission.note);
    }
  };

  for (let offset = 0; offset < samples.length; offset += RENDER_QUANTUM) {
    const available = Math.min(RENDER_QUANTUM, samples.length - offset);
    if (available === RENDER_QUANTUM) {
      block.set(samples.subarray(offset, offset + RENDER_QUANTUM));
    } else {
      block.fill(0);
      block.set(samples.subarray(offset, offset + available));
    }
    collect(engine.processChunk(block, offset));
  }

  collect(engine.flush());

  notes.sort((a, b) => a.startTime - b.startTime);

  return {
    notes,
    emissions,
    frames,
    durationMs: (samples.length / sampleRate) * 1000,
    sampleRate,
    trace,
  };
}

function toTraceRow(frame: PitchFrame, fast: FastFrame | undefined): TraceRow {
  return {
    timestampMs: frame.timestamp,
    frequencyHz: frame.frequencyHz,
    confidence: frame.confidence,
    rms: frame.amplitude.rms,
    tau: frame.detector.tau ?? null,
    cmnd: frame.detector.cmnd ?? null,
    zeroCrossingHz: frame.detector.zeroCrossingHz ?? null,
    onset: fast?.attack != null,
    onsetFlux: fast?.attack?.fluxValue ?? 0,
    nearestNote: frame.nearest?.name ?? null,
  };
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
 * Additive sibling of `analyzeSamples`, which delegates here: the trace is the
 * debugging surface for the detector iteration loop and has no business
 * widening the contract everything else depends on.
 */
export function analyzeSamplesDetailed(
  samples: Float32Array,
  sampleRate: number,
  options?: AnalyzeOptions
): DetailedAnalyzeResult {
  return run(samples, sampleRate, options, true);
}
