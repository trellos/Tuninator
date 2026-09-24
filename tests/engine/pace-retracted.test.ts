/**
 * The local-rate estimate reads the gaps between Note openings. An opening
 * that never became a Note — a stub absorbed into its successor, a fragment
 * dropped before it was announced — cuts a real gap in two, and eight such
 * pieces put the median on a cliff. With `tracking.paceIgnoresRetracted`
 * the opening is struck out once its fate is decided. See DECISION-048.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG, RENDER_QUANTUM, type EngineConfig } from "../../src/engine/config.js";
import { RecognitionEngine } from "../../src/engine/engine.js";
import type { TrackerTraceEvent } from "../../src/engine/tracker/note-tracker.js";

const SAMPLE_RATE = 48000;
const ms = (value: number): number => Math.round((value / 1000) * SAMPLE_RATE);

/** Add a decaying sawtooth pluck into `signal` at `atMs`. */
function addPluck(
  signal: Float32Array,
  atMs: number,
  hz: number,
  lengthMs: number,
  amplitude: number,
  tauMs: number
): void {
  const period = SAMPLE_RATE / hz;
  const start = ms(atMs);
  const tau = (tauMs / 1000) * SAMPLE_RATE;
  for (let i = 0; i < ms(lengthMs) && start + i < signal.length; i++) {
    signal[start + i] =
      (signal[start + i] as number) + amplitude * (2 * ((i % period) / period) - 1) * Math.exp(-i / tau);
  }
}

/**
 * Ten A3 eighths at 250ms, and between the second and the ninth a short,
 * sharp blip halfway through the interval: a transient the tracker opens a
 * Note on, some of which die before they are announced. Each of those cuts
 * a 250ms gap into 125 + 125.
 */
function eighthsWithBlips(): Float32Array {
  const signal = new Float32Array(ms(300 + 10 * 250 + 400));
  for (let k = 0; k < 10; k++) addPluck(signal, 300 + k * 250, 220, 600, 0.35, 400);
  for (let k = 1; k < 9; k++) addPluck(signal, 300 + k * 250 + 125, 220, 45, 0.5, 40);
  return signal;
}

const withGate = (on: boolean): EngineConfig => ({
  ...DEFAULT_ENGINE_CONFIG,
  tracking: { ...DEFAULT_ENGINE_CONFIG.tracking, paceIgnoresRetracted: on },
});

/** The tracker's pace reading at the last accepted same-pitch re-articulation. */
function lastPace(signal: Float32Array, config: EngineConfig): { pace: number | null; dropped: number } {
  const engine = new RecognitionEngine(SAMPLE_RATE, config);
  const events: TrackerTraceEvent[] = [];
  engine.setTrackerTrace((event) => events.push(event));
  for (let offset = 0; offset < signal.length; offset += RENDER_QUANTUM) {
    const block = new Float32Array(RENDER_QUANTUM);
    block.set(signal.subarray(offset, Math.min(offset + RENDER_QUANTUM, signal.length)));
    engine.processChunk(block, offset);
  }
  engine.flush();
  const accepted = events.filter(
    (event): event is Extract<TrackerTraceEvent, { kind: "rearticulation" }> =>
      event.kind === "rearticulation" && event.accepted && !event.pitchDiffers
  );
  const dropped = events.filter((event) => event.kind === "ended" && !event.announced).length;
  const last = accepted[accepted.length - 1];
  return { pace: last?.localIoiMs ?? null, dropped };
}

describe("the pace estimate and openings that never became Notes", () => {
  const signal = eighthsWithBlips();

  it("with every opening counted, the dropped blips halve the reading", () => {
    const { pace, dropped } = lastPace(signal, withGate(false));
    expect(dropped).toBeGreaterThan(0);
    expect(pace).not.toBeNull();
    expect(pace as number).toBeLessThan(170);
  });

  it("with retracted openings struck out, the reading is the eighth again", () => {
    const { pace, dropped } = lastPace(signal, withGate(true));
    expect(dropped).toBeGreaterThan(0);
    expect(pace).not.toBeNull();
    expect(pace as number).toBeGreaterThan(220);
  });

  it("the shipped default strikes them out", () => {
    expect(DEFAULT_ENGINE_CONFIG.tracking.paceIgnoresRetracted).toBe(true);
  });
});
