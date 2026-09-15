/**
 * Given a CORRECT onset, how soon can the pitch estimator name the note?
 *
 * The naming errors on the lead takes are all attribution — a Note wearing
 * its predecessor's or its successor's name — and the record says the pitch
 * path "does not lag on the material that misnames". That is a statement
 * about the engine's own boundaries. This asks the kernel-level question with
 * the boundaries taken from the labels: run the YIN kernels on windows ending
 * a fixed distance after each labelled onset and count how often the reading
 * already carries the label's pitch class. If the answer is "almost always by
 * +20ms", then every naming defect on a direct input is a boundary defect and
 * a correct onset front end fixes naming for free; if the estimator itself
 * takes 60ms+ to lock on a direct input, no boundary repair can help.
 *
 * Two further readings per label:
 *
 *  - **the fretting hand's lead**: the pitch 15ms BEFORE the labelled pick. On
 *    a single string the next note is fretted before it is picked, and a
 *    hammer-on or pull-off changes the ringing string's pitch before any pick
 *    lands. Read as this label's pitch, the previous label's, or something
 *    else. The DI triplet take emits a Note on that pre-pick change, which is
 *    the source of most of its extra Notes.
 *  - **the reading the engine's dual-window estimator would give**, through
 *    `YinEstimator.estimate` with a fresh median, alongside the raw kernels.
 *
 * A ceiling reading. No engine constant is derived from it.
 *
 * Usage:
 *   npx tsx scripts/measure-di-pitch-ceiling.ts               DI lead takes + clean-lead
 *   npx tsx scripts/measure-di-pitch-ceiling.ts --all         every note-labelled take
 *   npx tsx scripts/measure-di-pitch-ceiling.ts --detail      per label
 */

import { readFileSync } from "node:fs";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/config.js";
import { YinEstimator } from "../src/engine/fast/yin-estimator.js";
import { describeFrequency } from "../src/engine/kernels/notes.js";
import { YinDetector } from "../src/engine/kernels/yin.js";
import { acceptedAnswers, parseLabel, type LabeledEvent } from "../src/offline/matcher.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/** Window END relative to the labelled onset, ms. */
const OFFSETS_MS = [10, 15, 20, 30, 45, 60, 90];
/** Where the fretting-hand lead is read: the window ending this far BEFORE the pick. */
const PRE_PICK_MS = 15;

type Reading = { hz: number | null; confidence: number };

function readAt(samples: Float32Array, sampleRate: number, endMs: number, detector: YinDetector): Reading {
  const end = Math.round((endMs / 1000) * sampleRate);
  const start = end - detector.windowSize;
  if (start < 0 || end > samples.length) return { hz: null, confidence: 0 };
  const result = detector.detect(samples.subarray(start, end));
  return { hz: result.frequencyHz, confidence: result.confidence };
}

function agrees(hz: number | null, label: LabeledEvent): { pc: boolean; exact: boolean } {
  if (hz === null) return { pc: false, exact: false };
  const accepted = acceptedAnswers(label);
  const name = describeFrequency(hz).name;
  const parsed = parseLabel(name, "note");
  return {
    pc: parsed.pitchClass !== null && accepted.pitchClasses.has(parsed.pitchClass),
    exact: parsed.canonical !== null && accepted.canonical.has(parsed.canonical),
  };
}

function pitchClassOf(hz: number | null): string | null {
  return hz === null ? null : describeFrequency(hz).pitchClass;
}

function main(): void {
  const args = process.argv.slice(2);
  const detail = args.includes("--detail");
  const all = args.includes("--all");
  const filter = args.find((a) => !a.startsWith("--"));
  const fixtures = decodeFixtures({ quiet: true }).filter((f) => {
    if (filter !== undefined) return f.stem.includes(filter);
    if (all) return f.label.events.some((e) => e.kind === "note");
    return f.stem.includes("lead-line-di") || f.stem === "clean-lead-120bpm";
  });

  const config = DEFAULT_ENGINE_CONFIG;

  for (const fixture of fixtures) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const sampleRate = wav.sampleRate;
    const labels = fixture.label.events.filter((e) => e.kind === "note") as LabeledEvent[];
    if (labels.length === 0) continue;

    const long = new YinDetector({
      sampleRate,
      windowSize: config.pitch.longWindow,
      minFrequencyHz: config.analysis.minFrequencyHz,
      maxFrequencyHz: config.analysis.maxFrequencyHz,
      threshold: config.pitch.yinThreshold,
    });
    const short = new YinDetector({
      sampleRate,
      windowSize: config.pitch.shortWindow,
      minFrequencyHz: Math.max(config.analysis.minFrequencyHz, (2 * sampleRate) / config.pitch.shortWindow),
      maxFrequencyHz: config.analysis.maxFrequencyHz,
      threshold: config.pitch.yinThreshold,
    });
    const mid = new YinDetector({
      sampleRate,
      windowSize: 1024,
      minFrequencyHz: Math.max(config.analysis.minFrequencyHz, (2 * sampleRate) / 1024),
      maxFrequencyHz: config.analysis.maxFrequencyHz,
      threshold: config.pitch.yinThreshold,
    });

    const columns = ["short512", "mid1024", "long2048", "engine"] as const;
    const pcCorrect = new Map<string, number[]>();
    const exactCorrect = new Map<string, number[]>();
    for (const c of columns) {
      pcCorrect.set(c, OFFSETS_MS.map(() => 0));
      exactCorrect.set(c, OFFSETS_MS.map(() => 0));
    }
    let preThis = 0;
    let prePrevious = 0;
    let preOther = 0;
    let preNone = 0;
    const firstCorrect: number[] = [];

    console.log(`\n  ${fixture.stem}  (${labels.length} note labels)`);
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i] as LabeledEvent;
      const previous = i > 0 ? (labels[i - 1] as LabeledEvent) : null;
      const rowParts: string[] = [];
      let first: number | null = null;
      for (let k = 0; k < OFFSETS_MS.length; k++) {
        const endMs = label.startMs + (OFFSETS_MS[k] as number);
        const readings: Record<string, Reading> = {
          short512: readAt(mono, sampleRate, endMs, short),
          mid1024: readAt(mono, sampleRate, endMs, mid),
          long2048: readAt(mono, sampleRate, endMs, long),
        };
        // The engine's own combination, with a fresh temporal median so the
        // reading is this window's and not history's.
        const estimator = new YinEstimator(sampleRate, config);
        const endSample = Math.round((endMs / 1000) * sampleRate);
        const longStart = endSample - config.pitch.longWindow;
        const shortStart = endSample - config.pitch.shortWindow;
        if (longStart >= 0 && endSample <= mono.length) {
          const evidence = estimator.estimate(
            mono.subarray(longStart, endSample),
            mono.subarray(shortStart, endSample)
          );
          readings.engine = { hz: evidence.frequencyHz, confidence: evidence.confidence };
        } else {
          readings.engine = { hz: null, confidence: 0 };
        }
        for (const c of columns) {
          const reading = readings[c] as Reading;
          const gated = reading.confidence < config.analysis.confidenceGate;
          const a = agrees(gated ? null : reading.hz, label);
          const pcRow = pcCorrect.get(c) as number[];
          const exactRow = exactCorrect.get(c) as number[];
          if (a.pc) pcRow[k] = (pcRow[k] ?? 0) + 1;
          if (a.exact) exactRow[k] = (exactRow[k] ?? 0) + 1;
          if (c === "engine" && a.pc && first === null) first = OFFSETS_MS[k] as number;
        }
        const e = readings.engine as Reading;
        rowParts.push(
          `+${OFFSETS_MS[k]}:${e.hz === null || e.confidence < config.analysis.confidenceGate ? "-" : describeFrequency(e.hz).name}`
        );
      }
      if (first !== null) firstCorrect.push(first);

      // The fretting hand's lead.
      const pre = readAt(mono, sampleRate, label.startMs - PRE_PICK_MS, short);
      const preHz = pre.confidence >= config.analysis.confidenceGate ? pre.hz : null;
      const prePc = pitchClassOf(preHz);
      const thisPc = parseLabel(label.label, "note").pitchClass;
      const prevPc = previous === null ? null : parseLabel(previous.label, "note").pitchClass;
      let preTag: string;
      if (prePc === null) {
        preNone++;
        preTag = "none";
      } else if (prePc === thisPc && prePc !== prevPc) {
        preThis++;
        preTag = "THIS";
      } else if (prePc === prevPc) {
        prePrevious++;
        preTag = "prev";
      } else {
        preOther++;
        preTag = "other";
      }
      if (detail) {
        console.log(
          `    ${label.id.padEnd(4)} ${label.label.padEnd(4)} pre-pick ${preTag.padEnd(5)} first-correct ${first === null ? "never" : `+${first}ms`}  ${rowParts.join(" ")}`
        );
      }
    }

    const n = labels.length;
    console.log("    pitch class correct, window ending at onset + ms:");
    console.log("      " + "estimator".padEnd(10) + OFFSETS_MS.map((o) => `+${o}`.padStart(7)).join(""));
    for (const c of columns) {
      const row = pcCorrect.get(c) as number[];
      console.log("      " + c.padEnd(10) + row.map((v) => `${((100 * v) / n).toFixed(0)}%`.padStart(7)).join(""));
    }
    console.log("    exact (octave too):");
    for (const c of columns) {
      const row = exactCorrect.get(c) as number[];
      console.log("      " + c.padEnd(10) + row.map((v) => `${((100 * v) / n).toFixed(0)}%`.padStart(7)).join(""));
    }
    const sorted = [...firstCorrect].sort((a, b) => a - b);
    const med = sorted.length === 0 ? null : sorted[sorted.length >> 1];
    console.log(
      `    engine reading first carries the label's pitch class: median +${med ?? "-"}ms, ` +
        `never within +90ms: ${n - firstCorrect.length} of ${n}`
    );
    console.log(
      `    pitch 15ms BEFORE the pick reads: this label ${preThis}, previous label ${prePrevious}, ` +
        `other ${preOther}, none ${preNone}  (of ${n})`
    );
  }
}

main();
