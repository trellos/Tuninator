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
  PitchClass,
  SourceTimeMs,
} from "../../types.js";
import type { EngineConfig } from "../config.js";
import type { AttackEvidence, FastFrame, HarmonicReading, PitchActivation } from "../contracts.js";
import { SampleClock } from "../clock.js";
import { describeFrequency, midiToFrequency } from "../kernels/notes.js";
import { PitchChangeDetector, centsBetween, isOctaveJump } from "../fast/pitch-change.js";
import { RearticulationDetector } from "../fast/rearticulation.js";
import type { HypothesisTransition } from "./hypotheses.js";
import { NoteRecord, type HarmonyVote } from "./note-record.js";
import { classifyHarmonyChange, classifyPitchChange } from "./revision.js";

export type TrackerEmission =
  | { type: "started"; note: Note }
  | { type: "changed"; note: Note; change: NoteChange }
  | { type: "resolved"; note: Note }
  | { type: "ended"; note: Note };

/**
 * State moves worth telling a consumer about.
 *
 * Reaching `contender` is bookkeeping — every reading passes through it — while
 * becoming the leader, becoming settled, or being ruled out are all things a UI
 * showing the recognizer's thinking would want to react to.
 */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/** No-op comparator: `Array.prototype.sort` is stable, so this preserves order. */
function stableByNothing(): number {
  return 0;
}

const NOTABLE_STATES = new Set(["leading", "confirmed", "discredited", "superseded", "incorporated"]);

function queueTransitions(record: NoteRecord, transitions: HypothesisTransition[]): void {
  for (const transition of transitions) {
    if (!NOTABLE_STATES.has(transition.to)) continue;
    record.pendingTransitions.push(transition);
  }
}

/** Weight of the newest frame in the rolling amplitude baseline. */
const RMS_BASELINE_ALPHA = 0.25;

/**
 * Time constant of the room's harmonic-context estimate, in ms.
 *
 * Slow enough that one confused window during an attack transient does not
 * convince the tracker a chord became a single note, fast enough to notice a
 * player putting the pick down.
 */
const POLYPHONY_CONTEXT_TAU_MS = 250;

/** Ceiling on that estimate's step, however long the gap between readings. */
const POLYPHONY_CONTEXT_MAX_ALPHA = 0.2;

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
  /** Notes that have stopped sounding but whose deep work is still in flight. */
  private readonly closing: NoteRecord[] = [];
  /** Recently ended Notes, so `getNote()` can still answer for them. */
  private readonly ended: NoteRecord[] = [];

  private nextId = 1;
  private lastAttack: AttackEvidence | null = null;
  /**
   * How polyphonic the audio has been lately, independent of any one Note.
   *
   * Polyphony is a property of what is sounding, not of the Note the tracker
   * happens to have open, and keeping it per-Note loses it on every split —
   * which is exactly when it is needed. A chord that fragments into four short
   * Notes would rediscover from scratch, four times, that six strings are
   * ringing, and each rediscovery arrives a deep-lane latency too late to stop
   * the next split. So a new Note inherits the room's polyphony.
   */
  private contextHarmonic = 0;
  private contextUpdatedAt: SourceTimeMs | null = null;
  /**
   * When the audio last *became* harmonic, or null while it is not.
   *
   * Measured on the room rather than on the Note, because that is where the
   * distinction actually lives. A strummed take is continuously harmonic
   * whether or not the tracker happens to have split the current bar into two
   * Notes; a fast run reads as harmonic only in flashes, as an 85ms transform
   * straddles one note boundary and then the next.
   */
  private harmonicSince: SourceTimeMs | null = null;
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
    this.closing.length = 0;
    this.ended.length = 0;
    this.nextId = 1;
    this.lastAttack = null;
    this.lastEndedAt = null;
    this.contextHarmonic = 0;
    this.contextUpdatedAt = null;
    this.harmonicSince = null;
    this.pitchChange.reset();
  }

  getActiveNotes(): Note[] {
    const out: Note[] = [];
    for (const record of this.notes.values()) {
      if (record.announced) out.push(record.snapshot());
    }
    return out;
  }

  /** Ids of every Note still open, for the deep lane to queue work against. */
  activeNoteIds(): string[] {
    return [...this.notes.keys()];
  }

  getNote(id: string): Note | undefined {
    const active = this.notes.get(id);
    if (active !== undefined) return active.snapshot();
    for (const record of this.closing) {
      if (record.id === id) return record.snapshot();
    }
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
    /** Set when a split ends a Note whose successor should inherit its decay. */
    let splitFrom: NoteRecord | null = null;

    /* (a) An attack over something already sounding: a restrum or a re-pick.
     *     Only a genuine energy injection counts, and never mid-glide — a bend
     *     sweeps the spectrum, which fires both attack witnesses repeatedly
     *     inside what is musically one note. */
    if (frame.attack !== null && active !== null) {
      // Compared by pitch CLASS, not by MIDI note. On a sustained chord YIN
      // reports whichever string dominates the window and flips freely between
      // them — and on a single ringing string it flips between the fundamental
      // and its octave. Both read as "the pitch changed" and neither is a new
      // note. A genuinely new note in a line changes the pitch class.
      const arriving = frame.pitch.nearest?.midi ?? null;
      const sounding = active.dominantMidi();
      const pitchDiffers =
        arriving !== null &&
        sounding !== null &&
        (((arriving - sounding) % 12) + 12) % 12 !== 0 &&
        frame.pitch.confidence >= config.pitch.splitConfidence;
      const rearticulated = this.rearticulation.isRearticulation(
        frame.attack,
        frame,
        gliding,
        active.sustainedRms,
        pitchDiffers,
        active.decay.excess(frame.at, frame.rms),
        // A Note that has actually named a chord, not merely one sounding while
        // the room happens to read as harmonic. The decay model describes a
        // struck chord ringing out; applying it to a bent or vibratoed single
        // note describes nothing.
        active.harmonyLabel !== null,
        active.soundedMs
      );
      // A harmonically-named Note has proved it is a chord, and a chord's own
      // ring-out is full of transient-looking energy for hundreds of
      // milliseconds. A Note that has only ever been a single pitch has no such
      // internal structure and may be re-articulated as soon as it is real.
      const settled =
        active.harmonyLabel !== null
          ? active.lastSeenAt - active.startTime >= config.transient.minRestrumMs
          : active.soundedMs >= config.tracking.minStableMs;
      if (rearticulated && settled) {
        this.end(active, frame.attack.at, out);
        // The successor is created below, once this hop has decided what it is.
        // It inherits the decay: a restrum re-excites the strings that were
        // already ringing, so the curve is continuous through the split.
        splitFrom = active;
        active = null;
      }
    }

    /* (b) A confirmed pitch step with no attack: a legato move. The boundary is
     *     the FIRST frame that showed the new pitch, not the one that confirmed
     *     it, or every note in a run starts a hop and a half late. */
    // On polyphonic audio a YIN step is not a note boundary. There is no single
    // period to find in a strummed chord, so the estimator settles on whichever
    // string dominates the window and moves between them — often by exactly an
    // octave, which is its own known failure mode. Segmentation there comes from
    // attacks and from harmony changes, both of which describe the chord rather
    // than one string of it.
    // An octave-sized jump is the pitch estimator's best-known failure mode,
    // not a note boundary — it halves or doubles the period it locked onto, and
    // it does that on a single ringing string as readily as on a chord. Left
    // alone it splits one sustained note into two, and the fragment that keeps
    // the true octave is then a second event nobody played.
    //
    // Suppressed everywhere rather than only under harmonic context, because
    // the monophonic case is where it does the most damage: a lead note is long
    // enough for the estimate to flip mid-note and there is no chord to blame.
    // A genuine octave leap is rarer than this artefact and, when it is real,
    // arrives with an attack, which is a separate witness.
    const spuriousStep =
      pitchChange !== null &&
      (isOctaveJump(pitchChange.cents) ||
        (this.contextHarmonic >= config.harmony.octaveFlipContext &&
          this.contextHarmonic >= config.harmony.stepSuppressContext));

    if (
      active !== null &&
      pitchChange !== null &&
      pitchChange.kind === "step" &&
      !spuriousStep &&
      !active.harmonyBloomed
    ) {
      // The step is detected late by construction: YIN has to fill its window
      // with the new note and the temporal median has to turn over. When a
      // transient sits between the old Note's start and here, that transient is
      // where the note actually began, and it localises far better than the
      // pitch tracker can.
      let at = Math.max(pitchChange.at, active.startTime);
      let atSample = Math.max(pitchChange.atSample, 0);
      const attack = this.lastAttack;
      if (
        attack !== null &&
        attack.at > active.startTime &&
        attack.at < at &&
        at - attack.at <= config.tracking.backdateWindowMs
      ) {
        at = attack.at;
        atSample = attack.atSample;
      }
      const previous = active;
      this.end(active, at, out);
      active = this.begin(
        "pitchChange",
        frame,
        out,
        { at, atSample, frequencyHz: pitchChange.toHz },
        previous
      );
    }

    /* (c) Nothing is sounding and something just happened. */
    if (active === null) {
      const voiced = frame.pitch.frequencyHz !== null;
      const struck = frame.attack !== null && !frame.gated;
      if (voiced || struck) {
        active = this.begin(struck ? "attack" : "pitchChange", frame, out, null, splitFrom);
      }
    }

    /* (d) Fold this hop into whatever is sounding, or age it toward its end. */
    if (active !== null) {
      const silent = frame.gated;
      const unvoiced = frame.pitch.frequencyHz === null;

      if (silent || unvoiced) {
        if (active.silentSince === null && silent) active.silentSince = t;
        if (!silent) active.silentSince = null;
        if (active.unvoicedSince === null) active.unvoicedSince = t;

        // A Note ends when the sound stops, not when the pitch tracker loses
        // it. Those are different events and conflating them was a real defect:
        // a strummed chord has no single periodicity for YIN to hold onto, so
        // a Note that expired on unvoiced frames could not survive its own
        // first 90ms — the chord would vanish and, with no fresh attack to
        // restart it, never come back.
        const expired =
          active.silentSince !== null &&
          t - active.silentSince >= config.tracking.releaseGraceMs;
        if (expired) {
          this.end(active, active.silentSince as SourceTimeMs, out);
          active = null;
        } else {
          this.observe(active, frame, gliding);
        }
      } else {
        active.unvoicedSince = null;
        active.silentSince = null;
        this.observe(active, frame, gliding);
      }
    }

    this.publish(out);
    return out;
  }

  /**
   * Apply a deep-lane harmonic reading to a Note the fast lane already
   * reported on. This is where a Note blooms into a chord.
   *
   * The reading is a *vote*, not the answer. A strum's third decays far faster
   * than its root and fifth, so by the end of a chord the chroma has collapsed
   * to a power chord and a Note named from its last reading calls a Bm "B5".
   * Votes are pooled by root first and quality second, because the root is the
   * robust part — carried by the bass and the loudest partials, and it survives
   * the decay — while the quality lives in the third, the first thing to go.
   */
  applyHarmony(
    noteId: string,
    reading: HarmonicReading,
    activations: readonly PitchActivation[],
    evidence: { polyphony: number; voiceSpreadSemitones: number },
    at: SourceTimeMs
  ): TrackerEmission[] {
    const polyphony = evidence.polyphony;
    const out: TrackerEmission[] = [];
    const record = this.notes.get(noteId) ?? this.endedRecord(noteId);
    if (record === undefined) return out;

    record.polyphonySum += polyphony;
    record.polyphonyHops++;
    if (activations.length > 0) record.recordActivations(activations);
    const runningPolyphony =
      record.polyphonyHops > 0 ? record.polyphonySum / record.polyphonyHops : polyphony;
    // Three conditions, all necessary, because each is individually fooled.
    // Enough fundamentals — but a plucked string produces octave doublings that
    // satisfy the count. Enough distance between them — but a 4096-point window
    // is 85ms, so a fast run straddles two notes plus the decay of a third and
    // looks every bit as spread out as a chord. And weak periodicity — because
    // the one thing a single sounding string does that six do not is have a
    // period, which YIN finds with near-total confidence.
    const meanConfidence = record.frames > 0 ? record.confidenceSum / record.frames : 0;
    const harmonicNow =
      polyphony >= this.config.harmony.minPolyphony &&
      evidence.voiceSpreadSemitones >= this.config.harmony.minVoiceSpreadSemitones &&
      meanConfidence <= this.config.harmony.maxMonophonicConfidence
        ? 1
        : 0;
    // Time-based rather than per-reading, so the estimate describes the music
    // and not how often the deep lane happens to be sampled. A per-reading
    // smoothing constant silently makes the whole notion of "harmonic context"
    // a function of `harmony.hopDivisor`, which is a performance knob.
    const elapsed = this.contextUpdatedAt === null ? 0 : Math.max(0, at - this.contextUpdatedAt);
    // Capped, so a long gap in the readings cannot snap the estimate onto a
    // single window. After silence the recognizer should be uncertain about
    // what is sounding, not instantly confident.
    const alpha = Math.min(
      POLYPHONY_CONTEXT_MAX_ALPHA,
      1 - Math.exp(-elapsed / POLYPHONY_CONTEXT_TAU_MS)
    );
    this.contextUpdatedAt = at;
    this.contextHarmonic = this.contextHarmonic * (1 - alpha) + harmonicNow * alpha;
    record.polyphonic = this.contextHarmonic >= 0.5;

    if (reading.isConfident && reading.root !== null && reading.chordName !== null) {
      castHarmonyVote(
        record.harmonyVotes,
        reading.chordName,
        reading.root,
        reading.quality,
        reading.confidence
      );
      record.hypotheses.observe("harmony", reading.chordName, reading.confidence, at);
      queueTransitions(record, record.hypotheses.settle("harmony", at));

      // A chord change with no attack behind it. See `harmony.changeStableMs`.
      if (record.harmonyRoot !== null && reading.root !== record.harmonyRoot) {
        if (record.pendingHarmonyRoot !== reading.root) {
          record.pendingHarmonyRoot = reading.root;
          record.pendingHarmonySince = at;
          record.pendingHarmonyVotes.clear();
        }
        castHarmonyVote(
          record.pendingHarmonyVotes,
          reading.chordName,
          reading.root,
          reading.quality,
          reading.confidence
        );

        if (
          this.notes.has(record.id) &&
          at - record.pendingHarmonySince >= this.config.harmony.changeStableMs
        ) {
          // The evidence gathered while the change was merely pending belongs
          // to the NEW Note: the backdated boundary puts those readings inside
          // its span, and they are the ones where the third is still sounding.
          const boundary = Math.max(record.pendingHarmonySince, record.startTime);
          const carried = new Map(record.pendingHarmonyVotes);
          this.end(record, boundary, out);
          const successor = this.beginHarmonic(boundary, record, carried);
          for (const emission of this.applyHarmony(
            successor.id,
            reading,
            activations,
            evidence,
            at
          )) {
            out.push(emission);
          }
          this.publish(out);
          return out;
        }
      } else if (reading.root === record.harmonyRoot) {
        record.pendingHarmonyRoot = null;
        record.pendingHarmonyVotes.clear();
      }
    }

    // Blooming is a claim that more than one string is sounding, so it needs
    // evidence of polyphony rather than merely a template that happened to fit.
    // A single picked note fits "C5" perfectly well if you let it.
    const meanPolyphony = runningPolyphony;
    const enoughEvidence = record.polyphonyHops >= this.config.harmony.minEvidenceHops;
    const meanPitchConfidence =
      record.frames > 0 ? record.confidenceSum / record.frames : 0;
    const monophonic = meanPitchConfidence > this.config.harmony.maxMonophonicConfidence;
    if (!record.polyphonic || monophonic || !enoughEvidence) return out;

    const winner = bestHarmonyVote(record.harmonyVotes, this.config.harmony.minEvidenceHops);
    // Either this Note has itself sustained long enough to be a chord, or the
    // room has been unambiguously harmonic for that long — a strummed take
    // stays harmonic across a boundary the tracker has just drawn, and the new
    // Note should not have to re-earn what the previous one established.
    const minimum = this.config.harmony.minChordDurationMs;
    const sustained =
      Math.max(record.lastSeenAt, at) - record.startTime >= minimum ||
      (this.harmonicSince !== null && at - this.harmonicSince >= minimum);
    // See `harmony.minChordDurationMs`: an unnameable chord is a much weaker
    // claim than a named one, and the only one that misfires on a fast run.
    if (winner === null && !record.harmonyBloomed && !sustained) return out;

    const previousRoot = record.harmonyRoot;
    const previousQuality = record.harmonyQuality;
    const previousLabel = record.harmonyLabel;
    const bloomed = record.harmonyBloomed;

    record.harmonyBloomed = true;
    record.harmonyConfidence = winner === null ? 0 : winner.weight / winner.hops;
    record.harmonyAlternatives = reading.alternatives;
    record.estimatedVoiceCount = { value: meanPolyphony, confidence: reading.confidence };
    if (winner === null) {
      // Nothing ever cleared both the floor and the margin often enough to name
      // this Note. Saying so is a result: the recognizer knows it is a chord and
      // will not guess which one.
      record.harmonyRoot = null;
      record.harmonyQuality = null;
      record.harmonyLabel = null;
      record.harmonyIntervals = [];
    } else {
      record.harmonyRoot = winner.root;
      record.harmonyQuality = winner.quality;
      record.harmonyLabel = winner.label;
      record.harmonyIntervals = reading.intervals;
      record.spectralFit = record.harmonyConfidence;
    }
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
    if (!bloomed && record.currentPitch !== null && record.harmonyLabel !== null) {
      record.hypotheses.incorporate("pitch", record.currentPitch.name, record.harmonyLabel, at);
    }
    if (
      bloomed &&
      previousLabel !== null &&
      record.harmonyLabel !== null &&
      previousLabel !== record.harmonyLabel
    ) {
      record.hypotheses.supersede("harmony", previousLabel, record.harmonyLabel, at);
    }

    const type: NoteChangeType = bloomed
      ? classifyHarmonyChange(previousRoot, previousQuality, record.harmonyRoot, record.harmonyQuality)
      : "harmonyEnrichment";

    // A Note that has just named itself a chord reaches back for the fragments
    // of its own attack. See `harmony.mergeLookbackMs`.
    // Keyed on the first time this Note is NAMED, not the first time it bloomed:
    // a Note routinely blooms as an abstention first — it knows it is a chord
    // several readings before it knows which one — and the fragments of its
    // attack are still waiting to be claimed when the name finally arrives.
    const justNamed = !record.harmonyNamed && record.harmonyLabel !== null;
    if (record.harmonyLabel !== null) record.harmonyNamed = true;
    const longEnoughToBeAChord =
      Math.max(record.lastSeenAt, at) - record.startTime >= this.config.harmony.mergeMinSurvivorMs;
    if (justNamed && longEnoughToBeAChord && record.endTime === null) {
      const absorbed = this.absorbAttackFragments(record);
      if (absorbed.length > 0 && record.announced) {
        const revisionNumber = record.bump("structuralRevision");
        out.push({
          type: "changed",
          note: record.snapshot(),
          change: {
            type: "structuralRevision",
            at,
            revisionNumber,
            relatedNoteIds: absorbed,
          },
        });
      }
    }

    const label = record.currentLabel();
    if (record.announced && record.endTime === null && label !== record.lastEmitted.label) {
      const revisionNumber = record.bump(type);
      const change: NoteChange = { type, at, revisionNumber };
      if (bloomed && previousLabel !== null && type === "harmonyCorrection") {
        change.previous = { label: previousLabel };
      }
      record.lastEmitted.label = label;
      out.push({ type: "changed", note: record.snapshot(), change });
    } else {
      record.bump(type);
    }
    return out;
  }

  /** Opens the Note that takes over when the harmony changes mid-ring. */
  private beginHarmonic(
    at: SourceTimeMs,
    predecessor: NoteRecord,
    carriedVotes: ReadonlyMap<string, HarmonyVote>
  ): NoteRecord {
    const record = new NoteRecord({
      id: `n${this.nextId++}`,
      config: this.config,
      startTime: at,
      startSample: this.clock.toSamples(at),
      trigger: "pitchChange",
      frequencyHz: predecessor.currentFrequencyHz,
      originPitch: predecessor.currentPitch,
      confidence: predecessor.pitchConfidence,
      rms: predecessor.rms,
      peak: predecessor.maxPeak,
    });
    record.polyphonic = this.contextHarmonic >= 0.5;
    record.sustainedRms = predecessor.sustainedRms;
    for (const [label, vote] of carriedVotes) record.harmonyVotes.set(label, { ...vote });
    this.notes.set(record.id, record);
    return record;
  }

  /**
   * Absorb the unnamed Notes immediately preceding `survivor` into it.
   *
   * Only unnamed ones: a preceding Note that named its own chord is a different
   * chord, not a fragment of this one. Contiguity is required in both
   * directions — a gap means silence, and silence means two separate events.
   *
   * The survivor's start moves back to the earliest absorbed Note's start,
   * which is the point of the exercise: the fast lane's first fragment sits on
   * the real attack, and the Note that eventually names the chord does not.
   */
  private absorbAttackFragments(survivor: NoteRecord): string[] {
    const config = this.config.harmony;
    const absorbed: string[] = [];
    let earliest = survivor;

    for (let guard = 0; guard < 16; guard++) {
      let previous: NoteRecord | null = null;
      for (const candidate of [...this.closing, ...this.ended]) {
        if (candidate.merged) continue;
        if (candidate.harmonyLabel !== null) continue;
        if (candidate.endTime === null) continue;
        if (candidate.endTime - candidate.startTime > config.mergeMaxFragmentMs) continue;
        if (candidate.endTime > earliest.startTime + config.mergeMaxGapMs) continue;
        if (candidate.endTime < earliest.startTime - config.mergeMaxGapMs) continue;
        if (survivor.startTime - candidate.startTime > config.mergeLookbackMs) continue;
        if (previous === null || candidate.startTime > previous.startTime) previous = candidate;
      }
      if (previous === null) break;
      previous.merged = true;
      absorbed.push(previous.id);
      earliest = previous;
    }

    if (absorbed.length > 0) {
      survivor.startTime = earliest.startTime;
      survivor.startSample = earliest.startSample;
    }
    return absorbed;
  }

  /** The harmony a Note currently answers to, for segmentation decisions. */
  currentHarmonyOf(noteId: string): string | null {
    return this.notes.get(noteId)?.harmonyLabel ?? null;
  }

  /** Ends every open Note. Called on stop, and at the end of offline input. */
  flush(at: SourceTimeMs): TrackerEmission[] {
    const out: TrackerEmission[] = [];
    for (const record of [...this.notes.values()]) {
      this.end(record, Math.max(at, record.startTime), out);
    }
    this.publish(out);
    this.releaseClosed(EMPTY_SET, out);
    return out;
  }

  /* ------------------------------------------------------------------ */

  private begin(
    trigger: NoteOriginTrigger,
    frame: FastFrame,
    out: TrackerEmission[],
    override: { at: SourceTimeMs; atSample: number; frequencyHz: number | null } | null,
    /**
     * The Note this one is splitting away from, if any. Its decay state carries
     * over: the strings are the same strings, still ringing on the same curve.
     */
    predecessor: NoteRecord | null = null
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
    record.polyphonic = this.contextHarmonic >= 0.5;
    if (predecessor !== null) record.decay.adopt(predecessor.decay);
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
    record.decay.observe(t, frame.rms);
    record.lastSeenAt = t;
    if (!frame.gated) record.lastAudibleAt = t;

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
    // Weighted by the confidence of the reading, not counted. A hop where YIN
    // was sure and a hop where it barely cleared the gate are not equal
    // evidence, and in a fast run the uncertain hops cluster at the boundaries,
    // where the window is straddling two notes.
    record.noteVotes.set(
      nearest.midi,
      (record.noteVotes.get(nearest.midi) ?? 0) + frame.pitch.confidence
    );
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

    queueTransitions(record, record.hypotheses.settle("pitch", t));
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
        if (record.soundedMs < record.announceThresholdMs) continue;
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

      // A hypothesis moving state is news in its own right, and it is news
      // that arrives BEFORE the label catches up: a reading being promoted to
      // `leading` is the interesting moment, not the later hop where it
      // finally changes the answer. Emitted first, and at most one per hop, so
      // the trail stays readable rather than becoming a per-frame firehose.
      const transition = record.pendingTransitions.shift();
      record.pendingTransitions.length = 0;
      if (transition !== undefined) {
        const kind: NoteChangeType =
          transition.to === "discredited" || transition.to === "superseded"
            ? "hypothesisDiscredited"
            : transition.to === "incorporated"
              ? "hypothesisIncorporated"
              : "hypothesisPromoted";
        const revisionNumber = record.bump(kind);
        out.push({
          type: "changed",
          note: record.snapshot(),
          change: {
            type: kind,
            at: record.lastSeenAt,
            revisionNumber,
            previous: { label: transition.hypothesis.label, hypothesisId: transition.hypothesis.id },
          },
        });
      }

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
    record.endTime = endAt;

    if (!record.announced) {
      // Never announced: too short to have been a Note. Drop it rather than
      // emit an end with no matching start. Measured over how long it SOUNDED,
      // the same bar `publish` uses — a blip that spent its whole life in
      // release grace must not qualify just because the grace is long.
      if (record.soundedMs < record.announceThresholdMs) return;
      record.announced = true;
      record.lastEmitted = {
        label: record.currentLabel(),
        confidence: record.overallConfidence(),
        bendCents: record.bendCents,
        lifecycle: record.lifecycle,
      };
      out.push({ type: "started", note: record.snapshot() });
    }

    // The sound is over, but the recognizer may not have finished thinking. A
    // chord's identity is routinely settled by deep analysis that started
    // before the strum stopped, so the closing events wait for it — otherwise
    // the answer a consumer keeps is the one from before the evidence arrived.
    record.closing = true;
    this.closing.push(record);
  }

  /**
   * Emit the held closing events for every Note the deep lane is done with.
   *
   * @param busy ids the deep lane still has queued work for
   */
  releaseClosed(busy: ReadonlySet<string>, out: TrackerEmission[]): void {
    for (let i = this.closing.length - 1; i >= 0; i--) {
      const record = this.closing[i] as NoteRecord;
      if (busy.has(record.id)) continue;
      this.closing.splice(i, 1);

      if (!record.resolvedAnnounced) {
        record.resolvedAnnounced = true;
        record.lifecycle = "resolved";
        record.bump("resolved");
        out.push({ type: "resolved", note: record.snapshot() });
      }

      record.lifecycle = "ended";
      out.push({ type: "ended", note: record.snapshot() });

      this.ended.push(record);
      if (this.ended.length > this.config.tracking.endedNoteHistory) this.ended.shift();
    }
    // Closing Notes are emitted newest-last, so a consumer sees them in the
    // order they stopped sounding rather than in queue order.
    out.sort(stableByNothing);
  }

  private endedRecord(id: string): NoteRecord | undefined {
    for (const record of this.closing) {
      if (record.id === id) return record;
    }
    for (let i = this.ended.length - 1; i >= 0; i--) {
      const record = this.ended[i] as NoteRecord;
      if (record.id === id) return record;
    }
    return undefined;
  }
}

function castHarmonyVote(
  votes: Map<string, HarmonyVote>,
  label: string,
  root: PitchClass,
  quality: string | null,
  confidence: number
): void {
  const vote = votes.get(label) ?? {
    label,
    root,
    quality: quality ?? "maj",
    weight: 0,
    hops: 0,
  };
  vote.weight += confidence;
  vote.hops++;
  votes.set(label, vote);
}

/**
 * A Note's chord name, decided in two stages: root first, then quality among
 * the readings that agreed on that root.
 *
 * Root before quality because the root is the robust part — it is carried by
 * the bass and the loudest partials and survives the decay — while the quality
 * lives in the third, the first thing to disappear. Pooling by root means a
 * decayed `B5` and a full `Bm` reinforce each other on the root rather than
 * splitting the vote, and the quality is then settled only among readings that
 * were looking at the same chord.
 *
 * Ties break toward the first reading seen, which is deterministic: `Map`
 * iterates in insertion order and insertion order is analysis order.
 */
function bestHarmonyVote(
  votes: ReadonlyMap<string, HarmonyVote>,
  minEvidenceHops: number
): HarmonyVote | null {
  const roots = new Map<string, { weight: number; hops: number }>();
  for (const vote of votes.values()) {
    const aggregate = roots.get(vote.root) ?? { weight: 0, hops: 0 };
    aggregate.weight += vote.weight;
    aggregate.hops += vote.hops;
    roots.set(vote.root, aggregate);
  }

  let bestRoot: string | null = null;
  let bestWeight = 0;
  let bestHops = 0;
  for (const [root, aggregate] of roots) {
    if (aggregate.weight > bestWeight) {
      bestRoot = root;
      bestWeight = aggregate.weight;
      bestHops = aggregate.hops;
    }
  }
  // Below this the evidence is a flash rather than a reading, and the honest
  // answer is that this is a chord we will not name.
  if (bestRoot === null || bestHops < minEvidenceHops) return null;

  let winner: HarmonyVote | null = null;
  for (const vote of votes.values()) {
    if (vote.root !== bestRoot) continue;
    if (winner === null || vote.weight > winner.weight) winner = vote;
  }
  return winner;
}
