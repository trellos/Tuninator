/**
 * PitchFrame + onsets -> MusicEvent start/update/end.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the integration
 * workstream.
 *
 * State machine: attack -> sustain -> (bend) -> release -> ended.
 *
 * Two rules that the eval depends on:
 *  - An onset forces a new event even when the pitch is unchanged, so a
 *    re-picked note is two events rather than one long sustain.
 *  - A bent note stays ONE event: it transitions to `bend` and records the
 *    excursion; it is never split into two.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import type { MusicEvent } from "../types.js";
import type { Policy } from "./policy.js";
import type { EngineFrame } from "./pitch-engine.js";

export type TrackerEmission = {
  type: "start" | "update" | "end";
  /** A snapshot; the tracker never hands out a mutable reference. */
  event: MusicEvent;
};

export class EventTracker {
  constructor(_policy: Policy) {
    throw new Error("EventTracker: not implemented");
  }

  setPolicy(_policy: Policy): void {
    throw new Error("EventTracker.setPolicy: not implemented");
  }

  /** Emissions are ordered; a single hop can end one event and start another. */
  process(_engineFrame: EngineFrame): TrackerEmission[] {
    throw new Error("EventTracker.process: not implemented");
  }

  /** Ends every open event. Called on stop, and at the end of offline input. */
  flush(_timestampMs: number): TrackerEmission[] {
    throw new Error("EventTracker.flush: not implemented");
  }

  /** Every event not yet in the `ended` state. */
  getActiveEvents(): MusicEvent[] {
    throw new Error("EventTracker.getActiveEvents: not implemented");
  }
}
