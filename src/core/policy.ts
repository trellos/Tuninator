/**
 * Per-mode tuning of the shared detection kernel.
 *
 * A `Policy` is a plain data object: it crosses the worklet port as a structured
 * clone, so it must stay JSON-shaped (no functions, no class instances).
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import type { TuninatorMode, TuninatorOptions } from "../types.js";

export type Policy = {
  mode: TuninatorMode;

  analysis: {
    minFrequencyHz: number;
    maxFrequencyHz: number;
    /** Requested hop; the engine snaps this to whole 128-sample quanta. */
    pitchHopMs: number;
    rmsGate: number;
    confidenceGate: number;
  };

  tracking: {
    minStableMs: number;
    releaseGraceMs: number;
    bendThresholdCents: number;
  };

  pitch: {
    /** Long YIN window, in samples. Sized for two periods of low E (82.4Hz). */
    longWindow: number;
    /** Short YIN window, in samples. ~7x better time resolution. */
    shortWindow: number;
    /** Above this frequency a confident short-window result is preferred. */
    shortWindowMinHz: number;
    /** YIN absolute threshold on the CMND curve. */
    yinThreshold: number;
    /** Frames of temporal median applied before snapping to a note. */
    medianFrames: number;
    /**
     * A single-hop pitch jump this large reads as a new note rather than a bend.
     * This is what separates "A3 bent up to B3" (one event, gliding through the
     * intermediate cents over tens of frames) from a legato D5->E5 step (two
     * events, jumping in one or two frames). Both are 200 cents from the start,
     * so total displacement cannot distinguish them — only the per-hop rate can.
     */
    stepThresholdCents: number;
  };

  onset: {
    enabled: boolean;
    fftSize: number;
    /** Minimum inter-onset interval. 120bpm sixteenths are 125ms apart. */
    minIntervalMs: number;
    /** Frames in the adaptive median threshold window. */
    medianWindow: number;
    /** Multiplier on the adaptive median; higher = fewer onsets. */
    sensitivity: number;
    /**
     * How much louder than its recent baseline a frame must be for an onset to
     * split the note already sounding. 1 disables the check.
     *
     * Spectral flux fires on more than attacks: as a note decays the adaptive
     * median falls with it, so ordinary sustain ripple keeps clearing the
     * threshold and halves the note. A real re-pick puts energy back into the
     * string, which is what this tests for.
     */
    repickRmsRise: number;
  };

  chords: {
    enabled: boolean;
    fftSize: number;
    /** Minimum top-1 score for a confident chord label. */
    floor: number;
    /** Minimum score(top1) - score(top2) for a confident chord label. */
    margin: number;
  };

  /** Emit events on onsets even when pitch is uncertain (rhythm mode). */
  emitUnpitchedEvents: boolean;
};

const BASE: Omit<Policy, "mode"> = {
  analysis: {
    minFrequencyHz: 70,
    maxFrequencyHz: 1400,
    pitchHopMs: 12,
    rmsGate: 0.008,
    // Tuned against the recorded fixtures, not chosen a priori. At 0.5 the
    // detector dropped frames mid-note on decaying low strings, which read as
    // note-offs and split notes in two; 0.35 keeps them voiced. Measured on
    // clean-lead: pitch-class accuracy 72.1% -> 79.1%, missed 9 -> 6.
    confidenceGate: 0.35,
  },
  tracking: {
    minStableMs: 45,
    releaseGraceMs: 90,
    bendThresholdCents: 45,
  },
  pitch: {
    longWindow: 2048,
    shortWindow: 512,
    shortWindowMinHz: 300,
    yinThreshold: 0.13,
    medianFrames: 3,
    stepThresholdCents: 70,
  },
  onset: {
    enabled: true,
    fftSize: 1024,
    // 120bpm sixteenths are 125ms apart, so this has headroom while still
    // suppressing the double-triggers that pick noise produces.
    minIntervalMs: 90,
    medianWindow: 17,
    sensitivity: 1.6,
    repickRmsRise: 1.05,
  },
  chords: {
    enabled: false,
    fftSize: 4096,
    floor: 0.55,
    margin: 0.08,
  },
  emitUnpitchedEvents: false,
};

function clone(policy: Omit<Policy, "mode">): Omit<Policy, "mode"> {
  return {
    analysis: { ...policy.analysis },
    tracking: { ...policy.tracking },
    pitch: { ...policy.pitch },
    onset: { ...policy.onset },
    chords: { ...policy.chords },
    emitUnpitchedEvents: policy.emitUnpitchedEvents,
  };
}

/** The per-mode bias. Same event model throughout; only the parameters move. */
function forMode(mode: TuninatorMode): Policy {
  const p = clone(BASE);

  switch (mode) {
    case "lead":
      // Monophonic, high stability requirement, chords off.
      break;

    case "chords":
      p.chords.enabled = true;
      p.tracking.minStableMs = 120;
      p.tracking.releaseGraceMs = 160;
      p.onset.sensitivity = 1.9;
      p.onset.minIntervalMs = 180;
      break;

    case "rhythm":
      p.emitUnpitchedEvents = true;
      p.tracking.minStableMs = 25;
      p.tracking.releaseGraceMs = 60;
      p.onset.sensitivity = 1.35;
      p.analysis.confidenceGate = 0.35;
      break;

    case "raw":
      // Near-passthrough: minimal interpretation.
      p.tracking.minStableMs = 0;
      p.tracking.releaseGraceMs = 30;
      p.pitch.medianFrames = 1;
      p.onset.enabled = false;
      p.analysis.confidenceGate = 0.2;
      break;
  }

  return { mode, ...p };
}

/** Merge user options over the mode defaults. Unspecified fields keep defaults. */
export function resolvePolicy(options: TuninatorOptions = {}): Policy {
  const mode = options.mode ?? "lead";
  const p = forMode(mode);

  const a = options.analysis;
  if (a) {
    if (a.minFrequencyHz !== undefined) p.analysis.minFrequencyHz = a.minFrequencyHz;
    if (a.maxFrequencyHz !== undefined) p.analysis.maxFrequencyHz = a.maxFrequencyHz;
    if (a.pitchHopMs !== undefined) p.analysis.pitchHopMs = a.pitchHopMs;
    if (a.rmsGate !== undefined) p.analysis.rmsGate = a.rmsGate;
    if (a.confidenceGate !== undefined) p.analysis.confidenceGate = a.confidenceGate;
  }

  const t = options.tracking;
  if (t) {
    if (t.minStableMs !== undefined) p.tracking.minStableMs = t.minStableMs;
    if (t.releaseGraceMs !== undefined) p.tracking.releaseGraceMs = t.releaseGraceMs;
    if (t.bendThresholdCents !== undefined) {
      p.tracking.bendThresholdCents = t.bendThresholdCents;
    }
  }

  return p;
}

/**
 * Re-resolve for a new mode while preserving the caller's explicit overrides.
 * Used by `setMode()`, which must never restart the audio graph.
 */
export function repolicy(mode: TuninatorMode, options: TuninatorOptions = {}): Policy {
  return resolvePolicy({ ...options, mode });
}
