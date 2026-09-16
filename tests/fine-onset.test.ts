import { describe, expect, it } from "vitest";

import { FineOnsetDetector } from "../src/engine/kernels/fine-onset.js";

const SR = 48000;
const FFT = 1024;
const HOP = 128;

/** A decaying band-limited sawtooth: a stand-in for a plucked string. */
function pluckInto(
  out: Float32Array,
  startSample: number,
  hz: number,
  amplitude: number,
  tauMs: number,
  harmonics = 10
): void {
  const maxHarmonic = Math.min(harmonics, Math.floor(SR / 2 / hz));
  for (let i = startSample; i < out.length; i++) {
    const t = (i - startSample) / SR;
    let v = 0;
    for (let k = 1; k <= maxHarmonic; k++) v += Math.sin(2 * Math.PI * hz * k * t) / k;
    out[i] = (out[i] as number) + amplitude * v * (2 / Math.PI) * Math.exp(-t / (tauMs / 1000));
  }
}

/** A few milliseconds of broadband noise: a pick touching the string. */
function clickInto(out: Float32Array, startSample: number, amplitude: number, ms = 3): void {
  let seed = 12345;
  const n = Math.round((SR * ms) / 1000);
  for (let i = 0; i < n && startSample + i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const r = (seed / 0x7fffffff) * 2 - 1;
    out[startSample + i] = (out[startSample + i] as number) + amplitude * r;
  }
}

function detector(threshold = 1): FineOnsetDetector {
  return new FineOnsetDetector({
    sampleRate: SR,
    fftSize: FFT,
    hop: HOP,
    threshold,
    minIntervalMs: 40,
    preparationMs: 65,
    preparationRatio: 4,
  });
}

/** Run the detector over a signal and collect confirmed onsets in ms. */
function onsetsOf(signal: Float32Array, threshold = 1): number[] {
  const d = detector(threshold);
  const frame = new Float32Array(FFT);
  const out: number[] = [];
  for (let end = FFT; end <= signal.length; end += HOP) {
    frame.set(signal.subarray(end - FFT, end));
    for (const onset of d.process(frame, end, true)) out.push((onset.atSample / SR) * 1000);
  }
  return out;
}

describe("FineOnsetDetector", () => {
  it("expects its own window length", () => {
    const d = detector();
    expect(d.windowSize).toBe(FFT);
    expect(() => d.process(new Float32Array(FFT - 1), FFT, true)).toThrow(/expected 1024/);
  });

  it("reports nothing on silence and nothing on a steady decaying string", () => {
    const silence = new Float32Array(SR);
    expect(onsetsOf(silence)).toEqual([]);

    const steady = new Float32Array(SR * 2);
    pluckInto(steady, 2000, 82.4, 0.4, 1500);
    const found = onsetsOf(steady);
    // The pluck itself, and nothing over the 1.9s of decay that follows it.
    expect(found.length).toBe(1);
    expect(found[0]).toBeGreaterThan(30);
    expect(found[0]).toBeLessThan(80);
  });

  it("finds each stroke of an alternate-picked run, quiet upstrokes included", () => {
    const signal = new Float32Array(SR * 2);
    const strokes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const at = 0.3 + i * 0.107;
      strokes.push(at * 1000);
      // Loud downstroke, quiet upstroke, on the same pitch.
      pluckInto(signal, Math.round(at * SR), 659.3, i % 2 === 0 ? 0.4 : 0.06, 400);
    }
    const found = onsetsOf(signal, 0.5);
    expect(found.length).toBe(strokes.length);
    strokes.forEach((at, i) => {
      expect(Math.abs((found[i] as number) - at)).toBeLessThan(30);
    });
  });

  it("drops a weak click that a much stronger onset follows inside the preparation window", () => {
    const signal = new Float32Array(SR);
    pluckInto(signal, Math.round(0.2 * SR), 329.6, 0.4, 600);
    // The pick lands 45ms before the next stroke, then the stroke.
    clickInto(signal, Math.round(0.555 * SR), 0.02);
    pluckInto(signal, Math.round(0.6 * SR), 329.6, 0.4, 600);
    const found = onsetsOf(signal, 0.5);
    expect(found.length).toBe(2);
    expect(Math.abs((found[1] as number) - 600)).toBeLessThan(30);
  });

  it("keeps a weak stroke that nothing stronger follows", () => {
    const signal = new Float32Array(SR);
    pluckInto(signal, Math.round(0.2 * SR), 329.6, 0.4, 600);
    pluckInto(signal, Math.round(0.5 * SR), 329.6, 0.05, 600);
    const found = onsetsOf(signal, 0.5);
    expect(found.length).toBe(2);
    expect(Math.abs((found[1] as number) - 500)).toBeLessThan(30);
  });

  it("confirms an onset only after the preparation window has passed", () => {
    const d = detector(0.5);
    const signal = new Float32Array(SR);
    pluckInto(signal, Math.round(0.3 * SR), 440, 0.4, 600);
    const frame = new Float32Array(FFT);
    let confirmedAtEnd = -1;
    let onsetAt = -1;
    for (let end = FFT; end <= signal.length; end += HOP) {
      frame.set(signal.subarray(end - FFT, end));
      const out = d.process(frame, end, true);
      if (out.length > 0 && confirmedAtEnd < 0) {
        confirmedAtEnd = end;
        onsetAt = (out[0] as { atSample: number }).atSample;
      }
    }
    expect(onsetAt).toBeGreaterThan(0);
    // 65ms of preparation window, in samples.
    expect(confirmedAtEnd - onsetAt).toBeGreaterThanOrEqual(Math.round(0.065 * SR));
    expect(confirmedAtEnd - onsetAt).toBeLessThan(Math.round(0.065 * SR) + 2 * HOP);
  });

  it("never fires below the caller's gate", () => {
    const d = detector(0.5);
    const signal = new Float32Array(SR);
    pluckInto(signal, Math.round(0.3 * SR), 440, 0.4, 600);
    const frame = new Float32Array(FFT);
    let count = 0;
    for (let end = FFT; end <= signal.length; end += HOP) {
      frame.set(signal.subarray(end - FFT, end));
      count += d.process(frame, end, false).length;
    }
    expect(count).toBe(0);
  });
});
