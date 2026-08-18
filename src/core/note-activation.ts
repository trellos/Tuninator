/**
 * Multi-pitch note activation by non-negative least squares.
 *
 * One window of audio in, "how much of each note is sounding?" out — for every
 * semitone on the instrument at once, rather than picking notes off the
 * spectrum one at a time.
 *
 * WHY IT REPLACED GREEDY CANCELLATION
 *
 * The previous estimator scored each candidate fundamental by summing the
 * whitened partials on its harmonics, took the winner, attenuated every partial
 * that winner explained, and repeated. That is greedy, and on a guitar it is
 * greedy in exactly the wrong direction, because the fifth harmonic of a root
 * IS its major third, two octaves up. Measured on the cowboy-chords D bar at
 * 7000ms, where D3 A3 D4 F#4 are all ringing:
 *
 *   - F#4's own fundamental at 368Hz carries 7.5% of the frame's peak
 *     amplitude, sitting inside D4's skirt, so its prominence is 0.13 -- under
 *     the presence threshold, hence invisible.
 *   - F#5, its second harmonic, is loud and unambiguous at 738Hz... and D3's
 *     fifth harmonic is 736.5Hz. Whichever note is extracted first claims it,
 *     and D3 always is.
 *   - C#6, its third harmonic at 1104Hz, is A3's fifth harmonic at 1101Hz.
 *     Same story.
 *
 * So F#4 scored exactly zero, the chroma read {D, A}, and a D major chord could
 * only ever come out as D5 -- or, because the open A string put the bass on A,
 * as Asus4. No threshold fixes that: the third's evidence really is shared with
 * the root's, and first-come-first-served is the wrong model of sharing.
 *
 * NNLS solves for every note jointly instead. It asks which non-negative
 * combination of note profiles best reconstructs the observed spectrum, so a
 * partial two notes both predict is divided by how well each one's WHOLE series
 * explains the rest of the frame. D3 does not get to claim 738Hz outright; it
 * gets the share its own fundamental and lower harmonics earn, and the surplus
 * D3 cannot account for goes to F#4, which predicted that partial too.
 *
 * This is Mauch & Dixon's NNLS Chroma ("Approximate note transcription for the
 * improved identification of difficult chords", ISMIR 2010), with the solver
 * expressed as Lee & Seung multiplicative updates.
 *
 * SHAPE
 *
 *   1. Hann window -> magnitude spectrum.
 *   2. Peaks: local maxima, parabolically interpolated, kept only where they
 *      stand clear of the local noise floor.
 *   3. Those peaks are re-rendered as an idealised spectrum, using the same
 *      kernel the dictionary uses. Target and dictionary then live in one
 *      domain, so a note is scored on partials that are really there and is
 *      charged for partials it predicts that are not.
 *   4. NNLS against a dictionary with one column per semitone, each column a
 *      geometrically decaying harmonic comb.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import { RealFFT, hannWindow } from "./fft.js";

export type NoteActivationOptions = {
  sampleRate: number;
  fftSize: number;
  /** Lowest note in the dictionary. Default 36 (C2, 65.4Hz). */
  minMidi?: number;
  /** Highest note in the dictionary. Default 88 (E6, 1318.5Hz). */
  maxMidi?: number;
  /** Harmonics per dictionary column. Default 12. */
  harmonics?: number;
  /** Partials above this are neither measured nor modelled. Default 3000Hz. */
  spectrumMaxHz?: number;
  /** Partials below this are neither measured nor modelled. Default 60Hz. */
  spectrumMinHz?: number;
  /** Per-harmonic amplitude decay in a column: `decay^(h-1)`. Default 0.8. */
  harmonicDecay?: number;
  /**
   * Spectral-envelope variants per note. 1 models every string as having its
   * strongest partial at the fundamental. Default 3.
   */
  envelopes?: number;
  /**
   * Half-width of the window in which a note's own fundamental must show a
   * peak before the note may be activated at all. Cents. 0 disables the gate.
   * Default 45.
   */
  fundamentalGateCents?: number;
  /**
   * How large that fundamental peak must be next to the largest peak on the
   * note's own harmonics. 0 accepts any peak at all. Default 0.05.
   */
  fundamentalMinRatio?: number;
  /** Multiplicative-update passes. Default 60. */
  iterations?: number;
  /** Exponent applied to peak amplitudes before fitting. Default 0.5. */
  magnitudeExponent?: number;
  /**
   * L1 penalty, as a fraction of the frame's largest correlation. Larger is
   * sparser. Default 0.
   *
   * It does what it says — swept on the D bar it takes the phantom E5 from 37%
   * of peak down to 15% — but it takes the real third down with it, from 25% to
   * 19%, and across the five fixtures nothing between 0 and 0.1 changes a
   * single named event. Left available and left off: no policy chooses it,
   * because on this material there is nothing to choose.
   */
  sparsity?: number;
};

const DEFAULT_MIN_MIDI = 36;
const DEFAULT_MAX_MIDI = 88;
const DEFAULT_HARMONICS = 12;
const DEFAULT_SPECTRUM_MAX_HZ = 3000;
const DEFAULT_SPECTRUM_MIN_HZ = 60;
const DEFAULT_HARMONIC_DECAY = 0.8;
const DEFAULT_ENVELOPES = 3;
const DEFAULT_FUNDAMENTAL_GATE_CENTS = 45;
const DEFAULT_FUNDAMENTAL_MIN_RATIO = 0.05;
const DEFAULT_ITERATIONS = 60;
const DEFAULT_MAGNITUDE_EXPONENT = 0.5;
const DEFAULT_SPARSITY = 0;

/** Input RMS below this counts as silence. */
const SILENCE_RMS = 1e-6;

/**
 * Half-width of a partial's footprint, in bins and in cents.
 *
 * Two terms for two reasons. A Hann main lobe is four bins wide whatever the
 * frequency, which is the bin term. Guitar strings are inharmonic and rarely
 * exactly in tune, and both errors scale with frequency, which is the cent
 * term: at the twelfth harmonic a 0.3% stiffness stretch is several bins.
 */
const KERNEL_MIN_HALF_BINS = 1.3;
const KERNEL_HALF_CENTS = 30;

/** Block size for the running-minimum noise floor. Bins. */
const FLOOR_BLOCK = 8;
/** Noise-floor window half-width, as a fraction of the bin index. */
const FLOOR_RELATIVE_HALF_WIDTH = 0.35;
/** Floor on that half-width, so low bins still see a usable neighbourhood. */
const FLOOR_MIN_HALF_WIDTH = 8;
/** A peak must stand this many times clear of its local noise floor. */
const MIN_PEAK_FLOOR_RATIO = 1.6;
/**
 * Bins either side a local maximum must lead before it counts as a partial.
 *
 * 1 — a bare local maximum. Widening it is tempting, because hiss produces a
 * maximum every second or third bin and the running-minimum noise floor, which
 * exists precisely so a quiet partial beside a loud one survives, is by
 * construction too low to reject them. But real partials are not as isolated as
 * the textbook four-bin main lobe suggests: at 2 the five fixtures lose two
 * named events (56 -> 54) and gain four spurious ones, because a genuine
 * partial standing two bins from a louder one is common in a strummed chord.
 * Noise rejection is left to `MIN_PEAK_FLOOR_RATIO` and the tonality gate.
 */
const PEAK_DOMINANCE_BINS = 1;
/** ...and must carry at least this fraction of the frame's largest peak. */
const MIN_PEAK_AMPLITUDE_RATIO = 0.004;

/** Guard on the multiplicative update's denominator. */
const UPDATE_EPSILON = 1e-12;

/**
 * How hard each envelope variant leans on the low partials.
 *
 * Variant 0 is the textbook plucked string, loudest at the fundamental.
 * Variants 1 and 2 progressively suppress the low harmonics, because a real
 * guitar's low strings do not obey the textbook: on the cowboy-chords D bar the
 * open A string reads 0.023 of frame peak at 110Hz and 0.122 at its third
 * harmonic -- five times its own fundamental, where a decaying model predicts
 * two thirds of it. With only the textbook variant the solver cannot express
 * that string at all, and the excess at 330Hz gets explained by inventing an E4
 * that nobody played, which is enough to turn a D into a Dsus2.
 *
 * All variants of a note sum into that note's single activation, so the extra
 * columns buy timbre flexibility without ever inventing a pitch.
 */
const ENVELOPE_LOW_HARMONIC_SCALE: readonly (readonly number[])[] = [
  [1],
  [0.4],
  [0.15, 0.5],
];

export type NoteActivationResult = {
  /**
   * Activation per semitone, index 0 = `minMidi`. Non-negative.
   *
   * Live view of the analyzer's own buffer: valid until the next `analyze()`.
   */
  activation: Float64Array;
  /** Largest entry of `activation`, or 0. */
  peakActivation: number;
  /** 0..1 measure of how tonal (vs. noisy) the spectrum is. */
  salience: number;
  /** Peaks that survived the noise floor. Diagnostic. */
  peakCount: number;
};

export class NoteActivation {
  /** Number of samples `analyze()` expects. Equals `fftSize`. */
  readonly windowSize: number;
  readonly minMidi: number;
  readonly maxMidi: number;
  readonly noteCount: number;

  /** Envelope variants per note. Columns are `noteCount * envelopes`. */
  readonly envelopes: number;

  private readonly iterations: number;
  private readonly magnitudeExponent: number;
  private readonly sparsityFactor: number;
  private readonly fundamentalGateCents: number;
  private readonly fundamentalMinRatio: number;
  private readonly gateHarmonics: number;
  private readonly spectrumMaxHz: number;

  private readonly fft: RealFFT;
  private readonly bins: number;
  private readonly binHz: number;
  private readonly minBin: number;
  private readonly maxBin: number;

  private readonly hann: Float32Array;
  private readonly windowed: Float32Array;
  private readonly magnitude: Float32Array;
  private readonly logMagnitude: Float64Array;
  /** Per-block minima of `magnitude`, for the running-minimum noise floor. */
  private readonly blockMinimum: Float64Array;
  /** Idealised spectrum re-rendered from the detected peaks: the NNLS target. */
  private readonly target: Float64Array;

  /*
   * Dictionary in compressed-column form. Column k occupies
   * `entryBin`/`entryWeight` over `[columnStart[k], columnStart[k + 1])`.
   * Dense would be 53 x 2049 doubles for a 4096-point frame, 99% of it zero,
   * and every solver pass would walk all of it.
   */
  private readonly columnStart: Int32Array;
  private readonly entryBin: Int32Array;
  private readonly entryWeight: Float64Array;

  /** Per-note output: variant activations summed. Length `noteCount`. */
  private readonly activation: Float64Array;
  /** Per-column solver state. Length `noteCount * envelopes`. */
  private readonly columnActivation: Float64Array;
  private readonly correlation: Float64Array;
  private readonly gradient: Float64Array;
  private readonly reconstruction: Float64Array;
  /** Interpolated frequency of each surviving peak, ascending. */
  private readonly peakHz: Float64Array;
  /**
   * Amplitude of each surviving peak as a fraction of the frame's largest,
   * BEFORE `magnitudeExponent` is applied. Only the gate reads this.
   */
  private readonly peakAmplitude: Float64Array;
  private peakCount = 0;
  /** Per note: does a peak sit on its fundamental this frame? */
  private readonly fundamentalPresent: Uint8Array;

  constructor(options: NoteActivationOptions) {
    const { sampleRate, fftSize } = options;
    if (!(sampleRate > 0)) {
      throw new Error(`NoteActivation: sampleRate must be > 0, got ${sampleRate}`);
    }
    if (!(fftSize > 0)) {
      throw new Error(`NoteActivation: fftSize must be > 0, got ${fftSize}`);
    }

    this.windowSize = fftSize;
    this.minMidi = Math.round(options.minMidi ?? DEFAULT_MIN_MIDI);
    this.maxMidi = Math.round(options.maxMidi ?? DEFAULT_MAX_MIDI);
    if (this.maxMidi < this.minMidi) {
      throw new Error(
        `NoteActivation: maxMidi (${this.maxMidi}) must be >= minMidi (${this.minMidi})`
      );
    }
    this.noteCount = this.maxMidi - this.minMidi + 1;

    this.iterations = Math.max(1, Math.round(options.iterations ?? DEFAULT_ITERATIONS));
    this.magnitudeExponent = options.magnitudeExponent ?? DEFAULT_MAGNITUDE_EXPONENT;
    this.sparsityFactor = Math.max(0, options.sparsity ?? DEFAULT_SPARSITY);
    this.fundamentalGateCents = Math.max(
      0,
      options.fundamentalGateCents ?? DEFAULT_FUNDAMENTAL_GATE_CENTS
    );
    this.fundamentalMinRatio = Math.max(
      0,
      options.fundamentalMinRatio ?? DEFAULT_FUNDAMENTAL_MIN_RATIO
    );
    this.envelopes = Math.max(
      1,
      Math.min(
        ENVELOPE_LOW_HARMONIC_SCALE.length,
        Math.round(options.envelopes ?? DEFAULT_ENVELOPES)
      )
    );

    this.fft = new RealFFT(fftSize);
    this.bins = this.fft.bins;
    this.binHz = sampleRate / fftSize;

    const spectrumMaxHz = Math.min(
      options.spectrumMaxHz ?? DEFAULT_SPECTRUM_MAX_HZ,
      sampleRate / 2
    );
    const spectrumMinHz = Math.max(options.spectrumMinHz ?? DEFAULT_SPECTRUM_MIN_HZ, 1);
    this.minBin = Math.max(1, Math.floor(spectrumMinHz / this.binHz));
    this.maxBin = Math.min(this.bins - 2, Math.ceil(spectrumMaxHz / this.binHz));

    this.hann = hannWindow(fftSize);
    this.windowed = new Float32Array(fftSize);
    this.magnitude = new Float32Array(this.bins);
    this.logMagnitude = new Float64Array(this.bins);
    this.blockMinimum = new Float64Array(Math.ceil(this.bins / FLOOR_BLOCK));
    this.target = new Float64Array(this.bins);

    const columns = this.noteCount * this.envelopes;
    this.activation = new Float64Array(this.noteCount);
    this.columnActivation = new Float64Array(columns);
    this.correlation = new Float64Array(columns);
    this.gradient = new Float64Array(columns);
    this.reconstruction = new Float64Array(this.bins);
    this.peakHz = new Float64Array(this.bins);
    this.peakAmplitude = new Float64Array(this.bins);
    this.fundamentalPresent = new Uint8Array(this.noteCount);

    this.spectrumMaxHz = spectrumMaxHz;
    this.gateHarmonics = Math.max(1, Math.round(options.harmonics ?? DEFAULT_HARMONICS));

    const built = buildDictionary({
      noteCount: this.noteCount,
      envelopes: this.envelopes,
      minMidi: this.minMidi,
      binHz: this.binHz,
      minBin: this.minBin,
      maxBin: this.maxBin,
      harmonics: this.gateHarmonics,
      decay: options.harmonicDecay ?? DEFAULT_HARMONIC_DECAY,
      spectrumMaxHz,
    });
    this.columnStart = built.columnStart;
    this.entryBin = built.entryBin;
    this.entryWeight = built.entryWeight;
  }

  /** MIDI note number of activation index `k`. */
  midiOf(k: number): number {
    return this.minMidi + k;
  }

  /** `window.length` must equal `windowSize`. Applies its own Hann window. */
  analyze(window: Float32Array): NoteActivationResult {
    if (window.length !== this.windowSize) {
      throw new Error(
        `NoteActivation.analyze: expected ${this.windowSize} samples, got ${window.length}`
      );
    }

    let sumSquares = 0;
    for (let i = 0; i < window.length; i++) {
      const s = window[i]!;
      sumSquares += s * s;
      this.windowed[i] = s * this.hann[i]!;
    }
    if (!(Math.sqrt(sumSquares / window.length) > SILENCE_RMS)) return this.emptyResult(0, 0);

    this.fft.magnitudes(this.windowed, this.magnitude);

    const salience = this.computeSalience();
    const peakCount = this.buildTarget();
    if (peakCount === 0) return this.emptyResult(salience, 0);

    const peakActivation = this.solve();
    return { activation: this.activation, peakActivation, salience, peakCount };
  }

  /* ------------------------------------------------------------------ */

  private emptyResult(salience: number, peakCount: number): NoteActivationResult {
    this.activation.fill(0);
    return { activation: this.activation, peakActivation: 0, salience, peakCount };
  }

  /**
   * Tonalness as `1 - spectral flatness` over the modelled band. A sine is near
   * 1, white noise near 0. Callers use it to refuse to name a chord in noise.
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
    const flatness = Math.exp(sumLog / count) / (sum / count);
    return Math.max(0, Math.min(1, 1 - flatness));
  }

  /**
   * Detects peaks and re-renders them into `target` with the dictionary's own
   * kernel. Returns how many peaks survived.
   *
   * Re-rendering rather than fitting the raw spectrum is what makes the fit
   * well posed. A raw magnitude spectrum is mostly window leakage — every
   * strong partial spreads a skirt over its whole neighbourhood — and a
   * twelve-harmonic comb is very good at soaking leakage up. Measured before
   * this step existed, the top activation on the D bar was D2, a note nobody
   * played and a guitar cannot reach: a D major chord is approximately the
   * harmonic series of D2, so a comb laid over it explains almost everything.
   * What rules D2 out is that there is no PEAK at 73Hz, and only a target built
   * from peaks can charge it for predicting one.
   */
  private buildTarget(): number {
    this.target.fill(0);

    let framePeak = 0;
    for (let i = this.minBin; i <= this.maxBin; i++) {
      const m = this.magnitude[i]!;
      if (m > framePeak) framePeak = m;
    }
    if (!(framePeak > 0)) return 0;

    for (let i = 0; i < this.bins; i++) {
      this.logMagnitude[i] = Math.log(Math.max(this.magnitude[i]!, framePeak * 1e-9));
    }
    this.computeNoiseFloor();

    const compress = this.magnitudeExponent !== 1;
    const amplitudeFloor = framePeak * MIN_PEAK_AMPLITUDE_RATIO;
    let count = 0;

    for (let i = this.minBin; i <= this.maxBin; i++) {
      const m = this.magnitude[i]!;
      if (m < amplitudeFloor) continue;
      if (m < this.noiseFloorAt(i) * MIN_PEAK_FLOOR_RATIO) continue;
      if (!this.dominatesNeighbourhood(i, m)) continue;

      // Parabolic interpolation over log magnitudes: exact for a Gaussian peak,
      // and close enough for a Hann main lobe. Sub-bin position matters most
      // exactly where the FFT is weakest -- at 11.7Hz bins a low D is two thirds
      // of a semitone wide, so without this the bass lands on the wrong note.
      const a = this.logMagnitude[i - 1]!;
      const b = this.logMagnitude[i]!;
      const c = this.logMagnitude[i + 1]!;
      const denominator = a - 2 * b + c;
      let delta = denominator !== 0 ? (0.5 * (a - c)) / denominator : 0;
      if (!(delta > -0.5) || !(delta < 0.5)) delta = 0;

      const centre = i + delta;
      // Kept uncompressed for the gate: the gate compares a fundamental with
      // its own harmonics, and compression is exactly what would hide the
      // difference it is looking for.
      const relative = Math.exp(b - 0.25 * (a - c) * delta) / framePeak;
      const amplitude = compress ? Math.pow(relative, this.magnitudeExponent) : relative;

      const halfWidth = kernelHalfWidth(centre);
      const lo = Math.max(0, Math.ceil(centre - halfWidth));
      const hi = Math.min(this.bins - 1, Math.floor(centre + halfWidth));
      for (let bin = lo; bin <= hi; bin++) {
        this.target[bin] = this.target[bin]! + amplitude * raisedCosine(bin - centre, halfWidth);
      }
      this.peakHz[count] = centre * this.binHz;
      this.peakAmplitude[count] = relative;
      count++;
    }
    this.peakCount = count;
    this.markPresentFundamentals();
    return count;
  }

  /**
   * Flags the notes whose own fundamental shows a peak this frame.
   *
   * A plucked string in this register always puts energy at its fundamental,
   * and requiring it is what rules out the sub-harmonic phantoms that no
   * amount of least-squares tuning removes. A D major chord is approximately
   * the harmonic series of D2, so D2's twelve-harmonic comb explains every
   * peak the chord produces except one -- its own, at 73Hz, which is not there
   * and which a guitar cannot even play. Before this gate D2 was the top
   * activation on that bar, ahead of the four notes actually being fretted.
   *
   * Presence alone is not enough, which is why there is a ratio as well.
   * Recordings have rumble, and a peak of a few thousandths at 82Hz is enough
   * to unlock E2 — whose third harmonic is B3, so on a Bm strum E2's comb
   * covers the chord and the phantom returns through the back door. The
   * fundamental has to be a plausible SIZE for the harmonics the note is
   * claiming, not merely non-zero. The dictionary's flattest envelope already
   * says the fundamental may be a quarter of the third harmonic; the ratio here
   * is far below that, so it rejects only what no string does.
   */
  private markPresentFundamentals(): void {
    if (this.fundamentalGateCents <= 0) {
      this.fundamentalPresent.fill(1);
      return;
    }
    const ratio = Math.pow(2, this.fundamentalGateCents / 1200);
    for (let k = 0; k < this.noteCount; k++) {
      const fundamental = 440 * Math.pow(2, (this.minMidi + k - 69) / 12);
      // Bin quantisation is worth more than the cent window down here: at
      // 11.7Hz bins a low D is two thirds of a semitone wide.
      const slack = Math.max(fundamental * (ratio - 1), this.binHz * 0.75);
      const own = this.peakAmplitudeNear(fundamental, slack);
      if (own <= 0) {
        this.fundamentalPresent[k] = 0;
        continue;
      }
      if (this.fundamentalMinRatio <= 0) {
        this.fundamentalPresent[k] = 1;
        continue;
      }

      let strongest = own;
      for (let h = 2; h <= this.gateHarmonics; h++) {
        const hz = fundamental * h;
        if (hz > this.spectrumMaxHz) break;
        const partial = this.peakAmplitudeNear(hz, Math.max(hz * (ratio - 1), this.binHz * 0.75));
        if (partial > strongest) strongest = partial;
      }
      this.fundamentalPresent[k] = own >= strongest * this.fundamentalMinRatio ? 1 : 0;
    }
  }

  /**
   * Amplitude of the strongest peak within `slack` Hz of `hz`, or 0.
   * Peaks are ascending in frequency, so the window is found by bisection.
   */
  private peakAmplitudeNear(hz: number, slack: number): number {
    let left = 0;
    let right = this.peakCount;
    while (left < right) {
      const mid = (left + right) >> 1;
      if (this.peakHz[mid]! < hz - slack) left = mid + 1;
      else right = mid;
    }
    let best = 0;
    for (let p = left; p < this.peakCount; p++) {
      if (this.peakHz[p]! > hz + slack) break;
      if (this.peakAmplitude[p]! > best) best = this.peakAmplitude[p]!;
    }
    return best;
  }

  /** True when bin `i` leads every bin within `PEAK_DOMINANCE_BINS`. */
  private dominatesNeighbourhood(i: number, m: number): boolean {
    const lo = Math.max(1, i - PEAK_DOMINANCE_BINS);
    const hi = Math.min(this.bins - 2, i + PEAK_DOMINANCE_BINS);
    // Ties go to the lower bin, so a two-bin plateau yields one peak, not none.
    for (let k = lo; k < i; k++) if (this.magnitude[k]! >= m) return false;
    for (let k = i + 1; k <= hi; k++) if (this.magnitude[k]! > m) return false;
    return true;
  }

  /** Minima of fixed blocks of bins, for `noiseFloorAt`. */
  private computeNoiseFloor(): void {
    const blocks = this.blockMinimum.length;
    for (let b = 0; b < blocks; b++) {
      const lo = b * FLOOR_BLOCK;
      const hi = Math.min(this.bins, lo + FLOOR_BLOCK);
      let minimum = Infinity;
      for (let i = lo; i < hi; i++) {
        const m = this.magnitude[i]!;
        if (m < minimum) minimum = m;
      }
      this.blockMinimum[b] = minimum;
    }
  }

  /**
   * Local noise floor: the running MINIMUM over a proportional-bandwidth
   * window, to within one block.
   *
   * A minimum, not any kind of average, and that is load-bearing. Every
   * averaging estimator measures how much energy is in a neighbourhood rather
   * than how little, so where partials are dense it rises to meet them and eats
   * the quietest real partial in the region. Around F#4 in the cowboy-chords D
   * bar the quarter-octave window also holds D4, E4 and A4, and its geometric
   * mean is 0.066 of the frame peak against F#4's own 0.075 -- the third would
   * be rejected as noise. The floor beneath those peaks is two orders of
   * magnitude lower, and that is what a minimum returns.
   */
  private noiseFloorAt(i: number): number {
    const half = Math.max(FLOOR_MIN_HALF_WIDTH, Math.round(i * FLOOR_RELATIVE_HALF_WIDTH));
    const firstBlock = (Math.max(0, i - half) / FLOOR_BLOCK) | 0;
    const lastBlock = (Math.min(this.bins - 1, i + half) / FLOOR_BLOCK) | 0;
    let minimum = Infinity;
    for (let b = firstBlock; b <= lastBlock; b++) {
      const v = this.blockMinimum[b]!;
      if (v < minimum) minimum = v;
    }
    return minimum;
  }

  /**
   * Lee & Seung multiplicative updates for `min ||target - E x||^2, x >= 0`:
   *
   *     x <- x * (E^T target) / (E^T E x + lambda)
   *
   * Every factor is non-negative, so `x` never leaves the feasible set and no
   * projection step is needed. The objective is convex and the update is
   * monotonic in it, which is why a fixed iteration count is safe: stopping
   * early gives a worse fit, never a diverging one.
   *
   * `x` starts at the correlation rather than at ones. A multiplicative update
   * cannot resurrect a zero and moves slowly from a bad start, and the
   * correlation is already the right shape -- it is the greedy answer, which the
   * iterations then correct wherever notes overlap.
   */
  private solve(): number {
    const start = this.columnStart;
    const bin = this.entryBin;
    const weight = this.entryWeight;
    const target = this.target;
    const x = this.columnActivation;
    const correlation = this.correlation;
    const gradient = this.gradient;
    const reconstruction = this.reconstruction;
    const columns = this.noteCount * this.envelopes;

    let maxCorrelation = 0;
    for (let c = 0; c < columns; c++) {
      if (this.fundamentalPresent[(c / this.envelopes) | 0] === 0) {
        correlation[c] = 0;
        continue;
      }
      let dot = 0;
      for (let e = start[c]!; e < start[c + 1]!; e++) dot += weight[e]! * target[bin[e]!]!;
      correlation[c] = dot > 0 ? dot : 0;
      if (dot > maxCorrelation) maxCorrelation = dot;
    }
    if (!(maxCorrelation > 0)) {
      this.activation.fill(0);
      return 0;
    }

    // A column that correlates at all starts in play; one that does not starts
    // at a floor small enough to be irrelevant but non-zero, so the solver can
    // still recruit it if the residual demands it. A gated-out column starts at
    // zero and, because the update is multiplicative, can never leave it.
    const seed = maxCorrelation * 1e-6;
    for (let c = 0; c < columns; c++) {
      x[c] = correlation[c]! > 0 ? Math.max(correlation[c]!, seed) : 0;
    }

    const lambda = this.sparsityFactor * maxCorrelation;

    for (let iteration = 0; iteration < this.iterations; iteration++) {
      reconstruction.fill(0);
      for (let c = 0; c < columns; c++) {
        const xc = x[c]!;
        if (xc === 0) continue;
        for (let e = start[c]!; e < start[c + 1]!; e++) {
          const b = bin[e]!;
          reconstruction[b] = reconstruction[b]! + weight[e]! * xc;
        }
      }
      for (let c = 0; c < columns; c++) {
        if (x[c] === 0) continue;
        let dot = 0;
        for (let e = start[c]!; e < start[c + 1]!; e++) {
          dot += weight[e]! * reconstruction[bin[e]!]!;
        }
        gradient[c] = dot;
      }
      for (let c = 0; c < columns; c++) {
        if (x[c] === 0) continue;
        x[c] = x[c]! * (correlation[c]! / (gradient[c]! + lambda + UPDATE_EPSILON));
      }
    }

    let peak = 0;
    for (let k = 0; k < this.noteCount; k++) {
      let sum = 0;
      for (let v = 0; v < this.envelopes; v++) sum += x[k * this.envelopes + v]!;
      this.activation[k] = sum;
      if (sum > peak) peak = sum;
    }
    return peak;
  }
}

/* -------------------------------------------------------------------------- */

/** Half-width of a partial's footprint, in bins, at fractional bin `centre`. */
function kernelHalfWidth(centre: number): number {
  return Math.max(KERNEL_MIN_HALF_BINS, centre * (Math.pow(2, KERNEL_HALF_CENTS / 1200) - 1));
}

/** 1 at the partial, 0 at the edges of its footprint, smooth in between. */
function raisedCosine(offset: number, halfWidth: number): number {
  if (offset <= -halfWidth || offset >= halfWidth) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * offset) / halfWidth));
}

type DictionarySpec = {
  noteCount: number;
  envelopes: number;
  minMidi: number;
  binHz: number;
  minBin: number;
  maxBin: number;
  harmonics: number;
  decay: number;
  spectrumMaxHz: number;
};

/**
 * `envelopes` columns per semitone: a decaying harmonic comb, each partial
 * smeared over the bins it really occupies, the whole column normalised to unit
 * length. Column index is `note * envelopes + variant`.
 *
 * Unit norm is what makes activations comparable between columns. Without it a
 * low note -- whose comb fits every harmonic under the band limit -- would
 * outscore a high note with three, purely for having more places to look.
 */
function buildDictionary(spec: DictionarySpec): {
  columnStart: Int32Array;
  entryBin: Int32Array;
  entryWeight: Float64Array;
} {
  const { noteCount, envelopes, minMidi, binHz, minBin, maxBin, harmonics, decay, spectrumMaxHz } =
    spec;
  const columns = noteCount * envelopes;
  const columnStart = new Int32Array(columns + 1);
  const entryBin: number[] = [];
  const entryWeight: number[] = [];

  // Scratch, indexed by bin, so overlapping harmonics of one note accumulate
  // instead of overwriting. Cleared per column via `touched`.
  const accumulator = new Float64Array(maxBin + 2);
  const touched: number[] = [];

  for (let k = 0; k < noteCount; k++) {
    const fundamental = 440 * Math.pow(2, (minMidi + k - 69) / 12);

    for (let v = 0; v < envelopes; v++) {
      columnStart[k * envelopes + v] = entryBin.length;
      for (const bin of touched) accumulator[bin] = 0;
      touched.length = 0;

      const lowScale = ENVELOPE_LOW_HARMONIC_SCALE[v]!;
      for (let h = 1; h <= harmonics; h++) {
        const hz = fundamental * h;
        if (hz > spectrumMaxHz) break;
        const centre = hz / binHz;
        if (centre > maxBin) break;

        const halfWidth = kernelHalfWidth(centre);
        const amplitude = Math.pow(decay, h - 1) * (lowScale[h - 1] ?? 1);
        const lo = Math.max(minBin, Math.ceil(centre - halfWidth));
        const hi = Math.min(maxBin, Math.floor(centre + halfWidth));
        for (let i = lo; i <= hi; i++) {
          const value = amplitude * raisedCosine(i - centre, halfWidth);
          if (value <= 0) continue;
          if (accumulator[i] === 0) touched.push(i);
          accumulator[i] = accumulator[i]! + value;
        }
      }

      touched.sort((a, b) => a - b);
      let norm = 0;
      for (const bin of touched) norm += accumulator[bin]! * accumulator[bin]!;
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (const bin of touched) {
          entryBin.push(bin);
          entryWeight.push(accumulator[bin]! / norm);
        }
      }
    }
  }
  columnStart[columns] = entryBin.length;

  return {
    columnStart,
    entryBin: Int32Array.from(entryBin),
    entryWeight: Float64Array.from(entryWeight),
  };
}
