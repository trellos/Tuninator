/**
 * The budget check from the brief: at ~83 decisions/second worst case, what
 * does one forward pass of the shipped onset head cost? Measured on the
 * shipped plain-loop implementation with the shipped weights, not the
 * trainer's copy.
 *
 * Usage:  bun training/bench-inference.ts
 */

import { onsetHeadScore, ONSET_HEAD_SCALARS } from "../src/engine/kernels/onset-head.js";
import { ONSET_HEAD_PARAMS } from "../src/engine/kernels/onset-head-weights.js";
import { PATCH_SIZE } from "./features.js";
import { mulberry32 } from "./dsp.js";

const rng = mulberry32(31337);
const patch = new Float32Array(PATCH_SIZE);
for (let i = 0; i < patch.length; i++) patch[i] = rng();
const scalars = new Float32Array(ONSET_HEAD_SCALARS);
for (let i = 0; i < scalars.length; i++) scalars[i] = rng();

// Warm-up, then measure.
let sink = 0;
for (let i = 0; i < 2000; i++) sink += onsetHeadScore(ONSET_HEAD_PARAMS, patch, scalars);
const RUNS = 20000;
const t0 = performance.now();
for (let i = 0; i < RUNS; i++) {
  patch[i % PATCH_SIZE] = rng(); // keep the JIT honest
  sink += onsetHeadScore(ONSET_HEAD_PARAMS, patch, scalars);
}
const elapsed = performance.now() - t0;
console.log(`${RUNS} forward passes in ${elapsed.toFixed(1)}ms — ${((elapsed / RUNS) * 1000).toFixed(1)}µs per decision`);
console.log(`at 83 decisions/second: ${((elapsed / RUNS) * 83).toFixed(3)}ms of compute per second of audio`);
console.log(`(sink ${sink.toFixed(3)})`);
