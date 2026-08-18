/**
 * Monophonic segmentation: PitchFrame + onsets -> one note per event.
 *
 * Three rules the eval depends on:
 *
 *  - An onset forces a new event even when the pitch is unchanged, so a
 *    re-picked note is two events rather than one long sustain.
 *
 *  - A pitch STEP also splits, even without an onset. In a legato run the pick
 *    never re-attacks, so spectral flux stays flat and onset-driven splitting
 *    alone would merge 24 triplets into a handful of events.
 *
 *  - A bend stays ONE event. Total displacement cannot distinguish a 200-cent
 *    bend from a 200-cent legato step, so the discriminator is the per-hop rate:
 *    a bend glides through the intermediate cents over tens of frames, a fretted
 *    step jumps within one or two. Hence `pitch.stepThresholdCents`.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import type { EventPitch } from "../../types.js";
import type { EngineFrame } from "../pitch-engine.js";
import { describeFrequency, midiToFrequency } from "../notes.js";
import { BaseTracker } from "./base-tracker.js";
import { cents, type ActiveEvent, type TrackerEmission } from "./active-event.js";

/**
 * Hops of pitch history used to decide whether a bend is in progress.
 * Five hops is ~60ms at the default 12ms hop — long enough to see a bend move,
 * short enough not to smear across a genuine note change.
 */
const GLIDE_WINDOW = 5;

/**
 * Total pitch motion across `GLIDE_WINDOW` that counts as an active glide.
 *
 * Bending sweeps the whole spectrum, which spikes spectral flux, so the onset
 * detector fires *during* a bend — measured twice inside the A3->B3 bend on the
 * lead fixture, at 7707ms and 7987ms. Treating those as attacks chopped one
 * bent note into four events. An onset only means "new note" when the pitch is
 * not already moving.
 *
 * Well above vibrato (typically +/-15 cents) so a vibratoed sustain still
 * splits properly on a real re-pick.
 */
const GLIDE_MIN_CENTS = 25;

/**
 * Consecutive frames a new pitch must hold before it splits the event. One
 * frame is a detector wobble; two at 12ms is still well inside a 125ms note.
 */
const STEP_CONFIRM_FRAMES = 2;

/**
 * How close to a whole number of octaves a jump must be to be dismissed as a
 * detector artefact rather than a played interval.
 */
const OCTAVE_JUMP_TOLERANCE_CENTS = 60;

/**
 * True when `hz` is an octave multiple of `fromHz` — the signature of YIN
 * landing on a harmonic or a sub-harmonic rather than of a new note.
 *
 * A step of an octave is 1200 cents against a 70-cent threshold, so before this
 * every octave flip split the note in two. On the lead fixture's low strings
 * that is exactly what happened: B2 came out as a B3 event followed by a B2
 * event, and C#3 as four alternating C#3/C#4 fragments. The engine already
 * fights octave errors three ways at frame level; this is the same fight at
 * event level, where the giveaway is that nobody re-articulated.
 */
function isOctaveJump(hz: number, fromHz: number): boolean {
  const octaves = Math.log2(hz / fromHz);
  const nearest = Math.round(octaves);
  if (nearest === 0) return false;
  return Math.abs(octaves - nearest) * 1200 < OCTAVE_JUMP_TOLERANCE_CENTS;
}

/** Note-mode state, layered onto `ActiveEvent`. */
type NoteState = {
  /** Last few voiced frequencies, oldest first. Drives the glide test. */
  recentHz: number[];
  /**
   * How many voiced frames landed on each MIDI note. The event's label is the
   * mode of this, not the most recent frame: an event whose boundary is off by
   * part of a note bleeds into its neighbour, and labelling from the last frame
   * hands it the neighbour's name.
   */
  noteVotes: Map<number, number>;
  /** A candidate new pitch, held until it proves it is not a one-frame blip. */
  pendingStepHz: number | null;
  pendingStepFrames: number;
  /** Timestamp of the first frame showing the candidate pitch. */
  pendingStepAt: number;
};

type ActiveNote = ActiveEvent & NoteState;

export class NoteTracker extends BaseTracker<ActiveNote> {
  protected createModeState(_engineFrame: EngineFrame, hz: number | null): NoteState {
    const nearest = hz === null ? null : describeFrequency(hz);
    return {
      recentHz: hz === null ? [] : [hz],
      noteVotes: new Map(nearest === null ? [] : [[nearest.midi, 1]]),
      pendingStepHz: null,
      pendingStepFrames: 0,
      pendingStepAt: 0,
    };
  }

  process(engineFrame: EngineFrame): TrackerEmission[] {
    const out: TrackerEmission[] = [];
    const { frame, onset } = engineFrame;
    const t = frame.timestamp;
    const policy = this.policy;
    const gated = frame.amplitude.rms < policy.analysis.rmsGate;

    // An onset boundary: a genuinely re-picked note at the same pitch must read
    // as two events, not one sustain — but only if the string was actually
    // struck again.
    if (onset && this.active !== null) {
      const rearticulated =
        frame.amplitude.rms >= this.active.recentRms * policy.onset.repickRmsRise;
      // ...and only if the pitch is not already gliding. A bend sweeps the
      // spectrum, which spikes spectral flux AND lifts the RMS, so the
      // amplitude test alone passes and the bend gets chopped into pieces.
      if (rearticulated && !isGliding(this.active, frame.frequencyHz)) this.end(t, out);
    }

    if (frame.frequencyHz !== null) {
      const hz = frame.frequencyHz;
      const active = this.active;

      if (active === null) {
        this.begin("note", hz, t, engineFrame);
      } else if (active.lastVoicedHz !== null) {
        const stepCents = Math.abs(cents(hz, active.lastVoicedHz));
        const ref = active.refFrequencyHz;

        // Resolve an in-flight step FIRST. `lastVoicedHz` advances every frame,
        // so by the second frame of a real step the per-hop delta is back to
        // ~0 — testing that first reads a genuine note change as a wobble and
        // merges the run into one long event.
        const stepPending = active.pendingStepHz !== null;
        const holdsCandidate =
          stepPending &&
          Math.abs(cents(hz, active.pendingStepHz!)) <= policy.pitch.stepThresholdCents;

        if (stepPending && !holdsCandidate) {
          // Fell back toward where it came from: a wobble, not a note change.
          active.pendingStepHz = null;
          active.pendingStepFrames = 0;
        }

        // An octave leap with no attack behind it is the detector slipping a
        // harmonic, not the player jumping an octave. Playing one really does
        // happen -- but it is picked or hammered, and that lands an onset.
        const octaveSlip = isOctaveJump(hz, active.lastVoicedHz);

        if (octaveSlip) {
          active.pendingStepHz = null;
          active.pendingStepFrames = 0;
        } else if (holdsCandidate || stepCents > policy.pitch.stepThresholdCents) {
          if (holdsCandidate) {
            active.pendingStepFrames++;
          } else {
            active.pendingStepHz = hz;
            active.pendingStepFrames = 1;
            active.pendingStepAt = t;
          }

          if (active.pendingStepFrames >= STEP_CONFIRM_FRAMES) {
            // Jumped and stayed: a new note, not a bend. The new note began at
            // the first frame that showed the new pitch, not at the frame that
            // confirmed it — otherwise every note starts one hop late.
            const stepStart = Math.max(active.pendingStepAt, active.event.startedAt);
            this.end(stepStart, out);
            this.begin("note", hz, stepStart, engineFrame);
          }
        } else if (ref !== null) {
          const fromStart = cents(hz, ref);
          if (Math.abs(fromStart) >= policy.tracking.bendThresholdCents) {
            active.event.state = "bend";
            active.event.bend = {
              isActive: true,
              centsFromStart: fromStart,
              semitonesFromStart: fromStart / 100,
            };
          } else if (active.event.state === "release") {
            active.event.state = "sustain";
          }
        }
      } else if (active.refFrequencyHz === null) {
        // An unpitched (rhythm-mode) event that has now found a pitch.
        active.refFrequencyHz = hz;
        active.event.kind = "note";
      }

      this.observe(engineFrame, t);
    } else if (this.active !== null) {
      const active = this.active;
      if (active.unvoicedSince === null) active.unvoicedSince = t;
      if (active.event.state !== "bend") active.event.state = "release";

      if (t - active.unvoicedSince >= policy.tracking.releaseGraceMs) {
        this.end(active.unvoicedSince, out);
      }
    } else if (onset && policy.emitUnpitchedEvents && !gated) {
      // Rhythm mode: an attack is an event even with no usable pitch.
      this.begin("unknown", null, t, engineFrame);
      this.observe(engineFrame, t);
    }

    this.flushEmissions(out);
    return out;
  }

  protected onVoicedFrame(active: ActiveNote, engineFrame: EngineFrame, _t: number): void {
    const { frame } = engineFrame;
    const hz = frame.frequencyHz as number;

    active.recentHz.push(hz);
    if (active.recentHz.length > GLIDE_WINDOW) active.recentHz.shift();

    if (active.event.kind !== "note") return;

    const nearest = describeFrequency(hz);
    const primary: EventPitch = {
      frequencyHz: nearest.frequencyHz,
      midi: nearest.midi,
      name: nearest.name,
      pitchClass: nearest.pitchClass,
      octave: nearest.octave,
      cents: nearest.cents,
      role: "primary",
      confidence: frame.confidence,
      amplitude: frame.amplitude.rms,
    };
    active.event.primaryPitch = primary;
    active.event.pitches = [primary];

    active.noteVotes.set(nearest.midi, (active.noteVotes.get(nearest.midi) ?? 0) + 1);

    // The label keeps the ORIGIN note across a bend; the excursion lives in
    // `bend`. Only a non-bending event re-labels itself.
    if (active.event.bend.isActive) return;

    // Label from the note this event spent the most frames on, not from the
    // newest frame. A single stray frame — or a boundary that slid into the
    // next note — must not rename a settled event.
    const winner = modeOf(active.noteVotes);
    const label = winner === nearest.midi ? nearest : describeFrequency(midiToFrequency(winner));
    active.event.label = { name: label.name, root: label.pitchClass };
  }
}

/**
 * Most-voted note. Ties break toward the lower MIDI number so the result is
 * deterministic regardless of Map iteration order.
 */
function modeOf(votes: Map<number, number>): number {
  let bestMidi = 0;
  let bestCount = -1;
  for (const [midi, count] of votes) {
    if (count > bestCount || (count === bestCount && midi < bestMidi)) {
      bestCount = count;
      bestMidi = midi;
    }
  }
  return bestMidi;
}

/**
 * True when the event's pitch is sweeping — a bend or slide in progress.
 *
 * Requires the motion to be both large enough and consistently one-directional
 * across the window. Vibrato oscillates, so its net displacement stays small
 * and it does not qualify; a re-picked note holds steady and does not either.
 * Only a genuine glide moves monotonically, which is what makes this safe to
 * use for suppressing onset-driven splits.
 */
function isGliding(active: ActiveNote, currentHz: number | null): boolean {
  // `recentHz` is appended in observe(), which runs AFTER the onset check, so
  // the history alone stops one hop short of the frame being judged. Including
  // the current pitch is what makes this measure motion up to *now*: without
  // it the A3->B3 bend measured 24.4 cents against a 25-cent gate and split.
  const recent = currentHz === null ? active.recentHz : [...active.recentHz, currentHz];
  if (recent.length <= GLIDE_WINDOW) return false;

  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  if (Math.abs(cents(last, first)) < GLIDE_MIN_CENTS) return false;

  const rising = last > first;
  for (let i = 1; i < recent.length; i++) {
    // Allow a small backward wobble, but not a reversal.
    const delta = cents(recent[i]!, recent[i - 1]!);
    if (rising ? delta < -10 : delta > 10) return false;
  }
  return true;
}
