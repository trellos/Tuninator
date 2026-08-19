import { describe, expect, it } from "vitest";

import {
  A4_HZ,
  A4_MIDI,
  PITCH_CLASSES,
  centsBetween,
  describeFrequency,
  frequencyToMidiFloat,
  midiToFrequency,
  midiToName,
  midiToOctave,
  midiToPitchClass,
  nameToMidi,
} from "../src/engine/kernels/notes.js";
import type { PitchClass } from "../src/types.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** MIDI numbers of the guitar range, low E (E2) to the 24th fret of high E (E6). */
const E2 = 40;
const E6 = 88;

function guitarRange(): number[] {
  const out: number[] = [];
  for (let m = E2; m <= E6; m++) out.push(m);
  return out;
}

/** Detune `hz` by `cents`. */
function detune(hz: number, cents: number): number {
  return hz * Math.pow(2, cents / 1200);
}

/** The twelve names the `PitchClass` union allows, in `midi % 12` order. */
const EXPECTED_CLASSES: PitchClass[] = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/* -------------------------------------------------------------------------- */

describe("A4 anchor", () => {
  it("pins A4 = 440Hz = MIDI 69 exactly", () => {
    expect(A4_HZ).toBe(440);
    expect(A4_MIDI).toBe(69);
    expect(midiToFrequency(69)).toBe(440);
    expect(frequencyToMidiFloat(440)).toBe(69);
  });

  it("describes 440Hz as A4 with zero cents", () => {
    const note = describeFrequency(440);
    expect(note).toEqual({
      midi: 69,
      name: "A4",
      pitchClass: "A",
      octave: 4,
      frequencyHz: 440,
      cents: 0,
    });
  });

  it("honours a non-standard concert pitch", () => {
    const note = describeFrequency(432, 432);
    expect(note.midi).toBe(69);
    expect(note.name).toBe("A4");
    expect(note.cents).toBeCloseTo(0, 10);

    // At A4 = 432, a 440Hz signal is sharp by the ratio between the two.
    const sharp = describeFrequency(440, 432);
    expect(sharp.midi).toBe(69);
    expect(sharp.cents).toBeCloseTo(1200 * Math.log2(440 / 432), 10);
  });

  it("moves an octave per 12 semitones", () => {
    expect(midiToFrequency(81)).toBeCloseTo(880, 10);
    expect(midiToFrequency(57)).toBeCloseTo(220, 10);
    expect(frequencyToMidiFloat(880)).toBeCloseTo(81, 12);
  });
});

describe("scientific octave numbering", () => {
  it("puts middle C at MIDI 60 = C4", () => {
    expect(midiToName(60)).toBe("C4");
    expect(midiToOctave(60)).toBe(4);
    expect(midiToPitchClass(60)).toBe("C");
    expect(nameToMidi("C4")).toBe(60);
  });

  it("uses floor(midi/12) - 1, including below C0", () => {
    expect(midiToName(0)).toBe("C-1");
    expect(midiToOctave(0)).toBe(-1);
    expect(nameToMidi("C-1")).toBe(0);
    expect(midiToName(11)).toBe("B-1");
    expect(midiToName(12)).toBe("C0");
    expect(midiToName(127)).toBe("G9");
    expect(nameToMidi("G9")).toBe(127);
  });

  it("increments the octave at C, not at A", () => {
    expect(midiToName(71)).toBe("B4");
    expect(midiToName(72)).toBe("C5");
  });
});

describe("PITCH_CLASSES", () => {
  it("is indexed by midi % 12 and matches the PitchClass union", () => {
    expect(PITCH_CLASSES).toEqual(EXPECTED_CLASSES);
    expect(PITCH_CLASSES).toHaveLength(12);
  });

  it("agrees with midiToPitchClass over the whole MIDI range", () => {
    for (let m = 0; m <= 127; m++) {
      expect(midiToPitchClass(m)).toBe(PITCH_CLASSES[m % 12]);
    }
  });

  it("names every note in the guitar range with a legal pitch class", () => {
    for (const m of guitarRange()) {
      expect(EXPECTED_CLASSES).toContain(midiToPitchClass(m));
      expect(midiToName(m)).toBe(`${midiToPitchClass(m)}${midiToOctave(m)}`);
    }
  });
});

describe("nameToMidi", () => {
  it("round-trips with midiToName across E2..E6", () => {
    for (const m of guitarRange()) {
      expect(nameToMidi(midiToName(m))).toBe(m);
    }
  });

  it("normalises flats to sharps", () => {
    expect(nameToMidi("Bb2")).toBe(nameToMidi("A#2"));
    expect(nameToMidi("Eb3")).toBe(nameToMidi("D#3"));
    expect(nameToMidi("Gb4")).toBe(nameToMidi("F#4"));
    expect(midiToName(nameToMidi("Bb2"))).toBe("A#2");
    expect(midiToName(nameToMidi("Db5"))).toBe("C#5");
  });

  it("handles accidentals that cross an octave boundary", () => {
    // Cb4 is the note below C4; B#3 is the note above B3.
    expect(nameToMidi("Cb4")).toBe(nameToMidi("B3"));
    expect(nameToMidi("B#3")).toBe(nameToMidi("C4"));
    expect(nameToMidi("E#3")).toBe(nameToMidi("F3"));
    expect(nameToMidi("Fb3")).toBe(nameToMidi("E3"));
  });

  it("accepts lower-case letters and surrounding whitespace", () => {
    expect(nameToMidi("a4")).toBe(69);
    expect(nameToMidi("  F#3 ")).toBe(54);
  });

  it("gives the standard open-string MIDI numbers", () => {
    expect(["E2", "A2", "D3", "G3", "B3", "E4"].map(nameToMidi)).toEqual([
      40, 45, 50, 55, 59, 64,
    ]);
  });

  it("throws on unparseable names", () => {
    for (const bad of ["", "H4", "A", "4A", "A#", "C##b", "A4.5"]) {
      expect(() => nameToMidi(bad)).toThrow();
    }
  });
});

describe("centsBetween", () => {
  it("is zero for identical frequencies and 1200 for an octave", () => {
    expect(centsBetween(440, 440)).toBe(0);
    expect(centsBetween(880, 440)).toBeCloseTo(1200, 10);
    expect(centsBetween(220, 440)).toBeCloseTo(-1200, 10);
    expect(centsBetween(midiToFrequency(70), midiToFrequency(69))).toBeCloseTo(100, 10);
  });

  it("is positive when sharp and negative when flat", () => {
    expect(centsBetween(441, 440)).toBeGreaterThan(0);
    expect(centsBetween(439, 440)).toBeLessThan(0);
  });
});

describe("describeFrequency", () => {
  it("reports the detected frequency, not the ideal one", () => {
    const note = describeFrequency(441);
    expect(note.frequencyHz).toBe(441);
    expect(note.midi).toBe(69);
    expect(note.cents).toBeGreaterThan(0);
  });

  it("round-trips frequency -> note -> frequency across the guitar range", () => {
    for (const m of guitarRange()) {
      const hz = midiToFrequency(m);
      const note = describeFrequency(hz);
      expect(note.midi).toBe(m);
      expect(note.name).toBe(midiToName(m));
      expect(note.cents).toBeCloseTo(0, 9);
      expect(midiToFrequency(note.midi)).toBeCloseTo(hz, 9);
    }
  });

  it("recovers a known detune exactly", () => {
    for (const m of guitarRange()) {
      for (const cents of [-49, -30, -12, -1, 0, 1, 12, 30, 49]) {
        const note = describeFrequency(detune(midiToFrequency(m), cents));
        expect(note.midi).toBe(m);
        expect(note.cents).toBeCloseTo(cents, 8);
      }
    }
  });

  it("keeps cents inside the half-open range (-50, +50] across a dense sweep", () => {
    // 20 steps per semitone over the whole guitar range, so every rounding
    // boundary is crossed many times.
    for (let m = E2; m <= E6; m += 1) {
      for (let step = 0; step < 20; step++) {
        const hz = midiToFrequency(m + step / 20);
        const note = describeFrequency(hz);
        expect(note.cents).toBeGreaterThan(-50);
        expect(note.cents).toBeLessThanOrEqual(50);
        // The reported note is genuinely the nearest one. Recomputed the long
        // way round (through midi -> Hz -> log) this picks up ~1e-13 of
        // floating-point drift, which is exactly why `describeFrequency` does
        // not compute `cents` that way; allow for it here.
        expect(Math.abs(centsBetween(hz, midiToFrequency(note.midi)))).toBeLessThanOrEqual(50 + 1e-9);
      }
    }
  });

  it("rounds a half-semitone down, so the boundary is +50 and never -50", () => {
    const boundary = midiToFrequency(69.5);
    const note = describeFrequency(boundary);
    expect(Math.abs(note.cents)).toBeCloseTo(50, 6);
    expect(note.cents).toBeGreaterThan(-50);
    expect(note.cents).toBeLessThanOrEqual(50);

    // Either side of the boundary the sign is unambiguous.
    const justBelow = describeFrequency(detune(boundary, -0.01));
    expect(justBelow.midi).toBe(69);
    expect(justBelow.cents).toBeCloseTo(49.99, 6);

    const justAbove = describeFrequency(detune(boundary, 0.01));
    expect(justAbove.midi).toBe(70);
    expect(justAbove.cents).toBeCloseTo(-49.99, 6);
  });

  it("resolves the standard open strings", () => {
    const strings: Array<[number, string]> = [
      [82.41, "E2"],
      [110.0, "A2"],
      [146.83, "D3"],
      [196.0, "G3"],
      [246.94, "B3"],
      [329.63, "E4"],
    ];
    for (const [hz, name] of strings) {
      const note = describeFrequency(hz);
      expect(note.name).toBe(name);
      expect(note.midi).toBe(nameToMidi(name));
      expect(Math.abs(note.cents)).toBeLessThan(1);
    }
  });

  it("rejects frequencies that cannot name a note", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => describeFrequency(bad)).toThrow(RangeError);
    }
    expect(frequencyToMidiFloat(0)).toBeNaN();
    expect(frequencyToMidiFloat(-5)).toBeNaN();
  });
});
