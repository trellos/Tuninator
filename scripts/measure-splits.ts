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
 * belongs to the label whose bar it OVERLAPS MOST, each bar widened by
 * `OWNERSHIP_LEEWAY_MS` at both ends. A detection that overlaps no widened bar
 * is counted separately as a stray rather than blamed on a label.
 *
 * Most overlap, rather than "the last label that had started when the Note
 * did, within a 40ms reach forward" (the rule until 2026-09-19, DECISION-063).
 * That rule was right for a Note that began under its own label and wrong for
 * one that began early: a Note starting 67ms before its label was charged to
 * the label BEFORE it, so on the same-pitch takes, where a slow pick's release
 * sounds 45-70ms after its contact, a boundary moved onto the right event
 * moved the charge onto its neighbour and the count read flat (DECISION-049,
 * DECISION-051, DECISION-054). Overlap cannot do that: a Note that mostly
 * covers one bar is that bar's, whatever the tolerance at its start; a Note
 * that starts in a rest and runs into the next bar is the next bar's, which
 * is where the owner's ear puts it; and a Note that fills no bar at all is a
 * stray, not a charge against the note it happened to follow.
 *
 * Usage:
 *   npx tsx scripts/measure-splits.ts
 *   npx tsx scripts/measure-splits.ts --detail      per-label breakdown
 *   npx tsx scripts/measure-splits.ts --subset=slow  quarters and eighths only (see SUBSETS)
 *   npx tsx scripts/measure-splits.ts --fixtures=<regex> --ids=<regex>
 *                                                   any other slice: fixture stems and
 *                                                   label ids matching both regexes
 *
 * A filter narrows which LABELS are reported. Ownership is assigned over the
 * whole take first, so a Note is still charged to the event it began under
 * even when that event is outside the slice; the slice only decides which
 * events are counted and printed. Strays are per take and are not sliced.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { labelOf, projectEmissions } from "../src/offline/eval-adapter.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/**
 * How far past a label's annotated start and end its bar reaches when a Note
 * is charged to it. The matcher's own onset tolerance: matched detections sit
 * at a median of +12ms from their label over 266 pairs, with a tenth
 * percentile near -35ms, so 40 covers every genuine early start. It must stay
 * well under the tightest subdivision in the corpus (a sixteenth at 140bpm is
 * 107ms). Read on 2026-09-19 against 0 and 80: 0 and 40 count identically
 * everywhere, and at 80 the count starts to fall by neighbouring bars sharing
 * a Note rather than by any boundary moving (DECISION-063).
 */
export const OWNERSHIP_LEEWAY_MS = 40;

/**
 * Named slices of the corpus, as `--subset=<name>`.
 *
 * `slow` is the quarter- and eighth-note material — the notes a rhythm game's
 * tutorial asks for, and the ones the owner reports splitting in play. The
 * rule is per fixture because the takes mix subdivisions in one file and the
 * label ids carry the section: on the three lead-line takes `q*` and `e*` are
 * the 13 quarters and 18 eighths and `t*` the triplets; on the two same-pitch
 * eighths takes `e*` is the eighth section and `s16*` the sixteenths;
 * `clean-lead`'s `q*` is its quarter section. The quarters and
 * held-then-picked takes are slow throughout. Chord takes are strummed at
 * quarter spacing too but are a different phenomenon and are left out. A
 * fixture not listed contributes nothing to the slice. 754 labels as of
 * 2026-09-18; `docs/slow-note-splits-loop-log.md` carries the baseline.
 */
const SUBSETS: Record<string, ReadonlyArray<{ fixtures: RegExp; ids: RegExp }>> = {
  slow: [
    { fixtures: /^lead-line-.*quarter-eighth-triplet/, ids: /^(q|e)/ },
    { fixtures: /^clean-lead-120bpm$/, ids: /^q/ },
    { fixtures: /^same-pitch-quarters-a3-e5-120bpm/, ids: /./ },
    { fixtures: /^same-pitch-eighths-a3-120bpm/, ids: /^e/ },
    { fixtures: /^same-pitch-eighths-sixteenths-e5-120bpm/, ids: /^e/ },
    { fixtures: /^held-then-picked-six-strings-120bpm/, ids: /./ },
  ],
};

type LabelFilter = (stem: string, id: string) => boolean;

/** The `--subset`, `--fixtures` and `--ids` arguments as one predicate. */
function labelFilter(argv: readonly string[]): LabelFilter | null {
  const value = (flag: string): string | undefined =>
    argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const subsetName = value("--subset");
  const fixtures = value("--fixtures");
  const ids = value("--ids");
  if (subsetName === undefined && fixtures === undefined && ids === undefined) return null;

  let subset: ReadonlyArray<{ fixtures: RegExp; ids: RegExp }> | null = null;
  if (subsetName !== undefined) {
    subset = SUBSETS[subsetName] ?? null;
    if (subset === null) {
      throw new Error(`unknown --subset "${subsetName}"; known: ${Object.keys(SUBSETS).join(", ")}`);
    }
  }
  const fixtureRe = fixtures === undefined ? null : new RegExp(fixtures);
  const idRe = ids === undefined ? null : new RegExp(ids);

  return (stem, id) => {
    if (fixtureRe !== null && !fixtureRe.test(stem)) return false;
    if (idRe !== null && !idRe.test(id)) return false;
    if (subset !== null) {
      const rule = subset.find((r) => r.fixtures.test(stem));
      if (rule === undefined || !rule.ids.test(id)) return false;
    }
    return true;
  };
}

/**
 * The ownership rule, extracted so `build-relabel-kit.ts` charges extra Notes
 * to exactly the labels this script charges them to. Returns the index of the
 * owning label in `labels` (which must be sorted by startMs), or -1 for a
 * stray.
 */
export function ownerIndexOf(
  labels: ReadonlyArray<{ startMs: number; endMs: number }>,
  startedAt: number,
  endedAt: number | null
): number {
  // A Note the engine never ended, or ended on its own start, still stood
  // somewhere: a millisecond is enough to overlap the bar it began in.
  const end = endedAt === null || endedAt <= startedAt ? startedAt + 1 : endedAt;
  let owner = -1;
  let most = 0;
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i] as { startMs: number; endMs: number };
    const overlap =
      Math.min(end, label.endMs + OWNERSHIP_LEEWAY_MS) -
      Math.max(startedAt, label.startMs - OWNERSHIP_LEEWAY_MS);
    // Strictly more, so a tie goes to the earlier bar.
    if (overlap > most) {
      most = overlap;
      owner = i;
    }
  }
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
  /** Labels in the whole take, before any `--subset`/`--ids` slice. */
  wholeTakeLabels: number;
  strays: number;
  /**
   * The same question asked the other way: how many Notes were sounding at any
   * point inside the label's own span, with no leeway. A Note that rings
   * across a boundary is counted against both labels where the ownership rule
   * charges it to one, so this over-counts where that under-counts, and the
   * truth is bracketed between them.
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
      // The bar this Note fills most of, each bar widened by the matcher's
      // onset tolerance at both ends; a Note filling no bar is a stray. See
      // `ownerIndexOf`.
      const owner = ownerIndexOf(labels, detection.startedAt, detection.endedAt);
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

    rows.push({
      stem: fixture.stem,
      labels,
      wholeTakeLabels: labels.length,
      strays,
      overlapSplit,
      overlapExtras,
    });
  }

  return rows;
}

function main(): void {
  const detail = process.argv.includes("--detail");
  const filter = labelFilter(process.argv);
  let rows = measure();

  if (filter !== null) {
    // Slice AFTER ownership: every Note has already been charged to the event
    // it began under, so narrowing the labels reported cannot move a Note onto
    // a different event. Takes with no label in the slice drop out entirely.
    rows = rows
      .map((row) => ({ ...row, labels: row.labels.filter((l) => filter(row.stem, l.id)) }))
      .filter((row) => row.labels.length > 0);
    process.stdout.write(
      `  slice: ${process.argv.filter((a) => /^--(subset|fixtures|ids)=/.test(a)).join(" ")}\n` +
        `  (strays and the overlap-rule line are per whole take, not sliced)\n\n`
    );
  }

  let totalLabels = 0;
  let totalWholeTakeLabels = 0;
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
    totalWholeTakeLabels += row.wholeTakeLabels;
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
      `${totalOverlapSplit} of ${totalWholeTakeLabels} split, ${totalOverlapExtras} extra Notes` +
      `${filter === null ? "" : " (whole takes)"}\n`
  );
}

// Runs when invoked, stays quiet when imported: `build-relabel-kit.ts` reuses
// `ownerIndexOf` so its extra-Note boundaries are exactly this script's.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
