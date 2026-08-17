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

/** Weighted pitch-class templates, one entry per quality. */
export const CHORD_TEMPLATES: Readonly<Record<ChordQuality, readonly number[]>> = {
  "5": [], maj: [], min: [], "7": [], m7: [], maj7: [], maj9: [], m11: [], sus2: [], sus4: [],
};

/** `chroma` must be 12 bins, index 0 = C. */
export function matchChord(_chroma: Float32Array, _options?: ChordMatchOptions): ChordMatch {
  throw new Error("matchChord: not implemented");
}
