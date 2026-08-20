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
import { DeepLane } from "./deep/deep-lane.js";
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
  private readonly deep: DeepLane;
  private readonly tracker: NoteTracker;
  private readonly scratch: FastFrame[] = [];
  /** Deep jobs whose audio had aged out. Reported, never silently swallowed. */
  private droppedDeepJobs = 0;
  /** Regions the deep lane could not analyse. Same contract, same honesty. */
  private droppedDeepRegions = 0;

  constructor(sampleRate: number, config: EngineConfig, originContextTime?: number) {
    this.clock = new SampleClock(sampleRate, originContextTime);
    this.config = config;
    this.ring = new AudioRing(Math.ceil(config.deep.ringSeconds * sampleRate));
    this.fast = new FastLane(this.clock, config);
    this.deep = new DeepLane(this.clock, config);
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
    this.deep.clear();
    this.tracker.reset();
    this.droppedDeepJobs = 0;
    this.droppedDeepRegions = 0;
  }

  /** Deep jobs dropped because their audio aged out of the ring. */
  get droppedDeepJobCount(): number {
    return this.droppedDeepJobs;
  }

  /** Regions dropped because they outgrew the ring before being analysed. */
  get droppedDeepRegionCount(): number {
    return this.droppedDeepRegions;
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
      this.requestDeepWork(frame);
      this.requestRegionWork(frame);
      this.applyDeepResults(frame.at, emissions);
      this.tracker.releaseClosed(this.deep.busyNoteIds(), emissions);
    }
    this.scratch.length = 0;
    return { emissions, frames, fast };
  }

  /** Ends every open Note. Idempotent. */
  flush(): EngineOutput {
    const emissions: TrackerEmission[] = [];
    // Stop what is still sounding FIRST, so the take's last Notes are inside
    // the region the deep lane is about to rule on. The last event of a
    // recording is exactly the one whose region has not settled yet, and it
    // should not be the one event that never gets a verdict.
    for (const emission of this.tracker.closeOpenNotes(this.now)) emissions.push(emission);

    const region = this.tracker.pendingRegion();
    if (region !== null && region.fromSample < this.ring.writeIndex) {
      this.deep.requestRegion({
        fromSample: region.fromSample,
        toSample: this.ring.writeIndex,
        notBefore: Number.NEGATIVE_INFINITY,
        holdNoteIds: region.noteIds,
        attackSamples: this.tracker.transientSamplesIn(region.fromSample, this.ring.writeIndex),
      });
    }
    // Deep work still in flight describes audio that has already been heard, so
    // it is applied before the Notes it concerns are closed. Dropping it would
    // discard the very evidence that names the last chord of a take.
    this.applyDeepResults(Number.POSITIVE_INFINITY, emissions);
    this.tracker.releaseClosed(this.deep.busyNoteIds(), emissions, true);
    return { emissions, frames: [], fast: [] };
  }

  /**
   * Queue deep analysis of the audio under whatever is currently sounding.
   *
   * Only every `harmony.hopDivisor` hops: a 4096-point transform is far more
   * expensive than the fast lane's whole budget, and the spectrum does not
   * change meaningfully between adjacent 13ms hops anyway.
   */
  private requestDeepWork(frame: FastFrame): void {
    if (frame.gated) return;
    if (frame.hop % this.config.harmony.hopDivisor !== 0) return;

    const windowSize = this.deep.windowSize;
    const toSample = frame.sampleIndex;
    const fromSample = toSample - windowSize;
    if (fromSample < 0) return;

    for (const note of this.tracker.activeNoteIds()) {
      this.deep.request({
        noteId: note,
        purpose: "harmony",
        fromSample,
        toSample,
        notBefore: frame.at + this.config.deep.latencyMs,
      });
    }
  }

  /**
   * Queue a re-segmentation of everything nobody has ruled on yet.
   *
   * The fast lane proposes and the deep lane decides, so the question the deep
   * lane is asked is no longer "what is Note n7" but "what happened between
   * here and here". The region is bounded twice over: it ends when its Notes
   * have stopped and their audio has finished arriving, and it ends anyway once
   * it has grown long enough that waiting would risk it outrunning the ring.
   */
  private requestRegionWork(frame: FastFrame): void {
    const region = this.tracker.pendingRegion();
    if (region === null) return;
    if (region.fromSample >= frame.sampleIndex) return;

    const deep = this.config.deep;
    const settled = frame.at - region.lastEndTime >= deep.regionSettleMs;
    const grown = frame.at - this.clock.toMs(region.fromSample) >= deep.maxRegionMs;
    if (!settled && !grown) return;

    this.deep.requestRegion({
      fromSample: region.fromSample,
      toSample: frame.sampleIndex,
      notBefore: frame.at + deep.latencyMs,
      holdNoteIds: region.noteIds,
      attackSamples: this.tracker.transientSamplesIn(region.fromSample, frame.sampleIndex),
    });
  }

  private applyDeepResults(now: number, out: TrackerEmission[]): void {
    const drain = this.deep.drain(now, this.ring);
    this.droppedDeepJobs += drain.dropped;
    for (const region of drain.droppedRegions) {
      // The audio is gone. Say so by letting its Notes finish unrevised rather
      // than holding them open for a verdict that can never arrive.
      this.droppedDeepRegions++;
      this.tracker.resolveRegion(region.holdNoteIds);
    }
    for (const result of drain.results) {
      for (const emission of this.tracker.applyHarmony(
        result.noteId,
        result.reading,
        result.activations,
        result.evidence,
        result.at
      )) {
        out.push(emission);
      }
    }
    for (const segmentation of drain.segmentations) {
      for (const emission of this.tracker.applySegmentation(segmentation)) out.push(emission);
    }
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
