/**
 * Find where each labelled note actually sounds, and how clearly.
 *
 * The label files carry note identities the player confirmed, but their
 * TIMING is arithmetic: a waveform-estimated section start, divided evenly by
 * the note count. The lead fixture says so itself ("Waveform-estimated section
 * starts: quarters at 3950ms, triplets at 11860ms, sixteenths at 19870ms").
 * A human does not play a perfect grid, and measuring against one makes every
 * estimator look worse than it is — frames land in the neighbouring note and
 * the estimator is marked wrong for reading what was actually there.
 *
 * That is not a hypothesis. Sliding each labelled span over the audio and
 * scoring it by how much its own fundamental dominates the other notes of the
 * piece puts the lead fixture's sixteenths a median 90ms later than labelled,
 * its triplets 60ms, its quarters 40ms — and the per-note spread inside one
 * section runs from -100ms to +200ms, so no single global shift repairs it.
 *
 * So: identities stay ground truth, timing gets measured. This is deliberately
 * blind to any pitch tracker — a bare DFT at the candidate frequencies — so
 * that an estimator can never be scored against a target it helped position.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readWav, downmixToMono } from "../src/eval/wav.js";
import { REPO_ROOT, CACHE_DIR } from "./decode-fixtures.js";

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export type AlignedNote = {
  id: string;
  /** The label's note name, e.g. "C#5". Ground truth; never adjusted. */
  note: string;
  /** Where the label says it is. */
  labelledStartMs: number;
  labelledEndMs: number;
  /** Where it actually sounds, to the resolution of the offset search. */
  startMs: number;
  endMs: number;
  offsetMs: number;
  /**
   * How far this note's fundamental stands above the loudest OTHER note of the
   * piece, over its measured span. Above 1 means it is the note you would name
   * listening to that span; below 1 means something else is louder throughout,
   * and no monophonic estimator can be expected to pick it out.
   */
  dominance: number;
  /** The loudest rival, which is what a monophonic estimator will report. */
  rival: string;
};

/** Offsets searched, in ms. Wide enough for a whole note at these tempos. */
const SEARCH_MIN = -120;
const SEARCH_MAX = 220;
const SEARCH_STEP = 10;
/** Fundamentals closer than this are the same note for rivalry purposes. */
const SAME_NOTE_CENTS = 50;

export function midiOfName(note: string): number {
  const m = /^([A-G])(#|b)?(-?\d+)$/.exec(note);
  if (!m) return 0;
  let pc = NAMES.indexOf(m[1]!);
  if (m[2] === "#") pc += 1;
  if (m[2] === "b") pc -= 1;
  return (Number(m[3]) + 1) * 12 + (((pc % 12) + 12) % 12);
}
export function hzOfName(note: string): number {
  return 440 * Math.pow(2, (midiOfName(note) - 69) / 12);
}
export function nameOfMidi(midi: number): string {
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
/** Labels carry things like "A3 bend to B3"; the note is the first token. */
export function labelNote(label: string): string {
  return /^([A-G])(#|b)?(-?\d+)/.exec(label)?.[0] ?? label;
}

/** Hann-windowed magnitude at exactly `hz` over `[a, b)`. */
function magnitudeAt(
  samples: Float32Array,
  sampleRate: number,
  a: number,
  b: number,
  hz: number
): number {
  if (a < 0 || b > samples.length || b - a < 64) return 0;
  const n = b - a;
  const w = (2 * Math.PI * hz) / sampleRate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s = samples[a + i]! * hann;
    re += s * Math.cos(w * i);
    im -= s * Math.sin(w * i);
  }
  return (2 * Math.sqrt(re * re + im * im)) / n;
}

export type Fixture = {
  samples: Float32Array;
  sampleRate: number;
  notes: AlignedNote[];
};

export function alignFixture(stem: string): Fixture {
  const wav = readWav(readFileSync(join(CACHE_DIR, "fixtures", `${stem}.wav`)));
  const samples = downmixToMono(wav.samples, wav.channels);
  const sampleRate = wav.sampleRate;
  const labels = JSON.parse(
    readFileSync(join(REPO_ROOT, "fixtures", "labels", `${stem}.json`), "utf8")
  ).events as Array<{ id: string; label: string; startMs: number; endMs: number }>;

  // Every pitch the piece contains: the field each note competes against. Using
  // the piece's own vocabulary rather than all 12 semitones keeps the rival
  // honest — a neighbouring note that is really there, not an arbitrary bin.
  const vocabulary = [...new Set(labels.map((l) => labelNote(l.label)))];

  const notes: AlignedNote[] = [];
  for (const label of labels) {
    const note = labelNote(label.label);
    const own = hzOfName(note);
    let bestScore = -1;
    let bestOffset = 0;
    let bestRival = "";
    for (let offset = SEARCH_MIN; offset <= SEARCH_MAX; offset += SEARCH_STEP) {
      const a = Math.round((((label.startMs + offset) / 1000) * sampleRate));
      const b = Math.round((((label.endMs + offset) / 1000) * sampleRate));
      const mine = magnitudeAt(samples, sampleRate, a, b, own);
      let rival = 0;
      let rivalName = "";
      for (const other of vocabulary) {
        const hz = hzOfName(other);
        if (Math.abs(1200 * Math.log2(hz / own)) < SAME_NOTE_CENTS) continue;
        const m = magnitudeAt(samples, sampleRate, a, b, hz);
        if (m > rival) {
          rival = m;
          rivalName = other;
        }
      }
      const score = mine / Math.max(1e-9, rival);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
        bestRival = rivalName;
      }
    }
    notes.push({
      id: label.id,
      note,
      labelledStartMs: label.startMs,
      labelledEndMs: label.endMs,
      startMs: label.startMs + bestOffset,
      endMs: label.endMs + bestOffset,
      offsetMs: bestOffset,
      dominance: bestScore,
      rival: bestRival,
    });
  }
  return { samples, sampleRate, notes };
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const stem = process.argv[2] ?? "clean-lead-120bpm";
  const { notes } = alignFixture(stem);
  for (const n of notes) {
    process.stdout.write(
      `  ${n.id.padEnd(4)} ${n.note.padEnd(4)} ` +
        `${n.startMs.toFixed(0).padStart(6)}..${n.endMs.toFixed(0).padStart(6)}ms ` +
        `(label ${n.offsetMs >= 0 ? "+" : ""}${n.offsetMs}ms)  ` +
        `${n.dominance.toFixed(2).padStart(6)}x over ${n.rival}` +
        `${n.dominance < 1 ? "   <- never the loudest note in its own span" : ""}\n`
    );
  }
  const buried = notes.filter((n) => n.dominance < 1);
  process.stdout.write(
    `\n${notes.length} notes, ${buried.length} never dominant` +
      `${buried.length ? `: ${buried.map((n) => `${n.id} ${n.note} (${n.rival} is louder)`).join(", ")}` : ""}\n`
  );
}

if (process.argv[1]?.endsWith("label-alignment.ts")) {
  await main();
}
