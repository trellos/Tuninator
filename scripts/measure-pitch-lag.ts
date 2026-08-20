/**
 * How much of a Note's pitch evidence is about audio from before it began.
 *
 * A frame is stamped at the END of the window it analysed, so a hop at time T
 * describes [T - window, T]. A Note that opens on an attack therefore spends
 * its first hops voting on its predecessor's audio, and the vote is
 * confidence-weighted, so those hops are not cheap — the predecessor is a
 * settled ringing note and reads confidently, while the arriving one has just
 * been struck and is the least periodic thing in the take.
 *
 * This measures the size and the shape of that: per Note, how much vote mass
 * lands inside one window length of its own start, what that mass names, and
 * whether dropping it would change the Note's name.
 *
 * Usage:
 *   npx tsx scripts/measure-pitch-lag.ts                          every fixture
 *   npx tsx scripts/measure-pitch-lag.ts amped-quarter            one subset
 *   npx tsx scripts/measure-pitch-lag.ts amped-quarter --detail   per Note
 */

import { readFileSync } from "node:fs";
import { RecognitionEngine } from "../src/engine/engine.js";
import { DEFAULT_ENGINE_CONFIG, RENDER_QUANTUM } from "../src/engine/config.js";
import type { FastFrame } from "../src/engine/contracts.js";
import type { TrackerEmission } from "../src/engine/tracker/note-tracker.js";
import type { Note } from "../src/types.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

type Hop = {
  at: number;
  hz: number | null;
  confidence: number;
  source: string;
  name: string | null;
};

function drive(samples: Float32Array, sampleRate: number): { notes: Note[]; hops: Hop[] } {
  // `fast` is only populated under the pitch-frame diagnostic, and this script
  // is entirely about what the fast lane reported per hop.
  const config: typeof DEFAULT_ENGINE_CONFIG = {
    ...DEFAULT_ENGINE_CONFIG,
    diagnostics: { ...DEFAULT_ENGINE_CONFIG.diagnostics, pitchFrames: true },
  };
  const engine = new RecognitionEngine(sampleRate, config);
  const notes: Note[] = [];
  const hops: Hop[] = [];
  const block = new Float32Array(RENDER_QUANTUM);
  const collect = (out: { emissions: TrackerEmission[]; fast: FastFrame[] }): void => {
    for (const frame of out.fast) {
      hops.push({
        at: frame.at,
        hz: frame.pitch.frequencyHz,
        confidence: frame.pitch.confidence,
        source: frame.pitch.source,
        name: frame.pitch.nearest?.name ?? null,
      });
    }
    for (const emission of out.emissions) {
      if (emission.type === "ended") notes.push(emission.note);
    }
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
  notes.sort((a, b) => a.startTime - b.startTime);
  return { notes, hops };
}

/** Window length in ms behind the frame's timestamp, per estimator source. */
function windowMs(source: string, sampleRate: number): number {
  const samples =
    source === "short"
      ? DEFAULT_ENGINE_CONFIG.pitch.shortWindow
      : DEFAULT_ENGINE_CONFIG.pitch.longWindow;
  return (samples / sampleRate) * 1000;
}

type Row = {
  stem: string;
  notes: number;
  /** Vote mass from hops whose window straddles the Note's own start. */
  straddling: number;
  total: number;
  /** ...of that mass, how much names something other than the Note's label. */
  straddlingWrong: number;
  /** ...and how much names the Note that came before it. */
  straddlingPredecessor: number;
  /** Notes whose label would change if straddling votes were dropped. */
  wouldRename: number;
  /** ...of those, how many would then agree with the Note that follows. */
  renameToSuccessor: number;
  /** Notes with no non-straddling vote at all. */
  starved: number;
  /** Voiced hops decided by each estimator window. */
  short: number;
  long: number;
};

function measure(stem: string, samples: Float32Array, sampleRate: number, detail: boolean): Row {
  const { notes, hops } = drive(samples, sampleRate);
  const row: Row = {
    stem,
    notes: notes.length,
    straddling: 0,
    total: 0,
    straddlingWrong: 0,
    straddlingPredecessor: 0,
    wouldRename: 0,
    renameToSuccessor: 0,
    starved: 0,
    short: 0,
    long: 0,
  };
  for (const hop of hops) {
    if (hop.source === "short") row.short++;
    else if (hop.source === "long") row.long++;
  }

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i] as Note;
    const previous = i > 0 ? (notes[i - 1] as Note) : null;
    const next = i + 1 < notes.length ? (notes[i + 1] as Note) : null;
    const label = note.pitch.current?.name ?? null;
    const clean = new Map<string, number>();
    const lines: string[] = [];

    for (const hop of hops) {
      if (hop.at < note.startTime || hop.at > (note.endTime ?? Infinity)) continue;
      if (hop.hz === null || hop.name === null) continue;
      const straddles = hop.at - windowMs(hop.source, sampleRate) < note.startTime;
      if (!straddles) clean.set(hop.name, (clean.get(hop.name) ?? 0) + hop.confidence);
      row.total += hop.confidence;
      if (straddles) {
        row.straddling += hop.confidence;
        if (hop.name !== label) row.straddlingWrong += hop.confidence;
        if (previous !== null && hop.name === previous.pitch.current?.name) {
          row.straddlingPredecessor += hop.confidence;
        }
      }
      if (detail) {
        lines.push(
          `      +${(hop.at - note.startTime).toFixed(0).padStart(3)}ms  ${hop.name.padEnd(4)}` +
            ` conf ${hop.confidence.toFixed(2)}  ${hop.source.padEnd(5)}` +
            `${straddles ? "  straddles" : ""}`
        );
      }
    }

    let withoutDirty: string | null = null;
    let mass = 0;
    for (const [name, value] of clean) {
      if (value > mass) {
        mass = value;
        withoutDirty = name;
      }
    }
    if (clean.size === 0) row.starved++;
    if (withoutDirty !== null && withoutDirty !== label) {
      row.wouldRename++;
      if (next !== null && withoutDirty === next.pitch.current?.name) row.renameToSuccessor++;
    }

    if (detail) {
      console.log(
        `    ${note.startTime.toFixed(0).padStart(6)}-${(note.endTime ?? 0).toFixed(0).padStart(6)} ` +
          `named ${String(label).padEnd(5)} clean-only ${String(withoutDirty).padEnd(5)}` +
          `${withoutDirty !== label ? "  <- would rename" : ""}`
      );
      for (const line of lines) console.log(line);
    }
  }
  return row;
}

function main(): void {
  const args = process.argv.slice(2);
  const detail = args.includes("--detail");
  const filter = args.find((a) => !a.startsWith("--"));

  const rows: Row[] = [];
  for (const fixture of decodeFixtures({ quiet: true })) {
    if (filter !== undefined && !fixture.stem.includes(filter)) continue;
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    if (detail) console.log(`\n  ${fixture.stem}`);
    rows.push(measure(fixture.stem, mono, wav.sampleRate, detail));
  }

  const table: string[][] = [
    [
      "fixture",
      "notes",
      "straddling",
      "of which wrong",
      "= predecessor",
      "would rename",
      "-> successor",
      "starved",
      "short window",
    ],
  ];
  for (const r of rows) {
    table.push([
      r.stem,
      String(r.notes),
      `${((100 * r.straddling) / Math.max(r.total, 1e-9)).toFixed(1)}%`,
      `${((100 * r.straddlingWrong) / Math.max(r.straddling, 1e-9)).toFixed(1)}%`,
      `${((100 * r.straddlingPredecessor) / Math.max(r.straddling, 1e-9)).toFixed(1)}%`,
      String(r.wouldRename),
      String(r.renameToSuccessor),
      String(r.starved),
      `${((100 * r.short) / Math.max(r.short + r.long, 1)).toFixed(0)}%`,
    ]);
  }
  const width: number[] = [];
  for (const row of table) row.forEach((c, i) => (width[i] = Math.max(width[i] ?? 0, c.length)));
  table.splice(1, 0, width.map((w) => "-".repeat(w)));
  console.log("");
  for (const row of table) {
    console.log(
      "  " +
        row
          .map((c, i) => (i === 0 ? c.padEnd(width[i] as number) : c.padStart(width[i] as number)))
          .join("  ")
    );
  }
  console.log(
    "\n  straddling = confidence-weighted vote mass from hops whose analysis window\n" +
      "  reaches back past the Note's own start. The windows are the estimator's\n" +
      `  own: ${DEFAULT_ENGINE_CONFIG.pitch.longWindow} samples long, ` +
      `${DEFAULT_ENGINE_CONFIG.pitch.shortWindow} short.\n`
  );
}

main();
