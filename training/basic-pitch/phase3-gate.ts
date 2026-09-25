/**
 * Phase 3: the model's onset reading gating the tracker end to end, in a
 * dev-only harness. Loaded with `--import` before a measurement script; does
 * nothing unless BP_GATE_MODE is set. Nothing here is imported by `src/**`,
 * and the engine-side hook it answers lives only in `phase3-hook.patch`, which
 * is applied for the run and reverted afterwards (never committed).
 *
 * FIXED BEFORE ANY PHASE 3 RUN, ON DERIVATION ROWS ONLY, AND BEFORE THE
 * HELD-OUT PHASE 2 REPORT WAS READ (2026-09-25):
 *
 * Which decisions. Phase 2 cleared Q1 (onset at a Note's start separates
 * surplus Notes, DEEP AUC 0.853) and Q2 (Q2a DEEP 0.757 as a boundary
 * witness; Q2b 0.806 on the children DECISION-030's gate lets through). The
 * matching tracker decisions are announcing a Note (Q1: every Note) and
 * announcing a same-pitch split's child (Q2b). Q2a's own decision, the cut at
 * the transient, is a fast-lane decision whose FAST reading is at chance
 * (0.496), so it is not gated. Q3 cleared only on the branch "split made;
 * successor paired with a neighbouring label" (4 of 7): the boundary there was
 * already made, so no tracker decision exists for a gate to change; Q3 is not
 * run end to end.
 *
 * How. The hook withholds a Note the gate names — sets its announce bar to
 * infinity, so `end()` drops it as a Note that never cleared its bar, exactly
 * DECISION-030's mechanism. The reading is the DEEP one (window cut 200ms after
 * the Note's start), so in a live engine this is a deep-lane retraction
 * ~240ms after the start; DECISION-030 (c) measured retraction and never
 * announcing to score identically. The Note's pitch set is taken from its label
 * at the moment it would be announced (a single note: its pitch class in every
 * octave E2..E6; otherwise every note E2..E6), as Phase 2's O(S). A Note
 * opened at a time the baseline never opened one has no precomputed reading
 * and is left alone; the count is printed.
 *
 * Operating points, from the derivation Q1/Q2b rows (`zero-cost` sweep in the
 * notes), fixed before running:
 *   ZERO COST  theta 0.15: the largest of 0.05, 0.10, ... 0.50 at which the
 *              gate withholds no derivation Note the matcher paired. At row
 *              level it withholds 3 derivation extras (Q1) and none (Q2b).
 *   PACKAGE    theta 0.50: the model's own onset threshold (the package
 *              default, and Phase 2's 2x2 operating point). At row level on
 *              derivation it withholds 78 extras and 53 paired Notes (Q1), 48
 *              and 58 (Q2b): a trade, run to measure the exchange rate end to
 *              end, not as a candidate.
 * Four runs: {every Note, same-pitch children} x {0.15, 0.50}. Each reports
 * `npm run eval`'s totals, `measure-downstream-ledger.ts --all` and
 * `measure-splits.ts` overall and `--subset=slow`, against the baseline.
 *
 * Environment:
 *   BP_GATE_MODE      "all" | "samepitch"
 *   BP_GATE_THETA     the operating point
 *   BP_GATE_READINGS  <dir>/phase3/readings.json (`phase3-readings.ts`)
 */

import { readFileSync } from "node:fs";
import { midiOf, pitchSet } from "./features.js";

type Readings = Record<string, { stem: string; starts: Record<string, number[]> }>;
type Gate = (takeKey: unknown, startMs: number, label: string | null, samePitchChild: boolean) => boolean;

const mode = process.env.BP_GATE_MODE;
if (mode === "all" || mode === "samepitch") {
  const theta = Number(process.env.BP_GATE_THETA);
  const path = process.env.BP_GATE_READINGS;
  if (!Number.isFinite(theta) || path === undefined) throw new Error("BP_GATE_THETA and BP_GATE_READINGS are required");
  const readings = JSON.parse(readFileSync(path, "utf8")) as Readings;
  const counts = { asked: 0, withheld: 0, noReading: 0, unknownTake: 0 };
  const gate: Gate = (takeKey, startMs, label, samePitchChild) => {
    if (mode === "samepitch" && !samePitchChild) return false;
    counts.asked++;
    const take = typeof takeKey === "string" ? readings[takeKey] : undefined;
    if (take === undefined) {
      counts.unknownTake++;
      return false;
    }
    const perMidi = take.starts[(Math.round(startMs * 10) / 10).toFixed(1)];
    if (perMidi === undefined) {
      counts.noReading++;
      return false;
    }
    const m = label === null ? null : midiOf(label);
    const ps = pitchSet(m === null ? null : [m]);
    let best = 0;
    for (const midi of ps) best = Math.max(best, perMidi[midi - 40] ?? 0);
    const withhold = best < theta;
    if (withhold) counts.withheld++;
    return withhold;
  };
  (globalThis as Record<string, unknown>).__bpGate = gate;
  process.on("exit", () => {
    process.stderr.write(
      `[phase3 gate ${mode} theta ${theta}] asked ${counts.asked}, withheld ${counts.withheld}, ` +
        `no reading ${counts.noReading}, unknown take ${counts.unknownTake}\n`,
    );
  });
}
