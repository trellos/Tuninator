/**
 * One take through the real recognizer, with the time each emission was made.
 *
 * `src/offline/analyzer.ts` is the harness every measurement script uses; this
 * is its loop, line for line (same config resolution with no options, same
 * 128-sample blocks, the last block zero-padded, then `flush()`), with one
 * addition: the source time at which each emission left the engine. A Note's
 * `started` emission time is when the fast lane announced it, which is the
 * decision point a fast-lane reading of the model may use. `checkParity`
 * asserts the emissions are the analyzer's own, so nothing here can describe a
 * recognizer that does not exist.
 */

import { readFileSync } from "node:fs";
import { RecognitionEngine } from "../../src/engine/engine.js";
import { RENDER_QUANTUM, resolveEngineConfig } from "../../src/engine/config.js";
import type { TrackerEmission, TrackerTraceEvent } from "../../src/engine/tracker/note-tracker.js";
import { analyzeSamples } from "../../src/offline/analyzer.js";
import { projectEmissions } from "../../src/offline/eval-adapter.js";
import { matchEvents, type DetectedEvent, type LabeledEvent, type MatchResult } from "../../src/offline/matcher.js";
import { downmixToMono, readWav } from "../../src/offline/wav.js";
import type { Fixture } from "../../scripts/decode-fixtures.js";

/** The twelve 140bpm takes are held out; everything else is derivation (AGENTS.md section 3). */
export const DERIVATION = [
  "chords-a-bm-g-d-2x-120bpm",
  "clean-lead-120bpm",
  "cowboy-chords-c-d-em-g-c-d-em-am-120bpm",
  "power-chords-c-a-g-e-c-d-fsharp-e-120bpm",
  "spicy-chords-cmaj9-g-am11",
  "same-pitch-quarters-a3-e5-120bpm-di",
  "same-pitch-quarters-a3-e5-120bpm-amped",
  "same-pitch-eighths-a3-120bpm-di",
  "same-pitch-eighths-a3-120bpm-amped",
  "same-pitch-eighths-sixteenths-e5-120bpm-di",
  "same-pitch-eighths-sixteenths-e5-120bpm-amped",
  "held-then-picked-six-strings-120bpm-di",
  "held-then-picked-six-strings-120bpm-amped",
  "rest-repick-g2-60-120bpm-di",
  "rest-repick-g2-60-120bpm-amped",
] as const;
export const isHeldOut = (stem: string): boolean => stem.includes("140bpm");

export type SignalPath = "DI" | "amped" | "mic" | "clean";

/** The signal path, from the label file's own `instrument` field. */
export function pathOf(fixture: Fixture): SignalPath {
  const inst = (fixture.label as { instrument?: string }).instrument ?? "";
  if (inst === "guitar-di") return "DI";
  if (inst === "guitar-amped" || inst === "guitar-amp-sim") return "amped";
  if (inst === "guitar-amp-mic") return "mic";
  if (inst === "guitar-clean") return "clean";
  throw new Error(`${fixture.stem}: unknown instrument "${inst}"`);
}

export type TakeRun = {
  stem: string;
  path: SignalPath;
  sampleRate: number;
  mono: Float32Array;
  events: TrackerTraceEvent[];
  emissions: TrackerEmission[];
  /** Source ms at which emissions[i] was produced (end of its block, or the flush). */
  emittedAtMs: number[];
  detections: DetectedEvent[];
  labels: LabeledEvent[];
  match: MatchResult;
};

export function runTake(fixture: Fixture): TakeRun {
  const wav = readWav(readFileSync(fixture.wavPath));
  const mono = downmixToMono(wav.samples, wav.channels);
  const sr = wav.sampleRate;
  const config = resolveEngineConfig(undefined, {});
  const engine = new RecognitionEngine(sr, config);
  const events: TrackerTraceEvent[] = [];
  engine.setTrackerTrace((e) => events.push(e));
  const emissions: TrackerEmission[] = [];
  const emittedAtMs: number[] = [];
  const block = new Float32Array(RENDER_QUANTUM);
  for (let offset = 0; offset < mono.length; offset += RENDER_QUANTUM) {
    const available = Math.min(RENDER_QUANTUM, mono.length - offset);
    if (available === RENDER_QUANTUM) {
      block.set(mono.subarray(offset, offset + RENDER_QUANTUM));
    } else {
      block.fill(0);
      block.set(mono.subarray(offset, offset + available));
    }
    const out = engine.processChunk(block, offset);
    const at = (1000 * (offset + RENDER_QUANTUM)) / sr;
    for (const e of out.emissions) {
      emissions.push(e);
      emittedAtMs.push(at);
    }
  }
  const flushAt = (1000 * Math.ceil(mono.length / RENDER_QUANTUM) * RENDER_QUANTUM) / sr;
  for (const e of engine.flush().emissions) {
    emissions.push(e);
    emittedAtMs.push(flushAt);
  }
  const detections = projectEmissions(emissions).final;
  const labels = fixture.label.events as LabeledEvent[];
  return {
    stem: fixture.stem,
    path: pathOf(fixture),
    sampleRate: sr,
    mono,
    events,
    emissions,
    emittedAtMs,
    detections,
    labels,
    match: matchEvents(labels, detections),
  };
}

/** Throws unless this driver's detections are exactly the analyzer's. */
export function checkParity(run: TakeRun): void {
  const ref = projectEmissions(analyzeSamples(run.mono, run.sampleRate).emissions).final;
  const a = JSON.stringify(ref);
  const b = JSON.stringify(run.detections);
  if (a !== b) throw new Error(`${run.stem}: this driver's detections differ from src/offline/analyzer.ts`);
}
