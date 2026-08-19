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
 * belongs to the most recent label that had already started when it did (with a
 * small tolerance, because a Note backdated onto its attack can begin slightly
 * before the hand-annotated onset). Detections before the first label, or more
 * than `ORPHAN_GAP_MS` after the label they would attach to has ended, are
 * counted separately as strays rather than blamed on a label.
 *
 * Usage:
 *   npx tsx scripts/measure-splits.ts
 *   npx tsx scripts/measure-splits.ts --detail      per-label breakdown
 */

import { readFileSync } from "node:fs";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { labelOf, projectEmissions } from "../src/offline/eval-adapter.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/** How far before a label's annotated onset a Note may begin and still be its. */
const ONSET_TOLERANCE_MS = 120;
/** How long after a label ends a Note may begin and still be counted against it. */
const ORPHAN_GAP_MS = 400;

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
      let owner: LabelRow | null = null;
      for (const candidate of labels) {
        if (detection.startedAt < candidate.startMs - ONSET_TOLERANCE_MS) break;
        owner = candidate;
      }
      if (owner === null || detection.startedAt > owner.endMs + ORPHAN_GAP_MS) {
        strays++;
        continue;
      }
      owner.notes.push(detection.label.name);
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

main();
