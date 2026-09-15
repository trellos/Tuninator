/**
 * A second onset witness at the render quantum: log-compressed spectral flux
 * against a max-filtered short reference, read every 128 samples.
 *
 * The broadband kernel (`onset.ts`) decides at the fast lane's hop, 13.3ms,
 * with a 60ms dead time, and on a direct input that is what loses the quiet
 * strokes of an alternate-picked run: measured on the four DI takes
 * (`scripts/measure-di-onset-ceiling.ts`) it reaches 42 of the 48 sixteenths
 * where the same physics at a 2.67ms hop reaches 47, and every stroke it
 * loses is lost at the kernel, before any tracker rule runs.
 *
 * Three things make this reading different from the broadband one, and each
 * is the published SuperFlux recipe (Böck & Widmer, DAFx-13):
 *
 *  - **log compression** of the magnitudes, `log(1 + γ|X|)`, so a quiet
 *    pick landing on a loud ringing note is not measured against a bar the
 *    ringing note sets;
 *  - a reference that is the per-bin MAXIMUM over the frames 8–24ms back,
 *    **max-filtered over ±1 bin**, so a partial wandering between bins as a
 *    note decays or bends generates no flux while new energy still does;
 *  - the trailing **median** subtracted, so the same threshold means the same
 *    thing at two input gains (Böck, Krebs & Schedl, ISMIR 2012).
 *
 * And one thing the recipe does not have, which the DI takes demanded:
 * **the preparation veto.** Listed one by one, every off-label firing of this
 * function on the DI sixteenths at its 47/48 point was the pick landing on
 * the string 32–51ms BEFORE the stroke, 13–30× weaker than the stroke that
 * followed. A candidate that is followed within `preparationMs` by one at
 * least `preparationRatio` times stronger is that contact, not a stroke, and
 * is dropped. The cost is that a candidate is only confirmed
 * `preparationMs` after it happened; the tracker backdates onto it.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 * `process()` allocates only the array of confirmed onsets it returns.
 */

import { RealFFT, hannWindow } from "./fft.js";

export type FineOnsetOptions = {
  sampleRate: number;
  /** Transform length in samples. 1024 at 48kHz is 21ms. */
  fftSize: number;
  /** Samples between successive readings. The render quantum, 128. */
  hop: number;
  /** Detection threshold on the median-subtracted flux. Zero disables. */
  threshold: number;
  /** Least separation between two confirmed onsets, ms. */
  minIntervalMs: number;
  /** How long a stronger candidate may follow before the earlier one is a contact. */
  preparationMs: number;
  /** How much stronger the follower must be to veto. */
  preparationRatio: number;
  /** Lowest and highest frequency summed, Hz. */
  loHz?: number;
  hiHz?: number;
};

export type FineOnset = {
  /** The last sample of the frame the candidate peaked in. */
  atSample: number;
  /** Median-subtracted flux at the peak, in the kernel's own units. */
  value: number;
  /**
   * How far the 5ms envelope fell around the onset, dB, against its maximum
   * over the preceding tens of milliseconds. Filled in by the fast lane from
   * the ring once the onset is confirmed; zero until then. See
   * `FastLane.dipAround` for the shape it measures.
   */
  dipDb: number;
  /** How far the envelope came back up after that dip, dB. */
  reboundDb: number;
};

/** Log compression constant: `log(1 + GAMMA * magnitude)`. */
const GAMMA = 200;
/** The reference spans the frames this many hops back, inclusive: 8–24ms. */
const REFERENCE_FROM_HOPS = 3;
const REFERENCE_TO_HOPS = 9;
/** Half-width of the max filter across frequency, in bins. */
const MAX_FILTER_BINS = 1;
/** Hops of history behind the trailing median: 100ms at the render quantum. */
const MEDIAN_HOPS = 38;
/** A candidate is a local maximum over this many hops either side: ±13ms. */
const LOCAL_MAX_HOPS = 5;

export class FineOnsetDetector {
  readonly windowSize: number;
  readonly hop: number;

  private readonly sampleRate: number;
  private readonly threshold: number;
  private readonly minIntervalSamples: number;
  private readonly preparationSamples: number;
  private readonly preparationRatio: number;

  private readonly fft: RealFFT;
  private readonly hann: Float32Array;
  private readonly windowed: Float32Array;
  private readonly magnitude: Float32Array;
  private readonly logMagnitude: Float32Array;
  /** Max-filtered log spectra of the last `REFERENCE_TO_HOPS + 1` frames. */
  private readonly history: Float32Array;
  private readonly bins: number;
  private readonly binFrom: number;
  private readonly binTo: number;
  private framesSeen = 0;

  /** Raw flux of the preceding hops, for the median. */
  private readonly fluxHistory: Float64Array;
  private readonly medianScratch: Float64Array;
  private fluxCount = 0;
  private fluxIndex = 0;

  /** The last `2 * LOCAL_MAX_HOPS + 1` adjusted values, with their end samples. */
  private readonly recentValue: Float64Array;
  private readonly recentSample: Float64Array;
  private recentCount = 0;
  private recentIndex = 0;

  private lastOnsetSample = Number.NEGATIVE_INFINITY;
  /** Candidates awaiting the preparation window. Few, short-lived. */
  private readonly pending: FineOnset[] = [];

  constructor(options: FineOnsetOptions) {
    const { sampleRate, fftSize, hop } = options;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error(`FineOnsetDetector: sampleRate must be > 0, got ${sampleRate}`);
    }
    if (!Number.isInteger(hop) || hop < 1) {
      throw new Error(`FineOnsetDetector: hop must be a positive integer, got ${hop}`);
    }
    this.sampleRate = sampleRate;
    this.windowSize = fftSize;
    this.hop = hop;
    this.threshold = options.threshold;
    this.minIntervalSamples = Math.round((options.minIntervalMs / 1000) * sampleRate);
    this.preparationSamples = Math.round((options.preparationMs / 1000) * sampleRate);
    this.preparationRatio = options.preparationRatio;

    this.fft = new RealFFT(fftSize);
    this.bins = this.fft.bins;
    this.hann = hannWindow(fftSize);
    this.windowed = new Float32Array(fftSize);
    this.magnitude = new Float32Array(this.bins);
    this.logMagnitude = new Float32Array(this.bins);
    this.history = new Float32Array(this.bins * (REFERENCE_TO_HOPS + 1));

    const binHz = sampleRate / fftSize;
    const lo = options.loHz ?? 80;
    const hi = options.hiHz ?? 8000;
    this.binFrom = Math.max(1, Math.round(lo / binHz));
    this.binTo = Math.min(this.bins, Math.round(hi / binHz));

    this.fluxHistory = new Float64Array(MEDIAN_HOPS);
    this.medianScratch = new Float64Array(MEDIAN_HOPS);
    this.recentValue = new Float64Array(2 * LOCAL_MAX_HOPS + 1);
    this.recentSample = new Float64Array(2 * LOCAL_MAX_HOPS + 1);

    // Magnitudes in amplitude units — a sinusoid of amplitude A reads about
    // A across its main lobe — so the log compression's knee sits where it
    // does in the broadband kernel and in the ceiling measurements, not 256
    // magnitudes higher.
    let windowSum = 0;
    for (let i = 0; i < fftSize; i++) windowSum += this.hann[i] as number;
    this.magnitudeScale = windowSum > 0 ? 2 / windowSum : 1;
  }

  private readonly magnitudeScale: number;

  /** Whether a threshold was configured at all. */
  get enabled(): boolean {
    return this.threshold > 0;
  }

  reset(): void {
    this.history.fill(0);
    this.framesSeen = 0;
    this.fluxCount = 0;
    this.fluxIndex = 0;
    this.recentCount = 0;
    this.recentIndex = 0;
    this.lastOnsetSample = Number.NEGATIVE_INFINITY;
    this.pending.length = 0;
  }

  /**
   * Read one frame: the `windowSize` samples ending at (exclusive)
   * `endSample`. Returns the onsets confirmed by this call — candidates old
   * enough that nothing stronger followed inside the preparation window.
   *
   * `audible` is the caller's amplitude gate, as for the broadband kernel: a
   * candidate below it neither fires nor arms the dead time.
   */
  process(window: Float32Array, endSample: number, audible: boolean): FineOnset[] {
    if (window.length !== this.windowSize) {
      throw new Error(
        `FineOnsetDetector.process: expected ${this.windowSize} samples, got ${window.length}`
      );
    }
    const { hann, windowed, magnitude, logMagnitude, history, bins } = this;
    const size = this.windowSize;
    for (let i = 0; i < size; i++) windowed[i] = (window[i] as number) * (hann[i] as number);
    this.fft.magnitudes(windowed, magnitude);
    for (let k = 0; k < bins; k++) {
      logMagnitude[k] = Math.log(1 + GAMMA * this.magnitudeScale * (magnitude[k] as number));
    }

    // Rectified log flux against the per-bin maximum of the stored reference
    // frames. The stored frames are already max-filtered across frequency,
    // and max commutes, so this is SuperFlux's filtered reference exactly.
    const frames = REFERENCE_TO_HOPS + 1;
    let flux = 0;
    if (this.framesSeen >= REFERENCE_TO_HOPS) {
      for (let k = this.binFrom; k < this.binTo; k++) {
        let reference = 0;
        for (let d = REFERENCE_FROM_HOPS; d <= REFERENCE_TO_HOPS; d++) {
          const slot = (((this.framesSeen - d) % frames) + frames) % frames;
          const past = history[slot * bins + k] as number;
          if (past > reference) reference = past;
        }
        const delta = (logMagnitude[k] as number) - reference;
        if (delta > 0) flux += delta;
      }
    }

    // Store this frame, max-filtered across ±MAX_FILTER_BINS.
    const slot = (this.framesSeen % frames) * bins;
    for (let k = 0; k < bins; k++) {
      let peak = 0;
      for (let j = Math.max(0, k - MAX_FILTER_BINS); j <= Math.min(bins - 1, k + MAX_FILTER_BINS); j++) {
        const v = logMagnitude[j] as number;
        if (v > peak) peak = v;
      }
      history[slot + k] = peak;
    }
    this.framesSeen++;

    // Level-adaptive: the flux over the median of the preceding hops.
    const adjusted = flux - this.medianFlux();
    this.pushFlux(flux);

    // Peak picking over the centre of a short ring: a candidate is the
    // maximum over ±LOCAL_MAX_HOPS, which costs that many hops of latency.
    const ringSize = 2 * LOCAL_MAX_HOPS + 1;
    this.recentValue[this.recentIndex] = audible ? adjusted : Number.NEGATIVE_INFINITY;
    this.recentSample[this.recentIndex] = endSample;
    this.recentIndex = (this.recentIndex + 1) % ringSize;
    if (this.recentCount < ringSize) this.recentCount++;

    if (this.recentCount === ringSize && this.threshold > 0) {
      const centre = (this.recentIndex + LOCAL_MAX_HOPS) % ringSize;
      const value = this.recentValue[centre] as number;
      if (value >= this.threshold) {
        let isMax = true;
        for (let i = 0; i < ringSize; i++) {
          if (i !== centre && (this.recentValue[i] as number) > value) {
            isMax = false;
            break;
          }
        }
        const atSample = this.recentSample[centre] as number;
        if (isMax && atSample - this.lastOnsetSample >= this.minIntervalSamples) {
          this.lastOnsetSample = atSample;
          // A stronger arrival inside the preparation window vetoes what
          // came before it: that was the pick landing, this is the stroke.
          for (let i = this.pending.length - 1; i >= 0; i--) {
            const earlier = this.pending[i] as FineOnset;
            if (
              atSample - earlier.atSample <= this.preparationSamples &&
              value >= this.preparationRatio * earlier.value
            ) {
              this.pending.splice(i, 1);
            }
          }
          this.pending.push({ atSample, value, dipDb: 0, reboundDb: 0 });
        }
      }
    }

    // Confirm what has outlived the preparation window.
    const confirmed: FineOnset[] = [];
    while (this.pending.length > 0) {
      const oldest = this.pending[0] as FineOnset;
      if (endSample - oldest.atSample < this.preparationSamples) break;
      this.pending.shift();
      confirmed.push(oldest);
    }
    return confirmed;
  }

  private pushFlux(flux: number): void {
    this.fluxHistory[this.fluxIndex] = flux;
    this.fluxIndex = (this.fluxIndex + 1) % MEDIAN_HOPS;
    if (this.fluxCount < MEDIAN_HOPS) this.fluxCount++;
  }

  /** Median of the flux values before this hop; zero until there are enough. */
  private medianFlux(): number {
    const n = this.fluxCount;
    if (n < 8) return 0;
    const scratch = this.medianScratch;
    for (let i = 0; i < n; i++) scratch[i] = this.fluxHistory[i] as number;
    for (let i = 1; i < n; i++) {
      const v = scratch[i] as number;
      let j = i - 1;
      while (j >= 0 && (scratch[j] as number) > v) {
        scratch[j + 1] = scratch[j] as number;
        j--;
      }
      scratch[j + 1] = v;
    }
    return scratch[n >> 1] as number;
  }
}
