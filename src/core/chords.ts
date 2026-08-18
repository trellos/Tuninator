/**
 * Chord dictionary, template matching, and the honest-abstention rule.
 *
 * The margin rule is the product guarantee: when the top two candidates are too
 * close, or the best score is too low, this reports `unknown` with the
 * candidates in `alternatives` rather than a confident wrong label.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the chord
 * workstream.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import type { PitchClass } from "../types.js";

/** Chord qualities in the dictionary, as they appear in `label.quality`. */
export type ChordQuality =
  | "5" | "maj" | "min" | "7" | "m7" | "maj7" | "maj9" | "m11" | "sus2" | "sus4";

export type ChordCandidate = {
  /** Rendered label, e.g. "C5", "Am7", "Cmaj9". */
  label: string;
  root: PitchClass;
  quality: ChordQuality;
  /** Normalised template match score, 0..1. */
  score: number;
};

export type ChordMatchOptions = {
  /** Minimum score(top1) - score(top2) for confidence. Default 0.08. */
  margin?: number;
  /** Minimum score(top1) for confidence. Default 0.55. */
  floor?: number;
  /** Pitch-class index (0 = C) of the detected bass, for root disambiguation. */
  bassPitchClass?: number | null;
};

export type ChordMatch = {
  /** Best candidate by score, even when `isConfident` is false. */
  best: ChordCandidate | null;
  /** Runner-ups, most confident first, excluding `best`. */
  alternatives: ChordCandidate[];
  /**
   * False means the caller must emit `label.name: "unknown"` and surface
   * `alternatives` in `ambiguity.alternatives`.
   */
  isConfident: boolean;
  /** score(top1) - score(top2). Zero when fewer than two candidates. */
  margin: number;
};

/*
 * Template weights, in descending order of importance.
 *
 * Scoring is a cosine, so a weight is symmetric: a tone that is *present* in the
 * chroma earns a candidate that much, and a tone that is *missing* costs it that
 * much through the template's norm. That symmetry is what actually separates
 * "C" from "Cmaj7" on a chroma with no B in it, so the shared tones are
 * deliberately identical across qualities — only the extra tone moves.
 */
const W_ROOT = 1;
const W_THIRD = 0.95;
const W_FIFTH = 0.8;
const W_SEVENTH = 0.75;
/** Ninths and elevenths: real chord tones, but the last ones a player drops. */
const W_EXTENSION = 0.7;
/** A power chord's fifth carries more, because it is all there is. */
const W_POWER_FIFTH = 0.8;
const W_SUS_TONE = 0.8;
const W_SUS_FIFTH = 0.85;

/**
 * Weighted pitch-class templates, one entry per quality.
 *
 * Index is semitones above the root, so index 0 is always the root. The "5"
 * template is deliberately bare: a power chord has no third, and that absence
 * is the whole identity.
 */
export const CHORD_TEMPLATES: Readonly<Record<ChordQuality, readonly number[]>> = {
  //      1        b2  2             b3       3        4             b5  5              #5  6  b7           7
  "5":   [W_ROOT,  0,  0,            0,       0,       0,            0,  W_POWER_FIFTH, 0,  0, 0,           0          ],
  maj:   [W_ROOT,  0,  0,            0,       W_THIRD, 0,            0,  W_FIFTH,       0,  0, 0,           0          ],
  min:   [W_ROOT,  0,  0,            W_THIRD, 0,       0,            0,  W_FIFTH,       0,  0, 0,           0          ],
  "7":   [W_ROOT,  0,  0,            0,       W_THIRD, 0,            0,  W_FIFTH,       0,  0, W_SEVENTH,   0          ],
  m7:    [W_ROOT,  0,  0,            W_THIRD, 0,       0,            0,  W_FIFTH,       0,  0, W_SEVENTH,   0          ],
  maj7:  [W_ROOT,  0,  0,            0,       W_THIRD, 0,            0,  W_FIFTH,       0,  0, 0,           W_SEVENTH  ],
  maj9:  [W_ROOT,  0,  W_EXTENSION,  0,       W_THIRD, 0,            0,  W_FIFTH,       0,  0, 0,           W_SEVENTH  ],
  m11:   [W_ROOT,  0,  0,            W_THIRD, 0,       W_EXTENSION,  0,  W_FIFTH,       0,  0, W_SEVENTH,   0          ],
  sus2:  [W_ROOT,  0,  W_SUS_TONE,   0,       0,       0,            0,  W_SUS_FIFTH,   0,  0, 0,           0          ],
  sus4:  [W_ROOT,  0,  0,            0,       0,       W_SUS_TONE,   0,  W_SUS_FIFTH,   0,  0, 0,           0          ],
};

/** Sharp-spelled, indexed by pitch-class number. 0 = C. */
const PITCH_CLASS_NAMES: readonly PitchClass[] = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/** Rendered suffix per quality. `maj` renders bare ("C"), `min` as "m" ("Am"). */
const QUALITY_SUFFIX: Readonly<Record<ChordQuality, string>> = {
  "5": "5",
  maj: "",
  min: "m",
  "7": "7",
  m7: "m7",
  maj7: "maj7",
  maj9: "maj9",
  m11: "m11",
  sus2: "sus2",
  sus4: "sus4",
};

const QUALITIES: readonly ChordQuality[] = [
  "5", "maj", "min", "7", "m7", "maj7", "maj9", "m11", "sus2", "sus4",
];

export const DEFAULT_CHORD_FLOOR = 0.55;
export const DEFAULT_CHORD_MARGIN = 0.08;

/**
 * How much a bass note agreeing with a candidate's root is worth.
 *
 * The score is `(cosine + BASS_WEIGHT * bassAgrees) / (1 + BASS_WEIGHT)`, which
 * keeps every score in 0..1 and gives a root that matches the detected bass a
 * flat 0.13 advantage over an identical-cosine rival. That is what separates
 * C5 from G5 and Am11 from C6/9, whose chroma sets overlap almost completely —
 * it is deliberately larger than the 0.08 default margin, because without it
 * those pairs can only ever be `unknown`.
 */
const BASS_WEIGHT = 0.15;

/**
 * Runner-ups kept in `alternatives`. All 120 candidates are scored, but the
 * tail is noise, and this result crosses the worklet port on every hop.
 */
const MAX_ALTERNATIVES = 5;

/** Precomputed template norms, so `matchChord` does no per-call allocation. */
const TEMPLATE_NORMS: Readonly<Record<ChordQuality, number>> = (() => {
  const norms: Partial<Record<ChordQuality, number>> = {};
  for (const quality of QUALITIES) {
    const template = CHORD_TEMPLATES[quality];
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const w = template[i] ?? 0;
      sum += w * w;
    }
    norms[quality] = Math.sqrt(sum);
  }
  return norms as Record<ChordQuality, number>;
})();

/** `chroma` must be 12 bins, index 0 = C. */
export function matchChord(chroma: Float32Array, options: ChordMatchOptions = {}): ChordMatch {
  const floor = options.floor ?? DEFAULT_CHORD_FLOOR;
  const margin = options.margin ?? DEFAULT_CHORD_MARGIN;
  const bassPitchClass = normaliseBass(options.bassPitchClass);

  if (chroma.length !== 12) {
    throw new Error(`matchChord: chroma must have 12 bins, got ${chroma.length}`);
  }

  let chromaNorm = 0;
  for (let i = 0; i < 12; i++) {
    const v = chroma[i]!;
    chromaNorm += v * v;
  }
  chromaNorm = Math.sqrt(chromaNorm);

  // A silent (or negative-only) chroma has no interpretation at all. Reporting
  // `unknown` with no candidates beats inventing a root out of zeros.
  if (!(chromaNorm > 0)) {
    return { best: null, alternatives: [], isConfident: false, margin: 0 };
  }

  const bassScale = bassPitchClass === null ? 1 : 1 / (1 + BASS_WEIGHT);
  const candidates: ChordCandidate[] = [];

  for (let root = 0; root < 12; root++) {
    for (const quality of QUALITIES) {
      const template = CHORD_TEMPLATES[quality];
      let dot = 0;
      for (let i = 0; i < 12; i++) {
        const weight = template[(i - root + 12) % 12] ?? 0;
        if (weight === 0) continue;
        dot += weight * chroma[i]!;
      }

      const norm = TEMPLATE_NORMS[quality];
      let score = norm > 0 ? dot / (norm * chromaNorm) : 0;
      // Guard against a chroma carrying negative values, and against float drift
      // pushing a perfect match a hair over 1.
      score = Math.max(0, Math.min(1, score));

      if (bassPitchClass !== null) {
        score = (score + (bassPitchClass === root ? BASS_WEIGHT : 0)) * bassScale;
      }

      candidates.push({
        label: PITCH_CLASS_NAMES[root]! + QUALITY_SUFFIX[quality],
        root: PITCH_CLASS_NAMES[root]!,
        quality,
        score,
      });
    }
  }

  // Highest first. `Array.prototype.sort` is stable (ES2019), so equal scores
  // keep dictionary order and the result is reproducible across engines.
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0]!;
  const runnerUp = candidates[1];
  const gap = runnerUp ? best.score - runnerUp.score : 0;

  // The margin is measured against the best candidate with a DIFFERENT ROOT,
  // not the immediate runner-up.
  //
  // An extension template sits inescapably close to its parent triad: D7 is D
  // plus one tone, so on a clean D the two score within a hair of each other no
  // matter how well the chord was played. Measured on the strummed fixture, the
  // top two were repeatedly D(0.86)/D7(0.78), G(0.84)/G7(0.76), A(0.99)/A(0.91)
  // -- gaps right at the 0.08 margin, so a correctly identified chord abstained
  // on a question nobody was asking. "D or D7" is uncertainty about colour;
  // "D or Bm" is uncertainty about what was played, and only the second is what
  // the abstention rule exists to catch.
  //
  // The guarantee is unchanged where it matters: a genuine contest between
  // roots still has to clear the same margin, and the floor still applies to
  // every result.
  // The skip is deliberately ONE-WAY: only a rival that strictly *extends* the
  // best is discounted. D7 adds a tone to D, so when D wins it is not in real
  // competition. The reverse is not true and must not be skipped -- if Cmaj
  // wins over C5, the question "was a third played at all?" is exactly the
  // power-chord distinction, and it has to face the full margin.
  //
  // That asymmetry was originally justified by a measurement that no longer
  // holds: a symmetric rule used to cost power-chord accuracy 75% -> 67% and
  // produce a confidently-wrong label, back when the chroma could not see a
  // strummed third at all. Re-measured against the NNLS transcription, the two
  // rules name exactly the same 59 of 78 events; the symmetric one just emits
  // three more fragments. So the asymmetry is kept on its argument rather than
  // on its old evidence — and the argument is the one above, that a missing
  // third is a fact about the chord and not a shade of it.
  const rival = candidates.find((c) => !isStrictExtensionOf(c, best));
  const rivalGap = rival ? best.score - rival.score : 0;

  return {
    best,
    alternatives: candidates.slice(1, 1 + MAX_ALTERNATIVES),
    isConfident: best.score >= floor && (!rival || rivalGap >= margin),
    // Still the true top-2 gap: the contract says so, and it is what a consumer
    // inspecting `alternatives` expects to see.
    margin: gap,
  };
}

/** Pitch-class offsets a quality's template actually calls for. */
function toneSet(quality: ChordQuality): number[] {
  const template = CHORD_TEMPLATES[quality];
  const tones: number[] = [];
  for (let i = 0; i < 12; i++) if ((template[i] ?? 0) > 0) tones.push(i);
  return tones;
}

/**
 * True when `candidate` is the same chord as `best` plus at least one extra
 * tone: same root, every one of `best`'s tones present, and strictly more of
 * them. That is a colour variant, not a competing interpretation of what was
 * played.
 */
function isStrictExtensionOf(candidate: ChordCandidate, best: ChordCandidate): boolean {
  if (candidate.root !== best.root) return false;
  if (candidate.quality === best.quality) return true;
  const bestTones = toneSet(best.quality);
  const candidateTones = toneSet(candidate.quality);
  if (candidateTones.length <= bestTones.length) return false;
  return bestTones.every((tone) => candidateTones.includes(tone));
}

function normaliseBass(bass: number | null | undefined): number | null {
  if (bass === null || bass === undefined) return null;
  if (!Number.isFinite(bass)) return null;
  return (((Math.round(bass) % 12) + 12) % 12);
}
