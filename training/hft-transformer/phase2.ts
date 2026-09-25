/**
 * Phase 2 of `docs/external-models-eval-prompt.md` for cstr/hft-transformer-GGUF:
 * does the model carry boundary information the engine's witnesses lack?
 *
 * Phase 1 (`phase1.ts`) passed the model on its targets — per-frame, per-key
 * onset activations and key-down frames at 16ms, onset targets zero 48ms from
 * the event — and restricted it to DEEP-LANE decisions: every answer needs
 * 576ms of audio after its frame. Everything below was fixed in writing
 * (this header) before any take was run through the engine or the model.
 *
 * ============================================================================
 * TAKES
 *   DERIVATION (15): the five originals, the eight 120bpm same-pitch takes,
 *     the two rest-repick takes (AGENTS.md section 3). `--stage derivation`.
 *   HELD OUT (12): the 140bpm takes. `--stage heldout`, run ONCE, after the
 *     derivation results, with this code unchanged; reported in its own
 *     section as held-out whatever the derivation result, because the lost
 *     140bpm sixteenths Q3 asks about live there.
 *   Signal path from each label file's `instrument`: guitar-clean -> clean,
 *   guitar-di -> DI, guitar-amped / guitar-amp-sim -> amp, guitar-amp-mic -> mic.
 *
 * THE ENGINE SIDE
 *   The real engine (analyzeSamples, 48kHz, 128-sample blocks), its tracker
 *   trace, `projectEmissions(...).final` and the repository's matcher, exactly
 *   as the measurement scripts run them. Rows are built with the scripts' own
 *   code: `collectFixture` (measure-decision-separability.ts) for cuts,
 *   `classify`/`fatesOf` (measure-downstream-ledger.ts) for missed labels.
 *   Deep-lane rulings are OBSERVED, not changed: a wrapper around
 *   `DeepLane.prototype.drain` records each region ruling and
 *   `ring.writeIndex` at that moment — the audio the deep lane holds when it
 *   decides. Nothing in src/ is edited.
 *
 * THE MODEL SIDE
 *   Audio: the engine's own 48kHz samples, decimated 3:1 to 16kHz with
 *   torchaudio's default resampler (Hann-windowed sinc, 6 zero crossings,
 *   roll-off 0.99, i.e. cut-off 7.92kHz, zero phase), the one the model's
 *   training pipeline used on MAESTRO.
 *   DEEP reading (the one every bar is judged on): for a row with anchor
 *   time a, the first ruling whose held audio passes a; the model is handed
 *   only the audio the ring holds then (at most 4s, nothing after it) and
 *   answers the 128 frames ending at the ruling (`hft-read reads`).
 *   FULL reading (diagnostic only, never judged): the whole take, the model's
 *   own block-wise use, look-ahead intact (`hft-read full`). The gap between
 *   the two is what cutting the look-ahead costs, reported per question.
 *   Frame f is centred on 16f ms. "Onset", "frame" = the B-stage heads,
 *   post-sigmoid. A key's pitch class is (key + 21) mod 12.
 *
 * WINDOWS, each checked against the 107ms sixteenth at 140bpm
 *   onset window +-40ms around an anchor: 80ms wide, and a pick 107ms away
 *     has its trained triangle end 59ms from the anchor, outside it. OK.
 *   70ms margin from label starts (Q3 false alarms): the ledger's own window,
 *     two thirds of a sixteenth. OK.
 *   the model's STFT window, 128ms (FWHM 64ms): WIDER than a sixteenth. Each
 *     frame mixes neighbouring notes; separating them is the model's job, and
 *     the numbers below are how well it does it.
 *   the model's look-ahead, 576ms: cut at the deep lane's ruling; reported.
 *   the matcher's 300ms onset window: the repository's, unchanged; the
 *     outcome targets inherit it.
 *
 * ============================================================================
 * Q1 GHOSTS (outcome-shaped: is this emitted Note surplus?)
 *   Rows: every emitted Note (final, after absorption). y = 1 when the matcher
 *     left it unpaired (extra), 0 when paired.
 *   Anchor: the Note's end (its start when it has none) + 40ms.
 *   Scores, higher meaning "a real note", both pre-registered:
 *     S1a sounding: mean over the Note's frames of the max frame activation
 *         over all 88 keys;
 *     S1b pitch agreement: mean over the Note's frames of the max frame
 *         activation over the keys of the Note's pitch classes (octave-free;
 *         exact pitch is Q4's). A Note with no pitch reading uses all keys.
 *     The Note's frames: centres in [start, end], clipped to the reading.
 *   BAR: AUC >= 0.80 for S1a or S1b, deep reading, derivation pooled, AUC
 *     taken as P(score of a paired Note > score of an extra one).
 *   2x2 at the model's own 0.5: model says "real" iff S1b >= 0.5.
 *
 * Q2 SAME-PITCH SPLITS (boundary-shaped: should this cut have been made?)
 *   Rows: `collectFixture` rows that are accepted, settled and same-pitch
 *     (pitchDiffers 0): every cut the tracker made between two same-pitch
 *     Notes. Cut time t = row.at.
 *   Anchor: t + 40ms.
 *   Score S2: the max onset activation within +-40ms of t over the keys of
 *     the cut's pitch classes (the parent Note's, else the child's, else all
 *     keys). Higher meaning "a new articulation".
 *   Targets: y_b, the boundary target of `collectFixture` (a label starts
 *     within 70ms and no earlier-opened Note accounts for it) — the one the
 *     bar is on; y_o, the outcome target (the child Note went unpaired) —
 *     reported beside it, never compared with 0.698 (DECISION-032).
 *   BAR, both halves: (i) AUC(S2, y_b) > 0.698 over all Q2 rows, deep
 *     reading; (ii) on the rows whose child DECISION-030's shipped gate let
 *     through (the child's `ended` event says announced), the 95% bootstrap
 *     lower bound of AUC(S2, y_b) > 0.5 (2,000 class-stratified resamples,
 *     fixed seed).
 *   Beside it, same rows and targets: the engine's at-boundary witnesses
 *     (sharpness, fluxRatio, dipRatio) and its rate witness (the child's
 *     sounded span over the tracker's local IOI).
 *   2x2 at 0.5: model says "new articulation" iff S2 >= 0.5; the engine cut
 *     on every row, so it is right iff y_b = 1.
 *
 * Q3 LOST FAST NOTES (per ledger branch)
 *   Rows: every missed label, with the branch `classify` names.
 *   The model SEES a distinct note for a label when the onset activation of
 *     one of the label's pitch classes has a weak local maximum (the model's
 *     own `detect_event` rule) >= 0.5 at a frame within +-40ms of the label's
 *     start, and that frame is nearer this label's start than any other's.
 *     Anchor: the label's start + 40ms.
 *   False alarm, on MATCHED labels: such a maximum at the label's pitch
 *     classes inside its interior, [start + 70ms, min(end, next label's
 *     start) - 70ms] — an onset where no label is, which a recovery rule would
 *     turn into a split of a note the engine already has. Anchor: the
 *     interior's end + 40ms.
 *   BAR: in some branch holding at least 5 misses, the model sees at least
 *     half of them, deep reading, AND the false-alarm rate on matched labels
 *     is at most 2%.
 *   2x2 over all labels: engine right iff matched; model right iff it sees
 *     the label.
 *
 * Q4 PITCH (secondary; no bar)
 *   Rows: matched Notes whose label is a single note. The engine's final
 *     pitch and the model's (argmax key of the mean frame activation over the
 *     Note's frames, deep reading) against the label: exact and pitch class,
 *     by signal path and register (label below MIDI 60, or at or above).
 *     Chord labels: the share of the label's pitch classes among the model's
 *     keys at or above 0.5, reported only.
 *   2x2 on pitch class: engine right / model right.
 *
 * Every question: the 2x2 agreement table (only model right / only engine
 * right / both / neither) by signal path, and the deep-vs-full comparison.
 * A clean negative is a result; no bar moves after the numbers are read.
 * ============================================================================
 *
 * Usage (after build.sh):
 *   npx tsx training/hft-transformer/phase2.ts --stage derivation
 *   npx tsx training/hft-transformer/phase2.ts --stage heldout      # once
 * Model readings are cached under training/out/hft-transformer/reads/.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSamples } from "../../src/offline/analyzer.js";
import { projectEmissions } from "../../src/offline/eval-adapter.js";
import { acceptedAnswers, matchEvents, parseLabel, type LabeledEvent } from "../../src/offline/matcher.js";
import { downmixToMono, readWav } from "../../src/offline/wav.js";
import type { TrackerTraceEvent } from "../../src/engine/tracker/note-tracker.js";
import { DeepLane, type DeepRegionRequest } from "../../src/engine/deep/deep-lane.js";
import type { AudioRing } from "../../src/engine/ring-buffer.js";
import type { Note } from "../../src/types.js";
import { auc, collectFixture, FEATURES } from "../../scripts/measure-decision-separability.js";
import { classify, fatesOf } from "../../scripts/measure-downstream-ledger.js";
import { decodeFixtures } from "../../scripts/decode-fixtures.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const STAGE = arg("stage") ?? "derivation";
if (STAGE !== "derivation" && STAGE !== "heldout") throw new Error("--stage derivation|heldout");
const OUT = arg("dir") ?? "training/out/hft-transformer";
const BIN = join(OUT, "bin/hft-read");
const GGUF = join(OUT, "hf/hft-transformer-f32.gguf");
const THREADS = arg("threads") ?? "2";

const DERIVATION = [
  "chords-a-bm-g-d-2x-120bpm",
  "clean-lead-120bpm",
  "cowboy-chords-c-d-em-g-c-d-em-am-120bpm",
  "power-chords-c-a-g-e-c-d-fsharp-e-120bpm",
  "spicy-chords-cmaj9-g-am11",
  "same-pitch-quarters-a3-e5-120bpm-di",
  "same-pitch-quarters-a3-e5-120bpm-amped",
  "same-pitch-eighths-a3-120bpm-di",
  "same-pitch-eighths-a3-120bpm-amped",
  "same-pitch-eighths-sixteenths-e5-120bpm-di",
  "same-pitch-eighths-sixteenths-e5-120bpm-amped",
  "held-then-picked-six-strings-120bpm-di",
  "held-then-picked-six-strings-120bpm-amped",
  "rest-repick-g2-60-120bpm-di",
  "rest-repick-g2-60-120bpm-amped",
];
const HELDOUT = [
  "cowboy-chords-di-d-em-g-c-2x-140bpm",
  "cowboy-chords-amped-d-em-g-c-2x-140bpm",
  "cowboy-chords-mic-d-em-g-c-2x-140bpm",
  "lead-line-di-quarter-eighth-triplet-140bpm",
  "lead-line-amped-quarter-eighth-triplet-140bpm",
  "lead-line-quarter-eighth-triplet-140bpm",
  "lead-line-di-sixteenths-e-fsharp-140bpm",
  "lead-line-amped-sixteenths-e-fsharp-140bpm",
  "lead-line-sixteenths-e-fsharp-140bpm",
  "power-chords-di-b-a-g-fsharp-b-a-g-e-140bpm",
  "power-chords-amped-b-a-g-fsharp-b-a-g-e-140bpm",
  "power-chords-b-a-g-fsharp-b-a-g-e-140bpm",
];
const STEMS = STAGE === "derivation" ? DERIVATION : HELDOUT;

// ---------------------------------------------------------------------------
// Constants fixed in the header
// ---------------------------------------------------------------------------

const HOP_MS = 16;
const KEYS = 88;
const NF = 128;
const ONSET_WINDOW_MS = 40;
const LABEL_MARGIN_MS = 70;
const THRESHOLD = 0.5;
const Q1_BAR = 0.8;
const Q2_BAR = 0.698;
const Q3_RECALL = 0.5;
const Q3_MIN_BRANCH = 5;
const Q3_FA_MAX = 0.02;
const LOOKAHEAD_MS = 576;
const RING_SECONDS = 4;
const BOOTSTRAPS = 2000;

// ---------------------------------------------------------------------------
// Resampling: torchaudio.functional.resample(x, 48000, 16000) defaults
// ---------------------------------------------------------------------------

const RS_WIDTH = 19; // ceil(6 * 3 / 0.99)
const RS_KERNEL = (() => {
  const k = new Float64Array(2 * RS_WIDTH + 3);
  for (let i = 0; i < k.length; i++) {
    let t = ((i - RS_WIDTH) / 3) * 0.99;
    t = Math.max(-6, Math.min(6, t));
    const window = Math.cos((t * Math.PI) / 6 / 2) ** 2;
    t *= Math.PI;
    k[i] = (t === 0 ? 1 : Math.sin(t) / t) * window * (0.99 / 3);
  }
  return k;
})();

function resample48to16(x: Float32Array): Float32Array {
  const n = Math.ceil(x.length / 3);
  const out = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < RS_KERNEL.length; i++) {
      const src = 3 * j + i - RS_WIDTH;
      if (src >= 0 && src < x.length) s += (x[src] as number) * (RS_KERNEL[i] as number);
    }
    out[j] = s;
  }
  return out;
}
/** Last 48kHz sample (exclusive) a 16kHz sample j reads: 3j + 19. */
const end16For = (held48: number): number => Math.floor((held48 - RS_WIDTH) / 3) + 1;
const ring16For = (held48: number): number => {
  const first48 = held48 - RING_SECONDS * 48000;
  if (first48 <= 0) return 0;
  return Math.ceil(Math.ceil((first48 + RS_WIDTH - 1) / 3) / 256) * 256;
};

// ---------------------------------------------------------------------------
// Observing the deep lane's rulings
// ---------------------------------------------------------------------------

type Ruling = { fromSample: number; toSample: number; held: number; now: number };
let rulingSink: Ruling[] | null = null;
const originalDrain = DeepLane.prototype.drain;
DeepLane.prototype.drain = function drain(this: DeepLane, now: number, ring: AudioRing) {
  const lane = this as unknown as { pendingRegion: DeepRegionRequest | null };
  const pending = lane.pendingRegion;
  const out = originalDrain.call(this, now, ring);
  if (rulingSink !== null && pending !== null && pending.notBefore <= now) {
    rulingSink.push({ fromSample: pending.fromSample, toSample: pending.toSample, held: ring.writeIndex, now });
  }
  return out;
};

// ---------------------------------------------------------------------------
// Pitch helpers
// ---------------------------------------------------------------------------

const PCS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const pcIndex = (name: string): number => PCS.indexOf(name);
const QUALITY_PCS: Record<string, number[]> = {
  maj: [0, 4, 7], min: [0, 3, 7], "5": [0, 7], "7": [0, 4, 7, 10], m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11], maj9: [0, 4, 7, 11, 2], m9: [0, 3, 7, 10, 2], m11: [0, 3, 7, 10, 2, 5],
};

/** A label's pitch classes: its voicing when it lists one, else its name. */
function labelPcs(label: LabeledEvent): Set<number> {
  const out = new Set<number>();
  if (label.kind === "chord") {
    for (const p of label.pitches ?? []) {
      const parsed = parseLabel(p, "note");
      if (parsed.pitchClass !== null) out.add(pcIndex(parsed.pitchClass));
    }
    if (out.size === 0) {
      const parsed = parseLabel(label.label, "chord");
      if (parsed.pitchClass !== null) {
        const root = pcIndex(parsed.pitchClass);
        for (const iv of QUALITY_PCS[parsed.quality ?? "maj"] ?? [0]) out.add((root + iv) % 12);
      }
    }
  } else {
    for (const pc of acceptedAnswers(label).pitchClasses) out.add(pcIndex(pc));
  }
  return out;
}
/** A single-note label's MIDI number, or null. */
function labelMidi(label: LabeledEvent): number | null {
  if (label.kind === "chord") return null;
  for (const c of acceptedAnswers(label).canonical) {
    const parsed = parseLabel(c, "note");
    if (parsed.pitchClass !== null && parsed.octave !== null) return (parsed.octave + 1) * 12 + pcIndex(parsed.pitchClass);
  }
  return null;
}
/** A Note's pitch classes, from what it finally believed. Empty when it has no pitch. */
function notePcs(note: Note | undefined): Set<number> {
  const out = new Set<number>();
  if (note === undefined) return out;
  for (const p of note.harmony?.detectedPitches ?? []) out.add(((p.midi % 12) + 12) % 12);
  if (out.size === 0 && note.harmony?.root !== undefined) out.add(pcIndex(note.harmony.root));
  const single = note.pitch.current ?? note.origin.firstDetectedPitch;
  if (out.size === 0 && single !== null && single !== undefined) out.add(((single.midi % 12) + 12) % 12);
  return out;
}
const keysOf = (pcs: ReadonlySet<number>): number[] => {
  const keys: number[] = [];
  for (let k = 0; k < KEYS; k++) if (pcs.size === 0 || pcs.has((k + 21) % 12)) keys.push(k);
  return keys;
};

// ---------------------------------------------------------------------------
// Model readings
// ---------------------------------------------------------------------------

/** 128 answered frames from one deep-lane read, or the whole take. */
type Reading = {
  first: number; // global index of the first answered frame
  frames: number;
  onset: Float32Array; // frames x 88
  mpe: Float32Array;
};

function runBin(args: string[]): void {
  const r = spawnSync(BIN, args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`hft-read ${args[0]} failed: ${r.stderr}`);
}
const readF32 = (p: string): Float32Array => {
  const b = readFileSync(p);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

/**
 * One `hft-read take` per take: the FULL reading and every DEEP read, cached
 * by the hash of the read list.
 */
function readTake(stem: string, pcmPath: string, reads: Array<[number, number]>): { full: Reading; deep: Map<string, Reading> } {
  const spec = reads.map(([e, r]) => `${e} ${r}`).join("\n") + "\n";
  const tag = createHash("sha256").update(spec).digest("hex").slice(0, 16);
  const dir = join(OUT, "reads", stem);
  const prefix = join(dir, `take-${tag}`);
  if (!existsSync(`${prefix}.deep.bin`)) {
    writeFileSync(`${prefix}.reads.txt`, spec);
    runBin(["take", GGUF, pcmPath, `${prefix}.reads.txt`, prefix, THREADS]);
  }
  const onset = readF32(`${prefix}.onset.f32`);
  const full: Reading = { first: 0, frames: onset.length / KEYS, onset, mpe: readF32(`${prefix}.mpe.f32`) };
  return { full, deep: deepReadings(`${prefix}.deep.bin`, reads) };
}

function deepReadings(binPath: string, reads: Array<[number, number]>): Map<string, Reading> {
  const out = new Map<string, Reading>();
  const buf = readFileSync(binPath);
  const per = 4 + 4 * NF * KEYS * 4;
  if (buf.length !== per * reads.length) throw new Error(`${binPath}: ${buf.length} bytes, expected ${per * reads.length}`);
  reads.forEach(([e, r], i) => {
    const base = i * per;
    const slice = (h: number): Float32Array =>
      new Float32Array(buf.buffer.slice(buf.byteOffset + base + 4 + h * NF * KEYS * 4, buf.byteOffset + base + 4 + (h + 1) * NF * KEYS * 4));
    out.set(`${e} ${r}`, { first: buf.readInt32LE(base), frames: NF, onset: slice(0), mpe: slice(2) });
  });
  return out;
}

/** Value of a head at global frame f and key k, or NaN when the reading has no such frame. */
const at = (r: Reading, head: "onset" | "mpe", f: number, k: number): number => {
  const i = f - r.first;
  if (i < 0 || i >= r.frames) return NaN;
  return r[head][i * KEYS + k] as number;
};

/** Frames whose centres lie in [a, b] ms and that the reading answers. */
function framesIn(r: Reading, a: number, b: number): number[] {
  const out: number[] = [];
  for (let f = Math.ceil(a / HOP_MS); f * HOP_MS <= b; f++) if (f >= r.first && f < r.first + r.frames) out.push(f);
  return out;
}

/** Weak local maxima >= threshold (detect_event), at frames in [a, b], over keys. */
function peaks(r: Reading, keys: readonly number[], a: number, b: number): Array<{ f: number; k: number; v: number }> {
  const out: Array<{ f: number; k: number; v: number }> = [];
  for (const k of keys) {
    for (const f of framesIn(r, a, b)) {
      const v = at(r, "onset", f, k);
      if (!(v >= THRESHOLD)) continue;
      let left = true;
      for (let g = f - 1; g >= r.first; g--) {
        const w = at(r, "onset", g, k);
        if (v > w) break;
        if (v < w) {
          left = false;
          break;
        }
      }
      let right = true;
      for (let g = f + 1; g < r.first + r.frames; g++) {
        const w = at(r, "onset", g, k);
        if (v > w) break;
        if (v < w) {
          right = false;
          break;
        }
      }
      if (left && right) out.push({ f, k, v });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-take collection
// ---------------------------------------------------------------------------

type Path = "clean" | "DI" | "amp" | "mic";
const pathOf = (instrument: string | undefined): Path =>
  instrument === "guitar-di" ? "DI" : instrument === "guitar-amp-mic" ? "mic" : instrument === "guitar-clean" ? "clean" : "amp";

type Q1Row = { stem: string; path: Path; y: 0 | 1; deep: [number, number]; full: [number, number]; lookaheadMs: number };
type Q2Row = {
  stem: string; path: Path; yb: 0 | 1; yo: 0 | 1 | null; gatePassed: boolean;
  deep: number; full: number; lookaheadMs: number;
  sharpness: number; fluxRatio: number; dipRatio: number; spanOverIoi: number;
};
type Q3Miss = { stem: string; path: Path; branch: string; deep: boolean; full: boolean; lookaheadMs: number };
type Q3Hit = { stem: string; path: Path; seenDeep: boolean; seenFull: boolean; faDeep: boolean | null; faFull: boolean | null };
type Q4Row = { stem: string; path: Path; chord: boolean; low: boolean; engineExact: boolean | null; enginePc: boolean; modelExact: boolean | null; modelPc: boolean; chordPcShare: number | null };

const q1: Q1Row[] = [];
const q2: Q2Row[] = [];
const q3miss: Q3Miss[] = [];
const q3hit: Q3Hit[] = [];
const q4: Q4Row[] = [];
const rulingGaps: number[] = [];
let rulingCount = 0;

const fixtures = decodeFixtures({ quiet: true }).filter((f) => STEMS.includes(f.stem));
if (fixtures.length !== STEMS.length) throw new Error(`found ${fixtures.length} of ${STEMS.length} takes`);

for (const fixture of fixtures) {
  const t0 = Date.now();
  const path = pathOf(fixture.label.instrument);
  const wav = readWav(readFileSync(fixture.wavPath));
  const mono = downmixToMono(wav.samples, wav.channels);
  if (wav.sampleRate !== 48000) throw new Error(`${fixture.stem}: ${wav.sampleRate}Hz`);

  // ---- engine ----
  const events: TrackerTraceEvent[] = [];
  const rulings: Ruling[] = [];
  rulingSink = rulings;
  const analysis = analyzeSamples(mono, wav.sampleRate, { trackerTrace: (e) => events.push(e) });
  rulingSink = null;
  rulings.sort((a, b) => a.held - b.held);
  rulingCount += rulings.length;
  const detections = projectEmissions(analysis.emissions).final;
  const labels = fixture.label.events as LabeledEvent[];
  const result = matchEvents(labels, detections);
  const pairedIds = new Set(result.matches.map((m) => m.detection.id));
  const matchedLabelIds = new Set(result.matches.map((m) => m.label.id));
  const noteById = new Map(analysis.notes.map((n) => [n.id, n]));
  const fates = fatesOf(events, new Set(detections.map((d) => d.id)));

  /** The first ruling whose held audio passes `ms`; its (end16, ring16). */
  const deepKey = (ms: number): { key: string; read: [number, number]; lookaheadMs: number } => {
    const need = Math.ceil((ms / 1000) * 48000);
    const ruling = rulings.find((r) => r.held >= need) ?? rulings[rulings.length - 1];
    if (ruling === undefined) throw new Error(`${fixture.stem}: no deep ruling`);
    const read: [number, number] = [end16For(ruling.held), ring16For(ruling.held)];
    return { key: `${read[0]} ${read[1]}`, read, lookaheadMs: (ruling.held / 48000) * 1000 - ms };
  };

  // ---- rows, engine side; model reads collected as anchors ----
  const reads = new Map<string, [number, number]>();
  const later: Array<(deep: Map<string, Reading>, full: Reading) => void> = [];
  const anchor = (ms: number): { key: string; lookaheadMs: number } => {
    const d = deepKey(ms);
    reads.set(d.key, d.read);
    return { key: d.key, lookaheadMs: d.lookaheadMs };
  };

  // Q1 and Q4: emitted Notes.
  const pairOf = new Map(result.matches.map((m) => [m.detection.id, m.label]));
  for (const d of detections) {
    const start = d.startedAt;
    const end = d.endedAt !== null && d.endedAt > start ? d.endedAt : start;
    const a = anchor(end + ONSET_WINDOW_MS);
    const pcs = notePcs(noteById.get(d.id));
    const keys = keysOf(pcs);
    const y: 0 | 1 = pairedIds.has(d.id) ? 0 : 1;
    const label = pairOf.get(d.id);
    later.push((deep, full) => {
      const score = (r: Reading): [number, number] => {
        let frames = framesIn(r, start, end);
        if (frames.length === 0) {
          const f = Math.round(start / HOP_MS);
          frames = f >= r.first && f < r.first + r.frames ? [f] : [];
        }
        if (frames.length === 0) return [NaN, NaN];
        let sa = 0;
        let sb = 0;
        for (const f of frames) {
          let ma = 0;
          for (let k = 0; k < KEYS; k++) ma = Math.max(ma, at(r, "mpe", f, k));
          let mb = 0;
          for (const k of keys) mb = Math.max(mb, at(r, "mpe", f, k));
          sa += ma;
          sb += mb;
        }
        return [sa / frames.length, sb / frames.length];
      };
      const reading = deep.get(a.key);
      if (reading === undefined) throw new Error("missing deep reading");
      q1.push({ stem: fixture.stem, path, y, deep: score(reading), full: score(full), lookaheadMs: a.lookaheadMs });

      if (label !== undefined) {
        // Q4: the model's pitch over the Note's frames.
        const frames = framesIn(reading, start, end);
        const mean = new Float64Array(KEYS);
        for (const f of frames) for (let k = 0; k < KEYS; k++) mean[k] = (mean[k] as number) + at(reading, "mpe", f, k) / Math.max(1, frames.length);
        let best = 0;
        for (let k = 1; k < KEYS; k++) if ((mean[k] as number) > (mean[best] as number)) best = k;
        const note = noteById.get(d.id);
        const engineMidi = note?.pitch.current?.midi ?? note?.origin.firstDetectedPitch?.midi ?? null;
        const lp = labelPcs(label);
        const lm = labelMidi(label);
        if (label.kind === "chord" && frames.length > 0) {
          let hit = 0;
          for (const pc of lp) if ([...Array(KEYS).keys()].some((k) => (k + 21) % 12 === pc && (mean[k] as number) >= THRESHOLD)) hit++;
          const enginePcs = notePcs(note);
          q4.push({
            stem: fixture.stem, path, chord: true, low: false, engineExact: null,
            enginePc: [...lp].some((pc) => enginePcs.has(pc)), modelExact: null,
            modelPc: lp.has((best + 21) % 12), chordPcShare: lp.size > 0 ? hit / lp.size : null,
          });
        } else if (label.kind !== "chord" && lm !== null && frames.length > 0) {
          q4.push({
            stem: fixture.stem, path, chord: false, low: lm < 60,
            engineExact: engineMidi === null ? false : engineMidi === lm,
            enginePc: engineMidi === null ? false : ((engineMidi % 12) + 12) % 12 === lm % 12,
            modelExact: best + 21 === lm, modelPc: (best + 21) % 12 === lm % 12, chordPcShare: null,
          });
        }
      }
    });
  }

  // Q2: same-pitch cuts.
  const rows = collectFixture(fixture.stem, labels, events, matchedLabelIds, pairedIds);
  const dipByKey = new Map<string, number>();
  for (const e of events) if (e.kind === "rearticulation") dipByKey.set(`${e.at}|${e.noteId}`, e.dipRatio);
  const pitchDiffersCol = FEATURES.indexOf("pitchDiffers");
  for (const row of rows) {
    if (!row.accepted || !row.settled || row.x[pitchDiffersCol] !== 0) continue;
    const t = row.at;
    const a = anchor(t + ONSET_WINDOW_MS);
    let pcs = notePcs(noteById.get(row.noteId));
    if (pcs.size === 0 && row.childId) pcs = notePcs(noteById.get(row.childId));
    const keys = keysOf(pcs);
    const child = row.childId ? fates.get(row.childId) : undefined;
    const localIoi = row.rhythm?.[0] ?? NaN;
    later.push((deep, full) => {
      const s2 = (r: Reading): number => {
        let m = 0;
        for (const f of framesIn(r, t - ONSET_WINDOW_MS, t + ONSET_WINDOW_MS)) for (const k of keys) m = Math.max(m, at(r, "onset", f, k));
        return m;
      };
      const reading = deep.get(a.key);
      if (reading === undefined) throw new Error("missing deep reading");
      q2.push({
        stem: fixture.stem, path, yb: row.y,
        yo: row.childPaired === null || row.childPaired === undefined ? null : row.childPaired ? 0 : 1,
        gatePassed: child?.announced === true, deep: s2(reading), full: s2(full), lookaheadMs: a.lookaheadMs,
        sharpness: row.x[FEATURES.indexOf("sharpness")] as number,
        fluxRatio: row.x[FEATURES.indexOf("fluxRatio")] as number,
        dipRatio: dipByKey.get(`${row.at}|${row.noteId}`) ?? NaN,
        spanOverIoi: child !== undefined && Number.isFinite(localIoi) && localIoi > 0 ? child.soundedMs / localIoi : NaN,
      });
    });
  }

  // Q3: missed labels by branch; matched labels for the false-alarm rate.
  const spokenFor = new Set(result.matches.map((m) => m.detection.id));
  const starts = labels.map((l) => l.startMs);
  const sorted = [...labels].sort((x, y) => x.startMs - y.startMs);
  const sees = (r: Reading, label: LabeledEvent): boolean => {
    const keys = keysOf(labelPcs(label));
    for (const p of peaks(r, keys, label.startMs - ONSET_WINDOW_MS, label.startMs + ONSET_WINDOW_MS)) {
      const tp = p.f * HOP_MS;
      const nearest = starts.every((s) => Math.abs(s - label.startMs) < 1 || Math.abs(tp - label.startMs) <= Math.abs(tp - s));
      if (nearest) return true;
    }
    return false;
  };
  for (const miss of result.missed) {
    const label = miss.label;
    const cause = classify(label.startMs, events, fates, spokenFor, starts);
    const a = anchor(label.startMs + ONSET_WINDOW_MS);
    later.push((deep, full) => {
      const reading = deep.get(a.key);
      if (reading === undefined) throw new Error("missing deep reading");
      q3miss.push({ stem: fixture.stem, path, branch: cause.cause, deep: sees(reading, label), full: sees(full, label), lookaheadMs: a.lookaheadMs });
    });
  }
  for (const m of result.matches) {
    const label = m.label;
    const next = sorted.find((l) => l.startMs > label.startMs + 1);
    const lo = label.startMs + LABEL_MARGIN_MS;
    const hi = Math.min(label.endMs, next?.startMs ?? Infinity) - LABEL_MARGIN_MS;
    const aSee = anchor(label.startMs + ONSET_WINDOW_MS);
    const aFa = hi > lo ? anchor(hi + ONSET_WINDOW_MS) : null;
    later.push((deep, full) => {
      const rs = deep.get(aSee.key);
      const rf = aFa === null ? undefined : deep.get(aFa.key);
      if (rs === undefined) throw new Error("missing deep reading");
      const keys = keysOf(labelPcs(label));
      const fa = (r: Reading | undefined): boolean | null => (aFa === null || r === undefined ? null : peaks(r, keys, lo, hi).length > 0);
      q3hit.push({ stem: fixture.stem, path, seenDeep: sees(rs, label), seenFull: sees(full, label), faDeep: fa(rf), faFull: fa(full) });
    });
  }

  // ---- model ----
  const pcmDir = join(OUT, "reads", fixture.stem);
  mkdirSync(pcmDir, { recursive: true });
  const pcmPath = join(pcmDir, "pcm16k.f32");
  if (!existsSync(pcmPath)) writeFileSync(pcmPath, Buffer.from(resample48to16(mono).buffer));
  const readList = [...reads.values()].sort((x, y) => x[0] - y[0]);
  const { full, deep } = readTake(fixture.stem, pcmPath, readList);
  for (const f of later) f(deep, full);
  for (let i = 1; i < rulings.length; i++) rulingGaps.push(((rulings[i] as Ruling).held - (rulings[i - 1] as Ruling).held) / 48);
  process.stderr.write(
    `${fixture.stem}: ${rulings.length} rulings, ${readList.length} deep reads, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`,
  );
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** AUC of `score` for y = 1 over y = 0, NaN scores dropped. */
function aucOf(score: number[], y: number[]): { auc: number; n: number; pos: number } {
  const s: number[] = [];
  const t: number[] = [];
  score.forEach((v, i) => {
    if (Number.isFinite(v)) {
      s.push(v);
      t.push(y[i] as number);
    }
  });
  const pos = t.filter((v) => v === 1).length;
  return { auc: auc(s, t), n: s.length, pos };
}
/** Class-stratified bootstrap 95% interval of the AUC. */
function bootstrap(score: number[], y: number[]): [number, number] {
  const rnd = mulberry32(20260925);
  const pos = score.map((v, i) => [v, y[i] as number] as const).filter(([v, c]) => Number.isFinite(v) && c === 1);
  const neg = score.map((v, i) => [v, y[i] as number] as const).filter(([v, c]) => Number.isFinite(v) && c === 0);
  if (pos.length === 0 || neg.length === 0) return [NaN, NaN];
  const out: number[] = [];
  for (let b = 0; b < BOOTSTRAPS; b++) {
    const s: number[] = [];
    const t: number[] = [];
    for (let i = 0; i < pos.length; i++) {
      const p = pos[Math.floor(rnd() * pos.length)] as readonly [number, number];
      s.push(p[0]);
      t.push(1);
    }
    for (let i = 0; i < neg.length; i++) {
      const p = neg[Math.floor(rnd() * neg.length)] as readonly [number, number];
      s.push(p[0]);
      t.push(0);
    }
    out.push(auc(s, t));
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * BOOTSTRAPS)] as number, out[Math.floor(0.975 * BOOTSTRAPS)] as number];
}
const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : "  -  ");
const pct = (a: number, b: number): string => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "-");

type Cell = { onlyModel: number; onlyEngine: number; both: number; neither: number };
function twoByTwo<T extends { path: Path }>(rows: T[], model: (r: T) => boolean, engine: (r: T) => boolean): void {
  const paths: Array<Path | "all"> = ["clean", "DI", "amp", "mic", "all"];
  console.log(`    ${"path".padEnd(6)} ${"only model".padStart(11)} ${"only engine".padStart(12)} ${"both".padStart(6)} ${"neither".padStart(8)} ${"rows".padStart(6)}`);
  for (const p of paths) {
    const sel = rows.filter((r) => p === "all" || r.path === p);
    if (sel.length === 0) continue;
    const c: Cell = { onlyModel: 0, onlyEngine: 0, both: 0, neither: 0 };
    for (const r of sel) {
      const m = model(r);
      const e = engine(r);
      if (m && e) c.both++;
      else if (m) c.onlyModel++;
      else if (e) c.onlyEngine++;
      else c.neither++;
    }
    console.log(`    ${p.padEnd(6)} ${String(c.onlyModel).padStart(11)} ${String(c.onlyEngine).padStart(12)} ${String(c.both).padStart(6)} ${String(c.neither).padStart(8)} ${String(sel.length).padStart(6)}`);
  }
}
function lookahead(rows: Array<{ lookaheadMs: number }>): string {
  const v = rows.map((r) => r.lookaheadMs).sort((a, b) => a - b);
  if (v.length === 0) return "-";
  const q = (p: number): number => v[Math.min(v.length - 1, Math.floor(p * v.length))] as number;
  const short = v.filter((x) => x < LOOKAHEAD_MS).length;
  return `audio held past the anchor at the ruling: median ${q(0.5).toFixed(0)}ms (p10 ${q(0.1).toFixed(0)}, p90 ${q(0.9).toFixed(0)}); ${pct(short, v.length)} of rows under the model's ${LOOKAHEAD_MS}ms`;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const title = STAGE === "derivation" ? "DERIVATION (15 takes)" : "HELD OUT (12 takes, read once)";
console.log(`\n==== hFT-Transformer, Phase 2, ${title} ====`);
console.log(`deep-lane rulings: ${rulingCount}; median spacing ${f3((rulingGaps.sort((a, b) => a - b)[Math.floor(rulingGaps.length / 2)] ?? NaN) / 1000)}s`);

// Q1
console.log("\nQ1 GHOSTS (outcome: is this emitted Note surplus?), AUC = P(paired scores above extra)");
{
  const y = q1.map((r) => (r.y === 1 ? 0 : 1)); // 1 = paired, the class the score should rank higher
  console.log(`  rows ${q1.length}: ${q1.filter((r) => r.y === 0).length} paired, ${q1.filter((r) => r.y === 1).length} extra; ${lookahead(q1)}`);
  for (const [name, i] of [["S1a sounding", 0], ["S1b pitch agreement", 1]] as const) {
    const d = aucOf(q1.map((r) => r.deep[i]), y);
    const ci = bootstrap(q1.map((r) => r.deep[i]), y);
    const fl = aucOf(q1.map((r) => r.full[i]), y);
    console.log(`  ${name.padEnd(20)} deep ${f3(d.auc)} [${f3(ci[0])}, ${f3(ci[1])}] n=${d.n}   full ${f3(fl.auc)}   bar ${Q1_BAR}: ${d.auc >= Q1_BAR ? "PASS" : "fail"}`);
    for (const p of ["clean", "DI", "amp", "mic"] as Path[]) {
      const sel = q1.filter((r) => r.path === p);
      if (sel.length === 0) continue;
      const a = aucOf(sel.map((r) => r.deep[i]), sel.map((r) => (r.y === 1 ? 0 : 1)));
      console.log(`      ${p.padEnd(6)} deep ${f3(a.auc)} (${sel.filter((r) => r.y === 0).length} paired / ${sel.filter((r) => r.y === 1).length} extra)`);
    }
  }
  console.log("  2x2, S1b >= 0.5 says \"real\"; the engine is right on a paired Note:");
  twoByTwo(q1, (r) => (r.deep[1] >= THRESHOLD) === (r.y === 0), (r) => r.y === 0);
}

// Q2
console.log("\nQ2 SAME-PITCH SPLITS (boundary target y_b primary; outcome y_o beside it, not compared)");
{
  const yb = q2.map((r) => r.yb as number);
  const d = aucOf(q2.map((r) => r.deep), yb);
  const ci = bootstrap(q2.map((r) => r.deep), yb);
  const fl = aucOf(q2.map((r) => r.full), yb);
  console.log(`  rows ${q2.length}: ${q2.filter((r) => r.yb === 1).length} y_b=1; ${q2.filter((r) => r.gatePassed).length} gate-passed; ${lookahead(q2)}`);
  console.log(`  (i)  S2 on y_b, all rows:        deep ${f3(d.auc)} [${f3(ci[0])}, ${f3(ci[1])}]   full ${f3(fl.auc)}   bar > ${Q2_BAR}: ${d.auc > Q2_BAR ? "PASS" : "fail"}`);
  const g = q2.filter((r) => r.gatePassed);
  const gd = aucOf(g.map((r) => r.deep), g.map((r) => r.yb));
  const gci = bootstrap(g.map((r) => r.deep), g.map((r) => r.yb));
  const gf = aucOf(g.map((r) => r.full), g.map((r) => r.yb));
  console.log(`  (ii) S2 on y_b, gate-passed:     deep ${f3(gd.auc)} [${f3(gci[0])}, ${f3(gci[1])}] n=${gd.n} (${gd.pos} y_b=1)   full ${f3(gf.auc)}   bar lower bound > 0.5: ${gci[0] > 0.5 ? "PASS" : "fail"}`);
  const o = q2.filter((r) => r.yo !== null);
  const od = aucOf(o.map((r) => r.deep), o.map((r) => (r.yo === 1 ? 0 : 1)));
  const og = o.filter((r) => r.gatePassed);
  const ogd = aucOf(og.map((r) => r.deep), og.map((r) => (r.yo === 1 ? 0 : 1)));
  console.log(`  outcome y_o (child paired ranks higher): all ${f3(od.auc)} n=${od.n}; gate-passed ${f3(ogd.auc)} n=${ogd.n}`);
  console.log("  the engine's own witnesses on the same rows, y_b / y_o (child paired ranks higher):");
  for (const [name, get] of [
    ["sharpness", (r: Q2Row) => r.sharpness], ["fluxRatio", (r: Q2Row) => r.fluxRatio],
    ["-dipRatio", (r: Q2Row) => -r.dipRatio], ["spanOverIoi", (r: Q2Row) => r.spanOverIoi],
  ] as const) {
    const b = aucOf(q2.map(get), yb);
    const oo = aucOf(o.map(get), o.map((r) => (r.yo === 1 ? 0 : 1)));
    const gb = aucOf(g.map(get), g.map((r) => r.yb));
    console.log(`    ${name.padEnd(12)} y_b ${f3(b.auc)} (gate-passed ${f3(gb.auc)})   y_o ${f3(oo.auc)}`);
  }
  for (const p of ["clean", "DI", "amp", "mic"] as Path[]) {
    const sel = q2.filter((r) => r.path === p);
    if (sel.length === 0) continue;
    const a = aucOf(sel.map((r) => r.deep), sel.map((r) => r.yb));
    console.log(`    ${p.padEnd(6)} S2 deep on y_b ${f3(a.auc)} (${a.pos} y_b=1 of ${a.n})`);
  }
  console.log("  2x2, S2 >= 0.5 says \"new articulation\"; the engine cut every row, right iff y_b = 1:");
  twoByTwo(q2, (r) => (r.deep >= THRESHOLD) === (r.yb === 1), (r) => r.yb === 1);
}

// Q3
console.log("\nQ3 LOST FAST NOTES (missed labels by ledger branch)");
{
  console.log(`  misses ${q3miss.length}; matched labels ${q3hit.length}; ${lookahead(q3miss)}`);
  const branches = new Map<string, Q3Miss[]>();
  for (const m of q3miss) branches.set(m.branch, [...(branches.get(m.branch) ?? []), m]);
  const faRows = q3hit.filter((r) => r.faDeep !== null);
  const faDeep = faRows.filter((r) => r.faDeep === true).length;
  const faFull = q3hit.filter((r) => r.faFull === true).length;
  const faRate = faRows.length > 0 ? faDeep / faRows.length : NaN;
  console.log(`  false alarms on matched labels (an onset inside the interior): deep ${faDeep} of ${faRows.length} = ${pct(faDeep, faRows.length)} (bar <= ${Q3_FA_MAX * 100}%), full ${faFull}`);
  console.log(`  matched labels the model also sees: deep ${pct(q3hit.filter((r) => r.seenDeep).length, q3hit.length)}, full ${pct(q3hit.filter((r) => r.seenFull).length, q3hit.length)}`);
  let pass = false;
  for (const [branch, rows] of [...branches.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const seen = rows.filter((r) => r.deep).length;
    const ok = rows.length >= Q3_MIN_BRANCH && seen / rows.length >= Q3_RECALL;
    if (ok && faRate <= Q3_FA_MAX) pass = true;
    console.log(`    ${branch.padEnd(58)} ${String(rows.length).padStart(4)} misses, model sees ${String(seen).padStart(3)} deep (${pct(seen, rows.length)}), ${String(rows.filter((r) => r.full).length).padStart(3)} full${ok ? "  <- recall bar" : ""}`);
  }
  console.log(`  BAR (a branch of >= ${Q3_MIN_BRANCH} with >= ${Q3_RECALL * 100}% seen, and false alarms <= ${Q3_FA_MAX * 100}%): ${pass ? "PASS" : "fail"}`);
  console.log("  2x2 over all labels, the engine right iff matched, the model right iff it sees the label:");
  const all = [
    ...q3miss.map((m) => ({ path: m.path, model: m.deep, engine: false })),
    ...q3hit.map((h) => ({ path: h.path, model: h.seenDeep, engine: true })),
  ];
  twoByTwo(all, (r) => r.model, (r) => r.engine);
}

// Q4
console.log("\nQ4 PITCH (secondary, no bar): matched Notes, deep reading");
{
  const single = q4.filter((r) => !r.chord);
  const line = (name: string, rows: Q4Row[]): void => {
    if (rows.length === 0) return;
    const ee = rows.filter((r) => r.engineExact === true).length;
    const ep = rows.filter((r) => r.enginePc).length;
    const me = rows.filter((r) => r.modelExact === true).length;
    const mp = rows.filter((r) => r.modelPc).length;
    console.log(`    ${name.padEnd(22)} n=${String(rows.length).padStart(5)}  exact engine ${pct(ee, rows.length).padStart(6)} model ${pct(me, rows.length).padStart(6)}   pitch class engine ${pct(ep, rows.length).padStart(6)} model ${pct(mp, rows.length).padStart(6)}`);
  };
  line("single notes, all", single);
  for (const p of ["clean", "DI", "amp", "mic"] as Path[]) line(`  ${p}`, single.filter((r) => r.path === p));
  line("  below MIDI 60", single.filter((r) => r.low));
  line("  MIDI 60 and up", single.filter((r) => !r.low));
  const chords = q4.filter((r) => r.chord);
  if (chords.length > 0) {
    const share = chords.map((r) => r.chordPcShare ?? NaN).filter(Number.isFinite);
    console.log(`    chords n=${chords.length}: mean share of the label's pitch classes the model holds >= 0.5: ${f3(share.reduce((a, b) => a + b, 0) / Math.max(1, share.length))}`);
  }
  console.log("  2x2 on pitch class, single notes:");
  twoByTwo(single, (r) => r.modelPc, (r) => r.enginePc);
}

writeFileSync(join(OUT, `rows-${STAGE}.json`), JSON.stringify({ q1, q2, q3miss, q3hit, q4 }));
console.log(`\nrows written to ${join(OUT, `rows-${STAGE}.json`)}`);
