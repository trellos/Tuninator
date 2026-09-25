/**
 * Does the ggml runtime compute what the checkpoint's own architecture
 * computes? An independent re-implementation, in plain TypeScript, of the two
 * things this evaluation depends on:
 *
 *   1. the front end, from torchaudio's definition as `dataset.json` configures
 *      it (16kHz, n_fft = win = 2048 periodic Hann, hop 256, centred frames
 *      with CONSTANT (zero) padding, power 2, 256 HTK mels with slaney norm,
 *      f_max 8000, then log(mel + 1e-8)); and
 *   2. the forward pass of `modules/{encoder,decoder,layers}.py` from
 *      ddPn08/hft-transformers-rewrite, UNFUSED: the Conv2d(1, 4, (1, 5)) and
 *      the 244-wide token embedding as the checkpoint holds them, one
 *      LayerNorm module reused after every residual add, no scaling on the
 *      frequency decoder's queries, x16 on the encoder tokens and the time
 *      decoder's input, 4 heads of 64 with scale 1/8.
 *
 * It reads the checkpoint's tensors (`read-ckpt.py --export`), never the GGUF,
 * so a shared mistake in the conversion or the fusion cannot cancel out.
 *
 * WHAT WOULD FAIL IT, stated before running: a log-mel difference beyond
 * float32 rounding on bins above the floor, or a post-sigmoid head difference
 * above 1e-4 anywhere, or any cell on the other side of 0.5 from the runtime.
 * The model card's own figure for its port against the ONNX export is 2.5e-06
 * on the onset head.
 *
 * It also returns the frequency decoder's `_A` heads, which the GGUF does not
 * carry, for the record: they are the model's reading with a fixed ±576ms
 * receptive field (see `phase1.ts`).
 *
 * Usage (the clip and the runtime's dump come from `hft-read full`):
 *   npx tsx training/hft-transformer/reference-forward.ts --dir training/out/hft-transformer \
 *     --pcm test/test16k.f32 --dump test/full [--window 0]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] as string) : fallback;
}
const dir = arg("dir", "training/out/hft-transformer");
const pcmPath = join(dir, arg("pcm", "test/test16k.f32"));
const dumpPrefix = join(dir, arg("dump", "test/full"));
const windowIndex = Number(arg("window", "0"));

const readF32 = (p: string): Float32Array => {
  const b = readFileSync(p);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

type Index = { checkpoint_sha256: string; tensors: Record<string, { file: string; shape: number[] }> };
const index = JSON.parse(readFileSync(join(dir, "ckpt/tensors/index.json"), "utf8")) as Index;
const W = (name: string): Float32Array => {
  const e = index.tensors[`model.${name}`];
  if (e === undefined) throw new Error(`checkpoint: no tensor model.${name}`);
  return readF32(join(dir, "ckpt/tensors", e.file));
};

// ---------------------------------------------------------------------------
// 1. Front end
// ---------------------------------------------------------------------------

const SR = 16000;
const NFFT = 2048;
const HOP = 256;
const NMELS = 256;
const NFREQ = NFFT / 2 + 1;
const LOG_EPS = 1e-8;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = (re[b] as number) * wr - (im[b] as number) * wi;
        const ti = (re[b] as number) * wi + (im[b] as number) * wr;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
      }
    }
  }
}

function logMel(pcm: Float32Array): { T: number; mel: Float64Array } {
  const hann = new Float64Array(NFFT);
  for (let n = 0; n < NFFT; n++) hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / NFFT);
  const hzToMel = (f: number): number => 2595 * Math.log10(1 + f / 700);
  const melToHz = (m: number): number => 700 * (10 ** (m / 2595) - 1);
  const fPts = Array.from({ length: NMELS + 2 }, (_, i) => melToHz((hzToMel(SR / 2) * i) / (NMELS + 1)));
  const fb = new Float64Array(NMELS * NFREQ);
  for (let m = 0; m < NMELS; m++) {
    const lo = fPts[m] as number;
    const ce = fPts[m + 1] as number;
    const hi = fPts[m + 2] as number;
    for (let f = 0; f < NFREQ; f++) {
      const x = (f * (SR / 2)) / (NFREQ - 1);
      fb[m * NFREQ + f] = Math.max(0, Math.min((x - lo) / (ce - lo), (hi - x) / (hi - ce))) * (2 / (hi - lo));
    }
  }
  const T = Math.floor(pcm.length / HOP) + 1;
  const mel = new Float64Array(T * NMELS);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const power = new Float64Array(NFREQ);
  for (let t = 0; t < T; t++) {
    for (let n = 0; n < NFFT; n++) {
      const s = t * HOP - NFFT / 2 + n;
      re[n] = s >= 0 && s < pcm.length ? (pcm[s] as number) * (hann[n] as number) : 0;
      im[n] = 0;
    }
    fft(re, im);
    for (let k = 0; k < NFREQ; k++) power[k] = (re[k] as number) ** 2 + (im[k] as number) ** 2;
    for (let m = 0; m < NMELS; m++) {
      let s = 0;
      for (let k = 0; k < NFREQ; k++) s += (fb[m * NFREQ + k] as number) * (power[k] as number);
      mel[t * NMELS + m] = Math.log(s + LOG_EPS);
    }
  }
  return { T, mel };
}

// ---------------------------------------------------------------------------
// 2. The network, as modules/*.py writes it
// ---------------------------------------------------------------------------

const HID = 256;
const HEADS = 4;
const HD = HID / HEADS;
const PF = 512;
const NFRAME = 128;
const MARGIN = 32;
const NPROC = 2 * MARGIN + 1; // 65
const CH = 4;
const KER = 5;
const JW = NPROC - (KER - 1); // 61
const NOTES = 88;

/** y[n][o] = b[o] + sum_i x[n][i] * w[o][i] — PyTorch's Linear. */
function linear(x: Float64Array, n: number, inDim: number, w: Float32Array, b: Float32Array, outDim: number): Float64Array {
  const y = new Float64Array(n * outDim);
  for (let r = 0; r < n; r++) {
    const xo = r * inDim;
    for (let o = 0; o < outDim; o++) {
      const wo = o * inDim;
      let s = b[o] as number;
      for (let i = 0; i < inDim; i++) s += (x[xo + i] as number) * (w[wo + i] as number);
      y[r * outDim + o] = s;
    }
  }
  return y;
}

function layerNorm(x: Float64Array, n: number, g: Float32Array, b: Float32Array): Float64Array {
  const y = new Float64Array(x.length);
  for (let r = 0; r < n; r++) {
    let mean = 0;
    for (let i = 0; i < HID; i++) mean += x[r * HID + i] as number;
    mean /= HID;
    let v = 0;
    for (let i = 0; i < HID; i++) v += ((x[r * HID + i] as number) - mean) ** 2;
    const inv = 1 / Math.sqrt(v / HID + 1e-5);
    for (let i = 0; i < HID; i++) y[r * HID + i] = ((x[r * HID + i] as number) - mean) * inv * (g[i] as number) + (b[i] as number);
  }
  return y;
}

const add = (a: Float64Array, b: Float64Array): Float64Array => a.map((v, i) => v + (b[i] as number));

type Attn = { q: [Float32Array, Float32Array]; k: [Float32Array, Float32Array]; v: [Float32Array, Float32Array]; o: [Float32Array, Float32Array] };
const loadAttn = (p: string): Attn => ({
  q: [W(`${p}.fc_q.weight`), W(`${p}.fc_q.bias`)],
  k: [W(`${p}.fc_k.weight`), W(`${p}.fc_k.bias`)],
  v: [W(`${p}.fc_v.weight`), W(`${p}.fc_v.bias`)],
  o: [W(`${p}.fc_o.weight`), W(`${p}.fc_o.bias`)],
});

function mha(a: Attn, query: Float64Array, nq: number, kv: Float64Array, nk: number): Float64Array {
  const Q = linear(query, nq, HID, a.q[0], a.q[1], HID);
  const K = linear(kv, nk, HID, a.k[0], a.k[1], HID);
  const V = linear(kv, nk, HID, a.v[0], a.v[1], HID);
  const out = new Float64Array(nq * HID);
  const e = new Float64Array(nk);
  for (let h = 0; h < HEADS; h++) {
    for (let i = 0; i < nq; i++) {
      let max = -Infinity;
      for (let j = 0; j < nk; j++) {
        let s = 0;
        for (let d = 0; d < HD; d++) s += (Q[i * HID + h * HD + d] as number) * (K[j * HID + h * HD + d] as number);
        e[j] = s / Math.sqrt(HD);
        if ((e[j] as number) > max) max = e[j] as number;
      }
      let z = 0;
      for (let j = 0; j < nk; j++) {
        e[j] = Math.exp((e[j] as number) - max);
        z += e[j] as number;
      }
      for (let d = 0; d < HD; d++) {
        let s = 0;
        for (let j = 0; j < nk; j++) s += (e[j] as number) * (V[j * HID + h * HD + d] as number);
        out[i * HID + h * HD + d] = s / z;
      }
    }
  }
  return linear(out, nq, HID, a.o[0], a.o[1], HID);
}

type Layer = { ln: [Float32Array, Float32Array]; self: Attn | null; cross: Attn | null; ff1: [Float32Array, Float32Array]; ff2: [Float32Array, Float32Array] };
const loadLayer = (p: string, self: boolean, cross: boolean): Layer => ({
  ln: [W(`${p}.layer_norm.weight`), W(`${p}.layer_norm.bias`)],
  self: self ? loadAttn(`${p}.self_attention`) : null,
  cross: cross ? loadAttn(`${p}.encoder_attention`) : null,
  ff1: [W(`${p}.positionwise_feedforward.fc_1.weight`), W(`${p}.positionwise_feedforward.fc_1.bias`)],
  ff2: [W(`${p}.positionwise_feedforward.fc_2.weight`), W(`${p}.positionwise_feedforward.fc_2.bias`)],
});

function applyLayer(l: Layer, x: Float64Array, n: number, mem: Float64Array | null, nm: number): Float64Array {
  if (l.self !== null) x = layerNorm(add(x, mha(l.self, x, n, x, n)), n, l.ln[0], l.ln[1]);
  if (l.cross !== null && mem !== null) x = layerNorm(add(x, mha(l.cross, x, n, mem, nm)), n, l.ln[0], l.ln[1]);
  const h = linear(x, n, HID, l.ff1[0], l.ff1[1], PF).map((v) => Math.max(0, v));
  return layerNorm(add(x, linear(h, n, PF, l.ff2[0], l.ff2[1], HID)), n, l.ln[0], l.ln[1]);
}

const conv = [W("encoder.conv.weight"), W("encoder.conv.bias")] as const;
const tok = [W("encoder.tok_embedding_freq.weight"), W("encoder.tok_embedding_freq.bias")] as const;
const posEnc = W("encoder.pos_embedding_freq.weight");
const enc = [0, 1, 2].map((i) => loadLayer(`encoder.layers_freq.${i}`, true, false));
const posDecFreq = W("decoder.pos_embedding_freq.weight");
const decFreq = [
  loadLayer("decoder.layer_zero_freq", false, true),
  loadLayer("decoder.layers_freq.0", true, true),
  loadLayer("decoder.layers_freq.1", true, true),
];
const posTime = W("decoder.pos_embedding_time.weight");
const decTime = [0, 1, 2].map((i) => loadLayer(`decoder.layers_time.${i}`, true, false));
const headA = (h: string): [Float32Array, Float32Array] => [W(`decoder.fc_${h}_freq.weight`), W(`decoder.fc_${h}_freq.bias`)];
const headB = (h: string): [Float32Array, Float32Array] => [W(`decoder.fc_${h}_time.weight`), W(`decoder.fc_${h}_time.bias`)];
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** One 192-frame window ([192][256] log-mel) -> A and B heads, [128][88] post-sigmoid. */
function forward(window: Float64Array): Record<string, Float64Array> {
  const out: Record<string, Float64Array> = {};
  for (const k of ["onsetA", "offsetA", "mpeA", "onsetB", "offsetB", "mpeB"]) out[k] = new Float64Array(NFRAME * NOTES);
  const freqOut: Float64Array[] = [];
  for (let i = 0; i < NFRAME; i++) {
    // Conv2d(1, 4, (1, 5)) over each bin's 65-tap window, then the 244-wide embedding.
    const cnn = new Float64Array(NMELS * CH * JW);
    for (let bin = 0; bin < NMELS; bin++) {
      for (let c = 0; c < CH; c++) {
        for (let j = 0; j < JW; j++) {
          let s = conv[1][c] as number;
          for (let k = 0; k < KER; k++) s += (conv[0][c * KER + k] as number) * (window[(i + j + k) * NMELS + bin] as number);
          cnn[bin * CH * JW + c * JW + j] = s;
        }
      }
    }
    let h = linear(cnn, NMELS, CH * JW, tok[0], tok[1], HID);
    for (let t = 0; t < h.length; t++) h[t] = (h[t] as number) * Math.sqrt(HID) + (posEnc[t] as number);
    for (const l of enc) h = applyLayer(l, h, NMELS, null, 0);
    let q: Float64Array = Float64Array.from(posDecFreq);
    for (const l of decFreq) q = applyLayer(l, q, NOTES, h, NMELS);
    freqOut.push(q);
    for (const [name, head] of [["onsetA", headA("onset")], ["offsetA", headA("offset")], ["mpeA", headA("mpe")]] as const) {
      const z = linear(q, NOTES, HID, head[0], head[1], 1);
      for (let p = 0; p < NOTES; p++) (out[name] as Float64Array)[i * NOTES + p] = sigmoid(z[p] as number);
    }
    if ((i + 1) % 32 === 0) process.stderr.write(`  frequency stages: ${i + 1}/${NFRAME} frames\n`);
  }
  for (let p = 0; p < NOTES; p++) {
    let t: Float64Array = new Float64Array(NFRAME * HID);
    for (let i = 0; i < NFRAME; i++) {
      for (let d = 0; d < HID; d++) {
        t[i * HID + d] = ((freqOut[i] as Float64Array)[p * HID + d] as number) * Math.sqrt(HID) + (posTime[i * HID + d] as number);
      }
    }
    for (const l of decTime) t = applyLayer(l, t, NFRAME, null, 0);
    for (const [name, head] of [["onsetB", headB("onset")], ["offsetB", headB("offset")], ["mpeB", headB("mpe")]] as const) {
      const z = linear(t, NFRAME, HID, head[0], head[1], 1);
      for (let i = 0; i < NFRAME; i++) (out[name] as Float64Array)[i * NOTES + p] = sigmoid(z[i] as number);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Compare with the runtime
// ---------------------------------------------------------------------------

const pcm = readF32(pcmPath);
const t0 = Date.now();
const { T, mel } = logMel(pcm);
const runtimeMel = readF32(`${dumpPrefix}.mel.f32`);
if (runtimeMel.length !== T * NMELS) throw new Error(`frame count: reference ${T}, runtime ${runtimeMel.length / NMELS}`);
let melWorst = 0;
let melWorstAboveFloor = 0;
let melWorstLoud = 0;
const SIXTY_DB = Math.log(1e6); // 60dB of power, in nepers of log(mel)
for (let t = 0; t < T; t++) {
  let peak = -Infinity;
  for (let b = 0; b < NMELS; b++) peak = Math.max(peak, mel[t * NMELS + b] as number);
  for (let b = 0; b < NMELS; b++) {
    const i = t * NMELS + b;
    const d = Math.abs((mel[i] as number) - (runtimeMel[i] as number));
    melWorst = Math.max(melWorst, d);
    if ((mel[i] as number) > Math.log(LOG_EPS) + 5) melWorstAboveFloor = Math.max(melWorstAboveFloor, d);
    if ((mel[i] as number) > peak - SIXTY_DB) melWorstLoud = Math.max(melWorstLoud, d);
  }
}
console.log(`front end: ${T} frames; worst |log-mel difference| ${melWorst.toExponential(2)} overall, ` +
  `${melWorstAboveFloor.toExponential(2)} on bins more than 5 nepers above the log(1e-8) floor, ` +
  `${melWorstLoud.toExponential(2)} on bins within 60dB of their frame's loudest`);

/**
 * The runtime's window arithmetic: 32 frames of log(1e-8) before frame 0,
 * answered frames w*128 .. w*128+127, and log(1e-8) after the last frame.
 */
function windowOf(m: Float64Array | Float32Array): Float64Array {
  const win = new Float64Array((NFRAME + 2 * MARGIN) * NMELS);
  for (let r = 0; r < NFRAME + 2 * MARGIN; r++) {
    const f = windowIndex * NFRAME - MARGIN + r;
    for (let b = 0; b < NMELS; b++) win[r * NMELS + b] = f >= 0 && f < T ? (m[f * NMELS + b] as number) : Math.log(LOG_EPS);
  }
  return win;
}

/**
 * Two comparisons, reported separately because they test different things:
 * the reference network on the RUNTIME'S OWN log-mel isolates the network's
 * arithmetic (the model card's parity is of this kind, both sides fed one
 * mel); on the reference's own float64 log-mel it is end to end, the runtime's
 * float32 front end included.
 */
let modelWorst = 0;
for (const [label, source] of [
  ["network only (both sides read the runtime's log-mel)", runtimeMel],
  ["end to end (the reference computes its own log-mel)", mel],
] as const) {
  const ref = forward(windowOf(source));
  console.log(`${label}: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  let worstAll = 0;
  for (const head of ["onset", "offset", "mpe"]) {
    const rt = readF32(`${dumpPrefix}.${head}.f32`);
    const r = ref[`${head}B`] as Float64Array;
    let worst = 0;
    let flips = 0;
    let above = 0;
    for (let i = 0; i < NFRAME; i++) {
      for (let p = 0; p < NOTES; p++) {
        const a = rt[(windowIndex * NFRAME + i) * NOTES + p] as number;
        const b = r[i * NOTES + p] as number;
        worst = Math.max(worst, Math.abs(a - b));
        if (a >= 0.5 !== b >= 0.5) flips++;
        if (b >= 0.5) above++;
      }
    }
    worstAll = Math.max(worstAll, worst);
    console.log(`  ${head.padEnd(6)} B head: worst |runtime - reference| ${worst.toExponential(2)}, ` +
      `${flips} of ${NFRAME * NOTES} cells on opposite sides of 0.5 (${above} at or above it in the reference)`);
  }
  if (source === runtimeMel) modelWorst = worstAll;
  let aVsB = 0;
  for (let i = 0; i < NFRAME * NOTES; i++) aVsB = Math.max(aVsB, Math.abs((ref.onsetA?.[i] ?? 0) - (ref.onsetB?.[i] ?? 0)));
  console.log(`  (the A onset head, which the GGUF does not carry, differs from B by up to ${aVsB.toFixed(3)} on this window)`);
}
console.log(modelWorst <= 1e-4 ? "NETWORK PARITY: the runtime computes the checkpoint's model" : "NETWORK PARITY FAILED");
