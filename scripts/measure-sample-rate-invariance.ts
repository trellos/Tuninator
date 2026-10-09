/**
 * Does the recorded corpus give the same Notes at 44.1, 88.2 and 96kHz as at
 * 48kHz? Exits nonzero when it does not. CI runs it after `npm run eval`.
 *
 * Usage:
 *   npx tsx scripts/measure-sample-rate-invariance.ts
 *   npx tsx scripts/measure-sample-rate-invariance.ts --rates=44100
 *
 * Each source in `fixtures/audio/` is decoded by ffmpeg straight to every
 * rate (`.cache/fixtures-<rate>/`, the 48kHz decode is the eval's own), run
 * through `analyzeSamples` at that rate, and its final Notes are matched
 * one-to-one against the 48kHz run's: same pitch name, starts within 20ms.
 * Reported per rate: Notes left unmatched on either side, and how far apart
 * the matched starts and ends are.
 *
 * The bar: at most 1% of the 48kHz Notes unmatched, and 99% of matched starts
 * and ends within 3ms. Before the engine resampled to its analysis rate
 * (DECISION-088), 44.1 / 88.2 / 96kHz left 1,310 / 1,569 / 1,601 of 1,807
 * Notes unmatched, with matched starts up to 20ms apart; after, 10 / 5 / 3,
 * and every matched start identical to the 48kHz one.
 *
 * What is left is the recordings differing, not the engine. Every take
 * reaches the 48kHz run or the other one through ffmpeg's resampler — the
 * 44.1kHz mp3s are upsampled for the eval, the 48kHz AAC takes downsampled
 * here — whose filter is not the engine's, and a few decisions sit close
 * enough to their bar to tip: one chord in `chords-a-bm-g-d-2x-120bpm` that
 * splits at every other rate (it does not when the 48kHz audio is taken to
 * 44.1kHz and back by the engine's own resampler), and at 44.1kHz three
 * boundaries moved by four or five hops — in `same-pitch-quarters-a3-e5-
 * 120bpm-di` and the mic power chords — and one amped held C4 split in two. `tests/engine/sample-rate.test.ts`
 * asks the same of a score rendered analytically at each rate, where no
 * recording intervenes, and holds it to 3ms with nothing unmatched.
 *
 * Each rate is analysed in a child process, so the runs share the wall clock
 * rather than queue for it.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { CACHE_DIR, DEFAULT_SAMPLE_RATE, decodeFixtures } from "./decode-fixtures.js";

const OUT_DIR = join(CACHE_DIR, "sample-rate-invariance");
const MATCH_MS = 20;
const MAX_UNMATCHED_FRACTION = 0.01;
const MAX_P99_DELTA_MS = 3;

type SlimNote = { start: number; end: number | null; name: string | null };
type RateNotes = Record<string, SlimNote[]>;

function notesPath(rate: number): string {
  return join(OUT_DIR, `notes-${rate}.json`);
}

/** Child: analyse the corpus at one rate and write its Notes. */
function analyseRate(rate: number): void {
  const out: RateNotes = {};
  for (const fixture of decodeFixtures({ quiet: true, sampleRate: rate })) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const notes = analyzeSamples(downmixToMono(wav.samples, wav.channels), wav.sampleRate).notes;
    out[fixture.stem] = notes.map((n) => ({
      start: n.startTime,
      end: n.endTime,
      name: n.pitch.current?.name ?? null,
    }));
  }
  writeFileSync(notesPath(rate), JSON.stringify(out));
}

function runChild(rate: number): Promise<void> {
  const script = fileURLToPath(import.meta.url);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, script, `--worker=${rate}`], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`analysis at ${rate}Hz exited ${code}`))
    );
  });
}

type Comparison = {
  reference: number;
  other: number;
  unmatched: number;
  startDeltas: number[];
  endDeltas: number[];
  perFixture: Array<{ stem: string; reference: number; other: number; unmatched: number }>;
};

function compare(reference: RateNotes, other: RateNotes): Comparison {
  const result: Comparison = {
    reference: 0,
    other: 0,
    unmatched: 0,
    startDeltas: [],
    endDeltas: [],
    perFixture: [],
  };
  for (const [stem, refNotes] of Object.entries(reference)) {
    const otherNotes = other[stem] ?? [];
    const used = new Set<number>();
    let matched = 0;
    for (const note of otherNotes) {
      let best = -1;
      let bestDelta = Infinity;
      refNotes.forEach((ref, i) => {
        if (used.has(i) || ref.name !== note.name) return;
        const delta = Math.abs(ref.start - note.start);
        if (delta <= MATCH_MS && delta < bestDelta) {
          best = i;
          bestDelta = delta;
        }
      });
      if (best < 0) continue;
      used.add(best);
      matched++;
      const ref = refNotes[best] as SlimNote;
      result.startDeltas.push(bestDelta);
      if (ref.end !== null && note.end !== null) result.endDeltas.push(Math.abs(ref.end - note.end));
    }
    const unmatched = refNotes.length - matched + (otherNotes.length - matched);
    result.reference += refNotes.length;
    result.other += otherNotes.length;
    result.unmatched += unmatched;
    result.perFixture.push({ stem, reference: refNotes.length, other: otherNotes.length, unmatched });
  }
  return result;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

async function main(): Promise<void> {
  const worker = process.argv.find((a) => a.startsWith("--worker="));
  if (worker !== undefined) {
    analyseRate(Number(worker.slice("--worker=".length)));
    return;
  }
  const ratesArg = process.argv.find((a) => a.startsWith("--rates="));
  const rates = (ratesArg?.slice("--rates=".length) ?? "44100,88200,96000")
    .split(",")
    .map(Number)
    .filter((r) => r !== DEFAULT_SAMPLE_RATE);

  mkdirSync(OUT_DIR, { recursive: true });
  // Decode serially here, so the children only read.
  for (const rate of [DEFAULT_SAMPLE_RATE, ...rates]) decodeFixtures({ quiet: true, sampleRate: rate });
  await Promise.all([DEFAULT_SAMPLE_RATE, ...rates].map(runChild));

  const reference = JSON.parse(readFileSync(notesPath(DEFAULT_SAMPLE_RATE), "utf8")) as RateNotes;
  let failed = false;
  for (const rate of rates) {
    const other = JSON.parse(readFileSync(notesPath(rate), "utf8")) as RateNotes;
    const c = compare(reference, other);
    const startP99 = quantile(c.startDeltas, 0.99);
    const endP99 = quantile(c.endDeltas, 0.99);
    const unmatchedBar = Math.floor(c.reference * MAX_UNMATCHED_FRACTION);
    const pass = c.unmatched <= unmatchedBar && startP99 <= MAX_P99_DELTA_MS && endP99 <= MAX_P99_DELTA_MS;
    failed ||= !pass;
    process.stdout.write(
      `\n${pass ? "PASS" : "FAIL"}  ${rate}Hz against ${DEFAULT_SAMPLE_RATE}Hz: ` +
        `${c.other} Notes against ${c.reference}, ${c.unmatched} unmatched (bar ${unmatchedBar})\n` +
        `      |start| p99 ${startP99.toFixed(2)}ms max ${Math.max(0, ...c.startDeltas).toFixed(2)}ms, ` +
        `|end| p99 ${endP99.toFixed(2)}ms max ${Math.max(0, ...c.endDeltas).toFixed(2)}ms ` +
        `(bar p99 ${MAX_P99_DELTA_MS}ms)\n`
    );
    for (const f of c.perFixture.filter((f) => f.unmatched > 0)) {
      process.stdout.write(
        `      ${f.stem.padEnd(48)} ${f.other} vs ${f.reference} Notes, ${f.unmatched} unmatched\n`
      );
    }
  }
  if (failed) {
    process.stderr.write("\nsample-rate invariance: FAIL\n");
    process.exit(1);
  }
  process.stdout.write("\nsample-rate invariance: PASS\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`measure-sample-rate-invariance: ${(error as Error).message}\n`);
  process.exit(1);
});
