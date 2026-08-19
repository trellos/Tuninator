/**
 * `RecognitionEngine`: the whole recognizer, minus every host detail.
 *
 * Audio in as blocks of samples, Notes out as emissions. No microphone, no
 * worklet, no context, no clock — the host feeds it and drains it. That is what
 * lets the identical object run on the audio thread's downstream side in a
 * browser, inside a Web Worker, and in the Node eval harness, and it is the
 * only reason the offline eval numbers mean anything about live behaviour.
 *
 * Both lanes read from one ring: the fast lane analyses the newest audio every
 * hop, the deep lane is handed sample *ranges* to revisit later. Because reads
 * are addressed by absolute sample index, "the audio under Note n7" stays a
 * plain array read however long the deep lane took to get to it.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { Note, PitchFrame, SourceTimeMs, Timebase } from "../types.js";
import { SampleClock } from "./clock.js";
import type { EngineConfig } from "./config.js";
import { RENDER_QUANTUM } from "./config.js";
import type { FastFrame } from "./contracts.js";
import { FastLane } from "./fast/fast-lane.js";
import { AudioRing } from "./ring-buffer.js";
import { NoteTracker, type TrackerEmission } from "./tracker/note-tracker.js";

export type EngineOutput = {
  emissions: TrackerEmission[];
  /** Only populated when `diagnostics.pitchFrames` is set. */
  frames: PitchFrame[];
  /**
   * The raw fast-lane evidence behind `frames`, for offline tracing. Also only
   * populated under `diagnostics.pitchFrames`: it carries the transient
   * witnesses, which `PitchFrame` deliberately does not expose publicly.
   */
  fast: FastFrame[];
};

export class RecognitionEngine {
  readonly clock: SampleClock;
  readonly config: EngineConfig;

  private readonly ring: AudioRing;
  private readonly fast: FastLane;
  private readonly tracker: NoteTracker;
  private readonly scratch: FastFrame[] = [];

  constructor(sampleRate: number, config: EngineConfig, originContextTime?: number) {
    this.clock = new SampleClock(sampleRate, originContextTime);
    this.config = config;
    this.ring = new AudioRing(Math.ceil(config.deep.ringSeconds * sampleRate));
    this.fast = new FastLane(this.clock, config);
    this.tracker = new NoteTracker(this.clock, config);
  }

  get sampleRate(): number {
    return this.clock.sampleRate;
  }

  /** Samples processed so far. The engine's whole notion of "now". */
  get position(): number {
    return this.ring.writeIndex;
  }

  get now(): SourceTimeMs {
    return this.clock.toMs(this.ring.writeIndex);
  }

  getTimebase(): Timebase {
    return this.clock.timebase();
  }

  getActiveNotes(): Note[] {
    return this.tracker.getActiveNotes();
  }

  getNote(id: string): Note | undefined {
    return this.tracker.getNote(id);
  }

  reset(): void {
    this.ring.reset();
    this.fast.reset();
    this.tracker.reset();
  }

  /**
   * Push one chunk of mono audio. `startSample` is asserted rather than
   * trusted-and-ignored: a gap or an overlap in the capture stream is a real
   * failure mode (a dropped worklet message) and silently mis-timestamping
   * everything after it is the worst possible response.
   */
  processChunk(block: Float32Array, startSample?: number): EngineOutput {
    if (startSample !== undefined && startSample !== this.ring.writeIndex) {
      const gap = startSample - this.ring.writeIndex;
      if (gap > 0) {
        // Fill the hole with silence so time stays honest. A Note over the gap
        // ends in its release grace rather than absorbing the missing audio.
        const filler = new Float32Array(Math.min(gap, this.ring.capacity));
        this.ring.write(filler);
        this.fast.advance(this.ring, filler.length, this.scratch);
      }
    }

    this.ring.write(block);
    this.scratch.length = 0;
    this.fast.advance(this.ring, block.length, this.scratch);

    const emissions: TrackerEmission[] = [];
    const frames: PitchFrame[] = [];
    const fast: FastFrame[] = [];
    const diagnostic = this.config.diagnostics.pitchFrames;
    for (const frame of this.scratch) {
      if (diagnostic) {
        frames.push(toPitchFrame(frame));
        fast.push(frame);
      }
      for (const emission of this.tracker.process(frame)) emissions.push(emission);
    }
    this.scratch.length = 0;
    return { emissions, frames, fast };
  }

  /** Ends every open Note. Idempotent. */
  flush(): EngineOutput {
    return { emissions: this.tracker.flush(this.now), frames: [], fast: [] };
  }

  /** The block size the capture side is expected to deliver. */
  static get renderQuantum(): number {
    return RENDER_QUANTUM;
  }
}

function toPitchFrame(frame: FastFrame): PitchFrame {
  return {
    timestamp: frame.at,
    frequencyHz: frame.pitch.frequencyHz,
    confidence: frame.pitch.confidence,
    nearest: frame.pitch.nearest,
    amplitude: { rms: frame.rms, peak: frame.peak },
    detector: {
      tau: frame.pitch.tau,
      cmnd: frame.pitch.cmnd,
      zeroCrossingHz: frame.pitch.zeroCrossingHz,
    },
  };
}
