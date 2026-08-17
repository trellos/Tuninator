/**
 * PitchFrame + onsets -> MusicEvent start/update/end.
 *
 * State machine: attack -> sustain -> (bend) -> release -> ended.
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

import type { EventPitch, MusicEvent, MusicEventKind, MusicEventState } from "../types.js";
import type { Policy } from "./policy.js";
import type { EngineFrame } from "./pitch-engine.js";
import { describeFrequency } from "./notes.js";

export type TrackerEmission = {
  type: "start" | "update" | "end";
  /** A snapshot; the tracker never hands out a mutable reference. */
  event: MusicEvent;
};

type Active = {
  event: MusicEvent;
  /** Pitch the event is measured against; bends are relative to this. */
  refFrequencyHz: number | null;
  lastVoicedHz: number | null;
  lastVoicedAt: number;
  unvoicedSince: number | null;
  emittedStart: boolean;
  frames: number;
  confidenceSum: number;
  maxRms: number;
  maxPeak: number;
  /** Committed chord label, chord mode only. */
  chordLabel: string | null;
  /** A candidate replacement label, held until it proves it is not a flap. */
  pendingLabel: string | null;
  pendingSince: number;
  lastEmitted: { state: MusicEventState; bendCents: number; confidence: number; label: string };
};

const CENTS_PER_OCTAVE = 1200;

/** Runner-up chord interpretations kept on an event. */
const MAX_ALTERNATIVES = 4;

function cents(hz: number, refHz: number): number {
  return CENTS_PER_OCTAVE * Math.log2(hz / refHz);
}

export class EventTracker {
  private policy: Policy;
  private active: Active | null = null;
  private nextId = 1;

  constructor(policy: Policy) {
    this.policy = policy;
  }

  setPolicy(policy: Policy): void {
    this.policy = policy;
  }

  /** Emissions are ordered; a single hop can end one event and start another. */
  process(engineFrame: EngineFrame): TrackerEmission[] {
    const out: TrackerEmission[] = [];
    const { frame, onset, chord } = engineFrame;
    const t = frame.timestamp;
    const policy = this.policy;

    const gated = frame.amplitude.rms < policy.analysis.rmsGate;

    if (policy.chords.enabled) {
      this.processChord(engineFrame, gated, out);
      this.maybeEmitStart(t, out);
      return out;
    }

    // An onset is an unconditional boundary: a re-picked note at the same pitch
    // must read as two events, not one sustain.
    if (onset && this.active !== null) {
      this.end(t, out);
    }

    if (frame.frequencyHz !== null) {
      const hz = frame.frequencyHz;
      const active = this.active;

      if (active === null) {
        this.begin("note", hz, t, engineFrame);
      } else if (active.lastVoicedHz !== null) {
        const stepCents = Math.abs(cents(hz, active.lastVoicedHz));

        if (stepCents > policy.pitch.stepThresholdCents) {
          // Jumped in a single hop: a new note, not a bend.
          this.end(t, out);
          this.begin("note", hz, t, engineFrame);
        } else if (active.refFrequencyHz !== null) {
          const fromStart = cents(hz, active.refFrequencyHz);
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

    void chord;
    this.maybeEmitStart(t, out);
    return out;
  }

  /**
   * Chord segmentation is driven by chord CHANGE, not silence: the power-chord
   * and cowboy-chord labels are contiguous 2s bars with no gaps between them, so
   * waiting for a gap would merge all eight into one event.
   */
  private processChord(engineFrame: EngineFrame, gated: boolean, out: TrackerEmission[]): void {
    const { frame, chord } = engineFrame;
    const t = frame.timestamp;
    const policy = this.policy;

    if (gated) {
      const active = this.active;
      if (active !== null) {
        if (active.unvoicedSince === null) active.unvoicedSince = t;
        active.event.state = "release";
        if (t - active.unvoicedSince >= policy.tracking.releaseGraceMs) {
          this.end(active.unvoicedSince, out);
        }
      }
      return;
    }

    const confident = chord?.isConfident === true && chord.best !== null;
    const label = confident ? chord!.best!.label : "unknown";

    if (this.active === null) {
      this.begin("chord", frame.frequencyHz, t, engineFrame);
      const active = this.active as Active | null;
      if (active !== null) {
        active.chordLabel = confident ? label : null;
        this.applyChordLabel(active, engineFrame);
      }
      this.observe(engineFrame, t);
      return;
    }

    const active = this.active;
    active.unvoicedSince = null;

    if (confident && active.chordLabel === null) {
      // The attack transient is noisy and often unclassifiable; when it
      // resolves, upgrade this event in place rather than splitting. That keeps
      // `startedAt` on the actual attack, which is what onset error measures.
      active.chordLabel = label;
      this.applyChordLabel(active, engineFrame);
    } else if (confident && label !== active.chordLabel) {
      // Require persistence before switching, so one bad hop cannot shred a bar
      // into fragments.
      if (active.pendingLabel !== label) {
        active.pendingLabel = label;
        active.pendingSince = t;
      } else if (t - active.pendingSince >= policy.tracking.minStableMs) {
        this.end(active.pendingSince, out);
        this.begin("chord", frame.frequencyHz, active.pendingSince, engineFrame);
        const fresh = this.active as Active | null;
        if (fresh !== null) {
          fresh.chordLabel = label;
          this.applyChordLabel(fresh, engineFrame);
        }
      }
    } else if (label === active.chordLabel) {
      active.pendingLabel = null;
    }

    if (active === this.active) {
      this.applyChordLabel(active, engineFrame);
      if (active.event.state === "release") active.event.state = "sustain";
    }
    this.observe(engineFrame, t);
  }

  /** Writes the current chord interpretation onto the event, honestly. */
  private applyChordLabel(active: Active, engineFrame: EngineFrame): void {
    const chord = engineFrame.chord;
    if (!chord) return;

    if (active.chordLabel !== null && chord.isConfident && chord.best !== null) {
      active.event.label = {
        name: chord.best.label,
        root: chord.best.root,
        quality: chord.best.quality,
      };
    } else {
      // The margin rule said no. Say `unknown` and show the work, rather than
      // committing to a confident wrong label.
      active.event.label = { name: "unknown" };
    }

    // `matchChord` scores all 120 (root, quality) pairs and hands back every
    // runner-up. Only the near-misses are informative — and this list crosses
    // the worklet port on every update, so keep it short.
    const alternatives = [
      ...(chord.best && !chord.isConfident
        ? [{ label: chord.best.label, confidence: chord.best.score }]
        : []),
      ...chord.alternatives
        .slice(0, MAX_ALTERNATIVES)
        .map((c) => ({ label: c.label, confidence: c.score })),
    ].slice(0, MAX_ALTERNATIVES);
    active.event.ambiguity = {
      ...active.event.ambiguity,
      alternatives: alternatives.length > 0 ? alternatives : undefined,
      polyphony: engineFrame.chroma?.polyphony,
    };
    active.event.confidenceParts.spectralFit = chord.best?.score;

    if (engineFrame.chroma) {
      active.event.pitches = chordPitches(engineFrame, chord);
      active.event.primaryPitch = active.event.pitches[0] ?? null;
    }
  }

  private begin(
    kind: MusicEventKind,
    hz: number | null,
    t: number,
    engineFrame: EngineFrame
  ): void {
    const { frame } = engineFrame;
    const nearest = hz === null ? null : describeFrequency(hz);

    const primary: EventPitch | null =
      nearest === null
        ? null
        : {
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

    const event: MusicEvent = {
      id: `ev${this.nextId++}`,
      kind,
      startedAt: t,
      updatedAt: t,
      endedAt: null,
      state: "attack",
      label: { name: nearest?.name ?? "unknown" },
      primaryPitch: primary,
      pitches: primary ? [primary] : [],
      confidence: frame.confidence,
      confidenceParts: {
        pitch: frame.confidence,
        stability: 0,
        amplitude: Math.min(1, frame.amplitude.rms / 0.1),
      },
      ambiguity: {},
      amplitude: { rms: frame.amplitude.rms, peak: frame.amplitude.peak },
      bend: { isActive: false, centsFromStart: 0, semitonesFromStart: 0 },
    };

    this.active = {
      event,
      refFrequencyHz: hz,
      lastVoicedHz: hz,
      lastVoicedAt: t,
      unvoicedSince: null,
      emittedStart: false,
      frames: 0,
      confidenceSum: 0,
      maxRms: frame.amplitude.rms,
      maxPeak: frame.amplitude.peak ?? 0,
      chordLabel: null,
      pendingLabel: null,
      pendingSince: t,
      lastEmitted: { state: "attack", bendCents: 0, confidence: -1, label: "" },
    };
  }

  /** Folds one frame's evidence into the active event. */
  private observe(engineFrame: EngineFrame, t: number): void {
    const active = this.active;
    if (active === null) return;
    const { frame } = engineFrame;

    active.frames++;
    active.confidenceSum += frame.confidence;
    active.maxRms = Math.max(active.maxRms, frame.amplitude.rms);
    active.maxPeak = Math.max(active.maxPeak, frame.amplitude.peak ?? 0);
    active.event.updatedAt = t;
    active.event.amplitude = { rms: frame.amplitude.rms, peak: active.maxPeak };

    if (frame.frequencyHz !== null) {
      active.lastVoicedHz = frame.frequencyHz;
      active.lastVoicedAt = t;
      active.unvoicedSince = null;

      if (active.event.kind === "note") {
        const nearest = describeFrequency(frame.frequencyHz);
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
        // The label keeps the ORIGIN note across a bend; the excursion lives in
        // `bend`. Only a non-bending event re-labels itself.
        if (!active.event.bend.isActive) {
          active.event.label = { name: nearest.name, root: nearest.pitchClass };
        }
      }
    }

    const held = t - active.event.startedAt;
    const stability = Math.min(1, held / Math.max(1, this.policy.tracking.minStableMs));
    active.event.confidenceParts.stability = stability;
    active.event.confidenceParts.pitch = active.confidenceSum / Math.max(1, active.frames);
    active.event.confidenceParts.amplitude = Math.min(1, active.maxRms / 0.1);
    active.event.confidence = blendConfidence(active.event.confidenceParts);

    if (active.event.state === "attack" && held >= this.policy.tracking.minStableMs) {
      active.event.state = "sustain";
    }
  }

  /** Emits `start` once identity has settled, and `update` on real changes. */
  private maybeEmitStart(t: number, out: TrackerEmission[]): void {
    const active = this.active;
    if (active === null) return;

    // Measure stability over how long the note SOUNDED, not wall-clock since it
    // started. An event in release still ages, so using `t` here would let a
    // 24ms blip cross a 45ms stability gate purely by sitting in its release
    // grace — emitting a start for a note that had already stopped.
    const held = active.lastVoicedAt - active.event.startedAt;

    if (!active.emittedStart) {
      if (held >= this.policy.tracking.minStableMs) {
        active.emittedStart = true;
        active.lastEmitted = {
          state: active.event.state,
          bendCents: active.event.bend.centsFromStart,
          confidence: active.event.confidence,
          label: active.event.label.name,
        };
        out.push({ type: "start", event: snapshot(active.event) });
      }
      return;
    }

    const last = active.lastEmitted;
    const changed =
      active.event.state !== last.state ||
      active.event.label.name !== last.label ||
      Math.abs(active.event.bend.centsFromStart - last.bendCents) > 10 ||
      Math.abs(active.event.confidence - last.confidence) > 0.15;

    if (changed) {
      active.lastEmitted = {
        state: active.event.state,
        bendCents: active.event.bend.centsFromStart,
        confidence: active.event.confidence,
        label: active.event.label.name,
      };
      out.push({ type: "update", event: snapshot(active.event) });
    }
  }

  private end(t: number, out: TrackerEmission[]): void {
    const active = this.active;
    if (active === null) return;
    this.active = null;

    const duration = t - active.event.startedAt;

    if (!active.emittedStart) {
      // Never started: too short to have been a note. Drop it rather than emit
      // an end with no matching start.
      if (duration < this.policy.tracking.minStableMs) return;
      out.push({ type: "start", event: snapshot(active.event) });
    }

    active.event.state = "ended";
    active.event.endedAt = t;
    active.event.updatedAt = t;
    out.push({ type: "end", event: snapshot(active.event) });
  }

  /** Ends every open event. Called on stop, and at the end of offline input. */
  flush(timestampMs: number): TrackerEmission[] {
    const out: TrackerEmission[] = [];
    this.end(timestampMs, out);
    return out;
  }

  /** Every event not yet in the `ended` state. */
  getActiveEvents(): MusicEvent[] {
    if (this.active === null || !this.active.emittedStart) return [];
    return [snapshot(this.active.event)];
  }
}

function blendConfidence(parts: MusicEvent["confidenceParts"]): number {
  const values: number[] = [];
  if (parts.pitch !== undefined) values.push(parts.pitch);
  if (parts.stability !== undefined) values.push(parts.stability);
  if (parts.amplitude !== undefined) values.push(Math.min(1, parts.amplitude));
  if (parts.spectralFit !== undefined) values.push(parts.spectralFit);
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.max(0, Math.min(1, sum / values.length));
}

function chordPitches(engineFrame: EngineFrame, chord: EngineFrame["chord"]): EventPitch[] {
  const pitches: EventPitch[] = [];
  const chroma = engineFrame.chroma;
  if (!chroma) return pitches;

  if (chroma.bassFrequencyHz !== null) {
    const nearest = describeFrequency(chroma.bassFrequencyHz);
    pitches.push({
      frequencyHz: nearest.frequencyHz,
      midi: nearest.midi,
      name: nearest.name,
      pitchClass: nearest.pitchClass,
      octave: nearest.octave,
      cents: nearest.cents,
      role: "bass",
      confidence: chroma.salience,
      salience: chroma.salience,
    });
  }

  void chord;
  return pitches;
}

/** Structural copy, so a consumer holding an event cannot mutate tracker state. */
function snapshot(event: MusicEvent): MusicEvent {
  return {
    ...event,
    label: { ...event.label },
    primaryPitch: event.primaryPitch ? { ...event.primaryPitch } : null,
    pitches: event.pitches.map((p) => ({ ...p })),
    confidenceParts: { ...event.confidenceParts },
    ambiguity: {
      ...event.ambiguity,
      alternatives: event.ambiguity.alternatives?.map((a) => ({ ...a })),
    },
    amplitude: { ...event.amplitude },
    bend: { ...event.bend },
  };
}
