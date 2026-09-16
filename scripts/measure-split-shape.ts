/**
 * What SHAPE is a split? Four different defects look alike in a count.
 *
 * `measure-splits.ts` says how many Notes a labelled event came out as, and its
 * `--detail` prints their names — which invites the reading that "C5 then D5 on
 * a D5 label" is one event named twice, first with its predecessor's pitch.
 * That reading is testable, and it is mostly wrong. This separates the cases by
 * where the leading Note actually BEGAN:
 *
 *  - `predecessor's own`  it began before this label did, by more than
 *    `OWN_ONSET_MS`. It is the previous event's Note, or a fragment of it,
 *    charged here by the nearest-label rule. Nothing about this label was
 *    misnamed.
 *  - `same pitch twice`   it began on this label and carries this label's own
 *    name. A boundary the player did not put there.
 *  - `named as before`    it began on this label and carries the PREVIOUS
 *    label's name, and NOT its own. This is the pitch-lag shape: the boundary
 *    is right and the name describes audio from before it.
 *  - `named as neither`   something else entirely.
 *
 * **The two name tests are ordered own-name-first, and the order matters.**
 * Where consecutive labels carry the SAME pitch the two tests both pass, and
 * they are asking different questions: `named as before` is a claim that the
 * name is WRONG, `same pitch twice` that the boundary is wrong. When the names
 * coincide the name is not wrong — there is no naming defect to report — so the
 * split belongs to the segmentation shape. Testing previous-name first, as this
 * script originally did, made `same pitch twice` unreachable on exactly the
 * material recorded to study it: on `same-pitch-eighths-a3` every label is A3,
 * so all 20 of that take's correctly-named splits were filed as a naming defect
 * and the take reported one `same pitch twice`. The `ambiguous` column below
 * counts the splits where the two names coincide, so the reach of this ordering
 * is visible rather than assumed.
 *
 * Usage:
 *   npx tsx scripts/measure-split-shape.ts
 *   npx tsx scripts/measure-split-shape.ts --detail
 *   npx tsx scripts/measure-split-shape.ts sixteenths
 */

import { readFileSync } from "node:fs";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/**
 * How far from a label's own onset a Note may begin and still be a Note that
 * began HERE. Wider than the measured start error (median +12ms over 266
 * matched pairs) and far narrower than a triplet at 140bpm.
 */
const OWN_ONSET_MS = 45;
/** The same bound `measure-splits.ts` uses, so the two agree on what is a split. */
const ONSET_TOLERANCE_MS = 120;
const ORPHAN_GAP_MS = 400;

type Shape = "predecessor's own" | "named as before" | "same pitch twice" | "named as neither";

type Row = {
  stem: string;
  split: number;
  counts: Map<Shape, number>;
  /** Of the `predecessor's own` leaders, how many carry the PREVIOUS label's name. */
  predecessorNamed: number;
  /** Splits where this label and the one before it carry the same pitch. */
  ambiguous: number;
};

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

    // The assignment rule `measure-splits.ts` uses, copied so the two scripts
    // agree on which events are split before they disagree about why.
    const assigned = new Map<string, Array<{ startedAt: number; name: string }>>();
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
      bucket.push({ startedAt: detection.startedAt, name: detection.label.name });
      assigned.set(owner.id, bucket);
    }

    const row: Row = {
      stem: fixture.stem,
      split: 0,
      counts: new Map(),
      predecessorNamed: 0,
      ambiguous: 0,
    };
    if (detail) console.log(`\n  ${fixture.stem}`);
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i] as (typeof labels)[number];
      const previous = i > 0 ? (labels[i - 1] as (typeof labels)[number]) : null;
      const bucket = (assigned.get(label.id) ?? []).sort((a, b) => a.startedAt - b.startedAt);
      if (bucket.length < 2) continue;
      row.split++;
      const leader = bucket[0] as { startedAt: number; name: string };
      const name = leader.name;
      const offset = leader.startedAt - label.startMs;
      const shape: Shape =
        offset < -OWN_ONSET_MS
          ? "predecessor's own"
          : name === label.label
            ? "same pitch twice"
            : previous !== null && name === previous.label
              ? "named as before"
              : "named as neither";
      row.counts.set(shape, (row.counts.get(shape) ?? 0) + 1);
      // Where this label and the one before it carry the same pitch, the two
      // name tests cannot separate a naming defect from a segmentation one.
      // Counted so the ordering above is auditable instead of silent.
      if (previous !== null && previous.label === label.label) row.ambiguous++;
      if (shape === "predecessor's own" && previous !== null && name === previous.label) {
        row.predecessorNamed++;
      }
      if (detail) {
        console.log(
          `    ${label.id.padEnd(4)} ${label.label.padEnd(6)} @${label.startMs.toFixed(0).padStart(6)}` +
            `  ${bucket.map((n) => n.name).join(" + ").padEnd(22)}` +
            `  leader starts ${offset >= 0 ? "+" : ""}${offset.toFixed(0)}ms  ${shape}`
        );
      }
    }
    rows.push(row);
  }

  const shapes: Shape[] = [
    "predecessor's own",
    "named as before",
    "same pitch twice",
    "named as neither",
  ];
  const table: string[][] = [["fixture", "split events", ...shapes, "...named as ITS own label", "ambiguous"]];
  for (const r of rows) {
    table.push([
      r.stem,
      String(r.split),
      ...shapes.map((s) => String(r.counts.get(s) ?? 0)),
      String(r.predecessorNamed),
      String(r.ambiguous),
    ]);
  }
  table.push([
    "TOTAL",
    String(rows.reduce((n, r) => n + r.split, 0)),
    ...shapes.map((s) => String(rows.reduce((n, r) => n + (r.counts.get(s) ?? 0), 0))),
    String(rows.reduce((n, r) => n + r.predecessorNamed, 0)),
    String(rows.reduce((n, r) => n + r.ambiguous, 0)),
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
    `\n  A leader beginning more than ${OWN_ONSET_MS}ms before its label's own onset did not\n` +
      "  begin here: it is the previous event's Note, charged to this label by the\n" +
      "  nearest-label rule. Only `named as before` is a naming defect; `same pitch\n" +
      "  twice` is a segmentation one.\n" +
      "\n" +
      `  CAUTION on \`predecessor's own\`. Its ${OWN_ONSET_MS}ms window is narrower than the\n` +
      "  label-placement offset some takes carry, so on those it separates nothing:\n" +
      "  a leader that begins 'before' a label which itself sits late is this\n" +
      "  label's own Note. The amp-sim renders of the 120bpm same-pitch material\n" +
      "  are the case in point — their labels were calibrated on the DI render and\n" +
      "  applied unchanged, and `verify-fixtures.ts` puts their median offset at up\n" +
      "  to 65ms. Read that column on those takes as an upper bound, not a count.\n"
  );
}

main();
