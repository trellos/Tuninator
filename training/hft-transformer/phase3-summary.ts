/**
 * Phase 3's before/after table, split into derivation and held-out.
 *
 * Reads what the four measurements printed or wrote, before and after the
 * gate (see `phase3.ts` for the runs): the eval report JSON (labels, Notes,
 * matched, missed, false positives per take), `measure-splits.ts` overall and
 * `--subset=slow` (events split, extra Notes, per take), and
 * `measure-downstream-ledger.ts --all` (missed labels by cause, per take), so
 * the cost of the gate is named by the ledger branch it lands in.
 *
 * Usage:
 *   npx tsx training/hft-transformer/phase3-summary.ts [--dir training/out/hft-transformer/phase3]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const i = process.argv.indexOf("--dir");
const dir = i >= 0 ? (process.argv[i + 1] ?? "") : "training/out/hft-transformer/phase3";

const HELDOUT = new Set([
  "cowboy-chords-di-d-em-g-c-2x-140bpm", "cowboy-chords-amped-d-em-g-c-2x-140bpm", "cowboy-chords-mic-d-em-g-c-2x-140bpm",
  "lead-line-di-quarter-eighth-triplet-140bpm", "lead-line-amped-quarter-eighth-triplet-140bpm", "lead-line-quarter-eighth-triplet-140bpm",
  "lead-line-di-sixteenths-e-fsharp-140bpm", "lead-line-amped-sixteenths-e-fsharp-140bpm", "lead-line-sixteenths-e-fsharp-140bpm",
  "power-chords-di-b-a-g-fsharp-b-a-g-e-140bpm", "power-chords-amped-b-a-g-fsharp-b-a-g-e-140bpm", "power-chords-b-a-g-fsharp-b-a-g-e-140bpm",
]);
const group = (stem: string): "derivation" | "held-out" => (HELDOUT.has(stem) ? "held-out" : "derivation");

type Totals = Record<string, number>;
const add = (t: Totals, k: string, v: number): void => {
  t[k] = (t[k] ?? 0) + v;
};

function evalTotals(file: string): Record<string, Totals> {
  const r = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
    fixtures: Array<{ stem: string; overall: { labelCount: number; detectionCount: number; matchedCount: number; missedCount: number; falsePositiveCount: number } }>;
  };
  const out: Record<string, Totals> = { derivation: {}, "held-out": {} };
  for (const f of r.fixtures) {
    const t = out[group(f.stem)] as Totals;
    add(t, "labels", f.overall.labelCount);
    add(t, "Notes", f.overall.detectionCount);
    add(t, "matched", f.overall.matchedCount);
    add(t, "missed", f.overall.missedCount);
    add(t, "false positives", f.overall.falsePositiveCount);
  }
  return out;
}

function splitTotals(file: string): Record<string, Totals> {
  const out: Record<string, Totals> = { derivation: {}, "held-out": {} };
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
    const m = /^\s{2}([a-z0-9-]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m === null) continue;
    const t = out[group(m[1] as string)] as Totals;
    add(t, "labels", Number(m[2]));
    add(t, "split", Number(m[3]));
    add(t, "extras", Number(m[4]));
    add(t, "strays", Number(m[6]));
  }
  return out;
}

/** The ledger's cause rows, summed per group. Columns follow the sorted stems. */
function ledgerTotals(file: string, stems: string[]): Record<string, Totals> {
  const out: Record<string, Totals> = { derivation: {}, "held-out": {} };
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
    const cells = line.trim().split(/\s{2,}/);
    if (cells.length !== stems.length + 2) continue;
    const cause = cells[0] as string;
    if (cause === "cause" || cause === "detections" || /^-+$/.test(cause)) continue;
    stems.forEach((stem, k) => add(out[group(stem)] as Totals, cause, Number(cells[k + 1])));
  }
  return out;
}

const stems = (JSON.parse(readFileSync(join(dir, "before-eval-report.json"), "utf8")) as { fixtures: Array<{ stem: string }> }).fixtures
  .map((f) => f.stem)
  .sort();

const show = (title: string, before: Record<string, Totals>, after: Record<string, Totals>, keys: string[] | null): void => {
  console.log(`\n${title}`);
  for (const g of ["derivation", "held-out"]) {
    const b = before[g] as Totals;
    const a = after[g] as Totals;
    const ks = keys ?? [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => (b[k] ?? 0) !== 0 || (a[k] ?? 0) !== 0);
    for (const k of ks) {
      const x = b[k] ?? 0;
      const y = a[k] ?? 0;
      console.log(`  ${g.padEnd(10)} ${k.padEnd(58)} ${String(x).padStart(5)} -> ${String(y).padStart(5)}  ${y - x >= 0 ? "+" : ""}${y - x}`);
    }
  }
};

show("npm run eval (every label, every take)", evalTotals("before-eval-report.json"), evalTotals("after-eval-report.json"), [
  "labels", "Notes", "matched", "missed", "false positives",
]);
show("measure-splits.ts", splitTotals("before-splits.txt"), splitTotals("after-splits.txt"), ["labels", "split", "extras", "strays"]);
show("measure-splits.ts --subset=slow", splitTotals("before-splits-slow.txt"), splitTotals("after-splits-slow.txt"), ["labels", "split", "extras"]);
show("measure-downstream-ledger.ts --all, missed labels by cause", ledgerTotals("before-ledger.txt", stems), ledgerTotals("after-ledger.txt", stems), null);
