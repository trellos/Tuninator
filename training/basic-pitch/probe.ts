/**
 * Does the model answer promptly? Phase 1's timing question, measured on
 * SYNTHETIC plucks, so nothing is read on the corpus before Phase 2's bars are
 * fixed.
 *
 * `phase1.ts` shows the targets are one frame (11.6ms) wide but the answer at a
 * frame reads audio after it: the CNN reaches 116ms ahead at the onset output,
 * the CQT's centred filters 313ms ahead at E2's fundamental, and the log
 * normalisation spans the whole 1988ms window. What that means in practice is
 * an empirical question about the trained weights, so this measures it on
 * signals whose onsets are known exactly:
 *
 *   a pluck: a harmonic series (partials to 10kHz, amplitude 1/h^1.2, each
 *   decaying faster the higher it is), a 3ms raised-cosine attack, a 4ms noise
 *   burst for the pick, over a -60dBFS white-noise floor so no window holds
 *   digital silence. Deterministic (seeded noise).
 *
 *   1. One pluck at 1.000s, at E2 A2 D3 G3 B3 E4 E5. The whole-take reading
 *      (the package's own windowing) gives the onset activation's peak time
 *      against the true onset, its width, and when the note activation first
 *      crosses the package's thresholds (0.3 frame, 0.5 onset). Then the
 *      CAUSAL reading (`causal.ts`: audio after the decision point is zero) at
 *      decision points 0..174ms after the pluck: the largest onset activation
 *      any causal frame shows for this pluck, as a fraction of the whole-take
 *      peak. That curve IS the look-ahead cost on a clean onset.
 *   2. Two plucks of one pitch 107ms apart (a 140bpm sixteenth) and 214ms apart
 *      (an eighth), the first left ringing or damped over 10ms before the
 *      second: does the onset activation show the second pick as its own peak,
 *      whole-take and causally 23, 46 and 93ms after it?
 *
 * Synthetic plucks are not a guitar through an amp or a room. This is a
 * property of the model, a floor under what the corpus can show, not a
 * reading of the corpus.
 *
 * Usage: npx tsx training/basic-pitch/probe.ts --dir training/out/basic-pitch
 */

import { join } from "node:path";
import { readCausal, cell, DECISION_FRAME } from "./causal.js";
import { SAMPLE_RATE, posteriorgram } from "./framing.js";
import { loadModel } from "./runtime.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const dir = arg("dir");
if (!dir) {
  console.error("usage: npx tsx training/basic-pitch/probe.ts --dir <dir>");
  process.exit(2);
}

const SR = SAMPLE_RATE;
let seed = 12345;
const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32 - 0.5;
};

function pluck(out: Float32Array, midi: number, startS: number, endS: number | null, gain = 0.4): void {
  const f0 = 440 * 2 ** ((midi - 69) / 12);
  const n0 = Math.round(startS * SR);
  const nEnd = endS === null ? out.length : Math.min(out.length, Math.round(endS * SR));
  const tau1 = 1.5 * (82.4 / f0) ** 0.3; // seconds, lower notes ring longer
  for (let h = 1; h * f0 < 10000; h++) {
    const amp = gain / h ** 1.2;
    const tau = tau1 / (1 + 0.6 * (h - 1));
    const w = (2 * Math.PI * h * f0) / SR;
    for (let n = n0; n < nEnd; n++) {
      const t = (n - n0) / SR;
      const attack = t < 0.003 ? 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.003) : 1;
      const damp = endS !== null && n > nEnd - 0.01 * SR ? (nEnd - n) / (0.01 * SR) : 1;
      out[n] = (out[n] as number) + amp * attack * damp * Math.exp(-t / tau) * Math.sin(w * (n - n0));
    }
  }
  for (let n = n0; n < Math.min(nEnd, n0 + 0.004 * SR); n++) out[n] = (out[n] as number) + 0.15 * gain * rand();
}

function floor(len: number): Float32Array {
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) x[i] = 0.002 * rand(); // ~ -60 dBFS RMS
  return x;
}

const model = await loadModel(join(dir, "src/basic_pitch/saved_models/icassp_2022/nmp.onnx"));
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const nameOf = (m: number): string => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

/* ---- 1. One pluck ------------------------------------------------------------ */

const T0 = 1.0;
const DELTAS = [0, 12, 23, 35, 46, 70, 93, 116, 174];
console.log("1. One pluck at 1.000s. Whole-take reading (the package's windowing):");
console.log("   note  onset peak   at (ms vs pluck)  half-peak span   note>=0.3 from   note>=0.5 from");
const causalRows: string[] = [];
for (const midi of [40, 45, 50, 55, 59, 64, 76]) {
  const x = floor(Math.round(3 * SR));
  pluck(x, midi, T0, null);
  const pg = await posteriorgram(model, x);
  const bin = midi - 21;
  let peak = 0;
  let peakF = 0;
  for (let f = 0; f < pg.frames; f++) {
    const t = (pg.timesMs[f] as number) - 1000 * T0;
    if (t < -200 || t > 300) continue;
    const v = pg.onset[f * 88 + bin] as number;
    if (v > peak) {
      peak = v;
      peakF = f;
    }
  }
  let lo = peakF;
  while (lo > 0 && (pg.onset[(lo - 1) * 88 + bin] as number) >= peak / 2) lo--;
  let hi = peakF;
  while (hi + 1 < pg.frames && (pg.onset[(hi + 1) * 88 + bin] as number) >= peak / 2) hi++;
  const firstNote = (thr: number): string => {
    for (let f = 0; f < pg.frames; f++) {
      const t = (pg.timesMs[f] as number) - 1000 * T0;
      if (t < -300) continue;
      if ((pg.note[f * 88 + bin] as number) >= thr) return `${t >= 0 ? "+" : ""}${t.toFixed(0)}ms`;
    }
    return "never";
  };
  const rel = (f: number): number => (pg.timesMs[f] as number) - 1000 * T0;
  console.log(
    `   ${nameOf(midi).padEnd(4)}  ${peak.toFixed(2).padStart(10)}   ${`${rel(peakF) >= 0 ? "+" : ""}${rel(peakF).toFixed(0)}`.padStart(16)}  ` +
      `${`${rel(lo).toFixed(0)}..${rel(hi).toFixed(0)}`.padStart(14)}   ${firstNote(0.3).padStart(14)}   ${firstNote(0.5).padStart(14)}`,
  );
  // Causal: the largest onset any causal frame shows for this pluck.
  const readings = await readCausal(model, x, DELTAS.map((d) => 1000 * T0 + d));
  const cells = readings.map((r) => {
    let best = 0;
    for (let k = 0; k <= DECISION_FRAME; k++) {
      const t = r.frameMs(k) - 1000 * T0;
      if (t < -60) continue;
      best = Math.max(best, cell(r.onset, k, bin));
    }
    return best;
  });
  causalRows.push(
    `   ${nameOf(midi).padEnd(4)}  ${cells.map((c) => `${c.toFixed(2)} (${((100 * c) / Math.max(peak, 1e-9)).toFixed(0)}%)`.padStart(12)).join("")}`,
  );
}
console.log("\n   CAUSAL: the largest onset activation any frame at or before the decision point shows for the pluck,");
console.log("   and as a share of the whole-take peak, by decision point (ms after the pluck):");
console.log(`   note  ${DELTAS.map((d) => `+${d}ms`.padStart(12)).join("")}`);
for (const r of causalRows) console.log(r);

/* ---- 2. Two plucks, one pitch ------------------------------------------------ */

console.log("\n2. Two plucks of one pitch: is the second its own onset?");
console.log("   whole-take: onset peak at each pick, the lowest onset between them; causal: the largest onset any");
console.log("   frame shows for the SECOND pick, 23 / 46 / 93ms after it (audio after that point is zero)");
console.log("   note  gap    first     peak 1  between  peak 2     causal +23   +46   +93");
for (const midi of [45, 57, 76]) {
  for (const gapMs of [107, 214]) {
    for (const damped of [false, true]) {
      const x = floor(Math.round(3 * SR));
      const t2 = T0 + gapMs / 1000;
      pluck(x, midi, T0, damped ? t2 - 0.001 : null);
      pluck(x, midi, t2, null);
      const pg = await posteriorgram(model, x);
      const bin = midi - 21;
      const maxIn = (a: number, b: number): number => {
        let m = 0;
        for (let f = 0; f < pg.frames; f++) {
          const t = pg.timesMs[f] as number;
          if (t >= a && t <= b) m = Math.max(m, pg.onset[f * 88 + bin] as number);
        }
        return m;
      };
      const minIn = (a: number, b: number): number => {
        let m = 1;
        for (let f = 0; f < pg.frames; f++) {
          const t = pg.timesMs[f] as number;
          if (t >= a && t <= b) m = Math.min(m, pg.onset[f * 88 + bin] as number);
        }
        return m;
      };
      const p1 = maxIn(1000 * T0 - 30, 1000 * T0 + 30);
      const p2 = maxIn(1000 * t2 - 30, 1000 * t2 + 30);
      const between = minIn(1000 * T0 + 30, 1000 * t2 - 30);
      const readings = await readCausal(model, x, [23, 46, 93].map((d) => 1000 * t2 + d));
      const causal = readings.map((r) => {
        let best = 0;
        for (let k = 0; k <= DECISION_FRAME; k++) {
          const t = r.frameMs(k) - 1000 * t2;
          if (t < -30) continue;
          best = Math.max(best, cell(r.onset, k, bin));
        }
        return best;
      });
      console.log(
        `   ${nameOf(midi).padEnd(4)}  ${`${gapMs}ms`.padEnd(6)} ${(damped ? "damped" : "ringing").padEnd(8)}  ` +
          `${p1.toFixed(2).padStart(6)}  ${between.toFixed(2).padStart(7)}  ${p2.toFixed(2).padStart(6)}     ` +
          `${causal.map((c) => c.toFixed(2).padStart(6)).join("")}`,
      );
    }
  }
}
