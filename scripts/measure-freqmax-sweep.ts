/**
 * Sweep the frequency-axis max filter against the time-axis reference, on the
 * real corpus, at the raw-kernel level `measure-onset-coverage.ts` measures.
 *
 * `measure-freqmax-ripple.ts` establishes on a synthetic steady low E that the
 * frequency max suppresses the unresolved-harmonic beating better than the
 * three-frame time max does, with no time memory at all. This script asks what
 * that buys on the recorded corpus: label coverage against off-label firing,
 * per the derivation rule every kernel constant here was chosen by — take the
 * highest coverage available at an off-label rate no worse than the detector
 * it replaces, and derive it on the five 120bpm fixtures only. The held-out
 * rows are printed for reading, never for choosing.
 *
 * Usage:
 *   npx tsx scripts/measure-freqmax-sweep.ts
 */

import { readFileSync } from "node:fs";
import { OnsetDetector } from "../src/engine/kernels/onset.js";
import { DEFAULT_ENGINE_CONFIG, snapHop } from "../src/engine/config.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

const WINDOW_MS = 60;

const DERIVATION = [
  "chords-a-bm",
  "clean-lead-120bpm",
  "cowboy-chords-c-d",
  "power-chords-c-a",
  "spicy",
];

type Config = {
  name: string;
  referenceFrames: number;
  maxFilterSemitones?: number;
  floorFactor?: number;
};

const CONFIGS: Config[] = [
  { name: "baseline: time max, 3 frames", referenceFrames: 3 },
  { name: "freq ±0.5 st, 1 frame", referenceFrames: 1, maxFilterSemitones: 0.5 },
  { name: "freq ±1.0 st, 1 frame", referenceFrames: 1, maxFilterSemitones: 1.0 },
  { name: "freq ±1.5 st, 1 frame", referenceFrames: 1, maxFilterSemitones: 1.5 },
  { name: "freq ±2.0 st, 1 frame", referenceFrames: 1, maxFilterSemitones: 2.0 },
  { name: "freq ±0.5 st, 2 frames", referenceFrames: 2, maxFilterSemitones: 0.5 },
  { name: "freq ±1.0 st, 2 frames", referenceFrames: 2, maxFilterSemitones: 1.0 },
  { name: "freq ±1.0 st, 3 frames", referenceFrames: 3, maxFilterSemitones: 1.0 },
  // The 0.22 arrival floor was derived FOR the time-max flux scale; the
  // frequency-max reference sits higher, so its flux runs smaller and the
  // comparison above under-sells it. Re-derive the floor for the filter.
  { name: "freq ±0.5 st, 1 frame, floor 0.18", referenceFrames: 1, maxFilterSemitones: 0.5, floorFactor: 0.18 },
  { name: "freq ±0.5 st, 1 frame, floor 0.14", referenceFrames: 1, maxFilterSemitones: 0.5, floorFactor: 0.14 },
  { name: "freq ±0.5 st, 1 frame, floor 0.10", referenceFrames: 1, maxFilterSemitones: 0.5, floorFactor: 0.10 },
  { name: "freq ±0.5 st, 1 frame, floor 0.06", referenceFrames: 1, maxFilterSemitones: 0.5, floorFactor: 0.06 },
  { name: "freq ±1.0 st, 1 frame, floor 0.14", referenceFrames: 1, maxFilterSemitones: 1.0, floorFactor: 0.14 },
  { name: "freq ±1.0 st, 1 frame, floor 0.10", referenceFrames: 1, maxFilterSemitones: 1.0, floorFactor: 0.10 },
];

type Take = { stem: string; derivation: boolean; mono: Float32Array; sampleRate: number; labels: number[] };

function load(): Take[] {
  return decodeFixtures({ quiet: true }).map((fixture) => {
    const wav = readWav(readFileSync(fixture.wavPath));
    return {
      stem: fixture.stem,
      derivation: DERIVATION.some((d) => fixture.stem.startsWith(d)),
      mono: downmixToMono(wav.samples, wav.channels),
      sampleRate: wav.sampleRate,
      labels: fixture.label.events.map((e) => e.startMs),
    };
  });
}

function measure(take: Take, config: Config): { covered: number; offLabel: number; audibleHops: number } {
  const base = DEFAULT_ENGINE_CONFIG;
  const fftSize = base.transient.fluxFftSize;
  const hop = snapHop(base.analysis.hopMs, take.sampleRate);
  const detector = new OnsetDetector({
    sampleRate: take.sampleRate,
    fftSize,
    minIntervalMs: base.transient.minIntervalMs,
    medianWindow: base.transient.fluxMedianWindow,
    sensitivity: base.transient.fluxSensitivity,
    referenceFrames: config.referenceFrames,
    maxFilterSemitones: config.maxFilterSemitones,
    floorFactor: config.floorFactor,
  });

  const frame = new Float32Array(fftSize);
  const onsets: number[] = [];
  let audibleHops = 0;
  for (let start = 0; start + fftSize <= take.mono.length; start += hop) {
    frame.set(take.mono.subarray(start, start + fftSize));
    let energy = 0;
    for (let i = 0; i < fftSize; i++) energy += (frame[i] as number) * (frame[i] as number);
    const audible = Math.sqrt(energy / fftSize) >= base.analysis.rmsGate;
    const at = ((start + fftSize) / take.sampleRate) * 1000;
    const result = detector.process(frame, at, audible);
    if (audible) audibleHops++;
    if (result.isOnset) onsets.push(at);
  }
  const covered = take.labels.filter((l) => onsets.some((o) => Math.abs(o - l) <= WINDOW_MS)).length;
  const offLabel = onsets.filter((o) => !take.labels.some((l) => Math.abs(o - l) <= WINDOW_MS)).length;
  return { covered, offLabel, audibleHops };
}

const takes = load();

if (process.argv.includes("--detail")) {
  const detail = [CONFIGS[0] as Config, CONFIGS[1] as Config, CONFIGS[2] as Config];
  for (const config of detail) {
    console.log(`\n  ${config.name}`);
    for (const take of takes) {
      const m = measure(take, config);
      console.log(
        `    ${take.derivation ? "derive  " : "held-out"}  ${take.stem.padEnd(46)} ` +
          `${String(m.covered).padStart(3)} / ${String(take.labels.length).padStart(3)}  ` +
          `off ${m.offLabel}`
      );
    }
  }
  process.exit(0);
}

const header = [
  "configuration",
  "derive covered",
  "derive off-rate",
  "held-out covered",
  "held-out off-rate",
];
const rows: string[][] = [];
for (const config of CONFIGS) {
  let stats = { d: { covered: 0, labels: 0, off: 0, hops: 0 }, h: { covered: 0, labels: 0, off: 0, hops: 0 } };
  for (const take of takes) {
    const m = measure(take, config);
    const side = take.derivation ? stats.d : stats.h;
    side.covered += m.covered;
    side.labels += take.labels.length;
    side.off += m.offLabel;
    side.hops += m.audibleHops;
  }
  rows.push([
    config.name,
    `${stats.d.covered} / ${stats.d.labels}`,
    `${((100 * stats.d.off) / Math.max(stats.d.hops, 1)).toFixed(2)}%`,
    `${stats.h.covered} / ${stats.h.labels}`,
    `${((100 * stats.h.off) / Math.max(stats.h.hops, 1)).toFixed(2)}%`,
  ]);
}

console.log("\n  broadband kernel, engine window and hop, gated as the fast lane gates\n");
const width: number[] = [];
for (const row of [header, ...rows]) row.forEach((c, i) => (width[i] = Math.max(width[i] ?? 0, c.length)));
const line = (row: string[]): string =>
  "  " + row.map((c, i) => (i === 0 ? c.padEnd(width[i] as number) : c.padStart(width[i] as number))).join("  ");
console.log(line(header));
console.log("  " + width.map((w) => "-".repeat(w)).join("  "));
for (const row of rows) console.log(line(row));
console.log(
  "\n  choose on the derivation columns only; the held-out columns are read, never fitted."
);
