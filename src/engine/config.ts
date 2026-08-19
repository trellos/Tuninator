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
     * How far behind the audio the pitch estimate runs, ms.
     *
     * A frame is stamped at the END of the window it analysed, and the temporal
     * median needs several hops to turn over, so the pitch reported at time T
     * describes audio from around T minus this. The transient path has no such
     * delay, which is why a Note that begins on an attack lands on time while
     * its pitch arrives late.
     *
     * Used to decide WHICH Note a frame's pitch is evidence about. Zero means
     * every frame votes for whatever is sounding when it arrives, which on a
     * 167ms triplet hands half of each Note's evidence to its predecessor.
     */
    voteLagMs: number;
    /**
     * A single-hop pitch jump this large reads as a new note rather than a bend.
     * Total displacement cannot separate "A3 bent up to B3" from a legato
     * D5->E5 step — both are 200 cents — only the per-hop rate can.
     */
    stepThresholdCents: number;
    /** Consecutive frames a new pitch must hold before it splits a Note. */
    stepConfirmFrames: number;
    /**
     * Pitch confidence an arriving note needs before "the pitch changed" counts
     * as evidence that an attack started a new Note.
     *
     * On a strummed chord YIN reports whichever string dominates the window and
     * flips between them freely, at low confidence throughout — there is no
     * single periodicity to find. Requiring real periodicity is what stops
     * every strum from fragmenting into one Note per string.
     */
    splitConfidence: number;
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
     * Transient sharpness a re-strum needs over a *ringing chord*.
     *
     * Higher than `rearticulationSharpness`, and the only energy-independent
     * witness available there, because a chord's decay makes every level-based
     * test unreliable. Measured on the fixtures: genuine strums sit at 0.9 and
     * above (median 2.4 on the cowboy take), while most fragments a ringing
     * chord sheds top out just above 1.1.
     */
    restrumSharpness: number;
    /**
     * How long a single Note must have sounded before its own decay curve is
     * allowed to veto a re-articulation.
     *
     * Comfortably longer than a sixteenth at 140bpm (107ms) so fast runs keep
     * splitting normally, and far shorter than the seconds-long ring-out that
     * follows a phrase, which is what this is for.
     */
    ringOutMs: number;
    /**
     * Transient sharpness a *pitch-changing* attack needs before it starts a
     * new Note.
     *
     * Lower than `rearticulationSharpness`, because a new pitch is already
     * strong evidence — but not zero, because the individual strings of one
     * strum arrive at different pitch classes over tens of milliseconds and
     * would otherwise each open a Note of their own.
     */
    newPitchSharpness: number;
    /**
     * How long a *polyphonic* Note must have sounded before an attack is
     * allowed to end it.
     *
     * A strum excites six strings at slightly different moments and each one
     * rings unevenly, so the hundreds of milliseconds after a chord are full of
     * transient-looking energy that is the same strum still happening. A single
     * note has no such internal structure, which is why this applies only once
     * the deep lane has reported polyphony.
     */
    minRestrumMs: number;
    /**
     * How far above a Note's own measured decay curve the signal must sit for
     * the extra energy to count as a fresh strum.
     *
     * The one test a muted upstrum can pass and sustain ripple cannot: the
     * upstrum puts energy into strings that were on their way down, and no
     * amount of ripple lifts a decaying chord above where its own decay says
     * it should be.
     */
    restrumDecayExcess: number;
    /**
     * How long after a chord began a *sharpness-only* re-strum stays plausible.
     *
     * The sharpness escape exists for one thing: a muted upstrum, which damps
     * the strings and so puts total energy DOWN while plainly re-articulating
     * the chord. That is part of a strumming pattern — it follows its downstrum
     * within a beat, and on the fixtures every genuine one lands within half a
     * second of the strum it answers. Further into a ring-out the same evidence
     * means something else: a decaying chord produces sharp transients of its
     * own — finger noise, a string re-seating against a fret — that no pick
     * made, and reading those as re-strums is how a chord kept shedding Notes
     * seconds after it was played. Past this, re-articulating a chord takes
     * energy above its own decay curve, which is a witness ripple cannot fake.
     */
    mutedRestrumWindowMs: number;
    /**
     * Total pitch motion across the glide window that counts as an active
     * glide, in cents. Bending sweeps the spectrum, which spikes flux AND lifts
     * RMS, so both attack tests pass mid-bend; an attack only means "new note"
     * when the pitch is not already moving. Well above vibrato (±15 cents).
     */
    glideMinCents: number;
    /** Hops of pitch history the glide test looks back over. */
    glideWindowHops: number;
    /**
     * How long one articulation lasts, ms — the window in which a Note that has
     * just been ended by an attack is still the *same* thing being played.
     *
     * A strum is one gesture, not six: the pick crosses six strings over tens
     * of milliseconds and each string arrives as its own transient at its own
     * pitch. A single picked note is no better behaved — the attack transient
     * is the least periodic part of it, so the pitch estimator spends its first
     * hops still reporting whatever was ringing before. Either way the fast
     * lane emits a stub, named after the wrong thing, that ends on the attack
     * the player actually meant.
     *
     * Sized to cover the pitch path's lag and a strum's spread, and to stay
     * under a sixteenth at 120bpm (125ms) so a genuinely fast run still
     * segments. The fixtures put the cliff between 75 and 110ms: below it the
     * stubs survive, above it real notes in the triplet run are swallowed.
     */
    articulationMs: number;
  };

  tracking: {
    /** How long a Note must sound before it is announced. */
    minStableMs: number;
    /**
     * How long a Note with no measurable pitch must sound before it is
     * announced.
     *
     * Longer than `minStableMs`, because there is less to go on. A pitched Note
     * has already been confirmed by an independent estimator; an unpitched one
     * has only energy, and energy alone is also what a pick scrape, a fret
     * buzz and the tail of the previous chord look like.
     */
    minUnpitchedStableMs: number;
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
    /**
     * How long a Note must have sounded before it may report harmony it cannot
     * name.
     *
     * Naming a chord is self-justifying: the template fitted, the bass agreed,
     * and the Note says so. Saying "this is a chord and I will not name it" is
     * a much weaker claim to make about a short Note, and it is the one that
     * goes wrong on a fast run — an 85ms transform at 167ms per note straddles
     * two notes plus the decay of a third, which is genuinely polyphonic audio
     * that is not a chord. Every chord in the fixtures sustains for at least
     * 450ms; nothing shorter is a strum worth abstaining about.
     */
    minChordDurationMs: number;
    /** Estimated simultaneous fundamentals below which harmony never blooms. */
    minPolyphony: number;
    /**
     * Semitones the detected voices must span before the audio counts as
     * harmonic. Roughly a fifth: below that the "extra" fundamentals are an
     * octave doubling of one string, not a second voice.
     */
    minVoiceSpreadSemitones: number;
    /**
     * Mean fast-lane pitch confidence above which a Note stays a single note,
     * whatever the spectrum looks like.
     *
     * The spectral evidence cannot settle this on its own. A 4096-point window
     * is 85ms, and in a run at 167ms per note it straddles two notes plus the
     * decay of a third — so a fast lead line genuinely looks polyphonic, with
     * four to six fundamentals spread across two octaves. What separates it
     * from a chord is periodicity: one string sounding alone is strongly
     * periodic and YIN says so (median confidence 0.98 on the lead fixture),
     * while six strings ringing together have no single period to find (median
     * 0.65 to 0.90 on the chord fixtures).
     */
    maxMonophonicConfidence: number;
    /**
     * How harmonic the recent audio must read before an octave-sized pitch jump
     * is treated as the detector moving between strings rather than as a note
     * change.
     *
     * Deliberately far below half: the fragmentation this prevents happens in
     * the first moments of a strum, when the estimate has only just started
     * recovering from the silence before it. Waiting for certainty would arrive
     * after the damage.
     */
    octaveFlipContext: number;
    /**
     * How harmonic the recent audio must read before YIN's pitch steps stop
     * being treated as note boundaries at all.
     *
     * Higher than `octaveFlipContext`: ignoring an octave jump costs nothing on
     * a single note, while ignoring every step would merge a legato run into
     * one Note, so this one wants real confidence that a chord is sounding.
     */
    stepSuppressContext: number;
    /** Run the chroma path once every N fast hops. */
    hopDivisor: number;
    /**
     * How far back a Note that has just named itself a chord may reach to
     * absorb the fragments of its own attack.
     *
     * A strum is not one event acoustically: six strings are excited over tens
     * of milliseconds, each with its own transient, and the fast lane — which
     * has to answer within a hop and cannot know a chord is coming — reports
     * several short Notes before the deep lane has enough spectrum to say what
     * was played. Those fragments are not wrong, they are early. When the
     * harmony finally resolves, the Note that carries it reaches back and
     * absorbs the unnamed fragments contiguous with it, which is also what
     * moves its start back onto the real attack.
     */
    mergeLookbackMs: number;
    /** Largest silence between two Notes that a merge may bridge. */
    mergeMaxGapMs: number;
    /**
     * Longest Note a merge may absorb.
     *
     * A fragment of a strum's attack is short by definition — it exists because
     * the fast lane had to answer before the chord had declared itself. A Note
     * that sustained for longer than this was a note somebody played, and
     * swallowing it into a neighbour would delete a real event rather than
     * repair an artefact.
     */
    mergeMaxFragmentMs: number;
    /** How long the absorbing Note must itself have sounded. */
    mergeMinSurvivorMs: number;
    /**
     * How long a rival chord reading must persist before it splits the Note.
     *
     * Chord segmentation cannot wait for silence: the bars in these recordings
     * run into each other with no gap, and a player changing chord mid-ring
     * often produces no transient worth the name. The change itself is
     * therefore a boundary — but only once it has held, because one confused
     * window during a transition would otherwise shred a bar into fragments.
     */
    changeStableMs: number;
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
    voteLagMs: 0,
    stepThresholdCents: 70,
    stepConfirmFrames: 2,
    splitConfidence: 0.6,
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
    restrumSharpness: 0.9,
    ringOutMs: 250,
    newPitchSharpness: 0.3,
    minRestrumMs: 380,
    restrumDecayExcess: 1.25,
    mutedRestrumWindowMs: 1300,
    glideMinCents: 25,
    glideWindowHops: 5,
    articulationMs: 90,
  },
  tracking: {
    minStableMs: 45,
    minUnpitchedStableMs: 90,
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
    minEvidenceHops: 3,
    minChordDurationMs: 250,
    minPolyphony: 2,
    minVoiceSpreadSemitones: 7,
    maxMonophonicConfidence: 0.9,
    octaveFlipContext: 0.25,
    stepSuppressContext: 0.8,
    hopDivisor: 4,
    mergeLookbackMs: 900,
    mergeMaxGapMs: 120,
    mergeMaxFragmentMs: 250,
    mergeMinSurvivorMs: 0,
    changeStableMs: 240,
  },
  deep: {
    ringSeconds: 4,
    latencyMs: 40,
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
