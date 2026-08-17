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
 * Absolute lower bound on the threshold, in the same normalised units as
 * `flux`: magnitudes are scaled so that a sinusoid of amplitude A contributes
 * roughly A across its main lobe. So this floor is "a note appearing out of
 * nothing at about -60 dBFS", which is below any real pick attack and above
 * the numerical wobble of a steady tone.
 *
 * Without it, a stretch of digital silence drives the adaptive median to zero
 * and the first speck of noise afterwards reads as an onset.
 */
const FLUX_FLOOR = 1e-3;

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
  /** Magnitude spectrum of this hop, and of the previous one. */
  private readonly magnitude: Float32Array;
  private readonly previousMagnitude: Float32Array;
  /** Amplitude-correcting scale for the Hann-windowed magnitudes. */
  private readonly magnitudeScale: number;

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
    this.previousMagnitude = new Float32Array(this.fft.bins);

    let windowSum = 0;
    for (let i = 0; i < fftSize; i++) windowSum += this.hann[i]!;
    this.magnitudeScale = windowSum > 0 ? 2 / windowSum : 1;

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

    const { hann, windowed, magnitude, previousMagnitude, magnitudeScale } = this;
    const size = this.windowSize;

    for (let i = 0; i < size; i++) {
      windowed[i] = window[i]! * hann[i]!;
    }
    this.fft.magnitudes(windowed, magnitude);

    // Positive half-wave rectified difference of successive magnitude spectra.
    // Rectification is the whole point: only energy *appearing* is an attack,
    // energy decaying is not.
    let flux = 0;
    const bins = this.fft.bins;
    for (let k = 0; k < bins; k++) {
      const scaled = magnitude[k]! * magnitudeScale;
      magnitude[k] = scaled;
      const delta = scaled - previousMagnitude[k]!;
      if (delta > 0) flux += delta;
    }

    const threshold = Math.max(this.sensitivity * this.medianFlux(), FLUX_FLOOR);

    let isOnset = flux > threshold;
    if (isOnset && this.lastOnsetMs !== null) {
      // Timestamps come from the caller; `src/core/` never reads a clock.
      if (timestampMs - this.lastOnsetMs < this.minIntervalMs) isOnset = false;
    }
    if (isOnset) this.lastOnsetMs = timestampMs;

    // History and the previous spectrum advance regardless of suppression, so
    // the adaptive threshold keeps tracking the signal during the dead time.
    this.pushFlux(flux);
    previousMagnitude.set(magnitude);

    return { isOnset, flux, threshold };
  }

  reset(): void {
    this.previousMagnitude.fill(0);
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
