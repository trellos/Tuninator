/**
 * The deep lane: analysis that is allowed to be late.
 *
 * The fast lane must answer within a hop, which bounds what it can look at. The
 * deep lane has the opposite contract — it may take hundreds of milliseconds,
 * and in exchange it gets a 4096-point window and the right to revisit audio
 * the fast lane already reported on. That is what makes a Note able to *bloom*:
 * something announced as a single pitch acquires a chord identity later, from
 * evidence that did not exist when it was announced.
 *
 * Three properties matter more than throughput:
 *
 *  - **Jobs are addressed by sample range, not by "recent audio".** A job
 *    queued at 4.10s and run at 4.25s must analyse the audio it was queued
 *    about. Anything else silently analyses the wrong music.
 *  - **A job whose audio has aged out of the ring is dropped, loudly.** Reading
 *    whatever happens to be at those indices now would produce a confident
 *    answer about the wrong three seconds.
 *  - **Latency is simulated in source time, not measured in wall time.** There
 *    is no clock in the engine, so "150ms later" means 150ms of audio later.
 *    Offline and live runs therefore see the deep lane arrive at exactly the
 *    same point in the music, and an eval run is reproducible bit for bit.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { SourceTimeMs } from "../../types.js";
import type { EngineConfig } from "../config.js";
import type {
  DeepJobPurpose,
  HarmonicReading,
  PitchActivation,
  SpectralEvidence,
} from "../contracts.js";
import { AudioRing } from "../ring-buffer.js";
import { SampleClock } from "../clock.js";
import { HarmonicInterpreter } from "./harmonic.js";
import { MultiPitchAnalyzer } from "./multi-pitch.js";
import { SpectralAnalyzer } from "./spectral.js";

export type DeepRequest = {
  noteId: string;
  purpose: DeepJobPurpose;
  /** Inclusive start of the audio to analyse. */
  fromSample: number;
  /** Exclusive end. */
  toSample: number;
  /** Source time this result may be applied at. */
  notBefore: SourceTimeMs;
};

export type DeepResult = {
  noteId: string;
  purpose: DeepJobPurpose;
  at: SourceTimeMs;
  evidence: SpectralEvidence;
  activations: PitchActivation[];
  reading: HarmonicReading;
};

export type DeepDrain = {
  results: DeepResult[];
  /** Jobs dropped because their audio had aged out. Surfaced as diagnostics. */
  dropped: number;
};

/**
 * Pending jobs kept before the oldest is dropped.
 *
 * A backlog this deep already means the deep lane is not keeping up, and the
 * useful thing to do about it is analyse the newest audio rather than work
 * through a queue of history nobody is waiting for any more.
 */
const MAX_PENDING = 32;

export class DeepLane {
  private readonly config: EngineConfig;
  private readonly clock: SampleClock;
  private readonly spectral: SpectralAnalyzer;
  private readonly multiPitch: MultiPitchAnalyzer;
  private readonly harmonic: HarmonicInterpreter;
  private readonly window: Float32Array;

  /** Pending jobs, keyed so a literal duplicate coalesces rather than queues. */
  private readonly pending = new Map<string, DeepRequest>();

  constructor(clock: SampleClock, config: EngineConfig) {
    this.clock = clock;
    this.config = config;
    this.spectral = new SpectralAnalyzer(clock.sampleRate, config);
    this.multiPitch = new MultiPitchAnalyzer(this.spectral);
    this.harmonic = new HarmonicInterpreter(config);
    this.window = new Float32Array(this.spectral.windowSize);
  }

  get windowSize(): number {
    return this.spectral.windowSize;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Queue analysis of one window of audio on behalf of a Note.
   *
   * The key includes the window's end, so re-requesting the same window is a
   * no-op while successive windows of the same Note all survive: a chord's
   * identity is voted on across its whole life, and coalescing those together
   * would throw away exactly the evidence that separates a Bm from the B5 its
   * decayed tail looks like.
   */
  request(request: DeepRequest): void {
    const key = `${request.noteId}:${request.purpose}:${request.toSample}`;
    this.pending.set(key, request);
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next();
      if (oldest.done === true) break;
      this.pending.delete(oldest.value);
    }
  }

  /** Reassign a Note's pending work — used when a Note is split or absorbed. */
  reassign(fromNoteId: string, toNoteId: string): void {
    for (const [key, request] of [...this.pending]) {
      if (request.noteId !== fromNoteId) continue;
      this.pending.delete(key);
      this.request({ ...request, noteId: toNoteId });
    }
  }

  /** Notes with work still queued. A Note is not finished until this is empty. */
  busyNoteIds(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const request of this.pending.values()) out.add(request.noteId);
    return out;
  }

  forget(noteId: string): void {
    for (const [key, request] of [...this.pending]) {
      if (request.noteId === noteId) this.pending.delete(key);
    }
  }

  clear(): void {
    this.pending.clear();
  }

  /** Run everything due at `now`. */
  drain(now: SourceTimeMs, ring: AudioRing): DeepDrain {
    const results: DeepResult[] = [];
    let dropped = 0;

    for (const [key, request] of [...this.pending]) {
      if (request.notBefore > now) continue;
      this.pending.delete(key);

      const count = request.toSample - request.fromSample;
      if (count !== this.window.length || !ring.read(this.window, request.fromSample)) {
        // The audio this job was queued about is gone. Dropping it is the only
        // honest option: the ring now holds different music at those indices.
        dropped++;
        continue;
      }

      const evidence = this.spectral.analyze(this.window);
      const activations = this.multiPitch.activations(evidence);
      const reading = this.harmonic.interpret(evidence, activations);
      results.push({
        noteId: request.noteId,
        purpose: request.purpose,
        // The result describes the audio it analysed, not the moment it ran.
        at: this.clock.toMs(request.toSample),
        evidence,
        activations,
        reading,
      });
    }

    return { results, dropped };
  }

  /** Run every pending job regardless of its due time. Used by `flush()`. */
  drainAll(ring: AudioRing): DeepDrain {
    return this.drain(Number.POSITIVE_INFINITY, ring);
  }
}
