/**
 * The recognizer's single tuning object.
 *
 * Successor to `core/policy.ts`, minus the thing that file existed for: modes.
 * A `Policy` was per-mode because `lead` and `chords` ran *different code* —
 * chord segmentation was driven by chord-label change, note segmentation by
 * pitch step, and a chord played in lead mode was simply never a chord. One
 * recognizer now runs the whole time, so what is left here is genuine tuning:
 * gates, ranges, window sizes and how patient the tracker should be.
 *
 * Plain data, JSON-shaped: it crosses the worklet/worker port as a structured
 * clone, so no functions and no class instances.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { EngineTuning } from "../types.js";

export type EngineConfig = {
  analysis: {
    minFrequencyHz: number;
    maxFrequencyHz: number;
    /** Requested fast hop; the engine snaps it to whole 128-sample quanta. */
    hopMs: number;
    rmsGate: number;
    confidenceGate: number;
  };

  pitch: {
    /** Long YIN window, in samples. Sized for two periods of low E (82.4Hz). */
    longWindow: number;
    /** Short YIN window, in samples. ~4x better time resolution. */
    shortWindow: number;
    /** Above this frequency a confident short-window result is preferred. */
    shortWindowMinHz: number;
    /** YIN absolute threshold on the CMND curve. */
    yinThreshold: number;
    /** Frames of temporal median applied before snapping to a note. */
    medianFrames: number;
    /**
     * A single-hop pitch jump this large reads as a new note rather than a bend.
     * Total displacement cannot separate "A3 bent up to B3" from a legato
     * D5->E5 step — both are 200 cents — only the per-hop rate can.
     */
    stepThresholdCents: number;
    /** Consecutive frames a new pitch must hold before it splits a Note. */
    stepConfirmFrames: number;
  };

  transient: {
    fluxFftSize: number;
    /** Multiplier on the adaptive median. Higher = fewer flux onsets. */
    fluxSensitivity: number;
    fluxMedianWindow: number;
    /** Minimum interval between accepted attacks, ms. */
    minIntervalMs: number;
    /** RMS window for the envelope-rise test, ms. */
    envelopeWindowMs: number;
    /** Baseline the envelope-rise test measures against, ms. */
    envelopeBaselineMs: number;
    /** Rise over that baseline that counts as an attack on its own. */
    envelopeRiseRatio: number;
    /**
     * Rise a *flux* onset additionally needs before it is allowed to start a
     * new Note over a sounding one. Spectral flux fires on more than attacks:
     * as a note decays the adaptive median falls with it, so ordinary sustain
     * ripple keeps clearing the threshold and halves the note. A real re-pick
     * puts energy back into the string, which is what this tests for.
     */
    rearticulationRiseRatio: number;
    /**
     * Transient sharpness (flux / RMS) at which an attack counts as a genuine
     * re-articulation even though it is no louder than what it interrupts.
     * A muted upstrum over a ringing chord is exactly that case.
     */
    rearticulationSharpness: number;
    /**
     * Total pitch motion across the glide window that counts as an active
     * glide, in cents. Bending sweeps the spectrum, which spikes flux AND lifts
     * RMS, so both attack tests pass mid-bend; an attack only means "new note"
     * when the pitch is not already moving. Well above vibrato (±15 cents).
     */
    glideMinCents: number;
    /** Hops of pitch history the glide test looks back over. */
    glideWindowHops: number;
  };

  tracking: {
    /** How long a Note must sound before it is announced. */
    minStableMs: number;
    /** How long silence must persist before a Note is ended. */
    releaseGraceMs: number;
    bendThresholdCents: number;
    /** How long after an attack a new Note may still be backdated onto it. */
    backdateWindowMs: number;
    /** Notes held for `getNote()` after they end. */
    endedNoteHistory: number;
    /** Maximum contour points retained per Note. */
    maxContourPoints: number;
  };

  harmony: {
    fftSize: number;
    /** Minimum top-1 template score for a confident chord label. */
    floor: number;
    /** Minimum score(top1) - score(top2) for a confident chord label. */
    margin: number;
    /**
     * Confident hops the winning ROOT needs before a Note is willing to be
     * named. The chroma path runs once every few hops and caches in between, so
     * a handful of identical hops can be a single look at the spectrum.
     */
    minEvidenceHops: number;
    /** Estimated simultaneous fundamentals below which harmony never blooms. */
    minPolyphony: number;
    /** Run the chroma path once every N fast hops. */
    hopDivisor: number;
  };

  deep: {
    /** Audio history the deep lane can revisit, in seconds. */
    ringSeconds: number;
    /**
     * Source-time delay before a deep job's result is applied. Models the real
     * cost of deep analysis and, offline, makes that delay deterministic.
     */
    latencyMs: number;
  };

  diagnostics: {
    pitchFrames: boolean;
    contour: boolean;
  };
};

/** Matches the AudioWorklet render quantum. Do not change to "go faster". */
export const RENDER_QUANTUM = 128;

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  analysis: {
    minFrequencyHz: 70,
    maxFrequencyHz: 1400,
    hopMs: 12,
    rmsGate: 0.008,
    // Tuned against the recorded fixtures, not chosen a priori. At 0.5 the
    // detector dropped frames mid-note on decaying low strings, which read as
    // note-offs and split notes in two; 0.35 keeps them voiced.
    confidenceGate: 0.35,
  },
  pitch: {
    longWindow: 2048,
    shortWindow: 512,
    shortWindowMinHz: 300,
    yinThreshold: 0.13,
    medianFrames: 3,
    stepThresholdCents: 70,
    stepConfirmFrames: 2,
  },
  transient: {
    fluxFftSize: 1024,
    fluxSensitivity: 1.35,
    fluxMedianWindow: 17,
    minIntervalMs: 70,
    envelopeWindowMs: 20,
    envelopeBaselineMs: 80,
    envelopeRiseRatio: 1.35,
    rearticulationRiseRatio: 1.25,
    rearticulationSharpness: 0.7,
    glideMinCents: 25,
    glideWindowHops: 5,
  },
  tracking: {
    minStableMs: 45,
    releaseGraceMs: 90,
    bendThresholdCents: 45,
    backdateWindowMs: 120,
    endedNoteHistory: 64,
    maxContourPoints: 512,
  },
  harmony: {
    fftSize: 4096,
    floor: 0.55,
    margin: 0.08,
    minEvidenceHops: 5,
    minPolyphony: 2,
    hopDivisor: 4,
  },
  deep: {
    ringSeconds: 4,
    latencyMs: 150,
  },
  diagnostics: {
    pitchFrames: false,
    contour: false,
  },
};

/** Deep clone, so a caller's overrides never alias the shared defaults. */
function clone(config: EngineConfig): EngineConfig {
  return {
    analysis: { ...config.analysis },
    pitch: { ...config.pitch },
    transient: { ...config.transient },
    tracking: { ...config.tracking },
    harmony: { ...config.harmony },
    deep: { ...config.deep },
    diagnostics: { ...config.diagnostics },
  };
}

/**
 * Merge caller tuning over the defaults.
 *
 * `EngineTuning` deliberately exposes far less than `EngineConfig` holds: the
 * window sizes and template thresholds are the recognizer's business, and a
 * caller who moves them is tuning a detector rather than configuring a library.
 */
export function resolveEngineConfig(
  tuning: EngineTuning = {},
  diagnostics: { pitchFrames?: boolean; contour?: boolean } = {}
): EngineConfig {
  const config = clone(DEFAULT_ENGINE_CONFIG);
  const a = config.analysis;

  if (tuning.minFrequencyHz !== undefined) a.minFrequencyHz = tuning.minFrequencyHz;
  if (tuning.maxFrequencyHz !== undefined) a.maxFrequencyHz = tuning.maxFrequencyHz;
  if (tuning.hopMs !== undefined) a.hopMs = tuning.hopMs;
  if (tuning.rmsGate !== undefined) a.rmsGate = tuning.rmsGate;
  if (tuning.confidenceGate !== undefined) a.confidenceGate = tuning.confidenceGate;

  if (tuning.minStableMs !== undefined) config.tracking.minStableMs = tuning.minStableMs;
  if (tuning.releaseGraceMs !== undefined) {
    config.tracking.releaseGraceMs = tuning.releaseGraceMs;
  }
  if (tuning.bendThresholdCents !== undefined) {
    config.tracking.bendThresholdCents = tuning.bendThresholdCents;
  }
  if (tuning.deepLatencyMs !== undefined) config.deep.latencyMs = tuning.deepLatencyMs;

  if (diagnostics.pitchFrames !== undefined) {
    config.diagnostics.pitchFrames = diagnostics.pitchFrames;
  }
  if (diagnostics.contour !== undefined) config.diagnostics.contour = diagnostics.contour;

  return config;
}

/** Snap a requested hop to a whole number of render quanta, minimum one. */
export function snapHop(hopMs: number, sampleRate: number): number {
  const requested = (hopMs / 1000) * sampleRate;
  const quanta = Math.max(1, Math.round(requested / RENDER_QUANTUM));
  return quanta * RENDER_QUANTUM;
}
