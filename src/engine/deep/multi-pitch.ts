/**
 * `IMultiPitchAnalyzer`: the voicing, not the pitch-class set.
 *
 * `chroma` folds octaves away, which is right for matching templates against a
 * transposition-invariant shape and wrong for describing what was played. "C,
 * E, G" cannot distinguish C/G from root-position C, cannot say which C, and
 * cannot tell a three-string power chord from a six-string barre. The register
 * is available — the cancellation pass finds fundamentals on a semitone grid
 * before anything is folded — it was simply being discarded.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type {
  IMultiPitchAnalyzer,
  PitchActivation,
  SpectralEvidence,
} from "../contracts.js";
import { midiToFrequency, midiToOctave, midiToPitchClass } from "../kernels/notes.js";
import type { SpectralAnalyzer } from "./spectral.js";

export class MultiPitchAnalyzer implements IMultiPitchAnalyzer {
  constructor(private readonly spectral: SpectralAnalyzer) {}

  activations(evidence: SpectralEvidence): PitchActivation[] {
    const fundamentals = this.spectral.fundamentals();
    if (fundamentals.length === 0) return [];

    // Salience is a harmonic-sum in arbitrary units; normalising against the
    // strongest fundamental in the same frame is what makes it comparable
    // across frames of very different loudness.
    let maxSalience = 0;
    for (const f of fundamentals) maxSalience = Math.max(maxSalience, f.salience);
    if (maxSalience <= 0) return [];

    const out: PitchActivation[] = fundamentals.map((f) => {
      const relative = f.salience / maxSalience;
      return {
        // Named from the grid rather than from a measured peak: below ~150Hz a
        // peak's measured frequency can round to the wrong semitone outright.
        frequencyHz: midiToFrequency(f.midi),
        midi: f.midi,
        pitchClass: midiToPitchClass(f.midi),
        octave: midiToOctave(f.midi),
        salience: relative,
        // A fundamental that survived cancellation and carries most of the
        // frame's harmonic weight is about as certain as this front end gets;
        // one scraping through at a tenth of the leader is a guess.
        confidence: Math.min(1, 0.35 + 0.65 * relative),
      };
    });

    out.sort((a, b) => a.midi - b.midi);
    return out;
  }
}
