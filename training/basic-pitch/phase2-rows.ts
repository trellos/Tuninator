/**
 * Phase 2 rows: the engine's own decisions on each take, and the model read at
 * each one's decision points. The definitions are `phase2.ts`'s header, which
 * was committed before this ran; this file only implements them.
 *
 * Per take: the real recognizer (`engine-run.ts`, asserted identical to
 * `src/offline/analyzer.ts`), its trace, its final Notes and the matcher's
 * pairing; the ledger's branch for every missed label
 * (`scripts/measure-downstream-ledger.ts` `classify`); the boundary-shaped
 * decision rows (`scripts/measure-decision-separability.ts` `collectFixture`).
 * Then the engine's 48kHz audio, downmixed as the engine does, resampled to
 * 22050Hz, and one causal model window per distinct decision time
 * (`causal.ts`), plus the package's whole-take reading.
 *
 * Writes one JSON file per take under <dir>/rows/ (derivation) or
 * <dir>/rows-heldout/ (--heldout). The held-out set is read ONCE: with
 * --heldout this refuses to run if that directory already holds rows.
 *
 * Usage:
 *   npx tsx training/basic-pitch/phase2-rows.ts --dir training/out/basic-pitch [--heldout] [--only <stem>]
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TrackerTraceEvent } from "../../src/engine/tracker/note-tracker.js";
import type { LabeledEvent } from "../../src/offline/matcher.js";
import { decodeFixtures } from "../../scripts/decode-fixtures.js";
import { FEATURES, collectFixture } from "../../scripts/measure-decision-separability.js";
import { classify, fatesOf } from "../../scripts/measure-downstream-ledger.js";
import { BARS } from "./phase2.js";
import { causalWindow } from "./causal.js";
import { DERIVATION, checkParity, isHeldOut, runTake, type TakeRun } from "./engine-run.js";
import {
  bassMidi,
  causalFrames,
  dominantMidi,
  localOnsetPeak,
  meanNotes,
  midiOf,
  onsetAt,
  pitchSet,
  soundingOver,
  wholeFrames,
  type Frames,
} from "./features.js";
import { SAMPLE_RATE, posteriorgram } from "./framing.js";
import { resample } from "./resample.js";
import { loadModel, type Model } from "./runtime.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const dir = arg("dir");
if (!dir) {
  console.error("usage: npx tsx training/basic-pitch/phase2-rows.ts --dir <dir> [--heldout] [--only <stem>]");
  process.exit(2);
}
const heldout = process.argv.includes("--heldout");
const only = arg("only");
const outDir = join(dir, heldout ? "rows-heldout" : "rows");
if (heldout && existsSync(outDir) && readdirSync(outDir).some((f) => f.endsWith(".json")) && only === undefined) {
  console.error(`${outDir} already holds held-out rows. The held-out takes are read once; not re-reading them.`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const W = BARS.windowMs;
const DEEP = BARS.deepDelayMs;
const SPAN = BARS.maxSpanMs;

/* ---- pitch sets -------------------------------------------------------------- */

/** An engine Note's pitch set from its final label: one pitch class, or everything. */
function noteSet(label: string): { ps: number[]; midi: number | null } {
  const m = midiOf(label);
  return m === null ? { ps: pitchSet(null), midi: null } : { ps: pitchSet([m]), midi: m };
}

/** A label's pitch set: its listed pitches, else its name as a note, else everything. */
function labelSet(l: LabeledEvent): { ps: number[]; midis: number[] } {
  const listed = (l.pitches ?? []).map(midiOf).filter((m): m is number => m !== null);
  if (listed.length > 0) return { ps: pitchSet(listed), midis: listed };
  const own = midiOf(l.label);
  if (own !== null) return { ps: pitchSet([own]), midis: [own] };
  return { ps: pitchSet(null), midis: [] };
}

/* ---- requests: a decision time and what to read there ---------------------- */

type Request = { at: number; read: (fr: Frames) => void };

async function serve(model: Model, audio: Float32Array, requests: Request[]): Promise<number> {
  const byTime = new Map<number, Request[]>();
  for (const r of requests) {
    const key = Math.round(r.at * 10) / 10;
    const list = byTime.get(key) ?? [];
    list.push(r);
    byTime.set(key, list);
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);
  const BATCH = 8;
  for (let i = 0; i < times.length; i += BATCH) {
    const batch = times.slice(i, i + BATCH);
    const outs = await model.run(batch.map((t) => causalWindow(audio, t)));
    outs.forEach((o, j) => {
      const t = batch[j] as number;
      const fr = causalFrames(o, t);
      for (const r of byTime.get(t) ?? []) r.read(fr);
    });
  }
  return times.length;
}

/* ---- rows ------------------------------------------------------------------ */

type Q1Row = {
  id: string;
  label: string;
  startMs: number;
  endMs: number;
  announceMs: number | null;
  y: 0 | 1; // 1 = extra (surplus)
  midi: number | null;
  O_fast: number;
  N_fast: number;
  P_fast: number;
  O_deep: number;
  N_deep: number;
  P_deep: number;
  O_whole: number;
  N_whole: number;
  P_whole: number;
};

type Q2Row = {
  atMs: number;
  noteId: string;
  childId: string;
  childStartMs: number;
  parentLabel: string | null;
  yBoundary: 0 | 1;
  childEmitted: boolean;
  childPaired: boolean;
  childAnnounceMs: number | null;
  sharpness: number;
  fluxRatio: number;
  dipRatio: number;
  localIoiMs: number | null;
  childSoundedMs: number | null;
  O_fast: number;
  O_deep: number;
  O_whole: number;
  O_fastB: number;
};

type Q3Row = {
  id: string;
  label: string;
  kind: string;
  startMs: number;
  endMs: number;
  matched: boolean;
  branch: string | null;
  seen_deep: number;
  seen_whole: number;
  interiorMs: number | null;
  interior_deep: number;
  interior_whole: number;
};

type Q4Row = {
  id: string;
  label: string;
  kind: string;
  labelMidi: number | null; // lowest listed pitch, or the note
  rootPc: number | null; // chord root, from the label name
  engineExact: boolean;
  enginePc: boolean;
  modelDominant: number | null;
  modelBass: number | null;
};

export type TakeRows = {
  stem: string;
  path: string;
  heldout: boolean;
  labels: number;
  detections: number;
  windows: number;
  q1: Q1Row[];
  q2: Q2Row[];
  q3: Q3Row[];
  q4: Q4Row[];
};

function rootPcOf(label: string): number | null {
  const m = /^([A-G])([#b]?)/.exec(label.trim());
  if (m === null) return null;
  let pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as "C"] as number;
  if (m[2] === "#") pc += 1;
  if (m[2] === "b") pc -= 1;
  return ((pc % 12) + 12) % 12;
}

async function collectTake(model: Model, run: TakeRun): Promise<TakeRows> {
  const audio = resample(run.mono, run.sampleRate, SAMPLE_RATE);
  const whole = wholeFrames(await posteriorgram(model, audio));
  const requests: Request[] = [];

  // When each Note was announced (its `started` emission).
  const announced = new Map<string, number>();
  run.emissions.forEach((e, i) => {
    if (e.type === "started" && !announced.has(e.note.id)) announced.set(e.note.id, run.emittedAtMs[i] as number);
  });
  const detById = new Map(run.detections.map((d) => [d.id, d]));

  /* Q1 ---------------------------------------------------------------------- */
  const matchedIds = new Set(run.match.matches.map((m) => m.detection.id));
  const extraIds = new Set(run.match.falsePositives.map((f) => f.detection.id));
  const q1: Q1Row[] = [];
  for (const d of run.detections) {
    if (!matchedIds.has(d.id) && !extraIds.has(d.id)) continue; // paired with an optional label
    const s = d.startedAt;
    const e = d.endedAt !== null && d.endedAt > s ? d.endedAt : s + 1;
    const { ps, midi } = noteSet(d.label.name);
    const row: Q1Row = {
      id: d.id,
      label: d.label.name,
      startMs: s,
      endMs: e,
      announceMs: announced.get(d.id) ?? null,
      y: extraIds.has(d.id) ? 1 : 0,
      midi,
      O_fast: NaN,
      N_fast: NaN,
      P_fast: NaN,
      O_deep: NaN,
      N_deep: NaN,
      P_deep: NaN,
      O_whole: onsetAt(whole, s, ps, W),
      N_whole: soundingOver(whole, s, e, ps),
      P_whole: NaN,
    };
    const agree = (fr: Frames, a: number, b: number): number => {
      if (midi === null) return NaN;
      const dom = dominantMidi(meanNotes(fr, a, b));
      return dom === null ? NaN : dom % 12 === midi % 12 ? 1 : 0;
    };
    row.P_whole = agree(whole, s, e);
    const a = row.announceMs;
    if (a !== null) {
      requests.push({
        at: a,
        read: (fr) => {
          row.O_fast = onsetAt(fr, s, ps, W);
          row.N_fast = soundingOver(fr, s, a, ps);
          row.P_fast = agree(fr, s, a);
        },
      });
    }
    requests.push({ at: s + DEEP, read: (fr) => (row.O_deep = onsetAt(fr, s, ps, W)) });
    const spanEnd = Math.min(e, s + SPAN);
    requests.push({
      at: spanEnd + DEEP,
      read: (fr) => {
        row.N_deep = soundingOver(fr, s, spanEnd, ps);
        row.P_deep = agree(fr, s, spanEnd);
      },
    });
    q1.push(row);
  }

  /* Q2 ---------------------------------------------------------------------- */
  const matchedLabels = new Set(run.match.matches.map((m) => m.label.id));
  const pairedDetections = new Set(run.match.matches.map((m) => m.detection.id));
  const decisionRows = collectFixture(run.stem, run.labels, run.events, matchedLabels, pairedDetections);
  const opened = new Map<string, number>();
  const ended = new Map<string, Extract<TrackerTraceEvent, { kind: "ended" }>>();
  for (const ev of run.events) {
    if (ev.kind === "opened") opened.set(ev.noteId, ev.at);
    else if (ev.kind === "ended") ended.set(ev.noteId, ev);
  }
  const rearts = run.events.filter(
    (e): e is Extract<TrackerTraceEvent, { kind: "rearticulation" }> => e.kind === "rearticulation",
  );
  const iPitch = FEATURES.indexOf("pitchDiffers");
  const iSharp = FEATURES.indexOf("sharpness");
  const iFlux = FEATURES.indexOf("fluxRatio");
  const q2: Q2Row[] = [];
  for (const r of decisionRows) {
    if (!r.accepted || !r.settled || (r.x[iPitch] as number) !== 0) continue;
    if (r.childId === null || r.childId === undefined) continue;
    const childId = r.childId;
    const s = opened.get(childId);
    if (s === undefined) continue;
    const ev = rearts.find((e) => Math.abs(e.at - r.at) < 1e-6 && e.noteId === r.noteId);
    const parentLabel = detById.get(r.noteId)?.label.name ?? detById.get(childId)?.label.name ?? null;
    const { ps } = noteSet(parentLabel ?? "unknown");
    const row: Q2Row = {
      atMs: r.at,
      noteId: r.noteId,
      childId,
      childStartMs: s,
      parentLabel,
      yBoundary: r.y,
      childEmitted: detById.has(childId),
      childPaired: r.childPaired === true,
      childAnnounceMs: announced.get(childId) ?? null,
      sharpness: r.x[iSharp] as number,
      fluxRatio: r.x[iFlux] as number,
      dipRatio: ev?.dipRatio ?? NaN,
      localIoiMs: ev?.localIoiMs ?? null,
      childSoundedMs: ended.get(childId)?.soundedMs ?? null,
      O_fast: NaN,
      O_deep: NaN,
      O_whole: onsetAt(whole, s, ps, W),
      O_fastB: NaN,
    };
    requests.push({ at: r.at, read: (fr) => (row.O_fast = onsetAt(fr, s, ps, W)) });
    requests.push({ at: s + DEEP, read: (fr) => (row.O_deep = onsetAt(fr, s, ps, W)) });
    if (row.childEmitted && row.childAnnounceMs !== null) {
      requests.push({ at: row.childAnnounceMs, read: (fr) => (row.O_fastB = onsetAt(fr, s, ps, W)) });
    }
    q2.push(row);
  }

  /* Q3 and Q4 ----------------------------------------------------------------- */
  const starts = run.labels.map((l) => l.startMs).sort((a, b) => a - b);
  const fates = fatesOf(run.events, new Set(run.detections.map((d) => d.id)));
  const spokenFor = new Set(run.match.matches.map((m) => m.detection.id));
  const missed = new Set(run.match.missed.map((m) => m.label.id));
  const matchByLabel = new Map(run.match.matches.map((m) => [m.label.id, m]));
  const q3: Q3Row[] = [];
  const q4: Q4Row[] = [];
  for (const l of run.labels) {
    const isMissed = missed.has(l.id);
    const match = matchByLabel.get(l.id);
    if (!isMissed && match === undefined) continue; // an optional label
    const { ps, midis } = labelSet(l);
    const L = l.startMs;
    const nearest = (t: number): boolean => {
      for (const o of starts) {
        if (Math.abs(o - L) < 1e-6) continue;
        if (Math.abs(t - o) < Math.abs(t - L)) return false;
      }
      return true;
    };
    const next = starts.find((o) => o > L + 1e-6);
    const interiorEnd = Math.min(l.endMs, next ?? Number.POSITIVE_INFINITY) - W;
    const interiorStart = L + W;
    const hasInterior = interiorEnd - interiorStart >= 12;
    const iEnd = Math.min(interiorEnd, interiorStart + SPAN);
    const row: Q3Row = {
      id: l.id,
      label: l.label,
      kind: l.kind,
      startMs: L,
      endMs: l.endMs,
      matched: !isMissed,
      branch: isMissed
        ? classify(L, run.events, fates, spokenFor, run.labels.map((x) => x.startMs)).cause
        : null,
      seen_deep: NaN,
      seen_whole: localOnsetPeak(whole, L - W, L + W, ps, nearest),
      interiorMs: hasInterior ? iEnd - interiorStart : null,
      interior_deep: NaN,
      interior_whole: hasInterior ? localOnsetPeak(whole, interiorStart, iEnd, ps) : NaN,
    };
    requests.push({ at: L + DEEP, read: (fr) => (row.seen_deep = localOnsetPeak(fr, L - W, L + W, ps, nearest)) });
    if (hasInterior && !isMissed) {
      requests.push({ at: iEnd + DEEP, read: (fr) => (row.interior_deep = localOnsetPeak(fr, interiorStart, iEnd, ps)) });
    }
    q3.push(row);

    if (match !== undefined) {
      const spanEnd = Math.min(l.endMs, L + SPAN);
      const q4row: Q4Row = {
        id: l.id,
        label: l.label,
        kind: l.kind,
        labelMidi: midis.length > 0 ? Math.min(...midis) : null,
        rootPc: l.kind === "chord" ? rootPcOf(l.label) : null,
        engineExact: match.agreement.exact,
        enginePc: match.agreement.pitchClass,
        modelDominant: null,
        modelBass: null,
      };
      requests.push({
        at: spanEnd + DEEP,
        read: (fr) => {
          const mean = meanNotes(fr, L, spanEnd);
          q4row.modelDominant = dominantMidi(mean);
          q4row.modelBass = bassMidi(mean, BARS.noteThreshold);
        },
      });
      q4.push(q4row);
    }
  }

  const windows = await serve(model, audio, requests);
  return {
    stem: run.stem,
    path: run.path,
    heldout: isHeldOut(run.stem),
    labels: run.labels.length,
    detections: run.detections.length,
    windows,
    q1,
    q2,
    q3,
    q4,
  };
}

/* ---- main ------------------------------------------------------------------- */

const model = await loadModel(join(dir, "src/basic_pitch/saved_models/icassp_2022/nmp.onnx"));
const fixtures = decodeFixtures({ quiet: true }).filter((f) =>
  heldout ? isHeldOut(f.stem) : (DERIVATION as readonly string[]).includes(f.stem),
);
if (!heldout && fixtures.length !== DERIVATION.length) throw new Error(`found ${fixtures.length} derivation takes`);
if (heldout && fixtures.length !== 12) throw new Error(`found ${fixtures.length} held-out takes`);
for (const fixture of fixtures) {
  if (only !== undefined && fixture.stem !== only) continue;
  const t0 = Date.now();
  const run = runTake(fixture);
  checkParity(run);
  const rows = await collectTake(model, run);
  writeFileSync(join(outDir, `${fixture.stem}.json`), JSON.stringify(rows));
  console.log(
    `${fixture.stem.padEnd(48)} ${rows.path.padEnd(5)} q1 ${String(rows.q1.length).padStart(4)}  q2 ${String(rows.q2.length).padStart(4)}` +
      `  q3 ${String(rows.q3.length).padStart(4)}  windows ${String(rows.windows).padStart(5)}  ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
}
