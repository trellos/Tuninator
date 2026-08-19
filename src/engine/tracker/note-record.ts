/**
 * One Note's mutable interior, and the immutable snapshot handed out for it.
 *
 * The public `Note` is a value: handlers may hold it, compare it, put it in a
 * React state. Nothing they hold may ever change underneath them, so every
 * emission is a structural copy and `revision.revisionNumber` makes a held
 * snapshot's staleness checkable without deep-comparing anything.
 *
 * The interior is where the evidence lives: the vote tallies, the running
 * amplitude baselines, the hypothesis tracker. None of it is public, because
 * all of it is detector bookkeeping rather than musical fact.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type {
  DetectedPitch,
  Note,
  NoteChangeType,
  NoteLifecycle,
  NoteOriginTrigger,
  PitchClass,
  SourceTimeMs,
} from "../../types.js";
import type { EngineConfig } from "../config.js";
import type { ConfidenceParts, PitchActivation } from "../contracts.js";
import { DefaultConfidenceModel } from "./confidence.js";
import { StatefulHypothesisTracker, type HypothesisTransition } from "./hypotheses.js";
import { VoiceDecay } from "./voices.js";

const confidenceModel = new DefaultConfidenceModel();

/** One chord reading's accumulated evidence over a Note's life. */
export type HarmonyVote = {
  label: string;
  root: PitchClass;
  quality: string;
  /** Summed template score across the confident hops that voted for it. */
  weight: number;
  /** How many confident hops voted for it. */
  hops: number;
};

export class NoteRecord {
  readonly id: string;
  readonly hypotheses: StatefulHypothesisTracker;

  startTime: SourceTimeMs;
  startSample: number;
  endTime: SourceTimeMs | null = null;
  lifecycle: NoteLifecycle = "started";

  readonly trigger: NoteOriginTrigger;
  originPitch: DetectedPitch | null;
  readonly initialConfidence: number;

  /** Pitch the Note is measured against; bends are relative to this. */
  refFrequencyHz: number | null;
  currentFrequencyHz: number | null;
  currentPitch: DetectedPitch | null = null;
  pitchConfidence = 0;

  lastVoicedHz: number | null;
  lastVoicedAt: SourceTimeMs;
  /**
   * When this Note was last *audible*, which is not the same as last pitched.
   *
   * A strummed chord has no single periodicity for YIN to find, so a Note whose
   * life is measured in voiced frames can sound for two seconds and never be
   * announced. Announcement is about whether something was really played, and
   * that is a question about energy.
   */
  lastAudibleAt: SourceTimeMs;
  lastSeenAt: SourceTimeMs;
  unvoicedSince: SourceTimeMs | null = null;
  /** When the audio last fell below the gate, or null while it is audible. */
  silentSince: SourceTimeMs | null = null;

  /** Emitted `noteStarted` yet. A Note too short to be real never does. */
  announced = false;
  resolvedAnnounced = false;
  revisionNumber = 0;
  lastChangeType: NoteChangeType | null = null;

  frames = 0;
  confidenceSum = 0;
  maxRms: number;
  maxPeak: number;
  rms: number;
  /** Short rolling mean of rms — the baseline a re-pick has to rise above. */
  sustainedRms: number;
  /** This Note's own decay, fitted from its envelope. See `voices.ts`. */
  readonly decay = new VoiceDecay();

  /**
   * Confidence-weighted evidence for each MIDI note. The Note is labeled from
   * the strongest, not from the newest frame: a Note whose boundary is off by
   * part of a note bleeds into its neighbour, and labelling from the last frame
   * hands it the neighbour's name.
   */
  readonly noteVotes = new Map<number, number>();

  /**
   * The harmonic counterpart. A strum's third decays far faster than its root
   * and fifth, so by the end of a Note the chroma has collapsed to a power
   * chord and the last frame names a Bm "B5".
   */
  readonly harmonyVotes = new Map<string, HarmonyVote>();
  /**
   * More than one string is sounding, on the deep lane's evidence.
   *
   * Set from the first deep reading, long before the Note has enough evidence
   * to be *named*, because it changes segmentation immediately: YIN's
   * fundamental is meaningless on a strummed chord, so "the arriving pitch
   * differs from this Note's" stops being a reason to split.
   */
  polyphonic = false;
  harmonyBloomed = false;
  /** This Note has committed to a chord name at least once. */
  harmonyNamed = false;
  harmonyLabel: string | null = null;
  harmonyRoot: PitchClass | null = null;
  harmonyQuality: string | null = null;
  harmonyConfidence = 0;
  harmonyIntervals: string[] = [];
  harmonyBass: DetectedPitch | null = null;
  harmonyPitches: DetectedPitch[] = [];
  harmonyAlternatives: Array<{ label: string; confidence: number }> = [];
  uniquePitchClassCount: number | undefined;
  estimatedVoiceCount: { value: number; confidence: number } | undefined;
  polyphonySum = 0;
  polyphonyHops = 0;

  bendActive = false;
  bendDirection: "up" | "down" = "up";
  bendCents = 0;
  bendPeakCents = 0;
  bendReleaseDetected = false;
  bendConfidence = 0;

  /** A rival harmony reading, held until it proves it is not a flap. */
  pendingHarmonyRoot: PitchClass | null = null;
  pendingHarmonySince = 0;
  /**
   * Votes cast since `pendingHarmonySince` — the evidence arguing for the
   * change. A split backdates the boundary to that moment, so these readings
   * end up inside the NEW Note's span and are handed to it. Without that the
   * new Note loses its whole attack as evidence, which is the part where the
   * third is still sounding.
   */
  readonly pendingHarmonyVotes = new Map<string, HarmonyVote>();

  /**
   * The Note is over, but its `resolved`/`ended` events are held back until the
   * deep lane has said its last word about it. A chord's identity is often only
   * settled by analysis that started before the strum stopped.
   */
  closing = false;

  /**
   * This Note turned out to be part of another one and has been absorbed.
   *
   * Its already-delivered events stand — history is never rewritten — but the
   * recognizer no longer stands behind it as a separate event, and anything
   * summarising the final state should follow the `structuralRevision` on the
   * survivor rather than counting this Note again.
   */
  merged = false;

  spectralFit: number | undefined;
  contour: Array<readonly [SourceTimeMs, number, number]> = [];

  /** What was last emitted, so an update fires on change rather than per hop. */
  lastEmitted = { label: "", confidence: -1, bendCents: 0, lifecycle: "started" as NoteLifecycle };

  /**
   * Hypothesis transitions observed since the last emission, oldest first.
   *
   * Queued rather than emitted inline because a single hop can promote one
   * reading and discredit two others, and a consumer wants the resulting
   * events in order, after the Note snapshot that reflects all of them.
   */
  readonly pendingTransitions: HypothesisTransition[] = [];

  private readonly config: EngineConfig;

  constructor(options: {
    id: string;
    config: EngineConfig;
    startTime: SourceTimeMs;
    startSample: number;
    trigger: NoteOriginTrigger;
    frequencyHz: number | null;
    originPitch: DetectedPitch | null;
    confidence: number;
    rms: number;
    peak: number;
  }) {
    this.id = options.id;
    this.config = options.config;
    this.hypotheses = new StatefulHypothesisTracker(options.id);
    this.startTime = options.startTime;
    this.startSample = options.startSample;
    this.trigger = options.trigger;
    this.originPitch = options.originPitch;
    this.initialConfidence = options.confidence;
    this.refFrequencyHz = options.frequencyHz;
    this.currentFrequencyHz = options.frequencyHz;
    this.currentPitch = options.originPitch;
    this.pitchConfidence = options.confidence;
    this.lastVoicedHz = options.frequencyHz;
    this.lastVoicedAt = options.startTime;
    this.lastAudibleAt = options.startTime;
    this.lastSeenAt = options.startTime;
    this.rms = options.rms;
    this.maxRms = options.rms;
    this.maxPeak = options.peak;
    this.sustainedRms = options.rms;

    if (options.originPitch !== null) {
      this.noteVotes.set(options.originPitch.midi, options.confidence);
      this.hypotheses.observe("pitch", options.originPitch.name, options.confidence, options.startTime);
    }
  }

  /** How long the Note has actually sounded, not how long ago it began. */
  get soundedMs(): number {
    return Math.max(this.lastVoicedAt, this.lastAudibleAt) - this.startTime;
  }

  /** The bar this Note has to clear to be announced. See the config comments. */
  get announceThresholdMs(): number {
    const pitched = this.lastVoicedAt > this.startTime || this.harmonyBloomed;
    return pitched
      ? this.config.tracking.minStableMs
      : this.config.tracking.minUnpitchedStableMs;
  }

  get durationMs(): number {
    return (this.endTime ?? this.lastSeenAt) - this.startTime;
  }

  /** Most-voted MIDI note. Ties break low, so the result is order-independent. */
  dominantMidi(): number | null {
    let bestMidi: number | null = null;
    let bestCount = -1;
    for (const [midi, count] of this.noteVotes) {
      if (count > bestCount || (count === bestCount && bestMidi !== null && midi < bestMidi)) {
        bestCount = count;
        bestMidi = midi;
      }
    }
    return bestMidi;
  }

  confidenceParts(): ConfidenceParts {
    const parts: ConfidenceParts = {
      pitch: this.frames > 0 ? this.confidenceSum / this.frames : this.initialConfidence,
      stability: Math.min(1, this.soundedMs / Math.max(1, this.config.tracking.minStableMs)),
      amplitude: Math.min(1, this.maxRms / 0.1),
    };
    if (this.spectralFit !== undefined) parts.spectralFit = this.spectralFit;
    return parts;
  }

  overallConfidence(): number {
    return confidenceModel.blend(this.confidenceParts());
  }

  /** The name this Note would answer to right now. */
  currentLabel(): string {
    if (this.harmonyBloomed) return this.harmonyLabel ?? "unknown";
    return this.currentPitch?.name ?? "unknown";
  }

  bump(type: NoteChangeType): number {
    this.revisionNumber++;
    this.lastChangeType = type;
    return this.revisionNumber;
  }

  addContourPoint(at: SourceTimeMs, hz: number, confidence: number): void {
    if (!this.config.diagnostics.contour) return;
    this.contour.push([at, hz, confidence]);
    if (this.contour.length > this.config.tracking.maxContourPoints) this.contour.shift();
  }

  recordActivations(activations: readonly PitchActivation[]): void {
    this.harmonyPitches = activations.map((a) => ({
      midi: a.midi,
      name: `${a.pitchClass}${a.octave}`,
      pitchClass: a.pitchClass,
      octave: a.octave,
      frequencyHz: a.frequencyHz,
      role: "chordTone" as const,
      confidence: a.confidence,
      salience: a.salience,
    }));
    const classes = new Set(activations.map((a) => a.pitchClass));
    this.uniquePitchClassCount = classes.size;
  }

  snapshot(): Note {
    const note: Note = {
      id: this.id,
      startTime: this.startTime,
      endTime: this.endTime,
      lifecycle: this.lifecycle,
      origin: {
        firstDetectedPitch: this.originPitch === null ? null : { ...this.originPitch },
        initialConfidence: this.initialConfidence,
        trigger: this.trigger,
      },
      pitch: {
        confidence: this.pitchConfidence,
      },
      hypotheses: this.hypotheses.snapshot(),
      revision: {
        lastChangeType: this.lastChangeType,
        revisionNumber: this.revisionNumber,
      },
      confidence: this.overallConfidence(),
      amplitude: { rms: this.rms, peak: this.maxPeak },
    };

    if (this.currentFrequencyHz !== null) note.pitch.currentFrequencyHz = this.currentFrequencyHz;
    if (this.currentPitch !== null) note.pitch.current = { ...this.currentPitch };
    if (this.config.diagnostics.contour && this.contour.length > 0) {
      note.pitch.contour = this.contour.map((p) => [p[0], p[1], p[2]] as const);
    }

    if (this.bendActive || this.bendPeakCents !== 0) {
      note.bend = {
        active: this.bendActive,
        direction: this.bendDirection,
        amountCents: this.bendCents,
        peakAmountCents: this.bendPeakCents,
        releaseDetected: this.bendReleaseDetected,
        confidence: this.bendConfidence,
      };
    }

    if (this.harmonyBloomed) {
      const harmony: NonNullable<Note["harmony"]> = {
        confidence: this.harmonyConfidence,
      };
      if (this.harmonyRoot !== null) harmony.root = this.harmonyRoot;
      if (this.harmonyQuality !== null) harmony.quality = this.harmonyQuality;
      if (this.harmonyLabel !== null) harmony.chordName = this.harmonyLabel;
      if (this.harmonyIntervals.length > 0) harmony.intervals = [...this.harmonyIntervals];
      if (this.harmonyBass !== null) harmony.bass = { ...this.harmonyBass };
      if (this.harmonyPitches.length > 0) {
        harmony.detectedPitches = this.harmonyPitches.map((p) => ({ ...p }));
      }
      if (this.uniquePitchClassCount !== undefined) {
        harmony.uniquePitchClassCount = this.uniquePitchClassCount;
      }
      if (this.estimatedVoiceCount !== undefined) {
        harmony.estimatedVoiceCount = { ...this.estimatedVoiceCount };
      }
      note.harmony = harmony;
    }

    return note;
  }
}
