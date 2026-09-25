/**
 * Is cstr/hft-transformer-GGUF a note-BOUNDARY witness at all? Phase 1 of the
 * brief `docs/external-models-eval-prompt.md`, answered from the model's own
 * source, training code and weights file at pinned revisions.
 *
 * The question (2026-09-25): the recognizer's remaining errors are about note
 * boundaries — one played note emitted as two (`measure-splits.ts`), Notes with
 * no label behind them (`npm run eval`'s extras), sixteenths at 140bpm the
 * tracker absorbs (`measure-downstream-ledger.ts --all`). Does a published
 * piano transcriber (Toyama et al.'s hFT-Transformer, ISMIR 2023) carry
 * boundary information the engine's witnesses lack? The brief fixed the
 * deciding fact before anything was run: what does the model output over time
 * — (a) onset activations, (b) per-frame pitch including "no note", or (c) one
 * label per clip — at what TARGET resolution, and how promptly. A sixteenth at
 * 140bpm is 107ms. (c), or a target coarser than about 50ms, stops the line.
 *
 * WHICH MODEL THE FILE IS. The GGUF's card names sony/hFT-Transformer, but the
 * weights are not Sony's release: the flutter_tuner export kernel that made
 * the ONNX the GGUF was converted from took `epoch=9-step=46600.ckpt` from
 * huggingface.co/ddPn08/hft-transformer-rewrite and ran it through the code of
 * github.com/ddPn08/hft-transformers-rewrite (Sony's checkpoints sit behind a
 * manual download). That rewrite keeps Sony's architecture and Sony's label
 * code for onsets, adds three pedal heads per stage, and trains on logits.
 * `ckpt-vs-gguf.ts` confirms the chain: all 153 mapped tensors bit-identical,
 * the fused front end equal to the fusion of the checkpoint's own convolution
 * and embedding. So the TARGETS below are read from the rewrite (what these
 * weights were trained on) and checked against Sony's (what it rewrote).
 *
 * What this reads, all SHA-256 checked below (see `build.sh` for the fetch):
 *   - hf/: the GGUF card and hft-transformer-f32.gguf (huggingface.co, 17d72a24)
 *   - the rewrite @ 53c2033b: preprocess/midi.py (targets), dataset.json (front
 *     end, window), modules/*.py (architecture), training/module.py (loss),
 *     preprocess_maestro_v3.py (training data), infer.py (inference)
 *   - sony/hFT-Transformer @ 71a2ee06: corpus/conv_note2label.py, config.json
 *   - CrispASR @ 0864a3e0: src/hft_transformer.cpp (the runtime read here)
 *   - flutter_tuner @ 8cb104ab: the ONNX export kernel and its logged results
 *
 * What it prints:
 *   1. The time axis, read from the source by pattern and asserted, with the
 *      lines that DEFINE each output's target, so drift fails loudly.
 *   2. What each output is trained to answer, in milliseconds.
 *   3. The parameter count, from the GGUF's own tensors and the checkpoint's
 *      heads it does not carry, against this repository's 25,000 cap.
 *   4. Look-ahead and latency, which decide which lane could ever use it.
 *   5. The verdict against the brief's 50ms and 107ms bars.
 *
 * WHAT WOULD HAVE STOPPED IT, stated before running: one answer per window,
 * or an onset/frame target defined over more than about 50ms. What would
 * restrict it without stopping it: a look-ahead longer than the fast lane can
 * wait, which leaves only deep-lane decisions, read on the ring.
 *
 * Usage (fetch and build once with build.sh, then run offline):
 *   npx tsx training/hft-transformer/phase1.ts --dir training/out/hft-transformer
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kvNumber, kvString, readGguf } from "./gguf.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const dir = arg("dir") ?? "training/out/hft-transformer";

// ---------------------------------------------------------------------------
// Pinned inputs
// ---------------------------------------------------------------------------

const PINNED: Record<string, string> = {
  "hf/README.md": "17b23870f50b013ecee06aead4fc9b161cfaad3308430b331216816bd526217a",
  "hf/hft-transformer-f32.gguf": "577652db638f31b60b09e8651e6920faab83a35db84b103e29301d24ffaca935",
  "src/hft-transformers-rewrite/preprocess/midi.py": "59af3ba4fa6f2d6463de24d7d3fe8c9376e89c4c9e3b797bdf477c5b519a7abc",
  "src/hft-transformers-rewrite/preprocess_maestro_v3.py": "79f4e77be964befd319edc751d8486015476d7e65ec9f763fc67c0a157364491",
  "src/hft-transformers-rewrite/dataset.json": "dece3af496bd22898fcdaf2b27d41ae702569e1962d52b8de1d1f0970d34fa90",
  "src/hft-transformers-rewrite/modules/encoder.py": "51b756e869d93280ce850021580e0bb0aaaed91955e5be23a52cd79c81ca3ff6",
  "src/hft-transformers-rewrite/modules/decoder.py": "67371e11431fd9ec32f00e59818898a524eb961816fd5cc0f1f6a98df3246d8d",
  "src/hft-transformers-rewrite/training/module.py": "3aa9d2e6d40725a96aa5222c75c3b742a714d089eabb58efa38010196f37e278",
  "src/hft-transformers-rewrite/infer.py": "577975e8173fee9d5899bd4a1e196fd49f7eef838a74204c34d27c8627707318",
  "src/hFT-Transformer/corpus/conv_note2label.py": "6b198d039ad46a865f721031000a9eaf19ef4ffd20042f925c18639b6d2294fe",
  "src/hFT-Transformer/corpus/config.json": "9a87d48c5b7a9bcb8b0fcd6cd0603bb5608661e0f48160d99143db2affff2bfe",
  "src/CrispASR/src/hft_transformer.cpp": "e3274b5ba35b4d57515578d2d7249a96f4f2bc86595e28c06f175b9ee3f4e204",
  "src/onnx-export/onnx_export.py": "b562013ca39926405c3cb0a8da44d1ea7d2d3b8735730c30a712c13cb0041724",
  "src/onnx-export/results.json": "7d946094da565d137e34dbd9bd80d113bb0d7329df553a3845c07a8154bddca5",
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
const midi = read("src/hft-transformers-rewrite/preprocess/midi.py");
const prep = read("src/hft-transformers-rewrite/preprocess_maestro_v3.py");
const encoderPy = read("src/hft-transformers-rewrite/modules/encoder.py");
const decoderPy = read("src/hft-transformers-rewrite/modules/decoder.py");
const modulePy = read("src/hft-transformers-rewrite/training/module.py");
const inferPy = read("src/hft-transformers-rewrite/infer.py");
const sonyLabel = read("src/hFT-Transformer/corpus/conv_note2label.py");
const runtime = read("src/CrispASR/src/hft_transformer.cpp");
const exportPy = read("src/onnx-export/onnx_export.py");
const results = JSON.parse(read("src/onnx-export/results.json")) as {
  results: Array<{ model: string; notes: string; ops: { distinct: string[] } }>;
};

function mustContain(text: string, what: string, file: string): void {
  if (!text.includes(what)) throw new Error(`${file}: expected to find \`${what}\``);
}

// ---------------------------------------------------------------------------
// 1. The time axis, read from the source
// ---------------------------------------------------------------------------

type DatasetJson = {
  feature: { sampling_rate: number; hop_sample: number; mel_bins: number; fft_bins: number; window_length: number; window_mode: string; pad_mode: string };
  input: { margin_b: number; margin_f: number; num_frame: number };
  midi: { num_notes: number; pitch_min: number };
};
const ds = JSON.parse(read("src/hft-transformers-rewrite/dataset.json")) as DatasetJson;
const SR = ds.feature.sampling_rate;
const HOP = ds.feature.hop_sample;
const NFFT = ds.feature.fft_bins;
const MB = ds.input.margin_b;
const MF = ds.input.margin_f;
const NF = ds.input.num_frame;

// Sony's config is the same front end; the rewrite changed no number in it.
const sony = JSON.parse(read("src/hFT-Transformer/corpus/config.json")) as {
  feature: { sr: number; hop_sample: number; fft_bins: number; mel_bins: number };
  input: { margin_b: number; margin_f: number; num_frame: number };
};
if (
  sony.feature.sr !== SR || sony.feature.hop_sample !== HOP || sony.feature.fft_bins !== NFFT ||
  sony.feature.mel_bins !== ds.feature.mel_bins || sony.input.margin_b !== MB || sony.input.margin_f !== MF ||
  sony.input.num_frame !== NF
) {
  throw new Error("the rewrite's dataset.json and Sony's config.json disagree on the time axis");
}
if (ds.feature.window_length !== NFFT || ds.feature.window_mode !== "hann" || ds.feature.pad_mode !== "constant") {
  throw new Error("dataset.json: unexpected analysis window");
}

// The GGUF carries the same axis, and the runtime refuses anything else.
const gguf = readGguf(join(dir, "hf/hft-transformer-f32.gguf"));
for (const [k, v] of [
  ["hft.sample_rate", SR], ["hft.hop_size", HOP], ["hft.n_fft", NFFT], ["hft.n_mels", ds.feature.mel_bins],
  ["hft.n_frame", NF], ["hft.n_margin", MB], ["hft.front_taps", MB + MF + 1], ["hft.classes_num", ds.midi.num_notes],
] as const) {
  if (kvNumber(gguf, k) !== v) throw new Error(`GGUF ${k} = ${kvNumber(gguf, k)}, source says ${v}`);
}
if (kvString(gguf, "hft.front_end") !== "fused-conv-tok-embedding") throw new Error("GGUF front end is not the fused one");

// The lines that DEFINE each target, asserted verbatim in both code bases.
for (const [text, file] of [[midi, "rewrite preprocess/midi.py"], [sonyLabel, "sony conv_note2label.py"]] as const) {
  mustContain(text, "onset_tolerance = int(50.0 / hop_ms + 0.5)", file);
  mustContain(text, "offset_tolerance = int(50.0 / hop_ms + 0.5)", file);
}
mustContain(midi, "1.0 - (abs(onset_ms_diff) / (onset_sharpness * hop_ms))", "preprocess/midi.py");
mustContain(sonyLabel, "onset_val = max(0.0, 1.0 - (abs(onset_ms_diff) / (onset_sharpness * hop_ms)))", "conv_note2label.py");
mustContain(midi, "onset_frame = int(note.onset * num_frame_in_sec + 0.5)", "preprocess/midi.py");
mustContain(midi, "a_mpe[onset_frame : offset_frame + 1, pitch] = 1", "preprocess/midi.py");
mustContain(midi, "if note.offset == note_2.onset:", "preprocess/midi.py"); // no offset target at a same-key re-strike
// The pedal: `offset` is the KEY release; a re-strike of the same key before any pedal-off ends it there.
mustContain(midi, "if state is not None and state.onpedal > 0 and state.onpedal < event.time:", "preprocess/midi.py");
mustContain(prep, "labels = create_label(config.feature, config.midi, notes)", "preprocess_maestro_v3.py"); // default: no offset_duration_tolerance
mustContain(prep, "apply_pedal=True,", "preprocess_maestro_v3.py");
mustContain(prep, 'dataset_path: str = "maestro-v3.0.0",', "preprocess_maestro_v3.py");
mustContain(modulePy, "self.criterion_onset_B = nn.BCEWithLogitsLoss()", "training/module.py");
mustContain(encoderPy, "self.n_proc = n_margin * 2 + 1", "modules/encoder.py");
mustContain(encoderPy, "spec = spec.unfold(2, self.n_proc, 1).permute(0, 2, 1, 3).contiguous()", "modules/encoder.py");
mustContain(decoderPy, ".reshape([batch_size * self.n_note, self.n_frame, self.hid_dim])", "modules/decoder.py");
mustContain(decoderPy, "for layer_time in self.layers_time:", "modules/decoder.py");
mustContain(inferPy, "output_onset_B = torch.sigmoid(output_onset_B)", "infer.py");
mustContain(runtime, "const int total = ((T + NF - 1) / NF) * NF;", "hft_transformer.cpp");
mustContain(runtime, "p.center_pad = true;", "hft_transformer.cpp");
mustContain(runtime, "p.center_pad_reflect = false; // librosa pad_mode=\"constant\"", "hft_transformer.cpp");
mustContain(runtime, "dst[(size_t)tt * K + p] = hft_sigmoid(buf[(size_t)p * T + tt]);", "hft_transformer.cpp");
mustContain(exportPy, 'hf_hub_download("ddPn08/hft-transformer-rewrite", pick)', "onnx_export.py");
mustContain(exportPy, '"https://github.com/ddPn08/hft-transformers-rewrite.git "', "onnx_export.py");
const hftResult = results.results.find((r) => r.model === "hft_transformer");
if (hftResult === undefined || !hftResult.notes.includes("ckpt epoch=9-step=46600.ckpt")) {
  throw new Error("results.json: the export did not record epoch=9-step=46600.ckpt");
}
if (hftResult.ops.distinct.includes("Sigmoid")) throw new Error("results.json: the export has a Sigmoid op");

const ms = (samples: number): number => (1000 * samples) / SR;
const hopMs = ms(HOP);
const onsetFrames = Math.floor(50.0 / hopMs + 0.5);

console.log("cstr/hft-transformer-GGUF @ 17d72a24 = ddPn08/hft-transformer-rewrite epoch=9-step=46600.ckpt,");
console.log("  code github.com/ddPn08/hft-transformers-rewrite @ 53c2033b, rewriting github.com/sony/hFT-Transformer @ 71a2ee06");
console.log("");
console.log("1. The time axis (read from the source, asserted; Sony's config and the GGUF agree)");
console.log(`   ${SR}Hz mono, STFT n_fft = window ${NFFT} (${ms(NFFT)}ms, periodic Hann, centred, zero padding), hop ${HOP} = ${hopMs}ms`);
console.log(`   ${ds.feature.mel_bins} mel bins (HTK scale, slaney norm, 0-8000Hz), log(mel + 1e-8)`);
console.log(`   one forward pass: ${MB} + ${NF} + ${MF} = ${MB + NF + MF} frames in, the middle ${NF} answered; the next pass starts ${NF} frames on`);
console.log(`   encoder: each answered frame reads its own ${MB + MF + 1} frames (+-${MB}); frequency decoder: within the frame`);
console.log(`   time decoder: self-attention across all ${NF} answered frames of the pass, per key`);

// ---------------------------------------------------------------------------
// 2. What each output is trained to answer
// ---------------------------------------------------------------------------

console.log("");
console.log("2. What each output answers (its training target), per key of 88, per 16ms frame");
console.log(`   onset: a triangle peaked at the exact onset, ${onsetFrames} frames = ${onsetFrames * hopMs}ms to zero either side, >= 0.5 within +-${(onsetFrames * hopMs) / 2}ms`);
console.log(`   offset: the same triangle at the key release; NONE where the same key is re-struck at that instant`);
console.log("   frame (\"mpe\"): 1 on every frame from onset to key release (not the pedal's sustain, which has its own head)");
console.log("   velocity: 128 bins, set on frames where the onset target is >= 0.5");
console.log("   pedal heads (onpedal, offpedal, mpe_pedal): trained, and not carried by the GGUF");
console.log("   loss: BCEWithLogits, so every head is a logit; the runtime applies the sigmoid");
console.log("   two stages answer the same targets: A (frequency decoder) and B (time decoder); the GGUF carries B only");

// ---------------------------------------------------------------------------
// 3. Parameters
// ---------------------------------------------------------------------------

let ggufParams = 0;
let frontEndConstants = 0;
for (const t of gguf.tensors) {
  if (t.name === "hft.mel_fb" || t.name === "hft.window") frontEndConstants += t.elements;
  else ggufParams += t.elements;
}
const HID = kvNumber(gguf, "hft.hidden");
const conv = 4 * 5 + 4; // Conv2d(1, 4, (1, 5))
const tok = 4 * (MB + MF + 1 - 4) * HID + HID; // Linear(244, 256)
const fused = (MB + MF + 1) * HID + HID; // Linear(65, 256), what the GGUF holds instead
const aHeads = 6 * (HID + 1) + (HID * 128 + 128); // onset, offset, onpedal, offpedal, mpe, mpe_pedal, velocity
const bPedal = 3 * (HID + 1);
const checkpoint = ggufParams - fused + conv + tok + aHeads + bPedal;
console.log("");
console.log("3. Parameters (counted from the GGUF's tensors; the checkpoint's own count is 5,518,116, read-ckpt.py)");
console.log(`   the GGUF: ${ggufParams.toLocaleString("en-US")} trained values (front end fused), plus ${frontEndConstants.toLocaleString("en-US")} front-end constants (mel filterbank, window)`);
console.log(`   the checkpoint, unfused, with the A-stage and pedal heads the GGUF drops: ${checkpoint.toLocaleString("en-US")}`);
console.log(`   ${(checkpoint / 25_000).toFixed(0)}x this repository's shipping cap of 25,000 (AGENTS.md section 4)`);
if (checkpoint !== 5_518_116) throw new Error(`parameter reconstruction ${checkpoint} != the checkpoint's 5,518,116`);

// ---------------------------------------------------------------------------
// 4. Look-ahead and latency
// ---------------------------------------------------------------------------

const halfWindow = ms(NFFT / 2);
const aLookahead = MF * hopMs + halfWindow;
const bLookaheadMin = MF * hopMs + halfWindow;
const bLookaheadMax = (NF - 1 + MF) * hopMs + halfWindow;
console.log("");
console.log("4. How much audio after a frame its answer needs");
console.log(`   STFT: half the analysis window, ${halfWindow}ms`);
console.log(`   stage A: its +-${MF}-frame encoder window, ${MF * hopMs}ms + ${halfWindow}ms = ${aLookahead}ms, fixed`);
console.log(`   stage B: the rest of its pass and the margin: ${bLookaheadMin}ms for the pass's last frame, ${bLookaheadMax}ms for its first`);
console.log(`   in the model's own use (passes back to back) an answer exists ${bLookaheadMin}-${bLookaheadMax}ms after its frame`);
console.log("   the fast lane answers within tens of ms: it cannot use this model at all");
console.log("   the deep lane rules on a region 200ms after its Notes stop or when it reaches 1,200ms (+40ms), on a 4s ring:");
console.log("   it can hand the model everything up to its ruling, and loses the look-ahead of frames near the ruling");

// ---------------------------------------------------------------------------
// 5. The verdict
// ---------------------------------------------------------------------------

const SIXTEENTH_140 = 60000 / 140 / 4;
const BAR = 50;
const rows: Array<[string, number]> = [
  ["feature hop", hopMs],
  ["STFT analysis window", ms(NFFT)],
  ["  its full width at half maximum", ms(NFFT) / 2],
  ["onset target: zero this far from the onset", onsetFrames * hopMs],
  ["onset target: >= 0.5 within +-", (onsetFrames * hopMs) / 2],
  ["offset target: zero this far from the release", onsetFrames * hopMs],
  ["frame target: one value per", hopMs],
  ["stage A receptive field (its frames, plus the STFT)", (MB + MF) * hopMs + ms(NFFT)],
  ["stage A look-ahead", aLookahead],
  ["stage B look-ahead, last frame of a pass", bLookaheadMin],
  ["stage B look-ahead, first frame of a pass", bLookaheadMax],
];
console.log("");
console.log(`5. Against the brief's bars: ${BAR}ms, and the 140bpm sixteenth, ${SIXTEENTH_140.toFixed(0)}ms`);
for (const [what, v] of rows) {
  const verdict = v <= BAR ? "fine enough" : v < SIXTEENTH_140 ? "coarser than 50ms" : "coarser than a sixteenth";
  console.log(`   ${what.padEnd(54)} ${`${v.toFixed(0)}ms`.padStart(7)}   ${verdict}`);
}
console.log("");
console.log(
  "   DECIDING FACT: (a) and (b). Per-frame, per-key onset activations and key-down frames at 16ms, trained on\n" +
    `   targets no wider than ${onsetFrames * hopMs}ms either side of the true event. Not (c), and no target is coarser than 50ms.\n` +
    `   It is not causal: each answer needs ${aLookahead}ms of audio after its frame, so only a deep-lane decision can read it,\n` +
    "   and a boundary within that distance of the ruling is read with its look-ahead cut. Phase 1 passes on the targets;\n" +
    "   Phase 2 runs on deep-lane decisions only, with the cost of the cut measured.",
);
