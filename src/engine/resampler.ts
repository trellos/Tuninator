/**
 * Streaming band-limited resampler: whatever rate the host captures at, in;
 * the engine's one analysis rate, out.
 *
 * Every window, FFT length, hop, bin width and per-hop rate in the engine was
 * tuned on the fixture corpus at 48kHz, and dozens of them are counted in
 * samples, bins or hops rather than in milliseconds (`config.ts`'s
 * `ANALYSIS_SAMPLE_RATE` says which). Fed 44.1kHz directly, the same constants
 * described different durations and resolutions, and the corpus lost 43 more
 * labels; at 96kHz, 85 more. Converting each constant to milliseconds cannot
 * fix that exactly — the 640-sample hop is 588 samples at 44.1kHz, which is
 * not a whole number of 128-sample render quanta, and every rounding of every
 * converted count is a small de-tune of its own — so the engine converts the
 * audio instead, and everything downstream of this file only ever sees 48kHz.
 *
 * Output sample n is the input interpolated at exactly n / outputRate
 * seconds, so the timeline is the source's: a Note's `startTime` in ms is
 * where it is in the audio whatever rate it was captured at. Producing it
 * needs `halfWidth` input samples past that point, which is the resampler's
 * whole latency (16 samples, 0.36ms, at 44.1kHz upward; 32 at 96kHz).
 *
 * Kaiser-windowed sinc, cutoff just under the lower of the two Nyquists so a
 * downsample does not alias, coefficients per phase normalised to unit DC
 * gain so a steady level does not ripple at the ratio's period. Positions are
 * stepped in exact integer arithmetic over the reduced ratio, so there is no
 * accumulated drift however long the stream runs. Output is a pure function
 * of the input samples — how they were chunked never changes a value.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

/** Zero crossings of the sinc each side, at the output's bandwidth. */
const ZERO_CROSSINGS = 16;
/** Kaiser window shape: ~80dB stopband. */
const KAISER_BETA = 8;
/** Cutoff as a fraction of the lower Nyquist. Guitar content ends far below. */
const CUTOFF = 0.95;
/**
 * Coefficient rows kept. A ratio that reduces to more phases than this
 * (44101 -> 48000 reduces to 48000) still steps its positions exactly, and
 * reads the nearest of these rows: a position error under 1/8192 of an input
 * sample that never accumulates.
 */
const MAX_ROWS = 4096;

export class Resampler {
  readonly inputRate: number;
  readonly outputRate: number;
  /** Input samples needed each side of an output position. */
  readonly halfWidth: number;

  /** Reduced ratio: each output sample advances `step / phases` input samples. */
  private readonly phases: number;
  private readonly step: number;
  /** `rows` rows of `2 * halfWidth` taps, row r for fractional offset r / rows. */
  private readonly rows: number;
  private readonly bank: Float32Array;

  /** Input history; `buffer[0]` is absolute input index `bufferStart`. */
  private buffer: Float32Array;
  private bufferStart = 0;
  private bufferLength = 0;
  /** Input samples received. */
  private received = 0;

  /** Next output's position: integer input index plus `frac / phases`. */
  private whole = 0;
  private frac = 0;

  constructor(inputRate: number, outputRate: number) {
    for (const [name, rate] of [
      ["inputRate", inputRate],
      ["outputRate", outputRate],
    ] as const) {
      if (!Number.isInteger(rate) || rate <= 0) {
        throw new RangeError(`Resampler: ${name} must be a positive integer, got ${rate}`);
      }
    }
    this.inputRate = inputRate;
    this.outputRate = outputRate;

    const g = gcd(inputRate, outputRate);
    this.phases = outputRate / g;
    this.step = inputRate / g;
    this.rows = Math.min(this.phases, MAX_ROWS);

    // Downsampling widens the kernel in input samples to keep the zero
    // crossings at the output's bandwidth.
    const bandwidth = Math.min(1, outputRate / inputRate) * CUTOFF;
    this.halfWidth = Math.ceil(ZERO_CROSSINGS / bandwidth);
    this.bank = buildBank(this.rows, this.halfWidth, bandwidth);

    this.buffer = new Float32Array(4 * this.halfWidth + 1024);
    this.reset();
  }

  reset(): void {
    // The stream is preceded by silence: the first outputs read zeros before
    // input sample 0, exactly as an engine fed at the analysis rate sees
    // nothing before its first sample.
    this.buffer.fill(0);
    this.bufferStart = -this.halfWidth;
    this.bufferLength = this.halfWidth;
    this.received = 0;
    this.whole = 0;
    this.frac = 0;
  }

  /** Feed input; returns every output sample it completes, possibly none. */
  push(input: Float32Array): Float32Array {
    this.append(input);
    this.received += input.length;

    const h = this.halfWidth;
    const taps = 2 * h;
    // Output n needs input up to whole + h; the newest we hold is received - 1.
    // A rounded row may step one sample on, so hold one more back then.
    const last = this.received - 1 - h - (this.rows === this.phases ? 0 : 1);
    if (this.whole > last) return EMPTY;
    let count = 0;
    {
      // How many outputs fit, without stepping the state.
      let whole = this.whole;
      let frac = this.frac;
      while (whole <= last) {
        count++;
        frac += this.step;
        whole += Math.floor(frac / this.phases);
        frac %= this.phases;
      }
    }

    const out = new Float32Array(count);
    const buffer = this.buffer;
    const bank = this.bank;
    const exactRows = this.rows === this.phases;
    for (let n = 0; n < count; n++) {
      let whole = this.whole;
      let row = this.frac;
      if (!exactRows) {
        row = Math.round((this.frac * this.rows) / this.phases);
        if (row === this.rows) {
          row = 0;
          whole++;
        }
      }
      // Taps cover input whole - h + 1 .. whole + h.
      const base = whole - h + 1 - this.bufferStart;
      const offset = row * taps;
      let acc = 0;
      for (let k = 0; k < taps; k++) {
        acc += (buffer[base + k] as number) * (bank[offset + k] as number);
      }
      out[n] = acc;
      this.frac += this.step;
      this.whole += Math.floor(this.frac / this.phases);
      this.frac %= this.phases;
    }
    // Keep one spare sample: a rounded row can read one past `whole`.
    this.discardBefore(this.whole - h);
    return out;
  }

  private append(input: Float32Array): void {
    const needed = this.bufferLength + input.length;
    if (needed > this.buffer.length) {
      const grown = new Float32Array(Math.max(needed, this.buffer.length * 2));
      grown.set(this.buffer.subarray(0, this.bufferLength));
      this.buffer = grown;
    }
    this.buffer.set(input, this.bufferLength);
    this.bufferLength = needed;
  }

  private discardBefore(index: number): void {
    const drop = index - this.bufferStart;
    if (drop <= 0) return;
    this.buffer.copyWithin(0, drop, this.bufferLength);
    this.bufferLength -= drop;
    this.bufferStart = index;
  }
}

const EMPTY = new Float32Array(0);

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * Coefficients for every fractional offset. Row p, tap k weighs input
 * `whole - halfWidth + 1 + k` for an output at `whole + p / rows`.
 */
function buildBank(rows: number, halfWidth: number, bandwidth: number): Float32Array {
  const taps = 2 * halfWidth;
  const bank = new Float32Array(rows * taps);
  const norm = besselI0(KAISER_BETA);
  for (let p = 0; p < rows; p++) {
    const offset = p / rows;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      // Distance from the output position to this input sample.
      const d = k - halfWidth + 1 - offset;
      const r = d / halfWidth;
      const window = Math.abs(r) >= 1 ? 0 : besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / norm;
      const x = bandwidth * d;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const c = bandwidth * sinc * window;
      bank[p * taps + k] = c;
      sum += c;
    }
    for (let k = 0; k < taps; k++) bank[p * taps + k] = (bank[p * taps + k] as number) / sum;
  }
  return bank;
}

/** Zeroth-order modified Bessel function of the first kind, by its series. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}
