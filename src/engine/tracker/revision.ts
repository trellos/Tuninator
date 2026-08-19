/**
 * Classifying what a change to a Note *means*.
 *
 * The old surface had one `musicEventUpdate` for everything, which left a
 * consumer unable to tell "I know more now" from "I was wrong". Those want
 * opposite UI: an enrichment should slide in, a correction should replace and
 * ideally explain itself. That distinction is decidable here and nowhere else,
 * because only the tracker knows whether the new label contains the old one.
 *
 * The rule: a change is an *enrichment* when the previous answer is still true
 * and merely less specific (C -> Cmaj7 -> Cmaj9, or the same note with a better
 * frequency); it is a *correction* when the previous answer is now claimed to
 * have been false (C -> Am, D5 -> C#5).
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { NoteChangeType } from "../../types.js";

/** Qualities ordered by specificity within a family, least specific first. */
const EXTENSION_CHAINS: readonly (readonly string[])[] = [
  ["5", "maj", "6", "maj7", "maj9"],
  ["5", "maj", "7", "9", "11"],
  ["5", "min", "m6", "m7", "m9", "m11"],
  ["maj", "add9"],
  ["maj", "sus2"],
  ["maj", "sus4"],
];

/**
 * True when `next` is `previous` with more detail rather than a different
 * claim: same root, and the quality only ever got more specific along a chain
 * the earlier answer is a prefix of.
 */
export function isHarmonyEnrichment(
  previousRoot: string | null,
  previousQuality: string | null,
  nextRoot: string | null,
  nextQuality: string | null
): boolean {
  if (previousRoot === null || nextRoot === null) return previousRoot === null;
  if (previousRoot !== nextRoot) return false;
  if (previousQuality === null) return true;
  if (nextQuality === null) return false;
  if (previousQuality === nextQuality) return true;

  for (const chain of EXTENSION_CHAINS) {
    const from = chain.indexOf(previousQuality);
    const to = chain.indexOf(nextQuality);
    if (from >= 0 && to > from) return true;
  }
  return false;
}

export function classifyHarmonyChange(
  previousRoot: string | null,
  previousQuality: string | null,
  nextRoot: string | null,
  nextQuality: string | null
): NoteChangeType {
  return isHarmonyEnrichment(previousRoot, previousQuality, nextRoot, nextQuality)
    ? "harmonyEnrichment"
    : "harmonyCorrection";
}

/**
 * A pitch change within one Note.
 *
 * Same note name is a refinement — the frequency moved but the answer did not.
 * A different name while a bend is in progress is movement, which is part of
 * this Note by definition. A different name otherwise is a correction: the
 * Note was misidentified, and the split that would have made it two Notes did
 * not happen (too short, or the evidence arrived late).
 */
export function classifyPitchChange(
  previousName: string | null,
  nextName: string | null,
  bending: boolean
): NoteChangeType {
  if (previousName === null || previousName === nextName) return "pitchRefinement";
  if (bending) return "pitchMovement";
  return "pitchCorrection";
}
