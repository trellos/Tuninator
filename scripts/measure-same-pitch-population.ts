/**
 * Of the decisions the "same-pitch re-articulation" studies fit on, how many
 * ARE same-pitch re-articulations?
 *
 * A row is one `rearticulation` trace event, exactly as
 * `measure-decision-separability.ts` collects it. Its target label is the
 * nearest within 70ms; that label is a same-pitch re-articulation only if
 * the label BEFORE it carries the same pitch or chord name. Otherwise the
 * decision is "a new pitch arrived while the previous Note was still
 * ringing" — routed through the same branch, but a different question, with
 * evidence (the pitch changed) the same-pitch case does not have.
 *
 * The answer, recorded in `docs/DETECTION-FINDINGS.md`: 8 of 59 derivation
 * positives, all eight inside one take. Run this before trusting any
 * derivation-set reading of the same-pitch decision, and before adding
 * derivation material intended to fix it.
 *
 * Derivation takes only; the 140bpm takes are filtered before any audio is
 * decoded.
 *
 * Usage:  npx tsx scripts/measure-same-pitch-population.ts
 */

import { readFileSync } from "node:fs";
import { analyzeSamples } from "../src/offline/analyzer.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

const WINDOW_MS = 70;
type Tally = { rows: number; pos: number; posSamePitch: number; posNewPitch: number };
const perTake = new Map<string, Tally>();

for (const fixture of decodeFixtures({ quiet: true })) {
  if (fixture.stem.includes("140bpm")) continue; // derivation only
  const wav = readWav(readFileSync(fixture.wavPath));
  const mono = downmixToMono(wav.samples, wav.channels);
  const events: TrackerTraceEvent[] = [];
  analyzeSamples(mono, wav.sampleRate, { trackerTrace: (e) => events.push(e) });

  const labels = [...fixture.label.events].sort((a, b) => a.startMs - b.startMs);
  const isRepeat = new Map<string, boolean>();
  labels.forEach((l, i) => {
    isRepeat.set(l.id, i > 0 && (labels[i - 1] as (typeof labels)[number]).label === l.label);
  });

  const tally: Tally = { rows: 0, pos: 0, posSamePitch: 0, posNewPitch: 0 };
  const openedSoFar: number[] = [];
  for (const event of events) {
    if (event.kind === "opened") {
      openedSoFar.push(event.at);
      continue;
    }
    if (event.kind !== "rearticulation") continue;
    tally.rows++;
    let near: (typeof labels)[number] | null = null;
    for (const label of labels) {
      const d = Math.abs(label.startMs - event.at);
      if (d > WINDOW_MS) continue;
      if (near === null || d < Math.abs(near.startMs - event.at)) near = label;
    }
    let covered = false;
    if (near !== null) {
      for (const at of openedSoFar) {
        if (Math.abs(at - near.startMs) <= WINDOW_MS) {
          covered = true;
          break;
        }
      }
    }
    if (near !== null && !covered) {
      tally.pos++;
      if (isRepeat.get(near.id) === true) tally.posSamePitch++;
      else tally.posNewPitch++;
    }
  }
  perTake.set(fixture.stem, tally);
}

console.log("derivation decision table, positives split by what the decision actually is\n");
console.log("take                                       rows   pos   same-pitch re-artic.   new pitch arriving");
const total: Tally = { rows: 0, pos: 0, posSamePitch: 0, posNewPitch: 0 };
for (const [stem, t] of [...perTake.entries()].sort()) {
  console.log(
    `${stem.padEnd(42)} ${String(t.rows).padStart(4)}  ${String(t.pos).padStart(4)}   ${String(t.posSamePitch).padStart(18)}   ${String(t.posNewPitch).padStart(17)}`
  );
  total.rows += t.rows;
  total.pos += t.pos;
  total.posSamePitch += t.posSamePitch;
  total.posNewPitch += t.posNewPitch;
}
console.log(
  `${"TOTAL".padEnd(42)} ${String(total.rows).padStart(4)}  ${String(total.pos).padStart(4)}   ${String(total.posSamePitch).padStart(18)}   ${String(total.posNewPitch).padStart(17)}`
);
console.log(
  `\n  ${total.posSamePitch} of ${total.pos} derivation positives (${((total.posSamePitch / total.pos) * 100).toFixed(0)}%) are the decision every`
);
console.log("  study since DECISION-009 has called the same-pitch re-articulation problem.");
