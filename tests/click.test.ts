import { describe, expect, it } from "vitest";

import { ClickBandEnvelope, clickBandEnvelope } from "../src/engine/kernels/click.js";

const SR = 48000;

function sine(hz: number, durationMs: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round((durationMs / 1000) * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

/** A band-limited sawtooth — the strong low partials of a ringing string. */
function saw(hz: number, durationMs: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round((durationMs / 1000) * SR));
  const maxHarmonic = Math.floor(SR / 2 / hz);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 1; k <= Math.min(12, maxHarmonic); k++) v += Math.sin(2 * Math.PI * hz * k * t) / k;
    out[i] = amp * v * (2 / Math.PI);
  }
  return out;
}

/** Deterministic pseudo-noise: broadband, like a pick's click. */
function noiseBurst(signal: Float32Array, startMs: number, durationMs: number, amp: number): void {
  const start = Math.round((startMs / 1000) * SR);
  const end = Math.min(signal.length, start + Math.round((durationMs / 1000) * SR));
  let seed = 0x2545f491;
  for (let i = start; i < end; i++) {
    // xorshift32 — no Math.random, so the test is bit-reproducible.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    signal[i] = (signal[i] as number) + amp * ((seed / 0xffffffff) * 2 - 1);
  }
}

const ms = (samples: number): number => (samples / SR) * 1000;
const at = (timeMs: number): number => Math.round((timeMs / 1000) * SR);

function steadyLevel(envelope: Float32Array): number {
  // Median of the second half, past all transient settling.
  const tail = [...envelope.slice(Math.floor(envelope.length / 2))].sort((a, b) => a - b);
  return tail[Math.floor(tail.length / 2)] as number;
}

describe("ClickBandEnvelope", () => {
  it("passes the click band and rejects a string's strong low partials", () => {
    const inBand = steadyLevel(clickBandEnvelope(sine(5000, 400), SR));
    const string = steadyLevel(clickBandEnvelope(saw(200, 400), SR));
    const hiss = steadyLevel(clickBandEnvelope(sine(16000, 400), SR));
    expect(inBand).toBeGreaterThan(string * 30);
    expect(inBand).toBeGreaterThan(hiss * 5);
  });

  it("resolves a 3ms click as a compact spike at the right time", () => {
    const signal = new Float32Array(at(500));
    noiseBurst(signal, 200, 3, 0.5);
    const envelope = clickBandEnvelope(signal, SR);

    let peak = 0;
    let peakIndex = 0;
    for (let i = 0; i < envelope.length; i++) {
      if ((envelope[i] as number) > peak) {
        peak = envelope[i] as number;
        peakIndex = i;
      }
    }
    // The peak lands on the burst (within the burst plus the 1ms smoothing).
    expect(ms(peakIndex)).toBeGreaterThan(199);
    expect(ms(peakIndex)).toBeLessThan(206);

    // Compactness: the envelope stays above half peak only briefly. The filter
    // rings a little past the burst, but a 3ms click must not smear past ~10ms.
    let above = 0;
    for (const v of envelope) if (v >= peak / 2) above++;
    expect(ms(above)).toBeLessThan(10);

    // Causal: nothing before the burst.
    expect(envelope[at(198)] as number).toBeLessThan(peak / 100);
  });

  it("reads sustained in-band energy as spread, not compact", () => {
    // A steady in-band tone is the churn case: high envelope for its whole
    // duration. Duration-above-half-peak is what separates it from a click.
    const envelope = clickBandEnvelope(sine(4000, 400), SR);
    let peak = 0;
    for (const v of envelope) peak = Math.max(peak, v);
    let above = 0;
    for (const v of envelope) if (v >= peak / 2) above++;
    expect(ms(above)).toBeGreaterThan(300);
  });

  it("produces identical output streamed block-by-block and in one shot", () => {
    const signal = new Float32Array(at(300));
    noiseBurst(signal, 40, 3, 0.4);
    for (let i = 0; i < signal.length; i++) {
      signal[i] = (signal[i] as number) + 0.2 * Math.sin((2 * Math.PI * 3000 * i) / SR);
    }

    const oneShot = clickBandEnvelope(signal, SR);
    const streamed = new Float32Array(signal.length);
    const streaming = new ClickBandEnvelope(SR);
    // 128-sample render quanta, exactly as the worklet delivers audio.
    for (let start = 0; start < signal.length; start += 128) {
      const block = signal.subarray(start, Math.min(signal.length, start + 128));
      streaming.process(block, streamed.subarray(start, start + block.length));
    }
    for (let i = 0; i < signal.length; i += 997) {
      expect(streamed[i]).toBeCloseTo(oneShot[i] as number, 10);
    }
  });

  it("reset restores the initial state exactly", () => {
    const signal = new Float32Array(at(100));
    noiseBurst(signal, 10, 3, 0.4);
    const streaming = new ClickBandEnvelope(SR);
    const first = streaming.process(signal.slice());
    streaming.reset();
    const second = streaming.process(signal.slice());
    for (let i = 0; i < signal.length; i += 501) {
      expect(second[i]).toBe(first[i]);
    }
  });
});
