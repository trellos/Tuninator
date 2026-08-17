/**
 * Frequency <-> MIDI <-> name <-> cents.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the DSP-core
 * workstream.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import type { PitchClass, PitchNote } from "../types.js";

export const A4_HZ = 440;
export const A4_MIDI = 69;

/** Sharp-spelled, indexed by `midi % 12`. Matches the `PitchClass` union. */
export const PITCH_CLASSES: readonly PitchClass[] = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/** Fractional MIDI number. Not rounded. */
export function frequencyToMidiFloat(_hz: number, _a4Hz: number = A4_HZ): number {
  throw new Error("frequencyToMidiFloat: not implemented");
}

export function midiToFrequency(_midi: number, _a4Hz: number = A4_HZ): number {
  throw new Error("midiToFrequency: not implemented");
}

export function midiToPitchClass(_midi: number): PitchClass {
  throw new Error("midiToPitchClass: not implemented");
}

/** Scientific octave. C4 is middle C, so MIDI 60 -> 4. */
export function midiToOctave(_midi: number): number {
  throw new Error("midiToOctave: not implemented");
}

/** Scientific pitch notation, e.g. "A4", "F#3". */
export function midiToName(_midi: number): string {
  throw new Error("midiToName: not implemented");
}

/** Parses "A4", "F#3", "Bb2" (flats normalised to sharps). */
export function nameToMidi(_name: string): number {
  throw new Error("nameToMidi: not implemented");
}

/** Signed cents from `refHz` to `hz`. Positive means sharp. */
export function centsBetween(_hz: number, _refHz: number): number {
  throw new Error("centsBetween: not implemented");
}

/**
 * Resolve a detected frequency to the nearest equal-tempered note.
 * `cents` is the signed deviation, in the range (-50, +50].
 */
export function describeFrequency(_hz: number, _a4Hz: number = A4_HZ): PitchNote {
  throw new Error("describeFrequency: not implemented");
}
