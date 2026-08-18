/**
 * Engine-level tests: 128-sample blocks in, `PitchFrame`s out.
 *
 * These drive `PitchEngine` exactly the way both the AudioWorklet and the
 * offline analyzer do, so they are the closest synthetic proxy for live
 * behaviour. The fixtures remain the real benchmark.
 */

import { describe, expect, it } from "vitest";
import { PitchEngine, snapHop } from "../src/core/pitch-engine.js";
import { resolvePolicy } from "../src/core/policy.js";
import type { PitchFrame } from "../src/types.js";

const SAMPLE_RATE = 48000;
const RENDER_QUANTUM = 128;

/** Guitar-like: a sawtooth has the rich harmonic stack that trips up YIN. */
function sawtooth(frequencyHz: number, samples: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(samples);
  const period = SAMPLE_RATE / frequencyHz;
  for (let i = 0; i < samples; i++) {
    out[i] = amplitude * (2 * ((i % period) / period) - 1);
  }
  return out;
}

function silence(samples: number): Float32Array {
  return new Float32Array(samples);
}

/** Feeds a signal in render quanta, collecting every emitted frame. */
function runEngine(engine: PitchEngine, signal: Float32Array, startMs = 0): PitchFrame[] {
  const frames: PitchFrame[] = [];
  const blocks = Math.floor(signal.length / RENDER_QUANTUM);
  for (let b = 0; b < blocks; b++) {
    const block = signal.subarray(b * RENDER_QUANTUM, (b + 1) * RENDER_QUANTUM);
    const timestampMs = startMs + ((b * RENDER_QUANTUM) / SAMPLE_RATE) * 1000;
    const result = engine.push(block, timestampMs);
    if (result) frames.push(result.frame);
  }
  return frames;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

describe("snapHop", () => {
  it("snaps the requested hop to whole render quanta", () => {
    // 12ms at 48k is 576 samples, which is exactly 4.5 quanta -> 4 or 5.
    const hop = snapHop(12, SAMPLE_RATE);
    expect(hop % RENDER_QUANTUM).toBe(0);
    expect(hop).toBeGreaterThan(0);
    // Must stay close to the request: the whole point is beating a 50ms cadence.
    expect((hop / SAMPLE_RATE) * 1000).toBeLessThan(15);
  });

  it("never snaps below one render quantum", () => {
    expect(snapHop(0.01, SAMPLE_RATE)).toBe(RENDER_QUANTUM);
  });
});

describe("PitchEngine", () => {
  it("emits frames at the configured hop, with monotonic timestamps", () => {
    const policy = resolvePolicy({ mode: "lead" });
    const engine = new PitchEngine(SAMPLE_RATE, policy);

    const frames = runEngine(engine, sawtooth(220, SAMPLE_RATE));
    expect(frames.length).toBeGreaterThan(50);

    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.timestamp).toBeGreaterThan(frames[i - 1]!.timestamp);
    }

    const deltas = frames.slice(1).map((f, i) => f.timestamp - frames[i]!.timestamp);
    const hopMs = (engine.hopSamples / SAMPLE_RATE) * 1000;
    for (const delta of deltas) expect(delta).toBeCloseTo(hopMs, 5);

    // The stated goal was beating the old 50ms service.
    expect(hopMs).toBeLessThan(50);
  });

  it("detects a sustained low note and populates the detector fields", () => {
    const engine = new PitchEngine(SAMPLE_RATE, resolvePolicy({ mode: "lead" }));
    const frames = runEngine(engine, sawtooth(146.83, SAMPLE_RATE)); // D3

    const voiced = frames.filter((f) => f.frequencyHz !== null);
    expect(voiced.length).toBeGreaterThan(frames.length * 0.7);

    const detected = median(voiced.map((f) => f.frequencyHz!));
    const errorCents = 1200 * Math.log2(detected / 146.83);
    expect(Math.abs(errorCents)).toBeLessThan(15);

    const last = voiced.at(-1)!;
    expect(last.nearest).not.toBeNull();
    expect(last.nearest!.name).toBe("D3");
    expect(last.detector.tau).toBeGreaterThan(0);
    expect(last.detector.cmnd).not.toBeNull();
    expect(last.detector.zeroCrossingHz).toBeGreaterThan(0);
    expect(last.detector.effectiveSampleRate).toBe(SAMPLE_RATE);
    expect(last.amplitude.rms).toBeGreaterThan(0);
  });

  it("resolves a high note, where the short window carries the detection", () => {
    const engine = new PitchEngine(SAMPLE_RATE, resolvePolicy({ mode: "lead" }));
    const frames = runEngine(engine, sawtooth(554.37, SAMPLE_RATE)); // C#5

    const voiced = frames.filter((f) => f.frequencyHz !== null);
    expect(voiced.length).toBeGreaterThan(frames.length * 0.7);

    const detected = median(voiced.map((f) => f.frequencyHz!));
    expect(Math.abs(1200 * Math.log2(detected / 554.37))).toBeLessThan(15);
    expect(voiced.at(-1)!.nearest!.name).toBe("C#5");
  });

  it("gates silence to a null frequency but keeps emitting frames", () => {
    const engine = new PitchEngine(SAMPLE_RATE, resolvePolicy({ mode: "lead" }));
    const frames = runEngine(engine, silence(SAMPLE_RATE / 2));

    expect(frames.length).toBeGreaterThan(20);
    // The stream is continuous during silence — that is what a tuner UI needs.
    expect(frames.every((f) => f.frequencyHz === null)).toBe(true);
    expect(frames.every((f) => f.nearest === null)).toBe(true);
    expect(frames.every((f) => f.amplitude.rms < 0.001)).toBe(true);
  });

  it("does not report a confident pitch before the ring buffer has filled", () => {
    const engine = new PitchEngine(SAMPLE_RATE, resolvePolicy({ mode: "lead" }));
    // Only 3 hops' worth: far less than the 2048-sample long window.
    const frames = runEngine(engine, sawtooth(196, engine.hopSamples * 3));

    // Analysing a half-empty ring would read the zeros as a confident low pitch.
    for (const frame of frames.slice(0, 2)) {
      expect(frame.frequencyHz).toBeNull();
    }
  });

  it("tracks a pitch change across the hop boundary", () => {
    const engine = new PitchEngine(SAMPLE_RATE, resolvePolicy({ mode: "lead" }));
    const first = sawtooth(220, SAMPLE_RATE / 2);
    const second = sawtooth(329.63, SAMPLE_RATE / 2);
    const signal = new Float32Array(first.length + second.length);
    signal.set(first, 0);
    signal.set(second, first.length);

    const frames = runEngine(engine, signal);
    const halfMs = ((first.length / SAMPLE_RATE) * 1000);

    // Sample well clear of the transition so the long window is not straddling.
    const early = frames.filter((f) => f.timestamp < halfMs - 60 && f.frequencyHz !== null);
    const late = frames.filter((f) => f.timestamp > halfMs + 60 && f.frequencyHz !== null);

    expect(Math.abs(1200 * Math.log2(median(early.map((f) => f.frequencyHz!)) / 220))).toBeLessThan(20);
    expect(Math.abs(1200 * Math.log2(median(late.map((f) => f.frequencyHz!)) / 329.63))).toBeLessThan(20);
  });

  it("swaps policy without dropping the audio it has already accumulated", () => {
    const engine = new PitchEngine(SAMPLE_RATE, resolvePolicy({ mode: "lead" }));
    const signal = sawtooth(220, SAMPLE_RATE / 2);

    runEngine(engine, signal);
    // setMode() must never restart the graph, so this must not reset state.
    engine.setPolicy(resolvePolicy({ mode: "rhythm" }));

    const after = runEngine(engine, signal, 500);
    const voiced = after.filter((f) => f.frequencyHz !== null);
    // Detection continues immediately: no re-warmup, no gap.
    expect(voiced.length).toBeGreaterThan(after.length * 0.7);
    expect(after[0]!.frequencyHz).not.toBeNull();
  });
});
