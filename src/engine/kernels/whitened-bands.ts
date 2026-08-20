/**
 * Adaptive whitening and log-band reduction over the flux kernel's magnitude
 * spectra, plus a short causal ring of the reduced frames.
 *
 * The whitening recurrence is Stowell & Plumbley's (ICMC 2007), with the
 * constants measured in `scripts/measure-whitening-separability.ts` and kept
 * by DECISION-014 as the scale fix for take-dependent witness magnitudes:
 *
 *   P[f] <- max( |X[f]| , m * P[f] , floor )        m = 0.99, floor = 0.01
 *   Xw[f] = |X[f]| / P[f]
 *
 * so every bin occupies [0, 1] regardless of spectral roll-off, playing
 * dynamics, and what the signal chain did to the level. The reduction pools
 * the whitened bins into geometrically spaced bands with triangular weights,
 * because at fftSize 1024 the linear bin axis spends most of its resolution
 * where guitar spectra have the least structure, and a fixed-Hz axis would
 * make the same interval mean different widths at different pitches.
 *
 * The ring holds the last `PATCH_HOPS` reduced frames. Its span at the 48kHz
 * hop (13.33ms) is 8 x 13.33 = 106.7ms from oldest frame to the current one —
 * deliberately inside the corpus's tightest subdivision, the 107ms sixteenth
 * at 140bpm, per the standing lesson that a window wider than the spacing of
 * the events it discriminates produces false findings.
 *
 * Everything here is causal: `push()` consumes one magnitude frame and the
 * patch ends at that frame. Nothing reads ahead, nothing allocates after
 * construction, and the class is pure over Float32Array — part of
 * `src/engine/`, so no DOM, no globals, no clock reads, no npm imports.
 */

import { RealFFT, hannWindow } from "./fft.js";

/** Whitening memory: per-bin running peak decays by this per hop. */
export const WHITEN_M = 0.99;
/** Whitening floor: silence whitens to (tiny / floor), not to 0 / 0. */
export const WHITEN_FLOOR = 0.01;
/** Reduced frequency axis: this many geometrically spaced bands. */
export const BAND_COUNT = 60;
/** Band centre range, Hz. 65Hz sits under the low E's 82.4Hz fundamental. */
export const BAND_MIN_HZ = 65;
export const BAND_MAX_HZ = 8000;
/** Hops in the causal patch, current hop included. */
export const PATCH_HOPS = 9;
/** Decay per hop of the held (peak-hold) whitened reference. */
export const HELD_DECAY = 0.95;

/** The four whitened flux readings, mirroring the un-whitened witness split. */
export type WhitenedFlux = {
  /** Positive per-bin change against the short (recent frames) reference. */
  wFlux: number;
  /** The same, over the frame's own total whitened magnitude. */
  wFluxNorm: number;
  /** Positive change against the decaying peak hold since the sound began. */
  wHeldFlux: number;
  wHeldNorm: number;
};

/**
 * Triangular pooling weights from linear FFT bins to geometric bands.
 *
 * Each band's triangle runs from the previous band centre to the next, so the
 * bands overlap by construction and every bin between the first and last
 * centre is heard by at least one band. Near DC a band can be narrower than
 * one bin; the triangle is then widened to the bin spacing so no band is
 * silent. Weights are normalised per band, making a band's reading the
 * weighted MEAN of its whitened bins — bounded [0, 1] like the bins are.
 */
export function bandWeights(
  sampleRate: number,
  fftSize: number,
  bins: number
): { indices: Int32Array; offsets: Int32Array; weights: Float32Array } {
  const binHz = sampleRate / fftSize;
  const centres = new Float64Array(BAND_COUNT);
  const ratio = Math.pow(BAND_MAX_HZ / BAND_MIN_HZ, 1 / (BAND_COUNT - 1));
  for (let b = 0; b < BAND_COUNT; b++) centres[b] = BAND_MIN_HZ * Math.pow(ratio, b);

  const indices: number[] = [];
  const offsets = new Int32Array(BAND_COUNT + 1);
  const weights: number[] = [];
  for (let b = 0; b < BAND_COUNT; b++) {
    const centre = centres[b] as number;
    let lo = b > 0 ? (centres[b - 1] as number) : centre / ratio;
    let hi = b < BAND_COUNT - 1 ? (centres[b + 1] as number) : centre * ratio;
    // A triangle narrower than the bin spacing pools nothing; widen it.
    if (centre - lo < binHz) lo = centre - binHz;
    if (hi - centre < binHz) hi = centre + binHz;
    const kLo = Math.max(0, Math.ceil(lo / binHz));
    const kHi = Math.min(bins - 1, Math.floor(hi / binHz));
    let sum = 0;
    const start = indices.length;
    for (let k = kLo; k <= kHi; k++) {
      const hz = k * binHz;
      const w =
        hz <= centre ? (hz - lo) / Math.max(centre - lo, 1e-9) : (hi - hz) / Math.max(hi - centre, 1e-9);
      if (w <= 0) continue;
      indices.push(k);
      weights.push(w);
      sum += w;
    }
    for (let i = start; i < weights.length; i++) weights[i] = (weights[i] as number) / sum;
    offsets[b + 1] = indices.length;
  }
  return { indices: Int32Array.from(indices), offsets, weights: Float32Array.from(weights) };
}

/**
 * The extractor plus the transform that feeds it: Hann window, real FFT, and
 * the flux kernel's own magnitude scaling (2 / window-sum). One class so the
 * fast lane and the training pipeline run the SAME code from raw samples to
 * patch — the only thing a caller supplies is the window of `fftSize` samples
 * ending at the hop.
 */
export class WhitenedBandPipeline {
  private readonly fft: RealFFT;
  private readonly hann: Float32Array;
  private readonly windowed: Float32Array;
  private readonly magnitude: Float32Array;
  private readonly magnitudeScale: number;
  readonly extractor: WhitenedBandExtractor;

  constructor(sampleRate: number, fftSize: number, referenceFrames: number) {
    this.fft = new RealFFT(fftSize);
    this.hann = hannWindow(fftSize);
    this.windowed = new Float32Array(fftSize);
    this.magnitude = new Float32Array(this.fft.bins);
    let windowSum = 0;
    for (let i = 0; i < fftSize; i++) windowSum += this.hann[i] as number;
    this.magnitudeScale = windowSum > 0 ? 2 / windowSum : 1;
    this.extractor = new WhitenedBandExtractor(sampleRate, fftSize, this.fft.bins, referenceFrames);
  }

  /** Consume one hop's window (length `fftSize`, ending at the hop). */
  push(window: Float32Array): void {
    const n = this.windowed.length;
    for (let i = 0; i < n; i++) this.windowed[i] = (window[i] as number) * (this.hann[i] as number);
    this.fft.magnitudes(this.windowed, this.magnitude);
    for (let k = 0; k < this.magnitude.length; k++) {
      this.magnitude[k] = (this.magnitude[k] as number) * this.magnitudeScale;
    }
    this.extractor.push(this.magnitude);
  }

  patch(out: Float32Array): Float32Array {
    return this.extractor.patch(out);
  }

  whitenedFlux(): WhitenedFlux {
    return this.extractor.whitenedFlux();
  }

  reset(): void {
    this.extractor.reset();
  }
}

export class WhitenedBandExtractor {
  private readonly bins: number;
  private readonly referenceFrames: number;
  private readonly peaks: Float32Array;
  private readonly whitened: Float32Array;
  private readonly history: Float32Array;
  private readonly held: Float32Array;
  private historyIndex = 0;
  private historyFilled = 0;

  private readonly bandIndex: Int32Array;
  private readonly bandOffset: Int32Array;
  private readonly bandWeight: Float32Array;
  /** Ring of reduced frames, `PATCH_HOPS` deep, zero until filled. */
  private readonly ring: Float32Array;
  private ringIndex = 0;
  private pushed = 0;

  private readonly flux: WhitenedFlux = { wFlux: 0, wFluxNorm: 0, wHeldFlux: 0, wHeldNorm: 0 };

  constructor(sampleRate: number, fftSize: number, bins: number, referenceFrames: number) {
    this.bins = bins;
    this.referenceFrames = Math.max(1, referenceFrames);
    this.peaks = new Float32Array(bins).fill(WHITEN_FLOOR);
    this.whitened = new Float32Array(bins);
    this.history = new Float32Array(bins * this.referenceFrames);
    this.held = new Float32Array(bins);
    const bw = bandWeights(sampleRate, fftSize, bins);
    this.bandIndex = bw.indices;
    this.bandOffset = bw.offsets;
    this.bandWeight = bw.weights;
    this.ring = new Float32Array(BAND_COUNT * PATCH_HOPS);
  }

  reset(): void {
    this.peaks.fill(WHITEN_FLOOR);
    this.whitened.fill(0);
    this.history.fill(0);
    this.held.fill(0);
    this.historyIndex = 0;
    this.historyFilled = 0;
    this.ring.fill(0);
    this.ringIndex = 0;
    this.pushed = 0;
    this.flux.wFlux = 0;
    this.flux.wFluxNorm = 0;
    this.flux.wHeldFlux = 0;
    this.flux.wHeldNorm = 0;
  }

  /**
   * Consume one magnitude frame (the flux kernel's own scaling), advancing the
   * whitening state, the flux readings, and the patch ring by one hop.
   */
  push(magnitude: Float32Array): void {
    const bins = this.bins;
    const P = this.peaks;
    const W = this.whitened;
    const H = this.history;
    const held = this.held;

    let flux = 0;
    let heldFlux = 0;
    let total = 0;
    for (let k = 0; k < bins; k++) {
      const mag = magnitude[k] as number;
      const decayed = WHITEN_M * (P[k] as number);
      const peak =
        mag > decayed ? (mag > WHITEN_FLOOR ? mag : WHITEN_FLOOR) : decayed > WHITEN_FLOOR ? decayed : WHITEN_FLOOR;
      P[k] = peak;
      const w = mag / peak;
      W[k] = w;
      total += w;
      let reference = 0;
      for (let f = 0; f < this.historyFilled; f++) {
        const past = H[f * bins + k] as number;
        if (past > reference) reference = past;
      }
      const delta = w - reference;
      if (delta > 0) flux += delta;
      const heldDelta = w - (held[k] as number);
      if (heldDelta > 0) heldFlux += heldDelta;
    }
    this.flux.wFlux = flux;
    this.flux.wFluxNorm = flux / Math.max(total, 1e-9);
    this.flux.wHeldFlux = heldFlux;
    this.flux.wHeldNorm = heldFlux / Math.max(total, 1e-9);

    const slot = this.historyIndex * bins;
    for (let k = 0; k < bins; k++) {
      H[slot + k] = W[k] as number;
      const dec = (held[k] as number) * HELD_DECAY;
      held[k] = (W[k] as number) > dec ? (W[k] as number) : dec;
    }
    this.historyIndex = (this.historyIndex + 1) % this.referenceFrames;
    if (this.historyFilled < this.referenceFrames) this.historyFilled++;

    // Reduce to bands and write the ring slot for this hop.
    const ringSlot = this.ringIndex * BAND_COUNT;
    for (let b = 0; b < BAND_COUNT; b++) {
      const start = this.bandOffset[b] as number;
      const end = this.bandOffset[b + 1] as number;
      let v = 0;
      for (let i = start; i < end; i++) {
        v += (this.bandWeight[i] as number) * (W[this.bandIndex[i] as number] as number);
      }
      this.ring[ringSlot + b] = v;
    }
    this.ringIndex = (this.ringIndex + 1) % PATCH_HOPS;
    this.pushed++;
  }

  /** The flux readings of the most recent `push`. The object is reused. */
  whitenedFlux(): WhitenedFlux {
    return this.flux;
  }

  /**
   * The causal patch: `PATCH_HOPS` reduced frames ending at the most recent
   * `push`, oldest first, row-major `[hop][band]`. Hops before the first push
   * read as zero, so an early decision sees silence behind it rather than
   * another take's tail.
   */
  patch(out: Float32Array): Float32Array {
    const hops = PATCH_HOPS;
    for (let t = 0; t < hops; t++) {
      // t = 0 is the oldest requested hop, t = hops - 1 the current one.
      const age = hops - 1 - t;
      if (age >= this.pushed) {
        out.fill(0, t * BAND_COUNT, (t + 1) * BAND_COUNT);
        continue;
      }
      const slot = (((this.ringIndex - 1 - age) % hops) + hops) % hops;
      out.set(this.ring.subarray(slot * BAND_COUNT, (slot + 1) * BAND_COUNT), t * BAND_COUNT);
    }
    return out;
  }
}
