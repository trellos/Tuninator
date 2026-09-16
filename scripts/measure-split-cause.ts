/**
 * Which decision site places the boundary inside a single picked note?
 *
 * `measure-splits.ts` counts split events and `measure-tail-fragments.ts`
 * classifies their shape — 296 of the corpus's 320 fragment Notes are the same
 * pitch as the label and contiguous with the Note before them, which is one
 * played note cut in two. Neither says WHAT cut it. This does: for every such
 * fragment, it takes the tracker's own accepted-rearticulation trace nearest
 * the fragment's start and tallies that decision's `reason`.
 *
 * It exists because the answer is lopsided in a way that decides what to try
 * next. Two thirds of the defect (199 of 296) is accepted by a single test,
 * `sharpness` in `rearticulation.ts`, and the sharpness readings at those
 * WRONG boundaries are strong — median 3.94, p90 9.78. So the engine is not
 * failing to compute something at these instants; it is reading a genuine
 * spectral rise and calling it a pick, which is DECISION-028's 0.698 AUC
 * ceiling seen from the phantom side rather than the missed side. A fragment
 * with no accepted rearticulation within `DECISION_WINDOW_MS` came from
 * somewhere else entirely (the region lane, or a Note ending and restarting)
 * and is reported as its own row rather than folded in.
 *
 * The assignment rule, the shape test and every constant are copied verbatim
 * from `measure-tail-fragments.ts` so the two scripts agree on which fragments
 * exist before this one says why. Nothing here re-implements the tracker: the
 * reason strings are the tracker's own, from `TrackerTraceEvent`.
 *
 * Usage:
 *   npx tsx scripts/measure-split-cause.ts
 */
import { readFileSync } from "node:fs";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { parseLabel } from "../src/offline/matcher.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

const ONSET_TOLERANCE_MS = 120;
const ORPHAN_GAP_MS = 400;
const CONTIGUOUS_GAP_MS = 120;
/** How near a fragment's start an accepted decision has to be to be its. */
const DECISION_WINDOW_MS = 60;

const pitchClassOf = (name: string): string | null => parseLabel(name, "note").pitchClass;

type Row = { stem: string; frags: number; reasons: Map<string, number> };
const rows: Row[] = [];
const sharpAccepted: number[] = [];

for (const fixture of decodeFixtures({ quiet: true })) {
  const wav = readWav(readFileSync(fixture.wavPath));
  const mono = downmixToMono(wav.samples, wav.channels);
  const trace: TrackerTraceEvent[] = [];
  const analysis = analyzeSamples(mono, wav.sampleRate, {
    trackerTrace: (event) => trace.push(event),
  });
  const detections = projectEmissions(analysis.emissions).final;
  const labels = fixture.label.events;

  const assigned = new Map<string, typeof detections>();
  for (const detection of detections) {
    let owner: (typeof labels)[number] | null = null;
    let nearest = Infinity;
    for (const candidate of labels) {
      const distance = Math.abs(detection.startedAt - candidate.startMs);
      if (distance >= nearest) continue;
      nearest = distance;
      owner = candidate;
    }
    if (owner === null) continue;
    const placed =
      nearest <= ONSET_TOLERANCE_MS ||
      (detection.startedAt >= owner.startMs && detection.startedAt <= owner.endMs);
    if (!placed) continue;
    if (detection.startedAt > owner.endMs + ORPHAN_GAP_MS) continue;
    const bucket = assigned.get(owner.id) ?? [];
    bucket.push(detection);
    assigned.set(owner.id, bucket);
  }

  const row: Row = { stem: fixture.stem, frags: 0, reasons: new Map() };
  for (const label of labels) {
    const bucket = (assigned.get(label.id) ?? []).sort((a, b) => a.startedAt - b.startedAt);
    if (bucket.length < 2) continue;
    const labelClass = parseLabel(label.label, label.kind).pitchClass;
    for (let i = 1; i < bucket.length; i++) {
      const note = bucket[i] as (typeof bucket)[number];
      const previous = bucket[i - 1] as (typeof bucket)[number];
      const gapMs = previous.endedAt === null ? null : note.startedAt - previous.endedAt;
      const samePitch = labelClass !== null && pitchClassOf(note.label.name) === labelClass;
      const contiguous = gapMs !== null && gapMs <= CONTIGUOUS_GAP_MS;
      if (!samePitch || !contiguous) continue;
      row.frags++;
      let best: TrackerTraceEvent | null = null;
      let dist = Infinity;
      for (const event of trace) {
        if (event.kind !== "rearticulation" || !event.accepted) continue;
        const d = Math.abs(event.at - note.startedAt);
        if (d < dist && d <= DECISION_WINDOW_MS) {
          dist = d;
          best = event;
        }
      }
      const key =
        best === null ? "(no accepted rearticulation within 60ms)" : `accepted: ${best.reason}`;
      row.reasons.set(key, (row.reasons.get(key) ?? 0) + 1);
      if (best !== null && best.kind === "rearticulation") sharpAccepted.push(best.sharpness);
    }
  }
  rows.push(row);
}

const all = new Map<string, number>();
for (const r of rows) for (const [k, v] of r.reasons) all.set(k, (all.get(k) ?? 0) + v);
const keys = [...all.keys()].sort((a, b) => (all.get(b) ?? 0) - (all.get(a) ?? 0));
const W = 48;

console.log("\n  same-pitch contiguous fragments, by the site that ACCEPTED the boundary\n");
process.stdout.write(
  "  " + "fixture".padEnd(W) + "frags" + keys.map((k) => k.slice(0, 26).padStart(28)).join("") + "\n"
);
process.stdout.write("  " + "-".repeat(W + 5 + 28 * keys.length) + "\n");
for (const r of rows) {
  if (r.frags === 0) continue;
  process.stdout.write(
    "  " + r.stem.padEnd(W) + String(r.frags).padStart(5) +
      keys.map((k) => String(r.reasons.get(k) ?? 0).padStart(28)).join("") + "\n"
  );
}
process.stdout.write(
  "  " + "TOTAL".padEnd(W) + String(rows.reduce((s, r) => s + r.frags, 0)).padStart(5) +
    keys.map((k) => String(all.get(k) ?? 0).padStart(28)).join("") + "\n"
);
if (sharpAccepted.length > 0) {
  const s = [...sharpAccepted].sort((a, b) => a - b);
  const q = (p: number): string => (s[Math.floor(p * (s.length - 1))] ?? 0).toFixed(2);
  console.log(
    `\n  sharpness at these accepted boundaries, n=${s.length}: ` +
      `p10 ${q(0.1)}  median ${q(0.5)}  p90 ${q(0.9)}`
  );
}
