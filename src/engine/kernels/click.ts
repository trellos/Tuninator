/**
 * The click band: a causal 2-8kHz bandpass and a fine amplitude envelope at
 * sub-millisecond resolution.
 *
 * A pick striking a string produces a broadband click 1-5ms long. Every other
 * witness in this engine measures that click after dilution into a 23ms
 * spectral window on a 12ms hop — a 5-20x smearing of the most discriminative
 * moment in the signal. This kernel keeps the click at its own timescale: the
 * band above a guitar's strong partials and below the region a room mic fills
 * with hiss, rectified and smoothed just enough (~1ms) that a 1-5ms click
 * stays resolved as a spike rather than a plateau.
 *
 * The filter is a cascade of RBJ biquads (two high-pass sections at the low
 * edge, two low-pass at the high edge, Butterworth Q), causal by construction:
 * output at sample n reads nothing after n. That matters because the fast lane
 * must be able to run this over the most recent hop of raw samples at decision
 * time.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

export type ClickBandOptions = {
  /** Low edge of the click band, Hz. */
  loHz?: number;
  /** High edge of the click band, Hz. */
  hiHz?: number;
  /** Rectified-envelope smoothing window, ms. Keep ~1ms so a click stays a spike. */
  smoothMs?: number;
};

const DEFAULTS: Required<ClickBandOptions> = { loHz: 2000, hiHz: 8000, smoothMs: 1.0 };

/** One direct-form-I biquad section. Coefficients from the RBJ cookbook. */
export class Biquad {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private constructor(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  static highpass(sampleRate: number, cutoffHz: number, q = Math.SQRT1_2): Biquad {
    const w = (2 * Math.PI * cutoffHz) / sampleRate;
    const cosw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    return new Biquad((1 + cosw) / 2, -(1 + cosw), (1 + cosw) / 2, 1 + alpha, -2 * cosw, 1 - alpha);
  }

  static lowpass(sampleRate: number, cutoffHz: number, q = Math.SQRT1_2): Biquad {
    const w = (2 * Math.PI * cutoffHz) / sampleRate;
    const cosw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    return new Biquad((1 - cosw) / 2, 1 - cosw, (1 - cosw) / 2, 1 + alpha, -2 * cosw, 1 - alpha);
  }

  /** Filter one sample. Stateful; strictly causal. */
  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }
}

/**
 * Streaming click-band envelope: bandpass, rectify, boxcar-smooth.
 *
 * `process` may be called with successive blocks of any size; state carries
 * across calls, so feeding a whole take at once and feeding it hop by hop
 * produce identical output. The envelope is emitted at the input sample rate;
 * callers wanting a coarser grid read every Nth value.
 */
export class ClickBandEnvelope {
  private readonly sections: Biquad[];
  private readonly smoothLength: number;
  private readonly window: Float32Array;
  private windowIndex = 0;
  private windowSum = 0;

  constructor(sampleRate: number, options: ClickBandOptions = {}) {
    const { loHz, hiHz, smoothMs } = { ...DEFAULTS, ...options };
    this.sections = [
      Biquad.highpass(sampleRate, loHz),
      Biquad.highpass(sampleRate, loHz),
      Biquad.lowpass(sampleRate, hiHz),
      Biquad.lowpass(sampleRate, hiHz),
    ];
    this.smoothLength = Math.max(1, Math.round((smoothMs / 1000) * sampleRate));
    this.window = new Float32Array(this.smoothLength);
  }

  /** Filter and envelope one block. Returns `out` (allocated when omitted). */
  process(block: Float32Array, out?: Float32Array): Float32Array {
    const result = out ?? new Float32Array(block.length);
    const n = Math.min(block.length, result.length);
    for (let i = 0; i < n; i++) {
      let v = block[i] as number;
      for (const section of this.sections) v = section.step(v);
      const rectified = Math.abs(v);
      this.windowSum += rectified - (this.window[this.windowIndex] as number);
      this.window[this.windowIndex] = rectified;
      this.windowIndex = (this.windowIndex + 1) % this.smoothLength;
      // The running sum drifts by float rounding over millions of samples;
      // clamp the drift at zero so the envelope can never read negative.
      result[i] = this.windowSum > 0 ? this.windowSum / this.smoothLength : 0;
    }
    return result;
  }

  reset(): void {
    for (const section of this.sections) section.reset();
    this.window.fill(0);
    this.windowIndex = 0;
    this.windowSum = 0;
  }
}

/** One-shot form for offline analysis: the envelope of a whole buffer. */
export function clickBandEnvelope(
  samples: Float32Array,
  sampleRate: number,
  options: ClickBandOptions = {}
): Float32Array {
  return new ClickBandEnvelope(sampleRate, options).process(samples);
}
