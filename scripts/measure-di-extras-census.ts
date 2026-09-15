/**
 * What SHAPE are the extra Notes, one by one, by what opened and closed them?
 *
 * `measure-splits.ts` counts them and `measure-split-shape.ts` says where the
 * leading Note began relative to the label. Neither says what the tracker did:
 * whether the extra Note was opened by a pitch step or by an attack, whether
 * it was closed by an accepted re-articulation, and how it relates to the
 * matched Note that follows it. Those are the facts a repair has to key on,
 * and on the direct-input lead take they turn out to be one shape almost
 * throughout: a Note opened by a pitch STEP with no transient behind it,
 * closed by the pick landing tens of milliseconds later, carrying the pitch
 * the pick then plays. That is the fretting hand arriving before the picking
 * hand — a hammer-on or pull-off nobody meant as a note — and the tracker's
 * contract ("a legato pitch step is two Notes") turns it into one.
 *
 * Every row is read off the tracker's own trace and the matcher's own verdict,
 * so this describes the tracker as it is.
 *
 * Usage:
 *   npx tsx scripts/measure-di-extras-census.ts              the four DI takes
 *   npx tsx scripts/measure-di-extras-census.ts --all        every fixture
 *   npx tsx scripts/measure-di-extras-census.ts <substring>  one subset
 */

import { readFileSync } from "node:fs";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import type { Note } from "../src/types.js";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { labelOf, projectEmissions } from "../src/offline/eval-adapter.js";
import { matchEvents, parseLabel, type LabeledEvent } from "../src/offline/matcher.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

type Shape =
  | "pre-pick prefix (step-opened, attack-closed, same pitch as the pick)"
  | "pre-pick transition (step-opened, attack-closed, other pitch)"
  | "step-opened, step-closed"
  | "attack-opened, same pitch as the previous matched Note (tail fragment)"
  | "attack-opened, before a chord Note (strum fragment)"
  | "attack-opened, other"
  | "region-created"
  | "other";

type Row = {
  id: string;
  label: string;
  start: number;
  durationMs: number;
  trigger: string;
  closedByAttack: boolean;
  gapToNextMs: number | null;
  nextTrigger: string | null;
  nextLabel: string | null;
  nextMatched: boolean;
  samePcAsNext: boolean;
  samePcAsPrev: boolean;
  levelVsNext: number | null;
  shape: Shape;
};

function pitchClass(label: string, kind: string): string | null {
  return parseLabel(label, kind).pitchClass;
}

function main(): void {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const filter = args.find((a) => !a.startsWith("--"));
  const fixtures = decodeFixtures({ quiet: true }).filter((f) => {
    if (filter !== undefined) return f.stem.includes(filter);
    if (all) return true;
    return f.stem.includes("-di-");
  });

  const totals = new Map<Shape, number>();

  for (const fixture of fixtures) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const trace: TrackerTraceEvent[] = [];
    const result = analyzeSamples(mono, wav.sampleRate, {
      trackerTrace: (event) => trace.push(event),
    });
    const projection = projectEmissions(result.emissions);
    const labels = fixture.label.events as LabeledEvent[];
    const match = matchEvents(labels, projection.final);
    const matchedByDetection = new Map<string, LabeledEvent>();
    for (const m of match.matches) matchedByDetection.set(m.detection.id, m.label);
    const notes = [...result.notes].sort((a, b) => a.startTime - b.startTime);
    const byId = new Map<string, Note>();
    for (const n of notes) byId.set(n.id, n);

    const acceptedAt = new Map<string, number[]>();
    for (const event of trace) {
      if (event.kind === "rearticulation" && event.accepted && event.settled) {
        const list = acceptedAt.get(event.noteId) ?? [];
        list.push(event.at);
        acceptedAt.set(event.noteId, list);
      }
    }

    const rows: Row[] = [];
    for (const fp of match.falsePositives) {
      const note = byId.get(fp.detection.id);
      if (note === undefined) continue;
      const index = notes.indexOf(note);
      const next = notes.find((n, i) => i > index && n.startTime >= (note.endTime ?? note.startTime) - 1);
      const prev = index > 0 ? (notes[index - 1] as Note) : null;
      const end = note.endTime ?? note.startTime;
      const closedByAttack = (acceptedAt.get(note.id) ?? []).some((at) => Math.abs(at - end) <= 25);
      const label = labelOf(note);
      const nextLabel = next === undefined ? null : labelOf(next);
      const prevLabel = prev === null ? null : labelOf(prev);
      const kind = note.harmony !== undefined ? "chord" : "note";
      const samePcAsNext =
        nextLabel !== null &&
        pitchClass(label, kind) !== null &&
        pitchClass(label, kind) === pitchClass(nextLabel, next?.harmony !== undefined ? "chord" : "note");
      const samePcAsPrev =
        prevLabel !== null &&
        pitchClass(label, kind) !== null &&
        pitchClass(label, kind) === pitchClass(prevLabel, prev?.harmony !== undefined ? "chord" : "note");
      const trigger = note.origin.trigger;
      const nextTrigger = next?.origin.trigger ?? null;
      const gap = next === undefined ? null : next.startTime - end;
      const nextMatched = next !== undefined && matchedByDetection.has(next.id);
      const nextPeak = next?.amplitude.peak ?? 0;
      const ownPeak = note.amplitude.peak ?? 0;
      const levelVsNext = next === undefined || nextPeak <= 0 ? null : ownPeak / nextPeak;

      let shape: Shape;
      if (note.lifecycle === "ended" && (note.revision.lastChangeType === null && trigger === "attack" && note.hypotheses.trail.length === 0)) {
        shape = "region-created";
      } else if (trigger === "pitchChange" && closedByAttack && next !== undefined && next.origin.trigger === "attack") {
        shape = samePcAsNext
          ? "pre-pick prefix (step-opened, attack-closed, same pitch as the pick)"
          : "pre-pick transition (step-opened, attack-closed, other pitch)";
      } else if (trigger === "pitchChange") {
        shape = "step-opened, step-closed";
      } else if (trigger === "attack" && next !== undefined && next.harmony !== undefined && (gap ?? 1e9) < 150) {
        shape = "attack-opened, before a chord Note (strum fragment)";
      } else if (trigger === "attack" && samePcAsPrev) {
        shape = "attack-opened, same pitch as the previous matched Note (tail fragment)";
      } else if (trigger === "attack") {
        shape = "attack-opened, other";
      } else {
        shape = "other";
      }
      rows.push({
        id: note.id,
        label,
        start: note.startTime,
        durationMs: end - note.startTime,
        trigger,
        closedByAttack,
        gapToNextMs: gap,
        nextTrigger,
        nextLabel,
        nextMatched,
        samePcAsNext,
        samePcAsPrev,
        levelVsNext,
        shape,
      });
      totals.set(shape, (totals.get(shape) ?? 0) + 1);
    }

    const matchedTriggers = new Map<string, number>();
    for (const m of match.matches) {
      const note = byId.get(m.detection.id);
      if (note === undefined) continue;
      matchedTriggers.set(note.origin.trigger, (matchedTriggers.get(note.origin.trigger) ?? 0) + 1);
    }
    console.log(`\n  ${fixture.stem}: ${match.falsePositives.length} extra Notes of ${projection.final.length} for ${labels.length} labels`);
    console.log(
      `    matched Notes by trigger: ${[...matchedTriggers].map(([t, n]) => `${t} ${n}`).join(", ")}` +
        `   extra Notes by trigger: ${[...new Set(rows.map((r) => r.trigger))]
          .map((t) => `${t} ${rows.filter((r) => r.trigger === t).length}`)
          .join(", ")}`
    );
    for (const row of rows) {
      console.log(
        `    ${row.id.padEnd(4)} ${row.label.padEnd(7)} @${row.start.toFixed(0).padStart(6)} ${row.durationMs.toFixed(0).padStart(4)}ms ` +
          `${row.trigger.padEnd(11)} ${row.closedByAttack ? "closed-by-attack" : "                "} ` +
          `next ${(row.nextLabel ?? "-").padEnd(7)} ${(row.nextTrigger ?? "-").padEnd(11)} gap ${row.gapToNextMs === null ? "   -" : row.gapToNextMs.toFixed(0).padStart(4)}ms ` +
          `${row.nextMatched ? "matched" : "unmatch"} level/next ${row.levelVsNext === null ? "-" : row.levelVsNext.toFixed(2)}  -> ${row.shape}`
      );
    }
  }

  console.log("\n  TOTAL by shape:");
  for (const [shape, count] of [...totals].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${shape}`);
  }
}

main();
