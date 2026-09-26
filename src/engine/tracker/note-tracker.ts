/**
 * The semantic centre: fast-lane evidence in, evolving Notes out.
 *
 * Three commitments shape everything in this file, and they are consequences
 * of one another:
 *
 *  1. **Notes live in a Map.** A tracker that can hold exactly one sounding
 *     thing cannot represent a note beginning while another still rings — which
 *     is precisely what a restrum over a ringing chord, and a fast run over a
 *     decaying tail, both are.
 *
 *  2. **There are no modes.** One path runs, segmentation is driven by the same
 *     three cues regardless of what is being played — an attack, a pitch step,
 *     a harmony change — and a Note blooms into a chord when the deep lane
 *     finds evidence for one.
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
import { snapHop, type EngineConfig } from "../config.js";
import type {
  AttackEvidence,
  DeepSegmentation,
  FastFrame,
  HarmonicReading,
  PitchActivation,
  RegionSegment,
  RegionTransient,
} from "../contracts.js";
import type { FineOnset } from "../kernels/fine-onset.js";
import { SampleClock } from "../clock.js";
import { centsBetween, describeFrequency, midiToFrequency } from "../kernels/notes.js";
import { PitchChangeDetector, isOctaveJump } from "../fast/pitch-change.js";
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
 * One segmentation decision, as it was made.
 *
 * Diagnostic only: nothing in the engine reads these, and with no sink
 * installed nothing is allocated. It exists because "the tracker lost this
 * played note" is not an answer — the answer is which test rejected it and on
 * what numbers, and reconstructing that from the outside means reimplementing
 * the tracker, which is how a ledger comes to describe code that no longer
 * exists. See `scripts/measure-downstream-ledger.ts`.
 */
export type TrackerTraceEvent =
  | {
      kind: "onset";
      at: SourceTimeMs;
      /** The fast lane may not act on a gated hop, nor on a band-only one. */
      gated: boolean;
      broadband: boolean;
      band: boolean;
      sharpness: number;
      heldSharpness: number;
      fluxRatio: number;
      heldFluxRatio: number;
      riseRatio: number;
    }
  | {
      kind: "rearticulation";
      at: SourceTimeMs;
      noteId: string;
      accepted: boolean;
      /** Which test in `RearticulationDetector.verdict` decided. */
      reason: string;
      /** Old enough to be ENDED. A rejection here loses the arriving note. */
      settled: boolean;
      soundedMs: number;
      settleBarMs: number;
      pitchDiffers: boolean;
      gliding: boolean;
      /** Net displacement across the glide window, cents. See `glideCents()`. */
      glideCents: number;
      decayExcess: number | null;
      sharpness: number;
      heldSharpness: number;
      fluxRatio: number;
      heldFluxRatio: number;
      riseRatio: number;
      /** How far the envelope FELL before the transient. See `AttackEvidence.dipRatio`. */
      dipRatio: number;
      /** `frame.rms / sustainedRms`: the envelope against the Note's own baseline. */
      envelopeOverBaseline: number;
      /** `frame.rms / maxRms`: this hop against the loudest the Note has yet been. */
      levelOverPeak?: number;
      /** The onset kernel itself fired on this hop, as against the envelope witness. */
      kernelOnset: boolean;
      bloomed: boolean;
      /** The pace being played as the tracker read it here, or null with none. */
      localIoiMs?: number | null;
    }
  | { kind: "opened"; at: SourceTimeMs; noteId: string; trigger: NoteOriginTrigger }
  | {
      /**
       * The Note opened on a pick's contact and this attack is its release:
       * the boundary moved forward onto it. See `tracking.releaseRiseRatio`.
       */
      kind: "released";
      at: SourceTimeMs;
      noteId: string;
      /** Where the Note stood before, and the release's rise over its baseline. */
      from: SourceTimeMs;
      riseRatio: number;
      dipRatio: number;
      /** The pace being played when the boundary moved, or null with none read. */
      localIoiMs: number | null;
      /**
       * What said the Note opened on a contact: the fine hop, no rise, or
       * the release far louder (`tracking.contactGainDb`); `burst` when a
       * split's burst began on a contact that rose too little
       * (`tracking.burstContactRiseRatio`).
       */
      contact: "fine" | "no-rise" | "gain" | "burst";
      /**
       * `stub` when a split stub was absorbed without lending its start;
       * `gated` when the release was read on a hop the amplitude gate
       * refused (`tracking.releaseOnGatedHop`).
       */
      via: "unsettled" | "stub" | "gated" | "burst";
    }
  | {
      kind: "absorbed";
      at: SourceTimeMs;
      noteId: string;
      intoId: string;
      /** The absorbed Note's own span, and the pick each side came off. */
      durationMs: number;
      intoStartTime: SourceTimeMs;
      burstAt: number | null;
      intoBurstAt: number | null;
      /** The survivor's level at its start over the loudest the stub reached. */
      levelRatio?: number;
      /** How much of it the fast lane heard no pitch on; null when it has no hops there. */
      unvoiced?: number | null;
    }
  | {
      /**
       * A stub the tracker offered to `absorbArticulationFragment()` and it
       * declined, with the test that declined it.
       *
       * The counterpart of `absorbed`. A ledger that can only see the
       * absorptions that happened cannot tell a stub nobody offered from one
       * every guard was asked about and refused, and those want different
       * repairs.
       */
      kind: "declined";
      at: SourceTimeMs;
      noteId: string;
      intoId: string;
      reason: string;
      durationMs: number;
      /** `rms / maxRms` at its death: 1 means it was still rising. */
      fellTo: number;
      /** How much of it the fast lane heard no pitch on; null when it has no hops there. Prefix offers only. */
      unvoiced?: number | null;
    }
  | {
      /**
       * A settled Note split at a transient the amplitude gate refused, once
       * the level came back. See `tracking.gatedRepickDipRatio`.
       */
      kind: "gatedRepick";
      at: SourceTimeMs;
      noteId: string;
      dipRatio: number;
      /** The rise on the hop that confirmed it. */
      riseRatio: number;
    }
  | {
      kind: "ended";
      at: SourceTimeMs;
      noteId: string;
      startedAt: SourceTimeMs;
      announced: boolean;
      soundedMs: number;
      announceBarMs: number;
    };

/**
 * State moves worth telling a consumer about.
 *
 * Reaching `contender` is bookkeeping — every reading passes through it — while
 * becoming the leader, becoming settled, or being ruled out are all things a UI
 * showing the recognizer's thinking would want to react to.
 */
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
/** How far back the tracker remembers whether each hop was voiced, for a carved span the region lane delivers late. */
const VOICED_LOG_MS = 4000;
/** The window a damp's fall is measured against: see `tracking.dampFallDb`. */
const DAMP_MEDIAN_MS = 300;
/** How soon after the fall a damp must reach `tracking.dampDepthDb`. */
const DAMP_REACH_MS = 300;
/** Where a damped Note ends: the first hop this far under the median, in dB. */
const DAMP_END_DB = 6;
/** A Note quieter than this, in dB of RMS, is already too faint to damp. */
const DAMP_FLOOR_DB = -55;
/** How close a Note must follow the end of the one before to have been opened in its damp. */
const DAMP_GHOST_GAP_MS = 1;

/**
 * How close to its own peak a Note must still be for the transient that ends it
 * to be the same articulation still arriving.
 *
 * A pick is not instantaneous: the fast lane opens a Note on the first
 * transient and then spends a hop or two with nothing true to say, because an
 * attack is the least periodic part of a note and a strum's six strings arrive
 * one at a time. Whatever fires during those hops is the SAME pick still
 * landing, and the Note it interrupts has not had a chance to decay — it is at
 * or near the loudest it will ever be. A second pick is the opposite case: the
 * note it interrupts had peaked and begun to fall before fresh energy arrived.
 *
 * That is the Note measured against itself, so it means the same thing at any
 * level, on any signal path and at any tempo — which is exactly what a duration
 * cannot claim. At 140bpm a genuine sixteenth measures 80ms, well inside a
 * window sized so that a 120bpm strum's fragments are absorbed, and absorbing
 * it deletes a note somebody played.
 *
 * Not 1.0, because the RMS window ripples hop to hop; 5% is below that ripple
 * and above nothing. Fitted on the 120bpm fixtures, where it reproduces the
 * previous behaviour exactly.
 */
const STILL_RISING_FRACTION = 0.95;

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
/** The widest pitch step a damp drags the string through: a whole tone. */
const DAMP_STEP_SEMITONES = 2;

/** Bend movement below this is not worth an event, in cents. */
const BEND_EPSILON = 10;

/**
 * The fretting hand arriving before the pick.
 *
 * On a single string the next note is fretted before it is picked, and a
 * hammer-on or pull-off changes the ringing string's pitch tens of
 * milliseconds before any pick lands. The fast lane opens a Note on that
 * pitch step — "a legato step is two Notes" — and the pick then
 * re-articulates it, so one played note comes out as two. Measured on the
 * direct-input lead take, that is 8 of its 21 extra Notes at 72–196ms before
 * the pick, plus 5 shorter stubs of a pitch neither neighbour has, the
 * string half-stopped as the finger moves.
 *
 * A step-opened Note that ENDS on a pick within `PREFIX_MAX_MS` at the pitch
 * the pick then plays, and that carried no transient of its own, is that
 * pick's preparation and is absorbed into the picked Note — boundary at the
 * pick, name from the picked Note's own frames. A held hammer-on stays a
 * Note, and so does one that moves on to another pitch. These are held-out
 * readings until derivation material with re-picked legato exists
 * (`DECISION-033`).
 */
const PREFIX_MAX_MS = 250;
/** Longest silence between the prefix ending and the pick. */
const PREFIX_GAP_MS = 100;
/** A stroke this close to a Note's start means it was picked, not fretted. */
const PREFIX_TRANSIENT_MS = 30;
/**
 * How long before a step-opened Note's start a stroke still explains it.
 *
 * A pick the re-articulation detector refuses opens nothing; the pitch
 * detector then opens the Note once the new pitch has settled, 40–48ms after
 * the stroke on the derivation lead take (`clean-lead` `s8`), and the region
 * lane places a pitch-step boundary 62ms after a pick the fast lane missed
 * on the room-mic sixteenths (`s8` there too). A stroke inside this window
 * means the step WAS the pick, arriving late — not the fretting hand. On the
 * direct-input triplet take the closest prefix follows the pick before it by
 * 93ms (`t10` to `t11`), so the window is bounded on both sides; the mic and
 * DI readings are held-out.
 */
const PREFIX_LOOKBACK_MS = 80;
/** An onset this close to a contact the fine witness read is that contact. */
const CONTACT_MASK_MS = 15;
/** How long before a pitch step the contact that caused it may sit. See `contactLed`. */
const CONTACT_LEAD_MS = 30;
/**
 * How far the string has to be damped for a fine onset with no rebound to
 * read as a contact. On the direct input the pick landing on the string, or
 * the fretting hand arriving, damps it 12–24dB and nothing follows; a quiet
 * upstroke on the room-mic sixteenths reads a dip of 3–6dB and a rebound of
 * 2–6dB, and is a note somebody played. The bar sits between them.
 */
const CONTACT_DIP_DB = -10;

/**
 * How far below the lowest detected fundamental the fast lane's voted pitch
 * must sit before it is read as a chord's virtual pitch rather than a note.
 * An octave, less a semitone of grid slack; a fifth below (the missing
 * fundamental of one low string heard through a speaker) stays a note.
 */
const VIRTUAL_PITCH_SEMITONES = 11;
/**
 * The local note rate, and the shape of the estimator that reads it.
 *
 * Taken unchanged from the `PaceEstimator` in `docs/DETECTION-FINDINGS.md`
 * ("The constants are absolute milliseconds"): a ring of recent inter-onset
 * intervals, the median of the last eight, ignoring gaps too short to be two
 * notes, dropped after a silence. Nothing is fitted to these — the bars that
 * ARE derived live in `tracking.rateFragmentSpanFraction`,
 * `tracking.rateFragmentDipRatio` and the `rateFragmentNoRise*` trio.
 *
 * One property matters more than accuracy here, and it was measured rather
 * than assumed: a phantom boundary INSERTS an onset, which splits one true
 * interval into two short ones, so the estimate is dragged FAST by exactly the
 * errors the bar it feeds exists to remove. A fast rate gives a SHORTER bar and
 * therefore merges LESS, so the corruption is self-limiting rather than
 * self-reinforcing. Scaling the rate to 0.5x was measured to cost no labels.
 */
const RATE_GAPS = 8;
/**
 * Which recent gap to take as the interval. 0 is the shortest, 1 the longest.
 *
 * NOT the median, and the reason is a measured asymmetry rather than taste. A
 * MISSED onset merges two intervals into one and can only make a gap LONGER; a
 * PHANTOM onset splits one interval in two and can only make a gap SHORTER.
 * The bar this feeds is a fraction of the interval, so a long reading raises it
 * and suppresses real notes, while a short reading lowers it and merely does
 * less. Only one of those two errors is dangerous, and it is the one that
 * missed onsets cause.
 *
 * A median was tried first and failed in the pipeline exactly there: on
 * `lead-line-amped-sixteenths`, where the recognizer already misses a third of
 * the onsets, the surviving gaps are two and three sixteenths long, the median
 * read ~2.5x the true interval, and the raised bar cost a played note and took
 * that fixture's pitch-class gate below its threshold. A low percentile is
 * immune to that by construction, because dropping onsets never produces a
 * SHORT gap.
 */
const RATE_PERCENTILE = 0.5;
const RATE_MIN_INTERVAL_MS = 50;
const RATE_RESET_MS = 1500;
/**
 * There is deliberately NO fallback rate.
 *
 * An earlier version fell back to a whole note at 120bpm when it had no gaps
 * yet, and that single line was the whole of a measured regression: on
 * `lead-line-amped-sixteenths` the first Note of the take is 147ms long and
 * real, the fallback set its bar to 0.35 x 500 = 175ms, and it was suppressed —
 * costing a played note and taking that fixture's pitch-class gate under its
 * threshold. Every percentile of the estimator failed identically, because at
 * the start of a take none of them has any gap to read.
 *
 * The rule's claim is "shorter than a note at the pace currently being played".
 * With no pace measured there is no such claim to make, so `localIoiMs` returns
 * null and the caller leaves the bar alone. Abstaining is free here: it costs
 * only the first notes of a take, where nothing has yet gone wrong.
 */

/**
 * The fraction of the local interval a Note opened by a same-pitch boundary
 * must outlast before it is announced, or null when the boundary is not a
 * suspected tail fragment.
 *
 * Two shapes of suspicion, each with its own bar (see `tracking`): a boundary
 * with no envelope dip under it — the transient landed in a note still at
 * full strength — and one over which no energy arrived — the envelope after
 * it is no louder than the 80ms before it — provided the dip is not the deep
 * one a pick's contact leaves. A boundary showing both takes the longer bar.
 * `dip` and `rise` are null when nothing split at the same pitch.
 */
export function rateFragmentSpanFraction(
  dip: number | null,
  rise: number | null,
  bars: EngineConfig["tracking"]
): number | null {
  let fraction: number | null = null;
  if (dip !== null && dip >= bars.rateFragmentDipRatio) {
    fraction = bars.rateFragmentSpanFraction;
  }
  if (
    rise !== null &&
    dip !== null &&
    rise < bars.rateFragmentNoRiseRatio &&
    dip >= bars.rateFragmentNoRiseDipRatio
  ) {
    fraction = Math.max(fraction ?? 0, bars.rateFragmentNoRiseSpanFraction);
  }
  return fraction;
}

/**
 * A Note opened with less rise than this was opened on a pick's CONTACT, or
 * on nothing at all — not on energy arriving. The no-rise witness reads the
 * same population from the other side (`tracking.rateFragmentNoRiseRatio`):
 * DI contacts and phantoms rise 0.94 at their third quartile, real re-picks
 * 1.01 at their tenth percentile. 1.2 sits above every contact read and
 * under every release, and is not a tuned edge.
 */
const CONTACT_RISE = 1.2;

/** Opened by the fine witness, which fires on contacts, or with no rise. */
function isContactOpening(record: NoteRecord): boolean {
  return record.fineOpened || record.openingRise < CONTACT_RISE;
}

export class NoteTracker {
  private readonly config: EngineConfig;
  private readonly clock: SampleClock;
  /** One fast hop in ms, as the engine snaps it: the resolution of a fast-lane boundary. */
  private readonly hopMs: number;
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
   * A re-pick the amplitude gate refused on a settled Note, waiting one
   * articulation for the level to come back. See `tracking.gatedRepickDipRatio`.
   */
  private pendingGatedRepick: { attack: AttackEvidence; noteId: string } | null = null;
  /**
   * The newest same-pitch transient the verdict refused as `gated`, with the
   * rise it read. The fine witness delivers a contact 65ms late, so the
   * release this may be arrives before the Note it belongs to exists. See
   * `tracking.releaseBeforeFineContact`.
   */
  private lastGatedRefusal: { attack: AttackEvidence; riseRatio: number } | null = null;
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
  /** The same transients as sample indices, so the deep lane can address them. */
  private readonly attackSamples: number[] = [];
  /** The same moments with their witness and rise, for `transientsIn`. */
  private readonly attackRises: RegionTransient[] = [];
  /**
   * Whether the fast lane heard a pitch on each recent hop, and the hop's
   * level, oldest first. See `unvoicedFractionIn` and `levelFallIn`.
   */
  private readonly voicedLog: { at: SourceTimeMs; voiced: boolean; rms: number }[] = [];
  /** The newest entry of `attackRises` still owed the next hop's rise, or null. */
  private pendingRise: RegionTransient | null = null;
  /**
   * The attacks the fast lane ACTED on, oldest first: the broadband kernel's
   * firings above the gate. A fine onset landing within
   * `transient.fineOnsetDedupeMs` of one of these is the same stroke, already
   * handled, and must not re-articulate it a second time.
   */
  private readonly actedAttackTimes: SourceTimeMs[] = [];
  /**
   * The fine onsets the envelope read as a CONTACT rather than a stroke: flux
   * with no rebound out of the dip behind it. The pick landing on the string,
   * the fretting hand arriving — a transient nobody played a note with. Any
   * onset on `attackTimes` within `CONTACT_MASK_MS` of one of these is that
   * contact seen by a coarser witness, and `strokeNear` does not count it.
   */
  private readonly contactTimes: SourceTimeMs[] = [];
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

  /**
   * When each Note opened, oldest first, for the local-rate estimate.
   *
   * Every opening goes in, phantoms included: that is what a causal estimator
   * has. See the constants above for why that is safe here. With
   * `tracking.paceIgnoresRetracted`, an opening is struck out again once its
   * Note is absorbed or dropped unannounced — a fate decided in the past, so
   * the estimate stays causal — and the gap it cut in two is whole again.
   */
  private readonly openings: Array<{ at: number; id: string }> = [];

  /**
   * Where segmentation decisions go when anybody is listening. Null in every
   * production path, and checked rather than called, so tracing costs one
   * comparison per decision and allocates nothing.
   */
  trace: ((event: TrackerTraceEvent) => void) | null = null;

  constructor(clock: SampleClock, config: EngineConfig) {
    this.clock = clock;
    this.config = config;
    this.hopMs = clock.toMs(snapHop(config.analysis.hopMs, clock.sampleRate));
    this.pitchChange = new PitchChangeDetector(config);
    this.rearticulation = new RearticulationDetector(config);
  }

  reset(): void {
    this.openings.length = 0;
    this.notes.clear();
    this.closing.length = 0;
    this.ended.length = 0;
    this.nextId = 1;
    this.lastAttack = null;
    this.attackBurstStart = null;
    this.pendingGatedRepick = null;
    this.lastGatedRefusal = null;
    this.attackTimes.length = 0;
    this.attackSamples.length = 0;
    this.attackRises.length = 0;
    this.voicedLog.length = 0;
    this.pendingRise = null;
    this.actedAttackTimes.length = 0;
    this.contactTimes.length = 0;
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

    this.voicedLog.push({ at: t, voiced: frame.pitch.frequencyHz !== null, rms: frame.rms });
    while (this.voicedLog.length > 0 && (this.voicedLog[0] as { at: SourceTimeMs }).at < t - VOICED_LOG_MS) {
      this.voicedLog.shift();
    }

    // Every transient, gated or not. The amplitude gate exists to stop the fast
    // lane opening a Note on room tone, and it is right to be conservative
    // there — but a note picked into the tail of the one before it can sit
    // under the gate for the hop where the pick lands, which is exactly the
    // event the region lane is trying to corroborate. The gate still decides
    // what the fast lane may act on; this list only records what it saw.
    // The band witness is recorded on the same list and for the same reason.
    // The fast lane may not act on it — see `FastFrame.bandOnset` — but "energy
    // arrived at exactly here" is the half of the answer the region lane cannot
    // produce for itself, and a quiet upstroke 107ms after the downstroke it
    // answers is visible to the band and to nothing else.
    // The rise witness lags the flux by one hop: the hop that carries a
    // transient reads the rise of the hop before it. The transient recorded on
    // the previous hop takes this hop's rise when it is the larger.
    if (this.pendingRise !== null) {
      this.pendingRise.riseRatio = Math.max(this.pendingRise.riseRatio, frame.riseRatio);
      this.pendingRise = null;
    }
    if (frame.attack !== null || frame.bandOnset) {
      const at = frame.attack?.at ?? frame.at;
      if (this.trace !== null) {
        this.trace({
          kind: "onset",
          at,
          gated: frame.gated,
          broadband: frame.attack !== null,
          band: frame.bandOnset,
          sharpness: frame.attack?.sharpness ?? 0,
          heldSharpness: frame.attack?.heldSharpness ?? 0,
          fluxRatio: frame.attack?.fluxRatio ?? 0,
          heldFluxRatio: frame.attack?.heldFluxRatio ?? 0,
          riseRatio: frame.riseRatio,
        });
      }
      const last = this.attackTimes[this.attackTimes.length - 1];
      if (last === undefined || at > last) {
        this.attackTimes.push(at);
        this.attackSamples.push(frame.attack?.atSample ?? frame.sampleIndex);
        const rise: RegionTransient = {
          sample: frame.attack?.atSample ?? frame.sampleIndex,
          broadband: frame.attack !== null,
          riseRatio: frame.riseRatio,
        };
        this.attackRises.push(rise);
        this.pendingRise = rise;
      }
      if (this.attackTimes.length > ATTACK_HISTORY) {
        this.attackTimes.shift();
        this.attackSamples.shift();
        this.attackRises.shift();
      }
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
      this.actedAttackTimes.push(frame.attack.at);
      if (this.actedAttackTimes.length > ATTACK_HISTORY) this.actedAttackTimes.shift();
    }

    /* (a0) Strokes the fine-hop witness confirmed since the last frame. They
     *      describe audio tens of milliseconds old and act only where the
     *      broadband kernel did not; see `handleFineOnset`. */
    if (frame.fineOnsets !== undefined) {
      for (const onset of frame.fineOnsets) this.handleFineOnset(onset, frame, out);
    }

    let active = this.current();
    /** Set when a split ends a Note whose successor should inherit its decay. */
    let splitFrom: NoteRecord | null = null;
    /** The contact a split's boundary was moved off, for the successor's ring-out clock. */
    let burstContactAt: SourceTimeMs | null = null;
    /**
     * `dipRatio` at a SAME-PITCH split, for the Note that split is about to
     * open. Null when nothing split, or when the split changed pitch — a
     * boundary the pitch itself vouches for is not a tail-fragment candidate.
     * See `tracking.rateFragmentSpanFraction`.
     */
    let splitSamePitchDip: number | null = null;
    /**
     * `riseRatio` at the same split: the second shape of the same suspicion,
     * read on the direct input. See `tracking.rateFragmentNoRiseRatio`.
     */
    let splitSamePitchRise: number | null = null;

    /* (a-) A re-pick whose release began under the amplitude gate: the
     *      string was damped nearly silent, the pick's transient landed on a
     *      hop the gate refused, and the level has now come back. The
     *      boundary is the refused transient. See
     *      `tracking.gatedRepickDipRatio`. */
    if (this.pendingGatedRepick !== null) {
      const pending = this.pendingGatedRepick;
      const window = this.clock.durationSamples(config.transient.articulationMs);
      if (
        active === null ||
        pending.noteId !== active.id ||
        frame.sampleIndex - pending.attack.atSample > window
      ) {
        this.pendingGatedRepick = null;
      } else if (
        !frame.gated &&
        frame.riseRatio >= config.tracking.releaseRiseRatio &&
        // Ending a Note not yet announced drops it. The damped note behind a
        // gated re-pick has sounded its full length; one this young is a
        // stroke still being decided, and a sixteenth that has not cleared
        // its bar would be lost to the split (the E5 eighths DI take, 28227ms).
        active.announced &&
        // And it has sounded at least half the pace being played. Shorter is
        // the next stroke's contact that a witness already opened, and the
        // gated transient is that stroke's own release, not a second stroke
        // (the E5 eighths DI take, 11602 to 11693ms).
        this.soundedHalfThePace(active, pending.attack.at)
      ) {
        this.pendingGatedRepick = null;
        if (this.trace !== null) {
          this.trace({
            kind: "gatedRepick",
            at: pending.attack.at,
            noteId: active.id,
            dipRatio: pending.attack.dipRatio,
            riseRatio: frame.riseRatio,
          });
        }
        const previous = active;
        active.restruck = true;
        this.end(active, pending.attack.at, out);
        active = this.begin(
          "attack",
          frame,
          {
            at: pending.attack.at,
            atSample: pending.attack.atSample,
            frequencyHz: frame.pitch.frequencyHz,
          },
          previous,
          true
        );
      }
    }

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
      // ...and by a real step in cents, not merely by rounding to a different
      // name. `nearest` quantises: a note sitting 40 cents sharp of D5 reads
      // as D#5, so a held note with vibrato on it changes name every few hops
      // without the frequency having gone anywhere. Measured on the direct-
      // input lead take, that is what splits sustained quarter notes — a D5
      // held for 428ms sheds a "D#5" 280ms in, on an arriving pitch 50 cents
      // from the one it is already sounding. `pitch.stepThresholdCents` is
      // already the answer to "how far is a step", and the bend guard directly
      // below has always measured in cents for exactly this reason.
      const arrivingCents =
        frame.pitch.frequencyHz === null || sounding === null
          ? null
          : Math.abs(centsBetween(frame.pitch.frequencyHz, midiToFrequency(sounding)));
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
        arrivingCents !== null &&
        arrivingCents >= config.pitch.stepThresholdCents &&
        frame.pitch.confidence >= config.pitch.splitConfidence;
      const verdict = this.rearticulation.verdict(
        frame.attack,
        frame,
        gliding,
        active.sustainedRms,
        pitchDiffers,
        active.decay.excess(frame.at, frame.rms),
        // A Note that has decided it is a chord — not merely one sounding while
        // the room happens to read as harmonic, which on a fast run is every
        // other window. The decay model describes a struck chord ringing out;
        // applying it to a bent or vibratoed single note describes nothing.
        //
        // Deliberately "bloomed" rather than "named". Blooming is a claim about
        // the AUDIO: several fundamentals, spread across more than a fifth, and
        // no single period for YIN to lock onto. Naming is additionally a claim
        // that a chord template fitted, and a template fitting is the first
        // thing a saturated amp sim takes away — on the amped cowboy take the
        // recognizer emits "unknown" for chords it hears perfectly well as
        // chords. Gating on the name meant the one path that protects a ringing
        // chord from being chopped switched itself off on exactly the signal
        // that needed it, and the chord then went down the monophonic route and
        // shed a Note every few hundred milliseconds.
        active.harmonyBloomed,
        active.ringOutSoundedMs
      );
      const rearticulated = verdict.accepted;
      // A harmonically-named Note has proved it is a chord, and a chord's own
      // ring-out is full of transient-looking energy for hundreds of
      // milliseconds. A Note that has only ever been a single pitch has no such
      // internal structure and may be re-articulated as soon as it is real.
      const settled =
        active.harmonyLabel !== null
          ? active.lastSeenAt - active.startTime >= config.transient.minRestrumMs
          : active.soundedMs >= config.tracking.minStableMs;
      if (this.trace !== null) {
        this.trace({
          kind: "rearticulation",
          at: frame.attack.at,
          noteId: active.id,
          accepted: rearticulated,
          reason: verdict.reason,
          settled,
          soundedMs: active.soundedMs,
          settleBarMs:
            active.harmonyLabel !== null
              ? config.transient.minRestrumMs
              : config.tracking.minStableMs,
          pitchDiffers,
          gliding,
          glideCents: this.pitchChange.glideCents(),
          decayExcess: active.decay.excess(frame.at, frame.rms),
          sharpness: frame.attack.sharpness,
          heldSharpness: frame.attack.heldSharpness,
          fluxRatio: frame.attack.fluxRatio,
          heldFluxRatio: frame.attack.heldFluxRatio,
          riseRatio: frame.riseRatio,
          dipRatio: frame.attack.dipRatio,
          envelopeOverBaseline: frame.rms / Math.max(active.sustainedRms, 1e-9),
          levelOverPeak: frame.rms / Math.max(active.maxRms, 1e-9),
          kernelOnset: frame.attack.flux,
          bloomed: active.harmonyBloomed,
          localIoiMs: this.localIoiMs(frame.attack.at),
        });
      }
      if (!rearticulated && verdict.reason === "gated" && !pitchDiffers) {
        this.lastGatedRefusal = { attack: frame.attack, riseRatio: frame.riseRatio };
      }
      if (
        !rearticulated &&
        verdict.reason === "gated" &&
        settled &&
        !pitchDiffers &&
        !active.harmonyBloomed &&
        config.tracking.gatedRepickDipRatio > 0 &&
        frame.attack.dipRatio <= config.tracking.gatedRepickDipRatio
      ) {
        this.pendingGatedRepick = { attack: frame.attack, noteId: active.id };
      }
      // A muted restrum refused for a weak transient is the one rejection in
      // this detector that later evidence can overturn. Hold it.
      if (!rearticulated && settled && verdict.reason === "chord-not-sharp") {
        active.rejectedRestrum = {
          at: frame.attack.at,
          atSample: frame.attack.atSample,
          excess: active.decay.excess(frame.at, frame.rms),
          rms: frame.rms,
        };
      }
      // The Note opened on the pick's contact, and this is the pick letting
      // go: the boundary belongs here. Nothing has been announced yet, so the
      // start simply moves. See `tracking.releaseRiseRatio`.
      if (rearticulated && !settled && !pitchDiffers && this.isRelease(active, frame)) {
        if (this.trace !== null) {
          this.trace({
            kind: "released",
            at: frame.attack.at,
            noteId: active.id,
            from: active.startTime,
            riseRatio: frame.riseRatio,
            dipRatio: frame.attack.dipRatio,
            localIoiMs: this.localIoiMs(frame.attack.at),
            contact: active.fineOpened ? "fine" : "no-rise",
            via: "unsettled",
          });
        }
        active.startTime = frame.attack.at;
        active.startSample = frame.attack.atSample;
      }
      // The same release, on a hop the amplitude gate refused: the string is
      // still under the gate when it begins to speak, and the verdict above
      // never read it. Nothing opens here — the Note is already open and
      // unannounced, and only its start moves. See
      // `tracking.releaseOnGatedHop`.
      //
      // A Note the fine witness opened is settled the moment it exists, and
      // its contact can arrive on the release's own hop; it is read here too,
      // still unannounced, and keeps its announce clock on the contact so the
      // move does not re-decide it. See `tracking.releaseOnFineOpenedFrame`.
      if (
        !rearticulated &&
        verdict.reason === "gated" &&
        config.tracking.releaseOnGatedHop &&
        (!settled || (active.fineOpened && config.tracking.releaseOnFineOpenedFrame)) &&
        this.isRelease(active, frame)
      ) {
        if (this.trace !== null) {
          this.trace({
            kind: "released",
            at: frame.attack.at,
            noteId: active.id,
            from: active.startTime,
            riseRatio: frame.riseRatio,
            dipRatio: frame.attack.dipRatio,
            localIoiMs: this.localIoiMs(frame.attack.at),
            contact: active.fineOpened ? "fine" : "no-rise",
            via: "gated",
          });
        }
        if (settled) active.releasedFromContact = true;
        active.startTime = frame.attack.at;
        active.startSample = frame.attack.atSample;
      }
      if (rearticulated && settled) {
        // The boundary is the FIRST attack of this burst, not the one that
        // finally cleared the bar. A pick crossing six strings, or a pick
        // scrape followed by the string speaking, is one articulation with
        // several transients, and the event began at the first of them.
        //
        // Unless the Note now ending is the one that burst already opened. A
        // Note cannot end before it began, and placing the boundary back at its
        // own start collapses it to nothing — so a run picked faster than one
        // burst window comes out at half its real rate, one Note per pair.
        // When the burst is already this Note's own, the boundary is the
        // transient in hand.
        const burst = this.attackBurstStart ?? frame.attack;
        let boundary = burst.at > active.startTime ? burst : frame.attack;
        // Unless that first attack was the pick landing on a single string:
        // it mutes the string, the verdict refused it for carrying no energy,
        // and the stroke sounds at the release in hand. See
        // `tracking.burstContactRiseRatio`.
        if (
          boundary !== frame.attack &&
          config.tracking.burstContactRiseRatio > 0 &&
          boundary.riseRatio < config.tracking.burstContactRiseRatio &&
          !pitchDiffers &&
          !active.harmonyBloomed &&
          frame.riseRatio >= config.tracking.releaseRiseRatio
        ) {
          if (this.trace !== null) {
            this.trace({
              kind: "released",
              at: frame.attack.at,
              noteId: active.id,
              from: boundary.at,
              riseRatio: frame.riseRatio,
              dipRatio: frame.attack.dipRatio,
              localIoiMs: this.localIoiMs(frame.attack.at),
              contact: "burst",
              via: "burst",
            });
          }
          burstContactAt = boundary.at;
          boundary = frame.attack;
        }
        active.restruck = true;
        this.end(active, boundary.at, out);
        // The successor is created below, once this hop has decided what it is.
        // It inherits the decay: a restrum re-excites the strings that were
        // already ringing, so the curve is continuous through the split.
        splitFrom = active;
        if (!pitchDiffers) {
          splitSamePitchDip = frame.attack.dipRatio;
          splitSamePitchRise = frame.attack.riseRatio;
        }
        active = null;
      }
    }

    /* (a2) A rejected restrum the mute has since contradicted. */
    if (active !== null && active.rejectedRestrum !== null) {
      active = this.answerRejectedRestrum(active, frame, out);
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

    // A step that ends a Note too young to have been announced is not ending
    // an event. It is renaming a stub.
    //
    // The attack transient is the least periodic part of a note, so for the
    // first tens of milliseconds the pitch reported belongs to whatever was
    // ringing before. The estimator then catches up, and what it reports is a
    // step. The Note is ended two hops old, dropped for never having cleared
    // `minStableMs` — a start with no end is worse than nothing — and its
    // successor, which is the same event, begins late with none of the stub's
    // span. That is the same shape as a burst boundary landing on a Note's own
    // start, and the same repair applies: the stub is a fragment of the
    // articulation that shed it, so the Note that follows takes its start time
    // and keeps its own pitch evidence. Boundary from the stub, name from the
    // frames that describe what was played.
    //
    // Bounded by the consequence rather than by a duration: while the Note the
    // step would end is too young to be ANNOUNCED, or while every hop it has
    // ever seen said the same indefensible thing. The first is the ordinary
    // case; the second is the one a duration cannot reach, because a stub in a
    // slower passage can sit five hops on its predecessor's pitch and clear
    // the announcement bar without ever having described itself. Widening the
    // duration to reach it instead costs `clean-lead` a labelled note, which
    // is what pins this bound from the other side.
    //
    // And the reading it is leaving has to be one it cannot defend: see
    // `wearsPredecessorsName`. Without that the lead takes gain three split
    // events and two extra Notes, because a stub in a triplet run is
    // sometimes a real note that simply arrived quietly.
    const pitchStillArriving =
      active !== null &&
      pitchChange !== null &&
      (active.soundedMs < active.announceThresholdMs ||
        // Every vote it holds is for the reading it is now leaving: this Note
        // has accumulated no evidence of its own at all.
        active.dominantMidi() === describeFrequency(pitchChange.fromHz).midi ||
        // Or it never held any reading: see `NoteRecord.heldReading`.
        !active.heldReading) &&
      this.cannotDefendReading(active, pitchChange.fromHz, pitchChange.toHz);

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
        { at, atSample, frequencyHz: pitchChange.toHz },
        previous,
        pitchStillArriving
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
          null,
          splitFrom,
          splitFrom !== null
        );
        // A Note opened by a same-pitch boundary that had no envelope dip under
        // it, or no energy arriving over it, is a suspected tail fragment: it
        // has to outlast a fraction of the interval currently being played
        // before it is announced at all. One that dies first is dropped by
        // `end()`, which already discards a Note that never cleared its bar —
        // so this refuses the fragment rather than announcing and retracting
        // it, and costs latency only on a boundary that is doubtful in both
        // witnesses at once.
        if (burstContactAt !== null && this.config.tracking.burstContactRingOutOnContact) {
          active.ringOutFrom = burstContactAt;
        }
        const fraction = rateFragmentSpanFraction(
          splitSamePitchDip,
          splitSamePitchRise,
          this.config.tracking
        );
        if (fraction !== null) {
          const ioi = this.localIoiMs(active.startTime);
          if (ioi !== null) active.rateFragmentBarMs = fraction * ioi;
        }
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
          const silentSince = active.silentSince as SourceTimeMs;
          if (!this.absorbDampGhost(active, silentSince, out)) {
            this.end(active, this.dampedAt(active, silentSince)?.end ?? silentSince, out);
          }
          active = null;
        } else {
          this.observe(active, frame);
        }
      } else {
        active.unvoicedSince = null;
        active.silentSince = null;
        this.observe(active, frame);
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
    if (record.heldReading) {
      record.heldHarmonyReadings++;
      if (polyphony < this.config.harmony.minPolyphony) record.heldSingleReadings++;
    }
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
    // A period no string is sounding is a chord's, not a note's. An open D
    // (D3 A3 D4 F#4) is the harmonic series of D2 — partials 2, 3, 4 and 5 —
    // so YIN finds a confident 73Hz period in it and the monophonic veto
    // below refused to let the first D chord of the direct-input take bloom
    // at all; it was emitted as the note "D2". When the voted pitch sits an
    // octave or more below the LOWEST fundamental the spectrum actually
    // holds, the confidence is the chord's periodicity, and the veto — which
    // exists to keep a single picked note from blooming — does not apply.
    const virtualPitch = this.isVirtualPitch(record, activations);
    const harmonicNow =
      polyphony >= this.config.harmony.minPolyphony &&
      evidence.voiceSpreadSemitones >= this.config.harmony.minVoiceSpreadSemitones &&
      (meanConfidence <= this.config.harmony.maxMonophonicConfidence || virtualPitch)
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
    record.burstAt = this.attackBurstStart?.at ?? null;
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
    const monophonic =
      meanPitchConfidence > this.config.harmony.maxMonophonicConfidence && !virtualPitch;
    // One string, whatever its attack looked like: it answers to its pitch.
    // See `harmony.oneStringReadingFraction`. Only the name follows; the
    // Note keeps the segmentation a bloomed Note gets (see `NoteRecord.oneString`).
    const oneStringBar = this.config.harmony.oneStringReadingFraction;
    const oneString =
      oneStringBar > 0 &&
      record.heldHarmonyReadings > 0 &&
      record.heldSingleReadings >= oneStringBar * record.heldHarmonyReadings;
    if (oneString !== record.oneString) {
      const previous = record.currentLabel();
      record.oneString = oneString;
      const label = record.currentLabel();
      if (this.speaksFor(record) && label !== record.lastEmitted.label) {
        const revisionNumber = record.bump("harmonyCorrection");
        record.lastEmitted.label = label;
        out.push({
          type: "changed",
          note: record.snapshot(),
          change: { type: "harmonyCorrection", at, revisionNumber, previous: { label: previous } },
        });
      }
    }
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
    // An ended Note's new name is announced too, until it is resolved: `ended`
    // no longer waits for the deep lane, so this is how its answer arrives.
    if (this.speaksFor(record) && label !== record.lastEmitted.label) {
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

  /**
   * Absorb the fretting hand's preparation into the Note the pick opened.
   *
   * Two ways in. When a picked Note is announced — the moment its own frames
   * can say what pitch it plays — it looks back for the Note just before it
   * (`claimPrefix`). When the region lane later carves a pitch step out of a
   * ringing Note's tail, the carved Note looks forward for the pick that
   * ended it (`offerPrefix`): on the direct-input triplet take that is where
   * most prefixes come from, the fast lane having read the hammer-on as the
   * old note continuing and the region lane having found the step afterwards.
   *
   * See `PREFIX_MAX_MS`. The candidate is a prefix when the fretting hand
   * opened it — a pitch step, or a transient the fine witness read as a
   * contact — with no stroke behind it, it ended within a quarter second on a
   * pick, and either it carries the picked Note's pitch class or it is a stub
   * at a pitch neither the picked Note nor the note before it has. Its events
   * stand as history; the recognizer's final position is that it was the
   * picked Note's preparation, delivered as a `structuralRevision` on that
   * Note. The picked Note's start does not move: the pick is the boundary.
   */
  private claimPrefix(survivor: NoteRecord, out: TrackerEmission[]): void {
    if (survivor.prefixClaimed) return;
    survivor.prefixClaimed = true;
    if (!this.isPicked(survivor)) return;

    let predecessor: NoteRecord | null = null;
    const consider = (record: NoteRecord): void => {
      if (record === survivor || record.merged || record.endTime === null) return;
      if (record.startTime >= survivor.startTime) return;
      const gap = survivor.startTime - record.endTime;
      if (gap < -1 || gap > PREFIX_GAP_MS) return;
      if (predecessor === null || record.endTime > (predecessor.endTime as number)) predecessor = record;
    };
    for (const record of this.notes.values()) consider(record);
    for (const record of this.closing) consider(record);
    for (const record of this.ended) consider(record);
    if (predecessor !== null) this.tryClaimPrefix(predecessor, survivor, out);
  }

  /**
   * The region lane has carved `prefix` out of the past: find the pick that
   * ended it. A boundary the region put on a fast-lane transient is a stroke
   * by the region's own account and is not offered. Its energy witness does
   * not separate the cases — a hammer-on injects energy too, and on the
   * direct-input triplet take the region calls two of the six prefixes an
   * energy rise — so a pitch step and an energy rise are both offered and
   * left to the stroke test.
   */
  private offerPrefix(prefix: NoteRecord, segment: RegionSegment, out: TrackerEmission[]): void {
    if (prefix.endTime === null || prefix.merged) return;
    let successor: NoteRecord | null = null;
    const consider = (record: NoteRecord): void => {
      if (record === prefix || record.merged) return;
      if (record.startTime <= prefix.startTime) return;
      const gap = record.startTime - (prefix.endTime as number);
      if (gap < -1 || gap > PREFIX_GAP_MS) return;
      if (successor === null || record.startTime < successor.startTime) successor = record;
    };
    for (const record of this.notes.values()) consider(record);
    for (const record of this.closing) consider(record);
    for (const record of this.ended) consider(record);
    if (successor === null || !this.isPicked(successor)) return;
    // The string under the hand is not a stroke, whatever the region called
    // the boundary that opened it: the attack branch places one on the
    // pick's contact. See `tracking.prefixUnderHand`.
    const underHand = this.underHand(prefix);
    const refused = segment.boundary === "attack" && !underHand ? "region-attack" : null;
    this.tryClaimPrefix(prefix, successor, out, refused, underHand);
  }

  /**
   * A carved Note the fast lane heard no pitch on for most of its hops, and
   * whose level fell: the string half-stopped under the fretting hand
   * between a note's end and the next stroke's release. A sustained note
   * the detector merely lost the pitch of holds its level, and is not. See
   * `tracking.prefixUnderHand` and `tracking.underHandLevelFall`.
   */
  private underHand(record: NoteRecord): boolean {
    if (!this.config.tracking.prefixUnderHand || record.endTime === null) return false;
    const fraction = this.unvoicedFractionIn(record.startTime, record.endTime);
    if (fraction === null || fraction < this.config.tracking.underHandUnvoicedFraction) return false;
    const fall = this.levelFallIn(record.startTime, record.endTime);
    return fall !== null && fall <= this.config.tracking.underHandLevelFall;
  }

  /** The quietest hop in `[from, to)` over the loudest, or null when the fast lane has no hops there. */
  private levelFallIn(from: SourceTimeMs, to: SourceTimeMs): number | null {
    let loudest = 0;
    let quietest = Infinity;
    for (const entry of this.voicedLog) {
      if (entry.at < from) continue;
      if (entry.at >= to) break;
      loudest = Math.max(loudest, entry.rms);
      quietest = Math.min(quietest, entry.rms);
    }
    if (quietest === Infinity) return null;
    return loudest > 0 ? quietest / loudest : 0;
  }

  /** How much of `[from, to)` the fast lane heard no pitch on, or null when it has no hops there. */
  private unvoicedFractionIn(from: SourceTimeMs, to: SourceTimeMs): number | null {
    let hops = 0;
    let unvoiced = 0;
    for (const entry of this.voicedLog) {
      if (entry.at < from) continue;
      if (entry.at >= to) break;
      hops++;
      if (!entry.voiced) unvoiced++;
    }
    return hops === 0 ? null : unvoiced / hops;
  }

  private tryClaimPrefix(
    prefix: NoteRecord,
    survivor: NoteRecord,
    out: TrackerEmission[],
    /** A reason the offer already failed, traced here so every candidate is accounted for. */
    refused: string | null = null,
    /** The prefix is the string under the hand. See `underHand`. */
    underHand = false
  ): void {
    const duration = (prefix.endTime as number) - prefix.startTime;
    const unvoiced = this.unvoicedFractionIn(prefix.startTime, prefix.endTime as SourceTimeMs);
    const decline = (reason: string): void => {
      if (this.trace === null) return;
      this.trace({
        kind: "declined",
        at: prefix.startTime,
        noteId: prefix.id,
        intoId: survivor.id,
        reason: `prefix:${reason}`,
        durationMs: duration,
        fellTo: prefix.maxRms === 0 ? 1 : prefix.rms / prefix.maxRms,
        unvoiced,
      });
    };

    if (refused !== null) return decline(refused);
    // The fretting hand opened it: a pitch step, or a transient the fine
    // witness read as a contact. A stroke opened a note somebody played.
    const contactOpened = prefix.trigger === "attack" && this.contactNear(prefix.startTime);
    if (prefix.trigger !== "pitchChange" && !contactOpened) return decline("trigger");
    if (prefix.harmonyBloomed) return decline("decided");
    if (duration > PREFIX_MAX_MS) return decline("too-long");
    // Fretted, not picked: no stroke at its own start, nor in the window
    // before it where a refused pick opens a Note late on the pitch settling.
    // Under the hand, the transient at its start is the pick's contact: a
    // stroke there is one whose rise cleared the release bar.
    if (this.strokeNear(prefix.startTime, PREFIX_LOOKBACK_MS, PREFIX_TRANSIENT_MS, underHand)) {
      return decline("stroke");
    }

    const prefixClass = pitchClassIndex(prefix.dominantMidi());
    const survivorClass = pitchClassIndex(survivor.dominantMidi());
    if (survivorClass === null) return decline("unpitched");
    // The string half-stopped under the hand reads whatever pitch it reads.
    if (prefixClass === null && !underHand) return decline("unpitched");
    let claim = underHand || prefixClass === survivorClass;
    if (!claim && this.contactLed(prefix)) {
      // A stub at a pitch nobody played: the string half-stopped between
      // the note before it and the one the pick then plays. Only when the
      // fine witness saw the hand land — a contact at its start, or just
      // before the pitch step it opened on. A step alone at a pitch neither
      // neighbour has is as often the neighbour misread as a transition.
      const before = this.recordSoundingAt((prefix.startTime - 1) as SourceTimeMs);
      const beforeClass =
        before === undefined || before.id === prefix.id ? null : pitchClassIndex(before.dominantMidi());
      claim = beforeClass !== null && prefixClass !== beforeClass;
    }
    if (!claim) return decline("pitch");

    prefix.merged = true;
    this.retractOpening(prefix);
    if (this.trace !== null) {
      this.trace({
        kind: "absorbed",
        at: prefix.startTime,
        noteId: prefix.id,
        intoId: survivor.id,
        durationMs: duration,
        intoStartTime: survivor.startTime,
        burstAt: prefix.burstAt,
        intoBurstAt: survivor.burstAt,
        unvoiced,
      });
    }
    const revisionNumber = survivor.bump("structuralRevision");
    out.push({
      type: "changed",
      note: survivor.snapshot(),
      change: {
        type: "structuralRevision",
        at: survivor.startTime,
        revisionNumber,
        relation: "absorbed",
        relatedNoteIds: [prefix.id],
      },
    });
  }

  /**
   * A Note the pick opened: an attack the fine witness did not read as a
   * contact, or a pitch step with a stroke at it — the re-articulation
   * detector refuses a pick into a ringing string often enough that on the
   * direct-input triplet take half the played notes open on the pitch step
   * the same hop.
   */
  private isPicked(record: NoteRecord): boolean {
    if (record.harmonyBloomed) return false;
    if (record.trigger === "attack") return !this.contactNear(record.startTime);
    return this.strokeNear(record.startTime, PREFIX_TRANSIENT_MS, PREFIX_TRANSIENT_MS);
  }

  /**
   * An onset in `[at - before, at + after]` that the fine witness did not
   * read as a contact. With `sounded`, only one whose rise cleared
   * `tracking.releaseRiseRatio`: the release, not the pick's contact.
   */
  private strokeNear(at: SourceTimeMs, before: number, after: number, sounded = false): boolean {
    const bar = this.config.tracking.releaseRiseRatio;
    for (let i = 0; i < this.attackTimes.length; i++) {
      const onset = this.attackTimes[i] as SourceTimeMs;
      if (onset < at - before || onset > at + after) continue;
      if (sounded && (this.attackRises[i]?.riseRatio ?? 0) < bar) continue;
      if (!this.contactNear(onset)) return true;
    }
    return false;
  }

  private contactNear(at: SourceTimeMs): boolean {
    for (const contact of this.contactTimes) {
      if (Math.abs(contact - at) <= CONTACT_MASK_MS) return true;
    }
    return false;
  }

  /**
   * The hand landed at this Note's start, or in the `CONTACT_LEAD_MS` before
   * the pitch step it opened on: the pitch detector needs a few hops of the
   * new pitch before it opens, so the contact leads the step by 16–21ms on
   * the direct-input triplet take.
   */
  private contactLed(record: NoteRecord): boolean {
    for (const contact of this.contactTimes) {
      const lead = record.startTime - contact;
      if (lead >= -CONTACT_MASK_MS && lead <= CONTACT_LEAD_MS) return true;
    }
    return false;
  }

  /**
   * A stroke the fine-hop witness confirmed, delivered after the fact.
   *
   * Recorded for the region lane whatever else happens: "energy arrived at
   * exactly here" is the half of the answer the region cannot produce for
   * itself. It ACTS only where the broadband kernel did not — a fine onset
   * within `fineOnsetDedupeMs` of an attack the fast lane already acted on is
   * that attack — and only over silence or a single sounding note. Over a
   * chord it does nothing: a strum's interior is full of transient-looking
   * energy, and the witnesses that judge it (`sharpEnough`, the decay curve)
   * were derived for the broadband reading and stay in charge there.
   *
   * The boundary is backdated onto the onset's own sample. The frames the
   * old Note absorbed since then were the new note's, which on the case this
   * exists for — a note re-picked at its own pitch — costs nothing, and on a
   * new pitch costs a few hops of votes the successor makes up at once.
   */
  private handleFineOnset(onset: FineOnset, frame: FastFrame, out: TrackerEmission[]): void {
    const config = this.config;
    const at = this.clock.toMs(onset.atSample);

    // In order, for the region lane: this onset predates the newest entries.
    let index = this.attackTimes.length;
    while (index > 0 && (this.attackTimes[index - 1] as number) > at) index--;
    if (index === 0 || (this.attackTimes[index - 1] as number) !== at) {
      this.attackTimes.splice(index, 0, at);
      this.attackSamples.splice(index, 0, onset.atSample);
      this.attackRises.splice(index, 0, { sample: onset.atSample, broadband: false, riseRatio: 0 });
      if (this.attackTimes.length > ATTACK_HISTORY) {
        this.attackTimes.shift();
        this.attackSamples.shift();
        this.attackRises.shift();
      }
    }
    // A contact: the string was damped hard and nothing followed. See
    // `CONTACT_DIP_DB` for what this must not catch.
    const contact =
      onset.reboundDb < config.transient.fineOnsetReboundDb && onset.dipDb <= CONTACT_DIP_DB;
    if (contact) {
      this.contactTimes.push(at);
      if (this.contactTimes.length > ATTACK_HISTORY) this.contactTimes.shift();
    }

    for (const acted of this.actedAttackTimes) {
      if (Math.abs(acted - at) <= config.transient.fineOnsetDedupeMs) return;
    }

    const active = this.current();
    if (active === null) {
      // Nothing was sounding: the stroke opens a Note, backdated to the pick
      // but never over the end of whatever finished after it. Energy has to
      // have followed the transient — a hand brushing a string between
      // chords makes flux and no rebound.
      if (onset.reboundDb < config.transient.fineOnsetReboundDb) return;
      let start = at;
      if (this.lastEndedAt !== null && start < this.lastEndedAt) start = this.lastEndedAt;
      const opened = this.begin(
        "attack",
        frame,
        { at: start, atSample: this.clock.toSamples(start), frequencyHz: frame.pitch.frequencyHz },
        null,
        false
      );
      opened.lastAudibleAt = frame.at;
      opened.fineOpened = true;
      this.releaseAlreadyPassed(opened);
      return;
    }

    if (active.harmonyBloomed || active.polyphonic) return;
    if (at <= active.startTime) return;
    if (at - active.startTime < config.tracking.minStableMs) return;
    // A bend sweeps the spectrum and fires flux witnesses inside one note.
    if (this.pitchChange.isGliding()) return;
    // The pick landed on the string, then played it. Without the dip this is
    // sustain ripple the flux happened to read; without the rebound it is a
    // contact or a mute that no stroke followed.
    if (onset.dipDb > config.transient.fineOnsetDipDb) return;
    if (onset.reboundDb < config.transient.fineOnsetReboundDb) return;

    if (this.trace !== null) {
      this.trace({
        kind: "rearticulation",
        at,
        noteId: active.id,
        accepted: true,
        reason: "fine-onset",
        settled: true,
        soundedMs: at - active.startTime,
        settleBarMs: config.tracking.minStableMs,
        pitchDiffers: false,
        gliding: false,
        glideCents: this.pitchChange.glideCents(),
        decayExcess: active.decay.excess(at, frame.rms),
        sharpness: 0,
        heldSharpness: 0,
        fluxRatio: onset.value,
        heldFluxRatio: 0,
        riseRatio: frame.riseRatio,
        // The fine witness measures this same fall, in dB rather than as a
        // ratio — `dipAround` reads the 5ms envelope minimum against its prior
        // maximum, which is what `AttackEvidence.dipRatio` is. Converted rather
        // than left at 1, because 1 means "nothing fell" and something did.
        dipRatio: 10 ** (onset.dipDb / 20),
        envelopeOverBaseline: frame.rms / Math.max(active.sustainedRms, 1e-9),
        kernelOnset: false,
        bloomed: active.harmonyBloomed,
      });
    }
    active.restruck = true;
    this.end(active, at, out);
    const successor = this.begin(
      "attack",
      frame,
      { at, atSample: onset.atSample, frequencyHz: frame.pitch.frequencyHz },
      active,
      false
    );
    // The stroke has been sounding since the pick: the rebound was measured
    // before this Note existed. Without this its "sounded" clock starts at
    // the dip, where the frames are gated, and the next stroke 100ms later
    // finds it too young to be ended.
    successor.lastAudibleAt = frame.at;
    successor.fineOpened = true;
    this.releaseAlreadyPassed(successor);
  }

  /**
   * A Note the fine witness just opened on a contact whose release has
   * already been and gone: refused as `gated` on the Note before, because
   * the witness confirms an onset 65ms after it and the release arrived
   * first. The start moves onto it, as the release test would have moved
   * it had the Note existed, and the announce clock stays on the contact.
   * See `tracking.releaseBeforeFineContact`.
   */
  private releaseAlreadyPassed(record: NoteRecord): void {
    const refusal = this.lastGatedRefusal;
    if (!this.config.tracking.releaseBeforeFineContact || refusal === null) return;
    const window = this.clock.durationSamples(this.config.transient.articulationMs);
    const gap = refusal.attack.atSample - record.startSample;
    if (gap <= 0 || gap > window) return;
    if (refusal.riseRatio < this.config.tracking.releaseRiseRatio) return;
    if (this.trace !== null) {
      this.trace({
        kind: "released",
        at: refusal.attack.at,
        noteId: record.id,
        from: record.startTime,
        riseRatio: refusal.riseRatio,
        dipRatio: refusal.attack.dipRatio,
        localIoiMs: this.localIoiMs(refusal.attack.at),
        contact: "fine",
        via: "gated",
      });
    }
    record.releasedFromContact = true;
    record.startTime = refusal.attack.at;
    record.startSample = refusal.attack.atSample;
    this.lastGatedRefusal = null;
  }

  /**
   * Is the pitch this Note voted for one that no detected fundamental is
   * sounding — an octave or more below the lowest of them?
   *
   * `activations` arrive ascending in MIDI, so the first is the lowest. Two
   * of them are required: a single fundamental with the vote an octave under
   * it is the ordinary missing-fundamental reading of one note, which the
   * bass estimator handles and which must stay a note.
   */
  private isVirtualPitch(record: NoteRecord, activations: readonly PitchActivation[]): boolean {
    if (activations.length < 2) return false;
    const voted = record.dominantMidi();
    if (voted === null) return false;
    const lowest = (activations[0] as PitchActivation).midi;
    return lowest - voted >= VIRTUAL_PITCH_SEMITONES;
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
    record.burstAt = this.attackBurstStart?.at ?? null;
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
    const decline = (reason: string): void => {
      if (this.trace === null) return;
      this.trace({
        kind: "declined",
        at: predecessor.startTime,
        noteId: predecessor.id,
        intoId: survivor.id,
        reason,
        durationMs: predecessor.durationMs,
        fellTo: predecessor.maxRms === 0 ? 1 : predecessor.rms / predecessor.maxRms,
      });
    };
    if (predecessor.deepStructural) return decline("deep-structural");
    // A Note that named a chord, or that sustained past one articulation, is an
    // event somebody played. Only the stub of a forming articulation qualifies.
    if (predecessor.harmonyBloomed) return decline("bloomed");
    // Unless it never held a pitch and the survivor is its pitch arriving:
    // through an amp that can take 130ms. See `NoteRecord.heldReading`.
    const contact = this.isLoudContact(predecessor, survivor);
    if (
      predecessor.durationMs > this.config.transient.articulationMs &&
      !(survivor.absorbedRenaming && !predecessor.heldReading) &&
      !contact
    ) {
      return decline("too-long");
    }
    // And a Note that had already begun to decay was not a stub. See
    // `STILL_RISING_FRACTION`: a fragment of a forming articulation is
    // interrupted by the same pick still arriving, so it is at its own peak
    // when it dies, while a note answered by a second pick had peaked and
    // started to fall. Duration cannot separate those at two tempos; this is
    // the same claim made about the Note against itself.
    if (predecessor.rms < predecessor.maxRms * STILL_RISING_FRACTION) {
      return decline("already-falling");
    }
    // Contiguous by construction when the split ended the predecessor here, but
    // checked rather than assumed: a gap means silence, and silence means two
    // separate events.
    const end = predecessor.endTime;
    if (end === null) return decline("no-end");
    if (Math.abs(end - survivor.startTime) > this.config.harmony.mergeMaxGapMs) {
      return decline("gap");
    }

    if (this.trace !== null) {
      this.trace({
        kind: "absorbed",
        at: predecessor.startTime,
        noteId: predecessor.id,
        intoId: survivor.id,
        durationMs: predecessor.durationMs,
        intoStartTime: survivor.startTime,
        burstAt: predecessor.burstAt,
        intoBurstAt: survivor.burstAt,
        levelRatio: survivor.rms / Math.max(predecessor.maxRms, 1e-9),
      });
    }
    predecessor.merged = true;
    this.retractOpening(predecessor);
    survivor.pendingAbsorbed.push(predecessor.id, ...predecessor.pendingAbsorbed);
    // A stub the pick's own release split off was the pick's contact: it is
    // absorbed like any stub, but the boundary stays on the release. See
    // `tracking.releaseRiseRatio`.
    const bar = this.config.tracking.releaseRiseRatio;
    if (contact || (bar > 0 && isContactOpening(predecessor) && survivor.openingRise >= bar)) {
      if (this.trace !== null) {
        this.trace({
          kind: "released",
          at: survivor.startTime,
          noteId: survivor.id,
          from: predecessor.startTime,
          riseRatio: survivor.openingRise,
          dipRatio: survivor.openingDip,
          localIoiMs: this.localIoiMs(survivor.startTime),
          contact: predecessor.fineOpened ? "fine" : contact ? "gain" : "no-rise",
          via: "stub",
        });
      }
      return;
    }
    survivor.startTime = predecessor.startTime;
    survivor.startSample = predecessor.startSample;
  }

  /**
   * Whether `stub`, split off by the attack that opened `survivor`, was the
   * pick's contact heard through an amp: opened by an attack, and the note
   * arriving on the release at least `tracking.contactGainDb` louder than it.
   */
  private isLoudContact(stub: NoteRecord, survivor: NoteRecord): boolean {
    const bar = this.config.tracking.contactGainDb;
    if (bar <= 0 || stub.trigger !== "attack" || survivor.trigger !== "attack") return false;
    if (stub.openingRms <= 0) return false;
    return 20 * Math.log10(survivor.openingRms / stub.openingRms) >= bar;
  }

  /**
   * Whether `frame.attack`, landing in a Note too young to be re-articulated,
   * is the release of the pick whose contact opened it: the Note opened on a
   * contact, this hop is inside one articulation of its start, and the audio
   * rose over the 80ms before it — which spans the contact — by the bar. See
   * `tracking.releaseRiseRatio`.
   */
  /** Whether `record` has sounded at least half the local interval, or no pace is read. */
  private soundedHalfThePace(record: NoteRecord, at: SourceTimeMs): boolean {
    const ioi = this.localIoiMs(at);
    return ioi === null || record.soundedMs >= 0.5 * ioi;
  }

  private isRelease(active: NoteRecord, frame: FastFrame): boolean {
    const bar = this.config.tracking.releaseRiseRatio;
    if (bar <= 0 || frame.attack === null) return false;
    if (active.announced || active.harmonyBloomed) return false;
    if (!isContactOpening(active)) return false;
    // In samples: attack times are hop-quantised, and six hops of 640 at
    // 48kHz is 80ms in exact arithmetic and 80.0000000000018 in doubles
    // (the E5 eighths DI take at 14627ms read outside the window by that).
    const window = this.clock.durationSamples(this.config.transient.articulationMs);
    if (frame.attack.atSample - active.startSample > window) return false;
    return frame.riseRatio >= bar;
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
        // Nor a Note the fast lane deliberately ENDED on a re-articulation and
        // that lived long enough to be announced. The same argument applies: a
        // re-articulation is a decision that a new stroke began, and the Note it
        // closed is the stroke before it, already reported to the consumer.
        // Swallowing it retracts a detection and drags the survivor's start back
        // over a stroke it did not begin — which is how a run of picked notes
        // comes out as one long chord. A fragment of a forming articulation is
        // ended by the pitch settling, not by a second attack, and dies before
        // the announcement bar, which is what the bar is for.
        if (candidate.restruck && candidate.announced) continue;
        if (candidate.harmonyLabel !== null) continue;
        if (candidate.endTime === null) continue;
        if (candidate.endTime - candidate.startTime > config.mergeMaxFragmentMs) continue;
        if (candidate.endTime > earliest.startTime + config.mergeMaxGapMs) continue;
        if (candidate.endTime < earliest.startTime - config.mergeMaxGapMs) continue;
        if (survivor.startTime - candidate.startTime > config.mergeLookbackMs) continue;
        // A fragment of this attack came off the same pick this Note did. Two
        // Notes opened under different attack bursts are two strokes, and this
        // loop walks backwards through contiguous candidates: without the
        // check, one Note arriving after a run of short ones swallows the whole
        // run. On a triplet at 140bpm that is six played notes absorbed into
        // the seventh. See `NoteRecord.burstAt`.
        if (
          candidate.burstAt !== null &&
          survivor.burstAt !== null &&
          candidate.burstAt !== survivor.burstAt
        ) {
          continue;
        }
        if (previous === null || candidate.startTime > previous.startTime) previous = candidate;
      }
      if (previous === null) break;
      previous.merged = true;
      this.retractOpening(previous);
      if (this.trace !== null) {
        this.trace({
          kind: "absorbed",
          at: previous.startTime,
          noteId: previous.id,
          intoId: survivor.id,
          durationMs: previous.durationMs,
          intoStartTime: survivor.startTime,
          burstAt: previous.burstAt,
          intoBurstAt: survivor.burstAt,
        });
      }
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
   * Every transient recorded inside `[fromSample, toSample)`, ascending.
   *
   * The half of the answer the region lane cannot produce for itself. Its own
   * windows are 85ms long at a hop of 21ms, which localises a boundary to about
   * a fifth of a 140bpm sixteenth; a pick localises to one sample. What the
   * region adds is whether anything followed the pick.
   */
  transientSamplesIn(fromSample: number, toSample: number): number[] {
    const out: number[] = [];
    for (const sample of this.attackSamples) {
      if (sample >= fromSample && sample < toSample) out.push(sample);
    }
    return out;
  }

  /** `transientSamplesIn`, with each moment's witness and rise, copied. */
  transientsIn(fromSample: number, toSample: number): RegionTransient[] {
    return this.attackRises
      .filter((t) => t.sample >= fromSample && t.sample < toSample)
      .map((t) => ({ ...t }));
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
    // Their extent is history and cannot be rewritten — the `resolved` for
    // them has been delivered — but a name is a belief, and the region saw the whole
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

    // The region has decided how many events its span contains and where each
    // of them began. Everything from here reconciles the Notes onto THAT
    // decision rather than proposing boundaries into the partition the fast
    // lane already made — which is the difference between a lane that can
    // improve a partition and one that owns it. A boundary landing 61ms before
    // the end of the Note in front of it used to become a split candidate too
    // short to survive, and the event it described was lost; now the Note in
    // front of it ends there.
    const min = this.config.deep.minSegmentMs;
    /** Every segment after the first is a claim that an event began there. */
    const claims: RegionSegment[] = [];
    for (let i = 1; i < segments.length; i++) claims.push(segments[i] as RegionSegment);

    /** Split points inside a Note, by Note id, in time order. */
    const inside = new Map<string, RegionSegment[]>();

    for (const segment of claims) {
      const owner = ownerOf(open, segment.from);
      if (owner === null) {
        // Inside a Note that has named its own chord, the witnesses that find
        // a fresh note in a line fire all through one strum. Nothing to do.
        if (coveredBy(named, segment.from)) continue;
        this.insertFromSegment(segment, candidates, out);
        continue;
      }
      if (!this.isRealBoundary(owner, segment)) continue;
      const from = Math.max(segment.from, owner.startTime);
      // The fast lane already put a boundary here; the region agrees with it.
      if (from - owner.startTime < min) continue;

      const end = owner.endTime as SourceTimeMs;
      if (end - from >= min) {
        const list = inside.get(owner.id);
        if (list === undefined) inside.set(owner.id, [segment]);
        else list.push(segment);
        continue;
      }

      // The boundary lands in the last few tens of milliseconds of the Note
      // that owns it. That Note is not two events — it is one event whose end
      // the fast lane placed a little late, followed by an event it never
      // opened at all. Truncate it and carve out the successor.
      // Only a boundary the fast lane witnessed as a transient may shorten a
      // Note the recognizer already stood behind. A leader that changes sixty
      // milliseconds before a Note ends is the analysis window straddling the
      // boundary that is already there — the next note bleeding into the
      // window — and truncating on that costs three false positives on the
      // 140bpm lead take while recovering nothing anywhere. A transient is
      // localised to the sample, and it is the only witness that can be.
      if (segment.boundary !== "attack") continue;
      this.carveAfter(owner, segment, candidates, out);
    }

    for (const [id, mine] of inside) {
      const record = open.find((candidate) => candidate.id === id);
      if (record === undefined || record.merged) continue;
      const owned = ownerOfSegment(segments, record.startTime);
      this.splitAtSegments(record, [owned ?? mine[0] as RegionSegment, ...mine], out);
    }

    if (this.config.deep.regionMerge) {
      for (const segment of segments) this.mergeWithinSegment(segment, open, out);
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
   * Make the boundary a mute says was there after all.
   *
   * The three power-chord takes play one figure: a chord on the 1, the same
   * chord again on the 2, then the hand comes down and stops it. That second
   * strike is a MUTED restrum — it damps the strings, so it puts total energy
   * DOWN while plainly re-articulating the chord — and only its transient gives
   * it away. On the amp-sim path the compression flattens the transient until
   * `sharpEnough` cannot see it, and three of those strikes are lost. The
   * accepted and the rejected strokes are the same event played the same way;
   * held sharpness reads 0.73, 0.84 and 1.60 against a bar of 0.9 for the three
   * that fail and 2.28, 1.71 and 1.65 for the three that pass, and no bar
   * reaches the first group without admitting the chord's own sustain.
   *
   * The mute that follows is not flattened by anything. A mute REMOVES energy,
   * and a compressor, a room and a decaying string can all imitate an arrival
   * but none of them can imitate a removal — which is why
   * `scripts/measure-mute-witness.ts` separates 48 of 48 strokes on all three
   * signal paths where every witness at the boundary itself overlaps.
   *
   * So the rejection is held and the boundary made retroactively, backdated to
   * the transient that was refused. Two things this must not become:
   *
   *  - It cannot invent a Note out of a mute. A rejected TRANSIENT has to
   *    exist; a single strike left to ring and then stopped has nothing to
   *    resurrect, which is what `rejectedRestrum` being null means.
   *  - The mute's own hand noise must not be the candidate it resurrects.
   *    `muteWitnessGapMs` requires real separation between the two, and the
   *    measured separation on the fixtures is 308ms and more.
   *
   * Read against the Note's own fitted decay rather than any absolute level.
   * The absolute reading measures the recording: the direct take's ANSWERED
   * strokes collapse further than the amp take's MUTED ones, so a bar chosen
   * across paths says nothing about the playing.
   */
  private answerRejectedRestrum(
    active: NoteRecord,
    frame: FastFrame,
    out: TrackerEmission[]
  ): NoteRecord {
    const pending = active.rejectedRestrum;
    if (pending === null) return active;
    const config = this.config.transient;
    const age = frame.at - pending.at;

    // Closed unanswered: the chord was left to ring, so the rejection stands.
    if (age > config.muteWitnessWindowMs) {
      active.rejectedRestrum = null;
      return active;
    }
    if (age < config.muteWitnessGapMs) return active;

    // The chord has to have been ringing when the transient landed. A refused
    // transient on a chord already down to a fraction of its own peak is finger
    // noise on a dying string, and resurrecting it because the chord is stopped
    // later invents a Note nobody played.
    if (pending.rms < active.maxRms * config.muteWitnessLiveFraction) return active;

    const excess = active.decay.excess(frame.at, frame.rms);
    if (excess === null || excess >= config.muteCollapseExcess) return active;

    active.rejectedRestrum = null;
    const previous = active;
    this.end(active, pending.at, out);
    return this.begin(
      "attack",
      frame,
      { at: pending.at, atSample: pending.atSample, frequencyHz: frame.pitch.frequencyHz },
      previous,
      false
    );
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
      this.retractOpening(record);
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
      // A damp, not a note. Stopping a fretted string pushes it sharp for a
      // moment as it dies, and the region hears the new leader for as long as
      // the string still rings. A small change in the last stretch of a Note
      // that then fell silent is the hand, not the player's next note: a legato
      // note is ended by what follows it, not by silence. See `deep.dampTailMs`.
      const tail = this.config.deep.dampTailMs;
      const own = record.dominantMidi();
      if (
        tail > 0 &&
        record.silentSince !== null &&
        record.endTime !== null &&
        record.endTime - segment.from <= tail &&
        segment.dominantMidi !== null &&
        own !== null &&
        Math.abs(segment.dominantMidi - own) <= DAMP_STEP_SEMITONES
      ) {
        return false;
      }
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
   * End a Note where the region says the next event began, and carve that event
   * out of the audio behind it.
   *
   * The case this exists for is the one the region lane could see and could not
   * act on. Over the sixteenths run the region reads a leader of B4 -> A4 -> B4
   * and the A4 stretch is an event the fast lane emitted nothing at all for —
   * but the boundary estimate lands a few tens of milliseconds before the Note
   * in front of it stopped, so that Note *owned* the boundary and it became a
   * split candidate far too short to survive. Owning the partition means the
   * answer is the other way round: the region decided an event began there, so
   * the Note in front of it ends there and the event is carved out of what
   * follows.
   *
   * The successor is bounded by the next thing anybody emitted, not by the
   * segment alone. Letting a carved event run the region's full length was
   * measured and is worse — it overlaps the Note after it and reads as a false
   * positive.
   */
  private carveAfter(
    record: NoteRecord,
    segment: RegionSegment,
    neighbours: readonly NoteRecord[],
    out: TrackerEmission[]
  ): void {
    const min = this.config.deep.minSegmentMs;
    const from = Math.max(segment.from, record.startTime) as SourceTimeMs;
    // Both sides have to survive: a truncation that leaves a stub behind is the
    // analysis window sliding across a boundary that is already there.
    if (from - record.startTime < min) return;

    let to = segment.to;
    // Every Note the tracker still holds, not only the region's candidates. A
    // Note that began inside the region and is still sounding past its edge is
    // not a candidate — the region reaches only as far as the last Note that
    // ended inside it — yet it is exactly the Note a boundary here coincides
    // with. Since DECISION-055 an envelope rise is placed on the transient
    // that rose, which is the sample the fast lane opened its own Note on; a
    // carve there would be that Note a second time (the A3 eighths take,
    // 32293ms: the region's owner ended 4e-12ms after the boundary, so it
    // owned it, and the successor already standing there was out of sight).
    const everyNote = this.config.deep.regionCarveSeesEveryNote;
    const known = everyNote
      ? [...neighbours, ...this.notes.values(), ...this.closing, ...this.ended]
      : [...neighbours, ...this.notes.values()];
    for (const neighbour of known) {
      if (neighbour === record || neighbour.merged) continue;
      // A Note already begins here: the fast lane put this boundary in, and
      // the region agrees with it. Within one hop, which is the fast lane's
      // own resolution.
      if (everyNote && Math.abs(neighbour.startTime - from) <= this.hopMs) return;
      if (neighbour.startTime > from) to = Math.min(to, neighbour.startTime) as SourceTimeMs;
    }
    if (to - from < min) return;

    const announcements: TrackerEmission[] = [];
    const successor = this.beginFromSegment(segment, from, to, record, announcements);
    record.endTime = from;
    record.deepStructural = true;

    if (record.announced) {
      const revisionNumber = record.bump("structuralRevision");
      out.push({
        type: "changed",
        note: record.snapshot(),
        change: {
          type: "structuralRevision",
          at: from,
          revisionNumber,
          relation: "split",
          relatedNoteIds: [successor.id],
        },
      });
    }
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
   * so that its `started`, `ended` and `resolved` come out in the same shape and
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
    // A pitch step carved out of a ringing Note's tail may be the fretting
    // hand arriving before the pick that ended it. See `claimPrefix`.
    if (parent !== null) this.offerPrefix(record, segment, out);
    return record;
  }

  /**
   * End every Note that is still sounding, without resolving any of them.
   *
   * Separate from `releaseClosed` so the engine can end the take's last
   * Notes, have the deep lane rule on the region they live in, and only then
   * resolve them. The last event of a recording is exactly the one whose
   * region has not settled, and it should not be the one event that never gets
   * a verdict.
   */
  closeOpenNotes(at: SourceTimeMs): TrackerEmission[] {
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
      openingRise: frame.riseRatio,
      openingDip: frame.attack?.dipRatio ?? 1,
    });
    record.polyphonic = this.contextHarmonic >= HARMONIC_CONTEXT_THRESHOLD;
    record.burstAt = this.attackBurstStart?.at ?? null;
    if (predecessor !== null) record.decay.adopt(predecessor.decay);
    if (absorbPredecessor) {
      // A step-split stub lends its boundary but not its evidence. See
      // `NoteRecord.announceSoundedMs`.
      if (trigger === "pitchChange") record.absorbedRenaming = true;
      this.absorbArticulationFragment(record, predecessor);
    }
    this.notes.set(record.id, record);
    this.openings.push({ at, id: record.id });
    if (this.openings.length > RATE_GAPS * 4) this.openings.shift();
    if (this.trace !== null) {
      this.trace({ kind: "opened", at, noteId: record.id, trigger });
    }
    if (frequencyHz !== null) this.pitchChange.clearAfterSplit(frequencyHz, at);
    return record;
  }

  /** Folds one hop's evidence into a Note. */
  private observe(record: NoteRecord, frame: FastFrame): void {
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

    record.noteReading(hz);
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
  }

  /** Emits `started` once identity has settled, and `changed` on real changes. */
  private publish(out: TrackerEmission[]): void {
    for (const record of this.notes.values()) {
      if (record.endTime !== null) continue;

      if (!record.announced) {
        // Measure over how long the Note SOUNDED, not wall-clock since it
        // started: a Note in release still ages, so a 24ms blip could otherwise
        // cross a 45ms stability gate purely by sitting in its release grace.
        if (record.announceSoundedMs < record.announceThresholdMs) continue;
        record.announced = true;
        record.lastEmitted = {
          label: record.currentLabel(),
          confidence: record.overallConfidence(),
          bendCents: record.bendCents,
          lifecycle: record.lifecycle,
        };
        out.push({ type: "started", note: record.snapshot() });
        this.claimPrefix(record, out);
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

    for (const record of this.closing) this.announceLateLabel(record, out);
  }

  /**
   * An opening that never became a Note is not an event the pace is measured
   * on. See `tracking.paceIgnoresRetracted`.
   */
  private retractOpening(record: NoteRecord): void {
    if (!this.config.tracking.paceIgnoresRetracted) return;
    const index = this.openings.findIndex((opening) => opening.id === record.id);
    if (index >= 0) this.openings.splice(index, 1);
  }

  /**
   * The interval between notes the player is currently producing, in ms.
   *
   * Median of the recent gaps between Note openings. Strictly causal — only
   * openings at or before `at` are read — and deliberately built from the
   * tracker's own output, because that is the only thing available live.
   */
  private localIoiMs(at: SourceTimeMs): number | null {
    const gaps: number[] = [];
    for (let i = this.openings.length - 1; i > 0 && gaps.length < RATE_GAPS; i--) {
      const later = (this.openings[i] as { at: number }).at;
      // Strictly before: the opening being judged must not enter its own estimate.
      if (later >= at) continue;
      const gap = later - (this.openings[i - 1] as { at: number }).at;
      if (gap > RATE_RESET_MS) break;
      if (gap < RATE_MIN_INTERVAL_MS) continue;
      gaps.push(gap);
    }
    if (gaps.length === 0) return null;
    gaps.sort((a, b) => a - b);
    return gaps[Math.min(gaps.length - 1, Math.round((gaps.length - 1) * RATE_PERCENTILE))] as number;
  }

  /**
   * Where the player damped `record`, when it is ending in silence at
   * `silentSince`: the level fell `tracking.dampFallDb` under its recent
   * median, reached `tracking.dampDepthDb` under it soon after, and never
   * came back. Null when nothing in the Note looks like a damp, so it ends
   * where the sound did.
   */
  private dampedAt(
    record: NoteRecord,
    silentSince: SourceTimeMs
  ): { end: SourceTimeMs; fell: SourceTimeMs } | null {
    const { dampFallDb: fall, dampDepthDb: depth } = this.config.tracking;
    if (fall <= 0) return null;
    const log = this.voicedLog;
    const db = (i: number): number => 20 * Math.log10(Math.max((log[i] as { rms: number }).rms, 1e-9));
    const at = (i: number): number => (log[i] as { at: number }).at;
    const first = log.findIndex((entry) => entry.at >= record.startTime);
    if (first < 0) return null;
    for (let i = first + 1; i < log.length && at(i) < silentSince; i++) {
      const window: number[] = [];
      for (let k = i - 1; k >= first && at(k) >= at(i) - DAMP_MEDIAN_MS; k--) window.push(db(k));
      if (window.length * 2 < DAMP_MEDIAN_MS / Math.max(at(i) - at(i - 1), 1)) continue;
      window.sort((a, b) => a - b);
      const median = window[window.length >> 1] as number;
      if (median < DAMP_FLOOR_DB || db(i) >= median - fall) continue;
      let reached = false;
      let recovered = false;
      for (let k = i + 1; k < log.length; k++) {
        if (db(k) > median - fall / 2) {
          recovered = true;
          break;
        }
        if (at(k) - at(i) <= DAMP_REACH_MS && db(k) <= median - depth) reached = true;
      }
      if (recovered || !reached) continue;
      let j = i;
      while (j > first + 1 && db(j - 1) < median - DAMP_END_DB) j--;
      return { end: Math.max(at(j), record.startTime) as SourceTimeMs, fell: at(i) as SourceTimeMs };
    }
    return null;
  }

  /**
   * Whether a Note still sounding opened at `record`'s end at least
   * `tracking.dampFallDb` under `record`'s median level over the 300ms before
   * it: too quiet to be a pick, so it may be the damp's ghost.
   */
  private quietSuccessor(record: NoteRecord): boolean {
    const fall = this.config.tracking.dampFallDb;
    if (fall <= 0 || record.endTime === null) return false;
    const end = record.endTime;
    let next: NoteRecord | undefined;
    for (const candidate of this.notes.values()) {
      if (Math.abs(candidate.startTime - end) <= DAMP_GHOST_GAP_MS) next = candidate;
    }
    if (next === undefined || next.openingRms <= 0) return false;
    const levels = this.voicedLog
      .filter((entry) => entry.at < end && entry.at >= end - DAMP_MEDIAN_MS && entry.at >= record.startTime)
      .map((entry) => entry.rms)
      .sort((a, b) => a - b);
    const median = levels[levels.length >> 1];
    if (median === undefined || median <= 0) return false;
    return 20 * Math.log10(next.openingRms / median) <= -fall;
  }

  /**
   * Whether `ghost`, ending in silence at `silentSince`, was opened inside the
   * damp that stopped the Note before it. Through an amp the damp can push the
   * string sharp or rattle it hard enough to open a Note while the level is
   * still falling; nothing the player picked sounds after it. The Note before
   * must have run right up to it at a pitch within a damp's reach, and the
   * damp found over the two of them (`dampedAt`) must have begun falling by
   * the time the ghost opened. The ghost is then absorbed and the Note before
   * ends at the damp.
   */
  private absorbDampGhost(ghost: NoteRecord, silentSince: SourceTimeMs, out: TrackerEmission[]): boolean {
    if (this.config.tracking.dampFallDb <= 0) return false;
    const before = this.closing.find(
      (record) =>
        !record.merged &&
        record.announced &&
        record.endTime !== null &&
        Math.abs(record.endTime - ghost.startTime) <= DAMP_GHOST_GAP_MS
    );
    if (before === undefined) return false;
    const own = before.dominantMidi();
    const mine = ghost.dominantMidi();
    if (own !== null && mine !== null && Math.abs(own - mine) > DAMP_STEP_SEMITONES) return false;
    const damp = this.dampedAt(before, silentSince);
    if (damp === null || damp.fell > ghost.startTime) return false;

    ghost.merged = true;
    this.retractOpening(ghost);
    this.end(ghost, silentSince, out);
    before.endTime = damp.end;
    if (this.trace !== null) {
      this.trace({
        kind: "absorbed",
        at: ghost.startTime,
        noteId: ghost.id,
        intoId: before.id,
        durationMs: ghost.durationMs,
        intoStartTime: before.startTime,
        burstAt: ghost.burstAt,
        intoBurstAt: before.burstAt,
      });
    }
    const revisionNumber = before.bump("structuralRevision");
    out.push({
      type: "changed",
      note: before.snapshot(),
      change: {
        type: "structuralRevision",
        at: damp.end,
        revisionNumber,
        relation: "absorbed",
        relatedNoteIds: ghost.announced ? [ghost.id] : [],
      },
    });
    return true;
  }

  private end(record: NoteRecord, at: SourceTimeMs, out: TrackerEmission[]): void {
    this.notes.delete(record.id);
    const endAt = Math.max(at, record.startTime);
    this.lastEndedAt = endAt;
    record.endTime = endAt;

    if (this.trace !== null) {
      this.trace({
        kind: "ended",
        at: endAt,
        noteId: record.id,
        startedAt: record.startTime,
        announced: record.announced || record.announceSoundedMs >= record.announceThresholdMs,
        soundedMs: record.announceSoundedMs,
        announceBarMs: record.announceThresholdMs,
      });
    }

    if (!record.announced) {
      // Never announced: too short to have been a Note. Drop it rather than
      // emit an end with no matching start. Measured over how long it SOUNDED,
      // the same bar `publish` uses — a blip that spent its whole life in
      // release grace must not qualify just because the grace is long.
      if (record.announceSoundedMs < record.announceThresholdMs) {
        this.retractOpening(record);
        return;
      }
      record.announced = true;
      record.lastEmitted = {
        label: record.currentLabel(),
        confidence: record.overallConfidence(),
        bendCents: record.bendCents,
        lifecycle: record.lifecycle,
      };
      out.push({ type: "started", note: record.snapshot() });
      this.claimPrefix(record, out);
    }

    // The sound is over, and a consumer is told so now: `ended` means the
    // sound stopped, not that the answer is final. A Note already absorbed
    // into another is not told — the survivor's `structuralRevision` was its
    // last word.
    if (!record.merged) {
      record.lifecycle = "ended";
      out.push({ type: "ended", note: record.snapshot() });
    }

    // But the recognizer may not have finished thinking. A chord's identity is
    // routinely settled by deep analysis that started before the strum
    // stopped, and the region lane may yet move this Note's boundaries, so it
    // stays in the working set until they have ruled; what they change reaches
    // the consumer as `changed`, and `resolved` says when they are done.
    this.closing.push(record);
  }

  /**
   * Resolve every ended Note the deep lane is done with.
   *
   * Its `ended` went out when the sound stopped (`end`); this is the other
   * half, `resolved`, which says nothing more will change.
   *
   * @param busy ids the deep lane still has queued work for
   * @param force release even Notes nobody has ruled on — the end of a take
   */
  releaseClosed(busy: ReadonlySet<string>, out: TrackerEmission[], force = false): void {
    // Backwards, so the `splice` below leaves the indices still to visit valid.
    for (let i = this.closing.length - 1; i >= 0; i--) {
      const record = this.closing[i] as NoteRecord;
      // An absorbed Note has had its last word, the survivor's revision, and
      // is resolved at once. It stays in the working set for as long as it
      // always has: only what the consumer hears changes.
      if (record.merged) this.resolve(record, out);
      if (!force) {
        if (busy.has(record.id)) continue;
        // A Note nobody has re-analysed is not finished, whatever the queue
        // says. Holding it here is what makes the region reach back over it:
        // once it is gone from `closing` there is nothing left to correct.
        if (!record.deepResolved) continue;
        // Nor is one cut by a Note that opened far under it, which may yet
        // turn out to have been opened by its damp. See `absorbDampGhost`.
        // This holds the Note's resolution, not its ending (DECISION-086).
        if (this.quietSuccessor(record)) continue;
      }
      this.closing.splice(i, 1);
      this.announceLateLabel(record, out);
      this.resolve(record, out);

      this.ended.push(record);
      if (this.ended.length > this.config.tracking.endedNoteHistory) this.ended.shift();
    }
  }

  private resolve(record: NoteRecord, out: TrackerEmission[]): void {
    if (record.resolvedAnnounced) return;
    record.resolvedAnnounced = true;
    record.lifecycle = "resolved";
    record.bump("resolved");
    out.push({ type: "resolved", note: record.snapshot() });
  }

  /**
   * Whether a Note's name may still be announced: it has been announced, it
   * has not been absorbed, and it has not been resolved.
   */
  private speaksFor(record: NoteRecord): boolean {
    return record.announced && !record.merged && !record.resolvedAnnounced;
  }

  /**
   * Announce a name an ended Note came to by a path that emits nothing of its
   * own — a pitch vote attributed to it late (`pitch.voteLagMs`) or a harmony
   * reading applied after its end. Before `ended` went out at the end of the
   * sound, such a name reached the consumer only inside the held `ended`.
   */
  private announceLateLabel(record: NoteRecord, out: TrackerEmission[]): void {
    if (!this.speaksFor(record) || record.endTime === null) return;
    const previous = record.lastEmitted.label;
    const label = record.currentLabel();
    if (label === previous) return;
    const type: NoteChangeType = record.harmonyBloomed
      ? "harmonyCorrection"
      : classifyPitchChange(previous, label, false);
    const revisionNumber = record.bump(type);
    record.lastEmitted.label = label;
    const change: NoteChange = { type, at: record.endTime, revisionNumber };
    if (type === "pitchCorrection" || type === "harmonyCorrection") change.previous = { label: previous };
    out.push({ type: "changed", note: record.snapshot(), change });
  }

  /**
   * Can this Note defend the reading it is stepping away from?
   *
   * The evidence that a young Note's reading belongs to somebody else, made
   * checkable instead of assumed. Two ways it belongs to somebody else, and a
   * step out of either is the new note arriving rather than a note moving:
   *
   *  - it is the name of the Note in FRONT of it, still ringing while the pick
   *    that ended it lands;
   *  - it lies BETWEEN that Note and the pitch now arriving, which is the
   *    estimator's window straddling the boundary. On the room-mic sixteenths
   *    an F#5 answered by an E5 gives F5 for two hops — a pitch nobody played,
   *    and the reading the step is measured from.
   *
   * A Note with nothing in front of it has no name to defend either: its first
   * hops are the attack transient, which is the least periodic part of a note.
   */
  private cannotDefendReading(active: NoteRecord, fromHz: number, toHz: number): boolean {
    const predecessor = this.recordSoundingAt((active.startTime - 1) as SourceTimeMs);
    if (predecessor === undefined || predecessor.id === active.id) return true;
    const name = predecessor.dominantMidi();
    if (name === null) return true;
    const from = describeFrequency(fromHz).midi;
    if (((((from - name) % 12) + 12) % 12) === 0) return true;
    const to = describeFrequency(toHz).midi;
    return from > Math.min(name, to) && from < Math.max(name, to);
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
