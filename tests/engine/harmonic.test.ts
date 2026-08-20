/**
 * Harmonic interpretation: naming a chord, and refusing to.
 *
 * Driven with hand-built chroma vectors rather than audio, because the question
 * here is what the interpretation layer does with a spectrum, not whether the
 * front end produced a good one. Inversions, power chords and abstention are
 * all cases the template match cannot express on its own — a template is
 * transposition-invariant and therefore inversion-blind, and a match that
 * clears no threshold still has to become *something*.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG } from "../../src/engine/config.js";
import type { PitchActivation, SpectralEvidence } from "../../src/engine/contracts.js";
import { HarmonicInterpreter } from "../../src/engine/deep/harmonic.js";
import { PITCH_CLASSES } from "../../src/engine/kernels/notes.js";

const interpreter = new HarmonicInterpreter(DEFAULT_ENGINE_CONFIG);

function chroma(present: readonly number[]): Float32Array {
  const out = new Float32Array(12);
  for (const index of present) out[index] = 1;
  return out;
}

function evidence(
  present: readonly number[],
  bassPitchClass: number | null,
  bassFrequencyHz: number | null = null
): SpectralEvidence {
  return {
    chroma: chroma(present),
    bassPitchClass,
    bassFrequencyHz,
    salience: 0.9,
    polyphony: present.length,
    voiceSpreadSemitones: 12,
  };
}

function activation(midi: number, salience = 1): PitchActivation {
  return {
    frequencyHz: 440 * Math.pow(2, (midi - 69) / 12),
    midi,
    pitchClass: PITCH_CLASSES[((midi % 12) + 12) % 12] as PitchActivation["pitchClass"],
    octave: Math.floor(midi / 12) - 1,
    salience,
    confidence: 0.8,
  };
}

describe("naming a chord", () => {
  it("names a major triad", () => {
    const reading = interpreter.interpret(evidence([0, 4, 7], 0), [activation(48)]);
    expect(reading.root).toBe("C");
    expect(reading.quality).toBe("maj");
    expect(reading.chordName).toBe("C");
    expect(reading.isConfident).toBe(true);
  });

  it("names a minor triad, because that is the whole question", () => {
    const reading = interpreter.interpret(evidence([9, 0, 4], 9), [activation(45)]);
    expect(reading.root).toBe("A");
    expect(reading.quality).toBe("min");
    expect(reading.chordName).toBe("Am");
  });

  it("reports the intervals it believes are sounding", () => {
    const reading = interpreter.interpret(evidence([0, 4, 7], 0), [activation(48)]);
    expect(reading.intervals).toEqual(["1", "3", "5"]);
  });
});

describe("power chords", () => {
  it("calls a root and a fifth a power chord, not an impoverished major", () => {
    // "C5" is not a C major missing its third; it is a deliberate absence, and
    // calling it C would be a claim about the third the audio contradicts.
    const reading = interpreter.interpret(evidence([0, 7], 0), [activation(48), activation(55)]);
    expect(reading.chordName).toBe("C5");
    expect(reading.quality).toBe("5");
    expect(reading.intervals).toEqual(["1", "5"]);
  });

  it("uses the bass to pick which end of a fifth is the root", () => {
    // {C, G} is a perfect fifth, and a fifth has two roots depending on which
    // note is underneath. The template match cannot see that; the bass can.
    const asC = interpreter.interpret(evidence([0, 7], 0), [activation(48)]);
    const asG = interpreter.interpret(evidence([7, 2], 7), [activation(43)]);
    expect(asC.chordName).toBe("C5");
    expect(asG.chordName).toBe("G5");
  });
});

describe("inversions", () => {
  it("names a slash chord when the bass is a chord tone other than the root", () => {
    // A template match is inversion-blind: C/G and C are the same pitch-class
    // set. Only the bass separates them.
    const reading = interpreter.interpret(evidence([0, 4, 7], 7), [
      activation(43), activation(48), activation(52),
    ]);
    expect(reading.root).toBe("C");
    expect(reading.chordName).toBe("C/G");
  });

  it("leaves a root-position chord unslashed", () => {
    const reading = interpreter.interpret(evidence([0, 4, 7], 0), [
      activation(48), activation(52), activation(55),
    ]);
    expect(reading.chordName).toBe("C");
  });

  it("will not slash on a bass that is not in the chord", () => {
    // Far more likely the bass estimate is wrong than that the player put a
    // ninth in the bass, and "C/D" asserts a relationship nothing supports.
    const reading = interpreter.interpret(evidence([0, 4, 7], 0), [
      activation(50), activation(48), activation(52),
    ]);
    expect(reading.chordName).toBe("C");
  });
});

describe("abstention", () => {
  it("names nothing when nothing fits", () => {
    // A result, not a failure: the recognizer may say "I don't know", it may
    // not confidently say the wrong thing.
    const reading = interpreter.interpret(evidence([0, 1, 2, 3, 4, 5, 6], null), []);
    expect(reading.isConfident).toBe(false);
    expect(reading.chordName).toBeNull();
    expect(reading.root).toBeNull();
    expect(reading.quality).toBeNull();
  });

  it("still shows its work when it abstains", () => {
    const reading = interpreter.interpret(evidence([0, 1, 2, 3, 4, 5, 6], null), []);
    expect(reading.alternatives.length).toBeGreaterThan(0);
    expect(reading.alternatives[0]?.label).toBeTruthy();
  });

  it("says nothing at all about silence", () => {
    const reading = interpreter.interpret(evidence([], null), []);
    expect(reading.isConfident).toBe(false);
    expect(reading.chordName).toBeNull();
  });
});

describe("the bass", () => {
  it("prefers a measured fundamental over the chroma's own estimate", () => {
    const reading = interpreter.interpret(evidence([0, 4, 7], 0, 65.4), [
      activation(48), activation(52), activation(55),
    ]);
    expect(reading.bass?.midi).toBe(48);
    expect(reading.bass?.octave).toBe(3);
  });

  it("falls back to the chroma estimate when no fundamental agrees with it", () => {
    const reading = interpreter.interpret(evidence([0, 4, 7], 7, 98), []);
    expect(reading.bass?.pitchClass).toBe("G");
  });
});
