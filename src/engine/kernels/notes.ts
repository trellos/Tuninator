/**
 * Frequency <-> MIDI <-> name <-> cents.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the DSP-core
 * workstream.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import type { PitchClass, PitchNote } from "../../types.js";

export const A4_HZ = 440;
export const A4_MIDI = 69;

/** Sharp-spelled, indexed by `midi % 12`. Matches the `PitchClass` union. */
export const PITCH_CLASSES: readonly PitchClass[] = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/** Semitone offset of each natural letter above C. */
const LETTER_SEMITONES: Readonly<Record<string, number>> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

/** `letter`, then zero or more accidentals, then a (possibly negative) octave. */
const NAME_PATTERN = /^([A-Ga-g])([#b♯♭]*)(-?\d+)$/;

/**
 * Round half *down* so that a frequency exactly midway between two notes is
 * reported as the lower note at +50 cents. This is what keeps `cents` inside
 * the contractual half-open range (-50, +50].
 */
function roundHalfDown(value: number): number {
  return -Math.round(-value);
}

/** Fractional MIDI number. Not rounded. */
export function frequencyToMidiFloat(hz: number, a4Hz: number = A4_HZ): number {
  if (!Number.isFinite(hz) || hz <= 0 || !Number.isFinite(a4Hz) || a4Hz <= 0) {
    return Number.NaN;
  }
  return A4_MIDI + 12 * Math.log2(hz / a4Hz);
}

export function midiToFrequency(midi: number, a4Hz: number = A4_HZ): number {
  return a4Hz * Math.pow(2, (midi - A4_MIDI) / 12);
}

export function midiToPitchClass(midi: number): PitchClass {
  const rounded = Math.round(midi);
  const index = ((rounded % 12) + 12) % 12;
  return PITCH_CLASSES[index]!;
}

/** Scientific octave. C4 is middle C, so MIDI 60 -> 4. */
export function midiToOctave(midi: number): number {
  return Math.floor(Math.round(midi) / 12) - 1;
}

/** Scientific pitch notation, e.g. "A4", "F#3". */
export function midiToName(midi: number): string {
  return `${midiToPitchClass(midi)}${midiToOctave(midi)}`;
}

/** Parses "A4", "F#3", "Bb2" (flats normalised to sharps). */
export function nameToMidi(name: string): number {
  const match = NAME_PATTERN.exec(name.trim());
  if (!match) {
    throw new Error(`nameToMidi: cannot parse note name "${name}"`);
  }

  const letter = match[1]!.toUpperCase();
  const accidentals = match[2]!;
  const octave = Number.parseInt(match[3]!, 10);

  let semitone = LETTER_SEMITONES[letter]!;
  for (let i = 0; i < accidentals.length; i++) {
    const c = accidentals[i]!;
    // "b"/"♭" lower; "#"/"♯" raise. The letter itself was consumed above, so a
    // lowercase "b" here is unambiguously a flat ("Bb2" -> B, flat, octave 2).
    semitone += c === "#" || c === "♯" ? 1 : -1;
  }

  return (octave + 1) * 12 + semitone;
}

/** Signed cents from `refHz` to `hz`. Positive means sharp. */
export function centsBetween(hz: number, refHz: number): number {
  if (!Number.isFinite(hz) || hz <= 0 || !Number.isFinite(refHz) || refHz <= 0) {
    return Number.NaN;
  }
  return 1200 * Math.log2(hz / refHz);
}

/**
 * Resolve a detected frequency to the nearest equal-tempered note.
 * `cents` is the signed deviation, in the range (-50, +50].
 */
export function describeFrequency(hz: number, a4Hz: number = A4_HZ): PitchNote {
  const midiFloat = frequencyToMidiFloat(hz, a4Hz);
  if (!Number.isFinite(midiFloat)) {
    throw new RangeError(`describeFrequency: frequency must be finite and > 0, got ${hz}`);
  }

  const midi = roundHalfDown(midiFloat);

  // Equivalent to `centsBetween(hz, midiToFrequency(midi, a4Hz))` but without
  // the extra round-trip through exp/log, which is what guarantees the result
  // lands exactly inside (-50, +50] rather than a ulp outside it.
  const cents = (midiFloat - midi) * 100;

  return {
    midi,
    name: midiToName(midi),
    pitchClass: midiToPitchClass(midi),
    octave: midiToOctave(midi),
    frequencyHz: hz,
    cents,
  };
}
