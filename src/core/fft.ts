/**
 * Radix-2 real FFT. No dependencies.
 *
 * CONTRACT FILE — the signatures below are fixed; other core modules import
 * them. Implementation owned by the DSP-core workstream.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports, no allocation in
 * the hot path (all scratch buffers preallocated in the constructor).
 */

/** Precomputed Hann window of `size` samples (periodic, not symmetric). */
export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return w;
}

export class RealFFT {
  /** Transform length in samples. Must be a power of two. */
  readonly size: number;
  /** Number of usable output bins: `size / 2 + 1`. */
  readonly bins: number;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`RealFFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.bins = size / 2 + 1;
    throw new Error("RealFFT: not implemented");
  }

  /**
   * Forward transform of a real signal.
   * `input` length must be `size`; `outRe`/`outIm` length must be `bins`.
   * Does not window the input — apply `hannWindow` beforehand if needed.
   */
  forward(_input: Float32Array, _outRe: Float32Array, _outIm: Float32Array): void {
    throw new Error("RealFFT.forward: not implemented");
  }

  /**
   * Magnitude spectrum. `input` length must be `size`; `outMag` length `bins`.
   * Convenience wrapper over `forward` that avoids exposing scratch buffers.
   */
  magnitudes(_input: Float32Array, _outMag: Float32Array): void {
    throw new Error("RealFFT.magnitudes: not implemented");
  }
}
