/**
 * Pitch-class profile (chroma) for chord detection.
 *
 * A strummed guitar's overtones swamp its fundamentals in a raw magnitude
 * spectrum, so this does not fold the spectrum. It transcribes it first:
 * `NoteActivation` solves for how much of every semitone is sounding, jointly,
 * and only the resulting note activations are folded into 12 bins. An overtone
 * is therefore never counted as a note, and a note whose evidence is shared
 * with another note's overtones still gets its share.
 *
 * The bass is read off the same activations, as the lowest note the solver
 * actually lit up. That is what separates C5 from G5, and Am11 from C6/9.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the chord
 * workstream. Depends on `NoteActivation`.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import { NoteActivation } from "./note-activation.js";

export type ChromaOptions = {
  sampleRate: number;
  fftSize: number;
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  /** Harmonics per dictionary column. */
  harmonics?: number;
  /** Exponent applied to peak amplitudes before the fit. */
  magnitudeExponent?: number;
  /** Per-harmonic decay of a dictionary column. */
  harmonicDecay?: number;
  /** Spectral-envelope variants per note. */
  envelopes?: number;
  /** How large a note's fundamental peak must be beside its own harmonics. */
  fundamentalMinRatio?: number;
  /** Fraction of the strongest activation at which a note counts as sounding. */
  presenceRatio?: number;
  /** Contrast exponent applied to the normalised chroma. */
  contrast?: number;
};

export type ChromaResult = {
  /** 12 bins, index 0 = C, normalised so max = 1 (all zeros when silent). */
  chroma: Float32Array;
  /**
   * Lowest confidently-detected note, as a pitch class index (0 = C).
   * This is what separates C5 from G5, and Am11 from C6/9.
   */
  bassPitchClass: number | null;
  bassFrequencyHz: number | null;
  /** 0..1 measure of how tonal (vs. noisy) the spectrum is. */
  salience: number;
  /** Number of simultaneous notes the transcription found. */
  polyphony: number;
};

/* -------------------------------------------------------------------------- */
/* Tuning constants                                                            */
/* -------------------------------------------------------------------------- */

const DEFAULT_MIN_FREQUENCY_HZ = 70;
const DEFAULT_MAX_FREQUENCY_HZ = 1300;

/** Partials are measured and modelled this far up, well past the note grid. */
const SPECTRUM_MAX_HZ = 3000;

/**
 * Exponent of the generalised mean used to fold octaves into a pitch class.
 *
 * 1 is a plain sum, higher tends towards a max. Guitar voicings double the root
 * and fifth across strings and play the third once (open Em is E2 B2 E3 G3 B3
 * E4 — three E's, two B's, one G), so a plain sum makes every triad look like a
 * power chord. Combining octaves as an L-p norm lets a doubled note count for
 * more than a single one without counting for twice as much.
 */
const OCTAVE_FOLD_POWER = 2;

/**
 * Contrast exponent applied to the normalised chroma. Below 1 it *expands* the
 * quiet bins rather than suppressing them.
 *
 * What reaches this point is note presence, not energy, and presence is not
 * loudness: a third fretted on one string is genuinely quieter than a root
 * doubled across three, but it is no less part of the chord. Measured on the
 * cowboy-chords D bar, the transcription is right -- A2 D3 A3 D4 F#4, exactly
 * the voicing -- yet the F# activation is a third of the D's, purely because
 * one string is carrying it. Uncompressed, every triad reads as a power chord.
 */
const DEFAULT_CHROMA_CONTRAST = 0.5;

/**
 * Below this tonality the frame is noise, and it yields no chroma at all.
 *
 * Peak picking promotes noise: a loud hiss offers dozens of local maxima, and
 * enough of them land near some candidate's harmonics to elect five or six
 * confident "notes" that spell a chord nobody played. Peak shape cannot
 * separate the two cases — spectral flatness can, and that is what `salience`
 * measures. It fails safe: a gated frame reports no chroma, and the caller
 * reports `unknown`.
 */
const MIN_TONAL_SALIENCE = 0.4;

/** A note counts as sounding at this fraction of the strongest activation. */
const DEFAULT_NOTE_PRESENCE_RATIO = 0.12;

/** Bass search is limited to this range; a guitar's lowest string is 82.4Hz. */
const BASS_MAX_FREQUENCY_HZ = 220;
/**
 * The bass is the lowest note holding this fraction of the strongest
 * activation. Lower than the presence ratio because a bass string is often
 * the quietest thing in a strum and still unambiguously the bottom of the
 * chord.
 */
const BASS_PRESENCE_RATIO = 0.08;

/**
 * Bins a semitone must span before two adjacent notes count as distinguishable.
 * Below this the solver cannot help smearing each into the other.
 */
const MIN_RESOLVED_SEMITONE_BINS = 3;

const A4_HZ = 440;
const A4_MIDI = 69;

/* -------------------------------------------------------------------------- */

function hzFromMidi(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

export class ChromaAnalyzer {
  /** Number of samples `analyze()` expects. Equals `fftSize`. */
  readonly windowSize: number;

  private readonly notes: NoteActivation;
  private readonly contrast: number;
  private readonly presenceRatio: number;
  private readonly binHz: number;
  private readonly chroma = new Float32Array(12);
  private readonly octaveFold = new Float64Array(12);

  constructor(options: ChromaOptions) {
    const { sampleRate, fftSize } = options;
    if (!(sampleRate > 0)) {
      throw new Error(`ChromaAnalyzer: sampleRate must be > 0, got ${sampleRate}`);
    }

    const minFrequencyHz = Math.max(1, options.minFrequencyHz ?? DEFAULT_MIN_FREQUENCY_HZ);
    const maxFrequencyHz = Math.min(
      options.maxFrequencyHz ?? DEFAULT_MAX_FREQUENCY_HZ,
      sampleRate / 2
    );
    if (maxFrequencyHz <= minFrequencyHz) {
      throw new Error(
        `ChromaAnalyzer: maxFrequencyHz (${maxFrequencyHz}) must exceed ` +
          `minFrequencyHz (${minFrequencyHz})`
      );
    }

    this.windowSize = fftSize;
    this.binHz = sampleRate / fftSize;
    this.contrast = options.contrast ?? DEFAULT_CHROMA_CONTRAST;
    this.presenceRatio = options.presenceRatio ?? DEFAULT_NOTE_PRESENCE_RATIO;
    this.notes = new NoteActivation({
      sampleRate,
      fftSize,
      // The grid spans the notes that can be PLAYED; the spectrum is measured
      // well above it, because a note is identified by its harmonics.
      minMidi: Math.ceil(midiFromHz(minFrequencyHz)),
      maxMidi: Math.floor(midiFromHz(maxFrequencyHz)),
      spectrumMinHz: minFrequencyHz,
      spectrumMaxHz: SPECTRUM_MAX_HZ,
      harmonics: options.harmonics,
      magnitudeExponent: options.magnitudeExponent,
      harmonicDecay: options.harmonicDecay,
      envelopes: options.envelopes,
      fundamentalMinRatio: options.fundamentalMinRatio,
    });
  }

  /**
   * True when note `k` looks like its stronger neighbour bleeding a semitone.
   *
   * Down where a semitone is narrower than the FFT's own resolution, a note's
   * fundamental and its neighbour's occupy the same bins, so the solver cannot
   * help putting some of each onto the other. Measured on a synthesised
   * diminished seventh (C3 D#3 F#3 A3), D3 came out at 48% and C#3 at 32% —
   * neither played, both simply the smear of the notes a semitone above and
   * below them — and the spurious D was enough to make a symmetric chord that
   * has no right answer come out as a confident D7.
   *
   * A leak is never larger than what it leaked from, so requiring a local
   * maximum removes it. The rule is confined to the register where the FFT
   * really cannot resolve a semitone; higher up, two adjacent semitones are
   * many bins apart and a player sounding both deserves to have both reported.
   */
  private isUnresolvedLeak(activation: Float64Array, k: number): boolean {
    if (!this.resolvesSemitoneAt(k)) {
      if (k > 0 && activation[k - 1]! > activation[k]!) return true;
      if (k + 1 < this.notes.noteCount && activation[k + 1]! > activation[k]!) return true;
    }
    return false;
  }

  /** True when a semitone at note `k` spans enough bins to be resolvable. */
  private resolvesSemitoneAt(k: number): boolean {
    const hz = hzFromMidi(this.notes.midiOf(k));
    return hz * (Math.pow(2, 1 / 12) - 1) >= this.binHz * MIN_RESOLVED_SEMITONE_BINS;
  }

  /** `window.length` must equal `windowSize`. Applies its own Hann window. */
  analyze(window: Float32Array): ChromaResult {
    if (window.length !== this.windowSize) {
      throw new Error(
        `ChromaAnalyzer.analyze: expected ${this.windowSize} samples, got ${window.length}`
      );
    }

    const result = this.notes.analyze(window);
    if (result.peakActivation <= 0) return untonalResult(result.salience);
    // Too flat to be an instrument: report the tonality, but no notes.
    if (result.salience < MIN_TONAL_SALIENCE) return untonalResult(result.salience);

    const { activation, peakActivation } = result;
    const presenceFloor = peakActivation * this.presenceRatio;
    const bassFloor = peakActivation * BASS_PRESENCE_RATIO;

    let polyphony = 0;
    let bassIndex = -1;
    this.octaveFold.fill(0);

    for (let k = 0; k < this.notes.noteCount; k++) {
      const value = activation[k]!;
      if (value < presenceFloor) continue;
      if (this.isUnresolvedLeak(activation, k)) continue;
      polyphony++;
      // The floor is SUBTRACTED, not just tested. A hard threshold makes the
      // floor a cliff: a note scraping past it lands in the chroma at the
      // floor's height, which after normalising and expanding is around 0.45 —
      // loud enough to change the chord. Subtracting makes a marginal note
      // contribute a marginal amount, which is what marginal evidence is worth.
      const above = value - presenceFloor;
      const pitchClass = (((this.notes.midiOf(k) % 12) + 12) % 12);
      this.octaveFold[pitchClass] = this.octaveFold[pitchClass]! + Math.pow(above, OCTAVE_FOLD_POWER);
    }

    for (let k = 0; k < this.notes.noteCount; k++) {
      const hz = hzFromMidi(this.notes.midiOf(k));
      if (hz > BASS_MAX_FREQUENCY_HZ) break;
      if (activation[k]! < bassFloor) continue;
      if (this.isUnresolvedLeak(activation, k)) continue;
      bassIndex = k;
      break;
    }

    let max = 0;
    for (let i = 0; i < 12; i++) {
      const v = Math.pow(this.octaveFold[i]!, 1 / OCTAVE_FOLD_POWER);
      this.chroma[i] = v;
      if (v > max) max = v;
    }
    if (max > 0) {
      for (let i = 0; i < 12; i++) {
        this.chroma[i] = Math.pow(this.chroma[i]! / max, this.contrast);
      }
    }

    const bassMidi = bassIndex < 0 ? null : this.notes.midiOf(bassIndex);
    return {
      chroma: this.chroma,
      bassPitchClass: bassMidi === null ? null : (((bassMidi % 12) + 12) % 12),
      bassFrequencyHz: bassMidi === null ? null : hzFromMidi(bassMidi),
      salience: result.salience,
      polyphony,
    };
  }
}

/**
 * Running mean of the last N chroma frames.
 *
 * A chord lasts for hundreds of milliseconds; a chroma frame describes 85 of
 * them, and a single strum's frames disagree wildly as strings decay at
 * different rates and the pick noise washes through. Measured across one Bm
 * strum, consecutive frames read Bm, B5, Esus2, Esus2, B5, Gmaj9, Bm11 -- every
 * one of them a plausible reading of that instant, and the majority of them
 * wrong about the chord. Averaging first is what turns "what is sounding right
 * now" into "what is being played", and it is standard practice in chord
 * recognition for exactly this reason.
 *
 * The caller is expected to `reset()` on an attack: smoothing across a chord
 * change would blur the boundary the tracker needs to see.
 */
export class ChromaSmoother {
  private readonly history: Float32Array[];
  private readonly mean = new Float32Array(12);
  private next = 0;
  private filled = 0;

  constructor(frames: number) {
    const count = Math.max(1, Math.round(frames));
    this.history = Array.from({ length: count }, () => new Float32Array(12));
  }

  reset(): void {
    this.next = 0;
    this.filled = 0;
  }

  /**
   * Adds `chroma` and returns the mean of the frames held, renormalised to
   * max 1. The result is this instance's own buffer, valid until the next call.
   *
   * An all-zero frame — one the tonality gate rejected — is not history, it is
   * the absence of history, and averaging it in would dim a chord that is
   * perfectly audible either side of one noisy window.
   */
  push(chroma: Float32Array): Float32Array {
    let any = false;
    for (let i = 0; i < 12; i++) {
      if (chroma[i]! > 0) {
        any = true;
        break;
      }
    }
    if (any) {
      this.history[this.next]!.set(chroma);
      this.next = (this.next + 1) % this.history.length;
      if (this.filled < this.history.length) this.filled++;
    }
    if (this.filled === 0) {
      this.mean.fill(0);
      return this.mean;
    }

    let max = 0;
    for (let i = 0; i < 12; i++) {
      let sum = 0;
      for (let f = 0; f < this.filled; f++) sum += this.history[f]![i]!;
      const value = sum / this.filled;
      this.mean[i] = value;
      if (value > max) max = value;
    }
    if (max > 0) for (let i = 0; i < 12; i++) this.mean[i] = this.mean[i]! / max;
    return this.mean;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function midiFromHz(hz: number): number {
  return A4_MIDI + 12 * Math.log2(hz / A4_HZ);
}

/** No notes found, but the measured tonality is still worth reporting. */
function untonalResult(salience: number): ChromaResult {
  return {
    chroma: new Float32Array(12),
    bassPitchClass: null,
    bassFrequencyHz: null,
    salience,
    polyphony: 0,
  };
}
