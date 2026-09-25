/**
 * Are the GGUF's weights the published checkpoint's weights?
 *
 * The chain from the model's authors to the file evaluated here has three
 * hands in it: ddPn08 trained `epoch=9-step=46600.ckpt` with the
 * hft-transformers-rewrite code; a flutter_tuner export kernel turned it into
 * ONNX and pruned the graph to its four `_B` outputs; CrispASR's converter
 * turned the ONNX initialisers into `hft-transformer-f32.gguf`, fusing the
 * (1,5) convolution into the token embedding. The model card vouches for the
 * last step. This checks the whole chain against its two ends, both pinned:
 *
 *   - every GGUF tensor against the checkpoint tensor it came from, the fused
 *     front end against the fusion recomputed here from the checkpoint's own
 *     convolution and embedding;
 *   - the two front-end constants the converter wrote (`hft.window`,
 *     `hft.mel_fb`) against torchaudio's formulas for the configuration the
 *     model was trained with (`dataset.json`: 16kHz, n_fft 2048, 256 mels,
 *     periodic Hann, HTK mel scale, slaney norm, f_max = sr / 2);
 *   - which checkpoint tensors the GGUF does NOT carry (the frequency
 *     decoder's `_A` heads and all six pedal heads), and so what the GGUF
 *     cannot compute.
 *
 * WHAT WOULD FAIL IT: any tensor off by more than float32 rounding, or a
 * front-end constant off by more than float32 rounding of a float64
 * reference. Either means the evaluation would be reading some other model.
 *
 * Input: the tensors `read-ckpt.py --export` wrote, and the GGUF.
 * Usage:
 *   npx tsx training/hft-transformer/ckpt-vs-gguf.ts --dir training/out/hft-transformer
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { f32Tensor, readGguf } from "./gguf.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const dir = arg("dir") ?? "training/out/hft-transformer";

type Index = { checkpoint_sha256: string; tensors: Record<string, { file: string; shape: number[] }> };
const index = JSON.parse(readFileSync(join(dir, "ckpt/tensors/index.json"), "utf8")) as Index;
if (index.checkpoint_sha256 !== "7b7b575c2f02b3c36f1c3e2079b29eaca020ecb79fee40a1a473ef60052e9d12") {
  throw new Error("exported tensors are not from the pinned checkpoint");
}
function ck(name: string): Float32Array {
  const e = index.tensors[`model.${name}`];
  if (e === undefined) throw new Error(`checkpoint: no tensor model.${name}`);
  const b = readFileSync(join(dir, "ckpt/tensors", e.file));
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const gguf = readGguf(join(dir, "hf/hft-transformer-f32.gguf"));

/** Largest |a - b| over max |b|, so the figure is rounding-relative. */
function relErr(a: Float32Array | Float64Array, b: Float32Array | Float64Array): number {
  if (a.length !== b.length) return Infinity;
  let worst = 0;
  let scale = 0;
  for (let i = 0; i < a.length; i++) {
    worst = Math.max(worst, Math.abs((a[i] as number) - (b[i] as number)));
    scale = Math.max(scale, Math.abs(b[i] as number));
  }
  return scale > 0 ? worst / scale : worst;
}

// ---------------------------------------------------------------------------
// 1. Name map: GGUF tensor -> checkpoint tensor (identical layout)
// ---------------------------------------------------------------------------

const pairs: Array<[string, string]> = [
  ["hft.encoder.pos_freq", "encoder.pos_embedding_freq.weight"],
  ["hft.decoder.pos_freq", "decoder.pos_embedding_freq.weight"],
  ["hft.decoder.pos_time", "decoder.pos_embedding_time.weight"],
];
const linear = (g: string, c: string): void => {
  pairs.push([`${g}.weight`, `${c}.weight`], [`${g}.bias`, `${c}.bias`]);
};
const attn = (g: string, c: string): void => {
  for (const p of ["q", "k", "v", "o"]) linear(`${g}.${p}`, `${c}.fc_${p}`);
};
const block = (g: string, c: string, self: string | null, cross: string | null): void => {
  if (self !== null) attn(`${g}.attn`, `${c}.${self}`);
  if (cross !== null) attn(`${g}.xattn`, `${c}.${cross}`);
  linear(`${g}.ff1`, `${c}.positionwise_feedforward.fc_1`);
  linear(`${g}.ff2`, `${c}.positionwise_feedforward.fc_2`);
  pairs.push([`${g}.ln.weight`, `${c}.layer_norm.weight`], [`${g}.ln.bias`, `${c}.layer_norm.bias`]);
};
for (let i = 0; i < 3; i++) block(`hft.enc.${i}`, `encoder.layers_freq.${i}`, "self_attention", null);
block("hft.decfreq.0", "decoder.layer_zero_freq", null, "encoder_attention");
for (let i = 1; i < 3; i++) {
  block(`hft.decfreq.${i}`, `decoder.layers_freq.${i - 1}`, "self_attention", "encoder_attention");
}
for (let i = 0; i < 3; i++) block(`hft.dectime.${i}`, `decoder.layers_time.${i}`, "self_attention", null);
for (const h of ["onset", "offset", "mpe", "velocity"]) linear(`hft.head.${h}`, `decoder.fc_${h}_time`);

let worstMapped = 0;
let mappedElements = 0;
const used = new Set<string>();
for (const [g, c] of pairs) {
  const e = relErr(f32Tensor(gguf, g), ck(c));
  worstMapped = Math.max(worstMapped, e);
  mappedElements += ck(c).length;
  used.add(`model.${c}`);
}

// ---------------------------------------------------------------------------
// 2. The fused front end, recomputed from the checkpoint
// ---------------------------------------------------------------------------

const TAPS = 65;
const CH = 4;
const K = 5;
const J = TAPS - (K - 1); // 61
const H = 256;
const wConv = ck("encoder.conv.weight"); // [4, 1, 1, 5]
const bConv = ck("encoder.conv.bias"); // [4]
const wTok = ck("encoder.tok_embedding_freq.weight"); // [256, 244]
const bTok = ck("encoder.tok_embedding_freq.bias"); // [256]
for (const n of ["conv.weight", "conv.bias", "tok_embedding_freq.weight", "tok_embedding_freq.bias"]) {
  used.add(`model.encoder.${n}`);
}
const fusedW = new Float64Array(H * TAPS); // [d][m], the GGUF's [65, 256] layout
const fusedB = new Float64Array(H);
for (let d = 0; d < H; d++) {
  let b = bTok[d] as number;
  for (let c = 0; c < CH; c++) {
    let rowSum = 0;
    for (let j = 0; j < J; j++) rowSum += wTok[d * CH * J + c * J + j] as number;
    b += (bConv[c] as number) * rowSum;
  }
  fusedB[d] = b;
  for (let m = 0; m < TAPS; m++) {
    let s = 0;
    for (let c = 0; c < CH; c++) {
      for (let j = Math.max(0, m - (K - 1)); j <= Math.min(J - 1, m); j++) {
        s += (wTok[d * CH * J + c * J + j] as number) * (wConv[c * K + (m - j)] as number);
      }
    }
    fusedW[d * TAPS + m] = s;
  }
}
const frontW = relErr(f32Tensor(gguf, "hft.encoder.front.weight"), fusedW);
const frontB = relErr(f32Tensor(gguf, "hft.encoder.front.bias"), fusedB);

// ---------------------------------------------------------------------------
// 3. Front-end constants against torchaudio's formulas
// ---------------------------------------------------------------------------

const SR = 16000;
const NFFT = 2048;
const NMELS = 256;
const NFREQ = NFFT / 2 + 1;
const hann = new Float64Array(NFFT);
for (let n = 0; n < NFFT; n++) hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / NFFT); // periodic
const windowErr = relErr(f32Tensor(gguf, "hft.window"), hann);

// torchaudio.functional.melscale_fbanks(1025, 0, 8000, 256, 16000, norm="slaney", mel_scale="htk")
const hzToMel = (f: number): number => 2595 * Math.log10(1 + f / 700);
const melToHz = (m: number): number => 700 * (10 ** (m / 2595) - 1);
const allFreqs = Array.from({ length: NFREQ }, (_, i) => (i * (SR / 2)) / (NFREQ - 1));
const mMin = hzToMel(0);
const mMax = hzToMel(SR / 2);
const fPts = Array.from({ length: NMELS + 2 }, (_, i) => melToHz(mMin + ((mMax - mMin) * i) / (NMELS + 1)));
const fb = new Float64Array(NMELS * NFREQ); // [mel][freq], the GGUF's [1025, 256] layout
for (let m = 0; m < NMELS; m++) {
  const lo = fPts[m] as number;
  const ce = fPts[m + 1] as number;
  const hi = fPts[m + 2] as number;
  const enorm = 2 / (hi - lo);
  for (let f = 0; f < NFREQ; f++) {
    const x = allFreqs[f] as number;
    const down = (x - lo) / (ce - lo);
    const up = (hi - x) / (hi - ce);
    fb[m * NFREQ + f] = Math.max(0, Math.min(down, up)) * enorm;
  }
}
const melErr = relErr(f32Tensor(gguf, "hft.mel_fb"), fb);

// ---------------------------------------------------------------------------
// 4. What the GGUF does not carry
// ---------------------------------------------------------------------------

const absent = Object.keys(index.tensors).filter((n) => !used.has(n));
let absentElements = 0;
for (const n of absent) absentElements += (index.tensors[n]?.shape ?? []).reduce((a, b) => a * b, 1);
let ckElements = 0;
for (const e of Object.values(index.tensors)) ckElements += e.shape.reduce((a, b) => a * b, 1);
let ggufParams = 0;
for (const t of gguf.tensors) if (t.name !== "hft.mel_fb" && t.name !== "hft.window") ggufParams += t.elements;

const ok = (e: number, bar: number): string => (e <= bar ? "ok" : "FAIL");
console.log("GGUF against checkpoint (worst |difference| over the tensor's largest |value|)");
console.log(`  ${pairs.length} tensors mapped by name, ${mappedElements.toLocaleString("en-US")} values: ${worstMapped.toExponential(2)}  ${ok(worstMapped, 0)}`);
console.log(`  fused front end, recomputed here: weight ${frontW.toExponential(2)}  bias ${frontB.toExponential(2)}  ${ok(Math.max(frontW, frontB), 1e-5)}`);
console.log(`  hft.window against a periodic Hann(2048): ${windowErr.toExponential(2)}  ${ok(windowErr, 1e-6)}`);
console.log(`  hft.mel_fb against torchaudio's HTK/slaney filterbank: ${melErr.toExponential(2)}  ${ok(melErr, 1e-5)}`);
console.log("");
console.log(`checkpoint parameters ${ckElements.toLocaleString("en-US")}; GGUF parameters ${ggufParams.toLocaleString("en-US")} (front end fused)`);
console.log(`checkpoint tensors the GGUF does not carry: ${absent.length}, ${absentElements.toLocaleString("en-US")} values`);
for (const n of absent) console.log(`  ${n} [${(index.tensors[n]?.shape ?? []).join(", ")}]`);
