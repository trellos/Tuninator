/**
 * The signed distance between a detection's `startedAt` and the label it was
 * paired with, take by take — and, for every label the matcher left unmatched,
 * the Notes that opened near it and who took them.
 *
 * The downstream ledger attributes ten misses on the 140bpm takes to "split
 * made; successor paired with a neighbouring label": a boundary WAS found and a
 * Note DID open, but the matcher handed it to the label on the other side. That
 * only happens if starts sit systematically off their true attacks, so the
 * offset distribution has to be measured before anything is changed.
 *
 * Usage:
 *   npx tsx scripts/measure-onset-offset.ts          lead + sixteenths
 *   npx tsx scripts/measure-onset-offset.ts --all    every fixture
 *   npx tsx scripts/measure-onset-offset.ts sixteenths
 */

import { readFileSync } from "node:fs";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { matchEvents, type LabeledEvent } from "../src/offline/matcher.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

const FOCUS = ["sixteenths", "quarter-eighth-triplet"];
/** How near a label a Note has to open to be worth naming in the miss dump. */
const NEAR_MS = 160;

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (i - lo);
}

function main(): void {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const filter = args.find((a) => !a.startsWith("--"));
  const select = (stem: string): boolean => {
    if (filter !== undefined) return stem.includes(filter);
    if (all) return true;
    return FOCUS.some((f) => stem.includes(f));
  };

  const global: number[] = [];

  for (const fixture of decodeFixtures({ quiet: true })) {
    if (!select(fixture.stem)) continue;
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const events: TrackerTraceEvent[] = [];
    const analysis = analyzeSamples(mono, wav.sampleRate, {
      trackerTrace: (event) => events.push(event),
    });
    const detections = projectEmissions(analysis.emissions).final;
    const labels = fixture.label.events as LabeledEvent[];
    const result = matchEvents(labels, detections);

    const deltas = result.matches.map((m) => m.onsetDeltaMs).sort((a, b) => a - b);
    global.push(...deltas);
    const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);

    console.log(`\n  ${fixture.stem}`);
    console.log(
      `    matched ${deltas.length}/${labels.length}   ` +
        `onsetDelta ms  min ${quantile(deltas, 0).toFixed(0)}` +
        `  p25 ${quantile(deltas, 0.25).toFixed(0)}` +
        `  median ${quantile(deltas, 0.5).toFixed(0)}` +
        `  p75 ${quantile(deltas, 0.75).toFixed(0)}` +
        `  max ${quantile(deltas, 1).toFixed(0)}` +
        `  mean ${mean.toFixed(1)}`
    );

    if (result.missed.length === 0) continue;
    const takenBy = new Map<string, LabeledEvent>();
    for (const m of result.matches) takenBy.set(m.detection.id, m.label);
    const opens = events.filter(
      (e): e is Extract<TrackerTraceEvent, { kind: "opened" }> => e.kind === "opened"
    );

    console.log(`    missed:`);
    for (const { label } of result.missed) {
      const near = opens.filter((o) => Math.abs(o.at - label.startMs) <= NEAR_MS);
      const shown = near
        .map((o) => {
          const owner = takenBy.get(o.noteId);
          const who =
            owner === undefined
              ? "unemitted"
              : owner.id === label.id
                ? "THIS"
                : `->${owner.id}@${owner.startMs.toFixed(0)}`;
          return `${o.noteId}@${(o.at - label.startMs).toFixed(0)}(${o.trigger},${who})`;
        })
        .join(" ");
      console.log(
        `      ${label.id.padEnd(4)} @${label.startMs.toFixed(0).padStart(6)} ` +
          `${label.label.padEnd(6)} ${shown === "" ? "(no Note opened within " + NEAR_MS + "ms)" : shown}`
      );
    }
  }

  global.sort((a, b) => a - b);
  const mean = global.reduce((a, b) => a + b, 0) / Math.max(1, global.length);
  console.log(
    `\n  all matched pairs (${global.length})  min ${quantile(global, 0).toFixed(0)}` +
      `  p10 ${quantile(global, 0.1).toFixed(0)}` +
      `  p25 ${quantile(global, 0.25).toFixed(0)}` +
      `  median ${quantile(global, 0.5).toFixed(0)}` +
      `  p75 ${quantile(global, 0.75).toFixed(0)}` +
      `  p90 ${quantile(global, 0.9).toFixed(0)}` +
      `  max ${quantile(global, 1).toFixed(0)}  mean ${mean.toFixed(1)}\n`
  );
}

main();
