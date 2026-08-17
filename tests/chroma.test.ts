/**
 * `ChromaAnalyzer` against synthesized guitar-like input.
 *
 * Test signals are harmonic stacks, never pure sines: a fundamental plus five
 * partials with 1/n-ish decay, a pluck envelope, per-string strum offsets and a
 * little noise. Pure sines would leave the whitening and cancellation stages
 * with nothing to do, and every one of the bugs found while building this
 * module lived in how overtones interact.
 */

import { describe, expect, it } from "vitest";
import { ChromaAnalyzer } from "../src/core/chroma.js";
import { matchChord } from "../src/core/chords.js";

const SAMPLE_RATE = 48000;
const FFT_SIZE = 4096; // policy.chords.fftSize

const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/* -------------------------------------------------------------------------- */
/* Synthesis                                                                   */
/* -------------------------------------------------------------------------- */

function noteHz(name: string): number {
  const match = /^([A-G])(#|b)?(-?\d+)$/.exec(name);
  if (!match) throw new Error(`bad note name: ${name}`);
  let pitchClass = PITCH_CLASSES.indexOf(match[1]!);
  if (match[2] === "#") pitchClass += 1;
  if (match[2] === "b") pitchClass -= 1;
  const octave = Number(match[3]);
  const midi = (octave + 1) * 12 + (((pitchClass % 12) + 12) % 12);
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function pitchClassOf(name: string): number {
  const match = /^([A-G])(#|b)?(-?\d+)$/.exec(name);
  if (!match) throw new Error(`bad note name: ${name}`);
  let pitchClass = PITCH_CLASSES.indexOf(match[1]!);
  if (match[2] === "#") pitchClass += 1;
  if (match[2] === "b") pitchClass -= 1;
  return ((pitchClass % 12) + 12) % 12;
}

/** Deterministic LCG, so a failing test fails the same way twice. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

type StrumOptions = {
  harmonics?: number;
  /** Amplitude of harmonic n is 1/n^rolloff. */
  harmonicRolloff?: number;
  /** Delay between consecutive strings, milliseconds. */
  strumMs?: number;
  decaySeconds?: number;
  noiseLevel?: number;
  /** Seconds elapsed since the attack at the start of the window. */
  offsetSeconds?: number;
  seed?: number;
};

/**
 * One strummed chord: each note is a fundamental plus harmonics with 1/n
 * amplitudes, higher partials decaying faster, as a real string does.
 */
function strum(notes: string[], options: StrumOptions = {}): Float32Array {
  const {
    harmonics = 6,
    harmonicRolloff = 1.1,
    strumMs = 14,
    decaySeconds = 2.2,
    noiseLevel = 0.004,
    offsetSeconds = 0.08,
    seed = 9001,
  } = options;

  const random = makeRandom(seed);
  const out = new Float32Array(FFT_SIZE);

  notes.forEach((note, index) => {
    const fundamental = noteHz(note);
    const start = offsetSeconds + (index * strumMs) / 1000;
    const stringGain = 0.8 + 0.4 * random();

    for (let h = 1; h <= harmonics; h++) {
      // Real strings are slightly inharmonic; partials creep sharp.
      const frequency = fundamental * h * (1 + 0.0004 * (h * h - 1));
      if (frequency > SAMPLE_RATE * 0.45) break;
      const amplitude = (stringGain / Math.pow(h, harmonicRolloff)) * (0.85 + 0.3 * random());
      const phase = random() * Math.PI * 2;
      const decay = Math.pow(h, 0.6) / decaySeconds;
      const omega = 2 * Math.PI * frequency;

      for (let i = 0; i < FFT_SIZE; i++) {
        const t = start + i / SAMPLE_RATE;
        const envelope = Math.exp(-decay * t) * (1 - Math.exp(-t / 0.004));
        out[i] = out[i]! + amplitude * envelope * Math.sin(omega * t + phase);
      }
    }
  });

  let peak = 0;
  for (let i = 0; i < FFT_SIZE; i++) peak = Math.max(peak, Math.abs(out[i]!));
  if (peak > 0) for (let i = 0; i < FFT_SIZE; i++) out[i] = (out[i]! / peak) * 0.7;
  for (let i = 0; i < FFT_SIZE; i++) out[i] = out[i]! + (random() * 2 - 1) * noiseLevel;
  return out;
}

function whiteNoise(level = 0.25, seed = 4242): Float32Array {
  const random = makeRandom(seed);
  const out = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) out[i] = (random() * 2 - 1) * level;
  return out;
}

function analyzer(): ChromaAnalyzer {
  return new ChromaAnalyzer({ sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE });
}

/** Pitch class indices ordered by chroma weight, strongest first. */
function rankedPitchClasses(chroma: Float32Array): number[] {
  return [...chroma]
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value)
    .map((entry) => entry.index);
}

/* -------------------------------------------------------------------------- */

describe("ChromaAnalyzer construction", () => {
  it("reports the window size it expects", () => {
    expect(analyzer().windowSize).toBe(FFT_SIZE);
  });

  it("rejects a window of the wrong length", () => {
    expect(() => analyzer().analyze(new Float32Array(2048))).toThrow(/4096/);
  });

  it("rejects a non-positive sample rate", () => {
    expect(() => new ChromaAnalyzer({ sampleRate: 0, fftSize: FFT_SIZE })).toThrow(/sampleRate/);
  });

  it("rejects a frequency range that is inside out", () => {
    expect(
      () =>
        new ChromaAnalyzer({
          sampleRate: SAMPLE_RATE,
          fftSize: FFT_SIZE,
          minFrequencyHz: 900,
          maxFrequencyHz: 400,
        })
    ).toThrow(/must exceed/);
  });

  it("works at other sample rates and transform sizes", () => {
    const other = new ChromaAnalyzer({ sampleRate: 44100, fftSize: 8192 });
    expect(other.windowSize).toBe(8192);
    const window = new Float32Array(8192);
    for (let i = 0; i < 8192; i++) {
      // A2 plus four harmonics.
      for (let h = 1; h <= 4; h++) {
        window[i] = window[i]! + (0.4 / h) * Math.sin((2 * Math.PI * 110 * h * i) / 44100);
      }
    }
    expect(other.analyze(window).bassPitchClass).toBe(pitchClassOf("A2"));
  });
});

describe("silence", () => {
  it("returns an all-zero chroma and no bass", () => {
    const result = analyzer().analyze(new Float32Array(FFT_SIZE));
    expect([...result.chroma]).toEqual(new Array(12).fill(0));
    expect(result.bassPitchClass).toBeNull();
    expect(result.bassFrequencyHz).toBeNull();
    expect(result.salience).toBe(0);
    expect(result.polyphony).toBe(0);
  });

  it("treats a signal below the silence floor as silent", () => {
    const window = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      window[i] = 1e-9 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
    }
    const result = analyzer().analyze(window);
    expect(Math.max(...result.chroma)).toBe(0);
    expect(result.bassPitchClass).toBeNull();
  });
});

describe("chroma of a C major triad", () => {
  const chords = analyzer().analyze(strum(["C3", "E3", "G3", "C4", "E4"]));

  it("peaks on C, E and G", () => {
    const top3 = rankedPitchClasses(chords.chroma).slice(0, 3).sort((a, b) => a - b);
    expect(top3).toEqual([
      pitchClassOf("C3"),
      pitchClassOf("E3"),
      pitchClassOf("G3"),
    ]);
  });

  it("leaves every non-chord tone below every chord tone", () => {
    const chordTones = new Set([0, 4, 7]);
    let weakestChordTone = Infinity;
    let strongestOther = 0;
    for (let i = 0; i < 12; i++) {
      if (chordTones.has(i)) weakestChordTone = Math.min(weakestChordTone, chords.chroma[i]!);
      else strongestOther = Math.max(strongestOther, chords.chroma[i]!);
    }
    expect(strongestOther).toBeLessThan(weakestChordTone);
  });

  it("normalises so the maximum is exactly 1 and nothing is negative", () => {
    expect(Math.max(...chords.chroma)).toBeCloseTo(1, 6);
    for (const value of chords.chroma) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("estimates a polyphony consistent with a triad", () => {
    expect(chords.polyphony).toBeGreaterThanOrEqual(3);
    expect(chords.polyphony).toBeLessThanOrEqual(6);
  });

  it("is deterministic", () => {
    const again = analyzer().analyze(strum(["C3", "E3", "G3", "C4", "E4"]));
    expect([...again.chroma]).toEqual([...chords.chroma]);
    expect(again.bassPitchClass).toBe(chords.bassPitchClass);
  });
});

describe("harmonic whitening", () => {
  /*
   * The point of whitening: a single note's overtones must not read as chord
   * tones. A lone C3 has G4 as its third harmonic and E5 as its fifth, so an
   * un-whitened, un-cancelled fold reports a C major triad for one plucked
   * string.
   */
  it("does not invent a triad out of one note's overtones", () => {
    const result = analyzer().analyze(strum(["C3"], { harmonics: 6 }));
    const c = pitchClassOf("C3");
    const e = pitchClassOf("E3");
    const g = pitchClassOf("G3");
    expect(rankedPitchClasses(result.chroma)[0]).toBe(c);
    expect(result.chroma[e]!).toBeLessThan(0.5);
    expect(result.chroma[g]!).toBeLessThan(0.5);
  });

  it("finds a quiet fundamental under loud overtones", () => {
    // Harmonics louder than the fundamental, as on a bridge-pickup electric.
    const bright = strum(["A2", "E3", "A3"], { harmonicRolloff: 0.35, harmonics: 6 });
    const result = analyzer().analyze(bright);
    expect(result.bassPitchClass).toBe(pitchClassOf("A2"));
  });
});

describe("salience", () => {
  it("is high for a strummed chord and low for white noise", () => {
    const chord = analyzer().analyze(strum(["E2", "B2", "E3", "G3", "B3", "E4"]));
    const noise = analyzer().analyze(whiteNoise());
    expect(chord.salience).toBeGreaterThan(0.6);
    expect(noise.salience).toBeLessThan(0.3);
    expect(noise.salience).toBeGreaterThanOrEqual(0);
  });
});

describe("bass detection", () => {
  const cases: Array<[string, string[]]> = [
    ["C3", ["C3", "G3", "C4"]],
    ["A2", ["A2", "E3", "A3"]],
    ["G2", ["G2", "D3", "G3"]],
    ["E2", ["E2", "B2", "E3"]],
    ["D3", ["D3", "A3", "D4"]],
    ["F#2", ["F#2", "C#3", "F#3"]],
    ["C3", ["C3", "E3", "G3", "C4", "E4"]],
    ["E2", ["E2", "B2", "E3", "G3", "B3", "E4"]],
    ["G2", ["G2", "B2", "D3", "G3", "B3", "G4"]],
    ["A2", ["A2", "E3", "A3", "C4", "E4"]],
  ];

  for (const [expected, notes] of cases) {
    it(`hears ${expected} under ${notes.join(" ")}`, () => {
      const result = analyzer().analyze(strum(notes));
      expect(result.bassPitchClass).toBe(pitchClassOf(expected));
      expect(result.bassFrequencyHz).not.toBeNull();
      // Within a semitone of the note actually played.
      const ratio = result.bassFrequencyHz! / noteHz(expected);
      expect(Math.abs(1200 * Math.log2(ratio))).toBeLessThan(100);
    });
  }

  it("reports the lowest note, not the loudest", () => {
    // G3 and its overtones dominate; C3 is the quietest string but the bass.
    const result = analyzer().analyze(
      strum(["C3", "G3", "C4"], { harmonicRolloff: 0.8 })
    );
    expect(result.bassPitchClass).toBe(pitchClassOf("C3"));
  });
});

describe("end to end: chroma into matchChord", () => {
  function detect(notes: string[], options: StrumOptions = {}) {
    const result = analyzer().analyze(strum(notes, options));
    return { result, match: matchChord(result.chroma, { bassPitchClass: result.bassPitchClass }) };
  }

  it("calls C5 a power chord, not a C major triad", () => {
    const { match } = detect(["C3", "G3", "C4"]);
    expect(match.isConfident).toBe(true);
    expect(match.best?.root).toBe("C");
    expect(match.best?.quality).toBe("5");
    expect(match.best?.label).toBe("C5");

    // The third is what a power chord does not have, so `maj` must lose, and
    // lose by more than the margin rule needs.
    const major = [match.best!, ...match.alternatives].find((c) => c.quality === "maj");
    expect(major).toBeDefined();
    expect(major!.score).toBeLessThan(match.best!.score - 0.08);
  });

  it("calls a full C major voicing a major triad", () => {
    const { match } = detect(["C3", "E3", "G3", "C4", "E4"]);
    expect(match.isConfident).toBe(true);
    expect(match.best?.label).toBe("C");
    expect(match.best?.quality).toBe("maj");
  });

  it.each([
    ["C5", ["C3", "G3", "C4"]],
    ["A5", ["A2", "E3", "A3"]],
    ["G5", ["G2", "D3", "G3"]],
    ["E5", ["E2", "B2", "E3"]],
    ["D5", ["D3", "A3", "D4"]],
    ["F#5", ["F#2", "C#3", "F#3"]],
  ])("detects the %s power chord", (label, notes) => {
    const { match } = detect(notes as string[]);
    expect(match.best?.label).toBe(label);
    expect(match.isConfident).toBe(true);
  });

  it.each([
    ["C", ["C3", "E3", "G3", "C4", "E4"]],
    ["D", ["D3", "A3", "D4", "F#4"]],
    ["Em", ["E2", "B2", "E3", "G3", "B3", "E4"]],
    ["G", ["G2", "B2", "D3", "G3", "B3", "G4"]],
    ["Am", ["A2", "E3", "A3", "C4", "E4"]],
  ])("detects the open %s voicing", (label, notes) => {
    const { match } = detect(notes as string[]);
    expect(match.best?.label).toBe(label);
    expect(match.isConfident).toBe(true);
  });

  /*
   * Whitening flattens the spectral envelope, so it flatters noise too: without
   * the tonality gate, a hiss offers enough peaks to elect six "fundamentals"
   * and this came out as a confident D#maj9.
   */
  it("reads no chroma at all out of white noise", () => {
    const result = analyzer().analyze(whiteNoise());
    expect(Math.max(...result.chroma)).toBe(0);
    expect(result.bassPitchClass).toBeNull();
    expect(result.polyphony).toBe(0);
    expect(result.salience).toBeLessThan(0.22);

    const match = matchChord(result.chroma, { bassPitchClass: result.bassPitchClass });
    expect(match.isConfident).toBe(false);
    expect(match.best).toBeNull();
  });

  it("still hears the chord through heavy added noise", () => {
    const chord = strum(["C3", "E3", "G3", "C4", "E4"]);
    const hiss = whiteNoise(0.35, 77);
    const mixed = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) mixed[i] = chord[i]! + hiss[i]!;

    const result = analyzer().analyze(mixed);
    const match = matchChord(result.chroma, { bassPitchClass: result.bassPitchClass });
    expect(result.salience).toBeGreaterThan(0.22);
    expect(match.best?.label).toBe("C");
    expect(match.isConfident).toBe(true);
  });

  /*
   * A diminished seventh is symmetric: every note can be the root, and the
   * dictionary has no entry for it. There is no right answer, so the margin
   * rule must refuse to pick one — while still handing the caller the
   * candidates it was choosing between.
   */
  it("abstains on an ambiguous chord and still offers alternatives", () => {
    const result = analyzer().analyze(strum(["C3", "D#3", "F#3", "A3"]));
    const match = matchChord(result.chroma, { bassPitchClass: result.bassPitchClass });
    expect(result.salience).toBeGreaterThan(0.22);
    expect(match.isConfident).toBe(false);
    expect(match.margin).toBeLessThan(0.08);
    expect(match.best).not.toBeNull();
    expect(match.alternatives.length).toBeGreaterThan(0);
  });

  /*
   * Documented, not aspirational.
   *
   * Cmaj9 (C E G B D) contains Em, G and C; the voicing x32430 plays E twice and
   * never sounds G at all. What comes out is Cmaj9 ranked first — the bass note
   * is doing that work — but too close to its neighbours to clear the margin, so
   * the caller emits "unknown". That is the honest answer for this chord on a
   * strummed guitar, and this test exists to record it rather than to wish
   * otherwise. If a future change makes it confident, check it is confident for
   * a real reason before updating the assertion.
   */
  it("ranks Cmaj9 first but abstains: the extensions are too close to call", () => {
    const { match } = detect(["C3", "E3", "B3", "D4", "E4"]);
    expect(match.best?.label).toBe("Cmaj9");
    expect(match.isConfident).toBe(false);
    expect(match.margin).toBeLessThan(0.08);
    expect(match.alternatives.length).toBeGreaterThan(0);
  });

  /*
   * Am11 (A C D E G) is the same pitch-class set as C6/9. Only the bass tells
   * them apart, and here the bass is heard correctly, so this one does come out
   * confident. It is the exception, not the rule — see the fixture measurements
   * in the report: on the real recording Am11 lands on unknown 91% of the time.
   */
  it("detects Am11 on a clean take, on the strength of the bass", () => {
    const { result, match } = detect(["A2", "G3", "C4", "D4", "E4"]);
    expect(result.bassPitchClass).toBe(pitchClassOf("A2"));
    expect(match.best?.label).toBe("Am11");
    expect(match.isConfident).toBe(true);
  });

  it("loses Am11 without the bass, which is what makes the bass critical", () => {
    const result = analyzer().analyze(strum(["A2", "G3", "C4", "D4", "E4"]));
    const withBass = matchChord(result.chroma, { bassPitchClass: result.bassPitchClass });
    const withoutBass = matchChord(result.chroma, { bassPitchClass: null });
    expect(withBass.best!.score).toBeGreaterThan(withoutBass.best!.score);
  });
});
