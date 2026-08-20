/**
 * The same row format as `extract-rows.ts`, for THIS repo's corpus — the
 * decision table the falsifiers are scored on.
 *
 * The rows come from the canonical `collect()` in
 * `scripts/measure-decision-separability.ts`, untouched, so the population
 * and target are bit-identical to the baseline study's; this script only
 * joins each row to its whitened patch by the study's own half-a-hop rule.
 * Nothing here is training data — the derivation five may calibrate a
 * threshold, and the twelve 140bpm takes are scored once at the end.
 *
 * Usage:  bun training/extract-corpus-rows.ts [--out <dir>]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collect } from "../scripts/measure-decision-separability.js";
import { decodeFixtures } from "../scripts/decode-fixtures.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { collectPatches, RowWriter } from "./features.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] as string) : fallback;
}

const outDir = arg("out", "training/out/corpus");
mkdirSync(outDir, { recursive: true });

console.log("collecting the decision table (unchanged engine)...");
const rows = collect();

const byStem = new Map<string, number[]>();
rows.forEach((row, i) => {
  const list = byStem.get(row.stem);
  if (list === undefined) byStem.set(row.stem, [i]);
  else list.push(i);
});

const writer = new RowWriter(join(outDir, "corpus"));
let dropped = 0;
for (const fixture of decodeFixtures({ quiet: true })) {
  const indices = byStem.get(fixture.stem);
  if (indices === undefined) continue;
  const wav = readWav(readFileSync(fixture.wavPath));
  const mono = downmixToMono(wav.samples, wav.channels);
  const patches = collectPatches(
    mono,
    wav.sampleRate,
    indices.map((i) => (rows[i] as (typeof rows)[number]).at)
  );
  indices.forEach((rowIndex, wi) => {
    const row = rows[rowIndex] as (typeof rows)[number];
    const p = patches.get(wi);
    if (p === undefined) {
      dropped++;
      return;
    }
    writer.write(
      {
        take: row.stem,
        group: row.stem,
        flavor: "corpus",
        chain: "corpus",
        at: row.at,
        y: row.y,
        accepted: row.accepted,
        reason: row.reason,
        settled: row.settled,
      },
      p.patch,
      Float32Array.from(row.x),
      p.wflux
    );
  });
}
writer.close();

const summary = { rows: writer.count, dropped };
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
