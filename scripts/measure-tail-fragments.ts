/**
 * The same-pitch tail fragment, measured without reference to label onsets.
 *
 * `measure-split-shape.ts` classifies a split by where its LEADING Note began
 * relative to the label. That works while the labels are well placed, and it
 * stops working when they are not: its `predecessor's own` window is 45ms, and
 * the amp-sim renders of the 120bpm same-pitch material carry a label offset up
 * to 65ms because their labels were calibrated on the DI render and applied
 * unchanged (`docs/SAME-PITCH-MATERIAL.md`). A window narrower than the error
 * it is measuring separates nothing — the failure this repository has walked
 * into at least four times, recorded in `docs/DETECTION-FINDINGS.md`.
 *
 * So this asks the question the defect actually poses, which needs no onset at
 * all. `docs/DETECTION-FINDINGS.md` describes the shape as
 *
 *   > a correctly-named ~130ms Note, then a ~70ms tail fragment at the same
 *   > pitch
 *
 * The load-bearing part of that is a relation BETWEEN two Notes — are they at
 * the same pitch and butted up against each other — plus the event's own pitch,
 * which the label states. Neither needs the label's ONSET. A label is used only
 * to decide which Notes belong to one played event, and for that a
 * nearest-label assignment is enough: an error of tens of milliseconds in a
 * label's position does not move a Note into a different event when events are
 * 125ms apart at the very fastest.
 *
 * Each Note past the first in an event is classified against the LABEL's pitch
 * class rather than against the leading Note's. The label's name is ground
 * truth; the leading Note's name is not, and where the leader is really the
 * previous event's Note charged here by the nearest-label rule, anchoring on it
 * misfiles the whole event.
 *
 *  - `same pitch`    carries the label's own pitch class and begins within
 *    `CONTIGUOUS_GAP_MS` of the Note before it. A boundary inside one played
 *    event, at that event's own pitch. The defect.
 *  - `detached`      the label's pitch class, but separated by real silence.
 *    Two events with a gap between them are not one event split.
 *  - `other pitch`   a different pitch class. A naming defect, not this one.
 *
 * The `shortest ms` column is the duration profile the defect is usually
 * described by: the median, across split events, of the SHORTEST Note in the
 * event. It is reported rather than tested on, because which of the two Notes
 * is the short one turns out to vary and nothing here should depend on it.
 *
 * Usage:
 *   npx tsx scripts/measure-tail-fragments.ts
 *   npx tsx scripts/measure-tail-fragments.ts --detail
 *   npx tsx scripts/measure-tail-fragments.ts amped
 */

import { readFileSync } from "node:fs";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { parseLabel } from "../src/offline/matcher.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/** The bound `measure-splits.ts` uses, so all three scripts agree on a split. */
const ONSET_TOLERANCE_MS = 120;
const ORPHAN_GAP_MS = 400;

/**
 * Largest silence between two Notes that still reads as one event cut in two.
 *
 * `harmony.mergeMaxGapMs` is 120 and is the engine's own answer to the same
 * question; this is deliberately the same number, so that a fragment this
 * script calls contiguous is one the engine would also be willing to bridge.
 * Nothing is tuned against it — it only partitions the report.
 */
const CONTIGUOUS_GAP_MS = 120;

type Shape = "same pitch" | "detached" | "other pitch";

const SHAPES: readonly Shape[] = ["same pitch", "detached", "other pitch"];

type Row = {
  stem: string;
  /** Labelled events that came out as more than one Note. */
  split: number;
  /** Notes past the first, across those events. */
  extras: number;
  counts: Map<Shape, number>;
  /** Per split event, the duration of its SHORTEST Note, ms. */
  shortestMs: number[];
  /** Per split event, the duration of its LONGEST Note, ms. */
  longestMs: number[];
};

function pitchClassOf(name: string): string | null {
  return parseLabel(name, "note").pitchClass;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function main(): void {
  const args = process.argv.slice(2);
  const detail = args.includes("--detail");
  const filter = args.find((a) => !a.startsWith("--"));

  const rows: Row[] = [];
  for (const fixture of decodeFixtures({ quiet: true })) {
    if (filter !== undefined && !fixture.stem.includes(filter)) continue;
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const detections = projectEmissions(analyzeSamples(mono, wav.sampleRate).emissions).final;
    const labels = fixture.label.events;

    // The assignment rule `measure-splits.ts` uses, copied so the scripts agree
    // on which events are split before they disagree about why.
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

    const row: Row = {
      stem: fixture.stem,
      split: 0,
      extras: 0,
      counts: new Map(),
      shortestMs: [],
      longestMs: [],
    };
    if (detail) console.log(`\n  ${fixture.stem}`);

    for (const label of labels) {
      const bucket = (assigned.get(label.id) ?? []).sort((a, b) => a.startedAt - b.startedAt);
      if (bucket.length < 2) continue;
      row.split++;
      const labelClass = parseLabel(label.label, label.kind).pitchClass;
      const spans = bucket
        .map((note) => (note.endedAt === null ? null : note.endedAt - note.startedAt))
        .filter((ms): ms is number => ms !== null);
      if (spans.length > 0) {
        row.shortestMs.push(Math.min(...spans));
        row.longestMs.push(Math.max(...spans));
      }

      for (let i = 1; i < bucket.length; i++) {
        const note = bucket[i] as (typeof bucket)[number];
        const previous = bucket[i - 1] as (typeof bucket)[number];
        row.extras++;
        const durationMs = note.endedAt === null ? null : note.endedAt - note.startedAt;
        const gapMs = previous.endedAt === null ? null : note.startedAt - previous.endedAt;
        const samePitch =
          labelClass !== null && pitchClassOf(note.label.name) === labelClass;
        const contiguous = gapMs !== null && gapMs <= CONTIGUOUS_GAP_MS;

        const shape: Shape = !samePitch
          ? "other pitch"
          : !contiguous
            ? "detached"
            : "same pitch";

        row.counts.set(shape, (row.counts.get(shape) ?? 0) + 1);
        if (detail) {
          console.log(
            `    ${label.id.padEnd(5)} ${label.label.padEnd(5)}` +
              `  ${previous.label.name.padEnd(4)} ->  ${note.label.name.padEnd(4)}` +
              ` ${(durationMs ?? 0).toFixed(0).padStart(4)}ms` +
              `  gap ${(gapMs ?? 0).toFixed(0).padStart(4)}ms  ${shape}`
          );
        }
      }
    }
    rows.push(row);
  }

  const table: string[][] = [
    ["fixture", "split", "extras", ...SHAPES, "shortest ms", "longest ms"],
  ];
  for (const r of rows) {
    table.push([
      r.stem,
      String(r.split),
      String(r.extras),
      ...SHAPES.map((s) => String(r.counts.get(s) ?? 0)),
      median(r.shortestMs)?.toFixed(0) ?? "—",
      median(r.longestMs)?.toFixed(0) ?? "—",
    ]);
  }
  const allShortest = rows.flatMap((r) => r.shortestMs);
  const allLongest = rows.flatMap((r) => r.longestMs);
  table.push([
    "TOTAL",
    String(rows.reduce((n, r) => n + r.split, 0)),
    String(rows.reduce((n, r) => n + r.extras, 0)),
    ...SHAPES.map((s) => String(rows.reduce((n, r) => n + (r.counts.get(s) ?? 0), 0))),
    median(allShortest)?.toFixed(0) ?? "—",
    median(allLongest)?.toFixed(0) ?? "—",
  ]);

  const width: number[] = [];
  for (const row of table) row.forEach((c, i) => (width[i] = Math.max(width[i] ?? 0, c.length)));
  table.splice(1, 0, width.map((w) => "-".repeat(w)));
  console.log("");
  for (const row of table) {
    console.log(
      "  " +
        row
          .map((c, i) => (i === 0 ? c.padEnd(width[i] as number) : c.padStart(width[i] as number)))
          .join("  ")
    );
  }
  console.log(
    `\n  A Note past the first in a labelled event is \`same pitch\` when it carries\n` +
      `  the LABEL's pitch class and begins within ${CONTIGUOUS_GAP_MS}ms of the Note before it. No\n` +
      "  label ONSET enters that test, only the assignment of Notes to events, so a\n" +
      "  systematically late label set does not move the count. `shortest ms` and\n" +
      "  `longest ms` are medians across split events of the shortest and longest\n" +
      "  Note each came out as.\n"
  );
}

main();
