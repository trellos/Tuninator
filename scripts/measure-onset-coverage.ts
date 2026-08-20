/**
 * What the onset KERNEL sees, before the fast lane or the tracker touch it.
 *
 * `measure-onset-ceiling.ts` answers the next question along — how many
 * transients the fast lane was allowed to act on — and its answer is a
 * property of the fast lane's gate, its own dead time and the warm-up as much
 * as of the detector. This script isolates the detector: it drives
 * `OnsetDetector` directly at the engine's window and hop, gates it exactly as
 * the fast lane does, and counts how many labelled events have an onset within
 * `WINDOW_MS`, against how often it fires where nothing was played.
 *
 * Both numbers matter and neither alone means anything. A detector can cover
 * every label by firing on every hop. The derivation rule this repository uses
 * is the one the attack band was chosen by: take the highest coverage
 * available at an off-label rate no worse than the detector it replaces, and
 * derive it on the five 120bpm fixtures only.
 *
 * Usage:
 *   npx tsx scripts/measure-onset-coverage.ts
 *   npx tsx scripts/measure-onset-coverage.ts sixteenths     one subset
 */

import { readFileSync } from "node:fs";
import { OnsetDetector } from "../src/engine/kernels/onset.js";
import { DEFAULT_ENGINE_CONFIG, snapHop } from "../src/engine/config.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/** How near a labelled onset an onset has to be to be that event's. */
const WINDOW_MS = 60;

/**
 * The five 120bpm fixtures every constant in the detector was derived on. The
 * twelve 140bpm files are held out: measured here, never tuned to.
 */
const DERIVATION = [
  "chords-a-bm",
  "clean-lead-120bpm",
  "cowboy-chords-c-d",
  "power-chords-c-a",
  "spicy",
];

type Row = {
  stem: string;
  derivation: boolean;
  labels: number;
  covered: number;
  onsets: number;
  offLabel: number;
  audibleHops: number;
};

function measure(samples: Float32Array, sampleRate: number, labels: number[]): Row["labels"] extends never ? never : Omit<Row, "stem" | "derivation" | "labels"> {
  const config = DEFAULT_ENGINE_CONFIG;
  const fftSize = config.transient.fluxFftSize;
  const hop = snapHop(config.analysis.hopMs, sampleRate);
  const hopMs = (hop / sampleRate) * 1000;
  const detector = new OnsetDetector({
    sampleRate,
    fftSize,
    minIntervalMs: config.transient.minIntervalMs,
    medianWindow: config.transient.fluxMedianWindow,
    sensitivity: config.transient.fluxSensitivity,
    referenceFrames: Math.max(1, Math.round(config.transient.fluxReferenceMs / hopMs)),
  });

  const frame = new Float32Array(fftSize);
  const onsets: number[] = [];
  let audibleHops = 0;

  for (let start = 0; start + fftSize <= samples.length; start += hop) {
    frame.set(samples.subarray(start, start + fftSize));
    let energy = 0;
    for (let i = 0; i < fftSize; i++) energy += (frame[i] as number) * (frame[i] as number);
    const rms = Math.sqrt(energy / fftSize);
    // The fast lane's gate, simplified to its ceiling: the adaptive floor can
    // only lower it, and lowering it admits quieter hops rather than louder.
    const audible = rms >= config.analysis.rmsGate;
    const at = ((start + fftSize) / sampleRate) * 1000;
    const result = detector.process(frame, at, audible);
    if (audible) audibleHops++;
    if (result.isOnset) onsets.push(at);
  }

  const covered = labels.filter((l) => onsets.some((o) => Math.abs(o - l) <= WINDOW_MS)).length;
  const offLabel = onsets.filter((o) => !labels.some((l) => Math.abs(o - l) <= WINDOW_MS)).length;
  return { covered, onsets: onsets.length, offLabel, audibleHops };
}

function main(): void {
  const filter = process.argv[2];
  const fixtures = decodeFixtures({ quiet: true }).filter(
    (f) => filter === undefined || f.stem.includes(filter)
  );

  const rows: Row[] = [];
  for (const fixture of fixtures) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const labels = fixture.label.events.map((e) => e.startMs);
    rows.push({
      stem: fixture.stem,
      derivation: DERIVATION.some((d) => fixture.stem.startsWith(d)),
      labels: labels.length,
      ...measure(mono, wav.sampleRate, labels),
    });
  }

  const table: string[][] = [["fixture", "", "labels", "covered", "onsets", "off-label", "off-rate"]];
  for (const row of rows) {
    table.push([
      row.stem,
      row.derivation ? "derive" : "held-out",
      String(row.labels),
      String(row.covered),
      String(row.onsets),
      String(row.offLabel),
      `${((100 * row.offLabel) / Math.max(row.audibleHops, 1)).toFixed(2)}%`,
    ]);
  }

  const width: number[] = [];
  for (const row of table) row.forEach((c, i) => (width[i] = Math.max(width[i] ?? 0, c.length)));
  table.splice(1, 0, width.map((w) => "-".repeat(w)));
  for (const row of table) {
    console.log(
      "  " +
        row
          .map((c, i) => (i <= 1 ? c.padEnd(width[i] as number) : c.padStart(width[i] as number)))
          .join("  ")
    );
  }

  for (const set of [true, false]) {
    const subset = rows.filter((r) => r.derivation === set);
    if (subset.length === 0) continue;
    const sum = (pick: (r: Row) => number): number => subset.reduce((n, r) => n + pick(r), 0);
    console.log(
      `\n  ${set ? "DERIVATION (five 120bpm)" : "HELD OUT (twelve 140bpm)"}: ` +
        `${sum((r) => r.covered)} of ${sum((r) => r.labels)} labels covered, ` +
        `${sum((r) => r.offLabel)} off-label onsets over ${sum((r) => r.audibleHops)} above-gate hops ` +
        `(${((100 * sum((r) => r.offLabel)) / Math.max(sum((r) => r.audibleHops), 1)).toFixed(2)}%)`
    );
  }
  console.log(
    `\n  covered = labelled events with a kernel onset within ${WINDOW_MS}ms. Constants are\n` +
      `  derived on the derivation rows only; the held-out rows are read, never fitted.`
  );
}

main();
