/**
 * State and helpers shared by every tracking mode.
 *
 * An event's *lifecycle* — when it starts, how its confidence accumulates, when
 * it is safe to emit, when it ends — is identical whether the thing being
 * tracked is a single note or a strummed chord. Only the *segmentation* differs,
 * and that is what `NoteTracker` and `ChordTracker` own.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import type { MusicEvent, MusicEventState } from "../../types.js";

export type TrackerEmission = {
  type: "start" | "update" | "end";
  /** A snapshot; the tracker never hands out a mutable reference. */
  event: MusicEvent;
};

/**
 * The last thing a subscriber was told, so `update` fires on real change rather
 * than every hop.
 */
export type EmittedState = {
  state: MusicEventState;
  bendCents: number;
  confidence: number;
  label: string;
};

/**
 * One in-flight event, minus anything mode-specific.
 *
 * Every field here is read or written by the shared lifecycle in `BaseTracker`.
 * A field used by only one mode belongs on that mode's own state object, not
 * here — the previous single struct carried both modes' fields at once and half
 * of them were always null.
 */
export type ActiveEvent = {
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
  /** Short rolling mean of rms, the baseline a re-pick has to rise above. */
  recentRms: number;
  lastEmitted: EmittedState;
};

/**
 * Cross-event state that must survive a mode change.
 *
 * `setMode()` swaps which tracker is running, and both of these have to carry
 * over: event ids must stay unique across the swap, and a new event still needs
 * to be able to backdate onto the last onset without reaching past the last
 * event that closed.
 */
export type TrackerContext = {
  nextId: number;
  /** Timestamp of the most recent attack, for backdating a new event onto it. */
  lastOnsetAt: number | null;
  /** End of the most recently closed event, so backdating cannot overlap it. */
  lastEndedAt: number | null;
};

export function createContext(): TrackerContext {
  return { nextId: 1, lastOnsetAt: null, lastEndedAt: null };
}

export const CENTS_PER_OCTAVE = 1200;

export function cents(hz: number, refHz: number): number {
  return CENTS_PER_OCTAVE * Math.log2(hz / refHz);
}

export function blendConfidence(parts: MusicEvent["confidenceParts"]): number {
  const values: number[] = [];
  if (parts.pitch !== undefined) values.push(parts.pitch);
  if (parts.stability !== undefined) values.push(parts.stability);
  if (parts.amplitude !== undefined) values.push(Math.min(1, parts.amplitude));
  if (parts.spectralFit !== undefined) values.push(parts.spectralFit);
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.max(0, Math.min(1, sum / values.length));
}

/** Structural copy, so a consumer holding an event cannot mutate tracker state. */
export function snapshot(event: MusicEvent): MusicEvent {
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
