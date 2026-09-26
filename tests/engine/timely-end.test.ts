/**
 * `noteEnded` goes out when the sound ends (DECISION-086).
 *
 * The real engine over seeded synthetic plucks, fed in the worklet's 128-sample
 * quanta: the same signals `scripts/measure-end-latency.ts` measures.
 */

import { describe, expect, it } from "vitest";
import { RENDER_QUANTUM, resolveEngineConfig } from "../../src/engine/config.js";
import { RecognitionEngine } from "../../src/engine/engine.js";
import type { TrackerEmission } from "../../src/engine/tracker/note-tracker.js";

const SR = 48000;

type Pluck = { midi: number; at: number; damp: number };
type Residual = { at: number; hz: number; level: number };

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Plucked strings over a 1e-4 RMS noise floor; a damp falls 60dB in 40ms. */
function render(seconds: number, plucks: readonly Pluck[], residuals: readonly Residual[] = []): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const rand = lcg(7);
  for (let i = 0; i < out.length; i++) out[i] = (rand() * 2 - 1) * 1e-4 * Math.sqrt(3);
  for (const pluck of plucks) {
    const f0 = 440 * 2 ** ((pluck.midi - 69) / 12);
    const start = Math.round(pluck.at * SR);
    const damp = Math.round(pluck.damp * SR);
    for (let i = start; i < out.length; i++) {
      const t = (i - start) / SR;
      let s = 0;
      for (let k = 1; k <= 8; k++) s += (Math.sin(2 * Math.PI * f0 * k * t) / k) * Math.exp(-t * (0.7 + 0.5 * k));
      if (t < 0.004) s += (rand() * 2 - 1) * 0.8 * (1 - t / 0.004);
      let env = Math.min(1, t / 0.002);
      if (i >= damp) {
        const since = (i - damp) / SR;
        env *= Math.exp(-since * (Math.log(1000) / 0.04));
        if (since > 0.25) break;
      }
      out[i] = (out[i] ?? 0) + 0.06 * env * s;
    }
  }
  for (const r of residuals) {
    for (let i = Math.round(r.at * SR); i < out.length; i++) {
      const t = i / SR - r.at;
      out[i] = (out[i] ?? 0) + r.level * Math.sin(2 * Math.PI * r.hz * t) * Math.min(1, t / 0.01);
    }
  }
  return out;
}

type Call = { at: number; emissions: TrackerEmission[]; decided: string[] };

/** Every `processChunk` call, with what it emitted and which Notes the fast lane ended in it. */
function run(samples: Float32Array, rmsGate?: number): { calls: Call[]; flushed: TrackerEmission[] } {
  const engine = new RecognitionEngine(SR, resolveEngineConfig(rmsGate === undefined ? {} : { rmsGate }));
  let decided: string[] = [];
  engine.setTrackerTrace((event) => {
    if (event.kind === "ended") decided.push(event.noteId);
  });
  const calls: Call[] = [];
  const block = new Float32Array(RENDER_QUANTUM);
  for (let offset = 0; offset < samples.length; offset += RENDER_QUANTUM) {
    block.fill(0);
    block.set(samples.subarray(offset, Math.min(samples.length, offset + RENDER_QUANTUM)));
    decided = [];
    const emissions = engine.processChunk(block, offset).emissions;
    calls.push({ at: ((offset + RENDER_QUANTUM) / SR) * 1000, emissions, decided });
  }
  return { calls, flushed: engine.flush().emissions };
}

describe("a Note ended by silence", () => {
  const { calls, flushed } = run(render(4, [{ midi: 57, at: 1.0, damp: 1.5 }]));
  const all = [...calls.flatMap((c) => c.emissions), ...flushed];
  const id = all.find((e) => e.type === "started")?.note.id as string;

  it("is told so in the very call in which the fast lane ends it", () => {
    const call = calls.find((c) => c.decided.includes(id));
    expect(call).toBeDefined();
    expect(call?.emissions.some((e) => e.type === "ended" && e.note.id === id)).toBe(true);
  });

  it("within the release grace of the damp, not a region later", () => {
    const call = calls.find((c) => c.emissions.some((e) => e.type === "ended" && e.note.id === id));
    const ended = call?.emissions.find((e) => e.type === "ended");
    expect(ended?.note.endTime).toBeGreaterThan(1500);
    expect(ended?.note.endTime).toBeLessThan(1600);
    expect((call?.at ?? Infinity) - (ended?.note.endTime ?? 0)).toBeLessThan(150);
  });

  it("is resolved later, once, and after its one ended", () => {
    const types = all.filter((e) => e.note.id === id).map((e) => e.type);
    expect(types.filter((t) => t === "ended")).toHaveLength(1);
    expect(types.filter((t) => t === "resolved")).toHaveLength(1);
    expect(types.indexOf("resolved")).toBeGreaterThan(types.indexOf("ended"));
    expect(types[types.length - 1]).toBe("resolved");
    const endedIn = calls.findIndex((c) => c.emissions.some((e) => e.type === "ended"));
    const resolvedIn = calls.findIndex((c) => c.emissions.some((e) => e.type === "resolved"));
    expect(resolvedIn).toBeGreaterThan(endedIn);
    const resolved = all.find((e) => e.type === "resolved");
    expect(resolved?.note.lifecycle).toBe("resolved");
  });
});

describe("stop()", () => {
  it("ends and then resolves every Note still open", () => {
    // Stopped while the note is still ringing.
    const { calls, flushed } = run(render(1.4, [{ midi: 57, at: 1.0, damp: 9 }]));
    const live = calls.flatMap((c) => c.emissions);
    const open = live.filter((e) => e.type === "started").map((e) => e.note.id);
    expect(open.length).toBeGreaterThan(0);
    expect(live.some((e) => e.type === "ended")).toBe(false);
    for (const id of open) {
      const types = flushed.filter((e) => e.note.id === id).map((e) => e.type);
      expect(types.filter((t) => t === "ended")).toHaveLength(1);
      expect(types.filter((t) => t === "resolved")).toHaveLength(1);
      expect(types.indexOf("ended")).toBeLessThan(types.indexOf("resolved"));
    }
  });
});

describe("a damp that leaves something above a calibrated gate", () => {
  // The gate a consumer measured on a quiet direct input: 8x a 1e-4 floor.
  const GATE = 0.0008;
  const damped = [{ midi: 57, at: 1.0, damp: 1.5 }];

  function notes(residuals: Residual[], dampEndsAboveGate = true): { started: TrackerEmission[]; ended: TrackerEmission[]; at: number[] } {
    const samples = render(6, damped, residuals);
    const config = resolveEngineConfig({ rmsGate: GATE });
    config.tracking.dampEndsAboveGate = dampEndsAboveGate;
    const engine = new RecognitionEngine(SR, config);
    const started: TrackerEmission[] = [];
    const ended: TrackerEmission[] = [];
    const at: number[] = [];
    const block = new Float32Array(RENDER_QUANTUM);
    for (let offset = 0; offset < samples.length; offset += RENDER_QUANTUM) {
      block.fill(0);
      block.set(samples.subarray(offset, Math.min(samples.length, offset + RENDER_QUANTUM)));
      for (const e of engine.processChunk(block, offset).emissions) {
        if (e.type === "started") started.push(e);
        if (e.type === "ended") {
          ended.push(e);
          at.push(((offset + RENDER_QUANTUM) / SR) * 1000);
        }
      }
    }
    return { started, ended, at };
  }

  it("an open string ringing on: the Note ends at the damp, and the string opens nothing", () => {
    const { started, ended, at } = notes([{ at: 1.5, hz: 82.41, level: 0.0012 }]);
    expect(started).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.note.endTime).toBeGreaterThan(1500);
    expect(ended[0]?.note.endTime).toBeLessThan(1600);
    expect(at[0]).toBeLessThan(1500 + 250);
  });

  it("hum that is never a pitch: the Note ends at the damp while the take is running", () => {
    const { started, ended, at } = notes([
      { at: 1.5, hz: 50, level: 0.0015 },
      { at: 1.5, hz: 150, level: 0.0005 },
    ]);
    expect(started).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.note.endTime).toBeGreaterThan(1500);
    expect(ended[0]?.note.endTime).toBeLessThan(1600);
    expect(at[0]).toBeLessThan(1500 + 250);
  });

  it("with the rule off, the hum holds the Note open well past the damp", () => {
    const { ended } = notes([{ at: 1.5, hz: 50, level: 0.0015 }, { at: 1.5, hz: 150, level: 0.0005 }], false);
    expect(ended.every((e) => (e.note.endTime ?? 0) > 2000)).toBe(true);
  });
});
