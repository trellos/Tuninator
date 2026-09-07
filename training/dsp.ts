/**
 * Signal-path primitives for the augmentation chains: biquad filters (RBJ
 * cookbook), a waveshaper, a broadband compressor, a seeded PRNG, and
 * FFT-based overlap-add convolution for room impulse responses.
 *
 * Training-side only. Nothing under `src/` may import from this directory.
 */

/** Deterministic 32-bit PRNG; the seed IS the augmentation identity. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, for turning take names into stable seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type BiquadCoeffs = { b0: number; b1: number; b2: number; a1: number; a2: number };

function normalise(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiquadCoeffs {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function peakingEq(sampleRate: number, hz: number, q: number, gainDb: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * hz) / sampleRate;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  return normalise(1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A);
}

export function lowShelf(sampleRate: number, hz: number, gainDb: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * hz) / sampleRate;
  const c = Math.cos(w);
  const s = Math.sin(w);
  const alpha = (s / 2) * Math.SQRT2;
  const twoRootAAlpha = 2 * Math.sqrt(A) * alpha;
  return normalise(
    A * (A + 1 - (A - 1) * c + twoRootAAlpha),
    2 * A * (A - 1 - (A + 1) * c),
    A * (A + 1 - (A - 1) * c - twoRootAAlpha),
    A + 1 + (A - 1) * c + twoRootAAlpha,
    -2 * (A - 1 + (A + 1) * c),
    A + 1 + (A - 1) * c - twoRootAAlpha
  );
}

export function highShelf(sampleRate: number, hz: number, gainDb: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * hz) / sampleRate;
  const c = Math.cos(w);
  const s = Math.sin(w);
  const alpha = (s / 2) * Math.SQRT2;
  const twoRootAAlpha = 2 * Math.sqrt(A) * alpha;
  return normalise(
    A * (A + 1 + (A - 1) * c + twoRootAAlpha),
    -2 * A * (A - 1 + (A + 1) * c),
    A * (A + 1 + (A - 1) * c - twoRootAAlpha),
    A + 1 - (A - 1) * c + twoRootAAlpha,
    2 * (A - 1 - (A + 1) * c),
    A + 1 - (A - 1) * c - twoRootAAlpha
  );
}

export function lowpass(sampleRate: number, hz: number, q = Math.SQRT1_2): BiquadCoeffs {
  const w = (2 * Math.PI * hz) / sampleRate;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  return normalise((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha);
}

export function highpass(sampleRate: number, hz: number, q = Math.SQRT1_2): BiquadCoeffs {
  const w = (2 * Math.PI * hz) / sampleRate;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  return normalise((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
}

/** Direct form I, in place. */
export function biquad(x: Float32Array, c: BiquadCoeffs): void {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i] as number;
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
}

/** tanh waveshaper with drive (pre-gain) and make-up (post-gain), in place. */
export function drive(x: Float32Array, preGain: number, postGain: number): void {
  for (let i = 0; i < x.length; i++) {
    x[i] = Math.tanh((x[i] as number) * preGain) * postGain;
  }
}

/**
 * Broadband feed-forward compressor: peak envelope with attack/release, gain
 * reduction above threshold at `ratio`, in place. Deliberately plain — the
 * point is the qualitative behaviour an amp sim's compression has on sustain
 * (level held flat while the spectrum churns), not any specific product.
 */
export function compress(
  x: Float32Array,
  sampleRate: number,
  thresholdDb: number,
  ratio: number,
  attackMs: number,
  releaseMs: number,
  makeupDb: number
): void {
  const attack = Math.exp(-1 / ((attackMs / 1000) * sampleRate));
  const release = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  const threshold = Math.pow(10, thresholdDb / 20);
  const makeup = Math.pow(10, makeupDb / 20);
  let env = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i] as number);
    const coeff = a > env ? attack : release;
    env = coeff * env + (1 - coeff) * a;
    let gain = 1;
    if (env > threshold) gain = Math.pow(env / threshold, 1 / ratio - 1);
    x[i] = (x[i] as number) * gain * makeup;
  }
}

/* ---- FFT convolution ----------------------------------------------------- */

/** Iterative radix-2 complex FFT, in place over (re, im). */
export function fftComplex(re: Float64Array, im: Float64Array, invert: boolean): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error(`fft size must be a power of two, got ${n}`);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((invert ? 1 : -1) * 2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k] as number;
        const ui = im[i + k] as number;
        const vr = (re[i + k + len / 2] as number) * cr - (im[i + k + len / 2] as number) * ci;
        const vi = (re[i + k + len / 2] as number) * ci + (im[i + k + len / 2] as number) * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i++) {
      re[i] = (re[i] as number) / n;
      im[i] = (im[i] as number) / n;
    }
  }
}

/** Overlap-add convolution of a long signal with a short impulse response. */
export function convolve(x: Float32Array, ir: Float32Array): Float32Array {
  let fftSize = 4;
  while (fftSize < ir.length * 4) fftSize <<= 1;
  const block = fftSize - ir.length + 1;

  const hRe = new Float64Array(fftSize);
  const hIm = new Float64Array(fftSize);
  for (let i = 0; i < ir.length; i++) hRe[i] = ir[i] as number;
  fftComplex(hRe, hIm, false);

  const out = new Float32Array(x.length + ir.length - 1);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let start = 0; start < x.length; start += block) {
    const n = Math.min(block, x.length - start);
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < n; i++) re[i] = x[start + i] as number;
    fftComplex(re, im, false);
    for (let k = 0; k < fftSize; k++) {
      const ar = re[k] as number;
      const ai = im[k] as number;
      const br = hRe[k] as number;
      const bi = hIm[k] as number;
      re[k] = ar * br - ai * bi;
      im[k] = ar * bi + ai * br;
    }
    fftComplex(re, im, true);
    const limit = Math.min(fftSize, out.length - start);
    for (let i = 0; i < limit; i++) out[start + i] = (out[start + i] as number) + (re[i] as number);
  }
  return out;
}

/** Peak-normalise in place to `peak`, returning the gain applied. */
export function normalisePeak(x: Float32Array, peak = 0.9): number {
  let max = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i] as number);
    if (a > max) max = a;
  }
  if (max < 1e-9) return 1;
  const g = peak / max;
  for (let i = 0; i < x.length; i++) x[i] = (x[i] as number) * g;
  return g;
}
