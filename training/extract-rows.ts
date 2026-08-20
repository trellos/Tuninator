/**
 * Builds the external training population by running THIS engine over
 * GuitarSet audio — the lesson of the cycle-dissimilarity failure
 * (DECISION-015) applied: a feature (or model) is only worth measuring on the
 * population it will actually decide on, and that population is "hops where
 * an energy witness already fired over a sounding Note", not "onsets in the
 * abstract". So every training row here is a real `rearticulation` trace
 * event from `RecognitionEngine` driven over the external audio, labelled by
 * GuitarSet's own ground truth under the exact target rule the baseline
 * study defined.
 *
 * Usage:
 *   bun training/extract-rows.ts --data <guitarset-root> --out <dir> \
 *       [--flavors mic,pickup] [--chains clean,amp,room] [--limit N]
 *
 * `<guitarset-root>` must contain `annotation/*.jams` and `wav48/{mic,pickup}`
 * (48kHz mono WAV; see training/README.md for the preparation commands).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSamples } from "../src/offline/analyzer.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { applyChain, CHAINS, type Chain } from "./augment.js";
import { listTakes, loadOnsets } from "./guitarset.js";
import { collectPatches, decisionRows, RowWriter } from "./features.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] as string) : fallback;
}

const dataRoot = arg("data", "/home/user/datasets/guitarset");
const outDir = arg("out", "training/out/rows");
const flavors = arg("flavors", "mic,pickup").split(",");
const chains = arg("chains", "clean,amp,room").split(",") as Chain[];
const limit = Number(arg("limit", "0"));

for (const chain of chains) {
  if (!(CHAINS as readonly string[]).includes(chain)) throw new Error(`unknown chain ${chain}`);
}

const takes = listTakes(join(dataRoot, "annotation"));
const selected = limit > 0 ? takes.slice(0, limit) : takes;
mkdirSync(outDir, { recursive: true });

console.log(`${selected.length} takes x ${flavors.length} flavors x ${chains.length} chains`);

let totalRows = 0;
let totalPos = 0;
let totalAudioMs = 0;
let droppedNoHop = 0;
const started = Date.now();

for (const flavor of flavors) {
  for (const chain of chains) {
    const writer = new RowWriter(join(outDir, `${flavor}-${chain}`));
    let shardPos = 0;
    for (const take of selected) {
      const wavPath = join(dataRoot, "wav48", flavor, `${take.name}.wav`);
      if (!existsSync(wavPath)) {
        console.log(`  missing ${wavPath} — skipped`);
        continue;
      }
      const wav = readWav(readFileSync(wavPath));
      const mono = downmixToMono(wav.samples, wav.channels);
      const audio = applyChain(mono, wav.sampleRate, take.name, chain);
      totalAudioMs += (audio.length / wav.sampleRate) * 1000;

      const events: TrackerTraceEvent[] = [];
      analyzeSamples(audio, wav.sampleRate, { trackerTrace: (e) => events.push(e) });
      const labels = loadOnsets(take);
      const rows = decisionRows(events, labels);

      const patches = collectPatches(audio, wav.sampleRate, rows.map((r) => r.at));
      rows.forEach((row, i) => {
        const p = patches.get(i);
        if (p === undefined) {
          droppedNoHop++;
          return;
        }
        writer.write(
          {
            take: take.name,
            group: take.player,
            flavor,
            chain,
            at: row.at,
            y: row.y,
            accepted: row.accepted,
            reason: row.reason,
            settled: row.settled,
          },
          p.patch,
          row.witnesses,
          p.wflux
        );
        totalRows++;
        if (row.y === 1) {
          totalPos++;
          shardPos++;
        }
      });
    }
    writer.close();
    console.log(
      `  ${flavor}-${chain}: ${writer.count} rows, ${shardPos} positive, ` +
        `${((Date.now() - started) / 1000).toFixed(0)}s elapsed`
    );
  }
}

const hours = totalAudioMs / 3.6e6;
const summary = {
  takes: selected.length,
  flavors,
  chains,
  rows: totalRows,
  positives: totalPos,
  positiveRate: totalRows > 0 ? totalPos / totalRows : 0,
  audioHours: hours,
  rowsPerHour: hours > 0 ? totalRows / hours : 0,
  droppedNoHop,
};
writeFileSync(
  join(outDir, `summary-${flavors.join("+")}-${chains.join("+")}.json`),
  JSON.stringify(summary, null, 2) + "\n"
);
console.log(JSON.stringify(summary, null, 2));
