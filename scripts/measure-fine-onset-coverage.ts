/**
 * What the fine-hop onset witness (`kernels/fine-onset.ts`) sees at each
 * threshold, before the fast lane or the tracker touch it.
 *
 * The companion of `measure-onset-coverage.ts` for the new kernel, and the
 * script its threshold is read from: it drives the real `FineOnsetDetector`
 * at the render quantum with the fast lane's own gate, over a list of
 * thresholds, and counts labelled onsets with a confirmed fine onset within
 * `WINDOW_MS` under NEAREST-label attribution against confirmed onsets that
 * are nearest to no label inside the played span. Both axes, per fixture,
 * per threshold — and the derivation rows separately from the held-out
 * rows, because the threshold may only be read off the former.
 *
 * Usage:
 *   npx tsx scripts/measure-fine-onset-coverage.ts
 *   npx tsx scripts/measure-fine-onset-coverage.ts --thresholds=0.2,0.35,0.5
 *   npx tsx scripts/measure-fine-onset-coverage.ts sixteenths
 */

import { readFileSync } from "node:fs";
import { DEFAULT_ENGINE_CONFIG, RENDER_QUANTUM } from "../src/engine/config.js";
import { FineOnsetDetector } from "../src/engine/kernels/fine-onset.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/**
 * Attribution half-width. 30ms for the held-out takes, whose labels were
 * measured on the DI flux to the millisecond; the five 120bpm takes carry
 * first-pass timing and `--window=60` reads them the way
 * `measure-onset-coverage.ts` does.
 */
let WINDOW_MS = 30;
const PLAYED_PAD_MS = 300;
const DERIVATION = ["chords-a-bm", "clean-lead-120bpm", "cowboy-chords-c-d", "power-chords-c-a", "spicy"];

function measure(
  samples: Float32Array,
  sampleRate: number,
  onsetsMs: number[],
  endsMs: number[],
  threshold: number
): { covered: number; offLabel: number } {
  const t = DEFAULT_ENGINE_CONFIG.transient;
  const detector = new FineOnsetDetector({
    sampleRate,
    fftSize: t.fluxFftSize,
    hop: RENDER_QUANTUM,
    threshold,
    minIntervalMs: t.fineOnsetMinIntervalMs,
    preparationMs: t.fineOnsetPreparationMs,
    preparationRatio: t.fineOnsetPreparationRatio,
  });
  const window = new Float32Array(t.fluxFftSize);
  const gate = DEFAULT_ENGINE_CONFIG.analysis.rmsGate * 0.5;
  const confirmed: number[] = [];
  for (let end = t.fluxFftSize; end <= samples.length; end += RENDER_QUANTUM) {
    window.set(samples.subarray(end - t.fluxFftSize, end));
    let energy = 0;
    for (let i = 0; i < window.length; i++) energy += (window[i] as number) * (window[i] as number);
    const audible = Math.sqrt(energy / window.length) >= gate;
    for (const onset of detector.process(window, end, audible)) {
      confirmed.push((onset.atSample / sampleRate) * 1000);
    }
  }
  const first = (onsetsMs[0] as number) - PLAYED_PAD_MS;
  const last = (endsMs[endsMs.length - 1] as number) + PLAYED_PAD_MS;
  const coveredIds = new Set<number>();
  let offLabel = 0;
  for (const at of confirmed) {
    if (at < first || at > last) continue;
    let nearest = -1;
    let dist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < onsetsMs.length; i++) {
      const d = Math.abs(at - (onsetsMs[i] as number));
      if (d < dist) {
        dist = d;
        nearest = i;
      }
    }
    if (nearest >= 0 && dist <= WINDOW_MS) coveredIds.add(nearest);
    else offLabel++;
  }
  return { covered: coveredIds.size, offLabel };
}

function main(): void {
  const args = process.argv.slice(2);
  const thresholds = (args.find((a) => a.startsWith("--thresholds="))?.slice("--thresholds=".length) ?? "0.15,0.25,0.35,0.5,0.75,1,1.5")
    .split(",")
    .map(Number);
  const filter = args.find((a) => !a.startsWith("--"));
  const windowArg = args.find((a) => a.startsWith("--window="));
  if (windowArg !== undefined) WINDOW_MS = Number(windowArg.slice("--window=".length));
  const fixtures = decodeFixtures({ quiet: true }).filter((f) => filter === undefined || f.stem.includes(filter));

  console.log("  " + "fixture".padEnd(48) + "".padEnd(9) + thresholds.map((t) => `θ=${t}`.padStart(11)).join(""));
  const totals = new Map<boolean, number[]>();
  const labelTotals = new Map<boolean, number>();
  for (const fixture of fixtures) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const onsets = fixture.label.events.map((e) => e.startMs);
    const ends = fixture.label.events.map((e) => e.endMs);
    const derivation = DERIVATION.some((d) => fixture.stem.startsWith(d));
    const cells: string[] = [];
    const sums = totals.get(derivation) ?? thresholds.flatMap(() => [0, 0]);
    labelTotals.set(derivation, (labelTotals.get(derivation) ?? 0) + onsets.length);
    thresholds.forEach((threshold, i) => {
      const r = measure(mono, wav.sampleRate, onsets, ends, threshold);
      cells.push(`${r.covered}/${onsets.length} ${r.offLabel}`.padStart(11));
      sums[2 * i] = (sums[2 * i] ?? 0) + r.covered;
      sums[2 * i + 1] = (sums[2 * i + 1] ?? 0) + r.offLabel;
    });
    totals.set(derivation, sums);
    console.log("  " + fixture.stem.padEnd(48) + (derivation ? "derive" : "held").padEnd(9) + cells.join(""));
  }
  for (const [derivation, sums] of totals) {
    const labels = labelTotals.get(derivation) ?? 0;
    console.log(
      "  " +
        (derivation ? "DERIVATION" : "HELD OUT").padEnd(57) +
        thresholds.map((_, i) => `${sums[2 * i]}/${labels} ${sums[2 * i + 1]}`.padStart(11)).join("")
    );
  }
  console.log(`\n  cell = labels covered within ±${WINDOW_MS}ms (nearest-label) / off-label confirmed onsets in the played span`);
}

main();
