/**
 * The semantic centre: fast-lane evidence in, evolving Notes out.
 *
 * Successor to `core/event-tracker.ts`, and the file the rewrite exists for.
 * Three things changed, and they are all consequences of one another:
 *
 *  1. **Notes live in a Map, not in an `active: Active | null`.** The old
 *     tracker could represent exactly one sounding thing, so a note beginning
 *     while another still rang was structurally impossible — which is precisely
 *     what a restrum over a ringing chord, and a fast run over a decaying tail,
 *     both are. The Map is here from the first phase even while only one Note
 *     opens at a time, because retrofitting it later means rewriting every
 *     path in this file.
 *
 *  2. **There are no modes.** The old chord path and note path were different
 *     code reached by a caller-declared mode, and a chord played in lead mode
 *     was simply never a chord. Here one path runs, segmentation is driven by
 *     the same three cues regardless of what is being played — an attack, a
 *     pitch step, a harmony change — and a Note blooms into a chord when the
 *     deep lane finds evidence for one.
 *
 *  3. **A Note is a belief, not a measurement.** It starts as soon as there is
 *     evidence something was played and improves from there, and every
 *     improvement is delivered as a typed `NoteChange` so a consumer can tell
 *     "I know more now" from "I was wrong".
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type {
  DetectedPitch,
  Note,
  NoteChange,
  NoteChangeType,
  NoteOriginTrigger,
  SourceTimeMs,
} from "../../types.js";
import type { EngineConfig } from "../config.js";
import type { AttackEvidence, FastFrame, HarmonicReading, PitchActivation } from "../contracts.js";
import { SampleClock } from "../clock.js";
import { describeFrequency, midiToFrequency } from "../kernels/notes.js";
import { PitchChangeDetector, centsBetween } from "../fast/pitch-change.js";
import { RearticulationDetector } from "../fast/rearticulation.js";
import { NoteRecord } from "./note-record.js";
import { classifyHarmonyChange, classifyPitchChange } from "./revision.js";

export type TrackerEmission =
  | { type: "started"; note: Note }
  | { type: "changed"; note: Note; change: NoteChange }
  | { type: "resolved"; note: Note }
  | { type: "ended"; note: Note };

/** Weight of the newest frame in the rolling amplitude baseline. */
const RMS_BASELINE_ALPHA = 0.25;

/** Confidence movement below this is not worth an event. */
const CONFIDENCE_EPSILON = 0.15;
/** Bend movement below this is not worth an event, in cents. */
const BEND_EPSILON = 10;

export class NoteTracker {
  private readonly config: EngineConfig;
  private readonly clock: SampleClock;
  private readonly pitchChange: PitchChangeDetector;
  private readonly rearticulation: RearticulationDetector;

  /** Every Note not yet ended. Plural from day one; see the header. */
  private readonly notes = new Map<string, NoteRecord>();
  /** Recently ended Notes, so `getNote()` can still answer for them. */
  private readonly ended: NoteRecord[] = [];

  private nextId = 1;
  private lastAttack: AttackEvidence | null = null;
  /** End of the most recently closed Note, so backdating cannot overlap it. */
  private lastEndedAt: SourceTimeMs | null = null;

  constructor(clock: SampleClock, config: EngineConfig) {
    this.clock = clock;
    this.config = config;
    this.pitchChange = new PitchChangeDetector(config);
    this.rearticulation = new RearticulationDetector(config);
  }

  reset(): void {
    this.notes.clear();
    this.ended.length = 0;
    this.nextId = 1;
    this.lastAttack = null;
    this.lastEndedAt = null;
    this.pitchChange.reset();
  }

  getActiveNotes(): Note[] {
    const out: Note[] = [];
    for (const record of this.notes.values()) {
      if (record.announced) out.push(record.snapshot());
    }
    return out;
  }

  getNote(id: string): Note | undefined {
    const active = this.notes.get(id);
    if (active !== undefined) return active.snapshot();
    for (let i = this.ended.length - 1; i >= 0; i--) {
      const record = this.ended[i] as NoteRecord;
      if (record.id === id) return record.snapshot();
    }
    return undefined;
  }

  /** The Note the fast lane is currently describing. */
  private current(): NoteRecord | null {
    let latest: NoteRecord | null = null;
    for (const record of this.notes.values()) {
      if (latest === null || record.startTime >= latest.startTime) latest = record;
    }
    return latest;
  }

  process(frame: FastFrame): TrackerEmission[] {
    const out: TrackerEmission[] = [];
    const t = frame.at;
    const config = this.config;

    const pitchChange = this.pitchChange.observe(frame);
    const gliding = this.pitchChange.isGliding();

    if (frame.attack !== null && !frame.gated) this.lastAttack = frame.attack;

    let active = this.current();

    /* (a) An attack over something already sounding: a restrum or a re-pick.
     *     Only a genuine energy injection counts, and never mid-glide — a bend
     *     sweeps the spectrum, which fires both attack witnesses repeatedly
     *     inside what is musically one note. */
    if (frame.attack !== null && active !== null) {
      const rearticulated = this.rearticulation.isRearticulation(
        frame.attack,
        frame,
        gliding,
        active.sustainedRms
      );
      if (rearticulated && active.soundedMs >= config.tracking.minStableMs) {
        this.end(active, frame.attack.at, out);
        active = null;
      }
    }

    /* (b) A confirmed pitch step with no attack: a legato move. The boundary is
     *     the FIRST frame that showed the new pitch, not the one that confirmed
     *     it, or every note in a run starts a hop and a half late. */
    if (
      active !== null &&
      pitchChange !== null &&
      pitchChange.kind === "step" &&
      !active.harmonyBloomed
    ) {
      const at = Math.max(pitchChange.at, active.startTime);
      this.end(active, at, out);
      active = this.begin("pitchChange", frame, out, {
        at,
        atSample: Math.max(pitchChange.atSample, 0),
        frequencyHz: pitchChange.toHz,
      });
    }

    /* (c) Nothing is sounding and something just happened. */
    if (active === null) {
      const voiced = frame.pitch.frequencyHz !== null;
      const struck = frame.attack !== null && !frame.gated;
      if (voiced || struck) {
        active = this.begin(struck ? "attack" : "pitchChange", frame, out, null);
      }
    }

    /* (d) Fold this hop into whatever is sounding, or age it toward its end. */
    if (active !== null) {
      const silent = frame.gated;
      const unvoiced = frame.pitch.frequencyHz === null;

      if (silent || unvoiced) {
        if (active.unvoicedSince === null) active.unvoicedSince = t;
        const held = t - active.unvoicedSince;
        // A harmonically-bloomed Note is not ended by losing its fundamental —
        // a strummed chord has no single periodicity for YIN to hold onto —
        // only by going quiet.
        const expired = silent
          ? held >= config.tracking.releaseGraceMs
          : !active.harmonyBloomed && held >= config.tracking.releaseGraceMs;
        if (expired) {
          this.end(active, active.unvoicedSince, out);
          active = null;
        } else {
          this.observe(active, frame, gliding);
        }
      } else {
        active.unvoicedSince = null;
        this.observe(active, frame, gliding);
      }
    }

    this.publish(out);
    return out;
  }

  /**
   * Apply a deep-lane harmonic reading to a Note the fast lane already
   * reported on. This is where a Note blooms into a chord.
   */
  applyHarmony(
    noteId: string,
    reading: HarmonicReading,
    activations: readonly PitchActivation[],
    polyphony: number,
    at: SourceTimeMs
  ): TrackerEmission[] {
    const out: TrackerEmission[] = [];
    const record = this.notes.get(noteId) ?? this.endedRecord(noteId);
    if (record === undefined) return out;

    record.polyphonySum += polyphony;
    record.polyphonyHops++;
    record.recordActivations(activations);

    if (reading.chordName !== null && reading.root !== null) {
      record.hypotheses.observe("harmony", reading.chordName, reading.confidence, at);
    }

    const previousRoot = record.harmonyRoot;
    const previousQuality = record.harmonyQuality;
    const previousLabel = record.harmonyLabel;

    const bloomed = record.harmonyBloomed;
    record.harmonyBloomed = true;
    record.harmonyRoot = reading.root;
    record.harmonyQuality = reading.quality;
    record.harmonyLabel = reading.chordName;
    record.harmonyConfidence = reading.confidence;
    record.harmonyIntervals = reading.intervals;
    record.harmonyAlternatives = reading.alternatives;
    record.spectralFit = reading.confidence;
    record.estimatedVoiceCount = {
      value: record.polyphonyHops > 0 ? record.polyphonySum / record.polyphonyHops : polyphony,
      confidence: reading.confidence,
    };
    if (reading.bass !== null) {
      record.harmonyBass = {
        midi: reading.bass.midi,
        name: `${reading.bass.pitchClass}${reading.bass.octave}`,
        pitchClass: reading.bass.pitchClass,
        octave: reading.bass.octave,
        frequencyHz: reading.bass.frequencyHz,
        role: "bass",
        confidence: reading.bass.confidence,
        salience: reading.bass.salience,
      };
    }

    // A Note that has just learned it is a chord has not been corrected — the
    // pitch it reported is a member of that chord. Say so, rather than
    // discarding it.
    if (!bloomed && record.currentPitch !== null && reading.chordName !== null) {
      record.hypotheses.incorporate("pitch", record.currentPitch.name, reading.chordName, at);
    }
    if (
      bloomed &&
      previousLabel !== null &&
      reading.chordName !== null &&
      previousLabel !== reading.chordName
    ) {
      record.hypotheses.supersede("harmony", previousLabel, reading.chordName, at);
    }
    record.hypotheses.settle("harmony", at);

    const type: NoteChangeType = bloomed
      ? classifyHarmonyChange(previousRoot, previousQuality, reading.root, reading.quality)
      : "harmonyEnrichment";

    if (record.announced && record.endTime === null) {
      const revisionNumber = record.bump(type);
      const change: NoteChange = { type, at, revisionNumber };
      if (bloomed && previousLabel !== null && type === "harmonyCorrection") {
        change.previous = { label: previousLabel };
      }
      out.push({ type: "changed", note: record.snapshot(), change });
      record.lastEmitted.label = record.currentLabel();
    } else {
      record.bump(type);
    }
    return out;
  }

  /** Ends every open Note. Called on stop, and at the end of offline input. */
  flush(at: SourceTimeMs): TrackerEmission[] {
    const out: TrackerEmission[] = [];
    for (const record of [...this.notes.values()]) {
      this.end(record, Math.max(at, record.startTime), out);
    }
    this.publish(out);
    return out;
  }

  /* ------------------------------------------------------------------ */

  private begin(
    trigger: NoteOriginTrigger,
    frame: FastFrame,
    out: TrackerEmission[],
    override: { at: SourceTimeMs; atSample: number; frequencyHz: number | null } | null
  ): NoteRecord {
    const frequencyHz = override?.frequencyHz ?? frame.pitch.frequencyHz;
    let at = override?.at ?? frame.at;
    let atSample = override?.atSample ?? frame.sampleIndex;

    if (override === null) {
      // A Note begins at its attack, not at the moment the pitch tracker became
      // confident about it. YIN has to wait for its window to fill with the new
      // note and for the median to turn over; the transient detector localises
      // the attack far better. Without this backdating the whole Note slides
      // late, and on a 166ms triplet a late Note spends most of its frames on
      // the FOLLOWING note.
      const attack = this.lastAttack;
      if (attack !== null && frame.at - attack.at <= this.config.tracking.backdateWindowMs) {
        at = attack.at;
        atSample = attack.atSample;
        if (this.lastEndedAt !== null && at < this.lastEndedAt) {
          at = this.lastEndedAt;
          atSample = this.clock.toSamples(at);
        }
      }
    }

    const nearest = frequencyHz === null ? null : describeFrequency(frequencyHz);
    const originPitch: DetectedPitch | null =
      nearest === null
        ? null
        : {
            midi: nearest.midi,
            name: nearest.name,
            pitchClass: nearest.pitchClass,
            octave: nearest.octave,
            frequencyHz: nearest.frequencyHz,
            centsOffset: nearest.cents,
            role: "first",
            confidence: frame.pitch.confidence,
          };

    const record = new NoteRecord({
      id: `n${this.nextId++}`,
      config: this.config,
      startTime: at,
      startSample: atSample,
      trigger,
      frequencyHz,
      originPitch,
      confidence: frame.pitch.confidence,
      rms: frame.rms,
      peak: frame.peak,
    });
    this.notes.set(record.id, record);
    if (frequencyHz !== null) this.pitchChange.clearAfterSplit(frequencyHz, at);
    void out;
    return record;
  }

  /** Folds one hop's evidence into a Note. */
  private observe(record: NoteRecord, frame: FastFrame, gliding: boolean): void {
    const config = this.config;
    const t = frame.at;

    record.frames++;
    record.confidenceSum += frame.pitch.confidence;
    record.rms = frame.rms;
    record.maxRms = Math.max(record.maxRms, frame.rms);
    record.maxPeak = Math.max(record.maxPeak, frame.peak);
    record.sustainedRms =
      record.sustainedRms * (1 - RMS_BASELINE_ALPHA) + frame.rms * RMS_BASELINE_ALPHA;
    record.lastSeenAt = t;

    const hz = frame.pitch.frequencyHz;
    if (hz === null) {
      if (record.lifecycle === "started") record.lifecycle = "enriching";
      return;
    }

    // A Note begins at its attack, which is routinely a hop or two before any
    // pitch is measurable — the attack transient is the least periodic part of
    // a note. The origin pitch is therefore the first pitch actually detected,
    // not whatever was (not) known at the instant the Note opened, and the bend
    // reference is that same first real pitch.
    if (record.refFrequencyHz === null) {
      record.refFrequencyHz = hz;
      const first = describeFrequency(hz);
      record.originPitch = {
        midi: first.midi,
        name: first.name,
        pitchClass: first.pitchClass,
        octave: first.octave,
        frequencyHz: first.frequencyHz,
        centsOffset: first.cents,
        role: "first",
        confidence: frame.pitch.confidence,
      };
    }

    record.lastVoicedHz = hz;
    record.lastVoicedAt = t;
    record.currentFrequencyHz = hz;
    record.pitchConfidence = frame.pitch.confidence;
    record.addContourPoint(t, hz, frame.pitch.confidence);

    const nearest = describeFrequency(hz);
    record.noteVotes.set(nearest.midi, (record.noteVotes.get(nearest.midi) ?? 0) + 1);
    record.hypotheses.observe("pitch", nearest.name, frame.pitch.confidence, t);

    /* Bend. The label keeps the ORIGIN note across a bend and the excursion
     * lives in `bend`, because "A3 bent up to B3" is one thing the player did,
     * not two notes. */
    const ref = record.refFrequencyHz;
    if (ref !== null) {
      const fromStart = centsBetween(hz, ref);
      if (Math.abs(fromStart) >= config.tracking.bendThresholdCents) {
        if (!record.bendActive) {
          record.hypotheses.observe("bend", "bend", frame.pitch.confidence, t);
        }
        record.bendActive = true;
        record.bendDirection = fromStart >= 0 ? "up" : "down";
        record.bendCents = fromStart;
        record.bendConfidence = frame.pitch.confidence;
        if (Math.abs(fromStart) > Math.abs(record.bendPeakCents)) {
          record.bendPeakCents = fromStart;
        } else if (Math.abs(fromStart) < Math.abs(record.bendPeakCents) * 0.5) {
          record.bendReleaseDetected = true;
        }
      } else if (record.bendActive && Math.abs(record.bendPeakCents) > 0) {
        record.bendReleaseDetected = true;
        record.bendActive = false;
        record.bendCents = fromStart;
      }
    }

    /* Label from the note this Note spent the most frames on, not the newest
     * frame. A single stray frame — or a boundary that slid into the next
     * note — must not rename a settled Note. A bending Note keeps its origin. */
    if (!record.bendActive) {
      const winner = record.dominantMidi();
      const label =
        winner === null || winner === nearest.midi
          ? nearest
          : describeFrequency(midiToFrequency(winner));
      record.currentPitch = {
        midi: label.midi,
        name: label.name,
        pitchClass: label.pitchClass,
        octave: label.octave,
        frequencyHz: hz,
        centsOffset: label.cents,
        role: "first",
        confidence: frame.pitch.confidence,
      };
    } else if (record.currentPitch !== null) {
      record.currentPitch = { ...record.currentPitch, frequencyHz: hz };
    }

    record.hypotheses.settle("pitch", t);
    if (record.lifecycle === "started" && record.soundedMs >= config.tracking.minStableMs) {
      record.lifecycle = "enriching";
    }
    void gliding;
  }

  /** Emits `started` once identity has settled, and `changed` on real changes. */
  private publish(out: TrackerEmission[]): void {
    for (const record of this.notes.values()) {
      if (record.endTime !== null) continue;

      if (!record.announced) {
        // Measure over how long the Note SOUNDED, not wall-clock since it
        // started: a Note in release still ages, so a 24ms blip could otherwise
        // cross a 45ms stability gate purely by sitting in its release grace.
        if (record.soundedMs < this.config.tracking.minStableMs) continue;
        record.announced = true;
        record.lastEmitted = {
          label: record.currentLabel(),
          confidence: record.overallConfidence(),
          bendCents: record.bendCents,
          lifecycle: record.lifecycle,
        };
        out.push({ type: "started", note: record.snapshot() });
        continue;
      }

      const label = record.currentLabel();
      const confidence = record.overallConfidence();
      const last = record.lastEmitted;

      const labelChanged = label !== last.label;
      const bendChanged = Math.abs(record.bendCents - last.bendCents) > BEND_EPSILON;
      const confidenceChanged = Math.abs(confidence - last.confidence) > CONFIDENCE_EPSILON;
      if (!labelChanged && !bendChanged && !confidenceChanged) continue;

      const type: NoteChangeType = labelChanged
        ? classifyPitchChange(last.label, label, record.bendActive)
        : bendChanged
          ? "bendUpdate"
          : "confidenceUpdate";

      const revisionNumber = record.bump(type);
      const change: NoteChange = { type, at: record.lastSeenAt, revisionNumber };
      if (type === "pitchCorrection") change.previous = { label: last.label };

      record.lastEmitted = {
        label,
        confidence,
        bendCents: record.bendCents,
        lifecycle: record.lifecycle,
      };
      out.push({ type: "changed", note: record.snapshot(), change });
    }
  }

  private end(record: NoteRecord, at: SourceTimeMs, out: TrackerEmission[]): void {
    this.notes.delete(record.id);
    const endAt = Math.max(at, record.startTime);
    this.lastEndedAt = endAt;

    if (!record.announced) {
      // Never announced: too short to have been a Note. Drop it rather than
      // emit an end with no matching start. Measured over how long it SOUNDED,
      // the same bar `publish` uses — a blip that spent its whole life in
      // release grace must not qualify just because the grace is long.
      if (record.soundedMs < this.config.tracking.minStableMs) return;
      record.announced = true;
      record.lastEmitted = {
        label: record.currentLabel(),
        confidence: record.overallConfidence(),
        bendCents: record.bendCents,
        lifecycle: record.lifecycle,
      };
      out.push({ type: "started", note: record.snapshot() });
    }

    if (!record.resolvedAnnounced) {
      record.resolvedAnnounced = true;
      record.lifecycle = "resolved";
      record.bump("resolved");
      out.push({ type: "resolved", note: record.snapshot() });
    }

    record.lifecycle = "ended";
    record.endTime = endAt;
    out.push({ type: "ended", note: record.snapshot() });

    this.ended.push(record);
    if (this.ended.length > this.config.tracking.endedNoteHistory) this.ended.shift();
  }

  private endedRecord(id: string): NoteRecord | undefined {
    for (let i = this.ended.length - 1; i >= 0; i--) {
      const record = this.ended[i] as NoteRecord;
      if (record.id === id) return record;
    }
    return undefined;
  }
}
