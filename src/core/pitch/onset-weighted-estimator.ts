/**
 * Pitch of the energy that just ARRIVED, not of the energy that is loudest.
 *
 * WHY THIS EXISTS
 *
 * On the lead fixture the player runs legato: E5 is hammered on while D5 is
 * still ringing, and for a few tens of milliseconds both notes sound. A
 * monophonic estimator answers with the strongest periodicity, and the
 * strongest periodicity is the note that has had longer to bloom -- the OLD
 * one. Measured with a bare DFT over t4's span, E5 sits at relative magnitude
 * 1.000 and D5 at 0.985: the E is genuinely there, it simply is not louder.
 * YIN reads D5 on t4, t6, t10 and t16, and on t6 it does so at confidence 0.95.
 * No better periodicity estimator repairs that, because the periodicity it
 * reports is real.
 *
 * A human names the E anyway, and the reason is not loudness: it is that the E
 * ARRIVED. So that is what this estimates. The half-wave rectified spectral
 * difference against a reference from ~50-90ms earlier -- max(0, |X_now| -
 * |X_then|), the per-bin form of the flux in `onset.ts` -- deletes everything
 * that was already sounding and leaves what is new. Harmonic summation over
 * that residual names the arriving note while the older, louder note is
 * subtracted out of the problem entirely.
 *
 * WHAT IT IS BLIND TO, AND WHY THE CONFIDENCE SAYS SO
 *
 * In the steady middle of a held note nothing has arrived, the residual is
 * ripple, and the pitch of ripple is noise. This estimator is therefore
 * accurate in a narrow band of frames after each attack and worthless between
 * them, which is the exact opposite failure profile to YIN's. That asymmetry is
 * the product, so the confidence has to carry it honestly: high on a frame
 * whose spectrum is largely new, low on a frame that is a continuation. A
 * fusion can then take this estimator's word at note starts and YIN's in the
 * sustain; a fusion given a flat confidence would be worse than either.
 *
 * Part of `src/core/` -- no DOM, no globals, no npm imports. All scratch is
 * preallocated; `estimate()` allocates only the small result record, as the
 * other estimators do.
 */

import { RealFFT, hannWindow } from "../fft.js";
import type { PitchEstimate, PitchEstimator, PitchEstimatorOptions } from "./estimator.js";

/**
 * Samples per call. 43ms at 48kHz.
 *
 * Deliberately short. The window trails the sample point, so a long window
 * pushes the first frame that lies wholly inside a note further past the attack
 * -- and the attack is the only thing this method can see. 2048 is the shortest
 * window that still resolves a whole tone up here: at 23Hz bins D5 (587Hz) and
 * E5 (659Hz) are three bins apart, which their main lobes blur but their peaks
 * survive, and after the difference D5 is not in the spectrum to blur anything.
 */
const WINDOW = 2048;

/**
 * Transform length. The frame is zero-padded into it.
 *
 * Padding buys no resolution, only interpolation, and interpolation is what the
 * f0 grid needs: at 23Hz bins a 12.5-cent grid step is a fraction of a bin near
 * the bottom of the range, so without padding most grid points would read the
 * same three bins and the harmonic sum would be a staircase.
 */
const FFT_SIZE = 4096;

/**
 * Reference span, in calls back. At the engine's 640-sample hop that is
 * 53-93ms.
 *
 * The lower bound is set by the bench's own sampling rule and by physics: the
 * earliest frame that lies wholly inside a note ends ~48ms after the attack, so
 * a reference nearer than that has already seen the new note and subtracts it
 * away. The upper bound is set by the material: sixteenths at 120bpm are 125ms
 * apart, and a reference older than that reaches back past the previous note
 * into one whose energy has since decayed -- harmless (decay rectifies to zero)
 * but useless.
 *
 * It is a span rather than one frame, taken per-bin as a MAXIMUM, for the
 * reason `onset.ts` holds peaks: unresolved partials beat against each other as
 * the frame phase advances, so a single-frame reference lets a bin that merely
 * dipped and recovered read as an arrival. A bin must exceed everything it was
 * across the whole span before it counts as new.
 */
const REFERENCE_LAG_MIN = 4;
const REFERENCE_LAG_MAX = 7;

/** Spectra retained. One more than the oldest lag, so lag `n` is always there. */
const HISTORY = REFERENCE_LAG_MAX + 1;

/** f0 grid resolution. 12.5 cents -- an eighth of the smallest interval scored. */
const GRID_STEPS_PER_SEMITONE = 8;

/** Partials modelled per candidate, and their amplitude decay, as `note-activation.ts`. */
const HARMONICS = 8;
const HARMONIC_DECAY = 0.8;
/** Above this the guitar's partials are buried in pick noise and string squeak. */
const PARTIAL_MAX_HZ = 5000;

/**
 * How far from a candidate's predicted partial a residual peak may sit and
 * still count as that partial.
 *
 * Two terms, for the two reasons `note-activation.ts` gives: bin quantisation
 * is a fixed number of Hz whatever the frequency, and a real string is
 * inharmonic and slightly out of tune by an error that scales with it. Kept
 * well inside half a semitone so a candidate can never score on its
 * neighbour's partials, which is the whole game on a run of steps.
 */
const PARTIAL_MIN_SLACK_BINS = 0.5;
const PARTIAL_SLACK_CENTS = 35;

/**
 * A residual peak must lead its neighbours and carry this share of the largest
 * residual peak in the frame.
 *
 * Scoring PEAKS rather than raw residual magnitude is what makes the harmonic
 * sum mean anything. A pick or a hammer-on is broadband, so the raw residual of
 * an attack is a hump of transient noise with the note's partials on top of it,
 * and a harmonic comb laid over a hump collects the hump -- measured on t4, raw
 * residual magnitudes put the winner at G#3, a pitch nobody plays in the piece,
 * simply because the low register held the most new energy. A peak survives the
 * transient only if the arriving energy is tonal, which is what a note is.
 */
const PEAK_MIN_RATIO = 0.06;

/**
 * Amplitude compression before the harmonic sum.
 *
 * The residual of an attack is dominated by whichever partial the pick happened
 * to excite hardest, and on a hammer-on that is often not the fundamental. A
 * square root puts the partials within a factor of a few of each other so the
 * candidate is scored on the SHAPE of its series rather than on owning one loud
 * bin -- the same reason `note-activation.ts` fits compressed magnitudes.
 */
const MAGNITUDE_EXPONENT = 0.5;

/**
 * A candidate's own fundamental must carry at least this share of its loudest
 * partial.
 *
 * Without it the sum happily reports f0/2, whose even harmonics are exactly the
 * candidate's whole series -- the standard sub-harmonic slip of every spectral
 * method, and the contract file names it as the thing not to be confident
 * about. The threshold is deliberately far below what any plucked string does
 * (the flattest envelope in `note-activation.ts` still puts the fundamental at
 * a quarter of the third harmonic), so it rejects only octave phantoms.
 */
const FUNDAMENTAL_MIN_RATIO = 0.12;

/** Below this fraction of full scale the frame is silence, not a quiet note. */
const SILENCE_MAGNITUDE = 1e-5;

/**
 * Novelty at which the arrival term of the confidence saturates.
 *
 * `novelty` is the share of the frame's magnitude that is not in the reference,
 * and it is the term that actually predicts whether this estimator is right: a
 * note starting from silence reaches 1, while over the lead fixture's sustained
 * frames it has a median of 0.035 and a 99th percentile of 0.24. 0.35 sits above
 * that tail, so a hammer-on over a ringing string -- which only ever contributes
 * part of the frame -- still saturates and sustain never does.
 */
const NOVELTY_SATURATION = 0.35;

/**
 * Harmonic-sum score at which a candidate is taken to explain the arriving
 * peaks completely, as a fraction of the score a candidate would get if every
 * one of its partials were the loudest peak in the residual.
 *
 * A real attack never reaches 1: the upper partials of a plucked string are well
 * below the strongest, and a hammer-on adds broadband noise that owns some of
 * the peaks. 0.45 is the median over the fixture's arrival frames, so this sets
 * the SCALE of the confidence rather than discriminating within it -- measured,
 * it is 0.46 on the arrivals this estimator gets right and 0.48 on the ones it
 * gets wrong. It is here to stop a frame whose residual holds two peaks and a
 * hiss from reporting the same number as a frame holding a whole harmonic
 * series, not to rank the good frames against each other.
 */
const EXPLAINED_SATURATION = 0.45;

/**
 * Sharpness of the winner-versus-rival posterior. 3 makes a rival at 70% of the
 * winner read as 0.75 rather than the 0.3 a bare margin would give — a rival
 * that shares most of a note's partials is genuinely a live hypothesis, but it
 * is not an equal one.
 */
const POSTERIOR_SHARPNESS = 3;

/**
 * Confidence at which a reading is treated as a real arrival and latched.
 *
 * Below it the frame is a continuation and the estimator has nothing of its own
 * to say, so it repeats the last arrival it believed -- the note that started is
 * the note being played until another one starts. That is a claim about the
 * PAST, not a measurement of this frame, and it is reported at a decayed
 * confidence to say so.
 */
const ARRIVAL_CONFIDENCE = 0.35;

/** Per-frame decay applied to a latched reading, and the floor it decays to. */
const HOLD_DECAY = 0.82;
const HOLD_FLOOR = 0.08;

/**
 * How long a latched reading survives with no new arrival. 40 calls is ~530ms
 * at the engine hop -- longer than any note in the fixtures' fastest passage,
 * short enough that a stale answer cannot outlive the phrase it came from.
 */
const HOLD_FRAMES = 40;

export class OnsetWeightedEstimator implements PitchEstimator {
  readonly name = "onset-weighted";
  readonly windowSize = WINDOW;

  private readonly fft: RealFFT;
  private readonly bins: number;
  private readonly binHz: number;
  private readonly minBin: number;
  private readonly maxBin: number;

  private readonly hann: Float32Array;
  /** The frame, windowed into the first `WINDOW` slots; the tail stays zero. */
  private readonly padded: Float32Array;
  private readonly magnitude: Float32Array;
  /** Ring of the last `HISTORY` magnitude spectra, `bins` apart. */
  private readonly spectra: Float32Array;
  /** Per-bin maximum over the reference span. */
  private readonly reference: Float32Array;
  /** max(0, magnitude - reference): what arrived. */
  private readonly residual: Float32Array;
  /** Harmonic-sum score per f0 grid point. */
  private readonly score: Float64Array;

  /** Interpolated frequency of each surviving residual peak, ascending. */
  private readonly peakHz: Float64Array;
  /** ...and its amplitude as a fraction of the frame's largest residual peak. */
  private readonly peakAmplitude: Float64Array;
  private peakCount = 0;

  /** f0 of each grid point, ascending. */
  private readonly gridHz: Float64Array;
  /*
   * Partials in compressed-column form: grid point `g` owns
   * `[gridStart[g], gridStart[g + 1])` of `partialHz`/`partialSlack`/`weight`,
   * one entry per modelled harmonic, first entry the fundamental. Dense would
   * be mostly bookkeeping and every frame would walk all of it.
   */
  private readonly gridStart: Int32Array;
  private readonly partialHz: Float64Array;
  private readonly partialSlack: Float64Array;
  private readonly partialWeight: Float64Array;
  /** Score a candidate reaches when every partial it predicts is the frame's loudest peak. */
  private readonly saturatedScore: number;

  private historyCount = 0;
  /** Where the next spectrum goes; also the oldest once the ring is full. */
  private historyIndex = 0;

  private heldHz: number | null = null;
  private heldConfidence = 0;
  private heldAge = 0;

  constructor(options: PitchEstimatorOptions) {
    const { sampleRate, minFrequencyHz, maxFrequencyHz } = options;
    if (!(sampleRate > 0)) {
      throw new Error(`OnsetWeightedEstimator: sampleRate must be > 0, got ${sampleRate}`);
    }
    if (!(maxFrequencyHz > minFrequencyHz) || !(minFrequencyHz > 0)) {
      throw new Error(
        `OnsetWeightedEstimator: need 0 < minFrequencyHz < maxFrequencyHz, ` +
          `got ${minFrequencyHz}..${maxFrequencyHz}`
      );
    }

    this.fft = new RealFFT(FFT_SIZE);
    this.bins = this.fft.bins;
    this.binHz = sampleRate / FFT_SIZE;
    // One bin of headroom under the bound: a partial at exactly `minFrequencyHz`
    // needs its neighbours to interpolate, and the search slack reaches below it.
    this.minBin = Math.max(1, Math.floor(minFrequencyHz / this.binHz) - 1);
    this.maxBin = Math.min(
      this.bins - 2,
      Math.ceil(Math.min(PARTIAL_MAX_HZ, sampleRate / 2) / this.binHz)
    );

    this.hann = hannWindow(WINDOW);
    this.padded = new Float32Array(FFT_SIZE);
    this.magnitude = new Float32Array(this.bins);
    this.spectra = new Float32Array(HISTORY * this.bins);
    this.reference = new Float32Array(this.bins);
    this.residual = new Float32Array(this.bins);
    this.peakHz = new Float64Array(this.bins);
    this.peakAmplitude = new Float64Array(this.bins);

    const semitones = 12 * Math.log2(maxFrequencyHz / minFrequencyHz);
    const gridCount = Math.max(2, Math.round(semitones * GRID_STEPS_PER_SEMITONE) + 1);
    this.score = new Float64Array(gridCount);
    this.gridHz = new Float64Array(gridCount);
    this.gridStart = new Int32Array(gridCount + 1);

    const hz: number[] = [];
    const slack: number[] = [];
    const weight: number[] = [];
    const partialCeiling = Math.min(PARTIAL_MAX_HZ, this.maxBin * this.binHz);
    for (let g = 0; g < gridCount; g++) {
      const f0 = minFrequencyHz * Math.pow(2, g / (12 * GRID_STEPS_PER_SEMITONE));
      this.gridHz[g] = f0;
      this.gridStart[g] = hz.length;

      // Unit-norm weights, as `note-activation.ts` normalises its columns: a low
      // candidate fits more harmonics under the band limit than a high one, and
      // without normalisation it would outscore it for having more places to
      // look rather than for being right.
      let norm = 0;
      for (let h = 1; h <= HARMONICS; h++) {
        if (f0 * h > partialCeiling) break;
        norm += Math.pow(HARMONIC_DECAY, 2 * (h - 1));
      }
      norm = Math.sqrt(norm) || 1;

      for (let h = 1; h <= HARMONICS; h++) {
        const partial = f0 * h;
        if (partial > partialCeiling) break;
        hz.push(partial);
        slack.push(
          Math.max(
            PARTIAL_MIN_SLACK_BINS * this.binHz,
            partial * (Math.pow(2, PARTIAL_SLACK_CENTS / 1200) - 1)
          )
        );
        weight.push(Math.pow(HARMONIC_DECAY, h - 1) / norm);
      }
    }
    this.gridStart[gridCount] = hz.length;
    this.partialHz = Float64Array.from(hz);
    this.partialSlack = Float64Array.from(slack);
    this.partialWeight = Float64Array.from(weight);

    // Weights are unit-norm per candidate but their SUM is not, so the ceiling
    // is taken from the fullest candidate on the grid and the `explained` term
    // stays comparable across the range.
    let fullest = 0;
    for (let g = 0; g < gridCount; g++) {
      let sum = 0;
      for (let e = this.gridStart[g]!; e < this.gridStart[g + 1]!; e++) sum += this.partialWeight[e]!;
      if (sum > fullest) fullest = sum;
    }
    this.saturatedScore = Math.max(1e-9, fullest * EXPLAINED_SATURATION);
  }

  estimate(window: Float32Array): PitchEstimate {
    if (window.length !== WINDOW) {
      throw new Error(
        `OnsetWeightedEstimator.estimate: expected ${WINDOW} samples, got ${window.length}`
      );
    }

    for (let i = 0; i < WINDOW; i++) this.padded[i] = window[i]! * this.hann[i]!;
    this.fft.magnitudes(this.padded, this.magnitude);

    let frameTotal = 0;
    for (let k = this.minBin; k <= this.maxBin; k++) frameTotal += this.magnitude[k]!;
    if (!(frameTotal > SILENCE_MAGNITUDE)) {
      this.push();
      this.heldHz = null;
      this.heldConfidence = 0;
      return { frequencyHz: null, confidence: 0 };
    }

    const novelty = this.buildResidual(frameTotal);
    this.push();

    // Nothing has arrived, so there is nothing this estimator measures. Anything
    // it said now would be the pitch of ripple.
    if (novelty <= 0 || this.findResidualPeaks() === 0) return this.sustained();

    const best = this.searchGrid();
    if (best < 0) return this.sustained();

    const bestScore = this.score[best]!;
    let rival = 0;
    for (let g = 0; g < this.score.length; g++) {
      if (Math.abs(g - best) < GRID_STEPS_PER_SEMITONE) continue;
      const s = this.score[g]!;
      if (s > rival) rival = s;
    }

    // Three independent ways of being wrong, so the product of three factors and
    // not the flattering maximum. They do not carry equal weight, and saying
    // which does what is the point of reporting a number at all:
    //
    //  - `arrival` is the one that predicts correctness. It asks whether
    //    anything is being measured, or whether this is a continuation whose
    //    residual is ripple, and bucketing the fixture's frames by the confidence
    //    they end up with runs 51% correct at the bottom and 83% at the top.
    //  - `explained` sets the scale: whether ONE harmonic series accounts for the
    //    arriving peaks at all, rather than two peaks and a hiss.
    //  - `posterior` is the octave guard. A two-hypothesis posterior between the
    //    winner and the best candidate a semitone or more away, so a pitch tied
    //    with its own octave reports 0.5 and not 0.99 -- the case the contract
    //    file singles out. It separates right from wrong only weakly (median
    //    0.86 against 0.78), which is why it multiplies rather than decides.
    const arrival = Math.min(1, novelty / NOVELTY_SATURATION);
    const explained = Math.min(1, bestScore / this.saturatedScore);
    const a = Math.pow(bestScore, POSTERIOR_SHARPNESS);
    const b = Math.pow(rival, POSTERIOR_SHARPNESS);
    const posterior = a + b > 0 ? a / (a + b) : 0;
    const confidence = arrival * explained * posterior;

    if (confidence < ARRIVAL_CONFIDENCE) return this.sustained();

    const frequencyHz = this.refine(best);
    this.heldHz = frequencyHz;
    this.heldConfidence = confidence;
    this.heldAge = 0;
    return { frequencyHz, confidence };
  }

  reset(): void {
    this.spectra.fill(0);
    this.historyCount = 0;
    this.historyIndex = 0;
    this.heldHz = null;
    this.heldConfidence = 0;
    this.heldAge = 0;
  }

  /* ------------------------------------------------------------------ */

  /**
   * The answer for a frame in which nothing arrived: the last note that did,
   * reported as the memory it is.
   *
   * THE OBVIOUS ALTERNATIVE SCORES HIGHER AND IS THE WRONG ANSWER.
   *
   * Naming the pitch of the raw spectrum on these frames was measured: on a
   * contiguous pass of the lead fixture it takes this estimator from 31/43 notes
   * to 37/43, past YIN's 35 (32 to 36 as the bench samples it). It also loses t4,
   * t6, t10 and t16 -- every note this estimator exists for -- because the
   * sustain frames outnumber the attack frames and the sustain of a hammer-on is
   * still dominated by the note underneath it. What that variant becomes is a
   * second, slightly better YIN, wrong in the same places as the first, which is
   * the one thing a fusion has no use for.
   *
   * So: repeat the arrival instead. It is a claim about the PAST rather than a
   * measurement of this frame, and the decaying confidence says so, quietly
   * enough that a fusion can overrule it.
   */
  private sustained(): PitchEstimate {
    if (this.heldHz === null) return { frequencyHz: null, confidence: 0 };
    this.heldAge++;
    if (this.heldAge > HOLD_FRAMES) {
      this.heldHz = null;
      this.heldConfidence = 0;
      return { frequencyHz: null, confidence: 0 };
    }
    const confidence = Math.max(
      HOLD_FLOOR,
      this.heldConfidence * Math.pow(HOLD_DECAY, this.heldAge)
    );
    return { frequencyHz: this.heldHz, confidence };
  }

  /**
   * Fills `residual` with max(0, magnitude - reference) and returns the share of
   * the frame's magnitude that is new.
   *
   * Before the ring holds a full reference span the reference is empty, so the
   * whole frame reads as an arrival. That is the right answer for the first
   * note after silence and the only defensible one for a cold start.
   */
  private buildResidual(frameTotal: number): number {
    const { magnitude, reference, residual, bins } = this;
    reference.fill(0);
    for (let lag = REFERENCE_LAG_MIN; lag <= REFERENCE_LAG_MAX; lag++) {
      if (lag > this.historyCount) break;
      const base = ((this.historyIndex - lag + 2 * HISTORY) % HISTORY) * bins;
      for (let k = this.minBin; k <= this.maxBin; k++) {
        const v = this.spectra[base + k]!;
        if (v > reference[k]!) reference[k] = v;
      }
    }

    let arrived = 0;
    for (let k = this.minBin; k <= this.maxBin; k++) {
      const delta = magnitude[k]! - reference[k]!;
      if (delta > 0) {
        residual[k] = delta;
        arrived += delta;
      } else {
        residual[k] = 0;
      }
    }
    return arrived / frameTotal;
  }

  private push(): void {
    this.spectra.set(this.magnitude, this.historyIndex * this.bins);
    this.historyIndex = (this.historyIndex + 1) % HISTORY;
    if (this.historyCount < HISTORY) this.historyCount++;
  }

  /**
   * Local maxima of the residual that stand clear of the frame's largest,
   * parabolically interpolated. Returns how many survived.
   *
   * Interpolation over LOG amplitudes and only 1-bin dominance are both taken
   * from `note-activation.ts`, and for its reasons: the vertex of a log-parabola
   * is where a Hann lobe's true centre is, and a wider dominance test throws
   * away genuine partials standing two bins from a louder one, which is exactly
   * the D5/E5 case this estimator exists for.
   */
  private findResidualPeaks(): number {
    const { residual, peakHz, peakAmplitude } = this;

    let framePeak = 0;
    for (let k = this.minBin; k <= this.maxBin; k++) {
      const v = residual[k]!;
      if (v > framePeak) framePeak = v;
    }
    if (!(framePeak > 0)) {
      this.peakCount = 0;
      return 0;
    }

    const floor = framePeak * PEAK_MIN_RATIO;
    let count = 0;
    for (let k = Math.max(this.minBin, 1); k <= this.maxBin; k++) {
      const m = residual[k]!;
      if (m < floor) continue;
      if (residual[k - 1]! >= m || residual[k + 1]! > m) continue;

      const a = Math.log(Math.max(residual[k - 1]!, framePeak * 1e-9));
      const b = Math.log(m);
      const c = Math.log(Math.max(residual[k + 1]!, framePeak * 1e-9));
      const denominator = a - 2 * b + c;
      let delta = denominator !== 0 ? (0.5 * (a - c)) / denominator : 0;
      if (!(delta > -0.5) || !(delta < 0.5)) delta = 0;

      peakHz[count] = (k + delta) * this.binHz;
      peakAmplitude[count] = Math.exp(b - 0.25 * (a - c) * delta) / framePeak;
      count++;
    }
    this.peakCount = count;
    return count;
  }

  /**
   * Scores every f0 on the grid against the residual peaks and returns the
   * winner, or -1 if none survives the fundamental gate.
   */
  private searchGrid(): number {
    const { score, gridStart, partialHz, partialSlack, partialWeight } = this;
    let best = -1;
    let bestScore = 0;

    for (let g = 0; g < score.length; g++) {
      const from = gridStart[g]!;
      const to = gridStart[g + 1]!;
      if (from === to) {
        score[g] = 0;
        continue;
      }

      let sum = 0;
      let fundamental = 0;
      let strongest = 0;
      for (let e = from; e < to; e++) {
        const peak = this.peakNear(partialHz[e]!, partialSlack[e]!);
        if (e === from) fundamental = peak;
        if (peak > strongest) strongest = peak;
        sum += partialWeight[e]! * Math.pow(peak, MAGNITUDE_EXPONENT);
      }

      // Sub-harmonic gate: a candidate whose own fundamental is missing is
      // scoring on somebody else's series.
      if (fundamental < strongest * FUNDAMENTAL_MIN_RATIO) sum = 0;

      score[g] = sum;
      if (sum > bestScore) {
        bestScore = sum;
        best = g;
      }
    }
    return best;
  }

  /**
   * Amplitude of the strongest residual peak within `slack` Hz of `hz`, or 0.
   * Peaks are ascending, so the window is found by bisection.
   */
  private peakNear(hz: number, slack: number): number {
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

  /**
   * Sub-grid f0 by parabolic interpolation over the three scores around the
   * winner. The grid is geometric, so the vertex is interpolated in log
   * frequency and only then exponentiated.
   */
  private refine(best: number): number {
    const f0 = this.gridHz[best]!;
    if (best === 0 || best === this.score.length - 1) return f0;
    const a = this.score[best - 1]!;
    const b = this.score[best]!;
    const c = this.score[best + 1]!;
    const denominator = a - 2 * b + c;
    if (denominator === 0) return f0;
    let delta = (0.5 * (a - c)) / denominator;
    if (!(delta > -0.5) || !(delta < 0.5)) delta = 0;
    return f0 * Math.pow(2, delta / (12 * GRID_STEPS_PER_SEMITONE));
  }
}

export default function create(options: PitchEstimatorOptions): PitchEstimator {
  return new OnsetWeightedEstimator(options);
}
