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
import type {
  AttackEvidence,
  DeepSegmentation,
  FastFrame,
  HarmonicReading,
  PitchActivation,
  RegionSegment,
} from "../contracts.js";
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

/**
 * Where the room's harmonic-context estimate tips from "a note" to "a chord".
 *
 * One number rather than two, because "this Note is sounding over harmonic
 * audio" and "the room has stopped being harmonic" are the same claim measured
 * over different spans, and letting them disagree produced Notes that believed
 * they were chords in a room that did not.
 */
const HARMONIC_CONTEXT_THRESHOLD = 0.5;

/**
 * Attack times kept for the region lane to corroborate against.
 *
 * A few seconds' worth at any playable density, which is all the region lane
 * can reach anyway — the ring is four seconds long.
 */
const ATTACK_HISTORY = 256;

/** Confidence movement below this is not worth an event. */
const CONFIDENCE_EPSILON = 0.15;
/**
 * A bend big enough that the Note is provably following the player's hand.
 *
 * Above this the pitch has left the note it is named after on purpose, so both
 * boundary witnesses stop carrying information — a sweep fires the attack
 * witnesses repeatedly and drags the leader through every semitone on the way.
 * Below it, a decaying string wobbling across a semitone boundary registers as
 * a "bend" too, and refusing to re-segment those would hand the whole triplet
 * run back to the fast lane.
 */
const BEND_IS_ONE_NOTE_CENTS = 150;

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
   * The first attack of the burst `lastAttack` belongs to.
   *
   * One articulation produces more than one transient — six strings crossed by
   * a pick, the pick noise and then the string speaking — and a Note that opens
   * on the last of them opens late. Attacks closer together than one
   * articulation are one articulation, and the event began at the first of
   * them.
   */
  private attackBurstStart: AttackEvidence | null = null;
  /**
   * When energy last arrived, oldest first.
   *
   * The fast lane sees every transient and then declines to act on most of
   * them, because whether a transient means a new note depends on what is
   * already sounding. The region lane has the opposite problem: it can see that
   * the envelope rose over a trough hundreds of milliseconds later, but its
   * 85ms windows localise that rise poorly and it cannot tell a pick from the
   * ordinary ripple of a decay. Between them the answer is unambiguous — the
   * fast lane says exactly WHEN energy arrived, the region lane says whether
   * that arrival was a new event — and neither witness alone is enough.
   */
  private readonly attackTimes: SourceTimeMs[] = [];
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
    this.attackBurstStart = null;
    this.attackTimes.length = 0;
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

    // Every transient, gated or not. The amplitude gate exists to stop the fast
    // lane opening a Note on room tone, and it is right to be conservative
    // there — but a note picked into the tail of the one before it can sit
    // under the gate for the hop where the pick lands, which is exactly the
    // event the region lane is trying to corroborate. The gate still decides
    // what the fast lane may act on; this list only records what it saw.
    if (frame.attack !== null) {
      this.attackTimes.push(frame.attack.at);
      if (this.attackTimes.length > ATTACK_HISTORY) this.attackTimes.shift();
    }

    if (frame.attack !== null && !frame.gated) {
      const previous = this.lastAttack;
      const burst = this.attackBurstStart;
      const continues =
        previous !== null &&
        burst !== null &&
        frame.attack.at - previous.at <= config.transient.articulationMs &&
        frame.attack.at - burst.at <= config.tracking.backdateWindowMs;
      this.attackBurstStart = continues ? burst : frame.attack;
      this.lastAttack = frame.attack;
    }

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
      // A bending Note has left the pitch it is named after on purpose, so
      // "the arriving pitch is not the Note's pitch" stops meaning anything:
      // once A3 has been bent a semitone, every hop arrives at some other note
      // name, and a wobble across the A#3/B3 boundary reads as a new note
      // arriving. What still means something there is the frequency actually
      // moving, so while the Note bends the arriving pitch has to differ from
      // the one this Note was sounding a hop ago by a real step. Nothing
      // outside a bend is affected. "A3 bent up to B3" is one thing the player
      // did, and it has to come out as one Note.
      const bentSteady =
        active.bendActive &&
        active.lastVoicedHz !== null &&
        frame.pitch.frequencyHz !== null &&
        Math.abs(centsBetween(frame.pitch.frequencyHz, active.lastVoicedHz)) <
          config.pitch.stepThresholdCents;
      const pitchDiffers =
        // Never on a Note that has bloomed into a chord. A chord's pitch is not
        // one pitch: YIN reports whichever string dominates the window and
        // moves between them freely, so "a different pitch arrived" is the
        // normal state of affairs inside a strum and says nothing about a new
        // event. Segmentation there comes from attacks and from harmony
        // changes, both of which describe the chord rather than one voice of
        // it. This is the Voices-versus-Notes distinction: a string arriving is
        // a voice, and a voice is not a Note.
        !active.harmonyBloomed &&
        !bentSteady &&
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
        // The boundary is the FIRST attack of this burst, not the one that
        // finally cleared the bar. A pick crossing six strings, or a pick
        // scrape followed by the string speaking, is one articulation with
        // several transients, and the event began at the first of them.
        const boundary = this.attackBurstStart ?? frame.attack;
        this.end(active, boundary.at, out);
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
          this.harmonicSince !== null));

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
      const attack = this.attackBurstStart ?? this.lastAttack;
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
        active = this.begin(
          struck ? "attack" : "pitchChange",
          frame,
          out,
          null,
          splitFrom,
          splitFrom !== null
        );
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
    record.polyphonic = this.contextHarmonic >= HARMONIC_CONTEXT_THRESHOLD;
    // When the ROOM entered its current harmonic stretch.
    //
    // Declared, read, and never once written before now, so the thing it gates
    // never happened. Latched with hysteresis rather than read hop by hop: a
    // strummed chord's context estimate sags as the chord decays — the third
    // dies first, one string comes to dominate, and YIN starts finding a period
    // in it again — so an instantaneous test decides mid-ring that the chord
    // became a single note, which is exactly when the pitch-step segmentation
    // that shatters it is let back in. Entering takes real evidence; leaving
    // takes the room dropping well below it.
    if (this.contextHarmonic >= this.config.harmony.stepSuppressContext) {
      if (this.harmonicSince === null) this.harmonicSince = at;
    } else if (this.contextHarmonic < HARMONIC_CONTEXT_THRESHOLD) {
      this.harmonicSince = null;
    }

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

      } else if (reading.root === record.harmonyRoot) {
        record.pendingHarmonyRoot = null;
        record.pendingHarmonyVotes.clear();
      }
    }

    // Has a pending chord change stood long enough to be a boundary?
    //
    // Asked on every reading, not only on a confident one that disagrees. The
    // moment a chord changes over a ringing one is exactly when the chroma is
    // least sure of itself — the old chord is still sounding under the new — so
    // the readings that follow the change are routinely unconfident, and
    // requiring one of them to carry the timer meant the change could stand
    // pending indefinitely and never become a boundary. A reading that declines
    // to name anything does not contradict a pending change.
    if (
      record.pendingHarmonyRoot !== null &&
      record.pendingHarmonyVotes.size > 0 &&
      this.notes.has(record.id) &&
      at - record.pendingHarmonySince >= this.config.harmony.changeStableMs
    ) {
      // The evidence gathered while the change was merely pending belongs to
      // the NEW Note: the backdated boundary puts those readings inside its
      // span, and they are the ones where the third is still sounding.
      const boundary = Math.max(record.pendingHarmonySince, record.startTime);
      const carried = new Map(record.pendingHarmonyVotes);
      this.end(record, boundary, out);
      const successor = this.beginHarmonic(boundary, record, carried);
      for (const emission of this.applyHarmony(successor.id, reading, activations, evidence, at)) {
        out.push(emission);
      }
      this.publish(out);
      return out;
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
    // This Note has itself sustained long enough to be a chord.
    //
    // Deliberately NOT "or the room has been harmonic for that long", which is
    // what this line used to say against a `harmonicSince` nothing ever set.
    // Now that something does, the difference is measurable and it is bad:
    // saying "this is a chord and I will not name it" is the weakest claim the
    // recogniser makes, and the room's harmony is precisely the evidence that
    // misleads it — an 85ms transform over a 167ms run straddles two notes plus
    // the decay of a third and reads as harmonic in flashes. Licensing
    // abstention from that turns picked notes in a lead line into unnamed
    // chords. Keeping a strummed chord in one piece is what the room's harmony
    // is good for, and that is `harmonicSince`'s job in `process`.
    const minimum = this.config.harmony.minChordDurationMs;
    const sustained = Math.max(record.lastSeenAt, at) - record.startTime >= minimum;
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
    record.polyphonic = this.contextHarmonic >= HARMONIC_CONTEXT_THRESHOLD;
    // Born because the harmony changed, so it is a chord from its first hop.
    // Making it re-earn that leaves it open to the pitch-step segmentation a
    // bloomed Note is protected from, and a chord whose Note has just been
    // handed over shatters into one Note per string while it waits.
    record.harmonyBloomed = predecessor.harmonyBloomed;
    record.sustainedRms = predecessor.sustainedRms;
    for (const [label, vote] of carriedVotes) record.harmonyVotes.set(label, { ...vote });
    this.notes.set(record.id, record);
    return record;
  }

  /**
   * Absorb the Note this one has just split away from, when the two are one
   * articulation rather than two events.
   *
   * A strum is a single gesture that excites six strings over tens of
   * milliseconds, and a picked note opens with a transient the pitch estimator
   * cannot read for a window and a median afterwards. Both produce the same
   * artefact: a stub of a Note, sounding for a few tens of milliseconds and
   * named after whatever was ringing before it, ending on the attack the player
   * actually meant. The stub is not wrong so much as premature, and the Note
   * that follows it is the event.
   *
   * Absorbing rather than merging is the point: the survivor keeps its OWN
   * pitch evidence and inherits only the stub's start time, so the boundary
   * lands on the attack while the name still comes from the frames that
   * describe what was played. Merging would hand it the stub's votes too, which
   * is how a Note ends up answering to its predecessor's name.
   */
  private absorbArticulationFragment(
    survivor: NoteRecord,
    predecessor: NoteRecord | null
  ): void {
    if (predecessor === null) return;
    if (predecessor.merged) return;
    if (predecessor.deepStructural) return;
    // A Note that named a chord, or that sustained past one articulation, is an
    // event somebody played. Only the stub of a forming articulation qualifies.
    if (predecessor.harmonyBloomed) return;
    if (predecessor.durationMs > this.config.transient.articulationMs) return;
    // Contiguous by construction when the split ended the predecessor here, but
    // checked rather than assumed: a gap means silence, and silence means two
    // separate events.
    const end = predecessor.endTime;
    if (end === null) return;
    if (Math.abs(end - survivor.startTime) > this.config.harmony.mergeMaxGapMs) return;

    predecessor.merged = true;
    survivor.startTime = predecessor.startTime;
    survivor.startSample = predecessor.startSample;
    survivor.pendingAbsorbed.push(predecessor.id, ...predecessor.pendingAbsorbed);
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
        // A Note the region lane split out, or created, is a decided event
        // rather than a fragment of a forming articulation. Absorbing it would
        // let a chord that names itself nearby swallow the re-segmentation.
        if (candidate.deepStructural) continue;
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

  /* ------------------------------------------------------------------ */
  /* Region re-segmentation                                              */
  /* ------------------------------------------------------------------ */

  /**
   * The span of audio nobody has ruled on yet, or null when there is none.
   *
   * It runs from the start of the oldest Note that has stopped sounding but has
   * not been compared against a re-analysis of its own region, up to whatever
   * "now" turns out to be when the job is queued. A Note leaves this set by
   * being resolved, which is what stops the region growing without bound.
   *
   * Live Notes are deliberately excluded: their audio has not finished
   * arriving, and re-segmenting a Note against a region that stops in the
   * middle of it is how a note gets cut in half by the analysis rather than by
   * the player.
   */
  pendingRegion(): { fromSample: number; noteIds: string[]; lastEndTime: SourceTimeMs } | null {
    let fromSample = Number.POSITIVE_INFINITY;
    let lastEndTime = Number.NEGATIVE_INFINITY;
    const noteIds: string[] = [];
    for (const record of this.closing) {
      if (record.deepResolved || record.merged) continue;
      fromSample = Math.min(fromSample, record.startSample);
      lastEndTime = Math.max(lastEndTime, record.endTime ?? record.lastSeenAt);
      noteIds.push(record.id);
    }
    if (noteIds.length === 0) return null;
    return { fromSample, noteIds, lastEndTime: lastEndTime as SourceTimeMs };
  }

  /**
   * Let a region's Notes go without a verdict.
   *
   * Called when the audio aged out of the ring before the deep lane reached it.
   * A Note held open waiting for an answer that will never arrive would never
   * emit its own ending, which is a far worse failure than an unrevised Note.
   */
  resolveRegion(noteIds: readonly string[]): void {
    for (const id of noteIds) {
      const record = this.endedRecord(id) ?? this.notes.get(id);
      if (record !== undefined) record.deepResolved = true;
    }
  }

  /**
   * Reconcile a region's segmentation against the Notes already emitted in it.
   *
   * This is the direction the window-tagger could not run in. A harmony reading
   * arrives already addressed to a Note, so all it can do is improve that
   * Note's name; a segmentation arrives addressed to a span of audio, so it can
   * disagree about how many Notes there were at all.
   *
   * Three things a Note that named a chord is protected from, and one reason:
   * a strum IS several events' worth of energy arriving over tens of
   * milliseconds, so the witnesses that identify a fresh note in a line — the
   * leader moving, the envelope rising — both fire inside one chord routinely.
   * The deep lane may re-segment what has not already been identified as a
   * single chord, and nothing else.
   */
  applySegmentation(segmentation: DeepSegmentation): TrackerEmission[] {
    const out: TrackerEmission[] = [];
    const candidates: NoteRecord[] = [];
    const inRegion = (record: NoteRecord): boolean =>
      !record.merged &&
      record.endTime !== null &&
      record.startSample >= segmentation.fromSample &&
      record.endTime <= segmentation.to;
    for (const record of this.closing) {
      if (record.deepResolved) continue;
      if (inRegion(record)) candidates.push(record);
    }
    // Notes that have already been let go are still open to being *corrected*.
    // Their extent is history and cannot be rewritten — the `ended` for them
    // has been delivered — but a name is a belief, and the region saw the whole
    // event where the hops each saw 43ms straddling its edges. This is the same
    // path `applyHarmony` has always taken for a Note whose chord resolved
    // after it stopped sounding.
    const ended: NoteRecord[] = [];
    for (const record of this.ended) {
      if (inRegion(record)) ended.push(record);
    }
    candidates.sort((a, b) => a.startTime - b.startTime || (a.id < b.id ? -1 : 1));
    for (const record of candidates) record.deepResolved = true;

    // Everything past the last Note under consideration belongs to audio that
    // is still arriving. The region reaches into it on purpose — a boundary is
    // only visible once the window has seen what comes after it — but nothing
    // out there may be acted on yet.
    const horizon = Math.max(
      ...candidates.map((r) => r.endTime as number),
      ...ended.map((r) => r.endTime as number),
      Number.NEGATIVE_INFINITY
    );
    const segments = segmentation.segments.filter((segment) => segment.from < horizon);
    if (segments.length === 0) return out;

    // A Note that already knows which chord it is has been identified, not
    // merely detected, and a strum's interior looks exactly like a run of
    // fresh notes to both witnesses. Leave it alone, and leave its span alone.
    const named = candidates.filter((record) => record.harmonyLabel !== null);
    const open = candidates.filter((record) => record.harmonyLabel === null);



    const owned = new Map<string, RegionSegment[]>();
    const orphans: RegionSegment[] = [];
    for (const segment of segments) {
      const owner = ownerOf(open, segment.from);
      if (owner === null) {
        if (coveredBy(named, segment.from)) continue;
        orphans.push(segment);
        continue;
      }
      const list = owned.get(owner.id);
      if (list === undefined) owned.set(owner.id, [segment]);
      else list.push(segment);
    }

    for (const record of open) {
      const mine = (owned.get(record.id) ?? []).filter(
        (segment, index) => index === 0 || this.isRealBoundary(record, segment)
      );
      if (mine.length < 2) continue;
      this.splitAtSegments(record, mine, out);
    }

    if (this.config.deep.regionMerge) {
      for (const segment of segments) this.mergeWithinSegment(segment, open, out);
    }

    for (const segment of orphans) {
      this.insertFromSegment(segment, candidates, out);
    }

    // Corrections last, and applied to Notes that have already been let go as
    // readily as to Notes still closing.
    for (const record of [...open, ...ended]) {
      if (record.merged) continue;
      const segment = ownerOfSegment(segments, record.startTime);
      if (segment !== null) this.correctPitch(record, segment, out);
    }

    return out;
  }

  /**
   * Absorb Notes the fast lane cut where the region found no boundary.
   *
   * The mirror of splitting, and the direction that has to be more careful:
   * splitting can only turn one detection into two, while absorbing deletes a
   * detection the recognizer already stood behind, and if the region is wrong
   * that is a note somebody played thrown away. So it happens only where the
   * region positively found ONE event — no boundary of any kind between them —
   * and where the Notes agree with the segment and with each other about what
   * was sounding.
   */
  private mergeWithinSegment(
    segment: RegionSegment,
    open: readonly NoteRecord[],
    out: TrackerEmission[]
  ): void {
    const inside = open
      .filter(
        (record) =>
          !record.merged &&
          record.startTime >= segment.from &&
          record.startTime < segment.to &&
          (record.endTime ?? 0) <= segment.to
      )
      .sort((a, b) => a.startTime - b.startTime);
    if (inside.length < 2) return;

    const survivor = inside[0] as NoteRecord;
    if (survivor.deepStructural) return;
    const target = pitchClassIndex(segment.dominantMidi);
    const absorbed: string[] = [];
    let end = survivor.endTime as SourceTimeMs;

    for (let i = 1; i < inside.length; i++) {
      const record = inside[i] as NoteRecord;
      if (record.deepStructural) break;
      // Contiguous, or the silence between them says they are two events.
      if (record.startTime - end > this.config.harmony.mergeMaxGapMs) break;
      // And about the same thing the region says was sounding.
      if (target !== null && pitchClassIndex(record.dominantMidi()) !== target) break;
      record.merged = true;
      absorbed.push(record.id);
      end = Math.max(end, record.endTime ?? end) as SourceTimeMs;
    }
    if (absorbed.length === 0) return;

    survivor.endTime = end;
    survivor.deepStructural = true;
    if (!survivor.announced) return;
    const revisionNumber = survivor.bump("structuralRevision");
    out.push({
      type: "changed",
      note: survivor.snapshot(),
      change: {
        type: "structuralRevision",
        at: end,
        revisionNumber,
        relation: "absorbed",
        relatedNoteIds: absorbed,
      },
    });
  }

  /**
   * Rename a Note the region disagrees with.
   *
   * Not a structural claim and not gated on the Note still being open: an
   * already-ended Note's extent is history, but its name is a belief, and the
   * whole point of a lane that is allowed to be late is that it may arrive
   * after the fact with better evidence. A Note that has bloomed into a chord
   * is left alone — a chord is not named from one fundamental.
   */
  private correctPitch(
    record: NoteRecord,
    segment: RegionSegment,
    out: TrackerEmission[]
  ): void {
    if (!this.config.deep.regionCorrectPitch) return;
    if (record.harmonyBloomed) return;
    const activation = segment.activations[0];
    if (activation === undefined) return;
    const named = pitchClassIndex(record.dominantMidi());
    if (named === null || named === pitchClassIndex(activation.midi)) return;

    const previous = record.currentLabel();
    record.deepPitch = {
      midi: activation.midi,
      name: `${activation.pitchClass}${activation.octave}`,
      pitchClass: activation.pitchClass,
      octave: activation.octave,
      frequencyHz: activation.frequencyHz,
      centsOffset: 0,
      role: "first",
      confidence: activation.confidence,
    };
    const label = record.currentLabel();
    if (!record.announced || label === previous) return;
    const revisionNumber = record.bump("pitchCorrection");
    record.lastEmitted.label = label;
    out.push({
      type: "changed",
      note: record.snapshot(),
      change: {
        type: "pitchCorrection",
        at: segment.from,
        revisionNumber,
        previous: { label: previous },
      },
    });
  }

  /**
   * Is this segment boundary a note the player put there?
   *
   * Two rules, one per witness, and each is the same rule the fast lane already
   * lives by, applied to region evidence instead of hop evidence.
   *
   *  - **A chord's leader moving is a voice, not a Note.** A strum has no
   *    single pitch: its strings arrive over tens of milliseconds and decay at
   *    different rates, so the strongest fundamental wanders through the chord
   *    for its whole life. Splitting on that shattered every strum into one
   *    Note per string, which is the defect the fast lane's own
   *    Voices-versus-Notes rule exists to prevent.
   *  - **A re-articulation needs energy to have arrived.** The region lane can
   *    see the envelope rise over a trough, but an 85ms window localises that
   *    badly and cannot tell a pick from the ripple of a decay. The fast lane
   *    saw the transient and knows exactly when. Requiring both means a note
   *    re-picked at its own pitch is recoverable while sustain ripple is not.
   */
  private isRealBoundary(record: NoteRecord, segment: RegionSegment): boolean {
    // A bend sweeps the spectrum, which fires both attack witnesses repeatedly
    // inside what is musically one note, and drags the leader through every
    // semitone it passes on the way. Neither witness carries information here.
    // "A3 bent up to B3" is one thing the player did, and it comes out as one
    // Note or the recognizer is wrong about what happened.
    if (Math.abs(record.bendPeakCents) >= BEND_IS_ONE_NOTE_CENTS) return false;

    if (segment.boundary === "pitchChange") {
      // A chord's leader moving is a voice, not a Note. A strum has no single
      // pitch: its strings arrive over tens of milliseconds and decay at
      // different rates, so the strongest fundamental wanders through the chord
      // for its whole life. This is the fast lane's own Voices-versus-Notes
      // rule, applied to region evidence.
      if (record.harmonyBloomed) return false;
      // The boundary was found from the window that FIRST showed a new leader.
      // Whether the leader stayed changed is a question about the whole
      // segment, and only the accumulated answer is worth splitting a Note
      // over. Measured against the Note's OWN name rather than against the
      // neighbouring segment, because that is what the split has to change to
      // be worth making: cutting a C#5 in two and calling both halves C#5 is
      // fragmentation whatever the transform saw in between. Compared by pitch
      // class, since an octave-sized jump is the estimator's failure mode
      // rather than a note.
      const carved = pitchClassIndex(segment.dominantMidi);
      const named = pitchClassIndex(record.dominantMidi());
      return carved !== null && named !== null && carved !== named;
    }

    // A re-articulation needs energy to have arrived. The region lane can see
    // the envelope rise over a trough hundreds of milliseconds later, but an
    // 85ms window localises that badly and cannot tell a pick from the ripple
    // of a decay; the fast lane saw the transient and knows exactly when.
    // Neither witness is enough alone, and together they are unambiguous.
    const tolerance = this.config.tracking.backdateWindowMs;
    for (const at of this.attackTimes) {
      if (Math.abs(at - segment.from) <= tolerance) return true;
    }
    return false;
  }

  /**
   * Cut one Note into the events the region says it contained.
   *
   * The Note keeps its own identity and its first segment; each later segment
   * becomes a Note of its own, backdated onto the boundary the region found.
   * The original is announced as structurally revised rather than silently
   * shortened, because a consumer holding it needs to know it is now one of
   * several rather than the whole thing.
   */
  private splitAtSegments(
    record: NoteRecord,
    segments: readonly RegionSegment[],
    out: TrackerEmission[]
  ): void {
    const originalEnd = record.endTime as SourceTimeMs;
    const created: string[] = [];
    const announcements: TrackerEmission[] = [];

    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i] as RegionSegment;
      const from = Math.max(segment.from, record.startTime);
      const to = Math.min(
        originalEnd,
        i + 1 < segments.length ? (segments[i + 1] as RegionSegment).from : segment.to
      );
      // Both sides, not just the new one. A boundary that leaves a stub behind
      // is the analysis window sliding across a boundary that is already there,
      // and the stub it leaves is a Note nobody played.
      if (to - from < this.config.deep.minSegmentMs) continue;
      if (from - record.startTime < this.config.deep.minSegmentMs) continue;
      const successor = this.beginFromSegment(segment, from, to, record, announcements);
      created.push(successor.id);
    }

    if (created.length === 0) return;

    // The original now ends where the second event began.
    const firstNewStart = Math.min(
      ...created.map((id) => (this.endedRecord(id) as NoteRecord).startTime)
    );
    record.endTime = Math.max(record.startTime, firstNewStart) as SourceTimeMs;
    record.deepStructural = true;

    if (record.announced) {
      const revisionNumber = record.bump("structuralRevision");
      out.push({
        type: "changed",
        note: record.snapshot(),
        change: {
          type: "structuralRevision",
          at: record.endTime,
          revisionNumber,
          // The opposite claim from an absorption, on the same field: these are
          // the rest of the events this Note turned out to be, and every one of
          // them really happened.
          relation: "split",
          relatedNoteIds: created,
        },
      });
    }
    // The revision lands before the Notes it announces, so a consumer learns
    // that the Note it is holding has become several BEFORE the first of them
    // arrives.
    for (const emission of announcements) out.push(emission);
  }

  /**
   * Open a Note for a segment nothing was emitted for.
   *
   * The sixteenths run has an open B ringing under it, so a picked A4 is
   * plainly present in the spectrum and never becomes the loudest fundamental
   * in any single window. The fast lane emitted nothing at all across it. This
   * is the case a re-segmenter exists for: an event the first pass did not
   * merely misname, but missed.
   */
  private insertFromSegment(
    segment: RegionSegment,
    neighbours: readonly NoteRecord[],
    out: TrackerEmission[]
  ): void {
    const min = this.config.deep.minSegmentMs;
    // Never where a Note already begins: that is the same event twice.
    for (const neighbour of neighbours) {
      if (Math.abs(neighbour.startTime - segment.from) < min) return;
    }
    let to = segment.to;
    for (const neighbour of neighbours) {
      if (neighbour.startTime > segment.from) to = Math.min(to, neighbour.startTime);
    }
    if (to - segment.from < min) return;
    this.beginFromSegment(segment, segment.from, to as SourceTimeMs, null, out);
  }

  /**
   * Build a Note from a segment and close it immediately.
   *
   * The audio is already in the past, so there is nothing to observe hop by
   * hop: the segment IS the evidence. It goes through the ordinary closing path
   * so that its `started`, `resolved` and `ended` come out in the same shape and
   * the same order as every other Note's.
   *
   * A child of a Note that had bloomed into an unnamed chord inherits that
   * abstention. Splitting a Note the recognizer declined to name is a claim
   * about how many events there were, not a licence to suddenly name them.
   */
  private beginFromSegment(
    segment: RegionSegment,
    from: SourceTimeMs,
    to: SourceTimeMs,
    parent: NoteRecord | null,
    out: TrackerEmission[]
  ): NoteRecord {
    const activation = segment.activations[0] ?? null;
    const frequencyHz = activation === null ? null : activation.frequencyHz;
    const originPitch: DetectedPitch | null =
      activation === null
        ? null
        : {
            midi: activation.midi,
            name: `${activation.pitchClass}${activation.octave}`,
            pitchClass: activation.pitchClass,
            octave: activation.octave,
            frequencyHz: activation.frequencyHz,
            centsOffset: 0,
            role: "first",
            confidence: activation.confidence,
          };

    const record = new NoteRecord({
      id: `n${this.nextId++}`,
      config: this.config,
      startTime: from,
      startSample: this.clock.toSamples(from),
      trigger: parent === null ? "attack" : "pitchChange",
      frequencyHz,
      originPitch,
      confidence: activation?.confidence ?? segment.confidence,
      rms: parent?.rms ?? 0,
      peak: parent?.maxPeak ?? 0,
    });
    record.deepResolved = true;
    record.deepStructural = true;
    record.lastVoicedAt = to;
    record.lastAudibleAt = to;
    record.lastSeenAt = to;
    record.frames = Math.max(1, segment.windows);
    record.confidenceSum = record.frames * (activation?.confidence ?? 0.5);
    record.maxRms = parent?.maxRms ?? 0;
    if (parent !== null) {
      record.polyphonic = parent.polyphonic;
      record.harmonyBloomed = parent.harmonyBloomed;
      record.harmonyLabel = parent.harmonyLabel;
      record.harmonyRoot = parent.harmonyRoot;
      record.harmonyQuality = parent.harmonyQuality;
      record.harmonyConfidence = parent.harmonyConfidence;
      record.estimatedVoiceCount = parent.estimatedVoiceCount;
    }

    this.notes.set(record.id, record);
    // A backdated end must not move the floor future backdating is measured
    // against: this Note is being closed in the past, not now.
    const floor = this.lastEndedAt;
    // `end` announces a Note that was never announced, which is every Note born
    // this way — a consumer must see it start before it sees it finish, even
    // though both facts arrive at once and both are backdated.
    this.end(record, to, out);
    this.lastEndedAt = floor;
    return record;
  }

  /** The harmony a Note currently answers to, for segmentation decisions. */
  currentHarmonyOf(noteId: string): string | null {
    return this.notes.get(noteId)?.harmonyLabel ?? null;
  }

  /**
   * Stop every Note that is still sounding, without letting any of them go.
   *
   * Separate from `flush` so the engine can close the take's last Notes, have
   * the deep lane rule on the region they live in, and only then release them.
   * The last event of a recording is exactly the one whose region has not
   * settled, and it should not be the one event that never gets a verdict.
   */
  closeOpenNotes(at: SourceTimeMs): TrackerEmission[] {
    const out: TrackerEmission[] = [];
    for (const record of [...this.notes.values()]) {
      this.end(record, Math.max(at, record.startTime), out);
    }
    this.publish(out);
    return out;
  }

  /** Ends every open Note. Called on stop, and at the end of offline input. */
  flush(at: SourceTimeMs): TrackerEmission[] {
    const out = this.closeOpenNotes(at);
    this.releaseClosed(EMPTY_SET, out, true);
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
    predecessor: NoteRecord | null = null,
    /**
     * Whether `predecessor` may be absorbed into this Note as a fragment of one
     * articulation. True only when an ATTACK ended it: a confirmed pitch step
     * is a boundary the player put there, and a legato note in a fast run is
     * short without being premature.
     */
    absorbPredecessor = false
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
      const attack = this.attackBurstStart ?? this.lastAttack;
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
    record.polyphonic = this.contextHarmonic >= HARMONIC_CONTEXT_THRESHOLD;
    if (predecessor !== null) record.decay.adopt(predecessor.decay);
    if (absorbPredecessor) this.absorbArticulationFragment(record, predecessor);
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
    // Vote for the Note this audio belongs to, which is not always the Note
    // sounding now. See `pitch.voteLagMs`.
    const lag = config.pitch.voteLagMs;
    const owner = lag > 0 ? (this.recordSoundingAt(t - lag) ?? record) : record;
    owner.noteVotes.set(
      nearest.midi,
      (owner.noteVotes.get(nearest.midi) ?? 0) + frame.pitch.confidence
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

      if (record.pendingAbsorbed.length > 0) {
        const absorbed = record.pendingAbsorbed.splice(0, record.pendingAbsorbed.length);
        const revisionNumber = record.bump("structuralRevision");
        out.push({
          type: "changed",
          note: record.snapshot(),
          change: {
            type: "structuralRevision",
            at: record.lastSeenAt,
            revisionNumber,
            relatedNoteIds: absorbed,
          },
        });
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
   * @param force release even Notes nobody has ruled on — the end of a take
   */
  releaseClosed(busy: ReadonlySet<string>, out: TrackerEmission[], force = false): void {
    for (let i = this.closing.length - 1; i >= 0; i--) {
      const record = this.closing[i] as NoteRecord;
      if (!force) {
        if (busy.has(record.id)) continue;
        // A Note nobody has re-analysed is not finished, whatever the queue
        // says. Holding it here is what makes the region reach back over it:
        // once it is gone from `closing` there is nothing left to correct.
        if (!record.deepResolved) continue;
      }
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

  /**
   * The Note that was sounding at `at`, live or already finished.
   *
   * Pitch evidence arrives later than the audio it describes, so by the time a
   * frame can be voted on, the Note it belongs to may have ended — on a fast
   * run that is most of the run. Attributing it to whatever is sounding NOW
   * instead is what gave each Note a share of its predecessor's pitch.
   */
  private recordSoundingAt(at: SourceTimeMs): NoteRecord | undefined {
    let best: NoteRecord | undefined;
    const consider = (record: NoteRecord): void => {
      if (record.startTime > at) return;
      if (record.endTime !== null && record.endTime <= at) return;
      if (best === undefined || record.startTime > best.startTime) best = record;
    };
    for (const record of this.notes.values()) consider(record);
    for (const record of this.closing) consider(record);
    for (let i = this.ended.length - 1; i >= 0; i--) consider(this.ended[i] as NoteRecord);
    return best;
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

/** A MIDI note's pitch class as a number, or null. */
function pitchClassIndex(midi: number | null): number | null {
  return midi === null ? null : ((midi % 12) + 12) % 12;
}

/** The Note whose span contains `at`, latest first. */
function ownerOf(records: readonly NoteRecord[], at: SourceTimeMs): NoteRecord | null {
  let best: NoteRecord | null = null;
  for (const record of records) {
    if (record.startTime > at) continue;
    if ((record.endTime ?? Number.POSITIVE_INFINITY) <= at) continue;
    if (best === null || record.startTime > best.startTime) best = record;
  }
  return best;
}

/** The segment whose span contains `at`. */
function ownerOfSegment(
  segments: readonly RegionSegment[],
  at: SourceTimeMs
): RegionSegment | null {
  for (const segment of segments) {
    if (at >= segment.from && at < segment.to) return segment;
  }
  return null;
}

/** True when any of `records` is sounding at `at`. */
function coveredBy(records: readonly NoteRecord[], at: SourceTimeMs): boolean {
  return ownerOf(records, at) !== null;
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
