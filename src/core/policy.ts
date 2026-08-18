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
    /**
     * Short YIN window, in samples. ~5x better time resolution than
     * `longWindow`, and the single biggest lever on fast passages.
     */
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
     * Safety factor on the threshold's level-proportional floor.
     *
     * The decaying peak-hold reference leaks `1 - REFERENCE_DECAY` of the
     * frame's magnitude back into the flux every hop even when nothing is
     * happening, so the floor has to cover that leak. This multiplies it.
     *
     * It matters far more than it looks: the floor competes with the adaptive
     * median for `max()`, and because it scales with level it WINS in loud
     * passages — measured at 75% of hops through the lead fixture's triplet run,
     * where it made `sensitivity` inert and the detector deaf to exactly the
     * note boundaries it was needed for.
     */
    rippleFloorFactor: number;
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
    /**
     * How much louder than its recent baseline a frame must be for an onset to
     * split the chord already sounding.
     *
     * Barely above 1: the question is only "did energy stop falling?". The
     * baseline is a fast EMA, so a chord still decaying sits below it and a
     * re-strum sits above it; 1.02 is that test plus a margin for ripple.
     *
     * Its own number rather than `onset.repickRmsRise` (1.05) because the two
     * are answering different questions about different signals, and swept
     * against the fixtures they do not want the same answer: at 1.05 the
     * strummed fixture drops from 76.9% to 64.3% exact and loses two more of
     * its sixteen events, because a deliberately muted upstrum is quieter than
     * the ringing downstrum it follows.
     */
    restrikeRmsRise: number;
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
    // 65, swept 25/45/65/90 on the lead fixture: false positives fall 12/7/5/3
    // while accuracy holds at 79.1 until 90, where it drops. 65 is the last
    // value that costs nothing.
    minStableMs: 65,
    releaseGraceMs: 90,
    bendThresholdCents: 45,
  },
  pitch: {
    longWindow: 2048,
    // 384, swept against 256/384/512/768. The lead fixture's pitch-class
    // accuracy runs 69.8 / 79.1 / 72.1 / 67.4 across those: too long and the
    // detector is still hearing the previous note of a 166ms triplet, too short
    // and two periods of a 494Hz B4 barely fit. 384 samples is 8ms, and bounds
    // the short window's own search at 250Hz.
    shortWindow: 384,
    shortWindowMinHz: 300,
    yinThreshold: 0.13,
    // 1 -- no temporal median at all.
    //
    // It existed to discard a single octave-flipped frame, but a median that
    // spans 3 hops also delays every genuine note change by one, and on a 166ms
    // triplet that is most of a note. The octave errors it was covering for are
    // now caught where they belong: `isOctaveJump` in the note tracker refuses
    // to split on an octave leap, which is what those frames actually caused.
    // Measured: 1/2/3/5 frames give 8/8/9/11 missed notes on the lead fixture.
    medianFrames: 1,
    // 80 -- just under a semitone, so a real fretted step still clears it while
    // sub-semitone wobble does not. Swept 50/60/70/80: pitch-class accuracy
    // barely moves (81.4/79.1/79.1/79.1) but false positives fall 6/6/5/4, and
    // false positives are what the lead fixture is gated on.
    stepThresholdCents: 80,
  },
  onset: {
    enabled: true,
    fftSize: 1024,
    // 120bpm sixteenths are 125ms apart, so this has headroom while still
    // suppressing the double-triggers that pick noise produces.
    minIntervalMs: 90,
    medianWindow: 17,
    sensitivity: 1.6,
    rippleFloorFactor: 2,
    repickRmsRise: 1.05,
  },
  chords: {
    enabled: false,
    fftSize: 4096,
    restrikeRmsRise: 1.02,
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
