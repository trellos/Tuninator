/**
 * The chord dictionary and the margin rule.
 *
 * These are unit tests over hand-built chroma vectors: `matchChord`'s contract
 * is "12 bins in, ranked candidates out", and stating the input by hand makes
 * the assertions say what they mean. The end-to-end path — synthesized guitar
 * through `ChromaAnalyzer` and into here — is covered in `chroma.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  CHORD_TEMPLATES,
  DEFAULT_CHORD_FLOOR,
  DEFAULT_CHORD_MARGIN,
  matchChord,
  type ChordQuality,
} from "../src/core/chords.js";

const QUALITIES: ChordQuality[] = [
  "5", "maj", "min", "7", "m7", "maj7", "maj9", "m11", "sus2", "sus4",
];

const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const [C, CS, D, DS, E, F, FS, G, GS, A, AS, B] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** A chroma with the given pitch classes present, each at the given weight. */
function chromaOf(entries: Record<number, number>): Float32Array {
  const chroma = new Float32Array(12);
  for (const [index, value] of Object.entries(entries)) chroma[Number(index)] = value;
  return chroma;
}

/** The semitone offsets a quality's template gives a non-zero weight. */
function intervalsOf(quality: ChordQuality): number[] {
  const template = CHORD_TEMPLATES[quality];
  const intervals: number[] = [];
  for (let i = 0; i < 12; i++) if ((template[i] ?? 0) > 0) intervals.push(i);
  return intervals;
}

/** A template rotated to `root`, used as an idealised chroma for that chord. */
function idealChroma(quality: ChordQuality, root: number): Float32Array {
  const template = CHORD_TEMPLATES[quality];
  const chroma = new Float32Array(12);
  for (let i = 0; i < 12; i++) chroma[(i + root) % 12] = template[i] ?? 0;
  return chroma;
}

/* -------------------------------------------------------------------------- */

describe("CHORD_TEMPLATES", () => {
  it("defines all ten declared qualities as 12-element templates", () => {
    expect(Object.keys(CHORD_TEMPLATES).sort()).toEqual([...QUALITIES].sort());
    for (const quality of QUALITIES) {
      expect(CHORD_TEMPLATES[quality]).toHaveLength(12);
    }
  });

  it("puts the heaviest weight on the root and keeps every weight in 0..1", () => {
    for (const quality of QUALITIES) {
      const template = CHORD_TEMPLATES[quality];
      for (const weight of template) {
        expect(weight).toBeGreaterThanOrEqual(0);
        expect(weight).toBeLessThanOrEqual(1);
      }
      const root = template[0]!;
      for (let i = 1; i < 12; i++) expect(template[i]!).toBeLessThanOrEqual(root);
      expect(root).toBeGreaterThan(0);
    }
  });

  it.each([
    ["5", [0, 7]],
    ["maj", [0, 4, 7]],
    ["min", [0, 3, 7]],
    ["7", [0, 4, 7, 10]],
    ["m7", [0, 3, 7, 10]],
    ["maj7", [0, 4, 7, 11]],
    ["maj9", [0, 2, 4, 7, 11]],
    ["m11", [0, 3, 5, 7, 10]],
    ["sus2", [0, 2, 7]],
    ["sus4", [0, 5, 7]],
  ] as Array<[ChordQuality, number[]]>)("spells %s correctly", (quality, intervals) => {
    expect(intervalsOf(quality)).toEqual(intervals);
  });

  it("gives the power chord no third at all, which is its whole identity", () => {
    const template = CHORD_TEMPLATES["5"];
    expect(template[3]).toBe(0); // minor third
    expect(template[4]).toBe(0); // major third
    expect(template[7]!).toBeGreaterThan(0);
  });

  it("weights extensions below the triad they colour", () => {
    for (const quality of ["7", "m7", "maj7", "maj9", "m11"] as ChordQuality[]) {
      const template = CHORD_TEMPLATES[quality];
      const fifth = template[7]!;
      for (const interval of intervalsOf(quality)) {
        if (interval === 0 || interval === 3 || interval === 4 || interval === 7) continue;
        expect(template[interval]!).toBeLessThan(fifth);
      }
    }
  });

  it("keeps shared chord tones weighted identically across qualities", () => {
    // The whole point: only the *extra* tone should move a score, so a missing
    // seventh costs `maj7` exactly the seventh's weight and nothing else.
    const major = CHORD_TEMPLATES.maj;
    for (const quality of ["7", "maj7", "maj9"] as ChordQuality[]) {
      expect(CHORD_TEMPLATES[quality][0]).toBe(major[0]);
      expect(CHORD_TEMPLATES[quality][4]).toBe(major[4]);
      expect(CHORD_TEMPLATES[quality][7]).toBe(major[7]);
    }
    const minor = CHORD_TEMPLATES.min;
    for (const quality of ["m7", "m11"] as ChordQuality[]) {
      expect(CHORD_TEMPLATES[quality][0]).toBe(minor[0]);
      expect(CHORD_TEMPLATES[quality][3]).toBe(minor[3]);
      expect(CHORD_TEMPLATES[quality][7]).toBe(minor[7]);
    }
  });
});

describe("matchChord scoring", () => {
  it.each(QUALITIES)("ranks %s first on its own idealised chroma", (quality) => {
    // Root D rather than C, so a rotation bug cannot pass by accident.
    const match = matchChord(idealChroma(quality, D));
    expect(match.best?.quality).toBe(quality);
    expect(match.best?.root).toBe("D");
    expect(match.best?.score).toBeCloseTo(1, 5);
  });

  it("scores every candidate in 0..1 and sorts them descending", () => {
    const match = matchChord(chromaOf({ [C]: 1, [E]: 0.9, [G]: 0.85 }));
    const all = [match.best!, ...match.alternatives];
    for (const candidate of all) {
      expect(candidate.score).toBeGreaterThanOrEqual(0);
      expect(candidate.score).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.score).toBeLessThanOrEqual(all[i - 1]!.score);
    }
  });

  it("renders labels the way the fixtures spell them", () => {
    expect(matchChord(idealChroma("5", C)).best?.label).toBe("C5");
    expect(matchChord(idealChroma("maj", G)).best?.label).toBe("G");
    expect(matchChord(idealChroma("min", E)).best?.label).toBe("Em");
    expect(matchChord(idealChroma("min", A)).best?.label).toBe("Am");
    expect(matchChord(idealChroma("maj9", C)).best?.label).toBe("Cmaj9");
    expect(matchChord(idealChroma("m11", A)).best?.label).toBe("Am11");
    expect(matchChord(idealChroma("maj", FS)).best?.label).toBe("F#");
  });

  it("scores every root, not just the twelve labels it returns", () => {
    for (let root = 0; root < 12; root++) {
      const match = matchChord(idealChroma("5", root));
      expect(match.best?.root).toBe(PITCH_CLASSES[root]);
      expect(match.best?.quality).toBe("5");
    }
  });

  it("prefers the power chord over the triad when there is no third", () => {
    const match = matchChord(chromaOf({ [C]: 1, [G]: 0.85 }));
    expect(match.best?.quality).toBe("5");
    const major = match.alternatives.find((c) => c.label === "C");
    expect(major).toBeDefined();
    expect(match.best!.score - major!.score).toBeGreaterThan(DEFAULT_CHORD_MARGIN);
  });

  it("prefers the triad over the power chord once the third is there", () => {
    const match = matchChord(chromaOf({ [C]: 1, [E]: 0.85, [G]: 0.8 }));
    expect(match.best?.quality).toBe("maj");
    expect(match.isConfident).toBe(true);
  });

  it("hears the difference between a major and a minor third", () => {
    expect(matchChord(chromaOf({ [A]: 1, [C]: 0.85, [E]: 0.8 })).best?.label).toBe("Am");
    expect(matchChord(chromaOf({ [A]: 1, [CS]: 0.85, [E]: 0.8 })).best?.label).toBe("A");
  });
});

describe("bass weighting", () => {
  // C E G A is C6 and Am7 at the same time. Only the bass separates them.
  const ambiguous = chromaOf({ [C]: 1, [E]: 0.9, [G]: 0.85, [A]: 0.8 });

  it("picks the root the bass points at", () => {
    expect(matchChord(ambiguous, { bassPitchClass: C }).best?.root).toBe("C");
    expect(matchChord(ambiguous, { bassPitchClass: A }).best?.root).toBe("A");
  });

  it("lifts a root that agrees with the bass and lowers one that does not", () => {
    const neutral = matchChord(ambiguous);
    const withA = matchChord(ambiguous, { bassPitchClass: A });
    const rootedOnA = (match: ReturnType<typeof matchChord>) =>
      [match.best!, ...match.alternatives].find((c) => c.root === "A")!.score;
    expect(rootedOnA(withA)).toBeGreaterThan(rootedOnA(neutral));
  });

  it("separates a C-rooted from a G-rooted reading when the chroma cannot", () => {
    // A strummed C5 leaks D from G3's third harmonic, so the chroma holds C, G
    // and D — a set that belongs to C and to G equally, and the bass is the
    // only thing that says which. (With the D present the best C-rooted fit is
    // Csus2 rather than C5; that is the chroma being honest about the leakage.)
    const leaky = chromaOf({ [C]: 1, [G]: 0.95, [D]: 0.6 });
    expect(matchChord(leaky, { bassPitchClass: C }).best?.root).toBe("C");
    expect(matchChord(leaky, { bassPitchClass: G }).best?.root).toBe("G");
  });

  it("keeps scores inside 0..1 with the bass bonus applied", () => {
    const match = matchChord(idealChroma("maj", C), { bassPitchClass: C });
    for (const candidate of [match.best!, ...match.alternatives]) {
      expect(candidate.score).toBeGreaterThanOrEqual(0);
      expect(candidate.score).toBeLessThanOrEqual(1);
    }
  });

  it("ignores a null or absent bass identically", () => {
    const withNull = matchChord(ambiguous, { bassPitchClass: null });
    const without = matchChord(ambiguous);
    expect(withNull.best).toEqual(without.best);
  });

  it("wraps an out-of-range bass index onto a pitch class", () => {
    expect(matchChord(ambiguous, { bassPitchClass: 21 }).best?.root).toBe("A");
    expect(matchChord(ambiguous, { bassPitchClass: -3 }).best?.root).toBe("A");
  });
});

describe("the margin rule", () => {
  it("uses the documented defaults", () => {
    // These match policy.chords.floor and policy.chords.margin.
    expect(DEFAULT_CHORD_FLOOR).toBe(0.55);
    expect(DEFAULT_CHORD_MARGIN).toBe(0.08);
  });

  it("abstains when the top two are too close, even with a strong top score", () => {
    const flat = new Float32Array(12).fill(1);
    const match = matchChord(flat);
    expect(match.margin).toBeLessThan(DEFAULT_CHORD_MARGIN);
    expect(match.isConfident).toBe(false);
    expect(match.best).not.toBeNull();
    expect(match.alternatives.length).toBeGreaterThan(0);
  });

  it("abstains when the best score is under the floor", () => {
    const chroma = chromaOf({ [C]: 1, [E]: 0.85, [G]: 0.8 });
    // Raising the floor above what a perfect major triad scores must abstain.
    expect(matchChord(chroma).isConfident).toBe(true);
    expect(matchChord(chroma, { floor: 0.999 }).isConfident).toBe(false);
  });

  /*
   * Worth recording: with a cosine against this dictionary, the floor almost
   * never bites. Every template overlaps every chroma somewhat, so even
   * deliberately anti-tonal input scores 0.62-0.71 — above the 0.55 floor. It
   * is the *margin* that does essentially all of the abstaining in practice,
   * which is why the margin is the rule the design leans on.
   */
  it("records that hostile input still clears the floor, and the margin catches it", () => {
    const hostile: Array<[string, Float32Array]> = [
      ["tritone", chromaOf({ [C]: 1, [FS]: 1 })],
      ["diminished seventh", chromaOf({ [C]: 1, [DS]: 1, [FS]: 1, [A]: 1 })],
      ["whole-tone scale", chromaOf({ [C]: 1, [D]: 1, [E]: 1, [FS]: 1, [GS]: 1, [AS]: 1 })],
      ["all twelve equal", new Float32Array(12).fill(1)],
    ];
    for (const [, chroma] of hostile) {
      const match = matchChord(chroma);
      expect(match.best!.score).toBeGreaterThan(DEFAULT_CHORD_FLOOR);
      expect(match.isConfident).toBe(false);
      expect(match.margin).toBeLessThan(DEFAULT_CHORD_MARGIN);
    }
  });

  it("is confident when the best clears both the floor and the margin", () => {
    const match = matchChord(idealChroma("5", C));
    expect(match.best!.score).toBeGreaterThanOrEqual(DEFAULT_CHORD_FLOOR);
    expect(match.margin).toBeGreaterThanOrEqual(DEFAULT_CHORD_MARGIN);
    expect(match.isConfident).toBe(true);
  });

  it("honours a caller-supplied floor and margin", () => {
    const chroma = chromaOf({ [C]: 1, [E]: 0.85, [G]: 0.8 });
    expect(matchChord(chroma, { floor: 0.999 }).isConfident).toBe(false);
    expect(matchChord(chroma, { margin: 0.9 }).isConfident).toBe(false);
    expect(matchChord(chroma, { floor: 0.1, margin: 0.001 }).isConfident).toBe(true);
  });

  it("reports the gap between the top two as `margin`", () => {
    const match = matchChord(chromaOf({ [C]: 1, [E]: 0.85, [G]: 0.8 }));
    expect(match.margin).toBeCloseTo(match.best!.score - match.alternatives[0]!.score, 10);
  });

  it("always populates `best`, confident or not", () => {
    for (const chroma of [
      idealChroma("maj", C),
      new Float32Array(12).fill(1),
      chromaOf({ [C]: 1, [FS]: 1 }),
      chromaOf({ [C]: 0.01 }),
    ]) {
      expect(matchChord(chroma).best).not.toBeNull();
    }
  });

  it("lists alternatives most confident first, excluding `best`", () => {
    const match = matchChord(chromaOf({ [C]: 1, [E]: 0.9, [G]: 0.85 }));
    expect(match.alternatives.length).toBeGreaterThan(0);
    for (const alternative of match.alternatives) {
      expect(alternative.label).not.toBe(match.best!.label);
      expect(alternative.score).toBeLessThanOrEqual(match.best!.score);
    }
  });
});

describe("degenerate input", () => {
  it("returns nothing at all for an all-zero chroma", () => {
    const match = matchChord(new Float32Array(12));
    expect(match.best).toBeNull();
    expect(match.alternatives).toEqual([]);
    expect(match.isConfident).toBe(false);
    expect(match.margin).toBe(0);
  });

  it("rejects a chroma that is not 12 bins", () => {
    expect(() => matchChord(new Float32Array(11))).toThrow(/12 bins/);
    expect(() => matchChord(new Float32Array(24))).toThrow(/12 bins/);
  });

  it("is unaffected by the overall level of the chroma", () => {
    const quiet = chromaOf({ [C]: 0.02, [E]: 0.017, [G]: 0.016 });
    const loud = chromaOf({ [C]: 1, [E]: 0.85, [G]: 0.8 });
    expect(matchChord(quiet).best?.label).toBe(matchChord(loud).best?.label);
    expect(matchChord(quiet).best?.score).toBeCloseTo(matchChord(loud).best!.score, 4);
  });

  it("does not mutate the chroma it was handed", () => {
    const chroma = chromaOf({ [C]: 1, [E]: 0.85, [G]: 0.8 });
    const before = [...chroma];
    matchChord(chroma, { bassPitchClass: C });
    expect([...chroma]).toEqual(before);
  });
});

describe("what the dictionary cannot separate", () => {
  /*
   * Recorded, not aspirational.
   *
   * Given all five tones of a Cmaj9 in clean proportion, the dictionary does
   * resolve it. That is not the case a guitar presents.
   */
  it("resolves a clean, complete Cmaj9 chroma", () => {
    const clean = chromaOf({ [C]: 0.8, [E]: 1, [G]: 0.7, [B]: 0.85, [D]: 0.8 });
    const match = matchChord(clean);
    expect(match.best?.label).toBe("Cmaj9");
    expect(match.isConfident).toBe(true);
  });

  /*
   * What the guitar actually presents. The x32430 voicing is C3 E3 B3 D4 E4: E
   * twice, no G at all, and a C3 so quiet the analyser often loses it. These are
   * the chroma values measured off the synthesized voicing — root absent, fifth
   * absent. Without the bass the top candidate is E5, and the field is packed
   * inside a hundredth of a point, so the answer is `unknown`. That is correct:
   * with no C and no G in the chroma there is no evidence for C being the root.
   */
  it("abstains on the chroma a real Cmaj9 voicing actually produces", () => {
    const asPlayed = chromaOf({ [E]: 1, [B]: 0.93, [D]: 0.84 });
    const match = matchChord(asPlayed);
    expect(match.isConfident).toBe(false);
    expect(match.margin).toBeLessThan(DEFAULT_CHORD_MARGIN);
    expect(match.alternatives.length).toBeGreaterThan(0);
  });

  it("moves that same chroma to Cmaj9 on the bass alone, but still abstains", () => {
    const asPlayed = chromaOf({ [E]: 1, [B]: 0.93, [D]: 0.84 });
    const match = matchChord(asPlayed, { bassPitchClass: C });
    expect(match.best?.label).toBe("Cmaj9");
    // Right answer, not enough evidence to say so. The caller emits "unknown".
    expect(match.isConfident).toBe(false);
  });

  /*
   * Am11 is A C D E G — the same five pitch classes as C6/9, which the
   * dictionary does not contain. The bass is a thumb on the scale, not an
   * override: it lifts every candidate rooted on the bass note by a flat
   * amount, and if the chroma disagrees strongly enough, the chroma still wins.
   */
  it("lets the bass nudge the root without overriding the chroma", () => {
    const set = chromaOf({ [A]: 1, [C]: 0.9, [D]: 0.85, [E]: 0.95, [G]: 0.8 });
    expect(matchChord(set, { bassPitchClass: A }).best?.root).toBe("A");

    // A bass of D lifts the D-rooted candidates, but A is too strong to unseat.
    const withD = matchChord(set, { bassPitchClass: D });
    expect(withD.best?.root).toBe("A");
    const dRooted = (match: ReturnType<typeof matchChord>) =>
      [match.best!, ...match.alternatives].filter((c) => c.root === "D").length;
    expect(dRooted(withD)).toBeGreaterThan(dRooted(matchChord(set)));
    // Disagreement between bass and chroma costs confidence, which is the point.
    expect(withD.isConfident).toBe(false);
  });
});
