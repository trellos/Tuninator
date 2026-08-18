/**
 * Measure any `PitchEstimator` against the recorded fixtures.
 *
 * This is the shared measuring stick. Every estimator is judged the same way,
 * on the same audio, so the numbers are comparable and an argument about which
 * method is better can be settled instead of held.
 *
 * It deliberately measures the ESTIMATOR, not the pipeline: frames are taken
 * from the interior of each labelled note, where one note is the right answer,
 * and the estimator is asked directly. Tracking, segmentation, onsets and the
 * amplitude gate are all out of the picture. An estimator that reads the
 * interior of a note correctly can be tracked; one that does not, cannot.
 *
 *   npx tsx scripts/bench-estimator.ts src/core/pitch/yin-estimator.ts
 *   npx tsx scripts/bench-estimator.ts <module> --per-note
 *
 * The module must default-export a factory:
 *   (options: PitchEstimatorOptions) => PitchEstimator
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PitchEstimator, PitchEstimatorOptions } from "../src/core/pitch/estimator.js";
import { alignFixture, nameOfMidi, midiOfName, type AlignedNote } from "./label-alignment.js";

export type NoteOutcome = {
  id: string;
  want: string;
  /** Modal reading over the note's interior frames. */
  got: string;
  /** Fraction of interior frames that read the labelled note. */
  agreement: number;
  /**
   * True when the note is shorter than the estimator's own window, so no frame
   * can be taken from inside it. Not a failure to identify — a statement that
   * this estimator cannot see a note this short at all.
   */
  tooShort: boolean;
  /**
   * True when some other note of the piece is louder than this one throughout
   * its own span. A monophonic estimator reports the loudest periodicity, so
   * these are not winnable by a better monophonic method — they need either
   * polyphonic transcription or attack-aware tracking.
   */
  buried: boolean;
  /** Mean confidence over the interior frames the estimator voiced. */
  confidence: number;
  frames: number;
};

export type BenchResult = {
  name: string;
  /** Notes whose modal reading is the labelled note, out of all labelled. */
  exact: number;
  /** ...allowing any octave. */
  pitchClass: number;
  total: number;
  /** Exact, counting only notes that are audible above their rivals. */
  exactAudible: number;
  audible: number;
  /** Every interior frame, not just the modal vote. */
  frameExact: number;
  frameTotal: number;
  /** Mean of `agreement` — how decisively each note was read. */
  meanAgreement: number;
  /** Notes shorter than this estimator's window; it cannot see them at all. */
  tooShort: number;
  notes: NoteOutcome[];
};

/** The window ends at each hop, exactly as the ring buffer feeds the engine. */
const HOP = 640;
/**
 * Extra margin past the point where the analysis window first lies wholly
 * inside the note.
 *
 * The window TRAILS the sample point -- asking an estimator for the pitch at
 * time T shows it the audio ending at T -- so a frame taken 25ms into a note
 * is answered from a window that is mostly the note BEFORE it. Ignoring that
 * made every estimator look far worse than it is: YIN scored 1 of 12
 * sixteenths, and 11 of 12 once the sample points were moved by roughly one
 * window length.
 *
 * So the first usable frame is `startMs + windowMs`, not `startMs`, and this
 * is only the small extra cushion on top.
 */
const EDGE_GUARD_MS = 5;

export function benchEstimator(
  estimator: PitchEstimator,
  stem = "clean-lead-120bpm"
): BenchResult {
  const { samples, sampleRate, notes: aligned } = alignFixture(stem);
  const window = new Float32Array(estimator.windowSize);
  const windowMs = (estimator.windowSize / sampleRate) * 1000;
  const hopMs = (HOP / sampleRate) * 1000;

  // Every sample point, gathered before any of them is taken, so they can be
  // visited in TIME order rather than in label order.
  //
  // The measured spans overlap -- a note that is still ringing when the next is
  // plucked genuinely occupies the same milliseconds -- so walking notes one
  // after another makes the clock jump backwards at note boundaries, by as much
  // as 160ms on this fixture. A stateless estimator cannot tell; one that keeps
  // any history across frames has that history drawn from audio it should not
  // have heard yet, which is precisely the estimator this bench exists to
  // evaluate. A frame inside two notes is offered to both and estimated once.
  const points: Array<{ ms: number; note: number }> = [];
  for (let i = 0; i < aligned.length; i++) {
    const label = aligned[i]!;
    for (let ms = label.startMs + windowMs + EDGE_GUARD_MS; ms <= label.endMs; ms += hopMs) {
      const end = Math.round((ms / 1000) * sampleRate);
      if (end < estimator.windowSize || end > samples.length) continue;
      points.push({ ms, note: i });
    }
  }
  points.sort((a, b) => a.ms - b.ms || a.note - b.note);

  type Tally = {
    counts: Map<string, number>;
    confidenceSum: number;
    voiced: number;
    frames: number;
    hit: number;
  };
  const tallies: Tally[] = aligned.map(() => ({
    counts: new Map(),
    confidenceSum: 0,
    voiced: 0,
    frames: 0,
    hit: 0,
  }));

  let lastMs = Number.NaN;
  let lastResult: { frequencyHz: number | null; confidence: number } = {
    frequencyHz: null,
    confidence: 0,
  };
  for (const point of points) {
    if (point.ms !== lastMs) {
      const end = Math.round((point.ms / 1000) * sampleRate);
      window.set(samples.subarray(end - estimator.windowSize, end));
      lastResult = estimator.estimate(window);
      lastMs = point.ms;
    }
    const tally = tallies[point.note]!;
    tally.frames++;
    if (lastResult.frequencyHz === null) continue;
    tally.voiced++;
    tally.confidenceSum += lastResult.confidence;
    const midi = Math.round(69 + 12 * Math.log2(lastResult.frequencyHz / 440));
    const name = nameOfMidi(midi);
    tally.counts.set(name, (tally.counts.get(name) ?? 0) + 1);
    if (midi === midiOfName(aligned[point.note]!.note)) tally.hit++;
  }

  const notes: NoteOutcome[] = [];
  let frameExact = 0;
  let frameTotal = 0;
  for (let i = 0; i < aligned.length; i++) {
    const label = aligned[i]!;
    const tally = tallies[i]!;
    let got = "(none)";
    let best = 0;
    for (const [name, count] of tally.counts) {
      if (count > best) {
        best = count;
        got = name;
      }
    }
    notes.push({
      id: label.id,
      want: label.note,
      got,
      tooShort: tally.frames === 0,
      buried: label.dominance < 1,
      agreement: tally.frames > 0 ? tally.hit / tally.frames : 0,
      confidence: tally.voiced > 0 ? tally.confidenceSum / tally.voiced : 0,
      frames: tally.frames,
    });
    frameExact += tally.hit;
    frameTotal += tally.frames;
  }

  const audible = notes.filter((n) => !n.buried);
  return {
    name: estimator.name,
    exact: notes.filter((n) => n.got === n.want).length,
    pitchClass: notes.filter(
      (n) => n.got !== "(none)" && pitchClassOf(n.got) === pitchClassOf(n.want)
    ).length,
    total: notes.length,
    exactAudible: audible.filter((n) => n.got === n.want).length,
    audible: audible.length,
    frameExact,
    frameTotal,
    meanAgreement: notes.reduce((a, n) => a + n.agreement, 0) / Math.max(1, notes.length),
    tooShort: notes.filter((n) => n.tooShort).length,
    notes,
  };
}

function pitchClassOf(note: string): number {
  return ((midiOfName(note) % 12) + 12) % 12;
}

export function formatBench(result: BenchResult, windowSize: number): string {
  return (
    `${result.name}\n` +
    `  notes      ${result.exact}/${result.total} exact   ` +
    `${result.pitchClass}/${result.total} right pitch class\n` +
    `  audible    ${result.exactAudible}/${result.audible} exact ` +
    `(excluding notes another note drowns out throughout)\n` +
    `  frames     ${result.frameExact}/${result.frameTotal} ` +
    `(${((result.frameExact / Math.max(1, result.frameTotal)) * 100).toFixed(1)}%)   ` +
    `mean agreement ${(result.meanAgreement * 100).toFixed(1)}%\n` +
    (result.tooShort > 0
      ? `  UNSEEABLE  ${result.tooShort} notes are shorter than this estimator's ` +
        `${((windowSize / 48000) * 1000).toFixed(0)}ms window\n`
      : "")
  );
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const [modulePath, ...flags] = process.argv.slice(2);
  if (!modulePath) {
    process.stderr.write("usage: bench-estimator.ts <module> [--per-note]\n");
    process.exit(1);
  }
  const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    default: (options: PitchEstimatorOptions) => PitchEstimator;
  };
  const estimator = loaded.default({
    sampleRate: 48000,
    minFrequencyHz: 70,
    maxFrequencyHz: 1400,
  });
  const result = benchEstimator(estimator);
  process.stdout.write(formatBench(result, estimator.windowSize));
  if (flags.includes("--per-note")) {
    for (const n of result.notes) {
      process.stdout.write(
        `    ${n.id.padEnd(4)} want ${n.want.padEnd(4)} got ${n.got.padEnd(6)} ` +
          `agree ${(n.agreement * 100).toFixed(0).padStart(3)}%  conf ${n.confidence.toFixed(2)}` +
          `${n.tooShort ? "  [shorter than the window]" : ""}` +
          `${n.buried ? "  [drowned out by a louder note]" : ""}` +
          `${n.got === n.want ? "" : "   <-"}\n`
      );
    }
  }
}

if (process.argv[1]?.endsWith("bench-estimator.ts")) {
  await main();
}
