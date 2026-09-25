/**
 * Is spotify/basic-pitch a note-BOUNDARY witness at all? Phase 1 of the brief
 * `docs/external-models-eval-prompt.md`, answered from the model's own source,
 * its training-target code and its published weight file, at pinned revisions.
 *
 * The question (2026-09-25): the recognizer's remaining errors are about note
 * boundaries — one played note emitted as two (`measure-splits.ts`), Notes with
 * no label behind them (`npm run eval`'s extras), sixteenths at 140bpm the
 * tracker absorbs (`measure-downstream-ledger.ts --all`). Does a published
 * transcription model carry boundary information the engine's witnesses lack?
 * The brief fixed its deciding fact before anything was run: what does the
 * model output over time — (a) onset activations, (b) per-frame pitch including
 * "no note", or (c) one label per clip — and at what TARGET resolution, and
 * does it answer promptly. A sixteenth at 140bpm is 107ms; (c), or a target
 * coarser than about 50ms, stops the line here.
 *
 * What this reads, all pinned (SHA-256 checked below):
 *   - huggingface.co/spotify/basic-pitch @ 3cf4f083… : README.md (the card:
 *     licence, dataset tags). The revision holds nothing else but
 *     .gitattributes; code and weights live on GitHub.
 *   - github.com/spotify/basic-pitch @ fa5997a… (2025-11-13):
 *       basic_pitch/constants.py      the time axis
 *       basic_pitch/models.py         the architecture and the CQT's parameters
 *       basic_pitch/layers/nnaudio.py the CQT (filter lengths, decimation, padding)
 *       basic_pitch/layers/signal.py  the per-window log normalisation
 *       basic_pitch/nn.py             harmonic stacking
 *       basic_pitch/inference.py      the package's windowing and output names
 *       basic_pitch/note_creation.py  its note decoding defaults
 *       basic_pitch/data/datasets/guitarset.py      how targets are built
 *       basic_pitch/data/tf_example_deserialization.py  how they are windowed
 *       basic_pitch/train.py          the loss the trainer uses
 *       basic_pitch/saved_models/icassp_2022/nmp.onnx   the weights (a git blob)
 *   - github.com/mir-dataset-loaders/mirdata @ 4e187c2 (tag 1.0.0; the pinned
 *     package asks for mirdata>=1.0.0 and `annotations.py` is unchanged from
 *     1.0.0 to HEAD 11e11d5): `NoteData.to_sparse_index` and `closest_index`,
 *     which turn annotations into the onset, note and contour targets.
 *
 * What it prints:
 *   1. The time axis, read from the source by pattern and asserted.
 *   2. What each output is trained to answer: the target code, quoted and
 *      asserted, and its resolution in ms.
 *   3. The architecture and the temporal receptive field of each output, read
 *      from the ONNX graph's convolutions.
 *   4. The CQT's filter spans, from the source's formula, checked against the
 *      kernel taps stored in the ONNX file, at the guitar's strings.
 *   5. The parameter count from the ONNX initializers, learned against fixed.
 *   6. The verdict against the brief's 50ms and 107ms bars.
 *
 * WHAT WOULD HAVE STOPPED IT, stated before running: an output whose target is
 * one label per clip or window, or an onset/note target wider than about 50ms
 * (a dilated or smoothed onset label, a note target at a coarser grid). A
 * receptive field that reaches past 107ms is NOT by itself a stop — it is
 * look-ahead, which the fast lane cannot have and the deep lane can wait for —
 * but it is measured (`probe.ts`) and carried into Phase 2 as a cost.
 *
 * Usage (fetch once, then run offline; no network is touched by the script):
 *   D=training/out/basic-pitch
 *   mkdir -p $D/hf
 *   curl -sSL -o $D/hf/README.md \
 *     https://huggingface.co/spotify/basic-pitch/resolve/3cf4f083a240dc327d9cd30a3d542424b029b11b/README.md
 *   git clone https://github.com/spotify/basic-pitch.git $D/src
 *   git -C $D/src checkout fa5997af0a8210982619003269994a1be25eddf3
 *   git clone https://github.com/mir-dataset-loaders/mirdata.git $D/mirdata
 *   git -C $D/mirdata checkout 4e187c25b005da9af099ee41821d213a5c90de1f
 *   git clone https://github.com/spotify/basic-pitch-ts.git $D/ts      # parity.ts only
 *   git -C $D/ts checkout 2d498f82b61c71898edf0e8dd661b99076676c8b
 *   git -C $D/ts sparse-checkout set test_data model   # keep its .ts out of the root typecheck
 *   npx tsx training/basic-pitch/phase1.ts --dir $D
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOnnx, type OnnxNode } from "./onnx-proto.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const dir = arg("dir");
if (!dir) {
  console.error("usage: npx tsx training/basic-pitch/phase1.ts --dir <dir>  (see the header)");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Pinned inputs
// ---------------------------------------------------------------------------

export const HF_REVISION = "3cf4f083a240dc327d9cd30a3d542424b029b11b";
export const SRC_COMMIT = "fa5997af0a8210982619003269994a1be25eddf3";
export const MIRDATA_COMMIT = "4e187c25b005da9af099ee41821d213a5c90de1f";

const PINNED: Record<string, string> = {
  "hf/README.md": "a235691fab6058646eec2b69db460183970ad9852d355bf60644abe09202ce5e",
  "src/LICENSE": "929c910bae2152fa87199a5d0660e09263419b7eee6d4b301d05ee2aaf211c37",
  "src/basic_pitch/constants.py": "4dab8b61240dbf3320bc4983b9a215d93254df84caf19adef3859d1390189181",
  "src/basic_pitch/models.py": "8975d96b7173137b5e0f49177568ed470c026f84bffe52beccbc5f62eb7355be",
  "src/basic_pitch/layers/nnaudio.py": "8eadb36b74328e9c4826520e133371be6913bd7bd9ce02524ba0218f2ea1219a",
  "src/basic_pitch/layers/signal.py": "ecd0846053b6316d0cc851ae258c1e02ab282212b327610a86da19be117a47b4",
  "src/basic_pitch/nn.py": "6e13385fd00ff553c7c9de0533a760f006dc5c0d6240ada05f09153eeea5eb9b",
  "src/basic_pitch/inference.py": "b85aeaa13d421861378d8bd5e841d9087cecd3dc4bfd15abc1f40c1ea2b8abc9",
  "src/basic_pitch/note_creation.py": "83346193f834edfc37aeadbed91a4092b574727dd2b4535e03e5ad89d2e89506",
  "src/basic_pitch/data/datasets/guitarset.py": "cd62e8e04f5d37100a6b16c6b43669a82a4f1ce70f3222f54c39a8462590fb09",
  "src/basic_pitch/data/tf_example_deserialization.py":
    "b7adda1d80b584809a0f27f5b71db4f215fe93b0a24eb30d1995be10ad4fbd0c",
  "src/basic_pitch/train.py": "4da6522115a8eb7b15f0e1f959310b8f295c4bc7a0fd3c7e6675114a837c6717",
  "src/basic_pitch/saved_models/icassp_2022/nmp.onnx": "2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec",
  "mirdata/mirdata/annotations.py": "2a0d0493579cb1c28b2a33ba31797f574bf3ca37de35236100c416dacafb6cc5",
};

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

const read = (rel: string): string => readFileSync(join(dir, rel), "utf8");
const card = read("hf/README.md");
const constants = read("src/basic_pitch/constants.py");
const models = read("src/basic_pitch/models.py");
const nnaudio = read("src/basic_pitch/layers/nnaudio.py");
const signal = read("src/basic_pitch/layers/signal.py");
const nn = read("src/basic_pitch/nn.py");
const inference = read("src/basic_pitch/inference.py");
const noteCreation = read("src/basic_pitch/note_creation.py");
const guitarset = read("src/basic_pitch/data/datasets/guitarset.py");
const deser = read("src/basic_pitch/data/tf_example_deserialization.py");
const train = read("src/basic_pitch/train.py");
const annotations = read("mirdata/mirdata/annotations.py");

function mustContain(text: string, what: string, file: string): void {
  if (!text.includes(what)) throw new Error(`${file}: expected to find \`${what}\``);
}
function pyConst(text: string, name: string, file: string): string {
  const m = new RegExp(`^${name}\\s*=\\s*([^#\\n]+)`, "m").exec(text);
  if (!m?.[1]) throw new Error(`${file}: ${name} not found`);
  return m[1].trim();
}
const num = (text: string, name: string, file: string): number => {
  const v = Number(pyConst(text, name, file));
  if (!Number.isFinite(v)) throw new Error(`${file}: ${name} is not a number`);
  return v;
};

// ---------------------------------------------------------------------------
// 1. The time axis
// ---------------------------------------------------------------------------

const SR = num(constants, "AUDIO_SAMPLE_RATE", "constants.py");
const FFT_HOP = num(constants, "FFT_HOP", "constants.py");
const WINDOW_S = num(constants, "AUDIO_WINDOW_LENGTH", "constants.py");
const BASE_HZ = num(constants, "ANNOTATIONS_BASE_FREQUENCY", "constants.py");
const N_SEMITONES = num(constants, "ANNOTATIONS_N_SEMITONES", "constants.py");
const CONTOUR_BPS = num(constants, "CONTOURS_BINS_PER_SEMITONE", "constants.py");
mustContain(constants, "ANNOTATIONS_FPS = AUDIO_SAMPLE_RATE // FFT_HOP", "constants.py");
mustContain(constants, "ANNOT_N_FRAMES = ANNOTATIONS_FPS * AUDIO_WINDOW_LENGTH", "constants.py");
mustContain(constants, "AUDIO_N_SAMPLES = AUDIO_SAMPLE_RATE * AUDIO_WINDOW_LENGTH - FFT_HOP", "constants.py");
const FPS = Math.floor(SR / FFT_HOP); // integer division, as the source does
const N_FRAMES = FPS * WINDOW_S;
const N_SAMPLES = SR * WINDOW_S - FFT_HOP;
const OVERLAP_FRAMES = num(inference, "DEFAULT_OVERLAPPING_FRAMES", "inference.py");
mustContain(inference, "overlap_len = n_overlapping_frames * FFT_HOP", "inference.py");
mustContain(inference, "hop_size = AUDIO_N_SAMPLES - overlap_len", "inference.py");
mustContain(inference, "n_olap = int(0.5 * n_overlapping_frames)", "inference.py");
mustContain(inference, "output = output[:, n_olap:-n_olap, :]", "inference.py");
mustContain(
  inference,
  "audio_original = np.concatenate([np.zeros((int(overlap_len / 2),), dtype=np.float32), audio_original])",
  "inference.py",
);
const MIN_NOTE_MS = num(inference, "DEFAULT_MINIMUM_NOTE_LENGTH_MS", "inference.py");
const ENERGY_TOL = num(noteCreation, "ENERGY_TOLERANCE", "note_creation.py");

const ms = (samples: number): number => (1000 * samples) / SR;
const hopMs = ms(FFT_HOP);
const targetHopMs = 1000 / FPS;

console.log(`spotify/basic-pitch @ ${HF_REVISION.slice(0, 8)} (card), source github.com/spotify/basic-pitch @ ${SRC_COMMIT.slice(0, 7)}`);
console.log("");
console.log("1. The time axis (read from the source, asserted)");
console.log(`   sample rate ${SR}Hz, hop ${FFT_HOP} samples = ${hopMs.toFixed(2)}ms; targets at ${FPS} frames/s = ${targetHopMs.toFixed(2)}ms`);
console.log(`   one model call: ${N_SAMPLES} samples = ${ms(N_SAMPLES).toFixed(0)}ms in, ${N_FRAMES} frames out (every frame answered at once)`);
console.log(
  `   the package's windowing: ${OVERLAP_FRAMES} frames of overlap, ${OVERLAP_FRAMES / 2} trimmed from each end of each window ` +
    `(${(OVERLAP_FRAMES / 2 * hopMs).toFixed(0)}ms), hop ${N_SAMPLES - OVERLAP_FRAMES * FFT_HOP} samples = ` +
    `${ms(N_SAMPLES - OVERLAP_FRAMES * FFT_HOP).toFixed(0)}ms`,
);
console.log(
  `   its note decoding (not used here): minimum note ${MIN_NOTE_MS}ms, a note ends ${ENERGY_TOL} frames ` +
    `(${(ENERGY_TOL * hopMs).toFixed(0)}ms) after its frames fall under threshold`,
);

// ---------------------------------------------------------------------------
// 2. What each output is trained to answer
// ---------------------------------------------------------------------------

// guitarset.py: the three targets, on a grid of ANNOTATION_HOP = 1/86 s.
mustContain(guitarset, "time_scale = np.arange(0, duration + ANNOTATION_HOP, ANNOTATION_HOP)", "guitarset.py");
mustContain(guitarset, 'note_indices, note_values = track_local.notes_all.to_sparse_index(', "guitarset.py");
mustContain(guitarset, 'onset_indices, onset_values = track_local.notes_all.to_sparse_index(', "guitarset.py");
mustContain(guitarset, 'time_scale, "s", FREQ_BINS_NOTES, "hz", onsets_only=True', "guitarset.py");
mustContain(guitarset, 'contour_indices, contour_values = track_local.multif0.to_sparse_index(', "guitarset.py");
mustContain(guitarset, "tfm.build(track_local.audio_mic_path, local_wav_path)", "guitarset.py");
// mirdata: the onset target is ONE cell, the frame nearest the onset; the note
// target runs from the frame nearest the onset to the frame nearest the offset.
mustContain(annotations, "time_index_0 = closest_index(", "annotations.py");
mustContain(annotations, "onset_index.append([t0, f])", "annotations.py");
mustContain(annotations, "sparse_index.extend([[t, f] for t in range(t_start, t_end)])", "annotations.py");
mustContain(annotations, "t_end = (t1 if t1 != -1 else max_idx) + 1", "annotations.py");
mustContain(
  annotations,
  "indexes = np.argmin(scipy.spatial.distance.cdist(input_array, target_array), axis=1)",
  "annotations.py",
);
mustContain(annotations, 'kind="nearest",', "annotations.py"); // contour resampling
// The windowing of targets and audio is the same crop; nothing widens a label.
mustContain(deser, "onset_trim = trim_time(onsets, t_start, AUDIO_WINDOW_LENGTH, ANNOTATIONS_FPS)", "tf_example_deserialization.py");
mustContain(deser, '"onset": tf.ensure_shape(onsets, (ANNOT_N_FRAMES, N_FREQ_BINS_NOTES)),', "tf_example_deserialization.py");
// The loss: binary cross-entropy per cell with label smoothing (a squeeze of
// the VALUE towards 0.5, not a spread in time).
const SMOOTHING = num(models, "DEFAULT_LABEL_SMOOTHING", "models.py");
mustContain(models, "bce = tf.keras.losses.binary_crossentropy(y_true, y_pred, label_smoothing=label_smoothing)", "models.py");
mustContain(train, "loss = models.loss(weighted=weighted_onset_loss, positive_weight=positive_onset_weight)", "train.py");
// Nothing dilates or blurs a target in time: no convolution, max-pool or
// dilation touches the label tensors anywhere in the data pipeline.
for (const [text, file] of [
  [deser, "tf_example_deserialization.py"],
  [guitarset, "guitarset.py"],
] as const) {
  for (const forbidden of ["dilation", "gaussian_filter", "max_pool", "convolve"]) {
    if (text.includes(forbidden)) throw new Error(`${file}: \`${forbidden}\` appears; a target may be widened`);
  }
}

console.log("");
console.log("2. What each output is trained to answer (its TARGET)");
console.log(
  `   onset   (88 notes, A0..C8): 1 in the ONE frame nearest each annotated onset, else 0 — ${targetHopMs.toFixed(1)}ms wide, ` +
    `placed within +-${(targetHopMs / 2).toFixed(1)}ms`,
);
console.log(
  `   note    (88 notes): 1 on every frame from the frame nearest the onset to the frame nearest the offset, 0 elsewhere — ` +
    `"no note" is all zeros; both edges at +-${(targetHopMs / 2).toFixed(1)}ms`,
);
console.log(
  `   contour (${N_SEMITONES * CONTOUR_BPS} bins, 1/${CONTOUR_BPS} semitone): the annotated f0s, resampled to the ${FPS}fps grid by nearest neighbour`,
);
console.log(
  `   loss: binary cross-entropy per cell, label smoothing ${SMOOTHING} (a value squeeze to ${(SMOOTHING / 2).toFixed(1)}/${(1 - SMOOTHING / 2).toFixed(1)}, ` +
    "not a spread in time); no target is dilated, pooled or blurred",
);
console.log("   GuitarSet targets are built on its MIC recordings (audio_mic_path), all six strings' notes together");

// ---------------------------------------------------------------------------
// 3. Architecture and receptive field, from the ONNX graph
// ---------------------------------------------------------------------------

const onnxBytes = new Uint8Array(readFileSync(join(dir, "src/basic_pitch/saved_models/icassp_2022/nmp.onnx")));
const graph = parseOnnx(onnxBytes);
const init = new Map(graph.initializers.map((t) => [t.name, t]));
const convs = graph.nodes.filter((n) => n.opType === "Conv");
const ints = (n: OnnxNode, a: string): number[] => n.attributes.get(a)?.ints ?? [];
const weightOf = (n: OnnxNode) => {
  const w = init.get(n.inputs[1] as string);
  if (w === undefined) throw new Error(`${n.name}: weight is not an initializer`);
  return w;
};
// The CQT and decimation convolutions are 1-D over the audio (kernel 1 x 256);
// the learned ones are 2-D over (time, frequency).
const learnedConvs = convs.filter((n) => (ints(n, "kernel_shape")[0] ?? 1) > 1);
const cqtConvs = convs.filter((n) => weightOf(n).dims[0] === 36);
const decimators = convs.filter((n) => weightOf(n).dims[0] === 1 && ints(n, "kernel_shape")[1] === 256);
if (learnedConvs.length !== 6) throw new Error(`expected 6 learned convolutions, found ${learnedConvs.length}`);
if (cqtConvs.length !== 18 || decimators.length !== 8) {
  throw new Error(`expected 9 CQT octaves x (re, im) and 8 decimators, found ${cqtConvs.length} and ${decimators.length}`);
}

// Map each learned conv to its role by its weight shape (out, in, time, freq),
// as models.py declares them.
const ROLES: Array<{ role: string; shape: string; source: string }> = [
  { role: "contour 1 (8 harmonics -> 8)", shape: "8x8x3x39", source: "CONTOUR_KERNEL_SIZE_2 = (3, 39)" },
  { role: "contour 2 -> contour output", shape: "1x8x5x5", source: "CONTOUR_KERNEL_SIZE_3 = (5, 5)" },
  { role: "note 1 (contour -> 32, freq stride 3)", shape: "32x1x7x7", source: "NOTES_KERNEL_SIZE_1 = (7, 7)" },
  { role: "note 2 -> note output", shape: "1x32x7x3", source: "NOTES_KERNEL_SIZE_2 = (7, 3)" },
  { role: "onset 1 (8 harmonics -> 32, freq stride 3)", shape: "32x8x5x5", source: "ONSET_KERNEL_SIZE_1 = (5, 5)" },
  { role: "onset 2 (note 2 + onset 1 -> onset output)", shape: "1x33x3x3", source: "ONSET_KERNEL_SIZE_2 = (3, 3)" },
];
const halfT = new Map<string, number>();
for (const r of ROLES) {
  mustContain(models, r.source, "models.py");
  const n = learnedConvs.find((c) => weightOf(c).dims.join("x") === r.shape);
  if (n === undefined) throw new Error(`no convolution with weights ${r.shape} for ${r.role}`);
  const k = ints(n, "kernel_shape")[0] as number;
  const pads = ints(n, "pads");
  if (pads[0] !== (k - 1) / 2 || pads[2] !== (k - 1) / 2) throw new Error(`${r.role}: time padding is not centred`);
  halfT.set(r.shape, (k - 1) / 2);
}
mustContain(models, "# contour layers - fully convolutional - /!\\ commented out as it was unintentionally skipped", "models.py");
const h = (s: string): number => halfT.get(s) as number;
const rfContour = h("8x8x3x39") + h("1x8x5x5");
const rfNote = rfContour + h("32x1x7x7") + h("1x32x7x3");
const rfOnset = Math.max(rfNote, h("32x8x5x5")) + h("1x33x3x3");

console.log("");
console.log("3. Architecture (from the ONNX graph; batch norm folded into the convolutions by the converter)");
console.log("   front end: CQT (9 octaves by decimation, 36 bins/octave from A0 = 27.5Hz, 309 bins), magnitude,");
console.log("              log power normalised to 0..1 by the min and max over the WHOLE window, batch norm,");
console.log("              harmonic stacking of 8 shifted copies (harmonics 0.5, 1..7) -> 264 bins x 8 channels");
for (const r of ROLES) {
  const n = learnedConvs.find((c) => weightOf(c).dims.join("x") === r.shape) as OnnxNode;
  console.log(
    `   ${r.role.padEnd(44)} kernel ${ints(n, "kernel_shape").join("x").padEnd(5)} (time x freq)  ` +
      `stride ${ints(n, "strides").join("x")}  weights ${r.shape}`,
  );
}
console.log("   the model's first contour convolution (5x5, 32 filters) is commented out in models.py: the published");
console.log("   checkpoint was trained without it");
console.log(
  `   receptive field over CQT frames, centred: contour +-${rfContour}, note +-${rfNote}, onset +-${rfOnset} frames ` +
    `(+-${(rfContour * hopMs).toFixed(0)}, +-${(rfNote * hopMs).toFixed(0)}, +-${(rfOnset * hopMs).toFixed(0)}ms)`,
);

// ---------------------------------------------------------------------------
// 4. CQT filter spans, source formula against the ONNX kernel taps
// ---------------------------------------------------------------------------

mustContain(models, "bins_per_octave=12 * CONTOURS_BINS_PER_SEMITONE,", "models.py");
mustContain(models, "fmin=ANNOTATIONS_BASE_FREQUENCY,", "models.py");
mustContain(nnaudio, "Q = float(self.filter_scale) / (2 ** (1 / self.bins_per_octave) - 1)", "nnaudio.py");
mustContain(nnaudio, "filter_scale: int = 1,", "nnaudio.py");
mustContain(nnaudio, "_l = np.ceil(Q * fs / freq)", "nnaudio.py");
mustContain(nnaudio, 'DEFAULT_CQT_WINDOW = "hann"', "nnaudio.py");
mustContain(nnaudio, "self.padding = ReflectionPad1D(self.n_fft // 2)", "nnaudio.py");
mustContain(signal, "log_power_min = tf.reshape(tf.math.reduce_min(log_power, axis=[1, 2])", "signal.py");
mustContain(signal, "tf.math.reduce_max(log_power_offset, axis=[1, 2])", "signal.py");
mustContain(nn, "int(tf.math.round(SEMITONES_PER_OCTAVE * self.bins_per_semitone * log_base_b(float(h), 2)))", "nn.py");
mustContain(models, "[0.5] + list(range(1, n_harmonics)),", "models.py");

const BPO = 12 * CONTOUR_BPS;
const Q = 1 / (2 ** (1 / BPO) - 1);
const maxSemitones = Math.floor(12 * Math.log2((0.5 * SR) / BASE_HZ));
const nSemitones = Math.min(Math.ceil(12 * Math.log2(8)) + N_SEMITONES, maxSemitones);
const nBins = nSemitones * CONTOUR_BPS;
const nOctaves = Math.ceil(nBins / BPO);
const topFirst = nBins - BPO; // lowest bin of the top octave
// The top-octave kernel: row r is bin topFirst + r; octave level L (0 = top)
// applies the same row to audio decimated by 2^L.
const fminT = BASE_HZ * 2 ** (topFirst / BPO);
const rowLen = (r: number): number => Math.ceil((Q * SR) / (fminT * 2 ** (r / BPO)));
const kernelRe = init.get(cqtConvs[0]?.inputs[1] as string);
if (kernelRe?.floats == null || kernelRe.dims.join("x") !== "36x1x1x256") throw new Error("CQT kernel not found");
for (let r = 0; r < 36; r++) {
  // scipy's periodic Hann of length L has one zero tap; the rest are nonzero.
  let first = -1;
  let last = -1;
  for (let i = 0; i < 256; i++) {
    if ((kernelRe.floats[r * 256 + i] as number) !== 0) {
      if (first < 0) first = i;
      last = i;
    }
  }
  const span = last - first + 2;
  if (Math.abs(span - rowLen(r)) > 1) throw new Error(`CQT row ${r}: ${span} taps in the file, ${rowLen(r)} from the formula`);
}
const filterSamples = (bin: number): number => {
  const level = Math.ceil((topFirst - bin) / BPO);
  const row = bin - (topFirst - level * BPO);
  return rowLen(row) * 2 ** level;
};
const HARMONICS = [0.5, 1, 2, 3, 4, 5, 6, 7];
const shift = (hm: number): number => Math.round(BPO * Math.log2(hm));
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const binOfMidi = (midi: number): number => (midi - 21) * CONTOUR_BPS;
const STRINGS = [40, 45, 50, 55, 59, 64, 76]; // E2 A2 D3 G3 B3 E4, and E5 (the corpus's high same-pitch take)
console.log("");
console.log(
  `4. The CQT's filters (Q = ${Q.toFixed(2)}, Hann; length ceil(Q * sr / f); every row of the stored kernel matches the formula)`,
);
console.log(`   ${nBins} bins, ${nOctaves} octaves; lowest bin ${BASE_HZ}Hz: ${filterSamples(0)} samples = ${ms(filterSamples(0)).toFixed(0)}ms`);
console.log("   note     Hz   fundamental filter   half (look-ahead)   2nd harm.   7th harm.   0.5 harm. (stacked below)");
for (const midi of STRINGS) {
  const b = binOfMidi(midi);
  const f0 = filterSamples(b);
  const cells = [2, 7].map((hm) => {
    const bb = b + shift(hm);
    return bb < nBins ? `${ms(filterSamples(bb)).toFixed(0)}ms` : "above";
  });
  const sub = b + shift(0.5) >= 0 ? `${ms(filterSamples(b + shift(0.5))).toFixed(0)}ms` : "-";
  console.log(
    `   ${`${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`.padEnd(5)} ${(440 * 2 ** ((midi - 69) / 12)).toFixed(1).padStart(6)}   ` +
      `${`${ms(f0).toFixed(0)}ms`.padStart(8)}             ${`${(ms(f0) / 2).toFixed(0)}ms`.padStart(6)}          ` +
      `${(cells[0] as string).padStart(7)}     ${(cells[1] as string).padStart(7)}     ${sub.padStart(7)}`,
  );
}
void HARMONICS;

// ---------------------------------------------------------------------------
// 5. Parameters, from the ONNX initializers
// ---------------------------------------------------------------------------

let learned = 0;
let fixedFront = 0;
let shapes = 0;
const learnedNames = new Set<string>();
for (const n of learnedConvs) {
  for (const i of n.inputs.slice(1)) learnedNames.add(i);
}
// The input batch norm after the log CQT (one channel) is two constants after folding.
for (const n of graph.nodes) {
  if ((n.opType === "Mul" || n.opType === "Add") && n.inputs.some((i) => i.includes("batch_normalization/FusedBatchNormV3"))) {
    for (const i of n.inputs) if (init.has(i)) learnedNames.add(i);
  }
}
for (const t of graph.initializers) {
  if (t.dataType !== 1) shapes += t.size;
  else if (learnedNames.has(t.name)) learned += t.size;
  else fixedFront += t.size;
}
// Folding removed the other two batch norms' four vectors each; the Keras model
// counted gamma and beta as trainable and the moving mean and variance as not.
const foldedTrainable = 2 * 1 + 2 * 8 + 2 * 32 - 2; // two of the input BN's four survive as the Mul/Add
const kerasTrainable = learned + foldedTrainable;
console.log("");
console.log("5. Parameters (counted from the ONNX file's initializers)");
console.log(`   learned values in the file        ${learned.toLocaleString("en-US")}   (6 convolutions' kernels and biases, the input batch norm)`);
console.log(`   Keras trainable before folding    ${kerasTrainable.toLocaleString("en-US")}   (adds back batch-norm scale/offset folded away)`);
console.log(`   fixed front-end constants         ${fixedFront.toLocaleString("en-US")}   (CQT kernels 2 x 36 x 256, decimation filter 256, lengths 309, ...)`);
console.log(`   integer shape constants           ${shapes.toLocaleString("en-US")}`);
console.log(
  `   ${learned < 25_000 ? "UNDER" : "OVER"} this repository's 25,000-parameter cap (AGENTS.md section 4): ` +
    `${((100 * learned) / 25_000).toFixed(0)}% of it`,
);

// ---------------------------------------------------------------------------
// 6. The verdict
// ---------------------------------------------------------------------------

const license = /^license:\s*(\S+)/m.exec(card)?.[1] ?? "?";
const datasets = /^datasets:\n((?:- .*\n)+)/m.exec(card)?.[1]?.trim().split("\n").map((l) => l.slice(2).trim()) ?? [];
console.log("");
console.log(`   card: licence ${license}; datasets ${datasets.join(", ")}`);

const SIXTEENTH_140 = 60000 / 140 / 4;
const BAR = 50;
const e2 = filterSamples(binOfMidi(40));
const e2h7 = filterSamples(binOfMidi(40) + shift(7));
const rows: Array<[string, number]> = [
  ["frame hop (every output)", hopMs],
  ["onset target: one frame at the annotated onset", targetHopMs],
  ["note target: edges at the nearest frame", targetHopMs],
  ["contour target: nearest-neighbour f0 grid", targetHopMs],
  ["look-ahead of the CNN at the contour output", rfContour * hopMs],
  ["look-ahead of the CNN at the note output", rfNote * hopMs],
  ["look-ahead of the CNN at the onset output", rfOnset * hopMs],
  ["CQT half-filter at E2's 7th harmonic (577Hz)", ms(e2h7) / 2],
  ["CQT half-filter at E2's fundamental", ms(e2) / 2],
  ["CQT filter at E2's fundamental, whole", ms(e2)],
  ["log normalisation: min and max over the window", ms(N_SAMPLES)],
  ["package windowing: audio kept after a window's last frame", (OVERLAP_FRAMES / 2) * hopMs],
];
console.log("");
console.log(`6. Against the brief's bars: ${BAR}ms, and the 140bpm sixteenth, ${SIXTEENTH_140.toFixed(0)}ms`);
for (const [what, v] of rows) {
  const verdict = v <= BAR ? "fine enough" : v < SIXTEENTH_140 ? "coarser than 50ms" : "coarser than a sixteenth";
  console.log(`   ${what.padEnd(56)} ${`${v.toFixed(0)}ms`.padStart(6)}   ${verdict}`);
}
console.log("");
console.log(
  "   DECIDING FACT: (a) and (b). Every output is a per-frame posteriorgram at " +
    `${hopMs.toFixed(1)}ms: onset activations trained on a\n` +
    "   one-frame onset label, and a per-frame note activity (all zeros = no note) trained on onset-to-offset frames.\n" +
    "   The targets pass the brief's 50ms rule. The ANSWER at a frame is not causal: it reads audio after the frame\n" +
    `   through the CNN (up to ${(rfOnset * hopMs).toFixed(0)}ms at the onset output) and the centred CQT filters ` +
    `(${(ms(e2) / 2).toFixed(0)}ms at E2's fundamental), and\n` +
    "   its normalisation reads the whole 2s window. That is look-ahead, measured in probe.ts and costed in Phase 2.",
);
