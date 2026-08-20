/**
 * The seams the recognizer is built on.
 *
 * Every DSP decision the semantic layer depends on arrives through one of these
 * interfaces, carrying *evidence* rather than an answer. That distinction is
 * the whole design: a transient detector reports "energy rose by 3.2x over the
 * decaying baseline and the spectrum broadened", not "new note", because
 * whether that means a new note depends on what the tracker already believes —
 * mid-bend it means nothing, over a ringing chord it means a restrum.
 *
 * The first implementation of each is a wrapper over one of the eval-tested
 * kernels in `kernels/`. Replacing YIN with a neural estimator is meant to be a
 * new file implementing `IFastPitchEstimator`, not a rewrite of the tracker.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { PitchClass, PitchNote, SourceTimeMs } from "../types.js";

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

/** What the fast lane found out about pitch on one hop. */
export type PitchEvidence = {
  /** Null when gated, unvoiced, or below the confidence gate. */
  frequencyHz: number | null;
  confidence: number;
  nearest: PitchNote | null;
  /** Chosen lag in samples, for debugging. */
  tau: number | null;
  /** Cumulative mean normalised difference at `tau`. Lower is more periodic. */
  cmnd: number | null;
  /** Independent zero-crossing estimate, used as an octave sanity check. */
  zeroCrossingHz: number | null;
  /** Which window won this hop. The short one has ~4x the time resolution. */
  source: "long" | "short" | "none";
};

/**
 * Energy arriving in the signal.
 *
 * Both witnesses are reported rather than merged into a boolean, because they
 * fail differently and the tracker's response differs by witness. Spectral flux
 * localises an attack precisely but is deaf to a strum over a chord that is
 * already ringing (the spectrum barely changes); the envelope rise catches
 * exactly that case but is blunt about *when*.
 */
export type AttackEvidence = {
  at: SourceTimeMs;
  atSample: number;
  /** Spectral flux fired on this hop. */
  flux: boolean;
  /** Raw positive-rectified spectral flux, whether or not it fired. */
  fluxValue: number;
  /** The envelope rose sharply over its own recent baseline. */
  envelope: boolean;
  /** RMS over the short window divided by the baseline. 1 = no change. */
  riseRatio: number;
  /**
   * Spectral flux divided by the frame's own RMS: how *sharp* the transient is,
   * independent of how loud the passage is.
   *
   * This is what separates a muted upstrum over a ringing chord — quieter than
   * what it interrupts, so its rise ratio is below 1, but unmistakably a pick
   * hitting strings — from the ordinary flux ripple of a chord decaying.
   * Measured across the fixtures, hops near a labeled attack sit around 0.3-1.0
   * and hops elsewhere around 0.1.
   */
  sharpness: number;
  /**
   * Spectral flux divided by the threshold the flux kernel had adapted to when
   * it fired: how far this transient stands above what THIS signal's own
   * transients have been doing over the last few hundred milliseconds.
   *
   * `sharpness` divides by the frame's RMS, which makes it independent of how
   * loud the passage is but not of what the signal path did to it. A room mic
   * and an amp sim leave far more steady-state spectral churn behind than a
   * direct input does, so the same absolute sharpness means "a pick hit a
   * string" on one path and "nothing happened" on another — measured across
   * the corpus, the sharpness of attacks that land on nothing runs 0.46 on the
   * clean fixtures and 1.37 on the amp-sim ones, straddling any fixed
   * threshold. This ratio has the signal's own recent history in its
   * denominator instead, and its off-label median sits at 1.02-1.24 on every
   * path in the corpus.
   */
  fluxRatio: number;
  /** 0..1 blend of both witnesses. */
  strength: number;
};

/** A pitch that has moved, and how. */
export type PitchChangeEvidence = {
  kind: "step" | "glide";
  fromHz: number;
  toHz: number;
  cents: number;
  /** Source time of the FIRST frame showing the new pitch, not the confirming one. */
  at: SourceTimeMs;
  atSample: number;
  /** Frames the new pitch has held. */
  heldFrames: number;
};

/** One hop as the tracker sees it. */
export type FastFrame = {
  /** Index of the last sample in the analysed window. */
  sampleIndex: number;
  at: SourceTimeMs;
  pitch: PitchEvidence;
  rms: number;
  peak: number;
  /** True when the input is below the engine's amplitude gate. */
  gated: boolean;
  /** Null when nothing arrived on this hop. */
  attack: AttackEvidence | null;
  /** Short-window RMS over the recent baseline; the decay/injection signal. */
  riseRatio: number;
  /**
   * A band-limited flux onset fired on this hop.
   *
   * A second witness the fast lane is deliberately NOT allowed to act on. It
   * sums the flux over the region where a pick's transient lives and a ringing
   * guitar string's fundamentals do not (`transient.attackBandLoHz`), which is
   * what lets it hear a quiet upstroke over a loud note still sounding — the
   * room-mic sixteenths take goes from 38 of its 48 attacks visible to 43.
   *
   * It is not a licence to open a Note, and that is a measurement rather than
   * caution: routed into the fast lane's own decisions it costs `chords-a-bm` a
   * labelled event and takes `clean-lead`'s false positives from 1 to 5-9 at
   * every threshold tried, because every downstream constant is fitted to what
   * the broadband flux does. What it is good for is corroboration — the region
   * lane can see that the envelope rose over a trough and cannot localise it,
   * and this says exactly when energy arrived.
   */
  bandOnset: boolean;
  /** Hop index since the engine started. */
  hop: number;
};

/** One pitch the deep lane believes is sounding, with its register intact. */
export type PitchActivation = {
  frequencyHz: number;
  midi: number;
  pitchClass: PitchClass;
  octave: number;
  /** How much of the analysed spectrum this fundamental accounts for. */
  salience: number;
  confidence: number;
};

/** What the deep lane found in one window of audio. */
export type SpectralEvidence = {
  /** 12 bins, index 0 = C, normalised so max = 1. */
  chroma: Float32Array;
  bassPitchClass: number | null;
  bassFrequencyHz: number | null;
  salience: number;
  polyphony: number;
  /**
   * Semitones between the lowest and highest detected fundamental.
   *
   * The count of fundamentals alone does not separate a chord from a single
   * note: a plucked string routinely produces two or three surviving
   * fundamentals an octave apart, so "polyphony 2" is as common in a lead line
   * as in a dyad. What a chord actually looks like is voices *spread across the
   * neck* — measured across the fixtures, the lead take's fundamentals sit a
   * median of 4 semitones apart while the chord takes sit at 12 to 24.
   */
  voiceSpreadSemitones: number;
};

/** A chord reading, or an honest refusal to name one. */
export type HarmonicReading = {
  root: PitchClass | null;
  quality: string | null;
  /** "C", "C/G", "Cmaj9", "C5". Null when abstaining. */
  chordName: string | null;
  bass: PitchActivation | null;
  intervals: string[];
  confidence: number;
  /** Runner-up readings, most confident first. */
  alternatives: Array<{ label: string; confidence: number }>;
  /** True when the reading cleared both the floor and the margin. */
  isConfident: boolean;
};

/* -------------------------------------------------------------------------- */
/* Fast lane                                                                   */
/* -------------------------------------------------------------------------- */

export interface IFastPitchEstimator {
  /** Samples the long window needs. */
  readonly longWindowSize: number;
  /** Samples the short window needs. */
  readonly shortWindowSize: number;
  estimate(longWindow: Float32Array, shortWindow: Float32Array): PitchEvidence;
  reset(): void;
}

export interface ITransientDetector {
  /** Samples the spectral window needs. */
  readonly windowSize: number;
  /**
   * @param spectralWindow the most recent `windowSize` samples
   * @param shortRms RMS over a short recent window — the injection witness
   * @param at source time of the end of the analysed audio
   */
  observe(
    spectralWindow: Float32Array,
    shortRms: number,
    at: SourceTimeMs,
    atSample: number
  ): AttackEvidence | null;

  /**
   * Did the band-limited flux fire on the hop just observed? See
   * `FastFrame.bandOnset`.
   */
  readonly bandOnset: boolean;
  /** Short-window RMS over its baseline for the most recent hop. */
  readonly riseRatio: number;
  reset(): void;
}

export interface IPitchChangeDetector {
  /** Feed one hop. Returns evidence only when a change has been confirmed. */
  observe(frame: FastFrame): PitchChangeEvidence | null;
  /** True when the pitch is currently sweeping — a bend or slide in progress. */
  isGliding(): boolean;
  reset(): void;
}

export interface IRearticulationDetector {
  /**
   * Is this attack a genuine re-articulation over what is already sounding?
   *
   * @param attack the arriving energy
   * @param gliding whether the pitch is currently sweeping
   * @param sustainedRms the rolling baseline of what is already sounding
   * @param pitchDiffers the arriving pitch is not the sounding Note's own
   */
  isRearticulation(
    attack: AttackEvidence,
    frame: FastFrame,
    gliding: boolean,
    sustainedRms: number,
    /** The arriving pitch is not the one the sounding Note is named after. */
    pitchDiffers: boolean,
    /**
     * How far above its own fitted decay curve the sounding Note is, or null
     * while that decay is not yet measurable. See `tracker/voices.ts`.
     */
    decayExcess: number | null,
    /** The sounding Note is a chord, on the deep lane's evidence. */
    polyphonic: boolean,
    /** How long the sounding Note has already lasted, ms. */
    soundedMs: number
  ): boolean;
}

/* -------------------------------------------------------------------------- */
/* Deep lane                                                                   */
/* -------------------------------------------------------------------------- */

export interface ISpectralAnalyzer {
  readonly windowSize: number;
  analyze(window: Float32Array): SpectralEvidence;
}

export interface IMultiPitchAnalyzer {
  /** Register-preserving: a voicing, not a set of pitch classes. */
  activations(evidence: SpectralEvidence): PitchActivation[];
}

export interface IHarmonicInterpreter {
  interpret(
    evidence: SpectralEvidence,
    activations: readonly PitchActivation[]
  ): HarmonicReading;
}

/**
 * How deep jobs get from "queued" to "run".
 *
 * Injected rather than assumed so the offline harness can drain the queue
 * deterministically after each hop with a configurable simulated latency, while
 * the browser host drains it in budgeted slices. A replay test asserts the two
 * produce identical event streams.
 */
export interface IDeepScheduler {
  /** Queue work to run once source time has advanced to at least `notBefore`. */
  schedule(job: DeepJob): void;
  /** Run everything now due at `now`. Returns the jobs that ran. */
  drain(now: SourceTimeMs): void;
  /** Drop everything pending. */
  clear(): void;
  readonly pending: number;
}

export type DeepJobPurpose = "harmony" | "bend" | "multiPitch" | "resegment";

/* -------------------------------------------------------------------------- */
/* Region re-segmentation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One window's reading inside a region, ordered oldest first.
 *
 * The region analyser walks a span of audio at a hop rather than looking at one
 * window ending at "now", so what it produces is a *sequence*. Everything the
 * segmenter decides from is here, so the segmentation rule is testable against
 * a handwritten sequence with no FFT in sight.
 */
export type RegionWindowReading = {
  /** Inclusive start of the analysed window. */
  fromSample: number;
  /** Exclusive end. */
  toSample: number;
  /** Source time of the END of the analysed audio. */
  at: SourceTimeMs;
  /** Strongest fundamental in this window, register intact. Null when silent. */
  dominantMidi: number | null;
  /** Salience of the runner-up relative to the leader. 0 when there is none. */
  runnerUpSalience: number;
  rms: number;
  activations: PitchActivation[];
  evidence: SpectralEvidence;
  reading: HarmonicReading;
};

/**
 * One musical event the region analyser believes happened, in absolute samples.
 *
 * Deliberately carries no note id. The whole point of the region lane is that
 * it decides how many events there were, which it cannot do while it is being
 * told in advance whose window it is looking at.
 */
export type RegionSegment = {
  fromSample: number;
  toSample: number;
  from: SourceTimeMs;
  to: SourceTimeMs;
  /** Strongest fundamental over the segment. Null when nothing was found. */
  dominantMidi: number | null;
  /** Every activation seen in the segment, strongest first. */
  activations: PitchActivation[];
  /** The best harmonic reading over the segment, or an abstention. */
  reading: HarmonicReading;
  /** Windows that voted for this segment. */
  windows: number;
  /** How sure the analyser is that this is one event. */
  confidence: number;
  /** Why the segment began. The first segment of a region is "regionStart". */
  boundary: "regionStart" | "pitchChange" | "energyRise";
};

/** What the deep lane concluded about a whole region of audio. */
export type DeepSegmentation = {
  fromSample: number;
  toSample: number;
  from: SourceTimeMs;
  to: SourceTimeMs;
  segments: RegionSegment[];
  /** Windows analysed. Zero means the region was too short to look at. */
  windowCount: number;
  /** Mean per-segment confidence, or 0 when there are no segments. */
  confidence: number;
};

export type DeepJob = {
  /** Jobs with the same key coalesce: a newer one supersedes an older one. */
  key: string;
  noteId: string;
  purpose: DeepJobPurpose;
  /** Sample range to analyse. */
  fromSample: number;
  toSample: number;
  /** Source time the result may be applied at. */
  notBefore: SourceTimeMs;
  run: () => void;
};

/* -------------------------------------------------------------------------- */
/* Confidence                                                                  */
/* -------------------------------------------------------------------------- */

export type ConfidenceParts = {
  pitch?: number;
  stability?: number;
  amplitude?: number;
  spectralFit?: number;
};

export interface IConfidenceModel {
  blend(parts: ConfidenceParts): number;
}
