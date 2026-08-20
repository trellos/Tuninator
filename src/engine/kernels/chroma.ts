/**
 * Harmonic-whitened chroma (HPCP) for chord detection.
 *
 * A strummed guitar's overtones swamp its fundamentals in a raw magnitude
 * spectrum, so the spectrum is whitened / salience-weighted before folding into
 * 12 bins.
 *
 * Pipeline:
 *   1. Hann window -> `RealFFT` magnitude spectrum.
 *   2. Whitening: subtract a proportional-bandwidth moving mean of the *log*
 *      magnitudes (a running geometric-mean envelope) so what survives is each
 *      bin's prominence over its own neighbourhood, not its absolute level.
 *      After it, a quiet fundamental and a loud overtone are comparable.
 *   3. Peak picking on the raw spectrum with parabolic interpolation (at 4096
 *      points / 48kHz a bin is 11.7Hz, coarser than a semitone below ~200Hz),
 *      weighted by whitened prominence and a compressed amplitude term.
 *   4. Iterative harmonic cancellation over a semitone grid of candidate
 *      fundamentals: score, take the winner, attenuate the partials it explains,
 *      repeat. Every partial is spent once, so an overtone cannot also be read
 *      as a note. A plain fold cannot do this, and on a strummed guitar it turns
 *      every power chord into a ninth.
 *   5. The surviving fundamentals are folded to 12 pitch classes, normalised to
 *      max = 1. The bass is read separately, off the uncancelled peaks — or,
 *      where a speaker and a room have taken the bottom string's fundamental
 *      away entirely, off the spacing of the partials above it
 *      (`missing-fundamental.ts`).
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the chord
 * workstream. Depends on `RealFFT` and `hannWindow` from `./fft.js`.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import { RealFFT, hannWindow } from "./fft.js";
import { estimateMissingFundamental } from "./missing-fundamental.js";

export type ChromaOptions = {
  sampleRate: number;
  fftSize: number;
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  /** Number of harmonics folded in, with decaying weight. */
  harmonics?: number;
};

export type ChromaResult = {
  /** 12 bins, index 0 = C, normalised so max = 1 (all zeros when silent). */
  chroma: Float32Array;
  /**
   * Lowest confidently-detected partial, as a pitch class index (0 = C).
   * This is what separates C5 from G5, and Am11 from C6/9.
   */
  bassPitchClass: number | null;
  bassFrequencyHz: number | null;
  /** 0..1 measure of how tonal (vs. noisy) the spectrum is. */
  salience: number;
  /** Estimated number of simultaneous fundamentals. */
  polyphony: number;
  /**
   * The fundamentals themselves, strongest first, with their register intact.
   *
   * `chroma` deliberately folds octaves away, which is right for matching
   * templates and wrong for describing a voicing: "C, E, G" cannot tell C/G
   * from a root-position C, and cannot say which C. Cancellation already
   * computes these on the way to `polyphony`, so reporting them costs nothing
   * and is the only place the register survives.
   */
  fundamentals: Array<{ midi: number; salience: number }>;
};

/* -------------------------------------------------------------------------- */
/* Tuning constants                                                            */
/* -------------------------------------------------------------------------- */

const DEFAULT_MIN_FREQUENCY_HZ = 70;
const DEFAULT_MAX_FREQUENCY_HZ = 1300;
const DEFAULT_HARMONICS = 5;

/** Input RMS below this counts as silence: all-zero chroma, no bass. */
const SILENCE_RMS = 1e-6;

/** Whitening window half-width, as a fraction of the bin index (~1/4 octave). */
const ENVELOPE_RELATIVE_HALF_WIDTH = 0.35;
/** Floor on that half-width so the low bins still see a usable neighbourhood. */
const ENVELOPE_MIN_HALF_WIDTH = 8;
/** Magnitudes below this fraction of the frame peak are clamped before log(). */
const MAGNITUDE_FLOOR_RATIO = 1e-5;

/** Log-prominence (nepers) a peak must clear over its local geometric mean. */
const MIN_PEAK_PROMINENCE = 0.1;
/** Prominence saturates here, so one freak bin cannot own the whole chroma. */
const MAX_PEAK_PROMINENCE = 4;
/** Peaks quieter than this fraction of the loudest peak are dropped outright. */
const MIN_PEAK_AMPLITUDE_RATIO = 0.002;
/** Compression on a peak's relative amplitude; 0 = pure whitening, 1 = none. */
const AMPLITUDE_EXPONENT = 0.1;
/** Per-step decay of the sub-harmonic fold (h = 1 is the peak itself). */
const HARMONIC_DECAY = 0.6;

/** Lowest / highest MIDI note treated as a plausible fundamental. */
const GRID_MIN_MIDI = 36; // C2, 65.4Hz
const GRID_MAX_MIDI = 88; // E6, 1318.5Hz

/** Most fundamentals extracted from one frame. A guitar has six strings. */
const MAX_FUNDAMENTALS = 6;
/**
 * Extraction stops once a candidate falls this far below the first one.
 *
 * This is the gate that decided whether a strummed triad keeps its third. A
 * guitar plays the third once while doubling root and fifth across strings, so
 * the third's salience is legitimately several times lower -- it is not noise,
 * it is just outnumbered. Measured on the fixture's first Bm strum: B3 scores
 * 3.068, F#3 scores 2.679, and the D4 that makes it minor scores 0.703 against
 * a 0.920 cutoff at the old 0.3. It was pruned on every frame, leaving a chroma
 * of exactly {B, F#} -- a literal power chord -- so Bm could only ever be read
 * as B5.
 *
 * 0.22 was chosen by sweeping 0.30/0.22/0.15/0.10/0.06 against all four chord
 * fixtures. It is not simply "lower is better": below 0.20 the extra
 * fundamentals are ghosts rather than thirds, and spicy-chords collapses from
 * 50% to 0% exact while a confidently-wrong label appears on the strummed
 * fixture. 0.22 is the point where real thirds survive and ghosts do not.
 */
const FUNDAMENTAL_STOP_RATIO = 0.22;
/** Fraction of a partial's weight a fundamental claims when it is cancelled. */
const CANCELLATION_STRENGTH = 0.85;
/** Harmonics reached by cancellation. Deliberately more than are scored. */
const CANCELLATION_HARMONICS = 10;
/**
 * Window for calling a partial the h-th harmonic of a candidate.
 *
 * Two error sources, so two terms. A mistuned string is off by a constant
 * number of *cents* at every harmonic, which is the second term. Measuring a
 * peak is off by a constant number of *Hz* — roughly half a bin — which at
 * 11.7Hz bins is 4 cents up at 2kHz but 80 cents down at low E, and is why the
 * first term has to exist at all. Matching in cents alone throws away every
 * bass note on the instrument.
 */
const HARMONIC_MATCH_CENTS = 45;
const HARMONIC_MATCH_BINS = 0.65;
/** Harmonics a candidate must have before it can be called a fundamental. */
const MIN_HARMONIC_SUPPORT = 2;
/** A partial counts as present while it holds this fraction of the peak weight. */
const PRESENCE_RATIO = 0.05;

/** Bass search is limited to this range; a guitar's lowest string is 82.4Hz. */
const BASS_MAX_FREQUENCY_HZ = 200;
/**
 * A bass candidate is accepted as the lowest one holding this fraction of the
 * best low-register salience. Straight "lowest supported partial" picks up
 * octave ghosts and body resonance; "strongest" picks the wrong string of a
 * power chord. The lowest one that is genuinely *comparable* is neither.
 */
const BASS_SALIENCE_RATIO = 0.4;
/** Tighter window for "this peak IS the bass note", vs. merely near a harmonic. */
const BASS_OWN_PEAK_BINS = 0.45;
const BASS_OWN_PEAK_CENTS = 40;

/**
 * Exponent of the generalised mean used to fold octaves into a pitch class.
 *
 * 1 is a plain sum, higher tends towards a max. Guitar voicings double the root
 * and fifth across strings and play the third once (open Em is E2 B2 E3 G3 B3
 * E4 — three E's, two B's, one G), so a plain sum makes every triad look like a
 * power chord. Combining octaves as an L-p norm lets a doubled note count for
 * more than a single one without counting for twice as much.
 */
const OCTAVE_FOLD_POWER = 2;

/**
 * Contrast exponent applied to the normalised chroma. Below 1 it *expands* the
 * quiet bins rather than suppressing them.
 *
 * Cancellation has already decided which notes are sounding, so what reaches
 * this point is presence, not energy — and a note's salience mostly measures how
 * many strong partials it happened to own. An open Em plays three E's, two B's
 * and one G: the G is the chord's third and the least of its salience. Left
 * uncompressed, every triad reads as a power chord.
 */
const CHROMA_CONTRAST = 0.4;

/**
 * Below this tonality the frame is noise, and it yields no chroma at all.
 *
 * Whitening deliberately flattens the spectral envelope, which means it also
 * promotes noise: a loud hiss offers a few dozen peaks, and enough of them land
 * near some candidate's harmonics to elect five or six confident "fundamentals"
 * that spell a chord nobody played. Peak shape cannot separate the two cases —
 * peak *prominence* can, and `salience` already measures exactly that.
 *
 * Measured over the four fixtures: 866 chord frames run 0.239 to 0.939, first
 * percentile 0.306; 60 white-noise frames run 0.118 to 0.209. The gate sits in
 * the gap, and it fails safe — a gated frame reports no chroma, the caller
 * reports `unknown`.
 */
const MIN_TONAL_SALIENCE = 0.22;

const A4_HZ = 440;
const A4_MIDI = 69;

/* -------------------------------------------------------------------------- */

function hzFromMidi(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

export class ChromaAnalyzer {
  /** Number of samples `analyze()` expects. Equals `fftSize`. */
  readonly windowSize: number;

  private readonly minFrequencyHz: number;
  private readonly maxFrequencyHz: number;
  private readonly harmonics: number;

  private readonly fft: RealFFT;
  private readonly hann: Float32Array;
  private readonly windowed: Float32Array;
  private readonly magnitude: Float32Array;
  private readonly logMagnitude: Float64Array;
  /** Inclusive prefix sums of `logMagnitude`, so the envelope costs O(bins). */
  private readonly logPrefix: Float64Array;

  /** Interpolated peak frequencies, ascending. Valid for `peakCount` entries. */
  private readonly peakHz: Float64Array;
  private readonly peakAmplitude: Float64Array;
  private readonly binProminence: Float64Array;
  private readonly peakWeight: Float64Array;
  private peakCount = 0;

  /** Peak weights as cancellation eats them; reset from `peakWeight` per frame. */
  private readonly workingWeight: Float64Array;
  /** Weight below which a partial no longer counts as present. Per frame. */
  private presenceThreshold = 0;

  /** Candidate fundamental frequencies, one per semitone of the grid. */
  private readonly candidateHz: Float64Array;
  private readonly gridSize: number;
  private readonly bassSalience: Float64Array;
  private readonly fundamentalGrid: Int32Array;
  private readonly fundamentalSalience: Float64Array;
  private readonly octaveFold: Float64Array;
  private readonly harmonicWeights: Float64Array;

  private readonly binHz: number;
  private readonly minBin: number;
  private readonly maxBin: number;

  constructor(options: ChromaOptions) {
    const { sampleRate, fftSize } = options;
    if (!(sampleRate > 0)) {
      throw new Error(`ChromaAnalyzer: sampleRate must be > 0, got ${sampleRate}`);
    }

    this.windowSize = fftSize;
    this.minFrequencyHz = Math.max(1, options.minFrequencyHz ?? DEFAULT_MIN_FREQUENCY_HZ);
    this.maxFrequencyHz = Math.min(
      options.maxFrequencyHz ?? DEFAULT_MAX_FREQUENCY_HZ,
      sampleRate / 2
    );
    if (this.maxFrequencyHz <= this.minFrequencyHz) {
      throw new Error(
        `ChromaAnalyzer: maxFrequencyHz (${this.maxFrequencyHz}) must exceed ` +
          `minFrequencyHz (${this.minFrequencyHz})`
      );
    }
    this.harmonics = Math.max(1, Math.min(8, Math.round(options.harmonics ?? DEFAULT_HARMONICS)));

    this.fft = new RealFFT(fftSize);
    const bins = this.fft.bins;

    this.hann = hannWindow(fftSize);
    this.windowed = new Float32Array(fftSize);
    this.magnitude = new Float32Array(bins);
    this.logMagnitude = new Float64Array(bins);
    this.logPrefix = new Float64Array(bins + 1);

    this.peakHz = new Float64Array(bins);
    this.peakAmplitude = new Float64Array(bins);
    this.binProminence = new Float64Array(bins);
    this.peakWeight = new Float64Array(bins);

    this.binHz = sampleRate / fftSize;
    this.minBin = Math.max(1, Math.floor(this.minFrequencyHz / this.binHz));
    this.maxBin = Math.min(bins - 2, Math.ceil(this.maxFrequencyHz / this.binHz));

    this.workingWeight = new Float64Array(bins);
    this.gridSize = GRID_MAX_MIDI - GRID_MIN_MIDI + 1;
    this.candidateHz = new Float64Array(this.gridSize);
    for (let k = 0; k < this.gridSize; k++) {
      this.candidateHz[k] = hzFromMidi(GRID_MIN_MIDI + k);
    }
    this.bassSalience = new Float64Array(this.gridSize);
    this.fundamentalGrid = new Int32Array(MAX_FUNDAMENTALS);
    this.fundamentalSalience = new Float64Array(MAX_FUNDAMENTALS);
    this.octaveFold = new Float64Array(12);

    this.harmonicWeights = new Float64Array(this.harmonics);
    for (let h = 0; h < this.harmonics; h++) {
      this.harmonicWeights[h] = Math.pow(HARMONIC_DECAY, h);
    }
  }

  /** `window.length` must equal `windowSize`. Applies its own Hann window. */
  analyze(window: Float32Array): ChromaResult {
    if (window.length !== this.windowSize) {
      throw new Error(
        `ChromaAnalyzer.analyze: expected ${this.windowSize} samples, got ${window.length}`
      );
    }

    let sumSquares = 0;
    for (let i = 0; i < window.length; i++) {
      const s = window[i]!;
      sumSquares += s * s;
      this.windowed[i] = s * this.hann[i]!;
    }
    const rms = Math.sqrt(sumSquares / window.length);
    if (!(rms > SILENCE_RMS)) return silentResult();

    this.fft.magnitudes(this.windowed, this.magnitude);

    let maxMagnitude = 0;
    for (let i = this.minBin; i <= this.maxBin; i++) {
      const m = this.magnitude[i]!;
      if (m > maxMagnitude) maxMagnitude = m;
    }
    if (!(maxMagnitude > 0)) return silentResult();

    const salience = this.computeSalience();
    // Too flat to be an instrument: report the tonality, but no notes.
    if (salience < MIN_TONAL_SALIENCE) return untonalResult(salience);

    this.whiten(maxMagnitude);
    this.collectPeaks();
    if (this.peakCount === 0) return untonalResult(salience);

    // The bass is read off the untouched peaks, before cancellation eats them.
    this.resetWorkingWeights();
    const bassGrid = this.findBass();
    // ...and where there is no peak to read, off the spacing of the ones above
    // it. A speaker and a room take the bottom string's fundamental away; the
    // rest of its series is still there and still names it.
    const missingGrid = this.findMissingFundamental(bassGrid);

    let bassFrequencyHz: number | null = null;
    let bassPitchClass: number | null = null;
    if (missingGrid >= 0) {
      // No measured frequency: the whole point is that the peak is absent, so
      // the grid position is the only honest answer.
      bassFrequencyHz = this.candidateHz[missingGrid]!;
      bassPitchClass = (((GRID_MIN_MIDI + missingGrid) % 12) + 12) % 12;
    } else if (bassGrid >= 0) {
      const gridHz = this.candidateHz[bassGrid]!;
      const own = this.strongestPartialNear(gridHz);
      // Report what was measured, but name the note from the grid: below ~150Hz
      // a peak's measured frequency can round to the wrong semitone outright.
      bassFrequencyHz = own >= 0 ? this.peakHz[own]! : gridHz;
      bassPitchClass = (((GRID_MIN_MIDI + bassGrid) % 12) + 12) % 12;
    }

    const fundamentals = this.estimateFundamentals();
    const chroma = this.foldToChroma(fundamentals);

    const detected: Array<{ midi: number; salience: number }> = [];
    for (let f = 0; f < fundamentals; f++) {
      detected.push({
        midi: GRID_MIN_MIDI + (this.fundamentalGrid[f] as number),
        salience: this.fundamentalSalience[f] as number,
      });
    }

    return {
      chroma,
      bassPitchClass,
      bassFrequencyHz,
      salience,
      polyphony: fundamentals,
      fundamentals: detected,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Steps                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Tonalness as `1 - spectral flatness` over the analysis band. A sine is
   * near 1, white noise near 0.
   */
  private computeSalience(): number {
    let sumLog = 0;
    let sum = 0;
    let count = 0;
    for (let i = this.minBin; i <= this.maxBin; i++) {
      const m = this.magnitude[i]! + 1e-12;
      sumLog += Math.log(m);
      sum += m;
      count++;
    }
    if (count === 0 || sum <= 0) return 0;
    const geometric = Math.exp(sumLog / count);
    const arithmetic = sum / count;
    const flatness = geometric / arithmetic;
    return Math.max(0, Math.min(1, 1 - flatness));
  }

  /**
   * Replaces `logMagnitude` with each bin's log-prominence over a
   * proportional-bandwidth moving geometric mean of its neighbours. This is
   * the whitening step: after it, a quiet fundamental and a loud overtone are
   * on comparable footing.
   */
  private whiten(maxMagnitude: number): void {
    const bins = this.fft.bins;
    const floorMagnitude = Math.max(maxMagnitude * MAGNITUDE_FLOOR_RATIO, 1e-30);

    for (let i = 0; i < bins; i++) {
      this.logMagnitude[i] = Math.log(Math.max(this.magnitude[i]!, floorMagnitude));
    }

    this.logPrefix[0] = 0;
    for (let i = 0; i < bins; i++) {
      this.logPrefix[i + 1] = this.logPrefix[i]! + this.logMagnitude[i]!;
    }

    // Written back into logMagnitude bottom-up would corrupt later windows, so
    // prominence goes into its own pass over the prefix sums instead.
    for (let i = this.minBin - 1; i <= this.maxBin + 1; i++) {
      if (i < 0 || i >= bins) continue;
      const half = Math.max(
        ENVELOPE_MIN_HALF_WIDTH,
        Math.round(i * ENVELOPE_RELATIVE_HALF_WIDTH)
      );
      const lo = Math.max(0, i - half);
      const hi = Math.min(bins - 1, i + half);
      const mean = (this.logPrefix[hi + 1]! - this.logPrefix[lo]!) / (hi - lo + 1);
      this.binProminence[i] = this.logMagnitude[i]! - mean;
    }
  }

  /**
   * Local maxima of the raw magnitude spectrum, refined by parabolic
   * interpolation on the log magnitudes, weighted by whitened prominence and
   * a compressed amplitude term. Ascending in frequency.
   */
  private collectPeaks(): void {
    this.peakCount = 0;

    let maxAmplitude = 0;
    let count = 0;
    for (let i = this.minBin; i <= this.maxBin; i++) {
      const m = this.magnitude[i]!;
      if (!(m > this.magnitude[i - 1]!) || !(m >= this.magnitude[i + 1]!)) continue;

      const prominence = this.binProminence[i]! - MIN_PEAK_PROMINENCE;
      if (!(prominence > 0)) continue;

      // Parabolic interpolation over log magnitudes: exact for a Gaussian
      // peak, and close enough for a Hann main lobe.
      const a = this.logMagnitude[i - 1]!;
      const b = this.logMagnitude[i]!;
      const c = this.logMagnitude[i + 1]!;
      const denominator = a - 2 * b + c;
      let delta = denominator !== 0 ? (0.5 * (a - c)) / denominator : 0;
      if (!(delta > -0.5) || !(delta < 0.5)) delta = 0;

      const hz = (i + delta) * this.binHz;
      if (hz < this.minFrequencyHz || hz > this.maxFrequencyHz) continue;

      const amplitude = Math.exp(b - 0.25 * (a - c) * delta);

      this.peakHz[count] = hz;
      this.peakAmplitude[count] = amplitude;
      this.peakWeight[count] = Math.min(prominence, MAX_PEAK_PROMINENCE);
      if (amplitude > maxAmplitude) maxAmplitude = amplitude;
      count++;
    }
    if (count === 0 || maxAmplitude <= 0) return;

    // Second pass: drop the very quiet peaks and fold amplitude into weight.
    let kept = 0;
    for (let p = 0; p < count; p++) {
      const relative = this.peakAmplitude[p]! / maxAmplitude;
      if (relative < MIN_PEAK_AMPLITUDE_RATIO) continue;
      this.peakHz[kept] = this.peakHz[p]!;
      this.peakAmplitude[kept] = relative;
      this.peakWeight[kept] = this.peakWeight[p]! * Math.pow(relative, AMPLITUDE_EXPONENT);
      kept++;
    }
    this.peakCount = kept;

    let maxWeight = 0;
    for (let p = 0; p < kept; p++) {
      const w = this.peakWeight[p]!;
      if (w > maxWeight) maxWeight = w;
    }
    this.presenceThreshold = maxWeight * PRESENCE_RATIO;
  }

  /**
   * Iterative harmonic cancellation.
   *
   * Every semitone on the grid is scored by summing the whitened partials at
   * its own harmonics. The winner is recorded, *its* partials are attenuated,
   * and the grid is rescored — so a partial can only be claimed once. Without
   * this, a plain sub-harmonic fold reads G3's third harmonic (D5) as a D, and
   * C3's fifth harmonic (E5) as an E, and a C5 power chord comes out looking
   * like Cmaj9. Repeats until the field falls away or six strings are used up.
   *
   * Octave errors are harmless here: C2 and C3 land in the same pitch class.
   * Fifth-below ghosts are what cancellation actually buys.
   *
   * Returns the number of fundamentals written to `fundamentalGrid`.
   */
  private estimateFundamentals(): number {
    this.resetWorkingWeights();

    let found = 0;
    let firstSalience = 0;

    for (let iteration = 0; iteration < MAX_FUNDAMENTALS; iteration++) {
      let bestIndex = -1;
      let bestSalience = 0;
      for (let k = 0; k < this.gridSize; k++) {
        const salience = this.salienceOf(this.candidateHz[k]!);
        if (salience > bestSalience) {
          bestSalience = salience;
          bestIndex = k;
        }
      }
      if (bestIndex < 0) break;
      if (iteration === 0) firstSalience = bestSalience;
      else if (bestSalience < firstSalience * FUNDAMENTAL_STOP_RATIO) break;

      this.fundamentalGrid[found] = bestIndex;
      this.fundamentalSalience[found] = bestSalience;
      found++;
      this.cancel(this.candidateHz[bestIndex]!);
    }
    return found;
  }

  /**
   * The lowest note the spacing of the partials implies, when its own
   * fundamental is not in the recording — or -1, which is the normal answer.
   *
   * Delegated to `missing-fundamental.ts`, which carries the reasoning and the
   * guard against the octave-below fiction. Two conditions are imposed here:
   * the estimate is only used when it is *lower* than the bass that was read
   * directly (otherwise the peaks won and should have), and the search stops at
   * the top of the bass range, because above it the fundamental is present and
   * there is nothing to infer.
   *
   * It changes the bass reading and nothing else. Seeding cancellation with the
   * estimate as well — so that the partials of the note nobody could see stop
   * being spent on notes nobody played — was built and measured, and it costs a
   * label on the derivation set: it strips the third off `chords-a-bm`'s last
   * `D` while gaining nothing there. See `docs/DETECTION-FINDINGS.md`.
   *
   * Cost is sixteen candidates against a binary search each, on a lane that
   * already runs a fifty-three-semitone cancellation loop per hop.
   */
  private findMissingFundamental(bassGrid: number): number {
    const estimate = estimateMissingFundamental(
      {
        hz: this.peakHz,
        weight: this.workingWeight,
        count: this.peakCount,
        presenceThreshold: this.presenceThreshold,
        binHz: this.binHz,
        maxFrequencyHz: this.maxFrequencyHz,
      },
      Math.min(GRID_MAX_MIDI, Math.floor(12 * Math.log2(BASS_MAX_FREQUENCY_HZ / A4_HZ)) + A4_MIDI)
    );
    if (estimate === null) return -1;

    const grid = estimate.midi - GRID_MIN_MIDI;
    if (grid < 0 || grid >= this.gridSize) return -1;
    if (bassGrid >= 0 && grid >= bassGrid) return -1;
    return grid;
  }

  /**
   * Harmonic-sum salience of a candidate fundamental: how much surviving
   * whitened energy sits at f, 2f, 3f... A candidate needs at least
   * `MIN_HARMONIC_SUPPORT` of its own harmonics before it counts at all, which
   * is what stops a lone noise peak from becoming a note.
   */
  private salienceOf(fundamentalHz: number): number {
    let sum = 0;
    let support = 0;
    for (let h = 1; h <= this.harmonics; h++) {
      const target = fundamentalHz * h;
      if (target > this.maxFrequencyHz) break;
      const index = this.strongestPartialNear(target);
      if (index < 0) continue;
      const weight = this.workingWeight[index]!;
      if (weight < this.presenceThreshold) continue;
      support++;
      sum += weight * this.harmonicWeights[h - 1]!;
    }
    return support >= MIN_HARMONIC_SUPPORT ? sum : 0;
  }

  /** Restores every peak's weight, undoing any cancellation. */
  private resetWorkingWeights(): void {
    for (let p = 0; p < this.peakCount; p++) {
      this.workingWeight[p] = this.peakWeight[p]!;
    }
  }

  /**
   * Attenuates the partials a detected fundamental explains.
   *
   * Reaches further up the series than `salienceOf` sums: a note explains every
   * one of its harmonics in band, not just the few that were worth scoring. Cut
   * this short and the leftovers grow phantoms — G3's sixth harmonic, left
   * standing, is enough to support a D5 that nobody played.
   */
  private cancel(fundamentalHz: number): void {
    for (let h = 1; h <= CANCELLATION_HARMONICS; h++) {
      const target = fundamentalHz * h;
      if (target > this.maxFrequencyHz) break;
      const index = this.strongestPartialNear(target);
      if (index < 0) continue;
      // Flat, not scaled by the harmonic weight: a partial sitting on h*f is
      // explained by this fundamental whatever the sum happened to pay for it.
      this.workingWeight[index] = this.workingWeight[index]! * (1 - CANCELLATION_STRENGTH);
    }
  }

  /** Half-width of the window that counts as "sitting on" `hz`, in Hz. */
  private toleranceHz(hz: number): number {
    return Math.max(
      this.binHz * HARMONIC_MATCH_BINS,
      hz * (Math.pow(2, HARMONIC_MATCH_CENTS / 1200) - 1)
    );
  }

  /**
   * Index of the strongest surviving peak sitting on `hz`, or -1. Peaks are
   * ascending, so the window is found by binary search.
   */
  private strongestPartialNear(hz: number): number {
    const tolerance = this.toleranceHz(hz);
    return this.strongestPartialInRange(hz - tolerance, hz + tolerance);
  }

  /** Index of the strongest surviving peak in `[low, high]` Hz, or -1. */
  private strongestPartialInRange(low: number, high: number): number {
    let left = 0;
    let right = this.peakCount;
    while (left < right) {
      const mid = (left + right) >> 1;
      if (this.peakHz[mid]! < low) left = mid + 1;
      else right = mid;
    }

    let best = -1;
    let bestWeight = 0;
    for (let p = left; p < this.peakCount; p++) {
      if (this.peakHz[p]! > high) break;
      const weight = this.workingWeight[p]!;
      if (weight > bestWeight) {
        bestWeight = weight;
        best = p;
      }
    }
    return best;
  }

  /** Folds the detected fundamentals into 12 normalised pitch classes. */
  private foldToChroma(fundamentals: number): Float32Array {
    const chroma = new Float32Array(12);
    this.octaveFold.fill(0);

    for (let f = 0; f < fundamentals; f++) {
      const midi = GRID_MIN_MIDI + this.fundamentalGrid[f]!;
      const pitchClass = (((midi % 12) + 12) % 12);
      this.octaveFold[pitchClass] =
        this.octaveFold[pitchClass]! + Math.pow(this.fundamentalSalience[f]!, OCTAVE_FOLD_POWER);
    }
    for (let i = 0; i < 12; i++) {
      chroma[i] = Math.pow(this.octaveFold[i]!, 1 / OCTAVE_FOLD_POWER);
    }

    let max = 0;
    for (let i = 0; i < 12; i++) {
      const v = chroma[i]!;
      if (v > max) max = v;
    }
    if (max > 0) {
      for (let i = 0; i < 12; i++) {
        chroma[i] = Math.pow(chroma[i]! / max, CHROMA_CONTRAST);
      }
    }
    return chroma;
  }

  /**
   * The lowest note actually being played, as a grid index, or -1.
   *
   * Scored on grid semitones rather than on raw peak frequencies: a low peak's
   * measured frequency is off by up to most of a semitone at this resolution,
   * and predicting its harmonics as h * (that error) misses every one of them.
   * The grid frequency is exact, so only the *partials* need to be found — and
   * those sit high enough to be measured well.
   *
   * A candidate has to clear three bars: its own fundamental is visible (which
   * rules out the octave-below ghost, whose partials are all real but whose
   * fundamental is silent), at least two harmonics support it, and its salience
   * is comparable to the best in the low register (which rules out body
   * resonance and string noise). The lowest survivor wins.
   */
  private findBass(): number {
    let last = 0;
    let bestSalience = 0;
    for (let k = 0; k < this.gridSize; k++) {
      if (this.candidateHz[k]! > BASS_MAX_FREQUENCY_HZ) break;
      const salience = this.bassSalienceOf(this.candidateHz[k]!);
      this.bassSalience[k] = salience;
      if (salience > bestSalience) bestSalience = salience;
      last = k;
    }
    if (bestSalience <= 0) return -1;

    // Lowest *local maximum* over the threshold. Plain "lowest over the
    // threshold" lands a semitone flat: below ~150Hz a peak's tolerance window
    // is wider than a semitone, so the grid point below the real note sees the
    // same partial and, being lower, always won.
    const threshold = bestSalience * BASS_SALIENCE_RATIO;
    for (let k = 0; k <= last; k++) {
      const salience = this.bassSalience[k]!;
      if (salience < threshold) continue;
      if (k > 0 && this.bassSalience[k - 1]! > salience) continue;
      if (k < last && this.bassSalience[k + 1]! > salience) continue;
      return k;
    }
    return -1;
  }

  /**
   * Harmonic salience of a bass candidate; zero unless its own fundamental is
   * really there.
   *
   * The own-note window is tighter than the harmonic window on purpose. "A
   * partial sits near h*f" is a weak claim and wants slack; "this peak *is* the
   * note" is a strong one and must not be satisfied by the neighbour. At the
   * loose width, B2's window reaches C3, so every C chord with a B in it
   * reported a bass of B.
   */
  private bassSalienceOf(fundamentalHz: number): number {
    if (fundamentalHz < this.minFrequencyHz) return 0;
    const tolerance = Math.max(
      this.binHz * BASS_OWN_PEAK_BINS,
      fundamentalHz * (Math.pow(2, BASS_OWN_PEAK_CENTS / 1200) - 1)
    );
    const own = this.strongestPartialInRange(fundamentalHz - tolerance, fundamentalHz + tolerance);
    if (own < 0 || this.workingWeight[own]! < this.presenceThreshold) return 0;
    return this.salienceOf(fundamentalHz);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function silentResult(): ChromaResult {
  return untonalResult(0);
}

/** No notes found, but the measured tonality is still worth reporting. */
function untonalResult(salience: number): ChromaResult {
  return {
    chroma: new Float32Array(12),
    bassPitchClass: null,
    bassFrequencyHz: null,
    salience,
    polyphony: 0,
    fundamentals: [],
  };
}
