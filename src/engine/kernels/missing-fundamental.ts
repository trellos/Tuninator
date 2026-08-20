/**
 * The bass note read from the SPACING of the partials, for when the
 * fundamental itself is not in the recording.
 *
 * A guitar speaker and a room roll off the bottom of the instrument's range. On
 * the room-mic capture in the corpus a `B2` power chord arrives with 5% of the
 * `123.5Hz` fundamental the direct input has, while `247`, `370`, `494` and
 * `741` — its 2nd, 3rd, 4th and 6th partials — are all still there at full
 * strength. Every peak-picking bass estimate reads that as a note somewhere
 * around `247`, an octave high, and every naming error downstream follows.
 *
 * The spacing still determines the answer: no other fundamental a guitar can
 * sound explains 247, 370, 494 and 741 together. This module makes that
 * inference and nothing else.
 *
 * **Subharmonic summation, not harmonic product.** HPS multiplies the spectrum
 * decimated by 1, 2, 3..., which means one absent harmonic multiplies the whole
 * product by (near) zero. The case being solved here is defined by an absent
 * harmonic — the first one — so a product form scores the right answer at zero
 * by construction. A sum degrades gracefully instead: the missing term simply
 * does not contribute, and the partials that are present carry the estimate.
 * The same argument applies to the 5th partial, which at the bottom of this
 * instrument's range carries a few percent of the energy of the 3rd and would
 * drag a product down with it. As a peak, though, it is still there and still
 * prominent, and the guard below needs it.
 *
 * **The guard.** A subharmonic estimator's own failure mode is the opposite
 * error: every harmonic of `f` is also a harmonic of `f/2`, so `f/2` always
 * scores well and the estimator invents a note an octave below a real one. Two
 * things stop it here.
 *
 *  1. *Odd harmonics.* If `f/2` is a fiction, its odd harmonics `3f/2` and
 *     `5f/2` fall between the real ones and there is nothing at them — unless
 *     other notes in the chord happen to sit there. A power chord puts its
 *     fifth exactly at `3f/2`, so that one proves nothing on its own and the
 *     5th partial is required as well. Nothing a guitar is likely to be playing
 *     over `f` sounds at `5f/2`.
 *  2. *The instrument's range.* An estimate below the lowest string is not a
 *     note, whatever the arithmetic says. This is what rejects the octave-below
 *     reading of a root-position major triad, whose third two octaves up sits
 *     within a quarter-tone of `5f/2` and which therefore passes the odd test:
 *     on the derivation fixtures the only candidates that got that far were
 *     `C2` (65.4Hz) under an open C and `D2` (73.4Hz) under an open D, both
 *     below `E2`.
 *
 * Because the fundamental is by definition absent, the estimate is a grid
 * position rather than a measured frequency, and it is only ever offered when
 * there is no peak to read directly.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

/** Harmonics considered. Beyond the 8th the match window admits anything. */
const HARMONICS = 8;
/** Harmonics that must be present, else this is not one string's series. */
const REQUIRED_HARMONICS: readonly number[] = [2, 3];
/**
 * Odd harmonics above the first; the guard against the octave-below fiction.
 *
 * The 7th is deliberately not among them. The match window is proportional to
 * frequency — it has to be, since a mistuned string is off by a constant number
 * of cents at every partial — and by `3.5f` it is wide enough to be satisfied
 * by a partial belonging to something else: on a synthesized `Cmaj9` the `D5`
 * at 588Hz sits 34 cents from where `E2`'s 7th would be, and admitting it was
 * enough to invent an `E2` under the chord and rename it `Em7`.
 */
const ODD_HARMONICS: readonly number[] = [3, 5];
/** How many of `ODD_HARMONICS` must be present — both. One is a power chord's fifth. */
const MIN_ODD_SUPPORT = 2;
/** Partials above the first that must be present in total. */
const MIN_SUPPORT = 4;

/**
 * Lowest MIDI note the estimate may name: `E2`, the lowest string in standard
 * tuning. A drop tuning needs this two semitones lower, at the cost of
 * re-admitting the `D2`-under-an-open-D reading the guard currently rejects.
 */
export const MIN_FUNDAMENTAL_MIDI = 40;

/** Match window, in cents and in bins — see `chroma.ts` for why it needs both. */
const MATCH_CENTS = 45;
const MATCH_BINS = 0.65;

const A4_HZ = 440;
const A4_MIDI = 69;

export type PartialSpectrum = {
  /** Peak frequencies in Hz, ascending. Only `count` entries are read. */
  hz: ArrayLike<number>;
  /** Peak weights, parallel to `hz`. Whitened prominence, in `chroma.ts`. */
  weight: ArrayLike<number>;
  count: number;
  /** A peak below this weight does not count as present. */
  presenceThreshold: number;
  /** FFT bin width in Hz; sets the floor on the match window. */
  binHz: number;
  /** Harmonics above this are not looked for. */
  maxFrequencyHz: number;
};

export type MissingFundamental = {
  /** The estimate, as a MIDI note. There is no peak to measure, so no Hz. */
  midi: number;
  frequencyHz: number;
  /** Subharmonic sum, in the same units as the input weights. */
  score: number;
  /** Partials above the first found at this spacing. */
  support: number;
  /** How many of the 3rd and 5th were found. */
  oddSupport: number;
};

function frequencyOf(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

function toleranceHz(hz: number, binHz: number): number {
  return Math.max(binHz * MATCH_BINS, hz * (Math.pow(2, MATCH_CENTS / 1200) - 1));
}

/** Weight of the strongest peak sitting on `hz`, or 0 if there is none. */
function weightNear(spectrum: PartialSpectrum, hz: number): number {
  const tolerance = toleranceHz(hz, spectrum.binHz);
  const low = hz - tolerance;
  const high = hz + tolerance;

  let left = 0;
  let right = spectrum.count;
  while (left < right) {
    const mid = (left + right) >> 1;
    if ((spectrum.hz[mid] as number) < low) left = mid + 1;
    else right = mid;
  }

  let best = 0;
  for (let p = left; p < spectrum.count; p++) {
    if ((spectrum.hz[p] as number) > high) break;
    const weight = spectrum.weight[p] as number;
    if (weight > best) best = weight;
  }
  return best >= spectrum.presenceThreshold ? best : 0;
}

/**
 * The lowest note whose partial spacing the spectrum shows, when its own
 * fundamental is not there to be read.
 *
 * `maxMidi` bounds the search; a bass estimate has no business being made from
 * the middle of the neck, where the fundamental is present and can just be
 * measured. Returns `null` — the normal answer — unless the evidence for an
 * absent fundamental is complete: no peak at the fundamental itself, at least
 * `MIN_SUPPORT` partials above it including the 2nd and the 3rd, and at least
 * `MIN_ODD_SUPPORT` odd partials so the reading cannot be an octave-below
 * fiction built out of some other note's harmonics.
 */
export function estimateMissingFundamental(
  spectrum: PartialSpectrum,
  maxMidi: number
): MissingFundamental | null {
  let best: MissingFundamental | null = null;

  for (let midi = MIN_FUNDAMENTAL_MIDI; midi <= maxMidi; midi++) {
    const f0 = frequencyOf(midi);
    // The inference is only allowed where there is nothing to read directly:
    // if the fundamental is in the recording, the peak pickers own this.
    if (weightNear(spectrum, f0) > 0) continue;

    let score = 0;
    let support = 0;
    let oddSupport = 0;
    let missingRequired = false;

    for (let h = 2; h <= HARMONICS; h++) {
      const target = f0 * h;
      if (target > spectrum.maxFrequencyHz) {
        if (REQUIRED_HARMONICS.includes(h)) missingRequired = true;
        break;
      }
      const weight = weightNear(spectrum, target);
      if (weight <= 0) {
        if (REQUIRED_HARMONICS.includes(h)) {
          missingRequired = true;
          break;
        }
        continue;
      }
      support++;
      if (ODD_HARMONICS.includes(h)) oddSupport++;
      // 1/h: the classic subharmonic-summation weighting. A high partial is
      // both quieter in reality and cheaper to hit by accident, since the match
      // window is proportional to frequency.
      score += weight / h;
    }

    if (missingRequired) continue;
    if (support < MIN_SUPPORT) continue;
    if (oddSupport < MIN_ODD_SUPPORT) continue;
    if (best !== null && score <= best.score) continue;
    best = { midi, frequencyHz: f0, score, support, oddSupport };
  }

  return best;
}
