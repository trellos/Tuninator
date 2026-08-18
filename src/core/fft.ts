/**
 * Radix-2 FFT. No dependencies.
 *
 * Shared by the onset detector (1024-point) and the chroma analyser
 * (4096-point), so it is implemented up front rather than left as a contract:
 * it is the one module two workstreams both build on.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports. All scratch is
 * preallocated in the constructor; `magnitudes` never allocates.
 */

/** Periodic (not symmetric) Hann window of `size` samples. */
export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return w;
}

export class RealFFT {
  /** Transform length in samples. Always a power of two. */
  readonly size: number;
  /** Number of usable output bins: `size / 2 + 1`. */
  readonly bins: number;

  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly reverse: Uint32Array;

  constructor(size: number) {
    if (size < 4 || (size & (size - 1)) !== 0) {
      throw new Error(`RealFFT size must be a power of two >= 4, got ${size}`);
    }
    this.size = size;
    this.bins = size / 2 + 1;

    this.re = new Float32Array(size);
    this.im = new Float32Array(size);

    const half = size >> 1;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      this.cosTable[k] = Math.cos((2 * Math.PI * k) / size);
      this.sinTable[k] = Math.sin((2 * Math.PI * k) / size);
    }

    // Bit-reversal permutation table.
    let levels = 0;
    for (let t = size; t > 1; t >>= 1) levels++;
    this.reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < levels; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.reverse[i] = r;
    }
  }

  /**
   * Magnitude spectrum. `input.length` must be `size`; `outMag.length` `bins`.
   *
   * The only transform on offer. A `forward()` returning re/im existed and was
   * never called by anything -- it was a second verbatim copy of the butterfly
   * below. Add it back the day something needs phase.
   */
  magnitudes(input: Float32Array, outMag: Float32Array): void {
    if (input.length !== this.size) {
      throw new Error(`RealFFT.magnitudes: expected ${this.size} samples, got ${input.length}`);
    }

    const { re, im, size } = this;
    im.fill(0);

    const rev = this.reverse;
    for (let i = 0; i < size; i++) {
      re[rev[i]!] = input[i]!;
    }

    const cos = this.cosTable;
    const sin = this.sinTable;

    for (let len = 2; len <= size; len <<= 1) {
      const halfLen = len >> 1;
      const step = size / len;
      for (let i = 0; i < size; i += len) {
        for (let j = 0, k = 0; j < halfLen; j++, k += step) {
          const wr = cos[k]!;
          const wi = -sin[k]!;
          const a = i + j;
          const b = a + halfLen;

          const br = re[b]!;
          const bi = im[b]!;
          const tr = br * wr - bi * wi;
          const ti = br * wi + bi * wr;

          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }

    const bins = this.bins;
    for (let i = 0; i < bins; i++) {
      const r = re[i]!;
      const m = im[i]!;
      outMag[i] = Math.sqrt(r * r + m * m);
    }
  }
}
