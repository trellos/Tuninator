/**
 * A band-limited resampler, so the model can read exactly the samples the
 * engine reads.
 *
 * The engine runs at 48kHz on `.cache/fixtures/*.wav` and this repository has
 * no resampler; the model takes 22050Hz. Decoding the sources a second time at
 * 22050Hz would hand the model a different decode than the engine's, with its
 * own alignment to check. Instead the model reads the engine's own 48kHz WAV
 * through this: a Kaiser-windowed sinc, evaluated per output sample at its
 * exact input position, so it is zero-phase by construction (sample n of the
 * output sits at time n / outRate, no delay to compensate).
 *
 * Quality: 32 zero crossings of the output-rate sinc each side, cutoff at 0.95
 * of the output Nyquist (10.47kHz at 22050Hz), Kaiser beta 8.6 (about 80dB
 * stopband). The model's top CQT bin is 10.35kHz, so only the last few bins
 * of its range sit in the transition band. `parity.ts` validates it: the
 * reference output shipped with the model was computed on audio resampled by
 * the Python pipeline's own resampler, and the same comparison is run on this
 * one.
 */

const ZERO_CROSSINGS = 32;
const CUTOFF = 0.95;
const BETA = 8.6;

/** Modified Bessel function of the first kind, order 0 (series). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function resample(x: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return x.slice();
  const g = gcd(inRate, outRate);
  const up = outRate / g; // output samples per `down` input samples
  const down = inRate / g;
  const ratio = inRate / outRate; // input samples per output sample
  // Low-pass at CUTOFF of the lower Nyquist, expressed in cycles per INPUT sample.
  const fc = (0.5 * CUTOFF * Math.min(inRate, outRate)) / inRate;
  // Half-width in input samples: ZERO_CROSSINGS zero crossings of the cutoff sinc.
  const half = Math.ceil(ZERO_CROSSINGS / (2 * fc));
  const i0Beta = besselI0(BETA);
  const nOut = Math.floor((x.length * outRate) / inRate);
  const out = new Float32Array(nOut);
  // One tap table per fractional phase: output n sits at input n*down/up.
  const tables = new Map<number, Float64Array>();
  const table = (phase: number): Float64Array => {
    let t = tables.get(phase);
    if (t !== undefined) return t;
    const frac = phase / up; // position past the integer input sample, in input samples
    t = new Float64Array(2 * half + 1);
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      const tau = k - frac; // input sample (base + k) relative to the output position
      const s = tau === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * tau) / (Math.PI * tau);
      const r = tau / (half + 1);
      const w = Math.abs(r) >= 1 ? 0 : besselI0(BETA * Math.sqrt(1 - r * r)) / i0Beta;
      t[k + half] = s * w;
      sum += s * w;
    }
    // Unity gain at DC for every phase.
    for (let i = 0; i < t.length; i++) t[i] = (t[i] as number) / sum;
    tables.set(phase, t);
    return t;
  };
  for (let n = 0; n < nOut; n++) {
    const num = n * down;
    const base = Math.floor(num / up);
    const phase = num - base * up;
    const t = table(phase);
    let acc = 0;
    const lo = base - half;
    for (let k = 0; k < t.length; k++) {
      const i = lo + k;
      if (i < 0 || i >= x.length) continue;
      acc += (x[i] as number) * (t[k] as number);
    }
    out[n] = acc;
  }
  void ratio;
  return out;
}
