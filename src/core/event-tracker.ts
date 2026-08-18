/**
 * PitchFrame + onsets -> MusicEvent start/update/end.
 *
 * State machine: attack -> sustain -> (bend) -> release -> ended.
 *
 * This file is the façade. The work is split by what actually differs between
 * modes — segmentation — while the event lifecycle stays in one place:
 *
 *   tracking/active-event.ts  shared per-event state and snapshotting
 *   tracking/base-tracker.ts  begin / observe / emit / end, common to both
 *   tracking/note-tracker.ts  monophonic: onsets, pitch steps, bends
 *   tracking/chord-tracker.ts polyphonic: chord change, voting, abstention
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import type { MusicEvent } from "../types.js";
import type { Policy } from "./policy.js";
import type { EngineFrame } from "./pitch-engine.js";
import { createContext, type TrackerContext, type TrackerEmission } from "./tracking/active-event.js";
import { NoteTracker } from "./tracking/note-tracker.js";
import { ChordTracker } from "./tracking/chord-tracker.js";

export type { TrackerEmission } from "./tracking/active-event.js";

export class EventTracker {
  private policy: Policy;
  private readonly context: TrackerContext = createContext();
  private current: NoteTracker | ChordTracker;
  /** Timestamp of the most recent hop, so a mode change can close an event. */
  private lastSeenAt = 0;
  /**
   * Emissions produced by a mode change, delivered on the next hop.
   *
   * `setPolicy()` has no channel to emit on — the worklet calls it from its
   * port handler, not from `process()` — so an event closed by a mode change
   * waits here rather than vanishing.
   */
  private pending: TrackerEmission[] = [];

  constructor(policy: Policy) {
    this.policy = policy;
    this.current = policy.chords.enabled
      ? new ChordTracker(policy, this.context)
      : new NoteTracker(policy, this.context);
  }

  /**
   * Swaps policy in place, and swaps the tracker when the mode changes shape.
   *
   * An in-flight event does not survive a mode change: a note event and a chord
   * event mean different things, and carrying one into the other silently
   * changes what a consumer was told. It is ended honestly instead.
   */
  setPolicy(policy: Policy): void {
    const modeChanged = policy.chords.enabled !== this.policy.chords.enabled;
    this.policy = policy;

    if (!modeChanged) {
      this.current.setPolicy(policy);
      return;
    }

    const closedAt = this.context.lastEndedAt ?? 0;
    this.pending.push(...this.current.flush(Math.max(closedAt, this.lastSeenAt)));
    this.current = policy.chords.enabled
      ? new ChordTracker(policy, this.context)
      : new NoteTracker(policy, this.context);
  }

  /** Emissions are ordered; a single hop can end one event and start another. */
  process(engineFrame: EngineFrame): TrackerEmission[] {
    const t = engineFrame.frame.timestamp;
    this.lastSeenAt = t;
    // Shared across modes: a new event backdates onto the most recent attack
    // whichever tracker is running, and that has to survive a mode change.
    if (engineFrame.onset) this.context.lastOnsetAt = engineFrame.onsetAt ?? t;

    const out = this.drainPending();
    out.push(...this.current.process(engineFrame));
    return out;
  }

  /** Ends every open event. Called on stop, and at the end of offline input. */
  flush(timestampMs: number): TrackerEmission[] {
    const out = this.drainPending();
    out.push(...this.current.flush(timestampMs));
    return out;
  }

  /** Every event not yet in the `ended` state. */
  getActiveEvents(): MusicEvent[] {
    return this.current.getActiveEvents();
  }

  private drainPending(): TrackerEmission[] {
    if (this.pending.length === 0) return [];
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
