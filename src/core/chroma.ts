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
 *   3. Peak picking on the raw spectrum with parabolic interpolation (at 4096
 *      points / 48kHz a bin is 11.7Hz, coarser than a semitone below ~200Hz),
 *      weighted by whitened prominence and a compressed amplitude term.
 *   4. Sub-harmonic summation of every peak onto a semitone pitch grid, then
 *      the grid is folded to 12 pitch classes and normalised to max = 1.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the chord
 * workstream. Depends on `RealFFT` and `hannWindow` from `./fft.js`.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import { RealFFT, hannWindow } from "./fft.js";

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
};

/* -------------------------------------------------------------------------- */
/* Tuning constants                                                            */
/* -------------------------------------------------------------------------- */

const DEFAULT_MIN_FREQUENCY_HZ = 70;
const DEFAULT_MAX_FREQUENCY_HZ = 1600;
const DEFAULT_HARMONICS = 4;

/** Input RMS below this counts as silence: all-zero chroma, no bass. */
const SILENCE_RMS = 1e-6;

/** Whitening window half-width, as a fraction of the bin index (~1/4 octave). */
const ENVELOPE_RELATIVE_HALF_WIDTH = 0.25;
/** Floor on that half-width so the low bins still see a usable neighbourhood. */
const ENVELOPE_MIN_HALF_WIDTH = 8;
/** Magnitudes below this fraction of the frame peak are clamped before log(). */
const MAGNITUDE_FLOOR_RATIO = 1e-5;

/** Log-prominence (nepers) a peak must clear over its local geometric mean. */
const MIN_PEAK_PROMINENCE = 0.45;
/** Prominence saturates here, so one freak bin cannot own the whole chroma. */
const MAX_PEAK_PROMINENCE = 4;
/** Peaks quieter than this fraction of the loudest peak are dropped outright. */
const MIN_PEAK_AMPLITUDE_RATIO = 2e-3;
/** Compression on a peak's relative amplitude; 0 = pure whitening, 1 = none. */
const AMPLITUDE_EXPONENT = 0.25;
/** Per-step decay of the sub-harmonic fold (h = 1 is the peak itself). */
const HARMONIC_DECAY = 0.6;

/** Lowest / highest MIDI note treated as a plausible fundamental. */
const GRID_MIN_MIDI = 36; // C2, 65.4Hz
const GRID_MAX_MIDI = 88; // E6, 1318.5Hz

/** Bass search is limited to this range; a guitar's lowest string is 82.4Hz. */
const BASS_MAX_FREQUENCY_HZ = 400;
/** A bass candidate must carry at least this fraction of the strongest weight. */
const BASS_MIN_WEIGHT_RATIO = 0.12;
/** How close (in cents) a partial must sit to h*f to count as harmonic support. */
const BASS_HARMONIC_TOLERANCE_CENTS = 55;
/** Harmonics of h = 2..4 that must be present before a peak can be the bass. */
const BASS_MIN_HARMONIC_SUPPORT = 2;

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
 * Contrast exponent applied to the normalised chroma.
 *
 * Sub-harmonic summation leaves a haze of overtone leakage in the non-chord
 * bins (a C5 power chord picks up D from G3's third harmonic and E from C3's
 * fifth). Without this the whole chord dictionary scores within ~0.01 of the
 * right answer and *everything* fails the margin rule. Raising the chroma to a
 * power leaves max = 1 and the ranking intact, but pushes the leakage down so
 * the margin measures something real.
 */
const CHROMA_CONTRAST = 2;

/** Chroma bins at or above this fraction of the max count towards polyphony. */
const POLYPHONY_THRESHOLD = 0.45;

const A4_HZ = 440;
const A4_MIDI = 69;
const LN2 = Math.LN2;

/* -------------------------------------------------------------------------- */

function midiFromHz(hz: number): number {
  return A4_MIDI + 12 * (Math.log(hz / A4_HZ) / LN2);
}

export class ChromaAnalyzer {
  /** Number of samples `analyze()` expects. Equals `fftSize`. */
  readonly windowSize: number;

  private readonly sampleRate: number;
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

  private readonly grid: Float64Array;
  private readonly gridSize: number;
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
    this.sampleRate = sampleRate;
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

    this.gridSize = GRID_MAX_MIDI - GRID_MIN_MIDI + 1;
    this.grid = new Float64Array(this.gridSize);
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
    this.whiten(maxMagnitude);
    this.collectPeaks();
    if (this.peakCount === 0) {
      return { chroma: new Float32Array(12), bassPitchClass: null, bassFrequencyHz: null, salience, polyphony: 0 };
    }

    const chroma = this.foldToChroma();
    const bassIndex = this.findBass();
    const bassFrequencyHz = bassIndex < 0 ? null : this.peakHz[bassIndex]!;
    const bassPitchClass =
      bassFrequencyHz === null ? null : pitchClassOfHz(bassFrequencyHz);

    return {
      chroma,
      bassPitchClass,
      bassFrequencyHz,
      salience,
      polyphony: countChromaPeaks(chroma),
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
  }

  /**
   * Sub-harmonic summation: every peak votes for f/h as a fundamental, with a
   * decaying weight, spread across the two nearest semitones by a cos^2 window
   * (a partition of unity, so no energy is created or lost). The semitone grid
   * is then folded to 12 pitch classes.
   */
  private foldToChroma(): Float32Array {
    this.grid.fill(0);

    for (let p = 0; p < this.peakCount; p++) {
      const hz = this.peakHz[p]!;
      const weight = this.peakWeight[p]!;
      if (!(weight > 0)) continue;

      for (let h = 1; h <= this.harmonics; h++) {
        const fundamental = hz / h;
        if (fundamental < this.minFrequencyHz) break;

        const midi = midiFromHz(fundamental) - GRID_MIN_MIDI;
        if (midi < -0.5 || midi > this.gridSize - 0.5) continue;

        const contribution = weight * this.harmonicWeights[h - 1]!;
        const lower = Math.floor(midi);
        const fraction = midi - lower;
        // cos^2(pi/2 * d) + cos^2(pi/2 * (1 - d)) === 1.
        const lowerShare = Math.cos((Math.PI / 2) * fraction) ** 2;
        if (lower >= 0 && lower < this.gridSize) {
          this.grid[lower] = this.grid[lower]! + contribution * lowerShare;
        }
        const upper = lower + 1;
        if (upper >= 0 && upper < this.gridSize) {
          this.grid[upper] = this.grid[upper]! + contribution * (1 - lowerShare);
        }
      }
    }

    const chroma = new Float32Array(12);
    this.octaveFold.fill(0);
    for (let k = 0; k < this.gridSize; k++) {
      const value = this.grid[k]!;
      if (value <= 0) continue;
      const pitchClass = (((GRID_MIN_MIDI + k) % 12) + 12) % 12;
      this.octaveFold[pitchClass] =
        this.octaveFold[pitchClass]! + Math.pow(value, OCTAVE_FOLD_POWER);
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
   * The lowest peak that is plausibly a fundamental rather than somebody
   * else's overtone: strong enough, and with at least two of its own harmonics
   * actually present in the spectrum.
   */
  private findBass(): number {
    let maxWeight = 0;
    for (let p = 0; p < this.peakCount; p++) {
      const w = this.peakWeight[p]!;
      if (w > maxWeight) maxWeight = w;
    }
    if (maxWeight <= 0) return -1;

    const minWeight = maxWeight * BASS_MIN_WEIGHT_RATIO;
    let fallback = -1;

    for (let p = 0; p < this.peakCount; p++) {
      const hz = this.peakHz[p]!;
      if (hz > BASS_MAX_FREQUENCY_HZ) break;
      if (this.peakWeight[p]! < minWeight) continue;

      let support = 0;
      for (let h = 2; h <= 4; h++) {
        if (this.hasPartialNear(hz * h)) support++;
      }
      if (support >= BASS_MIN_HARMONIC_SUPPORT) return p;
      if (fallback < 0 && support >= 1 && this.peakWeight[p]! >= maxWeight * 0.35) {
        fallback = p;
      }
    }
    return fallback;
  }

  /** Is there a surviving peak within `BASS_HARMONIC_TOLERANCE_CENTS` of `hz`? */
  private hasPartialNear(hz: number): boolean {
    if (hz > this.maxFrequencyHz) return false;
    const ratio = Math.pow(2, BASS_HARMONIC_TOLERANCE_CENTS / 1200);
    const lo = hz / ratio;
    const hi = hz * ratio;
    for (let p = 0; p < this.peakCount; p++) {
      const f = this.peakHz[p]!;
      if (f > hi) return false;
      if (f >= lo) return true;
    }
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function silentResult(): ChromaResult {
  return {
    chroma: new Float32Array(12),
    bassPitchClass: null,
    bassFrequencyHz: null,
    salience: 0,
    polyphony: 0,
  };
}

function pitchClassOfHz(hz: number): number {
  const midi = Math.round(midiFromHz(hz));
  return (((midi % 12) + 12) % 12);
}

/** Circular local maxima of the normalised chroma above `POLYPHONY_THRESHOLD`. */
function countChromaPeaks(chroma: Float32Array): number {
  let count = 0;
  for (let i = 0; i < 12; i++) {
    const value = chroma[i]!;
    if (value < POLYPHONY_THRESHOLD) continue;
    const previous = chroma[(i + 11) % 12]!;
    const next = chroma[(i + 1) % 12]!;
    if (value > previous && value >= next) count++;
  }
  return count;
}
