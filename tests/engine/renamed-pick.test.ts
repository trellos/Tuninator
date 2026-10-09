/**
 * A pick the pitch estimator renamed keeps the pick's start (DECISION-089).
 *
 * On fast same-register plucks the onset opens a Note on time, but YIN's
 * window still reads the previous pitch; the step to the new pitch confirms
 * four hops later, the attack Note is dropped for never reaching
 * `tracking.minStableMs`, and the Note the step opens used to start 53-67ms
 * after the pluck. The stub now lends its start to that Note. Before the
 * change this score had 12 of 110 Notes starting more than 40ms late.
 *
 * `scripts/measure-triplet-onset-lag.ts` runs the same score at six tempos.
 */

import { describe, expect, it } from "vitest";
import { analyzeSamples } from "../../src/offline/analyzer.js";
import { projectEmissions } from "../../src/offline/eval-adapter.js";
import { describeFrequency, midiToFrequency } from "../../src/engine/kernels/notes.js";

const SR = 48000;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Pluck = { midi: number; at: number; duration: number };

/** Eighth-note triplets in G2-G3, as in `sample-rate.test.ts`. */
function score(count: number, bpm: number): Pluck[] {
  const rand = lcg(bpm);
  const scale = [43, 45, 47, 48, 50, 52, 54, 55];
  const ioi = 60 / bpm / 3;
  return Array.from({ length: count }, (_, i) => ({
    midi: scale[Math.floor(rand() * scale.length)] as number,
    at: 0.5 + i * ioi,
    duration: ioi * 0.9,
  }));
}

function render(plucks: readonly Pluck[]): Float32Array {
  const last = plucks[plucks.length - 1] as Pluck;
  const out = new Float32Array(Math.ceil((last.at + last.duration + 0.6) * SR));
  for (const p of plucks) {
    const f0 = midiToFrequency(p.midi);
    const from = Math.ceil(p.at * SR);
    const to = Math.min(out.length, Math.ceil((p.at + p.duration + 0.05) * SR));
    for (let i = from; i < to; i++) {
      const t = i / SR - p.at;
      const release = t > p.duration ? Math.max(0, 1 - (t - p.duration) / 0.05) : 1;
      const env = Math.min(1, t / 0.003) * Math.exp(-t * 6) * release;
      let s = 0;
      for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h;
      out[i] = (out[i] ?? 0) + 0.3 * env * s;
    }
  }
  return out;
}

describe("a pick the pitch estimator renamed", () => {
  const plucks = score(110, 120);
  const notes = projectEmissions(analyzeSamples(render(plucks), SR).emissions).final.sort(
    (a, b) => a.startedAt - b.startedAt
  );
  // A Note belongs to the pluck whose slot it starts in: from 40ms before the
  // pluck to 40ms before the next, well inside the 167ms interval.
  const slots = plucks.map((p, i) => {
    const next = plucks[i + 1];
    const from = p.at * 1000 - 40;
    const to = next === undefined ? Infinity : next.at * 1000 - 40;
    return notes.filter((n) => n.startedAt >= from && n.startedAt < to);
  });

  it("starts the Note at the pluck, not at the step", () => {
    const late = slots.filter((mine, i) => {
      const first = mine[0];
      return first !== undefined && first.startedAt - (plucks[i] as Pluck).at * 1000 > 40;
    });
    expect(late.length).toBeLessThanOrEqual(1);
  });

  it("adds no Note and names every pluck it heard", () => {
    expect(slots.reduce((n, mine) => n + Math.max(0, mine.length - 1), 0)).toBe(0);
    slots.forEach((mine, i) => {
      const first = mine[0];
      if (first === undefined) return;
      expect(first.label.name).toBe(describeFrequency(midiToFrequency((plucks[i] as Pluck).midi)).name);
    });
  });
});
