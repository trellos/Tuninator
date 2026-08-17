/**
 * Spectral-flux onset detection with an adaptive median threshold.
 *
 * RMS envelope alone misses a re-picked same-pitch note, which the eval scores
 * as a missed event. Spectral flux is what catches it.
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
  /** Frames in the adaptive median window. */
  medianWindow: number;
  /** Multiplier on the adaptive median. Higher = fewer onsets. */
  sensitivity: number;
};

export type OnsetResult = {
  isOnset: boolean;
  /** Positive half-wave rectified spectral flux for this hop. */
  flux: number;
  /** The adaptive threshold flux was compared against. */
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

/**
 * The decaying reference leaks `1 - REFERENCE_DECAY` of the frame's magnitude
 * back into the flux every hop even when nothing is happening, so the threshold
 * floor is that leak times a safety factor. Expressing the floor as a fraction
 * of the current frame's magnitude is what makes the detector level-independent
 * — an absolute floor that suppresses a quiet passage would be far below the
 * steady-state ripple of a loud one.
 */
const RIPPLE_FLOOR_FACTOR = 2;

/**
 * Absolute lower bound, in the same normalised units as `flux`: magnitudes are
 * scaled so a sinusoid of amplitude A contributes about A across its main lobe.
 * This is what stops the first speck of dither after a stretch of digital
 * silence — where the adaptive median and the relative floor are both zero —
 * from reading as an onset.
 */
const ABSOLUTE_FLUX_FLOOR = 1e-3;

export class OnsetDetector {
  /** Number of samples `process()` expects. Equals `fftSize`. */
  readonly windowSize: number;

  readonly sampleRate: number;
  readonly minIntervalMs: number;
  readonly medianWindow: number;
  readonly sensitivity: number;

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
  /** Threshold floor as a fraction of the frame's total magnitude. */
  private readonly relativeFloor: number;

  /** Ring buffer of the last `medianWindow` flux values. */
  private readonly fluxHistory: Float64Array;
  /** Scratch the median sorts into, so `process()` never allocates. */
  private readonly medianScratch: Float64Array;
  private historyCount = 0;
  private historyIndex = 0;

  private lastOnsetMs: number | null = null;

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

    this.relativeFloor = RIPPLE_FLOOR_FACTOR * (1 - REFERENCE_DECAY);

    this.fluxHistory = new Float64Array(medianWindow);
    this.medianScratch = new Float64Array(medianWindow);
  }

  /**
   * Call once per analysis hop with the most recent `windowSize` samples.
   * `timestampMs` gates the minimum inter-onset interval.
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
    let totalMagnitude = 0;
    const bins = this.fft.bins;
    for (let k = 0; k < bins; k++) {
      const scaled = magnitude[k]! * magnitudeScale;
      magnitude[k] = scaled;
      totalMagnitude += scaled;
      const delta = scaled - reference[k]!;
      if (delta > 0) flux += delta;
    }

    const threshold = Math.max(
      this.sensitivity * this.medianFlux(),
      this.relativeFloor * totalMagnitude,
      ABSOLUTE_FLUX_FLOOR
    );

    let isOnset = flux > threshold;
    if (isOnset && this.lastOnsetMs !== null) {
      // Timestamps come from the caller; `src/core/` never reads a clock.
      if (timestampMs - this.lastOnsetMs < this.minIntervalMs) isOnset = false;
    }
    if (isOnset) this.lastOnsetMs = timestampMs;

    // History and the reference advance regardless of suppression, so the
    // adaptive threshold keeps tracking the signal during the dead time.
    this.pushFlux(flux);
    for (let k = 0; k < bins; k++) {
      const decayed = reference[k]! * REFERENCE_DECAY;
      const current = magnitude[k]!;
      reference[k] = current > decayed ? current : decayed;
    }

    return { isOnset, flux, threshold };
  }

  reset(): void {
    this.reference.fill(0);
    this.fluxHistory.fill(0);
    this.historyCount = 0;
    this.historyIndex = 0;
    this.lastOnsetMs = null;
  }

  private pushFlux(flux: number): void {
    this.fluxHistory[this.historyIndex] = flux;
    this.historyIndex = (this.historyIndex + 1) % this.medianWindow;
    if (this.historyCount < this.medianWindow) this.historyCount++;
  }

  /**
   * Median of the flux values seen before this hop. Insertion sort on a
   * preallocated scratch buffer — `medianWindow` is ~17, and this keeps
   * `process()` allocation-free (a `subarray().sort()` would not).
   */
  private medianFlux(): number {
    const n = this.historyCount;
    if (n === 0) return 0;

    const scratch = this.medianScratch;
    const history = this.fluxHistory;
    for (let i = 0; i < n; i++) scratch[i] = history[i]!;

    for (let i = 1; i < n; i++) {
      const value = scratch[i]!;
      let j = i - 1;
      while (j >= 0 && scratch[j]! > value) {
        scratch[j + 1] = scratch[j]!;
        j--;
      }
      scratch[j + 1] = value;
    }

    const mid = n >> 1;
    return (n & 1) === 1 ? scratch[mid]! : (scratch[mid - 1]! + scratch[mid]!) / 2;
  }
}
