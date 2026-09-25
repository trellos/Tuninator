/**
 * Phase 1, step 3: does the model run correctly here? Its own repositories'
 * reference outputs, reproduced on this machine's runtime.
 *
 * The documented path is the Python package (`pip install basic-pitch`), which
 * cannot be installed here: pypi.org and files.pythonhosted.org are refused by
 * the environment's egress policy. The model instead runs as the ONNX file the
 * Python repository ships (`basic_pitch/saved_models/icassp_2022/nmp.onnx`,
 * a plain git blob), under `onnxruntime-node` 1.30.0 from registry.npmjs.org,
 * with the package's own windowing re-implemented in `framing.ts`. Parity is
 * checked against two references published by the model's authors:
 *
 *   A. github.com/spotify/basic-pitch-ts @ 2d498f8, `test_data/vocal-da-80bpm.json`:
 *      the Python pipeline's debug dump for `vocal-da-80bpm.22050.wav` — the
 *      exact input windows it fed the network and the unwrapped note, onset and
 *      contour outputs. The TS port's own test holds its runtime to 5e-3 of it.
 *      A1 feeds the dumped windows (network parity, nothing else in between);
 *      A2 rebuilds the windows from the WAV with `framing.ts` (framing parity).
 *   B. github.com/spotify/basic-pitch @ fa5997a, `tests/resources/vocadito_10.wav`
 *      and `vocadito_10/model_output.npz`: the Python test `test_predict`
 *      holds the package to 1e-4 of it. The WAV is 44.1kHz and the package
 *      resamples it with librosa; here it goes through `resample.ts`, the same
 *      resampler the fixtures will go through at 48kHz, so B also bounds what
 *      the resampler costs.
 *
 * WHAT WOULD FAIL IT, stated before running: A1 outside the TS port's own
 * 5e-3 on any output means the runtime or the file is not the model; B far
 * outside A1 means the framing or the resampler is wrong.
 *
 * Usage (after `npm ci` in training/basic-pitch/, and the clones in the
 * header of `phase1.ts`):
 *   npx tsx training/basic-pitch/parity.ts --dir training/out/basic-pitch
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readWav } from "../../src/offline/wav.js";
import { KEPT, OVERLAP_SAMPLES, SAMPLE_RATE, WINDOW_HOP, posteriorgram, windowsOf } from "./framing.js";
import { readPickledArrayDict, readZip } from "./npz.js";
import { resample } from "./resample.js";
import { WINDOW_FRAMES, loadModel } from "./runtime.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const dir = arg("dir");
if (!dir) {
  console.error("usage: npx tsx training/basic-pitch/parity.ts --dir <dir>  (see the header)");
  process.exit(2);
}

export const PINNED_REFERENCES: Record<string, string> = {
  "src/basic_pitch/saved_models/icassp_2022/nmp.onnx": "2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec",
  "src/tests/resources/vocadito_10.wav": "0978bde1c130ae26a9cfcd90012f12fdaf9877bbe45cf21c5237ba7ac9b8703b",
  "src/tests/resources/vocadito_10/model_output.npz": "45bf29f260cd37db50a198fb9897e6c6c1b21454f22424a3b527345422260a1b",
  "ts/test_data/vocal-da-80bpm.22050.wav": "b4d142de94b039cdd7ad90e2fabb3351aa294b82207ddd3b153ad1d3f5e285fa",
  "ts/test_data/vocal-da-80bpm.json": "d243f77adc619306f086ee8562cb5202fa5e996c1beef47187a93b07c8113b6c",
};

let drift = 0;
for (const [rel, want] of Object.entries(PINNED_REFERENCES)) {
  const got = createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex");
  if (got !== want) {
    console.error(`DRIFT ${rel}: sha256 ${got}, pinned ${want}`);
    drift++;
  }
}
if (drift > 0) process.exit(1);

type Stats = { maxAbs: number; meanAbs: number; over1e4: number; over5e3: number; n: number };
function compare(a: ArrayLike<number>, b: ArrayLike<number>): Stats {
  if (a.length !== b.length) throw new Error(`length ${a.length} against ${b.length}`);
  let maxAbs = 0;
  let sum = 0;
  let over1e4 = 0;
  let over5e3 = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs((a[i] as number) - (b[i] as number));
    maxAbs = Math.max(maxAbs, d);
    sum += d;
    if (d > 1e-4) over1e4++;
    if (d > 5e-3) over5e3++;
  }
  return { maxAbs, meanAbs: sum / a.length, over1e4, over5e3, n: a.length };
}
const row = (name: string, s: Stats): string =>
  `   ${name.padEnd(30)} max |d| ${s.maxAbs.toExponential(2).padStart(9)}   mean |d| ${s.meanAbs.toExponential(2).padStart(9)}` +
  `   > 1e-4: ${((100 * s.over1e4) / s.n).toFixed(2).padStart(6)}%   > 5e-3: ${((100 * s.over5e3) / s.n).toFixed(3).padStart(7)}%`;

const model = await loadModel(join(dir, "src/basic_pitch/saved_models/icassp_2022/nmp.onnx"));
console.log(`runtime: onnxruntime-node ${model.runtimeVersion}, 2 threads`);

/* ---- A. vocal-da-80bpm ------------------------------------------------------ */

type Dump = {
  audio_windowed: number[][][];
  audio_original_length: number;
  hop_size_samples: number;
  overlap_length_samples: number;
  unwrapped_output: { note: number[][]; onset: number[][]; contour: number[][] };
};
const dump = JSON.parse(readFileSync(join(dir, "ts/test_data/vocal-da-80bpm.json"), "utf8")) as Dump;
if (dump.hop_size_samples !== WINDOW_HOP || dump.overlap_length_samples !== OVERLAP_SAMPLES) {
  throw new Error("the dump's framing is not the pinned package's");
}
const dumpedWindows = dump.audio_windowed.map((w) => Float32Array.from(w, (v) => v[0] as number));
const refFrames = dump.unwrapped_output.note.length;
const flat = (m: number[][]): Float32Array => Float32Array.from(m.flat());

function unwrap(outs: Awaited<ReturnType<typeof model.run>>, frames: number) {
  const pick = (key: "note" | "onset" | "contour", width: number): Float32Array => {
    const out = new Float32Array(frames * width);
    let f = 0;
    for (const o of outs) {
      for (let k = 15; k < WINDOW_FRAMES - 15 && f < frames; k++, f++) {
        out.set(o[key].subarray(k * width, (k + 1) * width), f * width);
      }
    }
    return out;
  };
  return { note: pick("note", 88), onset: pick("onset", 88), contour: pick("contour", 264) };
}

console.log("\nA1. vocal-da-80bpm, the Python pipeline's own input windows (network parity)");
const a1 = unwrap(await model.run(dumpedWindows), refFrames);
console.log(`   ${dumpedWindows.length} windows, ${refFrames} frames compared`);
for (const k of ["note", "onset", "contour"] as const) console.log(row(k, compare(a1[k], flat(dump.unwrapped_output[k]))));

console.log("\nA2. vocal-da-80bpm, windows rebuilt from the WAV by framing.ts");
const wavA = readWav(new Uint8Array(readFileSync(join(dir, "ts/test_data/vocal-da-80bpm.22050.wav"))));
if (wavA.sampleRate !== SAMPLE_RATE || wavA.channels !== 1) throw new Error("vocal-da-80bpm.22050.wav is not 22050Hz mono");
if (wavA.samples.length !== dump.audio_original_length) throw new Error("the WAV is not the dumped audio");
const rebuilt = windowsOf(wavA.samples);
if (rebuilt.length !== dumpedWindows.length) throw new Error(`${rebuilt.length} windows against ${dumpedWindows.length}`);
let inMax = 0;
rebuilt.forEach((w, i) => (inMax = Math.max(inMax, compare(w, dumpedWindows[i] as Float32Array).maxAbs)));
console.log(`   input windows: max |d| ${inMax.toExponential(2)} (one 16-bit step is ${(1 / 32768).toExponential(2)})`);
const a2 = unwrap(await model.run(rebuilt), refFrames);
for (const k of ["note", "onset", "contour"] as const) console.log(row(k, compare(a2[k], flat(dump.unwrapped_output[k]))));

/* ---- B. vocadito_10 --------------------------------------------------------- */

console.log("\nB. vocadito_10 (44.1kHz), resampled by resample.ts, windowed by framing.ts");
const ref = readPickledArrayDict(
  readZip(new Uint8Array(readFileSync(join(dir, "src/tests/resources/vocadito_10/model_output.npz")))).get("arr_0.npy") as Uint8Array,
);
const wavB = readWav(new Uint8Array(readFileSync(join(dir, "src/tests/resources/vocadito_10.wav"))));
const audioB = resample(wavB.samples, wavB.sampleRate, SAMPLE_RATE);
const pg = await posteriorgram(model, audioB);
const expectFrames = Math.floor((audioB.length / WINDOW_HOP) * KEPT);
console.log(
  `   ${wavB.sampleRate}Hz -> ${SAMPLE_RATE}Hz: ${audioB.length} samples (the Python test asserts 200607); ` +
    `${pg.frames} frames against ${(ref.get("note")?.shape ?? []).join("x")} in the reference (expected ${expectFrames})`,
);
for (const k of ["note", "onset", "contour"] as const) {
  const r = ref.get(k);
  if (r === undefined) throw new Error(`reference has no ${k}`);
  const n = Math.min(pg[k].length, r.data.length);
  console.log(row(k, compare(pg[k].subarray(0, n), Array.from(r.data.subarray(0, n) as Float32Array))));
}
console.log(
  "\n   A1 is the network alone; A2 adds the windowing; B adds a different resampler than the reference's.\n" +
    "   The Python package's own test holds B to 1e-4 with ITS resampler; the TS port holds its runtime to 5e-3 on A.",
);
