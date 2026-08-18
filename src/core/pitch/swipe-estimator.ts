/**
 * SWIPE' — Camacho & Harris, "A sawtooth waveform inspired pitch estimator for
 * speech and music", JASA 124(3), 2008 — behind the shared estimator contract.
 *
 * WHY IT IS WORTH HAVING ALONGSIDE YIN
 *
 * YIN compares the waveform with itself. When a note's second period is not
 * quite a copy of its first — a plucked string whose upper partials decay
 * faster than its fundamental, or two strings beating — the difference function
 * dips again at twice the lag and the reading falls an octave. That failure
 * lives in the time domain and no amount of thresholding removes it.
 *
 * SWIPE scores a candidate pitch by how well the observed spectrum matches the
 * spectrum of a sawtooth at that pitch. It is exposed to the mirror-image
 * failure: a harmonic comb laid over a harmonic series also fits the SUB
 * harmonics, because every harmonic of f0 is a harmonic of f0/2 as well. Three
 * things in this method exist to fight exactly that, and none is decorative:
 *
 *   - SQUARE ROOT of the magnitude spectrum. The score is an inner product, and
 *     an inner product against raw magnitudes is decided by whichever single
 *     partial is loudest, so a candidate explaining one strong partial and
 *     nothing else outscores one explaining ten. The square root compresses
 *     that range, which is what turns the inner product into something that
 *     behaves like a normalised correlation over the whole series rather than a
 *     vote by the loudest partial.
 *
 *   - FIRST AND PRIME harmonics only — the apostrophe in SWIPE'. The
 *     sub-harmonic f0/2 has harmonics at f0/2, f0, 3f0/2, 2f0, ...; every
 *     harmonic of f0 is in that set, so a full comb cannot separate the two and
 *     the only evidence against f0/2 is the energy MISSING at its odd
 *     harmonics. Restricting the kernel to 1, 2, 3, 5, 7, 11, ... makes that
 *     evidence the whole score, because the kernel of f0/2 then puts lobes at
 *     3f0/2, 5f0/2 and 7f0/2 — half-integer multiples of f0, where a note at f0
 *     puts nothing at all.
 *
 *   - NEGATIVE VALLEYS between the lobes, and a unit-norm kernel. The valleys
 *     charge a candidate for energy sitting BETWEEN its harmonics, which is what
 *     stops broadband noise or a dense chord from scoring well everywhere; the
 *     normalisation stops a low candidate — which fits more harmonics under
 *     Nyquist, and so has more places to look — from winning on count.
 *
 * Two of those three pay for themselves on the lead fixture, measured by
 * removing them one at a time: without the square root it reads 34/43 notes and
 * 68.4% of frames, without the valleys 35/43 and 68.6%, against 36/43 and 71.0%
 * with everything. The prime restriction is the one that does not — a full comb
 * scores 36/43 and 71.3%, two frames better, which is noise. That is not an
 * argument for dropping it: this fixture is a clean monophonic lead whose only
 * octave-shaped error is on a note another note drowns out throughout, so it
 * cannot show what the prime set is for — and the restriction pays for itself
 * anyway, at 270k kernel entries against the full comb's 628k. Re-measure it
 * on material that does confuse octaves.
 *
 * SHAPE
 *
 *   1. Hann window -> magnitude spectrum -> resampled onto the analysis axis ->
 *      square root -> normalised to unit length.
 *   2. Inner product against one precomputed kernel per candidate pitch, on a
 *      log-spaced candidate grid over the configured range.
 *   3. Parabolic interpolation of the winner in log-f0, which is what buys
 *      sub-semitone accuracy from a candidate grid this coarse.
 *
 * DEPARTURES FROM THE PUBLISHED METHOD, BOTH DELIBERATE
 *
 * The paper scores each candidate from the window that holds about eight of its
 * own periods, interpolating between the two power-of-two window sizes that
 * bracket it. That is right for a method covering 40Hz to 1kHz of speech and it
 * is not available here: this contract fixes ONE window size per estimator and
 * the caller supplies exactly that many samples. One window serves every
 * candidate, which costs resolution at the bottom of the range.
 *
 * The frequency axis is LINEAR, not ERB-warped. The warp is in the paper and it
 * was what this file did first; on the lead fixture it reads 35/43 notes and
 * 67.7% of frames where the linear axis reads 36/43 and 70.7%, and that gap
 * does not close at any ERB step from 0.1 down to 0.03, so it is the warp and
 * not the sampling. An ERB axis is dense below 1kHz and sparse above it, which
 * is right for the speech formants it was designed around and wrong for a
 * guitar: what separates a note from its own octave is its HIGH partials, and
 * an axis spending four fifths of its points under 1kHz lets the fundamental
 * region outvote them.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports. Every buffer,
 * including the whole kernel bank, is allocated in the constructor.
 */

import { RealFFT, hannWindow } from "../fft.js";
import type { PitchEstimate, PitchEstimator, PitchEstimatorOptions } from "./estimator.js";

/**
 * 43ms at 48kHz — the same window YIN uses, which is not a coincidence.
 *
 * A spectral method wants a long window, and this one wants it more than most,
 * because the kernel's lobes are a fixed FRACTION of the candidate wide: at the
 * bottom of the range they are a couple of bins across, and a short transform
 * smears neighbouring candidates into one another. Working against that, the
 * bench cannot take a frame until the window lies wholly inside the note, and
 * the lead fixture's sixteenths are ~110ms, so a long window stops seeing the
 * fast material at all. Measured on that fixture, notes exact / frame agreement:
 * 1024 -> 34, 68.8%; 2048 -> 36, 75.7%; 4096 -> 36, 78.0%; 8192 -> 7, because
 * 34 of the 43 notes are then shorter than the window.
 *
 * 4096 reads its frames slightly more decisively, and 2048 is chosen anyway: it
 * sees 617 of the fixture's frames where 4096 sees 488, it halves the latency a
 * tuner shows the player, and it puts this estimator on the same frames as the
 * incumbent, which is what makes a per-frame comparison between them mean
 * anything.
 */
const WINDOW = 2048;

/**
 * Transform length: the window zero-padded to twice its length.
 *
 * One extra radix-2 stage. It adds no information, but the analysis axis below
 * averages blocks of bins, and the padding lets a block straddle a partial
 * instead of quantising it — worth 36/43 notes and 71.0% of frames against
 * 35/43 and 67.4% unpadded. Padding to four times the window buys nothing
 * further (70.8%).
 */
const FFT_SIZE = WINDOW * 2;

/**
 * Candidates per semitone: the grid the kernel bank is built on, and the unit
 * the rival search below measures a semitone in.
 *
 * 12 puts them 8 cents apart. Doubling to 24 and again to 48 changes nothing
 * measurable — 436, 436 and 438 frames of 617, and under a cent of difference
 * on a synthetic sawtooth sweep — because the parabolic fit, not the grid, is
 * what sets the pitch accuracy. 12 does it in half the kernel bank (270k
 * entries, 3.2MB) and 1.0ms a frame.
 */
const CANDIDATES_PER_SEMITONE = 12;

/**
 * Analysis axis resolution, in transform bins per point.
 *
 * The axis cannot resolve more than the transform does, so this is expressed in
 * bins rather than Hz and follows the window size on its own. 1 and 2 score the
 * same (437 and 438 frames of 617); 4 loses a note and thirty frames, its 46Hz
 * points being wider than the kernel lobes of the low candidates. 2, for doing
 * it in half the inner-product work.
 */
const BINS_PER_POINT = 2;

/** Bins below this are excluded outright: DC offset and rumble, never pitch. */
const SPECTRUM_MIN_HZ = 25;

/** Input RMS below this counts as silence. */
const SILENCE_RMS = 1e-6;

/**
 * Pitch strength that maps to zero confidence, and the one that maps to full
 * confidence before the ambiguity penalty is applied.
 *
 * Strength is a unit-norm inner product, so it sits on a fixed scale whatever
 * the input level — but it is NOT an accuracy, and calibrating it is the whole
 * job of this pair of numbers. Over the lead fixture's 617 interior frames,
 * binned by strength, the reading is right 34% of the time below 0.25, 61%
 * between 0.25 and 0.35, 74% between 0.35 and 0.50, and 87% above that. The
 * split by register tells the same story: below C4 the median strength is 0.50
 * and the reading is right 79% of the time; above it the median is 0.35 and 64%,
 * because a high note leaves fewer harmonics under Nyquist for the kernel to
 * find. So the ramp spans the band where right and wrong readings actually
 * separate, and a strong low note is allowed to say so.
 */
const STRENGTH_FLOOR = 0.15;
const STRENGTH_CONFIDENT = 0.4;

/**
 * How far clear of its best rival the winner must stand before the ambiguity
 * penalty lifts, as a fraction of the winner's own strength.
 *
 * Two ramps because two failure modes, and the edges are measured rather than
 * chosen. When the rival is an octave or a fifth away — SWIPE guessing between
 * a note and its own harmonic series, this method's blind spot — frames whose
 * winner leads by less than half read the labelled note 40% of the time, and
 * frames that lead by more read it 82% of the time. When the rival is at some
 * unrelated interval, usually a second string still ringing, the same cliff
 * sits lower and is gentler: 50% below a 0.4 lead, 76% above it. Reporting a
 * confident answer from inside either cliff is exactly what would make a fusion
 * of several estimators worse than its best member.
 *
 * Together with the strength ramp this comes out calibrated: over the fixture's
 * 617 frames the mean reported confidence is 0.712 and the reading is right
 * 71.0% of the time, and correct frames average 0.28 more confidence than wrong
 * ones (0.79 against 0.51). The incumbent YIN reports a mean 0.84 for its 68.9%.
 */
const HARMONIC_TIE_MIN = 0.3;
const HARMONIC_TIE_CLEAR = 0.6;
const OTHER_TIE_MIN = 0.1;
const OTHER_TIE_CLEAR = 0.4;

/** Intervals at which a rival counts as the harmonic kind, in cents. */
const HARMONIC_INTERVALS_CENTS = [-2400, -1902, -1200, -702, 702, 1200, 1902, 2400];
/** Tolerance around those. Wide enough for a mistuned string, in cents. */
const HARMONIC_INTERVAL_TOLERANCE_CENTS = 60;

/** Below this the spectrum matched nothing; report no pitch rather than noise. */
const MIN_REPORTED_STRENGTH = 0.06;

export class SwipeEstimator implements PitchEstimator {
  readonly name = "swipe-prime";
  readonly windowSize = WINDOW;

  private readonly fft: RealFFT;
  private readonly hann: Float32Array;
  private readonly windowed: Float32Array;
  private readonly magnitude: Float32Array;

  /** First transform bin of analysis point 0; points step `BINS_PER_POINT`. */
  private readonly firstBin: number;
  /** Centre frequency of each analysis point, ascending. */
  private readonly pointHz: Float64Array;
  /** Square-rooted, unit-normalised spectrum on that axis. */
  private readonly loudness: Float64Array;

  /*
   * The kernel bank in compressed-column form: candidate `c` occupies
   * `[kernelStart[c], kernelStart[c + 1])` of the paired point/weight arrays.
   * Dense would be ~620 candidates by ~1000 points of Float64, three quarters
   * of it the gaps between the used harmonics, and every frame would walk all
   * of it. Sparse it is 270k entries, and a frame costs 1.0ms.
   */
  private readonly candidateHz: Float64Array;
  private readonly kernelStart: Int32Array;
  private readonly kernelPoint: Int32Array;
  private readonly kernelWeight: Float64Array;
  /** Pitch strength per candidate. */
  private readonly strength: Float64Array;
  /** Ratio between adjacent candidates, for the log-domain interpolation. */
  private readonly candidateRatio: number;

  constructor(options: PitchEstimatorOptions) {
    const { sampleRate, minFrequencyHz, maxFrequencyHz } = options;
    if (!(sampleRate > 0)) {
      throw new Error(`SwipeEstimator: sampleRate must be > 0, got ${sampleRate}`);
    }
    if (!(minFrequencyHz > 0) || !(maxFrequencyHz > minFrequencyHz)) {
      throw new Error(
        `SwipeEstimator: need 0 < minFrequencyHz < maxFrequencyHz, got ` +
          `${minFrequencyHz}..${maxFrequencyHz}`
      );
    }

    this.fft = new RealFFT(FFT_SIZE);
    this.hann = hannWindow(WINDOW);
    this.windowed = new Float32Array(FFT_SIZE);
    this.magnitude = new Float32Array(this.fft.bins);

    /* --- Analysis axis ------------------------------------------------------ */
    // Starts a quarter of the lowest candidate, because that candidate's first
    // kernel lobe reaches a further 0.75 f0 below its own fundamental and the
    // axis has to carry it. It runs to Nyquist, with no band limit, and that is
    // the measured answer rather than the obvious one: a cap looks right, since
    // above 5kHz a guitar has little partial energy and plenty of hiss, and the
    // unit-length normalisation lets that hiss scale every real correlation
    // down. But capping at 3kHz collapses the fixture to 29/43 notes and 61.9%
    // of frames, because the prime harmonics of the high candidates live up
    // there and they are the evidence that tells a note from its octave. Past
    // 5kHz the cap changes nothing at all (36/43 at 5k, 8k, 12k and Nyquist), so
    // there is no constant to justify.
    const binHz = sampleRate / FFT_SIZE;
    this.firstBin = Math.max(1, Math.round(Math.max(minFrequencyHz / 4, SPECTRUM_MIN_HZ) / binHz));
    const points = Math.floor((this.fft.bins - this.firstBin) / BINS_PER_POINT);
    if (points < 4) {
      throw new Error(`SwipeEstimator: sampleRate ${sampleRate} leaves no usable spectrum`);
    }
    this.pointHz = new Float64Array(points);
    for (let g = 0; g < points; g++) {
      this.pointHz[g] = (this.firstBin + g * BINS_PER_POINT + (BINS_PER_POINT - 1) / 2) * binHz;
    }
    this.loudness = new Float64Array(points);

    /* --- Candidates and kernel bank ----------------------------------------- */
    const semitones = 12 * Math.log2(maxFrequencyHz / minFrequencyHz);
    const count = Math.max(3, Math.round(semitones * CANDIDATES_PER_SEMITONE) + 1);
    this.candidateRatio = Math.pow(2, 1 / (12 * CANDIDATES_PER_SEMITONE));
    this.candidateHz = new Float64Array(count);
    for (let c = 0; c < count; c++) {
      this.candidateHz[c] = minFrequencyHz * Math.pow(this.candidateRatio, c);
    }
    this.strength = new Float64Array(count);

    const bank = buildKernelBank(this.candidateHz, this.pointHz);
    this.kernelStart = bank.start;
    this.kernelPoint = bank.point;
    this.kernelWeight = bank.weight;
  }

  estimate(window: Float32Array): PitchEstimate {
    if (window.length !== WINDOW) {
      throw new Error(`SwipeEstimator.estimate: expected ${WINDOW} samples, got ${window.length}`);
    }

    // Only the first WINDOW samples of `windowed` are ever written; the
    // zero-padded tail stays zero from allocation.
    let sumSquares = 0;
    for (let i = 0; i < WINDOW; i++) {
      const s = window[i]!;
      sumSquares += s * s;
      this.windowed[i] = s * this.hann[i]!;
    }
    if (!(Math.sqrt(sumSquares / WINDOW) > SILENCE_RMS)) return SILENT;

    this.fft.magnitudes(this.windowed, this.magnitude);
    if (!this.buildLoudness()) return SILENT;
    return this.score();
  }

  /* ------------------------------------------------------------------ */

  /**
   * Resamples, square-roots and normalises the spectrum onto the analysis axis.
   * False when the band holds no energy at all.
   *
   * The unit-length normalisation is what makes pitch strength comparable
   * between frames, and so between estimators: both vectors in the inner
   * product then have norm one and the score is a cosine similarity. It cannot
   * be raised by playing louder, only by the spectrum looking more like a
   * sawtooth at that pitch.
   */
  private buildLoudness(): boolean {
    const loudness = this.loudness;
    const magnitude = this.magnitude;
    let norm = 0;

    for (let g = 0; g < loudness.length; g++) {
      let sum = 0;
      const base = this.firstBin + g * BINS_PER_POINT;
      for (let b = 0; b < BINS_PER_POINT; b++) sum += magnitude[base + b]!;
      const value = Math.sqrt(sum / BINS_PER_POINT);
      loudness[g] = value;
      norm += value * value;
    }
    if (!(norm > 0)) return false;

    const scale = 1 / Math.sqrt(norm);
    for (let g = 0; g < loudness.length; g++) loudness[g] = loudness[g]! * scale;
    return true;
  }

  /** Correlates every kernel, then interprets the winner. */
  private score(): PitchEstimate {
    const start = this.kernelStart;
    const point = this.kernelPoint;
    const weight = this.kernelWeight;
    const loudness = this.loudness;
    const strength = this.strength;
    const count = strength.length;

    let best = -Infinity;
    let bestIndex = 0;
    for (let c = 0; c < count; c++) {
      let dot = 0;
      for (let e = start[c]!; e < start[c + 1]!; e++) dot += weight[e]! * loudness[point[e]!]!;
      strength[c] = dot;
      if (dot > best) {
        best = dot;
        bestIndex = c;
      }
    }
    if (!(best > MIN_REPORTED_STRENGTH)) return SILENT;

    /* --- Sub-semitone refinement ------------------------------------------- */
    // Fitted over candidate INDICES and applied as a ratio, because the
    // candidates are log-spaced: one parabola is then as accurate at 1400Hz as
    // at 70Hz, which a fit in Hz would not be.
    let delta = 0;
    if (bestIndex > 0 && bestIndex < count - 1) {
      const a = strength[bestIndex - 1]!;
      const b = strength[bestIndex]!;
      const c = strength[bestIndex + 1]!;
      const denominator = a - 2 * b + c;
      if (denominator < 0) {
        const d = (0.5 * (a - c)) / denominator;
        if (d > -1 && d < 1) delta = d;
      }
    }
    const frequencyHz = this.candidateHz[bestIndex]! * Math.pow(this.candidateRatio, delta);

    /* --- The best rival OUTSIDE the winner's own peak ----------------------- */
    // Two exclusions, and both are needed. Walking downhill finds where the
    // curve turns back up, which is where a second explanation of the frame
    // begins, and that boundary moves with the width of the peak. But on a grid
    // this fine the curve wobbles by a thousandth right beside its own summit,
    // and taking that wobble for a rival collapsed the confidence of one frame
    // in five that was in fact 78% right. So the walk starts a semitone out: a
    // candidate closer than that names the same note and is never a rival.
    let lo = bestIndex - CANDIDATES_PER_SEMITONE;
    while (lo > 0 && strength[lo - 1]! <= strength[lo]!) lo--;
    let hi = bestIndex + CANDIDATES_PER_SEMITONE;
    while (hi < count - 1 && strength[hi + 1]! <= strength[hi]!) hi++;

    let rival = 0;
    let rivalIndex = -1;
    for (let c = 0; c < count; c++) {
      if (c >= lo && c <= hi) continue;
      if (strength[c]! > rival) {
        rival = strength[c]!;
        rivalIndex = c;
      }
    }

    return { frequencyHz, confidence: this.confidenceOf(best, rival, bestIndex, rivalIndex) };
  }

  /**
   * Maps pitch strength onto the contract's 0..1 scale.
   *
   * The raw inner product is not a probability and must not be reported as one.
   * It is a cosine similarity between a real spectrum and an idealised sawtooth,
   * so a correctly identified guitar note in this fixture's top octave scores
   * around 0.35 — the rest is inharmonicity, the pick, and the room. Reporting
   * that as 0.35 would understate a reading that is usually right; reporting
   * every argmax as 0.95 would overstate them all. So strength is mapped through
   * the band where right and wrong readings separate on real material, and then
   * cut by how close the runner-up came.
   *
   * The cut is the honest part. SWIPE's characteristic error is naming a note's
   * octave or its fifth, and when it makes that error the two candidates score
   * within a few percent of one another: the frame genuinely does not
   * distinguish them. Fusion needs that said out loud rather than hidden behind
   * the argmax.
   */
  private confidenceOf(best: number, rival: number, bestIndex: number, rivalIndex: number): number {
    const level = clamp01((best - STRENGTH_FLOOR) / (STRENGTH_CONFIDENT - STRENGTH_FLOOR));
    if (level <= 0 || rivalIndex < 0 || rival <= 0) return level;

    const cents = 1200 * Math.log2(this.candidateHz[rivalIndex]! / this.candidateHz[bestIndex]!);
    let harmonic = false;
    for (const interval of HARMONIC_INTERVALS_CENTS) {
      if (Math.abs(cents - interval) <= HARMONIC_INTERVAL_TOLERANCE_CENTS) {
        harmonic = true;
        break;
      }
    }

    const margin = 1 - rival / best;
    const min = harmonic ? HARMONIC_TIE_MIN : OTHER_TIE_MIN;
    const clear = harmonic ? HARMONIC_TIE_CLEAR : OTHER_TIE_CLEAR;
    return level * clamp01((margin - min) / (clear - min));
  }
}

export default function create(options: PitchEstimatorOptions): PitchEstimator {
  return new SwipeEstimator(options);
}

/* -------------------------------------------------------------------------- */

/** Frozen because `estimate()` must not allocate, and no caller may mutate it. */
const SILENT: PitchEstimate = Object.freeze({ frequencyHz: null, confidence: 0 });

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * One kernel per candidate: a cosine lobe on the first and prime harmonics,
 * half-amplitude negative cosine in the valleys either side of each, tapered by
 * `1/sqrt(f)` because a sawtooth's partials fall off as `1/h` and the spectrum
 * has been square-rooted.
 *
 * Normalised by the norm of its POSITIVE part alone, which is Camacho's and is
 * not the same as normalising the whole kernel: the valleys are a penalty, and
 * a candidate whose valleys happen to be wide must not have that penalty shrunk
 * by the very normalisation meant to equalise its reach.
 */
function buildKernelBank(
  candidateHz: Float64Array,
  pointHz: Float64Array
): { start: Int32Array; point: Int32Array; weight: Float64Array } {
  const count = candidateHz.length;
  const points = pointHz.length;
  const start = new Int32Array(count + 1);
  const point: number[] = [];
  const weight: number[] = [];

  const kernel = new Float64Array(points);
  const topHz = pointHz[points - 1]!;

  for (let c = 0; c < count; c++) {
    start[c] = point.length;
    const f0 = candidateHz[c]!;
    kernel.fill(0);

    const maxHarmonic = Math.floor(topHz / f0 - 0.75);
    for (let h = 1; h <= maxHarmonic; h++) {
      if (h > 1 && !isPrime(h)) continue;
      // Each harmonic owns exactly 1.5 periods of the cosine, centred on its own
      // peak: the positive lobe within a quarter, the two half-weight negative
      // valleys out to three quarters. Consecutive harmonics tile that span
      // without overlapping, so no point is ever written by two of them.
      const loHz = (h - 0.75) * f0;
      const hiHz = (h + 0.75) * f0;
      for (let g = 0; g < points; g++) {
        const hz = pointHz[g]!;
        if (hz < loHz) continue;
        if (hz > hiHz) break;
        const q = hz / f0;
        const lobe = Math.cos(2 * Math.PI * q);
        kernel[g] = kernel[g]! + (Math.abs(q - h) < 0.25 ? lobe : lobe / 2);
      }
    }

    let norm = 0;
    for (let g = 0; g < points; g++) {
      const value = kernel[g]!;
      if (value === 0) continue;
      const tapered = value / Math.sqrt(pointHz[g]!);
      kernel[g] = tapered;
      if (tapered > 0) norm += tapered * tapered;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let g = 0; g < points; g++) {
        const value = kernel[g]!;
        if (value === 0) continue;
        point.push(g);
        weight.push(value / norm);
      }
    }
  }
  start[count] = point.length;

  return { start, point: Int32Array.from(point), weight: Float64Array.from(weight) };
}

function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let d = 3; d * d <= n; d += 2) {
    if (n % d === 0) return false;
  }
  return true;
}
