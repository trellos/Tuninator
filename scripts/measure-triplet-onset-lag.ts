/**
 * How late does a fast same-register pluck's Note start, and what does it cost?
 *
 * The bench GOATerizer's autoplay asked about (DECISION-088, DECISION-089):
 * synthetic plucks, six harmonics at 1/h, a 3ms attack, exp(-6t) decay and a
 * 50ms release, each sounding 90% of an eighth-note-triplet interval, pitches
 * drawn from G2-G3 (MIDI 43-55) by the LCG `tests/engine/sample-rate.test.ts`
 * uses, seeded with the bpm. The real engine is driven through
 * `analyzeSamples` in worklet-sized quanta; the Notes scored are the eval's
 * final projection (absorbed fragments removed).
 *
 * Per pluck, a Note belongs to it when the Note starts inside its slot: from
 * `LEEWAY_MS` before the pluck to `LEEWAY_MS` before the next one. 40ms is
 * well under the tightest interval here (143ms at 140bpm), so no Note can be
 * charged to a pluck it did not start under (AGENTS.md: check every window
 * against the tightest subdivision).
 *
 *   lag      first Note's start minus the pluck, ms (p50 / p90 / max)
 *   late     plucks whose first Note starts more than `LATE_MS` after them
 *   missed   plucks with no Note in their slot
 *   extra    Notes beyond the first in a slot, plus Notes in no slot
 *   wrong    plucks whose first Note is not named the plucked note
 *
 * `--detail` prints every late, missed or wrong pluck with the tracker trace
 * around it, which is how the mechanism in DECISION-089 was read.
 *
 * `--corpus` runs the same lag question on the recorded takes instead: every
 * label the eval's matcher pairs, detection start minus label start, split
 * derivation / held-out (held-out = the 140bpm takes, per AGENTS.md §3). The
 * held-out half prints only with `--held-out`, so a derivation reading can be
 * taken without looking at it.
 *
 * Usage:
 *   npx tsx scripts/measure-triplet-onset-lag.ts
 *   npx tsx scripts/measure-triplet-onset-lag.ts --bpm=120 --detail
 *   npx tsx scripts/measure-triplet-onset-lag.ts --rate=44100
 *   npx tsx scripts/measure-triplet-onset-lag.ts --set=tracking.minStableMs=50
 *   npx tsx scripts/measure-triplet-onset-lag.ts --corpus [--held-out]
 */

import { readFileSync } from "node:fs";
import type { EngineConfig } from "../src/engine/config.js";
import { describeFrequency } from "../src/engine/kernels/notes.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { matchEvents, type DetectedEvent, type LabeledEvent } from "../src/offline/matcher.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

const LEEWAY_MS = 40;
const LATE_MS = 40;
const NOTES = 110;
const DEFAULT_BPMS = [90, 100, 110, 120, 130, 140];
const SCALE = [43, 45, 47, 48, 50, 52, 54, 55];

type Pluck = { midi: number; at: number; duration: number };

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The score generator of `tests/engine/sample-rate.test.ts`, at any tempo. */
function score(count: number, bpm: number): Pluck[] {
  const rand = lcg(bpm);
  const ioi = 60 / bpm / 3;
  return Array.from({ length: count }, (_, i) => ({
    midi: SCALE[Math.floor(rand() * SCALE.length)] as number,
    at: 0.5 + i * ioi,
    duration: ioi * 0.9,
  }));
}

function render(plucks: readonly Pluck[], sampleRate: number): Float32Array {
  const last = plucks[plucks.length - 1] as Pluck;
  const out = new Float32Array(Math.ceil((last.at + last.duration + 0.6) * sampleRate));
  for (const p of plucks) {
    const f0 = 440 * 2 ** ((p.midi - 69) / 12);
    const from = Math.ceil(p.at * sampleRate);
    const to = Math.min(out.length, Math.ceil((p.at + p.duration + 0.05) * sampleRate));
    for (let i = from; i < to; i++) {
      const t = i / sampleRate - p.at;
      const release = t > p.duration ? Math.max(0, 1 - (t - p.duration) / 0.05) : 1;
      const env = Math.min(1, t / 0.003) * Math.exp(-t * 6) * release;
      let s = 0;
      for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h;
      out[i] = (out[i] ?? 0) + 0.3 * env * s;
    }
  }
  return out;
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

const fmt = (x: number): string => (Number.isFinite(x) ? x.toFixed(0) : "-");

/** `--set=tracking.minStableMs=50` → assign into the resolved config. */
function overrides(args: readonly string[]): ((config: EngineConfig) => void) | undefined {
  const sets = args.filter((a) => a.startsWith("--set=")).map((a) => a.slice(6));
  if (sets.length === 0) return undefined;
  return (config) => {
    for (const set of sets) {
      const [path, raw] = set.split("=") as [string, string];
      const keys = path.split(".");
      let node = config as unknown as Record<string, unknown>;
      for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
      const leaf = keys[keys.length - 1] as string;
      const old = node[leaf];
      node[leaf] = typeof old === "boolean" ? raw === "true" : typeof old === "number" ? Number(raw) : raw;
    }
  };
}

type BenchRow = {
  bpm: number;
  plucks: number;
  notes: number;
  lags: number[];
  late: number;
  missed: number;
  extra: number;
  wrong: number;
};

function bench(bpm: number, rate: number, detail: boolean, override?: (c: EngineConfig) => void): BenchRow {
  const plucks = score(NOTES, bpm);
  const events: TrackerTraceEvent[] = [];
  const analysis = analyzeSamples(render(plucks, rate), rate, {
    trackerTrace: (event) => events.push(event),
    overrideConfig: override,
  });
  const notes = projectEmissions(analysis.emissions).final.sort((a, b) => a.startedAt - b.startedAt);
  const row: BenchRow = { bpm, plucks: plucks.length, notes: notes.length, lags: [], late: 0, missed: 0, extra: 0, wrong: 0 };
  const owned = new Set<string>();
  plucks.forEach((p, i) => {
    const from = p.at * 1000 - LEEWAY_MS;
    const next = plucks[i + 1];
    const to = next === undefined ? Infinity : next.at * 1000 - LEEWAY_MS;
    const mine = notes.filter((n) => n.startedAt >= from && n.startedAt < to);
    for (const n of mine) owned.add(n.id);
    const want = describeFrequency(440 * 2 ** ((p.midi - 69) / 12)).name;
    const first = mine[0];
    let flag = "";
    if (first === undefined) {
      row.missed++;
      flag = "MISSED";
    } else {
      const lag = first.startedAt - p.at * 1000;
      row.lags.push(lag);
      row.extra += mine.length - 1;
      if (lag > LATE_MS) {
        row.late++;
        flag = `LATE ${fmt(lag)}ms`;
      }
      if (first.label.name !== want) {
        row.wrong++;
        flag += ` WRONG ${first.label.name}`;
      }
      if (mine.length > 1) flag += ` +${mine.length - 1}`;
    }
    if (detail && flag !== "") {
      const prev = plucks[i - 1];
      const prevName = prev === undefined ? "-" : describeFrequency(440 * 2 ** ((prev.midi - 69) / 12)).name;
      console.log(`  pluck ${i} ${want} (after ${prevName}) at ${fmt(p.at * 1000)}: ${flag.trim()}`);
      for (const n of mine) console.log(`    note ${n.id} ${n.label.name} ${fmt(n.startedAt)}-${fmt(n.endedAt ?? NaN)}`);
      for (const e of events) {
        if (e.at < from || e.at >= p.at * 1000 + 120 || e.kind === "onset") continue;
        console.log(`    ${describe(e)}`);
      }
    }
  });
  row.extra += notes.filter((n) => !owned.has(n.id)).length;
  return row;
}

function describe(e: TrackerTraceEvent): string {
  const at = fmt(e.at);
  switch (e.kind) {
    case "opened":
      return `${at} opened ${e.noteId} by ${e.trigger}`;
    case "ended":
      return `${at} ended ${e.noteId} (from ${fmt(e.startedAt)}) ${e.announced ? "announced" : "DROPPED"} sounded ${fmt(e.soundedMs)}/${fmt(e.announceBarMs)}`;
    case "declined":
      return `${at} declined ${e.noteId} into ${e.intoId}: ${e.reason} (${fmt(e.durationMs)}ms, fell to ${e.fellTo.toFixed(2)})`;
    case "absorbed":
      return `${at} absorbed ${e.noteId} into ${e.intoId} (${fmt(e.durationMs)}ms)`;
    case "rearticulation":
      return `${at} rearticulation ${e.noteId} ${e.accepted ? "ACCEPTED" : "refused"} ${e.reason} settled=${e.settled} differs=${e.pitchDiffers}`;
    default:
      return `${at} ${e.kind} ${"noteId" in e ? e.noteId : ""}`;
  }
}

function printBench(rows: readonly BenchRow[]): void {
  console.log("bpm  plucks notes  lag p50/p90/max   late missed extra wrong");
  const all: BenchRow = { bpm: 0, plucks: 0, notes: 0, lags: [], late: 0, missed: 0, extra: 0, wrong: 0 };
  for (const r of rows) {
    console.log(
      `${String(r.bpm).padStart(3)}  ${String(r.plucks).padStart(6)} ${String(r.notes).padStart(5)}  ` +
        `${fmt(quantile(r.lags, 0.5)).padStart(4)}/${fmt(quantile(r.lags, 0.9)).padStart(3)}/${fmt(Math.max(...r.lags)).padStart(3)}      ` +
        `${String(r.late).padStart(4)} ${String(r.missed).padStart(6)} ${String(r.extra).padStart(5)} ${String(r.wrong).padStart(5)}`
    );
    all.plucks += r.plucks;
    all.notes += r.notes;
    all.lags.push(...r.lags);
    all.late += r.late;
    all.missed += r.missed;
    all.extra += r.extra;
    all.wrong += r.wrong;
  }
  if (rows.length > 1) {
    console.log(
      `all  ${String(all.plucks).padStart(6)} ${String(all.notes).padStart(5)}  ` +
        `${fmt(quantile(all.lags, 0.5)).padStart(4)}/${fmt(quantile(all.lags, 0.9)).padStart(3)}/${fmt(Math.max(...all.lags)).padStart(3)}      ` +
        `${String(all.late).padStart(4)} ${String(all.missed).padStart(6)} ${String(all.extra).padStart(5)} ${String(all.wrong).padStart(5)}`
    );
  }
}

function corpus(heldOut: boolean, override?: (c: EngineConfig) => void): void {
  const sides = new Map<string, number[]>();
  console.log("fixture                                              pairs  lag p50/p90  late>40");
  for (const fixture of decodeFixtures({ quiet: true })) {
    const side = fixture.stem.includes("140bpm") ? "held-out" : "derivation";
    if (side === "held-out" && !heldOut) continue;
    const wav = readWav(readFileSync(fixture.wavPath));
    const analysis = analyzeSamples(downmixToMono(wav.samples, wav.channels), wav.sampleRate, {
      overrideConfig: override,
    });
    const detections: DetectedEvent[] = projectEmissions(analysis.emissions).final;
    const labels = fixture.label.events as LabeledEvent[];
    const deltas = matchEvents(labels, detections).matches.map((m) => m.onsetDeltaMs);
    const list = sides.get(side) ?? [];
    list.push(...deltas);
    sides.set(side, list);
    console.log(
      `${fixture.stem.padEnd(52)} ${String(deltas.length).padStart(5)}  ` +
        `${fmt(quantile(deltas, 0.5)).padStart(4)}/${fmt(quantile(deltas, 0.9)).padStart(4)}  ` +
        `${String(deltas.filter((d) => d > LATE_MS).length).padStart(6)}`
    );
  }
  for (const [side, deltas] of sides) {
    console.log(
      `${side.padEnd(52)} ${String(deltas.length).padStart(5)}  ` +
        `${fmt(quantile(deltas, 0.5)).padStart(4)}/${fmt(quantile(deltas, 0.9)).padStart(4)}  ` +
        `${String(deltas.filter((d) => d > LATE_MS).length).padStart(6)}`
    );
  }
}

const args = process.argv.slice(2);
const override = overrides(args);
if (args.includes("--corpus")) {
  corpus(args.includes("--held-out"), override);
} else {
  const bpmArg = args.find((a) => a.startsWith("--bpm="));
  const bpms = bpmArg === undefined ? DEFAULT_BPMS : bpmArg.slice(6).split(",").map(Number);
  const rateArg = args.find((a) => a.startsWith("--rate="));
  const rate = rateArg === undefined ? 48000 : Number(rateArg.slice(7));
  const detail = args.includes("--detail");
  printBench(bpms.map((bpm) => bench(bpm, rate, detail, override)));
}
