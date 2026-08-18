/**
 * The event lifecycle every tracking mode shares.
 *
 * Subclasses decide *segmentation* — when one event ends and the next begins —
 * and nothing else. Starting, accumulating evidence, deciding an event has
 * settled enough to announce, and ending it are all here, so the two modes
 * cannot drift apart on the parts consumers depend on.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import type { EventPitch, MusicEvent, MusicEventKind } from "../../types.js";
import type { Policy } from "../policy.js";
import type { EngineFrame } from "../pitch-engine.js";
import { describeFrequency } from "../notes.js";
import {
  blendConfidence,
  snapshot,
  type ActiveEvent,
  type TrackerContext,
  type TrackerEmission,
} from "./active-event.js";

/**
 * How long after an attack a new event may still be backdated to it. Wider than
 * a hop, narrower than the shortest note in the fixtures (125ms).
 */
const ONSET_BACKDATE_WINDOW_MS = 120;

/** Weight of the newest frame in the rolling rms baseline. */
const RMS_BASELINE_ALPHA = 0.25;

export abstract class BaseTracker<A extends ActiveEvent> {
  protected policy: Policy;
  protected readonly context: TrackerContext;
  protected active: A | null = null;

  constructor(policy: Policy, context: TrackerContext) {
    this.policy = policy;
    this.context = context;
  }

  setPolicy(policy: Policy): void {
    this.policy = policy;
  }

  /** One hop in, zero or more emissions out. Ordered: a hop can end and start. */
  abstract process(engineFrame: EngineFrame): TrackerEmission[];

  /** Mode-specific state for a newly begun event. */
  protected abstract createModeState(engineFrame: EngineFrame, hz: number | null): Omit<A, keyof ActiveEvent>;

  /** Called for every voiced frame, after the shared bookkeeping. */
  protected abstract onVoicedFrame(active: A, engineFrame: EngineFrame, t: number): void;

  protected begin(
    kind: MusicEventKind,
    hz: number | null,
    t: number,
    engineFrame: EngineFrame
  ): A {
    const { frame } = engineFrame;
    const nearest = hz === null ? null : describeFrequency(hz);

    // A note begins at its attack, not at the moment the pitch tracker becomes
    // confident about it. Spectral flux localises the attack far better than
    // YIN does — YIN has to wait for its window to fill with the new note and
    // for the median to turn over — so backdate onto the recent onset. Without
    // this the whole event slides late, and on a 166ms triplet a late event
    // spends most of its frames on the FOLLOWING note.
    let startedAt = t;
    const { lastOnsetAt, lastEndedAt } = this.context;
    if (lastOnsetAt !== null && t - lastOnsetAt <= ONSET_BACKDATE_WINDOW_MS) {
      startedAt = lastOnsetAt;
      // Never reach back past an already-closed event.
      if (lastEndedAt !== null && startedAt < lastEndedAt) startedAt = lastEndedAt;
    }

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
      id: `ev${this.context.nextId++}`,
      kind,
      startedAt,
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

    const shared: ActiveEvent = {
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
      recentRms: frame.amplitude.rms,
      lastEmitted: { state: "attack", bendCents: 0, confidence: -1, label: "" },
    };

    const active = { ...shared, ...this.createModeState(engineFrame, hz) } as A;
    this.active = active;
    return active;
  }

  /** Folds one frame's evidence into the active event. */
  protected observe(engineFrame: EngineFrame, t: number): void {
    const active = this.active;
    if (active === null) return;
    const { frame } = engineFrame;

    active.frames++;
    active.confidenceSum += frame.confidence;
    active.maxRms = Math.max(active.maxRms, frame.amplitude.rms);
    active.recentRms =
      active.recentRms * (1 - RMS_BASELINE_ALPHA) + frame.amplitude.rms * RMS_BASELINE_ALPHA;
    active.maxPeak = Math.max(active.maxPeak, frame.amplitude.peak ?? 0);
    active.event.updatedAt = t;
    active.event.amplitude = { rms: frame.amplitude.rms, peak: active.maxPeak };

    if (frame.frequencyHz !== null) {
      active.lastVoicedHz = frame.frequencyHz;
      active.lastVoicedAt = t;
      active.unvoicedSince = null;
      this.onVoicedFrame(active, engineFrame, t);
    }

    const held = t - active.event.startedAt;
    active.event.confidenceParts.stability = Math.min(
      1,
      held / Math.max(1, this.policy.tracking.minStableMs)
    );
    active.event.confidenceParts.pitch = active.confidenceSum / Math.max(1, active.frames);
    active.event.confidenceParts.amplitude = Math.min(1, active.maxRms / 0.1);
    active.event.confidence = blendConfidence(active.event.confidenceParts);

    if (active.event.state === "attack" && held >= this.policy.tracking.minStableMs) {
      active.event.state = "sustain";
    }
  }

  /**
   * Emits `start` once identity has settled, and `update` on real changes.
   * Called at the end of every hop, after segmentation has had its say.
   */
  protected flushEmissions(out: TrackerEmission[]): void {
    const active = this.active;
    if (active === null) return;

    // Measure stability over how long the note SOUNDED, not wall-clock since it
    // started. An event in release still ages, so using the hop time here would
    // let a 24ms blip cross a 45ms stability gate purely by sitting in its
    // release grace — emitting a start for a note that had already stopped.
    const held = active.lastVoicedAt - active.event.startedAt;

    if (!active.emittedStart) {
      if (held >= this.policy.tracking.minStableMs) {
        active.emittedStart = true;
        this.rememberEmitted(active);
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
      this.rememberEmitted(active);
      out.push({ type: "update", event: snapshot(active.event) });
    }
  }

  private rememberEmitted(active: A): void {
    active.lastEmitted = {
      state: active.event.state,
      bendCents: active.event.bend.centsFromStart,
      confidence: active.event.confidence,
      label: active.event.label.name,
    };
  }

  protected end(t: number, out: TrackerEmission[]): void {
    const active = this.active;
    if (active === null) return;
    this.active = null;
    this.context.lastEndedAt = t;

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
