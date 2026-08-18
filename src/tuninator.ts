/**
 * Tuninator — the general-purpose library.
 *
 * Audio in, musical interpretation out. Nothing else:
 *
 *   - no clock. The caller supplies every timestamp, so the same input always
 *     produces the same output and a file can be analysed faster than realtime.
 *   - no I/O. Blocks are pushed in; results are returned. There are no events
 *     to subscribe to and nothing to await.
 *   - no platform. No DOM, no Node, no `AudioContext`, no `getUserMedia`.
 *
 * Everything platform-specific lives in a *worker* — `src/workers/` — which
 * knows how to get audio out of one particular host and into `analyze()`.
 * `WorkerWebAudio` does it with an `AudioWorklet`; `WorkerOffline` does it with
 * a `Float32Array` read from disk. Both drive this identical code, which is the
 * only reason the offline eval predicts live behaviour at all.
 *
 * Audio must arrive as MONO. Picking or mixing channels is the host's job: it
 * is the only party that knows which physical input the instrument is plugged
 * into, and a library cannot guess it without guessing wrong.
 */

import type {
  MusicEvent,
  PitchFrame,
  TuninatorMode,
  TuninatorOptions,
} from "./types.js";
import { repolicy, resolvePolicy, type Policy } from "./core/policy.js";
import { PitchEngine, type EngineFrame } from "./core/pitch-engine.js";
import { EventTracker } from "./core/event-tracker.js";
import type { TrackerEmission } from "./core/tracking/active-event.js";
import type { ChromaResult } from "./core/chroma.js";
import type { ChordMatch } from "./core/chords.js";

export type { TrackerEmission } from "./core/tracking/active-event.js";

/** One analysis hop: the public frame, what it changed, and the internals. */
export type AnalysisResult = {
  /** The continuous stream. Emitted every hop, including during silence. */
  frame: PitchFrame;
  /** Event lifecycle changes this hop produced, in order. Often empty. */
  emissions: TrackerEmission[];
  /** True when the onset detector fired on this hop. */
  onset: boolean;
  onsetFlux: number;
  /** Null when chord detection is disabled by policy. */
  chroma: ChromaResult | null;
  chord: ChordMatch | null;
};

export type TuninatorConfig = TuninatorOptions & {
  /** Sample rate of the audio that will be pushed. Required: there is no clock. */
  sampleRate: number;
  /**
   * A fully-resolved policy, bypassing `TuninatorOptions`. Used by the worklet,
   * which receives a policy over the message port rather than user options.
   */
  policy?: Policy;
};

export class Tuninator {
  readonly sampleRate: number;
  /** Hop in samples, snapped to a whole number of 128-sample render quanta. */
  readonly hopSamples: number;

  private readonly options: TuninatorOptions;
  private policy: Policy;
  private mode: TuninatorMode;
  private readonly engine: PitchEngine;
  private readonly tracker: EventTracker;

  constructor(config: TuninatorConfig) {
    const { sampleRate, policy, ...options } = config;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error(`Tuninator: sampleRate must be > 0, got ${sampleRate}`);
    }

    this.sampleRate = sampleRate;
    this.options = options;
    this.policy = policy ?? resolvePolicy(options);
    this.mode = this.policy.mode;
    this.engine = new PitchEngine(sampleRate, this.policy);
    this.tracker = new EventTracker(this.policy);
    this.hopSamples = this.engine.hopSamples;
  }

  /**
   * Feed audio. Returns one result per hop boundary crossed — usually zero or
   * one, but a block longer than the hop legitimately produces several.
   *
   * `timestampMs` is the time of the FIRST sample in `block`, on whatever clock
   * the caller keeps; every timestamp coming back out is on that same clock.
   *
   * `block` must be mono. Any length is accepted: a worklet hands over 128
   * samples at a time, a file reader might hand over 65536.
   */
  analyze(block: Float32Array, timestampMs: number): AnalysisResult[] {
    const results: AnalysisResult[] = [];
    if (block.length === 0) return results;

    // The engine crosses at most one hop boundary per push, so a block longer
    // than the hop has to be fed in pieces or the extra hops are silently lost.
    // The common case — a render quantum, far shorter than a hop — takes the
    // fast path and never allocates a view.
    const hop = this.hopSamples;
    if (block.length <= hop) {
      const result = this.pushChunk(block, timestampMs);
      if (result !== null) results.push(result);
      return results;
    }

    for (let offset = 0; offset < block.length; offset += hop) {
      const chunk = block.subarray(offset, Math.min(offset + hop, block.length));
      const chunkMs = timestampMs + (offset / this.sampleRate) * 1000;
      const result = this.pushChunk(chunk, chunkMs);
      if (result !== null) results.push(result);
    }
    return results;
  }

  private pushChunk(chunk: Float32Array, timestampMs: number): AnalysisResult | null {
    const engineFrame = this.engine.push(chunk, timestampMs);
    if (engineFrame === null) return null;
    return toResult(engineFrame, this.tracker.process(engineFrame));
  }

  /**
   * Ends every open event, as of `timestampMs`. Call it when the input stops —
   * at the end of a file, or when a live stream is torn down — or the last note
   * played never gets its `end`.
   */
  flush(timestampMs: number): TrackerEmission[] {
    return this.tracker.flush(timestampMs);
  }

  /**
   * Swaps detection policy in place. The ring buffer, the accumulated audio and
   * any in-flight event survive, so this is safe to call mid-stream.
   */
  setMode(mode: TuninatorMode): void {
    if (mode === this.mode) return;
    this.setPolicy(repolicy(mode, { ...this.options, mode }));
  }

  getMode(): TuninatorMode {
    return this.mode;
  }

  /** Applies an already-resolved policy. The worklet receives one over the port. */
  setPolicy(policy: Policy): void {
    this.policy = policy;
    this.mode = policy.mode;
    this.engine.setPolicy(policy);
    this.tracker.setPolicy(policy);
  }

  getPolicy(): Policy {
    return this.policy;
  }

  /** Every event not yet in the `ended` state. */
  getActiveEvents(): MusicEvent[] {
    return this.tracker.getActiveEvents();
  }

  /**
   * Forgets all accumulated audio and analysis state.
   *
   * Returns the emissions ending any event that was still open, so a caller
   * that resets mid-note still sees its `end` rather than losing it.
   */
  reset(timestampMs = 0): TrackerEmission[] {
    const emissions = this.tracker.flush(timestampMs);
    this.engine.reset();
    return emissions;
  }
}

function toResult(engineFrame: EngineFrame, emissions: TrackerEmission[]): AnalysisResult {
  return {
    frame: engineFrame.frame,
    emissions,
    onset: engineFrame.onset,
    onsetFlux: engineFrame.onsetFlux,
    chroma: engineFrame.chroma,
    chord: engineFrame.chord,
  };
}
