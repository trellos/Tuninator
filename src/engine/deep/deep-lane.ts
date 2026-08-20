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
  DeepSegmentation,
  HarmonicReading,
  PitchActivation,
  RegionWindowReading,
  SpectralEvidence,
} from "../contracts.js";
import { segmentRegion } from "./resegment.js";
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

/**
 * A request to re-segment a whole region of audio.
 *
 * Deliberately not a `DeepRequest`: there is no `noteId`, because the answer is
 * how many events the region contains, and a lane that is told whose audio it
 * is looking at can only ever agree. `holdNoteIds` is bookkeeping in the other
 * direction — the Notes that must not finish until this has been ruled on — and
 * it never reaches the result.
 */
export type DeepRegionRequest = {
  /** Inclusive start of the audio to analyse. */
  fromSample: number;
  /** Exclusive end. */
  toSample: number;
  /** Source time this result may be applied at. */
  notBefore: SourceTimeMs;
  /** Notes held open until the region is ruled on. Not part of the answer. */
  holdNoteIds: readonly string[];
  /**
   * Every transient the fast lane saw inside the span, ascending.
   *
   * Not an instruction and not a partition — the fast lane's own segmentation
   * is exactly what the region is being asked to rule on. These are the moments
   * energy demonstrably arrived, which is the one thing an 85ms window cannot
   * establish for itself.
   */
  attackSamples: readonly number[];
};

/** A region the deep lane could not analyse, so its Notes can be let go. */
export type DroppedRegion = {
  fromSample: number;
  toSample: number;
  holdNoteIds: readonly string[];
  reason: "agedOut" | "tooShort";
};

export type DeepDrain = {
  results: DeepResult[];
  /** Region verdicts. Ordered, and never keyed to a Note. */
  segmentations: DeepSegmentation[];
  /** Jobs dropped because their audio had aged out. Surfaced as diagnostics. */
  dropped: number;
  /**
   * Regions that could not be analysed. Reported rather than swallowed: a Note
   * waiting on a region that never arrives would never finish.
   */
  droppedRegions: DroppedRegion[];
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
  /**
   * The one pending region, or null.
   *
   * One rather than a queue, and a newer request supersedes an older: a region
   * always runs from the oldest Note nobody has ruled on to now, so a later
   * request covers everything an earlier one did and more. Queueing them would
   * analyse the same audio several times and then apply the stalest answer
   * last, which is precisely the ordering hazard this change has to avoid.
   */
  private pendingRegion: DeepRegionRequest | null = null;

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
    return this.pending.size + (this.pendingRegion === null ? 0 : 1);
  }

  /** True while a region is queued. */
  get hasPendingRegion(): boolean {
    return this.pendingRegion !== null;
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

  /**
   * Queue a re-segmentation of a whole region.
   *
   * A later request replaces an earlier one wholesale, carrying its held Notes
   * forward: whatever the older region was going to rule on, the newer one
   * still covers.
   */
  requestRegion(request: DeepRegionRequest): void {
    const previous = this.pendingRegion;
    if (previous === null) {
      this.pendingRegion = request;
      return;
    }
    const held = new Set<string>([...previous.holdNoteIds, ...request.holdNoteIds]);
    const attacks = new Set<number>([...previous.attackSamples, ...request.attackSamples]);
    this.pendingRegion = {
      fromSample: Math.min(previous.fromSample, request.fromSample),
      toSample: Math.max(previous.toSample, request.toSample),
      notBefore: Math.min(previous.notBefore, request.notBefore),
      holdNoteIds: [...held],
      attackSamples: [...attacks].sort((a, b) => a - b),
    };
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
    for (const id of this.pendingRegion?.holdNoteIds ?? []) out.add(id);
    return out;
  }

  forget(noteId: string): void {
    for (const [key, request] of [...this.pending]) {
      if (request.noteId === noteId) this.pending.delete(key);
    }
    const region = this.pendingRegion;
    if (region !== null && region.holdNoteIds.includes(noteId)) {
      this.pendingRegion = {
        ...region,
        holdNoteIds: region.holdNoteIds.filter((id) => id !== noteId),
      };
    }
  }

  clear(): void {
    this.pending.clear();
    this.pendingRegion = null;
  }

  /** Run everything due at `now`. */
  drain(now: SourceTimeMs, ring: AudioRing): DeepDrain {
    const results: DeepResult[] = [];
    const segmentations: DeepSegmentation[] = [];
    const droppedRegions: DroppedRegion[] = [];
    let dropped = 0;

    // The region runs first. Its verdict is about how many events there were,
    // which every per-Note reading in the same drain is then filed against —
    // applying a Note's harmony before finding out the Note is about to be
    // split in two files the evidence under whichever half happens to exist.
    const region = this.pendingRegion;
    if (region !== null && region.notBefore <= now) {
      this.pendingRegion = null;
      const segmentation = this.analyzeRegion(region, ring);
      if (segmentation === null) {
        droppedRegions.push({
          fromSample: region.fromSample,
          toSample: region.toSample,
          holdNoteIds: region.holdNoteIds,
          reason:
            region.toSample - region.fromSample < this.spectral.windowSize
              ? "tooShort"
              : "agedOut",
        });
      } else {
        segmentations.push(segmentation);
      }
    }

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

    return { results, segmentations, dropped, droppedRegions };
  }

  /**
   * Walk a region window by window and hand back what it contains.
   *
   * Returns null when the audio is not there any more, or when the region is
   * shorter than one analysis window — both are honest refusals rather than
   * guesses, and both release the Notes that were waiting on the answer.
   */
  private analyzeRegion(
    request: DeepRegionRequest,
    ring: AudioRing
  ): DeepSegmentation | null {
    const windowSize = this.spectral.windowSize;
    const span = request.toSample - request.fromSample;
    if (span < windowSize) return null;
    if (!ring.has(request.fromSample, span)) return null;

    const deep = this.config.deep;
    const available = span - windowSize;
    const hop = Math.max(1, deep.regionHopSamples);
    let count = Math.floor(available / hop) + 1;
    let stride = hop;
    if (count > deep.maxRegionWindows) {
      // Rather than truncate the region — which would silently rule on only
      // part of it — look at the whole span more coarsely and say so through
      // the boundary resolution.
      stride = Math.ceil(available / Math.max(1, deep.maxRegionWindows - 1));
      count = Math.floor(available / stride) + 1;
    }

    const windows: RegionWindowReading[] = [];
    for (let i = 0; i < count; i++) {
      const from = request.fromSample + i * stride;
      const to = from + windowSize;
      if (!ring.read(this.window, from)) return null;

      const evidence = this.spectral.analyze(this.window);
      const activations = this.multiPitch.activations(evidence);
      const reading = this.harmonic.interpret(evidence, activations);

      let dominantMidi: number | null = null;
      let leader = -1;
      let runnerUp = 0;
      for (const activation of activations) {
        if (activation.salience > leader) {
          runnerUp = leader < 0 ? 0 : leader;
          leader = activation.salience;
          dominantMidi = activation.midi;
        } else if (activation.salience > runnerUp) {
          runnerUp = activation.salience;
        }
      }

      let sum = 0;
      for (let k = 0; k < windowSize; k++) {
        const sample = this.window[k] as number;
        sum += sample * sample;
      }

      windows.push({
        fromSample: from,
        toSample: to,
        at: this.clock.toMs(to),
        dominantMidi,
        runnerUpSalience: runnerUp,
        rms: Math.sqrt(sum / windowSize),
        activations,
        evidence,
        reading,
      });
    }

    const samplesPerMs = this.clock.sampleRate / 1000;
    const segments = segmentRegion(windows, {
      minSegmentMs: deep.minSegmentMs,
      holdWindows: deep.segmentHoldWindows,
      riseRatio: deep.segmentRiseRatio,
      attackSamples: request.attackSamples,
      attackRiseRatio: deep.segmentAttackRiseRatio,
      windowSize,
      samplesPerMs,
    });

    let confidence = 0;
    for (const segment of segments) confidence += segment.confidence;

    return {
      fromSample: request.fromSample,
      toSample: request.toSample,
      from: this.clock.toMs(request.fromSample),
      to: this.clock.toMs(request.toSample),
      segments,
      windowCount: windows.length,
      confidence: segments.length === 0 ? 0 : confidence / segments.length,
    };
  }

  /** Run every pending job regardless of its due time. Used by `flush()`. */
  drainAll(ring: AudioRing): DeepDrain {
    return this.drain(Number.POSITIVE_INFINITY, ring);
  }
}
