/**
 * How many played events come out as more than one Note?
 *
 * The eval's false-positive count understates fragmentation: its matcher pairs
 * exactly one detection with each label, so a chord that shattered into eleven
 * Notes shows up as one match plus however many extras happen to fall outside
 * the onset window. This script asks the blunter question instead — for every
 * labelled event, how many Notes did the recognizer emit for it — and that is
 * the number that has to come down.
 *
 * Assignment is deliberately crude and independent of the matcher: a detection
 * belongs to the label whose annotated onset it began NEAREST to. Detections
 * before the first label, or more than `ORPHAN_GAP_MS` after the label they
 * would attach to has ended, are counted separately as strays rather than
 * blamed on a label.
 *
 * Nearest, rather than "the most recent label that had already started, within
 * a tolerance". That rule was written for the 120bpm fixtures, where a fixed
 * 120ms tolerance is comfortably narrower than the gap between events, and it
 * silently inverted on the 140bpm takes, where a triplet is 140ms: a Note
 * beginning 118ms BEFORE a label was handed to that label rather than to the
 * one 22ms before it, and the event it really belonged to was then charged with
 * a split it had not committed. Nearest cannot invert, because it never reaches
 * past the midpoint between two labels.
 *
 * Usage:
 *   npx tsx scripts/measure-splits.ts
 *   npx tsx scripts/measure-splits.ts --detail      per-label breakdown
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { labelOf, projectEmissions } from "../src/offline/eval-adapter.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/**
 * How far BEFORE a label's annotated onset a Note may begin and still be its.
 *
 * Not a search radius — a reach forward. A Note belongs to the last event that
 * had started when it did, and this only covers the case where it begins
 * slightly early: it is backdated onto its own attack, and the hand annotation
 * is not sample-exact. Matched detections sit at a median of +12ms from their
 * label over 266 pairs, with a tenth percentile near -35ms, so 40 covers every
 * genuine early start.
 *
 * It must stay well under the tightest subdivision in the corpus — a sixteenth
 * at 140bpm is 107ms — or it reaches past the next onset and charges a Note to
 * an event that had not begun. At 120 it did exactly that, and the resulting
 * "previous note's pitch, then the right one" pattern was read twice as a
 * naming defect. It is a tail fragment of the event BEFORE, charged forward.
 */
export const ONSET_TOLERANCE_MS = 40;
/** How long after a label ends a Note may begin and still be counted against it. */
export const ORPHAN_GAP_MS = 400;

/**
 * The ownership rule, extracted so `build-relabel-kit.ts` charges extra Notes
 * to exactly the labels this script charges them to. Returns the index of the
 * owning label in `labels` (which must be sorted by startMs), or -1 for a
 * stray.
 */
export function ownerIndexOf(
  labels: ReadonlyArray<{ startMs: number; endMs: number }>,
  startedAt: number
): number {
  let owner = -1;
  for (let i = 0; i < labels.length; i++) {
    if (startedAt + ONSET_TOLERANCE_MS < (labels[i] as { startMs: number }).startMs) break;
    owner = i;
  }
  if (owner === -1) return -1;
  if (startedAt > (labels[owner] as { endMs: number }).endMs + ORPHAN_GAP_MS) return -1;
  return owner;
}

type LabelRow = {
  id: string;
  label: string;
  startMs: number;
  endMs: number;
  notes: string[];
};

type FixtureRow = {
  stem: string;
  labels: LabelRow[];
  strays: number;
  /**
   * The same question asked the other way: how many Notes were sounding at any
   * point inside the label's span. A Note that rings across a boundary is
   * counted against both labels, so this over-counts where the ownership rule
   * under-counts, and the truth is bracketed between them.
   */
  overlapSplit: number;
  overlapExtras: number;
};

function measure(): FixtureRow[] {
  const fixtures = decodeFixtures({ quiet: true });
  const rows: FixtureRow[] = [];

  for (const fixture of fixtures) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const analysis = analyzeSamples(mono, wav.sampleRate);
    const detections = projectEmissions(analysis.emissions).final;

    const labels: LabelRow[] = fixture.label.events.map((event) => ({
      id: event.id,
      label: event.label,
      startMs: event.startMs,
      endMs: event.endMs,
      notes: [],
    }));
    labels.sort((a, b) => a.startMs - b.startMs);

    let strays = 0;
    for (const detection of detections) {
      // The last event that had started when this Note did. A Note may begin
      // slightly BEFORE its label, because it is backdated onto its attack and
      // the annotation is not sample-exact, so the tolerance lets it reach one
      // event forward — but no further than the tightest subdivision in the
      // corpus, or it reaches the wrong event entirely. See `ownerIndexOf`.
      const owner = ownerIndexOf(labels, detection.startedAt);
      if (owner === -1) {
        strays++;
        continue;
      }
      (labels[owner] as LabelRow).notes.push(detection.label.name);
    }

    let overlapSplit = 0;
    let overlapExtras = 0;
    for (const label of labels) {
      const touching = detections.filter((d) => {
        const end = d.endedAt ?? d.startedAt;
        return end > label.startMs && d.startedAt < label.endMs;
      });
      if (touching.length > 1) {
        overlapSplit++;
        overlapExtras += touching.length - 1;
      }
    }

    rows.push({ stem: fixture.stem, labels, strays, overlapSplit, overlapExtras });
  }

  return rows;
}

function main(): void {
  const detail = process.argv.includes("--detail");
  const rows = measure();

  let totalLabels = 0;
  let totalSplit = 0;
  let totalExtras = 0;
  let totalStrays = 0;
  let totalOverlapSplit = 0;
  let totalOverlapExtras = 0;
  let worst = 0;

  const table: string[] = [];
  const width = Math.max(...rows.map((r) => r.stem.length), 7);
  table.push(
    `  ${"fixture".padEnd(width)}  ${"labels".padStart(6)}  ${"split".padStart(5)}  ` +
      `${"extras".padStart(6)}  ${"worst".padStart(5)}  ${"strays".padStart(6)}`
  );
  table.push(`  ${"-".repeat(width)}  ${"-".repeat(6)}  ${"-".repeat(5)}  ${"-".repeat(6)}  ${"-".repeat(5)}  ${"-".repeat(6)}`);

  for (const row of rows) {
    const split = row.labels.filter((l) => l.notes.length > 1).length;
    const extras = row.labels.reduce((sum, l) => sum + Math.max(0, l.notes.length - 1), 0);
    const fixtureWorst = Math.max(0, ...row.labels.map((l) => l.notes.length));
    totalLabels += row.labels.length;
    totalSplit += split;
    totalExtras += extras;
    totalStrays += row.strays;
    totalOverlapSplit += row.overlapSplit;
    totalOverlapExtras += row.overlapExtras;
    worst = Math.max(worst, fixtureWorst);
    table.push(
      `  ${row.stem.padEnd(width)}  ${String(row.labels.length).padStart(6)}  ` +
        `${String(split).padStart(5)}  ${String(extras).padStart(6)}  ` +
        `${String(fixtureWorst).padStart(5)}  ${String(row.strays).padStart(6)}`
    );
  }

  process.stdout.write(`${table.join("\n")}\n\n`);

  if (detail) {
    for (const row of rows) {
      const split = row.labels.filter((l) => l.notes.length > 1);
      if (split.length === 0) continue;
      process.stdout.write(`${row.stem}\n`);
      for (const label of split) {
        process.stdout.write(
          `  ${label.id.padEnd(4)} ${label.label.padEnd(8)} ${String(label.startMs).padStart(6)}ms  ` +
            `${label.notes.length} Notes: ${label.notes.join(" + ")}\n`
        );
      }
      process.stdout.write("\n");
    }
  }

  process.stdout.write(
    `TOTAL: ${totalSplit} of ${totalLabels} events split, ${totalExtras} extra Notes ` +
      `(worst single event ${worst} Notes, ${totalStrays} strays)\n` +
      `       counting every Note that overlaps a label instead: ` +
      `${totalOverlapSplit} of ${totalLabels} split, ${totalOverlapExtras} extra Notes\n`
  );
}

// Runs when invoked, stays quiet when imported: `build-relabel-kit.ts` reuses
// `ownerIndexOf` so its extra-Note boundaries are exactly this script's.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
