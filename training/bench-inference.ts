/**
 * The budget check from the brief: at ~83 decisions/second worst case, what
 * does one forward pass of the onset head cost? Measured on the trainer's
 * forward pass (`training/model.ts`), which is the same plain-loop
 * arithmetic a shipped implementation would run; the recorded figure from
 * the full experiment was 190µs per decision — under 2% of one core at the
 * worst-case decision rate.
 *
 * Usage:  bun training/bench-inference.ts
 */

import { Activations, forward, initParams, SCALARS } from "./model.js";
import { PATCH_SIZE } from "./features.js";
import { mulberry32 } from "./dsp.js";

const rng = mulberry32(31337);
const params = initParams(rng);
const patch = new Float32Array(PATCH_SIZE);
for (let i = 0; i < patch.length; i++) patch[i] = rng();
const scalars = new Float32Array(SCALARS);
for (let i = 0; i < scalars.length; i++) scalars[i] = rng();
const act = new Activations();

// Warm-up, then measure.
let sink = 0;
for (let i = 0; i < 2000; i++) sink += forward(params, patch, scalars, act);
const RUNS = 20000;
const t0 = performance.now();
for (let i = 0; i < RUNS; i++) {
  patch[i % PATCH_SIZE] = rng(); // keep the JIT honest
  sink += forward(params, patch, scalars, act);
}
const elapsed = performance.now() - t0;
console.log(`${RUNS} forward passes in ${elapsed.toFixed(1)}ms — ${((elapsed / RUNS) * 1000).toFixed(1)}µs per decision`);
console.log(`at 83 decisions/second: ${((elapsed / RUNS) * 83).toFixed(3)}ms of compute per second of audio`);
console.log(`(sink ${sink.toFixed(3)})`);
