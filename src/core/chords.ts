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

/**
 * Weighted pitch-class templates, one entry per quality.
 *
 * Index is semitones above the root, so index 0 is always the root. Weights are
 * importance, not loudness: the triad carries the identity, extensions colour
 * it. Because scoring is a cosine, a heavy weight on a tone that is *absent*
 * from the chroma costs the candidate as much as a present one earns it — so
 * extension weights are deliberately modest, and the "5" template is deliberately
 * bare. A power chord has no third; that absence is the whole identity.
 */
export const CHORD_TEMPLATES: Readonly<Record<ChordQuality, readonly number[]>> = {
  //           1     b2   2     b3    3     4     b5   5     #5   6     b7    7
  "5":       [1.0,  0,   0,    0,    0,    0,    0,   0.9,  0,   0,    0,    0   ],
  maj:       [1.0,  0,   0,    0,    0.85, 0,    0,   0.8,  0,   0,    0,    0   ],
  min:       [1.0,  0,   0,    0.85, 0,    0,    0,   0.8,  0,   0,    0,    0   ],
  "7":       [1.0,  0,   0,    0,    0.8,  0,    0,   0.7,  0,   0,    0.65, 0   ],
  m7:        [1.0,  0,   0,    0.8,  0,    0,    0,   0.7,  0,   0,    0.65, 0   ],
  maj7:      [1.0,  0,   0,    0,    0.8,  0,    0,   0.7,  0,   0,    0,    0.6 ],
  maj9:      [1.0,  0,   0.55, 0,    0.8,  0,    0,   0.65, 0,   0,    0,    0.6 ],
  m11:       [1.0,  0,   0,    0.8,  0,    0.55, 0,   0.65, 0,   0,    0.6,  0   ],
  sus2:      [1.0,  0,   0.8,  0,    0,    0,    0,   0.85, 0,   0,    0,    0   ],
  sus4:      [1.0,  0,   0,    0,    0,    0.8,  0,   0.85, 0,   0,    0,    0   ],
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

  return {
    best,
    alternatives: candidates.slice(1, 1 + MAX_ALTERNATIVES),
    isConfident: best.score >= floor && (!runnerUp || gap >= margin),
    margin: gap,
  };
}

function normaliseBass(bass: number | null | undefined): number | null {
  if (bass === null || bass === undefined) return null;
  if (!Number.isFinite(bass)) return null;
  return (((Math.round(bass) % 12) + 12) % 12);
}
