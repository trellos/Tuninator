/**
 * The fast lane, driven with synthesised audio through the real engine.
 *
 * Ported from the old `pitch-frame.test.ts`, which tested `PitchEngine`
 * directly. The unit under test is now the whole fast path — ring, hop
 * scheduling, dual-window YIN, transient detection — because that is what the
 * tracker consumes and the seams between them are exactly where a hop-boundary
 * or window-alignment bug hides.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG, RENDER_QUANTUM, snapHop } from "../../src/engine/config.js";
import { RecognitionEngine } from "../../src/engine/engine.js";
import type { PitchFrame } from "../../src/types.js";

const SAMPLE_RATE = 48000;

function diagnosticConfig(overrides: Partial<typeof DEFAULT_ENGINE_CONFIG> = {}) {
  return {
    ...DEFAULT_ENGINE_CONFIG,
    ...overrides,
    diagnostics: { pitchFrames: true, contour: false },
  };
}

/** A sawtooth: harmonically rich, like a plucked string and unlike a sine. */
function sawtooth(hz: number, samples: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(samples);
  const period = SAMPLE_RATE / hz;
  for (let i = 0; i < samples; i++) out[i] = amplitude * (2 * ((i % period) / period) - 1);
  return out;
}

function silence(samples: number): Float32Array {
  return new Float32Array(samples);
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function framesOf(signal: Float32Array, config = diagnosticConfig()): PitchFrame[] {
  const engine = new RecognitionEngine(SAMPLE_RATE, config);
  const frames: PitchFrame[] = [];
  for (let offset = 0; offset < signal.length; offset += RENDER_QUANTUM) {
    const block = new Float32Array(RENDER_QUANTUM);
    block.set(signal.subarray(offset, Math.min(offset + RENDER_QUANTUM, signal.length)));
    frames.push(...engine.processChunk(block, offset).frames);
  }
  return frames;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}

function cents(detected: number, reference: number): number {
  return 1200 * Math.log2(detected / reference);
}

describe("fast lane hop scheduling", () => {
  it("produces one frame per hop, timestamped from the sample index alone", () => {
    const frames = framesOf(sawtooth(220, SAMPLE_RATE));
    // 12ms is 576 samples, which is 4.5 render quanta; the hop snaps up to 5.
    const hopSamples = snapHop(DEFAULT_ENGINE_CONFIG.analysis.hopMs, SAMPLE_RATE);
    expect(hopSamples).toBe(640);
    const expected = Math.floor(SAMPLE_RATE / hopSamples);
    expect(frames.length).toBeGreaterThanOrEqual(expected - 1);
    expect(frames.length).toBeLessThanOrEqual(expected + 1);

    for (let i = 1; i < frames.length; i++) {
      const delta = (frames[i] as PitchFrame).timestamp - (frames[i - 1] as PitchFrame).timestamp;
      expect(delta).toBeCloseTo((hopSamples / SAMPLE_RATE) * 1000, 6);
    }
  });

  it("timestamps are exact multiples of the hop, with no accumulated drift", () => {
    const frames = framesOf(sawtooth(220, SAMPLE_RATE * 2));
    const hopMs = (snapHop(DEFAULT_ENGINE_CONFIG.analysis.hopMs, SAMPLE_RATE) / SAMPLE_RATE) * 1000;
    for (const frame of frames) {
      expect(frame.timestamp / hopMs).toBeCloseTo(Math.round(frame.timestamp / hopMs), 9);
    }
  });
});

describe("fast lane pitch", () => {
  it("tracks a low string through the long window", () => {
    const frames = framesOf(sawtooth(82.41, SAMPLE_RATE));
    const voiced = frames.filter((f) => f.frequencyHz !== null);
    expect(voiced.length).toBeGreaterThan(10);
    expect(Math.abs(cents(median(voiced.map((f) => f.frequencyHz as number)), 82.41))).toBeLessThan(25);
  });

  it("tracks a high note, where the short window is what makes it possible", () => {
    const frames = framesOf(sawtooth(659.26, SAMPLE_RATE));
    const voiced = frames.filter((f) => f.frequencyHz !== null);
    expect(voiced.length).toBeGreaterThan(10);
    expect(Math.abs(cents(median(voiced.map((f) => f.frequencyHz as number)), 659.26))).toBeLessThan(25);
  });

  it("reports silence as silence rather than as a confident low pitch", () => {
    const frames = framesOf(silence(SAMPLE_RATE));
    expect(frames.every((f) => f.frequencyHz === null)).toBe(true);
    expect(frames.every((f) => f.amplitude.rms < DEFAULT_ENGINE_CONFIG.analysis.rmsGate)).toBe(true);
  });

  it("does not emit a confident pitch before the ring holds a full window", () => {
    // The first hops would otherwise analyse a window that is mostly zeros,
    // which reads as a very low, very periodic note.
    const frames = framesOf(concat(silence(2048), sawtooth(220, SAMPLE_RATE)));
    const early = frames.slice(0, 3);
    expect(early.every((f) => f.frequencyHz === null)).toBe(true);
  });

  it("resolves a note change well inside the note's own duration", () => {
    // 125ms notes: 120bpm sixteenths. A detector whose window latency exceeds
    // the note length reports the average of two notes and neither of them.
    const noteSamples = Math.round(0.125 * SAMPLE_RATE);
    const signal = concat(
      sawtooth(440, noteSamples),
      sawtooth(587.33, noteSamples),
      sawtooth(440, noteSamples)
    );
    const frames = framesOf(signal);
    const secondNote = frames.filter((f) => {
      const t = f.timestamp;
      return t >= 175 && t <= 245 && f.frequencyHz !== null;
    });
    expect(secondNote.length).toBeGreaterThan(0);
    const hz = median(secondNote.map((f) => f.frequencyHz as number));
    expect(Math.abs(cents(hz, 587.33))).toBeLessThan(60);
  });
});

describe("fast lane transients", () => {
  it("finds the attack when a note starts out of silence", () => {
    const config = diagnosticConfig();
    const engine = new RecognitionEngine(SAMPLE_RATE, config);
    const signal = concat(silence(SAMPLE_RATE / 2), sawtooth(220, SAMPLE_RATE / 2));
    const attacks: number[] = [];
    for (let offset = 0; offset < signal.length; offset += RENDER_QUANTUM) {
      const block = new Float32Array(RENDER_QUANTUM);
      block.set(signal.subarray(offset, Math.min(offset + RENDER_QUANTUM, signal.length)));
      for (const frame of engine.processChunk(block, offset).fast) {
        if (frame.attack !== null) attacks.push(frame.attack.at);
      }
    }
    expect(attacks.length).toBeGreaterThan(0);
    // Within a hop and a half of the real edge at 500ms.
    expect(Math.abs((attacks[0] as number) - 500)).toBeLessThan(30);
  });

  it("does not keep firing through a steady tone", () => {
    const config = diagnosticConfig();
    const engine = new RecognitionEngine(SAMPLE_RATE, config);
    const signal = sawtooth(220, SAMPLE_RATE * 2);
    let attacks = 0;
    for (let offset = 0; offset < signal.length; offset += RENDER_QUANTUM) {
      const block = new Float32Array(RENDER_QUANTUM);
      block.set(signal.subarray(offset, Math.min(offset + RENDER_QUANTUM, signal.length)));
      for (const frame of engine.processChunk(block, offset).fast) {
        if (frame.attack !== null) attacks++;
      }
    }
    // One at the start of the tone is correct; a stream of them is the ripple
    // failure the peak-hold reference exists to prevent.
    expect(attacks).toBeLessThanOrEqual(2);
  });
});
