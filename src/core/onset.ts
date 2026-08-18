/**
 * Spectral-flux onset detection with peak picking.
 *
 * RMS envelope alone misses a re-picked same-pitch note, which the eval scores
 * as a missed event. Spectral flux is what catches it.
 *
 * WHY PEAK PICKING, AND NOT A THRESHOLD CROSSING
 *
 * The obvious detector — "flux above an adaptive threshold is an attack" —
 * cannot express the thing that actually distinguishes an attack: an attack is
 * a *peak*, and the ripple that surrounds it is not. Measured on the
 * power-chord fixture, thresholding fired ten times in twenty seconds and NOT
 * ONCE within 150ms of any of the eight strums. Two mechanisms did that, and
 * neither is fixable by moving a number:
 *
 *  - A level-proportional floor has to exist, because the decaying peak-hold
 *    reference leaks a fixed fraction of the frame's magnitude back into the
 *    flux every hop. But the frame with the most magnitude in it is the attack,
 *    so the floor is highest exactly where it must be lowest, and the loudest
 *    strums are the ones it hides.
 *  - Whatever crosses first wins, and the minimum inter-onset interval then
 *    locks out everything behind it. The finger noise 100ms before the first C5
 *    chord crossed at flux 0.0013; the strum itself, at flux 0.216, arrived
 *    inside the dead time and was discarded.
 *
 * Peak picking answers both. A candidate must be the largest flux in its
 * neighbourhood, which is what "attack" means and what ripple never is, and the
 * threshold can then be a plain multiple of the local mean with no
 * level-proportional term at all. It is the standard formulation — Dixon,
 * "Onset Detection Revisited" (DAFx-06).
 *
 * THE COST IS LATENCY. A peak cannot be recognised until the frames after it
 * have been seen, so `process()` reports onsets `peakWindow` hops late and
 * stamps them with the time they really happened. That backdating is not a
 * consolation prize: it is more accurate than the old immediate answer, which
 * fired on whatever crossed first.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the DSP-core
 * workstream.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import { RealFFT, hannWindow } from "./fft.js";

export type OnsetOptions = {
  sampleRate: number;
  fftSize: number;
  /** Minimum inter-onset interval, ms. 120bpm sixteenths are 125ms apart. */
  minIntervalMs: number;
  /** Frames in the adaptive mean window, counted forward from the candidate. */
  medianWindow: number;
  /** Multiplier on the adaptive mean. Higher = fewer onsets. */
  sensitivity: number;
  /** Hops either side a candidate must lead to count as a peak. Default 3. */
  peakWindow?: number;
  /** Safety factor on the ripple floor. Defaults to 2. */
  rippleFloorFactor?: number;
};

export type OnsetResult = {
  isOnset: boolean;
  /**
   * When the reported attack happened — `peakWindow` hops before the call that
   * returned it. Null when `isOnset` is false.
   */
  onsetTimestampMs: number | null;
  /** Positive half-wave rectified spectral flux for THIS hop. */
  flux: number;
  /** The adaptive threshold the candidate hop was compared against. */
  threshold: number;
};

/**
 * Per-hop decay of the reference spectrum.
 *
 * The reference is a per-bin peak hold rather than simply the previous frame.
 * While the spectrum is steady or rising the two are identical — the hold only
 * differs when a bin dips and comes back, which at `fftSize` 1024 and 44.1kHz
 * is mostly an artefact, not music: bin spacing is 43Hz, so the harmonics of a
 * low E (82.4Hz, 1.9 bins apart) are unresolved and their overlapping main
 * lobes beat against each other as the frame phase advances. Measured on a
 * *perfectly steady* synthetic low E, the plain successive-frame flux swings
 * between 0.003 and 0.68 on alternate hops — as large as a real pick attack.
 * The peak hold removes that ripple and leaves attacks untouched.
 */
const REFERENCE_DECAY = 0.95;

/** Hops either side of a candidate that it must lead. ~40ms at the default hop. */
const DEFAULT_PEAK_WINDOW = 3;

/**
 * Default safety factor on the ripple floor.
 *
 * The peak-hold reference decays by `1 - REFERENCE_DECAY` every hop, so a
 * perfectly steady note still leaks that fraction of its own magnitude back
 * into the flux, forever. The leak is not smooth — unresolved harmonics beat
 * against each other and it swings by nearly 3x around its mean — so on a
 * steady tone the mean-based threshold alone admits every other ripple peak,
 * measured at 14 "onsets" in a two-second synthetic low E that never changes.
 *
 * The floor that fixes it is proportional to the REFERENCE, not to the frame.
 * That distinction is the whole point: the leak is a property of what is
 * already sounding, so a floor scaled to the reference sits just above the
 * ripple during a sustain and drops to nothing where the reference is empty —
 * which is exactly where attacks are. Scaling it to the current frame instead,
 * as this once did, puts the highest floor on the loudest frame in the file,
 * and the loudest frame in the file is the strum.
 */
const DEFAULT_RIPPLE_FLOOR_FACTOR = 2;

/**
 * Absolute lower bound, in the same normalised units as `flux`: magnitudes are
 * scaled so a sinusoid of amplitude A contributes about A across its main lobe.
 * This is what stops the first speck of dither after a stretch of digital
 * silence — where the adaptive mean is zero — from reading as an onset.
 */
const ABSOLUTE_FLUX_FLOOR = 1e-3;

/**
 * How much louder than the last accepted onset a peak must be to be accepted
 * inside the minimum inter-onset interval.
 *
 * The interval exists to stop one attack registering twice, and for that it
 * must be generous. But a guitarist's hand touching the strings before a strum
 * is a real, small flux peak a few tens of milliseconds ahead of a real, large
 * one, and a generous interval lets the noise silence the music. A peak several
 * times larger than the one that opened the dead time is not an echo of it.
 */
const RETRIGGER_FLUX_RATIO = 3;

export class OnsetDetector {
  /** Number of samples `process()` expects. Equals `fftSize`. */
  readonly windowSize: number;

  readonly sampleRate: number;
  readonly minIntervalMs: number;
  readonly medianWindow: number;
  readonly sensitivity: number;
  readonly peakWindow: number;
  readonly rippleFloorFactor: number;

  private readonly fft: RealFFT;
  /** Periodic Hann, applied before every transform. */
  private readonly hann: Float32Array;
  /** Scratch for the windowed frame. */
  private readonly windowed: Float32Array;
  /** Magnitude spectrum of this hop. */
  private readonly magnitude: Float32Array;
  /** Decaying per-bin peak hold of previous hops; the flux reference. */
  private readonly reference: Float32Array;
  /** Amplitude-correcting scale for the Hann-windowed magnitudes. */
  private readonly magnitudeScale: number;

  /**
   * Ring of recent flux values and their timestamps, oldest first once full.
   * Long enough to hold the mean window behind a candidate and the peak window
   * in front of it.
   */
  private readonly fluxHistory: Float64Array;
  private readonly timeHistory: Float64Array;
  /** Per-hop ripple floor, kept in step with `fluxHistory`. */
  private readonly floorHistory: Float64Array;
  private readonly historySize: number;
  private historyCount = 0;
  /** Where the next value goes; also the oldest value once the ring is full. */
  private historyIndex = 0;

  private lastOnsetMs: number | null = null;
  private lastOnsetFlux = 0;

  constructor(options: OnsetOptions) {
    const { sampleRate, fftSize, minIntervalMs, medianWindow, sensitivity } = options;

    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error(`OnsetDetector: sampleRate must be > 0, got ${sampleRate}`);
    }
    if (!Number.isInteger(medianWindow) || medianWindow < 1) {
      throw new Error(`OnsetDetector: medianWindow must be an integer >= 1, got ${medianWindow}`);
    }

    this.windowSize = fftSize;
    this.sampleRate = sampleRate;
    this.minIntervalMs = minIntervalMs;
    this.medianWindow = medianWindow;
    this.sensitivity = sensitivity;
    this.peakWindow = Math.max(1, Math.round(options.peakWindow ?? DEFAULT_PEAK_WINDOW));
    this.rippleFloorFactor = options.rippleFloorFactor ?? DEFAULT_RIPPLE_FLOOR_FACTOR;

    // Throws for a non-power-of-two or undersized fftSize.
    this.fft = new RealFFT(fftSize);
    this.hann = hannWindow(fftSize);
    this.windowed = new Float32Array(fftSize);
    this.magnitude = new Float32Array(this.fft.bins);
    this.reference = new Float32Array(this.fft.bins);

    // A sinusoid of amplitude A peaks at A*sum(w)/2 in the raw transform.
    let windowSum = 0;
    for (let i = 0; i < fftSize; i++) windowSum += this.hann[i]!;
    this.magnitudeScale = windowSum > 0 ? 2 / windowSum : 1;

    // Everything the candidate hop needs on both sides, plus the candidate.
    this.historySize = this.medianWindow + 2 * this.peakWindow + 1;
    this.fluxHistory = new Float64Array(this.historySize);
    this.timeHistory = new Float64Array(this.historySize);
    this.floorHistory = new Float64Array(this.historySize);
  }

  /**
   * Call once per analysis hop with the most recent `windowSize` samples.
   *
   * The onset it reports, if any, is the hop `peakWindow` back — see the file
   * header. `timestampMs` is this hop's time; the reported onset carries its
   * own.
   */
  process(window: Float32Array, timestampMs: number): OnsetResult {
    if (window.length !== this.windowSize) {
      throw new Error(
        `OnsetDetector.process: expected ${this.windowSize} samples, got ${window.length}`
      );
    }

    const { hann, windowed, magnitude, reference, magnitudeScale } = this;
    const size = this.windowSize;

    for (let i = 0; i < size; i++) {
      windowed[i] = window[i]! * hann[i]!;
    }
    this.fft.magnitudes(windowed, magnitude);

    // Positive half-wave rectified difference against the reference spectrum.
    // Rectification is the whole point: only energy *appearing* is an attack,
    // energy decaying is not — which is why this fires on a re-picked note at
    // the same pitch, where the RMS envelope barely moves.
    let flux = 0;
    let referenceTotal = 0;
    const bins = this.fft.bins;
    for (let k = 0; k < bins; k++) {
      const scaled = magnitude[k]! * magnitudeScale;
      magnitude[k] = scaled;
      const held = reference[k]!;
      referenceTotal += held;
      const delta = scaled - held;
      if (delta > 0) flux += delta;
    }

    for (let k = 0; k < bins; k++) {
      const decayed = reference[k]! * REFERENCE_DECAY;
      const current = magnitude[k]!;
      reference[k] = current > decayed ? current : decayed;
    }

    // What a perfectly steady spectrum at this level would leak into the flux.
    const rippleFloor = this.rippleFloorFactor * (1 - REFERENCE_DECAY) * referenceTotal;
    this.push(flux, timestampMs, rippleFloor);
    const verdict = this.judgeCandidate();
    return { ...verdict, flux };
  }

  reset(): void {
    this.reference.fill(0);
    this.fluxHistory.fill(0);
    this.timeHistory.fill(0);
    this.floorHistory.fill(0);
    this.historyCount = 0;
    this.historyIndex = 0;
    this.lastOnsetMs = null;
    this.lastOnsetFlux = 0;
  }

  private push(flux: number, timestampMs: number, rippleFloor: number): void {
    this.fluxHistory[this.historyIndex] = flux;
    this.timeHistory[this.historyIndex] = timestampMs;
    this.floorHistory[this.historyIndex] = rippleFloor;
    this.historyIndex = (this.historyIndex + 1) % this.historySize;
    if (this.historyCount < this.historySize) this.historyCount++;
  }

  /** `age` 0 is the newest hop pushed, 1 the one before it, and so on. */
  private fluxAt(age: number): number {
    const index = (this.historyIndex - 1 - age + 2 * this.historySize) % this.historySize;
    return this.fluxHistory[index]!;
  }

  private timeAt(age: number): number {
    const index = (this.historyIndex - 1 - age + 2 * this.historySize) % this.historySize;
    return this.timeHistory[index]!;
  }

  private floorAt(age: number): number {
    const index = (this.historyIndex - 1 - age + 2 * this.historySize) % this.historySize;
    return this.floorHistory[index]!;
  }

  /**
   * Decides whether the hop `peakWindow` back was an attack.
   *
   * Three tests, all of which must pass:
   *
   *  - **It is a peak.** No hop within `peakWindow` either side carries more
   *    flux. Ripple during a sustain fails this; an attack never does.
   *  - **It stands out.** It clears `sensitivity` times the mean flux over the
   *    surrounding window, the ripple floor for the level already sounding, and
   *    an absolute floor for digital silence. The mean includes the candidate,
   *    so a lone spike in a quiet stretch passes easily and one more ripple
   *    among many does not.
   *  - **It is not an echo.** Far enough after the last accepted onset, or
   *    several times louder than it — see `RETRIGGER_FLUX_RATIO`.
   */
  private judgeCandidate(): Omit<OnsetResult, "flux"> {
    const w = this.peakWindow;
    const span = this.medianWindow + w;
    const rejected = { isOnset: false, onsetTimestampMs: null };

    // The mean is taken over whatever history exists rather than waiting for a
    // full window. Waiting would cost the first `medianWindow` hops outright,
    // and the first attack in a stream is the one a tuner most needs.
    let sum = 0;
    const available = Math.min(this.historyCount, span);
    for (let age = 0; age < available; age++) sum += this.fluxAt(age);
    const threshold = Math.max(
      available > 0 ? this.sensitivity * (sum / available) : 0,
      this.floorAt(Math.min(w, Math.max(0, this.historyCount - 1))),
      ABSOLUTE_FLUX_FLOOR
    );
    // A candidate does need the peak window on BOTH sides: that is what makes
    // it a peak rather than merely a large number.
    if (this.historyCount < 2 * w + 1) return { ...rejected, threshold };

    const candidate = this.fluxAt(w);
    const candidateTime = this.timeAt(w);

    // Ties go to the earlier hop, so a flat-topped attack reports its onset at
    // the front of the plateau rather than the back.
    for (let age = 0; age < w; age++) {
      if (this.fluxAt(age) >= candidate) return { ...rejected, threshold };
    }
    for (let age = w + 1; age <= 2 * w; age++) {
      if (this.fluxAt(age) > candidate) return { ...rejected, threshold };
    }

    if (candidate < threshold) return { ...rejected, threshold };

    if (this.lastOnsetMs !== null && candidateTime - this.lastOnsetMs < this.minIntervalMs) {
      if (candidate < this.lastOnsetFlux * RETRIGGER_FLUX_RATIO) {
        return { ...rejected, threshold };
      }
    }

    this.lastOnsetMs = candidateTime;
    this.lastOnsetFlux = candidate;
    return { isOnset: true, onsetTimestampMs: candidateTime, threshold };
  }
}
