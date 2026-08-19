/**
 * `IHarmonicInterpreter`: from a chroma and a voicing to a chord name, or to an
 * honest refusal to give one.
 *
 * The template match does the heavy lifting; this file is the layer that turns
 * its answer into something a musician would recognise, and it is where the
 * cases templates cannot express live:
 *
 *  - **Inversions.** A template match is transposition-invariant and therefore
 *    inversion-blind: C/G and C are the same pitch-class set. The bass, which
 *    the chroma kernel reads off the untouched peaks before cancellation, is
 *    what separates them, and the slash name is only used when the bass is a
 *    chord tone that is *not* the root.
 *  - **Power chords.** "C5" is not an impoverished C major, it is a deliberate
 *    absence of a third, and reporting it as C would be a claim about the third
 *    that the audio contradicts.
 *  - **Abstention.** When nothing clears both the floor and the margin, the
 *    honest answer is that this is a chord and we will not name it. That is a
 *    result, not a failure: on the extended-voicing fixture the pass criterion
 *    is precisely that the recognizer may say "unknown" and may not confidently
 *    say the wrong thing.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { PitchClass } from "../../types.js";
import type { EngineConfig } from "../config.js";
import type {
  HarmonicReading,
  IHarmonicInterpreter,
  PitchActivation,
  SpectralEvidence,
} from "../contracts.js";
import { matchChord, type ChordQuality } from "../kernels/chords.js";
import { PITCH_CLASSES } from "../kernels/notes.js";

/** Chord tones per quality, as semitone offsets from the root. */
const QUALITY_INTERVALS: Readonly<Record<ChordQuality, readonly number[]>> = {
  "5": [0, 7],
  maj: [0, 4, 7],
  min: [0, 3, 7],
  "7": [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  maj9: [0, 2, 4, 7, 11],
  m11: [0, 3, 5, 7, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
};

/** Interval names, indexed by semitones from the root. */
const INTERVAL_NAMES: readonly string[] = [
  "1", "b2", "2", "b3", "3", "4", "b5", "5", "#5", "6", "b7", "7",
];

export class HarmonicInterpreter implements IHarmonicInterpreter {
  constructor(private readonly config: EngineConfig) {}

  interpret(
    evidence: SpectralEvidence,
    activations: readonly PitchActivation[]
  ): HarmonicReading {
    const harmony = this.config.harmony;
    const match = matchChord(evidence.chroma, {
      floor: harmony.floor,
      margin: harmony.margin,
      bassPitchClass: evidence.bassPitchClass,
    });

    const alternatives = [
      ...(match.best !== null && !match.isConfident
        ? [{ label: match.best.label, confidence: match.best.score }]
        : []),
      ...match.alternatives.map((c) => ({ label: c.label, confidence: c.score })),
    ].slice(0, 4);

    const bass = bassActivation(evidence, activations);

    if (!match.isConfident || match.best === null) {
      // Abstention, not failure. `root`/`quality`/`chordName` all stay null and
      // the alternatives carry the work, so a consumer can show what was
      // considered without the recognizer committing to any of it.
      return {
        root: null,
        quality: null,
        chordName: null,
        bass,
        intervals: [],
        confidence: match.best?.score ?? 0,
        alternatives,
        isConfident: false,
      };
    }

    const root = match.best.root;
    const quality = match.best.quality;
    const rootIndex = PITCH_CLASSES.indexOf(root);
    const tones = QUALITY_INTERVALS[quality];

    let chordName = match.best.label;
    // A slash name only when the bass is a chord tone other than the root.
    // Naming "C/D" off a bass that is not in the chord would be asserting a
    // relationship the evidence does not support — far more likely the bass
    // estimate is wrong than that the player added a ninth in the bass.
    if (bass !== null) {
      const bassIndex = PITCH_CLASSES.indexOf(bass.pitchClass);
      const degree = (((bassIndex - rootIndex) % 12) + 12) % 12;
      if (degree !== 0 && tones.includes(degree)) {
        chordName = `${match.best.label}/${bass.pitchClass}`;
      }
    }

    return {
      root,
      quality,
      chordName,
      bass,
      intervals: tones.map((semitones) => INTERVAL_NAMES[semitones] as string),
      confidence: match.best.score,
      alternatives,
      isConfident: true,
    };
  }
}

/**
 * The lowest sounding note, preferring a measured activation over the chroma's
 * own bass estimate so the register is a real one rather than a grid position.
 */
function bassActivation(
  evidence: SpectralEvidence,
  activations: readonly PitchActivation[]
): PitchActivation | null {
  if (activations.length > 0) {
    let lowest = activations[0] as PitchActivation;
    for (const activation of activations) {
      if (activation.midi < lowest.midi) lowest = activation;
    }
    // The chroma's bass reading is taken from the untouched peaks, before
    // cancellation; when the two disagree, the one that agrees with a detected
    // fundamental is the one with a register we can stand behind.
    if (
      evidence.bassPitchClass === null ||
      PITCH_CLASSES.indexOf(lowest.pitchClass) === evidence.bassPitchClass
    ) {
      return { ...lowest, salience: lowest.salience };
    }
  }
  if (evidence.bassPitchClass === null || evidence.bassFrequencyHz === null) return null;

  const midi = Math.round(69 + 12 * Math.log2(evidence.bassFrequencyHz / 440));
  return {
    frequencyHz: evidence.bassFrequencyHz,
    midi,
    pitchClass: PITCH_CLASSES[evidence.bassPitchClass] as PitchClass,
    octave: Math.floor(midi / 12) - 1,
    salience: evidence.salience,
    confidence: evidence.salience,
  };
}
