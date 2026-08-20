/**
 * How many of the played events could the tracker possibly emit?
 *
 * Every question about a missed note eventually reduces to one of two: was the
 * evidence there, and did the tracker throw it away? This script answers the
 * first, and it answers it before any tracker rule runs — so it bounds what any
 * amount of work downstream can achieve.
 *
 * For each fixture it counts the transients the fast lane produced, split by
 * what the tracker is allowed to do with them:
 *
 *  - **accepted** — a broadband transient on a hop above the amplitude gate.
 *    This is the only witness the fast lane may act on, so the number of
 *    labelled events with one of these within `WINDOW_MS` is a hard ceiling on
 *    detections, give or take what the region lane can carve out of a Note.
 *  - **gated** — a broadband transient the amplitude gate suppressed. A note
 *    picked into the tail of the one before it can sit under the gate for the
 *    hop the pick lands on.
 *  - **band-only** — the band-limited witness fired and the broadband one did
 *    not. Recorded on the tracker's list for the region lane to corroborate
 *    against; the fast lane may not act on it. See `transient.attackBandLoHz`.
 *
 * Usage:
 *   npx tsx scripts/measure-onset-ceiling.ts
 *   npx tsx scripts/measure-onset-ceiling.ts sixteenths     one subset
 */

import { readFileSync } from "node:fs";
import { RecognitionEngine } from "../src/engine/engine.js";
import { RENDER_QUANTUM, resolveEngineConfig } from "../src/engine/config.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import type { TrackerEmission } from "../src/engine/tracker/note-tracker.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/** How near a labelled onset a transient has to be to be that event's. */
const WINDOW_MS = 60;

type Onset = { at: number; broadband: boolean; gated: boolean; band: boolean };

function onsetsOf(samples: Float32Array, sampleRate: number): {
  onsets: Onset[];
  emissions: TrackerEmission[];
} {
  const engine = new RecognitionEngine(sampleRate, resolveEngineConfig({}, { pitchFrames: true }));
  const onsets: Onset[] = [];
  const emissions: TrackerEmission[] = [];
  const block = new Float32Array(RENDER_QUANTUM);

  const collect = (output: ReturnType<RecognitionEngine["processChunk"]>): void => {
    for (const fast of output.fast) {
      if (fast.attack === null && !fast.bandOnset) continue;
      onsets.push({
        at: fast.attack?.at ?? fast.at,
        broadband: fast.attack !== null,
        gated: fast.gated,
        band: fast.bandOnset,
      });
    }
    for (const emission of output.emissions) emissions.push(emission);
  };

  for (let offset = 0; offset < samples.length; offset += RENDER_QUANTUM) {
    const available = Math.min(RENDER_QUANTUM, samples.length - offset);
    if (available === RENDER_QUANTUM) {
      block.set(samples.subarray(offset, offset + RENDER_QUANTUM));
    } else {
      block.fill(0);
      block.set(samples.subarray(offset, offset + available));
    }
    collect(engine.processChunk(block, offset));
  }
  collect(engine.flush());
  return { onsets, emissions };
}

function main(): void {
  const filter = process.argv[2];
  const fixtures = decodeFixtures({ quiet: true }).filter(
    (f) => filter === undefined || f.stem.includes(filter)
  );

  const rows: string[][] = [
    ["fixture", "labels", "detect", "accepted", "covered", "+gated", "+band"],
  ];

  for (const fixture of fixtures) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const { onsets, emissions } = onsetsOf(mono, wav.sampleRate);
    const detections = projectEmissions(emissions).final;
    const labels = fixture.label.events;

    const covered = (predicate: (o: Onset) => boolean): number =>
      labels.filter((l) =>
        onsets.some((o) => predicate(o) && Math.abs(o.at - l.startMs) <= WINDOW_MS)
      ).length;

    const accepted = onsets.filter((o) => o.broadband && !o.gated);
    rows.push([
      fixture.stem,
      String(labels.length),
      String(detections.length),
      String(accepted.length),
      String(covered((o) => o.broadband && !o.gated)),
      String(covered((o) => o.broadband)),
      String(covered(() => true)),
    ]);
  }

  const width: number[] = [];
  for (const row of rows) row.forEach((c, i) => (width[i] = Math.max(width[i] ?? 0, c.length)));
  rows.splice(1, 0, width.map((w) => "-".repeat(w)));
  for (const row of rows) {
    console.log(
      "  " +
        row
          .map((c, i) => (i === 0 ? c.padEnd(width[i] as number) : c.padStart(width[i] as number)))
          .join("  ")
    );
  }
  console.log();
  console.log(
    `  accepted = broadband transients above the amplitude gate; covered = labels with one\n` +
      `  within ${WINDOW_MS}ms. "+gated" and "+band" add the witnesses the fast lane may NOT act on.`
  );
}

main();
