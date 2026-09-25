/**
 * Is MuScriptor/muscriptor-small a note-BOUNDARY witness at all? Phase 1 of the
 * brief that asked (`docs/external-models-eval-prompt.md`), answered from the
 * model's own source at pinned revisions, so the stop-or-go fact can be checked
 * without its weights, which are gated.
 *
 * The question (2026-09-25): the recognizer's remaining errors are about note
 * boundaries — one played note emitted as two (`measure-splits.ts`), Notes with
 * no label behind them (`npm run eval`'s extras), sixteenths at 140bpm the
 * tracker absorbs (`measure-downstream-ledger.ts --all`). Does a published
 * ~100M-parameter multi-instrument transcriber (a decoder-only Transformer that
 * writes MIDI-like note events from a mel spectrogram; PyTorch; code MIT,
 * weights CC-BY-NC-4.0) carry boundary information the engine's witnesses lack?
 * The brief fixed its deciding fact before anything was run: what does the
 * model output over time — (a) onset activations, (b) per-frame pitch including
 * "no note", or (c) one label per clip — at what resolution was that output
 * TRAINED, and does it answer promptly. A sixteenth at 140bpm is 107ms. If the
 * answer is (c), or the target is coarser than about 50ms, the line stops at
 * Phase 1.
 *
 * This model's output is a token sequence, so its deciding fact is the time grid
 * its tokens are encoded on, and when a sequence exists: it writes one sequence
 * per 5-second chunk, and this engine's deep lane holds 4 seconds of audio.
 *
 * What this reads, all pinned (SHA-256 checked below):
 *   - the model card, README.md, at huggingface.co revision 8c127f60… (its git
 *     blob id is checked against the one the revision's tree lists),
 *   - the source repository github.com/muscriptor/muscriptor at 7f213af… (MIT):
 *       muscriptor/tokenizer/notes.py, tokenizer/mt3.py   vocabulary, tokenizer
 *       tests/encode_helpers.py     the note-to-token encoder, kept as a test
 *                                   helper; mt3.py says the training encoder
 *                                   has its layout
 *       muscriptor/events.py        the decoder: what each token means in time
 *       muscriptor/transcription_model.py   sample rate, chunking, variants
 *       muscriptor/modules/mel_spectrogram.py, modules/conditioners.py
 *                                   the front end
 *       muscriptor/models/lm.py, modules/transformer.py   the architecture
 *       muscriptor/utils/sampling.py, utils/beats.py   the frame mask, the
 *                                   timing-lag correction
 *   - this repository's DEFAULT_ENGINE_CONFIG, for the deep lane's ring.
 * The training code is not published. The encoder, the decoder and the model
 * code are what fix what the model can be trained to say, and when.
 *
 * NOT read: config.json and model.safetensors. The repository is gated
 * ("gated: auto", CC-BY-NC-4.0 plus conditions of use): both files answer
 * HTTP 401, x-error-code GatedRepo, to a client without a Hugging Face token
 * from an account that has accepted those conditions, and this environment has
 * none (2026-09-25). The runtime, the `muscriptor` package on PyTorch, would
 * come from pypi.org, which this environment's egress policy refuses. Nothing
 * below needs either: every number here is a property of the design. The
 * parameter count is checked against what the hub publishes about the weights
 * file without serving it (WEIGHTS below, from
 * https://huggingface.co/api/models/MuScriptor/muscriptor-small/revision/<rev>:
 * `siblings[].size`, `siblings[].lfs.sha256`, and `safetensors.parameters`,
 * which the hub reads from the file's header).
 *
 * What it prints:
 *   1. The token time axis — vocabulary, tick, how a shift token becomes a
 *      time, the chunk — read from the source and asserted, so a drift in the
 *      pinned files fails loudly instead of printing stale numbers.
 *   2. What the tokens can say about a same-pitch re-articulation.
 *   3. The front end: STFT window, hop, the frames a chunk's tokens read.
 *   4. The parameter count from the architecture, against the published file.
 *   5. When an answer exists: natively, and for a read the fast lane or the
 *      deep lane could take.
 *   6. The verdict against the brief's 50ms and 107ms bars.
 *
 * WHAT WOULD LET IT THROUGH, stated before running: tokens whose times are
 * encoded at 50ms or finer and placed per event rather than per chunk, with a
 * read the lanes can take (the audio up to a decision point, or the ring). A
 * coarser grid, or one answer per chunk, stops the line. Passing on paper does
 * not start Phase 2 here: Phase 2 needs the weights.
 *
 * Usage (fetch once, then run offline; the script touches no network):
 *   D=training/out/muscriptor
 *   mkdir -p $D/hf
 *   curl -sSL -o $D/hf/README.md \
 *     "https://huggingface.co/MuScriptor/muscriptor-small/resolve/8c127f603b807520fa465c838e9bfee8a91ada4e/README.md"
 *   git clone --no-checkout https://github.com/muscriptor/muscriptor.git $D/src
 *   git -C $D/src sparse-checkout set muscriptor tests
 *   git -C $D/src checkout 7f213afecf23bd6a1b8672aa223690ee9807cefb
 *   npx tsx training/muscriptor/phase1.ts --dir $D
 * The sparse checkout leaves out the source's web front end: this repository's
 * tsconfig includes training/, and that front end's TypeScript would fail
 * `npx tsc --noEmit` here. Nothing under it is read.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_ENGINE_CONFIG } from "../../src/engine/config.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const dir = arg("dir");
if (!dir) {
  console.error("usage: npx tsx training/muscriptor/phase1.ts --dir <dir>  (see the header)");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Pinned inputs
// ---------------------------------------------------------------------------

const HF_REVISION = "8c127f603b807520fa465c838e9bfee8a91ada4e";
const SRC_COMMIT = "7f213afecf23bd6a1b8672aa223690ee9807cefb";

const PINNED: Record<string, string> = {
  "hf/README.md": "a4d1c2d25c393e81348ed5b9b95eb0acf8842afb49b8cdb28be9643958051689",
  "src/muscriptor/tokenizer/notes.py": "686ee5a6d336bf74a67390c72af376c00e42061e0d72354346e2e52b95363f33",
  "src/muscriptor/tokenizer/mt3.py": "c37c7d9b101f6498bf8cf5964ab90df8b4df59f2e9960a192ed43b7fa9ae4a62",
  "src/tests/encode_helpers.py": "7f9faab79d274a43291f83a4afee2621bb262926628cad4d0aeeba75d1f74520",
  "src/muscriptor/events.py": "55f3c2239ebcfb68ab06158f46b97944501e922ddfe180073068ab3162be9171",
  "src/muscriptor/transcription_model.py": "f15314858929263e81f6a744f77db9bb3d2666718459fd520f424fb8e2ae305a",
  "src/muscriptor/modules/mel_spectrogram.py": "d456f638758f0e980dc21403db2342ec3f26647e9bf4d7f44110dabd8b867473",
  "src/muscriptor/modules/conditioners.py": "2f545e600f8a1f64b750ccb31363f1782098bbf5c6c35b7f0945011382a82892",
  "src/muscriptor/models/lm.py": "8600f40d7b5242b37d0db5dbf16eddde6b493d2243ac4177bc86750bcea554a2",
  "src/muscriptor/modules/transformer.py": "34959ace4333e6dcc675a1e20c03eb8ece4bf42f5508343a0f7f1417632ce171",
  "src/muscriptor/utils/sampling.py": "b0db94505b713f004aaabd613047e66cfd9e8cfc120ad69e9d96abc1236e36b2",
  "src/muscriptor/utils/beats.py": "e3857bc636618ace279571c025353c0870529cd3925a02284f6e3d47f651986d",
};

/** README.md's git blob id in the tree of HF_REVISION (the hub's `blobId`). */
const README_BLOB = "b973521868529c4fae350302e0f492612bc421e1";

/** model.safetensors at HF_REVISION, as the hub publishes it without serving it. */
const WEIGHTS = {
  bytes: 411_888_600,
  lfsSha256: "bbd482c786b895cf7d8f44185073d951adae2ebb8a66f82ca84cd1f84569549c",
  f32Elements: 102_968_832, // safetensors.parameters.F32: every tensor in the file is float32
};

const SHIP_CAP = 25_000; // AGENTS.md section 4

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
{
  const bytes = readFileSync(join(dir, "hf/README.md"));
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (blob !== README_BLOB) throw new Error(`hf/README.md is git blob ${blob}, not ${README_BLOB} of the pinned revision`);
}

const read = (rel: string): string => readFileSync(join(dir, rel), "utf8");
const card = read("hf/README.md");
const notesPy = read("src/muscriptor/tokenizer/notes.py");
const mt3Py = read("src/muscriptor/tokenizer/mt3.py");
const encoderPy = read("src/tests/encode_helpers.py");
const eventsPy = read("src/muscriptor/events.py");
const modelPy = read("src/muscriptor/transcription_model.py");
const melPy = read("src/muscriptor/modules/mel_spectrogram.py");
const condPy = read("src/muscriptor/modules/conditioners.py");
const lmPy = read("src/muscriptor/models/lm.py");
const transformerPy = read("src/muscriptor/modules/transformer.py");
const samplingPy = read("src/muscriptor/utils/sampling.py");
const beatsPy = read("src/muscriptor/utils/beats.py");

function grab(text: string, re: RegExp, file: string): string[] {
  const m = re.exec(text);
  if (!m) throw new Error(`${file}: ${re} not found`);
  return m.slice(1).map((g) => g ?? "");
}
const grabNum = (text: string, re: RegExp, file: string): number => Number(grab(text, re, file)[0]);
function mustContain(text: string, what: string, file: string): void {
  if (!text.includes(what)) throw new Error(`${file}: expected to find \`${what}\``);
}
/** `lines` must appear as consecutive lines of `text`, each compared with its indentation trimmed. */
function mustContainLines(text: string, lines: string[], file: string): void {
  const all = text.split("\n").map((l) => l.trim());
  for (let i = 0; i + lines.length <= all.length; i++) {
    if (lines.every((l, j) => all[i + j] === l)) return;
  }
  throw new Error(`${file}: expected the consecutive lines\n  ${lines.join("\n  ")}`);
}
const fmt = (n: number): string => n.toLocaleString("en-US");

// ---------------------------------------------------------------------------
// 1. The token time axis
// ---------------------------------------------------------------------------

const SR = grabNum(modelPy, /^_SAMPLE_RATE = (\d+)$/m, "transcription_model.py");
const SEGMENT_S = Number(grab(modelPy, /^_SEGMENT_DURATION = ([\d.]+)$/m, "transcription_model.py")[0]);
mustContain(modelPy, "# Must match the segment duration used during training / evaluation.", "transcription_model.py");
const [dimS, headsS, layersS, cardS] = grab(
  modelPy,
  /"small": _ModelConfig\(dim=(\d+), num_heads=(\d+), num_layers=(\d+), card=(\d+)\),/,
  "transcription_model.py",
);
const DIM = Number(dimS);
const HEADS = Number(headsS);
const LAYERS = Number(layersS);
const CARD = Number(cardS);
{
  const [d, h, l] = grab(card, /\(this variant: `dim=(\d+)`, `num_heads=(\d+)`, `num_layers=(\d+)`\)/, "README.md").map(Number);
  if (d !== DIM || h !== HEADS || l !== LAYERS) throw new Error("the card and the code disagree on the small variant");
}

// The tokenizer the model is loaded with: frame_rate is left at its default.
mustContainLines(
  modelPy,
  ["tokenizer = MT3Tokenizer(", 'instrument_vocabulary="MT3_FULL_PLUS",', "max_shift_steps=1001,", ")"],
  "transcription_model.py",
);
const MAX_SHIFT_STEPS = grabNum(modelPy, /max_shift_steps=(\d+),/, "transcription_model.py");
const FRAME_RATE = grabNum(mt3Py, /^\s+frame_rate: int = (\d+),$/m, "mt3.py");
const TICK_MS = 1000 / FRAME_RATE;

// The vocabulary, range by range, in decode-table order; its size must be the small variant's `card`.
const special = (grab(notesPy, /^SPECIAL_TOKENS = \(([^)]*)\)$/m, "notes.py")[0] as string)
  .split(",")
  .filter((s) => s.trim()).length;
const ranges: Array<[string, number]> = [];
for (const m of notesPy.matchAll(/EventRange\("(\w+)", (\d+), ([^)]+)\)/g)) {
  const hi = m[3] === "max_shift_steps - 1" ? MAX_SHIFT_STEPS - 1 : Number(m[3]);
  ranges.push([m[1] as string, hi - Number(m[2]) + 1]);
}
const vocab = special + ranges.reduce((s, [, n]) => s + n, 0);
if (vocab !== CARD) throw new Error(`vocabulary of ${vocab} tokens, but the small variant's card is ${CARD}`);

// A shift token is a time since the chunk's start, on the tick grid: the encoder
// writes it, the decoder reads it back.
mustContain(encoderPy, "ne_tick = round(ne.time * frame_rate)", "encode_helpers.py");
mustContain(encoderPy, "shift_ticks = ne_tick - start_tick", "encode_helpers.py");
mustContain(mt3Py, "The layout matches the training encoder", "mt3.py");
mustContain(eventsPy, "self._start_tick = round(item.seek_time * self._frame_rate)", "events.py");
mustContain(eventsPy, "self._tick_state = self._start_tick + event.value", "events.py");
mustContain(eventsPy, "time = self._tick_state / self._frame_rate", "events.py");
mustContain(eventsPy, "if self._next_seek_time is not None and time >= self._next_seek_time:", "events.py");

// Chunks: back to back, the last one padded with zeros; one token sequence each.
mustContain(modelPy, "start = i * segment_samples", "transcription_model.py");
mustContain(modelPy, "chunk = wav[:, start : start + segment_samples]", "transcription_model.py");
mustContain(modelPy, "chunk = F.pad(chunk, (0, segment_samples - chunk.shape[-1]))", "transcription_model.py");
const MAX_GEN = grabNum(modelPy, /max_gen_len = (\d+)$/m, "transcription_model.py");

const fullPlus = grab(mt3Py, /elif instrument_vocabulary == "MT3_FULL_PLUS":\n([\s\S]*?)\n\s+elif instrument_vocabulary ==/, "mt3.py")[0] as string;
const groups = [...fullPlus.matchAll(/^\s+(\d+): /gm)].length;
for (const s of ['"acoustic_guitar": 4,', '"clean_electric_guitar": 5,', '"distorted_electric_guitar": 6,']) {
  mustContain(mt3Py, s, "mt3.py");
}

const SEGMENT_MS = SEGMENT_S * 1000;
const SEGMENT_SAMPLES = SEGMENT_S * SR;

console.log(`MuScriptor/muscriptor-small @ ${HF_REVISION.slice(0, 8)}, source github.com/muscriptor/muscriptor @ ${SRC_COMMIT.slice(0, 7)}`);
console.log("");
console.log("1. The token time axis (read from the source, asserted)");
console.log(
  `   vocabulary ${vocab} tokens = ${special} special + ${ranges.map(([t, n]) => `${n} ${t}`).join(" + ")}` +
    ` (the small variant's card, ${CARD})`,
);
console.log(
  `   tick: frame_rate ${FRAME_RATE} per second = ${TICK_MS}ms; shift values 0..${MAX_SHIFT_STEPS - 1}, ` +
    `of which a chunk uses 0..${SEGMENT_S * FRAME_RATE - 1}`,
);
console.log("   the encoder rounds every note-on and note-off time to a tick; a shift token is the number of ticks");
console.log("   since the CHUNK's start (absolute within it, not since the last event); the decoder reads it the same way");
console.log(`   chunk: ${SEGMENT_MS}ms (${fmt(SEGMENT_SAMPLES)} samples at ${SR}Hz), back to back, the last one zero-padded;`);
console.log(`   one token sequence of at most ${MAX_GEN} tokens each; an event at or past the chunk's end is dropped`);
console.log(`   instruments: ${groups} groups (MT3_FULL_PLUS); guitar is 4 acoustic, 5 clean electric, 6 distorted electric`);

// ---------------------------------------------------------------------------
// 2. A same-pitch re-articulation, in tokens
// ---------------------------------------------------------------------------

mustContain(eventsPy, "self._open: dict[tuple[int, int], float] = {}", "events.py");
mustContainLines(
  mt3Py,
  [
    "# (transcription_model._build_instrument_for_program): the model emits",
    "# the first program of a group, so only that program is allowed.",
  ],
  "mt3.py",
);
mustContainLines(
  eventsPy,
  [
    "key = (self._program, event.value)",
    "actions = []",
    "if key in self._open:",
    "del self._open[key]",
    "actions.append(_EndNote(*key, time))",
    "if self._velocity > 0:",
    "self._open[key] = time",
    "actions.append(_StartNote(*key, time))",
  ],
  "events.py",
);
mustContainLines(
  encoderPy,
  ["key=lambda n: (", "round(n.time * frame_rate),", "n.is_drum,", "n.program,", "n.velocity,", "n.pitch,"],
  "encode_helpers.py",
);
const MIN_NOTE_MS = 1000 * Number(grab(notesPy, /^MINIMUM_NOTE_DURATION_SEC = ([\d.]+)$/m, "notes.py")[0]);
mustContain(notesPy, "sorted_notes[i - 1].offset = sorted_notes[i].onset", "notes.py");
mustContain(card, "It also cannot represent two notes of the same pitch and instrument sounding at the same time.", "README.md");

console.log("");
console.log("2. A same-pitch re-articulation, in tokens");
console.log("   open notes are keyed by (program, pitch), and the model writes one program per instrument group:");
console.log("   one sounding note per group and pitch, with its octave");
console.log("   at one tick the encoder writes offsets before onsets (velocity 0 sorts first), so a re-pick of a sounding");
console.log("   pitch is an off and an on on the same tick; the decoder also takes a bare on for an open key as a");
console.log("   retrigger, ending the old note on that tick");
console.log(`   closest two onsets of one pitch: one tick, ${TICK_MS}ms; shortest note the decoder keeps: ${MIN_NOTE_MS}ms`);
console.log("   cannot say: two notes of one pitch sounding at once in one group (a unison across two strings)");

// ---------------------------------------------------------------------------
// 3. The front end
// ---------------------------------------------------------------------------

const N_FFT = grabNum(modelPy, /^\s+n_fft=(\d+),$/m, "transcription_model.py");
const MEL_FRAME_RATE = grabNum(modelPy, /^\s+frame_rate=(\d+),$/m, "transcription_model.py");
const N_MELS = grabNum(modelPy, /^\s+n_mel_bins=(\d+),$/m, "transcription_model.py");
const INST_CLASSES = grabNum(modelPy, /inst_cond = ClassConditioner\(num_classes=(\d+),/, "transcription_model.py");
const DS_CLASSES = grabNum(modelPy, /ds_cond = ClassConditioner\(num_classes=(\d+),/, "transcription_model.py");
const HIDDEN_SCALE = grabNum(modelPy, /^\s+hidden_scale=(\d+),$/m, "transcription_model.py");
mustContain(modelPy, "# Always unconditional on dataset: the null/pad class.", "transcription_model.py");
if (MEL_FRAME_RATE !== FRAME_RATE) throw new Error("the mel frames and the token ticks are on different grids");
{
  const [n, hop, rate, mels] = grab(card, /STFT `n_fft=(\d+)`, hop (\d+) → (\d+) Hz frame rate, (\d+) mel bins/, "README.md").map(Number);
  if (n !== N_FFT || rate !== MEL_FRAME_RATE || mels !== N_MELS || hop !== SR / MEL_FRAME_RATE) {
    throw new Error("the card and the code disagree on the front end");
  }
}
mustContain(condPy, "self.hop_length = sample_rate // frame_rate", "conditioners.py");
for (const s of ["power=1.0,", "center=True,", 'pad_mode="reflect",']) mustContain(condPy, s, "conditioners.py");
mustContain(condPy, "mel = torch.log(mel + self.eps)", "conditioners.py");
mustContain(condPy, "lengths = lengths / (self.sample_rate // self.frame_rate)", "conditioners.py");
mustContain(condPy, "mask = length_to_mask(lengths, max_len=embeds.shape[1]).int()", "conditioners.py");
mustContain(samplingPy, "return torch.arange(final_length, device=lengths.device)[None, :] < lengths[:, None]", "sampling.py");
mustContain(melPy, 'self.register_buffer("window", torch.hann_window(n_fft))', "mel_spectrogram.py");
mustContain(melPy, 'self.register_buffer("fb", fb)', "mel_spectrogram.py");
for (const s of ["n_freqs=n_fft // 2 + 1,", "f_min=0.0,", "f_max=sample_rate / 2.0,"]) mustContain(melPy, s, "mel_spectrogram.py");
// The conditions go in front of the tokens, and attention is causal over the whole
// sequence, so every token sees every frame of its chunk.
mustContain(lmPy, "input_ = torch.cat([cond.to(input_.dtype), input_], dim=1)", "lm.py");
mustContain(transformerPy, "q_t, k_t, v_t, is_causal=True, dropout_p=0.0", "transformer.py");

const HOP = SR / MEL_FRAME_RATE;
const hopMs = (1000 * HOP) / SR;
const ms = (samples: number): number => (1000 * samples) / SR;
const windowMs = ms(N_FFT);
let halfMax = 0; // torch.hann_window is periodic: 0.5 - 0.5 cos(2 pi n / N)
for (let n = 0; n < N_FFT; n++) if (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT) >= 0.5) halfMax++;
const fwhmMs = ms(halfMax);
const framesComputed = 1 + Math.floor(SEGMENT_SAMPLES / HOP); // center=True
const framesKept = Math.floor(SEGMENT_SAMPLES / HOP); // length_to_mask(length / hop)
const newestCentre = (framesKept - 1) * HOP;
const reachMs = ms(newestCentre + N_FFT / 2 - SEGMENT_SAMPLES);
const binHz = SR / N_FFT;
const semitoneAtBinHz = binHz / (2 ** (1 / 12) - 1);

console.log("");
console.log("3. The front end (read from the source, asserted)");
console.log(`   ${SR}Hz mono; STFT ${N_FFT} samples = ${windowMs}ms under a periodic Hann window (${fwhmMs.toFixed(0)}ms at half maximum),`);
console.log(`   hop ${HOP} samples = ${hopMs}ms, the same grid as the ticks; magnitude, ${N_MELS} HTK mel bins 0-${SR / 2}Hz, log`);
console.log(`   frames are centred (reflect padding): ${framesComputed} per chunk, of which the mask keeps ${framesKept}, centred at`);
console.log(`   0..${ms(newestCentre)}ms; the newest reads ${reachMs.toFixed(0)}ms past the chunk's end, and that part is a mirror`);
console.log("   the spectrogram is projected to the model width and put in front of the tokens; attention is causal over");
console.log("   the whole sequence, so every token is written with the whole chunk in view");
console.log(`   frequency: FFT bins ${binHz.toFixed(2)}Hz apart, wider than a semitone below ${semitoneAtBinHz.toFixed(0)}Hz`);

// ---------------------------------------------------------------------------
// 4. Parameters, from the architecture
// ---------------------------------------------------------------------------

mustContainLines(lmPy, ["self.emb = ScaledEmbedding(", "self.card + 1,"], "lm.py");
mustContain(lmPy, "dim_feedforward=int(hidden_scale * dim),", "lm.py");
mustContain(lmPy, "self.out_norm = nn.LayerNorm(dim, eps=1e-5)", "lm.py");
mustContain(lmPy, "self.linear = nn.Linear(dim, card, bias=False)", "lm.py");
for (const s of [
  "in_proj = nn.Linear(embed_dim, 3 * embed_dim, bias=False, **factory_kwargs)",
  "self.out_proj = nn.Linear(embed_dim, embed_dim, bias=False, **factory_kwargs)",
  "self.norm1 = nn.LayerNorm(d_model, eps=1e-5, **factory_kwargs)",
  "self.norm2 = nn.LayerNorm(d_model, eps=1e-5, **factory_kwargs)",
  "self.linear1 = nn.Linear(d_model, dim_feedforward, bias=False, **factory_kwargs)",
  "self.linear2 = nn.Linear(dim_feedforward, d_model, bias=False, **factory_kwargs)",
  "pos_emb = create_sin_embedding(",
]) {
  mustContain(transformerPy, s, "transformer.py");
}
mustContain(condPy, "self.output_proj = nn.Linear(self.dim, output_dim)", "conditioners.py");
mustContain(condPy, "self.dim = n_mel_bins * self.fine_frame_rate_ratio", "conditioners.py");
mustContain(condPy, "self.embed = nn.Embedding(num_classes + 1, output_dim).to(device)", "conditioners.py");
// float32 unless on Apple's MPS; the conditioners stay float32 regardless.
mustContain(modelPy, 'dtype = torch.float16 if device.type == "mps" else torch.float32', "transcription_model.py");

const FF = HIDDEN_SCALE * DIM;
const attention = 3 * DIM * DIM + DIM * DIM;
const feedForward = 2 * DIM * FF;
const layerNorms = 2 * (2 * DIM);
const perLayer = attention + feedForward + layerNorms;
const tokenEmbedding = (CARD + 1) * DIM;
const outHead = 2 * DIM + DIM * CARD;
const melProj = N_MELS * DIM + DIM;
const classEmb = (INST_CLASSES + 1) * DIM + (DS_CLASSES + 1) * DIM;
const learned = tokenEmbedding + LAYERS * perLayer + outHead + melProj + classEmb;
const buffers = N_FFT + (N_FFT / 2 + 1) * N_MELS; // Hann window + mel filterbank, stored in the file
const elements = learned + buffers;
const bytes32 = 4 * elements;
if (elements !== WEIGHTS.f32Elements) {
  throw new Error(`the architecture has ${elements} tensor elements, the published file ${WEIGHTS.f32Elements}`);
}

const line = (what: string, n: number): void => console.log(`   ${what.padEnd(60)}${fmt(n).padStart(12)}`);
console.log("");
console.log("4. Parameters (from the architecture; the weights were not fetched)");
line(`token embedding, (${CARD} + 1) x ${DIM}`, tokenEmbedding);
line(`${LAYERS} layers of ${fmt(perLayer)}`, LAYERS * perLayer);
console.log(
  `     each: attention ${fmt(attention)}, feed-forward ${fmt(feedForward)} (${DIM} -> ${FF} -> ${DIM}), ` +
    `two LayerNorms ${fmt(layerNorms)};\n     linear layers without biases, positions sinusoidal (no parameters)`,
);
line(`output LayerNorm and projection to the ${CARD} tokens`, outHead);
line(`mel projection, ${N_MELS} -> ${DIM}`, melProj);
line(`instrument-group (${INST_CLASSES} + 1) and dataset (${DS_CLASSES} + 1) embeddings`, classEmb);
line("learned parameters", learned);
line(`+ Hann window ${fmt(N_FFT)} and mel filterbank ${fmt(N_FFT / 2 + 1)} x ${N_MELS}, fixed`, buffers);
line("= tensor elements in the file", elements);
console.log(
  `   model.safetensors (LFS sha256 ${WEIGHTS.lfsSha256.slice(0, 16)}…): the hub reads ` +
    `${fmt(WEIGHTS.f32Elements)} float32 elements from its header, the same`,
);
console.log(
  `   x 4 bytes (float32, the code's default) = ${fmt(bytes32)}, against the file's ${fmt(WEIGHTS.bytes)}: ` +
    `${fmt(WEIGHTS.bytes - bytes32)} bytes left for the header`,
);
console.log(`   ${fmt(Math.round(learned / SHIP_CAP))}x this repository's shipping cap of ${fmt(SHIP_CAP)} (AGENTS.md section 4)`);

// ---------------------------------------------------------------------------
// 5. When an answer exists
// ---------------------------------------------------------------------------

const LAG_MS = grabNum(modelPy, /\(up to ~(\d+) ms\) due to model/, "transcription_model.py");
const LAG_FIX_MS = 1000 * Number(grab(beatsPy, /^MAX_ONSET_DELAY_S = ([\d.]+)$/m, "beats.py")[0]);
const RING_MS = DEFAULT_ENGINE_CONFIG.deep.ringSeconds * 1000;
const SETTLE_MS = DEFAULT_ENGINE_CONFIG.deep.regionSettleMs;
const DEEP_LATENCY_MS = DEFAULT_ENGINE_CONFIG.deep.latencyMs;
const MAX_REGION_MS = DEFAULT_ENGINE_CONFIG.deep.maxRegionMs;
const padMs = Math.max(0, SEGMENT_MS - RING_MS);

console.log("");
console.log("5. When an answer exists");
console.log(`   natively: a chunk's tokens start once its last sample has arrived; an event t ms into a chunk is`);
console.log(`   answered ${SEGMENT_MS} - t ms after it at the earliest (0-${SEGMENT_MS}ms), plus decoding up to ${MAX_GEN} tokens`);
console.log(`   the code says every event may carry one constant lag of up to ~${LAG_MS}ms, removed afterwards against a`);
console.log(`   beat grid (at most ${LAG_FIX_MS}ms)`);
console.log(`   a fast-lane read: the ${SEGMENT_MS}ms ending at the decision point. The event under decision is then in the`);
console.log(`   newest frames: the newest is centred ${hopMs}ms before the decision point and reads ${reachMs.toFixed(0)}ms of mirror past it`);
console.log(`   a deep-lane read: the ring holds ${RING_MS}ms (DEFAULT_ENGINE_CONFIG.deep.ringSeconds), ${padMs}ms short of a chunk, so`);
console.log(`   ${padMs}ms of every input is padding; the code's own padding is zeros after the audio (a file's last chunk).`);
console.log(`   A region (at most ${MAX_REGION_MS}ms) is analysed once ${SETTLE_MS}ms of audio has followed its last Note, and its`);
console.log(`   result applies ${DEEP_LATENCY_MS}ms of source time later`);

// ---------------------------------------------------------------------------
// 6. The verdict
// ---------------------------------------------------------------------------

const SIXTEENTH_140 = 60000 / 140 / 4;
const BAR = 50;
const verdict = (v: number): string =>
  v <= BAR ? "fine enough" : v < SIXTEENTH_140 ? "coarser than 50ms" : "coarser than a sixteenth";
type Row = [string, string, string];
const row = (what: string, v: number, note?: string): Row => [what, v.toFixed(0), note ?? verdict(v)];
const table: Array<Row | string> = [
  "what the tokens resolve",
  row("token time grid: one shift step (absolute in chunk)", TICK_MS),
  row("closest two onsets of one pitch (one tick)", TICK_MS),
  row("shortest note the decoder keeps", MIN_NOTE_MS),
  "what each frame reads",
  row("mel frame hop", hopMs),
  row("STFT window, every mel bin", windowMs),
  row("STFT window, Hann width at half maximum", fwhmMs),
  row("newest frame's reach past a chunk's end", reachMs, "mirrored audio, not future audio"),
  "when an answer exists",
  row("one token sequence per chunk", SEGMENT_MS),
  ["wait from an event to its chunk's end (native)", `0-${SEGMENT_MS}`, verdict(SEGMENT_MS)],
  row("constant lag on every event, per the code", LAG_MS, "fine enough (removed afterwards)"),
  row("deep lane ring (DEFAULT_ENGINE_CONFIG.deep)", RING_MS, `${padMs}ms short of a chunk`),
];
console.log("");
console.log(`6. Against the brief's bars: ${BAR}ms, and the 140bpm sixteenth, ${SIXTEENTH_140.toFixed(0)}ms`);
console.log(`${"".padEnd(64)}ms    against ${BAR}ms / ${SIXTEENTH_140.toFixed(0)}ms`);
for (const r of table) {
  if (typeof r === "string") {
    console.log(`   ${r}`);
    continue;
  }
  const [what, v, note] = r;
  console.log(`     ${what.padEnd(54)}${v.padStart(7)}    ${note}`);
}
console.log("");
console.log(
  "   DECIDING FACT: not (c). The model writes note-on and note-off events per (instrument group, pitch), with\n" +
    `   the octave, each on an absolute ${TICK_MS}ms tick inside its chunk: (a) and (b) at once, as decisions rather than\n` +
    `   activations. Its target grid is ${TICK_MS}ms, finer than ${BAR}ms and a tenth of the ${SIXTEENTH_140.toFixed(0)}ms sixteenth, so the Phase 1\n` +
    `   rule does not stop it on resolution. It does not answer promptly as published: one sequence per ${SEGMENT_MS}ms chunk,\n` +
    `   written with the whole chunk in view, 0-${SEGMENT_MS}ms after an event. The lanes could still read it: the fast\n` +
    `   lane on the ${SEGMENT_MS}ms ending at a decision point, with the event in the newest frames; the deep lane on its\n` +
    `   ${RING_MS}ms ring and ${padMs}ms of zeros. Neither is the condition its published scores describe, and whether\n` +
    "   its answers there carry the boundary is Phase 2's question. Phase 2 needs the weights, which are gated:\n" +
    "   stopped at Phase 1, with nothing read on the corpus.",
);
