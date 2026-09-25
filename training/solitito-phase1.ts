/**
 * Is greblus/solitito-ai a note-BOUNDARY witness at all? Phase 1 of the brief
 * that asked, answered from the model's own source and DSP kernel, so the
 * stop-or-go fact can be checked without its weights.
 *
 * The question (2026-09-25): the recognizer's remaining errors are about note
 * boundaries — one played note emitted as two (`measure-splits.ts`), Notes with
 * no label behind them (`npm run eval`'s extras), sixteenths at 140bpm the
 * tracker absorbs (`measure-downstream-ledger.ts --all`). Does a published
 * 7.4M-parameter guitar model (CNN + Transformer, ONNX, trained on GuitarSet and
 * NAM-rendered synthetic takes) carry boundary information the engine's
 * witnesses lack? The brief fixed its deciding fact before anything was run:
 * what does the model output over time — (a) onset activations, (b) per-frame
 * pitch including "no note", or (c) one label per clip — and at what
 * resolution. A sixteenth at 140bpm is 107ms; a model that cannot resolve
 * 107ms cannot witness these boundaries. If the answer is (c), or coarser than
 * about 50ms, the line stops at Phase 1 and nothing is measured on the corpus.
 *
 * What this reads, all pinned (SHA-256 checked below):
 *   - the model repository's README (huggingface.co, revision 96f63770…),
 *   - `dsp_weights.json`, the app's sparse pseudo-CQT kernel (same revision;
 *     byte-identical to the copy in the source repository),
 *   - the source repository github.com/greblus/solitito at 57a433d…:
 *     `dist/model_trainer.py` (features, targets, heads, architecture),
 *     `src/audio.rs` (the app's framing), `src/main.rs` (its inference cadence).
 * The two ONNX files are NOT read: their bytes are served from
 * us.aws.cdn.hf.co, which this environment's egress policy refused (403) on
 * 2026-09-25. Nothing below needs them — every number here is a property of
 * the design, fixed before any weight was trained.
 *
 * What it prints:
 *   1. The constants that set the model's time axis, read from the source by
 *      pattern and asserted, with the lines that define each head's TARGET, so
 *      a drift in the pinned files fails loudly instead of printing stale
 *      numbers.
 *   2. What each head is trained to answer, in milliseconds.
 *   3. The parameter count, from the architecture in the trainer, against the
 *      two ONNX files' published sizes and this repository's 25,000 cap.
 *   4. The time support of the app's CQT bins, reconstructed from
 *      `dsp_weights.json`. Each bin is the inner product of the LAST 8192
 *      samples (512ms at 16kHz) under a Hann window with a complex filter
 *      centred in that chunk (`gen_weights.py` pads it to the middle), so every
 *      bin reads audio centred about 256ms before the newest sample and as
 *      wide as its own filter. The training side (`librosa.cqt`, centred
 *      frames) uses the same filters untruncated; its length is inferred from
 *      the Q the untruncated bins show.
 *   5. The verdict against the brief's 50ms and 107ms bars.
 *
 * WHAT WOULD HAVE LET IT THROUGH, stated before running: an output series
 * whose target is defined per frame at 50ms or finer — an onset activation
 * trained against a label of about one frame, or a frame-level pitch that
 * includes "no note". A window-level answer, or an onset target coarser than
 * 50ms, stops the line.
 *
 * Usage (fetch once, then run offline; no network is touched by the script):
 *   R=96f63770aea422a5aa2cf6dc775f0375f5866ef4
 *   mkdir -p <dir>/hf
 *   for f in README.md dsp_weights.json; do
 *     curl -sSL -o <dir>/hf/$f "https://huggingface.co/greblus/solitito-ai/resolve/$R/$f"; done
 *   git clone https://github.com/greblus/solitito.git <dir>/src
 *   git -C <dir>/src checkout 57a433db6c945d71f70037e9c9dd08b2865ef848
 *   npx tsx training/solitito-phase1.ts --dir <dir>
 *   npx tsx training/solitito-phase1.ts --dir <dir> --all-bins   # every CQT bin
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const dir = arg("dir");
if (!dir) {
  console.error("usage: npx tsx training/solitito-phase1.ts --dir <dir>  (see the header)");
  process.exit(2);
}
const allBins = process.argv.includes("--all-bins");

// ---------------------------------------------------------------------------
// Pinned inputs
// ---------------------------------------------------------------------------

const HF_REVISION = "96f63770aea422a5aa2cf6dc775f0375f5866ef4";
const SRC_COMMIT = "57a433db6c945d71f70037e9c9dd08b2865ef848";

const PINNED: Record<string, string> = {
  "hf/README.md": "97bdfdef0e21fd8764d4055cb12001cd8d29aa9ccbb53628cef1431c5f67088c",
  "hf/dsp_weights.json": "26fd0135195a4e55cf2791f4d9e6275f1ba2dc36e1b0d2d5121836ca4633a823",
  "src/dist/model_trainer.py": "6ea36afb9e98bd653c45e4228a22f80595fa67301ecacbb7c3f2d05c7215ced6",
  "src/src/audio.rs": "242fa480e3b89947d677ab353d986c71098c97fc079edc5af8779e9947b340e7",
};

/** Published sizes of the two ONNX files (the hub's `x-linked-size`). */
const ONNX_BYTES = {
  threeHead: 29_291_803, // best_model_v2_take6.onnx
  fourHead: 29_922_576, // best_model_v2_take6_onset.onnx
};

const read = (rel: string): string => readFileSync(join(dir, rel), "utf8");

let drift = 0;
for (const [rel, want] of Object.entries(PINNED)) {
  const got = createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex");
  if (got !== want) {
    console.error(`DRIFT ${rel}: sha256 ${got}, pinned ${want}`);
    drift++;
  }
}
if (drift > 0) {
  console.error("Inputs are not the pinned files; every number below would be about something else.");
  process.exit(1);
}

const trainer = read("src/dist/model_trainer.py");
const audioRs = read("src/src/audio.rs");
const mainRs = read("src/src/main.rs");

function pyConst(name: string): string {
  const m = new RegExp(`^${name}\\s*=\\s*([^#\\n]+)`, "m").exec(trainer);
  if (!m?.[1]) throw new Error(`model_trainer.py: ${name} not found`);
  return m[1].trim();
}
function rsConst(name: string): number {
  const m = new RegExp(`pub const ${name}: \\w+ = (\\d+);`).exec(audioRs);
  if (!m?.[1]) throw new Error(`audio.rs: ${name} not found`);
  return Number(m[1]);
}
function mustContain(text: string, what: string, file: string): void {
  if (!text.includes(what)) throw new Error(`${file}: expected to find \`${what}\``);
}

// ---------------------------------------------------------------------------
// 1. The time axis, read from the source
// ---------------------------------------------------------------------------

const SR = Number(pyConst("SR"));
const HOP = Number(pyConst("HOP_LENGTH"));
const CTX = Number(pyConst("CTX_FRAMES"));
const N_BINS = Number(pyConst("N_BINS"));
const BPO = Number(pyConst("BINS_PER_OCTAVE"));
const FEATURES = Number(pyConst("INPUT_FEATURES"));
const COVER = Number(pyConst("NOTE_MIN_COVER"));
const ONSET_FRAMES = Number(pyConst("ONSET_FRAMES"));
const ONSET_LOOKBACK = Number(pyConst("ONSET_LOOKBACK"));
const ONSET_SOLO_ONLY = pyConst("ONSET_SOLO_ONLY");
const FFT = rsConst("FFT_SIZE");

if (rsConst("TARGET_SR") !== SR || rsConst("HOP_LENGTH") !== HOP || rsConst("CTX_FRAMES") !== CTX) {
  throw new Error("audio.rs and model_trainer.py disagree on the time axis");
}

// The lines that DEFINE what each head answers, asserted verbatim.
mustContain(trainer, "cqt     = librosa.cqt(y, sr=SR, hop_length=HOP_LENGTH,", "model_trainer.py");
mustContain(trainer, "pitch_vec = (win.mean(axis=0) >= NOTE_MIN_COVER).astype(np.float32)", "model_trainer.py");
mustContain(trainer, "lo = i + CTX_FRAMES - ONSET_FRAMES", "model_trainer.py");
mustContain(trainer, "hi = i + CTX_FRAMES", "model_trainer.py");
mustContain(trainer, "emb    = seq[:, 0]", "model_trainer.py");
mustContain(trainer, "return (self.fc_root(emb), self.fc_quality(emb), self.fc_pitch(emb),", "model_trainer.py");
mustContain(trainer, "before = seq[:, -1 - ONSET_LOOKBACK]", "model_trainer.py");
mustContain(trainer, "raw_before = x[:, -1 - ONSET_LOOKBACK]", "model_trainer.py");
mustContain(audioRs, "let chunk = &resampled[resampled.len() - FFT_SIZE..];", "audio.rs");
mustContain(audioRs, ".map(|i| 0.5 * (1.0 - (2.0 * PI * i as f32 / (FFT_SIZE - 1) as f32).cos()))", "audio.rs");
mustContain(mainRs, "the model is asked every 40 ms", "main.rs");

const ms = (samples: number): number => (1000 * samples) / SR;
const hopMs = ms(HOP);

console.log(`greblus/solitito-ai @ ${HF_REVISION.slice(0, 8)}, source github.com/greblus/solitito @ ${SRC_COMMIT.slice(0, 7)}`);
console.log("");
console.log("1. The time axis (read from the source, asserted)");
console.log(`   sample rate ${SR}Hz, hop ${HOP} samples = ${hopMs}ms, context ${CTX} frames = ${CTX * hopMs}ms`);
console.log(`   input ${CTX} x ${FEATURES}: ${N_BINS} CQT bins (${BPO}/octave from C1) + 12 chroma + 12 bass energy`);
console.log(`   training features: librosa.cqt, centred frames, each bin its own Hann filter`);
console.log(`   app features: the LAST ${FFT} samples (${ms(FFT)}ms) under a Hann window, FFT, sparse pseudo-CQT kernel`);
console.log(`   app inference: one forward pass every 40ms, over the newest ${CTX} frames`);

// ---------------------------------------------------------------------------
// 2. What each head is trained to answer
// ---------------------------------------------------------------------------

console.log("");
console.log("2. What each head answers (its training target)");
console.log(`   root / quality / pitch: read off the CLS token — ONE answer for the whole ${CTX * hopMs}ms window`);
console.log(
  `   pitch target: a class is "sounding" if it sounds for >= ${COVER} of the window ` +
    `(${Math.round(COVER * CTX)} frames = ${COVER * CTX * hopMs}ms of ${CTX * hopMs}ms)`,
);
console.log(
  `   onset target: a class was STRUCK inside the last ${ONSET_FRAMES} frames = ${ONSET_FRAMES * hopMs}ms ` +
    `(trained on solo recordings only: ${ONSET_SOLO_ONLY})`,
);
console.log(
  `   onset input: the newest frame's token and raw spectrum against those ${ONSET_LOOKBACK} frames ` +
    `(${ONSET_LOOKBACK * hopMs}ms) earlier`,
);
console.log("   no head has an octave: pitch and onset are 12 pitch classes, root is 12 classes + Noise");

// ---------------------------------------------------------------------------
// 3. Parameter count, from the architecture in the trainer
// ---------------------------------------------------------------------------

for (const s of [
  "def __init__(self, c, r=16):",
  "nn.Conv2d(i, o, 3, padding=1, bias=False),",
  "nn.GroupNorm(8, o), nn.GELU(),",
  "ConvBlockSE(1,   48,",
  "ConvBlockSE(48,  96,",
  "ConvBlockSE(96,  192,",
  "ConvBlockSE(192, 384,",
  "self.proj = nn.Linear(3840, 384)",
  "d_model=384, nhead=8, dim_feedforward=768,",
  "self.tr       = nn.TransformerEncoder(layer, num_layers=4)",
  "nn.LayerNorm(384), nn.Dropout(DROPOUT_RATE * 0.5), nn.Linear(384, 13)",
  "nn.Linear(384, 192), nn.GELU(), nn.Dropout(DROPOUT_RATE),",
  "nn.Linear(192, 96),  nn.GELU(), nn.Dropout(DROPOUT_RATE * 0.5),",
  "nn.Linear(384, 128), nn.GELU(), nn.Dropout(DROPOUT_RATE),",
  "nn.Linear(128, 64),  nn.GELU(), nn.Dropout(DROPOUT_RATE * 0.5),",
  "nn.LayerNorm(792),",
  "nn.Linear(792, 192), nn.GELU(), nn.Dropout(DROPOUT_RATE * 0.5),",
]) {
  mustContain(trainer, s, "model_trainer.py");
}
const qualities = /^QUALITIES\s*=\s*\[([^\]]*)\]/m.exec(trainer)?.[1]?.split(",").filter((q) => q.trim()).length;
if (qualities !== 11) throw new Error(`QUALITIES has ${qualities} entries, expected 11`);

const linear = (i: number, o: number): number => i * o + o;
const layerNorm = (d: number): number => 2 * d;
const convSe = (i: number, o: number): number => i * o * 9 + 2 * o + 2 * o * Math.floor(o / 16);
const trunk =
  2 + // InstanceNorm2d(1, affine=True)
  convSe(1, 48) + convSe(48, 96) + convSe(96, 192) + convSe(192, 384) +
  linear(3840, 384) + // 384 channels x 10 frequency cells after four (1,2) pools of 168
  384 + (CTX + 1) * 384 + // CLS token, positional table
  4 * (linear(384, 3 * 384) + linear(384, 384) + linear(384, 768) + linear(768, 384) + 2 * layerNorm(384));
const heads3 =
  layerNorm(384) + linear(384, 13) +
  layerNorm(384) + linear(384, 192) + linear(192, 96) + linear(96, qualities) +
  layerNorm(384) + linear(384, 128) + linear(128, 64) + linear(64, 12);
const onsetHead = layerNorm(792) + linear(792, 192) + linear(192, 12);
const threeHead = trunk + heads3;
const fourHead = threeHead + onsetHead;

console.log("");
console.log("3. Parameters (from the architecture; the weights themselves were not fetched)");
console.log(`   three heads ${threeHead.toLocaleString("en-US")}, with the onset head ${fourHead.toLocaleString("en-US")}`);
console.log(
  `   float32 bytes ${(4 * threeHead).toLocaleString("en-US")} / ${(4 * fourHead).toLocaleString("en-US")} ` +
    `against the published ONNX sizes ${ONNX_BYTES.threeHead.toLocaleString("en-US")} / ` +
    `${ONNX_BYTES.fourHead.toLocaleString("en-US")}`,
);
console.log(
  `   the two files differ by ${(ONNX_BYTES.fourHead - ONNX_BYTES.threeHead).toLocaleString("en-US")} bytes; ` +
    `the onset head is ${onsetHead.toLocaleString("en-US")} parameters = ${(4 * onsetHead).toLocaleString("en-US")} bytes`,
);
console.log(`   ${(fourHead / 25_000).toFixed(0)}x this repository's shipping cap of 25,000 (AGENTS.md section 4)`);

// ---------------------------------------------------------------------------
// 4. Time support of the app's CQT bins, reconstructed from the kernel
// ---------------------------------------------------------------------------

type Kernel = {
  format: string;
  fft_size: number;
  sr: number;
  n_bins: number;
  cqt_offsets: number[];
  cqt_fft_idx: number[];
  cqt_re: number[];
  cqt_im: number[];
};
const kernel = JSON.parse(read("hf/dsp_weights.json")) as Kernel;
if (kernel.format !== "sparse-csr-v1" || kernel.fft_size !== FFT || kernel.sr !== SR || kernel.n_bins !== N_BINS) {
  throw new Error("dsp_weights.json does not describe the front end the source declares");
}

/** In-place iterative radix-2 complex FFT; `inverse` conjugates the twiddles and scales by 1/n. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
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
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1;
      let cIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tRe = (re[b] as number) * cRe - (im[b] as number) * cIm;
        const tIm = (re[b] as number) * cIm + (im[b] as number) * cRe;
        re[b] = (re[a] as number) - tRe;
        im[b] = (im[a] as number) - tIm;
        re[a] = (re[a] as number) + tRe;
        im[a] = (im[a] as number) + tIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = (re[i] as number) / n;
      im[i] = (im[i] as number) / n;
    }
  }
}

/** Full width at half maximum, in samples, of a non-negative envelope. */
function fwhm(env: Float64Array): number {
  let peak = 0;
  for (const v of env) peak = Math.max(peak, v);
  let first = -1;
  let last = -1;
  for (let n = 0; n < env.length; n++) {
    if ((env[n] as number) >= peak / 2) {
      if (first < 0) first = n;
      last = n;
    }
  }
  return last - first + 1;
}

const hann = new Float64Array(FFT);
for (let n = 0; n < FFT; n++) hann[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (FFT - 1)));

type BinTime = {
  bin: number;
  hz: number;
  filterFwhmMs: number; // the filter's own envelope; half its length, for a Hann filter
  truncated: boolean; // the filter fills the 8192-sample chunk (the app cut it there)
  appFwhmMs: number; // after the app's Hann(8192) analysis window
  lagMs: number; // energy centre behind the newest sample of the chunk
  peakBinError: number; // |argmax_k kernel| against the bin's centre frequency, in FFT bins
};

const fminHz = 440 * 2 ** ((24 - 69) / 12); // C1
const bins: BinTime[] = [];
for (let b = 0; b < N_BINS; b++) {
  const re = new Float64Array(FFT);
  const im = new Float64Array(FFT);
  let peakK = 0;
  let peakMag = 0;
  const from = kernel.cqt_offsets[b] as number;
  const to = kernel.cqt_offsets[b + 1] as number;
  for (let j = from; j < to; j++) {
    const k = kernel.cqt_fft_idx[j] as number;
    // gen_weights.py stores conj(FFT(filter)); the filter's spectrum is its conjugate.
    re[k] = kernel.cqt_re[j] as number;
    im[k] = -(kernel.cqt_im[j] as number);
    const mag = Math.hypot(re[k] as number, im[k] as number);
    if (mag > peakMag) {
      peakMag = mag;
      peakK = k;
    }
  }
  fft(re, im, true);
  const own = new Float64Array(FFT);
  const app = new Float64Array(FFT);
  let e2 = 0;
  let ne2 = 0;
  for (let n = 0; n < FFT; n++) {
    own[n] = Math.hypot(re[n] as number, im[n] as number);
    app[n] = (own[n] as number) * (hann[n] as number);
    const p = (app[n] as number) ** 2;
    e2 += p;
    ne2 += n * p;
  }
  const edge = Math.max(own[0] as number, own[FFT - 1] as number);
  let peak = 0;
  for (const v of own) peak = Math.max(peak, v);
  const hz = fminHz * 2 ** (b / BPO);
  bins.push({
    bin: b,
    hz,
    filterFwhmMs: ms(fwhm(own)),
    truncated: edge > 0.05 * peak,
    appFwhmMs: ms(fwhm(app)),
    lagMs: ms(FFT - 1 - ne2 / e2),
    peakBinError: Math.abs(peakK - (hz * FFT) / SR),
  });
}

// Q from the bins whose Hann filter fits inside the chunk: length = 2 x FWHM.
const untruncated = bins.filter((b) => !b.truncated && b.hz >= 100);
const qs = untruncated.map((b) => (2 * b.filterFwhmMs * b.hz) / 1000).sort((a, b) => a - b);
const q = qs[Math.floor(qs.length / 2)] as number;
const trainingLenMs = (hz: number): number => (1000 * q) / hz;

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const nameOf = (b: number): string => {
  const midi = 24 + Math.floor(b / 2);
  return `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}${b % 2 ? "+50c" : ""}`;
};
// The six open strings, then up the neck to the 24th fret of the high E, then the top bin.
const SHOWN = [32, 42, 52, 62, 70, 80, 90, 104, 114, 128, 143];

console.log("");
console.log("4. Time support of the CQT bins (app kernel reconstructed from dsp_weights.json)");
console.log(`   Q = ${q.toFixed(1)} (median over ${untruncated.length} bins whose filter fits the chunk)`);
console.log("   bin  note      Hz     training filter   app window FWHM   app centre behind newest sample");
for (const b of bins) {
  if (!allBins && !SHOWN.includes(b.bin)) continue;
  const train = trainingLenMs(b.hz);
  const trainCol = `${train.toFixed(0)}ms (FWHM ${(train / 2).toFixed(0)})`;
  console.log(
    `   ${String(b.bin).padStart(3)}  ${nameOf(b.bin).padEnd(8)} ${b.hz.toFixed(1).padStart(6)}   ` +
      `${trainCol.padEnd(18)}${`${b.appFwhmMs.toFixed(0)}ms${b.truncated ? " (cut at 512)" : ""}`.padEnd(18)}` +
      `${b.lagMs.toFixed(0)}ms`,
  );
}
const worstPeak = Math.max(...bins.map((b) => b.peakBinError));
const lags = bins.map((b) => b.lagMs);
const lagLo = Math.min(...lags).toFixed(0);
const lagHi = Math.max(...lags).toFixed(0);
console.log(
  `   all ${N_BINS} bins centred ${lagLo === lagHi ? lagLo : `${lagLo}-${lagHi}`}ms behind the newest sample; ` +
    `kernel peaks within ${worstPeak.toFixed(1)} FFT bins of each bin's frequency`,
);

// ---------------------------------------------------------------------------
// 5. The verdict
// ---------------------------------------------------------------------------

const SIXTEENTH_140 = 60000 / 140 / 4;
const BAR = 50;
const rows: Array<[string, number]> = [
  ["feature hop", hopMs],
  ["root / quality / pitch answer (one per window)", CTX * hopMs],
  ["pitch target: least a class must sound to be labelled", COVER * CTX * hopMs],
  ["onset target: struck within", ONSET_FRAMES * hopMs],
  ["onset head's comparison lookback", ONSET_LOOKBACK * hopMs],
  ["app frame (every bin reads inside it)", ms(FFT)],
  ["app bin centre behind the newest sample", Math.max(...lags)],
];
console.log("");
console.log(`5. Against the brief's bars: ${BAR}ms, and the 140bpm sixteenth, ${SIXTEENTH_140.toFixed(0)}ms`);
for (const [what, v] of rows) {
  const verdict = v <= BAR ? "fine enough" : v < SIXTEENTH_140 ? "coarser than 50ms" : "coarser than a sixteenth";
  console.log(`   ${what.padEnd(56)} ${`${v.toFixed(0)}ms`.padStart(6)}   ${verdict}`);
}
console.log("");
console.log(
  "   DECIDING FACT: (c). Every forward pass returns one answer about its whole window; the finest target any\n" +
    `   head is trained on is the onset head's ${ONSET_FRAMES * hopMs}ms bin, coarser than ${BAR}ms and within one hop of the\n` +
    `   ${SIXTEENTH_140.toFixed(0)}ms sixteenth. The brief's Phase 1 rule stops the line here; nothing is measured on the corpus.`,
);
