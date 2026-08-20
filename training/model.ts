/**
 * The onset head: a small convolutional scorer for the same-pitch
 * re-articulation decision.
 *
 *   patch 9x60 (whitened log-band spectrogram, causal, ends at the decision
 *   hop) -> conv 3x3 x8 -> relu -> maxpool(f,2) -> conv 3x3 x16 -> relu ->
 *   maxpool(f,3) -> flatten 720 -> dense 24 -> relu
 *   scalars 16 (12 witnesses + 4 whitened flux readings, fixed transforms)
 *   -> dense 16 -> relu
 *   concat 40 -> dense 24 -> relu -> dense 1 -> sigmoid
 *
 * 19,833 parameters — inside the ≤~25,000 bound DECISION-016 admits, and
 * small enough that the whole bet stays on the DATA rather than capacity.
 * Time structure is kept through to the flatten (no pooling over hops):
 * the patch is aligned so its last hop IS the decision hop, and "flux burst
 * now" versus "flux burst 60ms ago" is the distinction the decision needs.
 *
 * This file owns the architecture constants, the parameter layout, and the
 * forward pass used by the trainer. The SHIPPED forward pass in `src/engine/`
 * is an independent plain-loop implementation checked against this one by
 * saved reference activations — see `tests/engine/onset-head.test.ts`.
 */

import {
  BAND_COUNT,
  PATCH_HOPS,
} from "../src/engine/kernels/whitened-bands.js";

export const PATCH_T = PATCH_HOPS; // 9
export const PATCH_F = BAND_COUNT; // 60
export const C1 = 8;
export const C2 = 16;
export const T1 = PATCH_T - 2; // 7
export const F1 = PATCH_F - 2; // 58
export const F1P = F1 / 2; // 29
export const T2 = T1 - 2; // 5
export const F2 = F1P - 2; // 27
export const F2P = 9; // 27 / 3
export const FLAT = T2 * F2P * C2; // 720
export const PDENSE = 24;
export const SCALARS = 16;
export const SDENSE = 16;
export const MERGE = 24;

export type Layout = {
  conv1W: number; // C1 x 1 x 3 x 3
  conv1B: number;
  conv2W: number; // C2 x C1 x 3 x 3
  conv2B: number;
  densePW: number; // PDENSE x FLAT
  densePB: number;
  denseSW: number; // SDENSE x SCALARS
  denseSB: number;
  merge1W: number; // MERGE x (PDENSE + SDENSE)
  merge1B: number;
  merge2W: number; // 1 x MERGE
  merge2B: number;
  total: number;
};

export function layout(): Layout {
  let at = 0;
  const alloc = (n: number): number => {
    const start = at;
    at += n;
    return start;
  };
  return {
    conv1W: alloc(C1 * 3 * 3),
    conv1B: alloc(C1),
    conv2W: alloc(C2 * C1 * 3 * 3),
    conv2B: alloc(C2),
    densePW: alloc(PDENSE * FLAT),
    densePB: alloc(PDENSE),
    denseSW: alloc(SDENSE * SCALARS),
    denseSB: alloc(SDENSE),
    merge1W: alloc(MERGE * (PDENSE + SDENSE)),
    merge1B: alloc(MERGE),
    merge2W: alloc(1 * MERGE),
    merge2B: alloc(1),
    total: at,
  };
}

/**
 * Fixed input transforms, part of the shipped model contract: the ratio-like
 * witnesses carry heavy right tails, so they enter through log1p; booleans
 * and the already-bounded readings enter as they are. Indices follow
 * `training/features.ts` WITNESS_NAMES then the four whitened flux readings.
 */
export function transformScalars(raw: Float32Array, out: Float32Array): void {
  for (let i = 0; i < 7; i++) out[i] = Math.log1p(Math.max(0, raw[i] as number));
  out[7] = Math.log1p(Math.max(0, raw[7] as number)) / 8; // soundedMs
  out[8] = raw[8] as number;
  out[9] = raw[9] as number;
  out[10] = raw[10] as number;
  out[11] = raw[11] as number;
  out[12] = Math.log1p(Math.max(0, raw[12] as number)); // wFlux
  out[13] = raw[13] as number; // wFluxNorm
  out[14] = Math.log1p(Math.max(0, raw[14] as number)); // wHeldFlux
  out[15] = raw[15] as number; // wHeldNorm
}

/** Scratch buffers for one forward/backward pass; reused across samples. */
export class Activations {
  a1 = new Float32Array(C1 * T1 * F1);
  p1 = new Float32Array(C1 * T1 * F1P);
  p1arg = new Int32Array(C1 * T1 * F1P);
  a2 = new Float32Array(C2 * T2 * F2);
  p2 = new Float32Array(C2 * T2 * F2P);
  p2arg = new Int32Array(C2 * T2 * F2P);
  hP = new Float32Array(PDENSE);
  sIn = new Float32Array(SCALARS);
  hS = new Float32Array(SDENSE);
  hM = new Float32Array(MERGE);
  z = 0;
  p = 0;
}

const L = layout();
export const PARAM_COUNT = L.total;

/**
 * Forward pass. `patch` is row-major [t][f] (t oldest first), values the
 * whitened band frames; `scalars` must already be transformed. Returns the
 * pre-sigmoid logit and fills `act` for the backward pass.
 */
export function forward(params: Float32Array, patch: Float32Array, scalars: Float32Array, act: Activations): number {
  // conv1 (valid, 3x3, 1 -> C1) + relu
  for (let c = 0; c < C1; c++) {
    const wBase = L.conv1W + c * 9;
    const b = params[L.conv1B + c] as number;
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
        act.a1[(c * T1 + t) * F1 + f] = v > 0 ? v : 0;
      }
    }
  }
  // maxpool over f, width 2
  for (let c = 0; c < C1; c++) {
    for (let t = 0; t < T1; t++) {
      const base = (c * T1 + t) * F1;
      const outBase = (c * T1 + t) * F1P;
      for (let f = 0; f < F1P; f++) {
        const i0 = base + f * 2;
        const v0 = act.a1[i0] as number;
        const v1 = act.a1[i0 + 1] as number;
        if (v0 >= v1) {
          act.p1[outBase + f] = v0;
          act.p1arg[outBase + f] = i0;
        } else {
          act.p1[outBase + f] = v1;
          act.p1arg[outBase + f] = i0 + 1;
        }
      }
    }
  }
  // conv2 (valid, 3x3, C1 -> C2) + relu
  for (let c = 0; c < C2; c++) {
    const b = params[L.conv2B + c] as number;
    for (let t = 0; t < T2; t++) {
      for (let f = 0; f < F2; f++) {
        let v = b;
        for (let ci = 0; ci < C1; ci++) {
          const wBase = L.conv2W + (c * C1 + ci) * 9;
          for (let dt = 0; dt < 3; dt++) {
            const inBase = (ci * T1 + t + dt) * F1P + f;
            const wRow = wBase + dt * 3;
            v +=
              (params[wRow] as number) * (act.p1[inBase] as number) +
              (params[wRow + 1] as number) * (act.p1[inBase + 1] as number) +
              (params[wRow + 2] as number) * (act.p1[inBase + 2] as number);
          }
        }
        act.a2[(c * T2 + t) * F2 + f] = v > 0 ? v : 0;
      }
    }
  }
  // maxpool over f, width 3
  for (let c = 0; c < C2; c++) {
    for (let t = 0; t < T2; t++) {
      const base = (c * T2 + t) * F2;
      const outBase = (c * T2 + t) * F2P;
      for (let f = 0; f < F2P; f++) {
        const i0 = base + f * 3;
        let best = i0;
        if ((act.a2[i0 + 1] as number) > (act.a2[best] as number)) best = i0 + 1;
        if ((act.a2[i0 + 2] as number) > (act.a2[best] as number)) best = i0 + 2;
        act.p2[outBase + f] = act.a2[best] as number;
        act.p2arg[outBase + f] = best;
      }
    }
  }
  // dense patch head + relu
  for (let o = 0; o < PDENSE; o++) {
    let v = params[L.densePB + o] as number;
    const wBase = L.densePW + o * FLAT;
    for (let i = 0; i < FLAT; i++) v += (params[wBase + i] as number) * (act.p2[i] as number);
    act.hP[o] = v > 0 ? v : 0;
  }
  // dense scalar head + relu
  act.sIn.set(scalars);
  for (let o = 0; o < SDENSE; o++) {
    let v = params[L.denseSB + o] as number;
    const wBase = L.denseSW + o * SCALARS;
    for (let i = 0; i < SCALARS; i++) v += (params[wBase + i] as number) * (scalars[i] as number);
    act.hS[o] = v > 0 ? v : 0;
  }
  // merge + relu
  for (let o = 0; o < MERGE; o++) {
    let v = params[L.merge1B + o] as number;
    const wBase = L.merge1W + o * (PDENSE + SDENSE);
    for (let i = 0; i < PDENSE; i++) v += (params[wBase + i] as number) * (act.hP[i] as number);
    for (let i = 0; i < SDENSE; i++) v += (params[wBase + PDENSE + i] as number) * (act.hS[i] as number);
    act.hM[o] = v > 0 ? v : 0;
  }
  // output
  let z = params[L.merge2B] as number;
  for (let i = 0; i < MERGE; i++) z += (params[L.merge2W + i] as number) * (act.hM[i] as number);
  act.z = z;
  act.p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  return z;
}

/**
 * Backward pass for one sample: accumulates dLoss/dParams into `grad` given
 * dLoss/dz (for weighted BCE with sigmoid output, that is `w * (p - y)`).
 * Mirrors `forward` exactly; the argmax indices recorded there route the
 * pooling gradients.
 */
export function backward(
  params: Float32Array,
  patch: Float32Array,
  act: Activations,
  dz: number,
  grad: Float32Array,
  scratch: {
    dhM: Float32Array;
    dhP: Float32Array;
    dhS: Float32Array;
    dp2: Float32Array;
    da2: Float32Array;
    dp1: Float32Array;
    da1: Float32Array;
  }
): void {
  const { dhM, dhP, dhS, dp2, da2, dp1, da1 } = scratch;

  grad[L.merge2B] = (grad[L.merge2B] as number) + dz;
  for (let i = 0; i < MERGE; i++) {
    grad[L.merge2W + i] = (grad[L.merge2W + i] as number) + dz * (act.hM[i] as number);
    dhM[i] = (act.hM[i] as number) > 0 ? dz * (params[L.merge2W + i] as number) : 0;
  }

  dhP.fill(0);
  dhS.fill(0);
  for (let o = 0; o < MERGE; o++) {
    const d = dhM[o] as number;
    if (d === 0) continue;
    const wBase = L.merge1W + o * (PDENSE + SDENSE);
    grad[L.merge1B + o] = (grad[L.merge1B + o] as number) + d;
    for (let i = 0; i < PDENSE; i++) {
      grad[wBase + i] = (grad[wBase + i] as number) + d * (act.hP[i] as number);
      dhP[i] = (dhP[i] as number) + d * (params[wBase + i] as number);
    }
    for (let i = 0; i < SDENSE; i++) {
      grad[wBase + PDENSE + i] = (grad[wBase + PDENSE + i] as number) + d * (act.hS[i] as number);
      dhS[i] = (dhS[i] as number) + d * (params[wBase + PDENSE + i] as number);
    }
  }

  dp2.fill(0);
  for (let o = 0; o < PDENSE; o++) {
    if ((act.hP[o] as number) <= 0) continue;
    const d = dhP[o] as number;
    if (d === 0) continue;
    const wBase = L.densePW + o * FLAT;
    grad[L.densePB + o] = (grad[L.densePB + o] as number) + d;
    for (let i = 0; i < FLAT; i++) {
      grad[wBase + i] = (grad[wBase + i] as number) + d * (act.p2[i] as number);
      dp2[i] = (dp2[i] as number) + d * (params[wBase + i] as number);
    }
  }
  for (let o = 0; o < SDENSE; o++) {
    if ((act.hS[o] as number) <= 0) continue;
    const d = dhS[o] as number;
    if (d === 0) continue;
    const wBase = L.denseSW + o * SCALARS;
    grad[L.denseSB + o] = (grad[L.denseSB + o] as number) + d;
    for (let i = 0; i < SCALARS; i++) {
      grad[wBase + i] = (grad[wBase + i] as number) + d * (act.sIn[i] as number);
    }
  }

  // unpool f3 into conv2 activations
  da2.fill(0);
  for (let i = 0; i < C2 * T2 * F2P; i++) {
    const d = dp2[i] as number;
    if (d !== 0) da2[act.p2arg[i] as number] = (da2[act.p2arg[i] as number] as number) + d;
  }

  // conv2 backward
  dp1.fill(0);
  for (let c = 0; c < C2; c++) {
    for (let t = 0; t < T2; t++) {
      for (let f = 0; f < F2; f++) {
        const idx = (c * T2 + t) * F2 + f;
        if ((act.a2[idx] as number) <= 0) continue;
        const d = da2[idx] as number;
        if (d === 0) continue;
        grad[L.conv2B + c] = (grad[L.conv2B + c] as number) + d;
        for (let ci = 0; ci < C1; ci++) {
          const wBase = L.conv2W + (c * C1 + ci) * 9;
          for (let dt = 0; dt < 3; dt++) {
            const inBase = (ci * T1 + t + dt) * F1P + f;
            const wRow = wBase + dt * 3;
            grad[wRow] = (grad[wRow] as number) + d * (act.p1[inBase] as number);
            grad[wRow + 1] = (grad[wRow + 1] as number) + d * (act.p1[inBase + 1] as number);
            grad[wRow + 2] = (grad[wRow + 2] as number) + d * (act.p1[inBase + 2] as number);
            dp1[inBase] = (dp1[inBase] as number) + d * (params[wRow] as number);
            dp1[inBase + 1] = (dp1[inBase + 1] as number) + d * (params[wRow + 1] as number);
            dp1[inBase + 2] = (dp1[inBase + 2] as number) + d * (params[wRow + 2] as number);
          }
        }
      }
    }
  }

  // unpool f2 into conv1 activations
  da1.fill(0);
  for (let i = 0; i < C1 * T1 * F1P; i++) {
    const d = dp1[i] as number;
    if (d !== 0) da1[act.p1arg[i] as number] = (da1[act.p1arg[i] as number] as number) + d;
  }

  // conv1 backward (input gradient not needed)
  for (let c = 0; c < C1; c++) {
    const wBase = L.conv1W + c * 9;
    for (let t = 0; t < T1; t++) {
      for (let f = 0; f < F1; f++) {
        const idx = (c * T1 + t) * F1 + f;
        if ((act.a1[idx] as number) <= 0) continue;
        const d = da1[idx] as number;
        if (d === 0) continue;
        grad[L.conv1B + c] = (grad[L.conv1B + c] as number) + d;
        for (let dt = 0; dt < 3; dt++) {
          const rowBase = (t + dt) * PATCH_F + f;
          const wRow = wBase + dt * 3;
          grad[wRow] = (grad[wRow] as number) + d * (patch[rowBase] as number);
          grad[wRow + 1] = (grad[wRow + 1] as number) + d * (patch[rowBase + 1] as number);
          grad[wRow + 2] = (grad[wRow + 2] as number) + d * (patch[rowBase + 2] as number);
        }
      }
    }
  }
}

export function makeScratch(): Parameters<typeof backward>[5] {
  return {
    dhM: new Float32Array(MERGE),
    dhP: new Float32Array(PDENSE),
    dhS: new Float32Array(SDENSE),
    dp2: new Float32Array(FLAT),
    da2: new Float32Array(C2 * T2 * F2),
    dp1: new Float32Array(C1 * T1 * F1P),
    da1: new Float32Array(C1 * T1 * F1),
  };
}

/** He-style init, seeded. */
export function initParams(rng: () => number): Float32Array {
  const params = new Float32Array(PARAM_COUNT);
  const gauss = (): number => {
    const u = Math.max(rng(), 1e-12);
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const fill = (start: number, count: number, fanIn: number): void => {
    const sd = Math.sqrt(2 / fanIn);
    for (let i = 0; i < count; i++) params[start + i] = gauss() * sd;
  };
  fill(L.conv1W, C1 * 9, 9);
  fill(L.conv2W, C2 * C1 * 9, C1 * 9);
  fill(L.densePW, PDENSE * FLAT, FLAT);
  fill(L.denseSW, SDENSE * SCALARS, SCALARS);
  fill(L.merge1W, MERGE * (PDENSE + SDENSE), PDENSE + SDENSE);
  fill(L.merge2W, MERGE, MERGE);
  return params;
}

export { L as LAYOUT };
