/**
 * Door 1 of the slow-note-splits loop, on the bench: judge a phrase's
 * same-pitch boundaries TOGETHER, and drop the one whose removal makes the
 * phrase's note spacing most regular.
 *
 * `docs/slow-note-splits-loop-prompt.md` §5 door 1. Every witness this project
 * has read AT a boundary tops out near 0.70 AUC, and on the amped renders the
 * phantom and the re-pick read the same on every one tried (door 2, closed).
 * What a listener uses is a claim about a SEQUENCE: evenly spaced picks. A
 * phantom boundary splits one interval into two pieces that do not sit on the
 * phrase's grid; dropping it restores one interval that does. A real note sits
 * on the grid whether or not its neighbour is dropped, so dropping it never
 * makes the phrase more regular.
 *
 * **The cost.** For a phrase (Notes whose openings are closer than
 * `PHRASE_GAP_MS`), the unit is the median inter-onset interval of the
 * partition being scored. An interval's misfit is the distance, in octaves,
 * from the nearest allowed multiple of that unit (`GRID`). A boundary between
 * two SAME-PITCH Notes is dropped when that lowers the phrase's total misfit
 * by more than `margin`. Drops are greedy, best first, re-scoring after each,
 * because one drop changes the unit and its neighbours' intervals. There is
 * no decay term (DECISION-011 closed that at chance) and no rate estimate
 * taken from before the boundary (DECISION-037): the partition is scored by
 * its own regularity.
 *
 * **What it can never do.** Drop a boundary between two pitches, and drop
 * anything in a phrase of fewer than `MIN_PHRASE` Notes. A real note is
 * isolated in a slow passage by construction.
 *
 * NOTHING HERE CHANGES ENGINE BEHAVIOUR. The drop is simulated on the final
 * detection list, the survivor's end extended over the dropped Note, and the
 * matcher re-run, as `measure-rate-relative-merge.ts` does. A bench number is a
 * hypothesis: if it passes, the pipeline is still the verdict.
 *
 * FALSIFIER, stated before running: on the DERIVATION takes, more extra Notes
 * removed than the shipped rate gate (DECISION-030 plus DECISION-045) removes
 * on the current engine, at zero added missed labels. The gate's figure is
 * measured here by running the engine with its two span fractions at 0.
 * Below that, door 1 closes with its numbers. Held-out is read once, after a
 * setting is chosen on derivation.
 *
 * Usage:
 *   npx tsx scripts/measure-phrase-regularity-decode.ts
 *   npx tsx scripts/measure-phrase-regularity-decode.ts --detail
 */

import { readFileSync } from "node:fs";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { matchEvents, type DetectedEvent, type LabeledEvent } from "../src/offline/matcher.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import { decodeFixtures } from "./decode-fixtures.js";

/** Two openings further apart than this belong to different phrases. */
const PHRASE_GAP_MS = 1200;
/** A phrase needs this many Notes before any boundary in it is judged. */
const MIN_PHRASE = 4;
/** The allowed multiples of the phrase's unit. Halves and quarters, no thirds. */
const GRIDS: Record<string, number[]> = {
  halves: [0.5, 1, 1.5, 2, 3, 4],
  quarters: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4],
  integers: [1, 2, 3, 4],
};
const MARGINS = [0.2, 0.35, 0.5, 0.75, 1.0, 1.5];

const DERIVATION = new Set([
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
]);

type Take = {
  stem: string;
  derivation: boolean;
  path: "di" | "amped" | "mic" | "other";
  labels: readonly LabeledEvent[];
  detections: DetectedEvent[];
  /**
   * The Notes the fast lane opened by ACCEPTING a same-pitch re-articulation,
   * with that boundary's dip witness. Door 1's candidate set is these
   * boundaries, not every same-pitch neighbour.
   */
  dipOf: Map<string, number>;
};

function pathOf(stem: string): Take["path"] {
  if (/-di(-|$)/.test(stem)) return "di";
  if (/amped/.test(stem)) return "amped";
  if (/-mic-|^lead-line-(quarter|sixteenths)|^power-chords-b-a-g/.test(stem)) return "mic";
  return "other";
}

function median(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
}

function misfit(ioi: number, unit: number, grid: readonly number[]): number {
  let best = Infinity;
  for (const k of grid) best = Math.min(best, Math.abs(Math.log2(ioi / (k * unit))));
  return best;
}

/** Total misfit of a phrase's openings, each interval against the median. */
function phraseCost(onsets: readonly number[], grid: readonly number[]): number {
  if (onsets.length < 3) return 0;
  const iois: number[] = [];
  for (let i = 1; i < onsets.length; i++) iois.push((onsets[i] as number) - (onsets[i - 1] as number));
  const unit = median(iois);
  let cost = 0;
  for (const x of iois) cost += misfit(x, unit, grid);
  return cost;
}

/**
 * The decode for one take: which detection ids to drop, and which survivor
 * each is absorbed into.
 */
function decode(
  detections: readonly DetectedEvent[],
  grid: readonly number[],
  margin: number,
  dipOf: ReadonlyMap<string, number> | null = null,
  dipWeight = 0,
  minUnitMs = 0
): Map<string, string> {
  const notes = [...detections].sort((a, b) => a.startedAt - b.startedAt);
  const absorbedInto = new Map<string, string>();
  // Phrases.
  const phrases: DetectedEvent[][] = [];
  let cur: DetectedEvent[] = [];
  for (const n of notes) {
    const last = cur[cur.length - 1];
    if (last !== undefined && n.startedAt - last.startedAt > PHRASE_GAP_MS) {
      phrases.push(cur);
      cur = [];
    }
    cur.push(n);
  }
  if (cur.length > 0) phrases.push(cur);

  for (const phrase of phrases) {
    let kept = [...phrase];
    for (;;) {
      if (kept.length < MIN_PHRASE) break;
      if (minUnitMs > 0) {
        const o = kept.map((n) => n.startedAt);
        const g: number[] = [];
        for (let i = 1; i < o.length; i++) g.push((o[i] as number) - (o[i - 1] as number));
        if (median(g) < minUnitMs) break;
      }
      const base = phraseCost(kept.map((n) => n.startedAt), grid);
      let bestGain = margin;
      let bestIndex = -1;
      for (let i = 1; i < kept.length; i++) {
        const a = kept[i - 1] as DetectedEvent;
        const b = kept[i] as DetectedEvent;
        if (a.label.name !== b.label.name) continue;
        let penalty = 0;
        if (dipOf !== null) {
          const dip = dipOf.get(b.id);
          if (dip === undefined) continue;
          penalty = dipWeight * (1 - Math.min(1, dip));
        }
        const without = kept.filter((_, j) => j !== i).map((n) => n.startedAt);
        const gain = base - phraseCost(without, grid) - penalty;
        if (gain > bestGain) {
          bestGain = gain;
          bestIndex = i;
        }
      }
      if (bestIndex < 0) break;
      const dropped = kept[bestIndex] as DetectedEvent;
      const into = kept[bestIndex - 1] as DetectedEvent;
      absorbedInto.set(dropped.id, into.id);
      kept = kept.filter((_, j) => j !== bestIndex);
    }
  }
  return absorbedInto;
}

function apply(detections: readonly DetectedEvent[], absorbedInto: ReadonlyMap<string, string>): DetectedEvent[] {
  const survivor = (id: string): string => {
    let at = id;
    while (absorbedInto.has(at)) at = absorbedInto.get(at) as string;
    return at;
  };
  const extend = new Map<string, number>();
  for (const d of detections) {
    if (!absorbedInto.has(d.id) || d.endedAt === null) continue;
    const into = survivor(d.id);
    extend.set(into, Math.max(extend.get(into) ?? 0, d.endedAt));
  }
  return detections
    .filter((d) => !absorbedInto.has(d.id))
    .map((d) => {
      const e = extend.get(d.id);
      return e === undefined ? d : { ...d, endedAt: Math.max(d.endedAt ?? 0, e) };
    });
}

function run(overrideGate: boolean): Take[] {
  const takes: Take[] = [];
  for (const fixture of decodeFixtures({ quiet: true })) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const trace: TrackerTraceEvent[] = [];
    const analysis = analyzeSamples(mono, wav.sampleRate, {
      trackerTrace: (e) => trace.push(e),
      overrideConfig: overrideGate
        ? (c) => {
            c.tracking.rateFragmentSpanFraction = 0;
            c.tracking.rateFragmentNoRiseSpanFraction = 0;
          }
        : undefined,
    });
    const dipOf = new Map<string, number>();
    for (let i = 0; i < trace.length; i++) {
      const e = trace[i] as TrackerTraceEvent;
      if (e.kind !== "rearticulation" || !e.accepted || e.pitchDiffers) continue;
      for (let j = i + 1; j < trace.length && j < i + 8; j++) {
        const n = trace[j] as TrackerTraceEvent;
        if (n.kind === "opened" && Math.abs(n.at - e.at) <= 30) {
          dipOf.set(n.noteId, e.dipRatio);
          break;
        }
      }
    }
    takes.push({
      dipOf,
      stem: fixture.stem,
      derivation: DERIVATION.has(fixture.stem),
      path: pathOf(fixture.stem),
      labels: fixture.label.events as LabeledEvent[],
      detections: [...projectEmissions(analysis.emissions).final],
    });
  }
  return takes;
}

type Score = { missed: number; fp: number; dropped: number };
function score(takes: readonly Take[], f: (t: Take) => DetectedEvent[], only: (t: Take) => boolean): Score {
  let missed = 0;
  let fp = 0;
  let dropped = 0;
  for (const t of takes) {
    if (!only(t)) continue;
    const after = f(t);
    dropped += t.detections.length - after.length;
    const r = matchEvents(t.labels, after);
    missed += r.missed.length;
    fp += r.falsePositives.length;
  }
  return { missed, fp, dropped };
}

const detail = process.argv.includes("--detail");
const shipped = run(false);
const gateOff = run(true);
const deriv = (t: Take): boolean => t.derivation;
const held = (t: Take): boolean => !t.derivation;
const as = (t: Take): DetectedEvent[] => t.detections;

const s0 = score(shipped, as, deriv);
const g0 = score(gateOff, as, deriv);
console.log("DERIVATION (5 originals + 8 same-pitch takes), final Notes, matcher:");
console.log(`  shipped engine          missed ${s0.missed}  fp ${s0.fp}`);
console.log(`  rate gate off           missed ${g0.missed}  fp ${g0.fp}`);
console.log(
  `  => the shipped gate removes ${g0.fp - s0.fp} fp at ${s0.missed - g0.missed >= 0 ? "+" : ""}${s0.missed - g0.missed} missed. Door 1's bar: remove more than that at +0 missed.\n`
);

type Row = { grid: string; margin: number; d: Score; dOnGateOff: Score; dec: (t: Take) => DetectedEvent[] };
const rows: Row[] = [];
/**
 * `slow` abstains on any phrase whose own median interval is under 200ms,
 * which is every sixteenth section in the corpus (125ms at 120bpm, 107ms at
 * 140bpm) and no eighth section (250ms at 120bpm). Door 1 targets the slow
 * material; the sixteenth sections are where the first runs lost real notes.
 */
const VARIANTS: Array<{ name: string; accepted: boolean; w: number; minUnit: number }> = [
  { name: "", accepted: false, w: 0, minUnit: 0 },
  { name: "+acc", accepted: true, w: 0, minUnit: 0 },
  { name: "+acc+dip1", accepted: true, w: 1, minUnit: 0 },
  { name: "+acc+dip3", accepted: true, w: 3, minUnit: 0 },
  { name: "+slow", accepted: false, w: 0, minUnit: 200 },
  { name: "+acc+slow", accepted: true, w: 0, minUnit: 200 },
  { name: "+acc+dip1+slow", accepted: true, w: 1, minUnit: 200 },
];
for (const v of VARIANTS) {
  for (const [gname, grid] of Object.entries(GRIDS)) {
    for (const margin of MARGINS) {
      const dec = (t: Take): DetectedEvent[] =>
        apply(t.detections, decode(t.detections, grid, margin, v.accepted ? t.dipOf : null, v.w, v.minUnit));
      rows.push({ grid: gname + v.name, margin, d: score(shipped, dec, deriv), dOnGateOff: score(gateOff, dec, deriv), dec });
    }
  }
}
console.log("door 1 on derivation   (on top of the shipped engine | in place of the gate)");
console.log("  grid      margin   dropped  missed  fp     Δmissed Δfp   |  dropped  missed  fp     Δmissed Δfp vs shipped");
for (const r of rows) {
  const a = r.d;
  const b = r.dOnGateOff;
  console.log(
    `  ${r.grid.padEnd(9)} ${r.margin.toFixed(2).padStart(5)}   ${String(a.dropped).padStart(6)}  ${String(a.missed).padStart(6)}  ${String(a.fp).padStart(4)}   ${String(a.missed - s0.missed).padStart(6)} ${String(a.fp - s0.fp).padStart(5)}   |  ${String(b.dropped).padStart(6)}  ${String(b.missed).padStart(6)}  ${String(b.fp).padStart(4)}   ${String(b.missed - s0.missed).padStart(6)} ${String(b.fp - s0.fp).padStart(5)}`
  );
}

// Per path and per take on derivation, at every setting that holds missed.
const ok = rows.filter((r) => r.d.missed <= s0.missed).sort((x, y) => x.d.fp - y.d.fp);
const forced = process.argv.find((a) => a.startsWith("--at="));
const pick = forced
  ? rows.find((r) => `${r.grid}:${r.margin}` === forced.slice(5))
  : ok[0];
if (pick === undefined) {
  console.log("\nNo setting holds derivation missed at the shipped figure. Door 1 fails its falsifier on the bench.");
} else {
  console.log(`\nBest setting at +0 derivation missed: grid ${pick.grid}, margin ${pick.margin} -> fp ${s0.fp} -> ${pick.d.fp} (${pick.d.fp - s0.fp}); the gate's own share was ${s0.fp - g0.fp}.`);
  const grid = GRIDS[pick.grid.split("+")[0] as string] as number[];
  const dec = pick.dec;
  console.log("\nper take (derivation):  missed / fp  shipped -> door 1");
  for (const t of shipped.filter(deriv)) {
    const a = score([t], as, () => true);
    const b = score([t], dec, () => true);
    if (a.missed !== b.missed || a.fp !== b.fp) console.log(`  ${t.stem.padEnd(48)} ${a.missed}/${a.fp} -> ${b.missed}/${b.fp}`);
  }
  const h0 = score(shipped, as, held);
  const h1 = score(shipped, dec, held);
  console.log(`\nHELD-OUT, read once at that setting: missed ${h0.missed} -> ${h1.missed}, fp ${h0.fp} -> ${h1.fp}`);
  for (const t of shipped.filter(held)) {
    const a = score([t], as, () => true);
    const b = score([t], dec, () => true);
    if (a.missed !== b.missed || a.fp !== b.fp) console.log(`  ${t.stem.padEnd(48)} ${a.missed}/${a.fp} -> ${b.missed}/${b.fp}`);
  }
  if (detail) {
    for (const t of shipped) {
      const m = decode(t.detections, grid, pick.margin);
      const paired = new Set(matchEvents(t.labels, t.detections).matches.map((x) => x.detection.id));
      const sorted = [...t.detections].sort((a, b) => a.startedAt - b.startedAt);
      for (const [id, into] of m) {
        const k = sorted.findIndex((x) => x.id === id);
        const ctx = sorted.slice(Math.max(0, k - 3), k + 4).map((x) => `${x.id === id ? "*" : ""}${x.startedAt.toFixed(0)}${paired.has(x.id) ? "" : "x"}`);
        console.log(`  drop ${paired.has(id) ? "REAL " : "extra"} ${t.stem} @${(sorted[k] as DetectedEvent).startedAt.toFixed(0)} ${(sorted[k] as DetectedEvent).label.name}  [${ctx.join(" ")}]`);
      }
    }
  }
}
