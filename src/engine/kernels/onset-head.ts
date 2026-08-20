/**
 * Inference for the learned re-articulation witness (the "onset head"): the
 * forward pass of a 19,833-parameter convolutional scorer, as plain loops
 * over `Float32Array`. DECISION-016 is the licence: fixed weights, executed
 * by plain TypeScript, no runtime dependency, no training at runtime.
 *
 * Architecture (must stay in lock-step with `training/model.ts`, which owns
 * the trainer's copy; `tests/engine/onset-head.test.ts` pins this
 * implementation to the trainer's saved logits):
 *
 *   patch 9x60 -> conv 3x3 x8, relu -> maxpool(f,2) -> conv 3x3 x16, relu
 *   -> maxpool(f,3) -> flatten 720 -> dense 24, relu
 *   scalars 16 -> dense 16, relu
 *   concat 40 -> dense 24, relu -> dense 1 -> sigmoid
 *
 * The patch is `WhitenedBandExtractor`'s causal 9-hop x 60-band snapshot
 * ending at the decision hop; the scalars are the twelve witnesses
 * `RearticulationDetector.verdict` holds plus the four whitened flux
 * readings, through the fixed transforms below. Parameter layout is the
 * trainer's: conv1 W,b; conv2 W,b; patch dense W,b; scalar dense W,b;
 * merge dense W,b; output W,b — weights row-major by output.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import { BAND_COUNT, PATCH_HOPS } from "./whitened-bands.js";

const PATCH_T = PATCH_HOPS; // 9
const PATCH_F = BAND_COUNT; // 60
const C1 = 8;
const C2 = 16;
const T1 = PATCH_T - 2; // 7
const F1 = PATCH_F - 2; // 58
const F1P = F1 / 2; // 29
const T2 = T1 - 2; // 5
const F2 = F1P - 2; // 27
const F2P = 9; // 27 / 3
const FLAT = T2 * F2P * C2; // 720
const PDENSE = 24;
export const ONSET_HEAD_SCALARS = 16;
const SDENSE = 16;
const MERGE = 24;

// Parameter offsets, in declaration order.
const O_CONV1W = 0;
const O_CONV1B = O_CONV1W + C1 * 9;
const O_CONV2W = O_CONV1B + C1;
const O_CONV2B = O_CONV2W + C2 * C1 * 9;
const O_DENSEPW = O_CONV2B + C2;
const O_DENSEPB = O_DENSEPW + PDENSE * FLAT;
const O_DENSESW = O_DENSEPB + PDENSE;
const O_DENSESB = O_DENSESW + SDENSE * ONSET_HEAD_SCALARS;
const O_MERGE1W = O_DENSESB + SDENSE;
const O_MERGE1B = O_MERGE1W + MERGE * (PDENSE + SDENSE);
const O_MERGE2W = O_MERGE1B + MERGE;
const O_MERGE2B = O_MERGE2W + MERGE;
export const ONSET_HEAD_PARAMS_EXPECTED = O_MERGE2B + 1;

/**
 * The fixed input transforms, part of the trained model's contract: the
 * ratio-like witnesses carry heavy right tails and enter through log1p;
 * booleans and the bounded readings enter as they are. Order:
 * sharpness, heldSharpness, fluxRatio, heldFluxRatio, riseRatio,
 * envelopeOverBaseline, decayExcess (null as 0), soundedMs, pitchDiffers,
 * gliding, kernelOnset, bloomed, wFlux, wFluxNorm, wHeldFlux, wHeldNorm.
 */
export function onsetHeadTransform(raw: Float32Array, out: Float32Array): void {
  for (let i = 0; i < 7; i++) out[i] = Math.log1p(Math.max(0, raw[i] as number));
  out[7] = Math.log1p(Math.max(0, raw[7] as number)) / 8;
  out[8] = raw[8] as number;
  out[9] = raw[9] as number;
  out[10] = raw[10] as number;
  out[11] = raw[11] as number;
  out[12] = Math.log1p(Math.max(0, raw[12] as number));
  out[13] = raw[13] as number;
  out[14] = Math.log1p(Math.max(0, raw[14] as number));
  out[15] = raw[15] as number;
}

/** Preallocated scratch so a decision allocates nothing. */
const a1 = new Float32Array(C1 * T1 * F1);
const p1 = new Float32Array(C1 * T1 * F1P);
const a2 = new Float32Array(C2 * T2 * F2);
const p2 = new Float32Array(FLAT);
const hP = new Float32Array(PDENSE);
const hS = new Float32Array(SDENSE);
const hM = new Float32Array(MERGE);

/**
 * The pre-sigmoid logit for one decision. `patch` is the whitened band
 * snapshot (9 x 60, oldest hop first); `scalars` the sixteen TRANSFORMED
 * side inputs (see `onsetHeadTransform`).
 */
export function onsetHeadLogit(params: Float32Array, patch: Float32Array, scalars: Float32Array): number {
  for (let c = 0; c < C1; c++) {
    const wBase = O_CONV1W + c * 9;
    const b = params[O_CONV1B + c] as number;
    for (let t = 0; t < T1; t++) {
      for (let f = 0; f < F1; f++) {
        let v = b;
        for (let dt = 0; dt < 3; dt++) {
          const rowBase = (t + dt) * PATCH_F + f;
          const wRow = wBase + dt * 3;
          v +=
            (params[wRow] as number) * (patch[rowBase] as number) +
            (params[wRow + 1] as number) * (patch[rowBase + 1] as number) +
            (params[wRow + 2] as number) * (patch[rowBase + 2] as number);
        }
        a1[(c * T1 + t) * F1 + f] = v > 0 ? v : 0;
      }
    }
  }
  for (let c = 0; c < C1; c++) {
    for (let t = 0; t < T1; t++) {
      const base = (c * T1 + t) * F1;
      const outBase = (c * T1 + t) * F1P;
      for (let f = 0; f < F1P; f++) {
        const v0 = a1[base + f * 2] as number;
        const v1 = a1[base + f * 2 + 1] as number;
        p1[outBase + f] = v0 >= v1 ? v0 : v1;
      }
    }
  }
  for (let c = 0; c < C2; c++) {
    const b = params[O_CONV2B + c] as number;
    for (let t = 0; t < T2; t++) {
      for (let f = 0; f < F2; f++) {
        let v = b;
        for (let ci = 0; ci < C1; ci++) {
          const wBase = O_CONV2W + (c * C1 + ci) * 9;
          for (let dt = 0; dt < 3; dt++) {
            const inBase = (ci * T1 + t + dt) * F1P + f;
            const wRow = wBase + dt * 3;
            v +=
              (params[wRow] as number) * (p1[inBase] as number) +
              (params[wRow + 1] as number) * (p1[inBase + 1] as number) +
              (params[wRow + 2] as number) * (p1[inBase + 2] as number);
          }
        }
        a2[(c * T2 + t) * F2 + f] = v > 0 ? v : 0;
      }
    }
  }
  for (let c = 0; c < C2; c++) {
    for (let t = 0; t < T2; t++) {
      const base = (c * T2 + t) * F2;
      const outBase = (c * T2 + t) * F2P;
      for (let f = 0; f < F2P; f++) {
        let best = a2[base + f * 3] as number;
        const v1 = a2[base + f * 3 + 1] as number;
        const v2 = a2[base + f * 3 + 2] as number;
        if (v1 > best) best = v1;
        if (v2 > best) best = v2;
        p2[outBase + f] = best;
      }
    }
  }
  for (let o = 0; o < PDENSE; o++) {
    let v = params[O_DENSEPB + o] as number;
    const wBase = O_DENSEPW + o * FLAT;
    for (let i = 0; i < FLAT; i++) v += (params[wBase + i] as number) * (p2[i] as number);
    hP[o] = v > 0 ? v : 0;
  }
  for (let o = 0; o < SDENSE; o++) {
    let v = params[O_DENSESB + o] as number;
    const wBase = O_DENSESW + o * ONSET_HEAD_SCALARS;
    for (let i = 0; i < ONSET_HEAD_SCALARS; i++) v += (params[wBase + i] as number) * (scalars[i] as number);
    hS[o] = v > 0 ? v : 0;
  }
  for (let o = 0; o < MERGE; o++) {
    let v = params[O_MERGE1B + o] as number;
    const wBase = O_MERGE1W + o * (PDENSE + SDENSE);
    for (let i = 0; i < PDENSE; i++) v += (params[wBase + i] as number) * (hP[i] as number);
    for (let i = 0; i < SDENSE; i++) v += (params[wBase + PDENSE + i] as number) * (hS[i] as number);
    hM[o] = v > 0 ? v : 0;
  }
  let z = params[O_MERGE2B] as number;
  for (let i = 0; i < MERGE; i++) z += (params[O_MERGE2W + i] as number) * (hM[i] as number);
  return z;
}

/** The logit through the sigmoid: the learned witness's probability. */
export function onsetHeadScore(params: Float32Array, patch: Float32Array, scalars: Float32Array): number {
  const z = onsetHeadLogit(params, patch, scalars);
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}
