/**
 * What `absorbArticulationFragment()` is offered, and what it refuses.
 *
 * The tracker's answer to a Note that opens before its pitch has arrived is to
 * let the Note that follows take its start time and keep its own name. That
 * repair either happens or it does not, and until now the trace only recorded
 * the absorptions that DID happen — so a stub nobody offered looked exactly
 * like a stub every guard was asked about and refused. Those want different
 * repairs, so `note-tracker.ts` now traces a `declined` event too, and this
 * script reads both.
 *
 * Two questions, because the answer to the first is not the answer to the
 * second:
 *
 *  1. THE CENSUS. Every offer, keyed by the call site that made it and the test
 *     that refused it. The site matters: a pitch step offers the Note it is
 *     ending as a stub of the note arriving, while an attack offers the Note a
 *     re-articulation just closed — and the second is USUALLY a whole note that
 *     should be refused, so counting them together says nothing.
 *
 *  2. THE AUDIT. Every label that came out as two Notes where the first wears
 *     the PREVIOUS label's name, which is the shape the split ledger reports
 *     most often on the lead takes. For each one: when the first Note actually
 *     started relative to the annotated onset, what opened it, whether a
 *     broadband transient fired there, and what became of it.
 *
 * The audit exists because that shape has an obvious reading — a Note opening
 * on this note's attack while the estimator still reports the last one — and
 * the offsets refute it. See `docs/DETECTION-FINDINGS.md`.
 *
 * Usage:
 *   npx tsx scripts/measure-articulation-stubs.ts
 *   npx tsx scripts/measure-articulation-stubs.ts --detail
 *   npx tsx scripts/measure-articulation-stubs.ts sixteenths
 */

import { readFileSync } from "node:fs";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import type { LabeledEvent } from "../src/offline/matcher.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/**
 * How far before a label's annotated onset a Note may begin and still be read
 * as that label's. Deliberately tight. `measure-splits.ts` uses 120ms, which is
 * most of a sixteenth at 140bpm, and at that width a second Note sitting inside
 * one label is indistinguishable from the first Note of the next one.
 */
const ONSET_TOLERANCE_MS = 40;
/** How near a Note's start a transient has to be to be the one that opened it. */
const ONSET_MATCH_MS = 20;

type Bag = Map<string, number>;

function bump(bag: Bag, key: string): void {
  bag.set(key, (bag.get(key) ?? 0) + 1);
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.round((sorted.length - 1) * q)] as number;
}

function summarise(name: string, values: number[], digits = 0): string {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) return `  ${name}: none`;
  const f = (q: number): string => quantile(v, q).toFixed(digits);
  return (
    `  ${name} n=${v.length}  min ${f(0)}  p25 ${f(0.25)}  median ${f(0.5)}` +
    `  p75 ${f(0.75)}  max ${f(1)}`
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const detail = args.includes("--detail");
  const filter = args.find((a) => !a.startsWith("--"));

  const census: Bag = new Map();
  const verdicts: Bag = new Map();
  const openedBy: Bag = new Map();
  /** Where the first Note started, relative to the label it is blamed on. */
  const stubOffsets: number[] = [];
  /** Where the SECOND Note started, relative to the same label. */
  const realOffsets: number[] = [];

  for (const fixture of decodeFixtures({ quiet: true })) {
    if (filter !== undefined && !fixture.stem.includes(filter)) continue;
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const events: TrackerTraceEvent[] = [];
    const analysis = analyzeSamples(mono, wav.sampleRate, {
      trackerTrace: (e) => events.push(e),
    });
    const detections = projectEmissions(analysis.emissions).final;
    const labels = fixture.label.events as LabeledEvent[];

    const absorbed = new Set<string>();
    const declined = new Map<string, string>();
    const opened = new Map<string, Extract<TrackerTraceEvent, { kind: "opened" }>>();
    const onsets: Array<Extract<TrackerTraceEvent, { kind: "onset" }>> = [];
    for (const event of events) {
      if (event.kind === "absorbed") absorbed.add(event.noteId);
      else if (event.kind === "declined") declined.set(event.noteId, event.reason);
      else if (event.kind === "opened") opened.set(event.noteId, event);
      else if (event.kind === "onset") onsets.push(event);
    }
    for (const event of events) {
      if (event.kind !== "declined") continue;
      bump(census, `${opened.get(event.intoId)?.trigger ?? "?"} / ${event.reason}`);
    }
    for (const event of events) {
      if (event.kind !== "absorbed") continue;
      bump(census, `${opened.get(event.intoId)?.trigger ?? "?"} / ABSORBED`);
    }

    // Ownership: a Note belongs to the latest label that had already started.
    const owned = new Map<string, typeof detections>();
    for (const detection of detections) {
      let best: LabeledEvent | null = null;
      for (const label of labels) {
        if (label.startMs - ONSET_TOLERANCE_MS > detection.startedAt) continue;
        if (best === null || label.startMs > best.startMs) best = label;
      }
      if (best === null) continue;
      const list = owned.get(best.id) ?? [];
      list.push(detection);
      owned.set(best.id, list);
    }

    const lines: string[] = [];
    for (let i = 1; i < labels.length; i++) {
      const label = labels[i] as LabeledEvent;
      const previous = labels[i - 1] as LabeledEvent;
      const notes = owned.get(label.id) ?? [];
      if (notes.length !== 2) continue;
      const stub = notes[0] as (typeof detections)[number];
      const real = notes[1] as (typeof detections)[number];
      if (stub.label.name !== previous.label) continue;
      if (real.label.name !== label.label) continue;

      const verdict = absorbed.has(stub.id)
        ? "absorbed"
        : (declined.get(stub.id) ?? "never offered");
      bump(verdicts, verdict);

      const near = onsets.filter((o) => Math.abs(o.at - stub.startedAt) <= ONSET_MATCH_MS);
      const kernel =
        near.length === 0
          ? "no transient"
          : near.some((o) => o.broadband && !o.gated)
            ? "broadband"
            : near.some((o) => o.gated)
              ? "gated"
              : "band-only";
      bump(openedBy, `${opened.get(stub.id)?.trigger ?? "?"} / ${kernel}`);
      stubOffsets.push(stub.startedAt - label.startMs);
      realOffsets.push(real.startedAt - label.startMs);

      lines.push(
        `    ${label.id.padEnd(4)} ${label.label.padEnd(5)} @${label.startMs.toFixed(0).padStart(6)}` +
          `  first ${stub.id} ${stub.label.name.padEnd(5)}` +
          ` at ${(stub.startedAt - label.startMs).toFixed(0).padStart(5)}ms` +
          `  second ${real.id} at ${(real.startedAt - label.startMs).toFixed(0).padStart(4)}ms` +
          `  ${(opened.get(stub.id)?.trigger ?? "?").padEnd(11)} ${kernel.padEnd(12)} ${verdict}`
      );
    }
    if (detail && lines.length > 0) {
      console.log(`\n  ${fixture.stem}  (${lines.length})`);
      for (const line of lines) console.log(line);
    }
  }

  const show = (title: string, bag: Bag): void => {
    console.log(`\n  ${title}`);
    const rows = [...bag.entries()].sort((a, b) => b[1] - a[1]);
    const width = Math.max(...rows.map(([k]) => k.length), 1);
    for (const [key, n] of rows) console.log(`    ${key.padEnd(width)}  ${n}`);
  };

  show("every offer to absorbArticulationFragment(), by call site and outcome", census);
  show("labels whose first Note wears the previous label's name", verdicts);
  show("what opened that first Note", openedBy);
  console.log("");
  console.log(summarise("first Note start, relative to the label it is blamed on (ms)", stubOffsets));
  console.log(summarise("second Note start, relative to the same label (ms)      ", realOffsets));
  console.log("");
}

main();
