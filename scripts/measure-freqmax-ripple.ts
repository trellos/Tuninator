/**
 * Can a FREQUENCY-axis maximum filter replace the onset kernel's TIME-axis one?
 *
 * The kernel's reference is the per-bin maximum over the last `referenceFrames`
 * hops, and its doc comment records why: at fftSize 1024 and 44.1kHz the
 * harmonics of a low E are 1.9 bins apart, unresolved, and their overlapping
 * main lobes beat — measured on a perfectly steady synthetic low E, the
 * successive-frame flux swings as widely as a real pick attack. The time
 * maximum removes the ripple, but any time memory makes the reference the
 * loudest recent frame, which raises the bar for a QUIETER re-attack — exactly
 * the case the corpus fails on.
 *
 * SuperFlux (Böck & Widmer, DAFx-13) runs the maximum across frequency bins of
 * the previous frame instead: a partial may wander in frequency without
 * generating flux, but it has only one frame of time memory. If that absorbs
 * the low-E beating, the time memory can drop toward one frame.
 *
 * THE FALSIFIER, STATED BEFORE THE RUN: if flux on a steady synthetic low E
 * still swings comparably to a real pick attack with the frequency max in
 * place and no time memory (referenceFrames = 1), the frequency max is not
 * substituting for the time max, and the change should be reverted rather than
 * stacked on top of it.
 *
 * "Comparably" is measured as the ratio of the steady signal's worst hop to
 * the attack's flux: the current kernel (three-frame time max) holds that
 * ratio low, and that is the bar the frequency max has to match at
 * referenceFrames 1.
 *
 * Usage:
 *   npx tsx scripts/measure-freqmax-ripple.ts
 */

import { OnsetDetector } from "../src/engine/kernels/onset.js";
import { DEFAULT_ENGINE_CONFIG, snapHop } from "../src/engine/config.js";

const SAMPLE_RATE = 44100;
const LOW_E_HZ = 82.41;

/** Sawtooth via summed harmonics, so the spectrum is exactly the 1/n comb. */
function sawtooth(hz: number, samples: number, amplitude: number): Float32Array {
  const out = new Float32Array(samples);
  const nyquist = SAMPLE_RATE / 2;
  const partials = Math.floor(nyquist / hz);
  for (let n = 1; n <= partials; n++) {
    const w = (2 * Math.PI * hz * n) / SAMPLE_RATE;
    const a = (amplitude * 2) / (Math.PI * n);
    for (let i = 0; i < samples; i++) out[i] = (out[i] as number) + a * Math.sin(w * i);
  }
  return out;
}

/**
 * The same tone with a re-pick at `attackAt` seconds: the phase resets, the
 * amplitude steps up by half, and a 3ms broadband burst rides the edge — the
 * impulse a pick is.
 */
function rePicked(hz: number, seconds: number, attackAt: number): Float32Array {
  const total = Math.round(seconds * SAMPLE_RATE);
  const edge = Math.round(attackAt * SAMPLE_RATE);
  const out = new Float32Array(total);
  out.set(sawtooth(hz, edge, 0.3), 0);
  out.set(sawtooth(hz, total - edge, 0.45), edge);
  // Deterministic pseudo-noise burst; no RNG so the run is reproducible.
  const burst = Math.round(0.003 * SAMPLE_RATE);
  let seed = 1;
  for (let i = 0; i < burst; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const white = seed / 0x40000000 - 1;
    out[edge + i] = (out[edge + i] as number) + 0.15 * white;
  }
  return out;
}

type Run = { name: string; referenceFrames: number; maxFilterSemitones?: number };

function measure(run: Run): { steadyP50: number; steadyMax: number; attack: number } {
  const config = DEFAULT_ENGINE_CONFIG;
  const fftSize = config.transient.fluxFftSize;
  const hop = snapHop(config.analysis.hopMs, SAMPLE_RATE);
  const attackAt = 1.5;
  const signal = rePicked(LOW_E_HZ, 2.5, attackAt);

  const detector = new OnsetDetector({
    sampleRate: SAMPLE_RATE,
    fftSize,
    minIntervalMs: config.transient.minIntervalMs,
    medianWindow: config.transient.fluxMedianWindow,
    sensitivity: config.transient.fluxSensitivity,
    referenceFrames: run.referenceFrames,
    maxFilterSemitones: run.maxFilterSemitones,
  });

  const frame = new Float32Array(fftSize);
  const steady: number[] = [];
  let attack = 0;
  for (let start = 0; start + fftSize <= signal.length; start += hop) {
    frame.set(signal.subarray(start, start + fftSize));
    const atMs = ((start + fftSize) / SAMPLE_RATE) * 1000;
    const result = detector.process(frame, atMs);
    const sinceAttackMs = atMs - attackAt * 1000;
    if (sinceAttackMs >= 0 && sinceAttackMs < 40) {
      if (result.flux > attack) attack = result.flux;
    } else if (atMs > 300 && sinceAttackMs < 0) {
      // Steady region: warmed up, before the re-pick.
      steady.push(result.flux);
    }
  }
  steady.sort((a, b) => a - b);
  return {
    steadyP50: steady[steady.length >> 1] as number,
    steadyMax: steady[steady.length - 1] as number,
    attack,
  };
}

const RUNS: Run[] = [
  { name: "current: time max, 3 frames", referenceFrames: 3 },
  { name: "no memory, no freq max (the documented ripple)", referenceFrames: 1 },
  { name: "freq max ±0.5 st, 1 frame", referenceFrames: 1, maxFilterSemitones: 0.5 },
  { name: "freq max ±1.0 st, 1 frame", referenceFrames: 1, maxFilterSemitones: 1.0 },
  { name: "freq max ±1.5 st, 1 frame", referenceFrames: 1, maxFilterSemitones: 1.5 },
  { name: "freq max ±2.0 st, 1 frame", referenceFrames: 1, maxFilterSemitones: 2.0 },
  { name: "freq max ±1.0 st, 2 frames", referenceFrames: 2, maxFilterSemitones: 1.0 },
  { name: "freq max ±1.0 st, 3 frames", referenceFrames: 3, maxFilterSemitones: 1.0 },
];

console.log("\n  steady low E (sawtooth 82.41Hz) with a re-pick at 1.5s\n");
const header = ["configuration", "steady p50", "steady max", "attack flux", "worst/attack"];
const rows = RUNS.map((run) => {
  const m = measure(run);
  return [
    run.name,
    m.steadyP50.toFixed(4),
    m.steadyMax.toFixed(4),
    m.attack.toFixed(4),
    (m.steadyMax / Math.max(m.attack, 1e-12)).toFixed(3),
  ];
});
const width: number[] = [];
for (const row of [header, ...rows]) row.forEach((c, i) => (width[i] = Math.max(width[i] ?? 0, c.length)));
const line = (row: string[]): string =>
  "  " + row.map((c, i) => (i === 0 ? c.padEnd(width[i] as number) : c.padStart(width[i] as number))).join("  ");
console.log(line(header));
console.log("  " + width.map((w) => "-".repeat(w)).join("  "));
for (const row of rows) console.log(line(row));
console.log("");
