/**
 * The Phase 2 features, exactly as `phase2.ts`'s header defines them, over any
 * set of model frames: a causal reading (`causal.ts`) or the whole-take
 * posteriorgram (`framing.ts`). Pure functions; no runtime here.
 */

import { DECISION_FRAME } from "./causal.js";
import { HOP, SAMPLE_RATE, type Posteriorgram } from "./framing.js";
import type { WindowOutput } from "./runtime.js";

export const LOW_MIDI = 40; // E2
export const HIGH_MIDI = 88; // E6
const FRAME_MS = (1000 * HOP) / SAMPLE_RATE;

/** A read-only view of model frames with their centre times. */
export type Frames = {
  count: number;
  timeMs(f: number): number;
  onset(f: number, midi: number): number;
  note(f: number, midi: number): number;
};

/** The frames of one causal window cut at `atMs` that a decision at `atMs` may use. */
export function causalFrames(out: WindowOutput, atMs: number): Frames {
  return {
    count: DECISION_FRAME + 1,
    timeMs: (f) => atMs + (f - DECISION_FRAME) * FRAME_MS,
    onset: (f, m) => out.onset[f * 88 + (m - 21)] as number,
    note: (f, m) => out.note[f * 88 + (m - 21)] as number,
  };
}

export function wholeFrames(pg: Posteriorgram): Frames {
  return {
    count: pg.frames,
    timeMs: (f) => pg.timesMs[f] as number,
    onset: (f, m) => pg.onset[f * 88 + (m - 21)] as number,
    note: (f, m) => pg.note[f * 88 + (m - 21)] as number,
  };
}

const NOTE_PC: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** MIDI number of a note name like "A3", "F#2", "Bb3"; null for anything else. */
export function midiOf(name: string): number | null {
  const m = /^([A-G])([#b♯♭]*)(-?\d)$/.exec(name.trim());
  if (m === null) return null;
  let pc = NOTE_PC[m[1] as string] as number;
  for (const ch of m[2] as string) pc += ch === "#" || ch === "♯" ? 1 : -1;
  return 12 * (Number(m[3]) + 1) + pc;
}

/** Every MIDI note from E2 to E6 sharing a pitch class with any of `midis`. */
export function pitchSet(midis: readonly number[] | null): number[] {
  const all: number[] = [];
  for (let m = LOW_MIDI; m <= HIGH_MIDI; m++) all.push(m);
  if (midis === null || midis.length === 0) return all;
  const pcs = new Set(midis.map((m) => ((m % 12) + 12) % 12));
  return all.filter((m) => pcs.has(m % 12));
}

/** Frames whose centre lies in [a, b]. */
function framesIn(fr: Frames, a: number, b: number): number[] {
  const out: number[] = [];
  // Binary-search-free: frames are few for a causal reading; for the whole take
  // start from an estimate.
  const first = Math.max(0, Math.floor((a - fr.timeMs(0)) / FRAME_MS) - 2);
  for (let f = first; f < fr.count; f++) {
    const t = fr.timeMs(f);
    if (t > b) break;
    if (t >= a) out.push(f);
  }
  return out;
}

/** O(S): the largest onset over PS within +-windowMs of S. NaN when no frame is readable. */
export function onsetAt(fr: Frames, s: number, ps: readonly number[], windowMs: number): number {
  const fs = framesIn(fr, s - windowMs, s + windowMs);
  if (fs.length === 0) return NaN;
  let best = 0;
  for (const f of fs) for (const m of ps) best = Math.max(best, fr.onset(f, m));
  return best;
}

/** N(a,b): mean over frames in [a,b] of the largest note activation over PS. */
export function soundingOver(fr: Frames, a: number, b: number, ps: readonly number[]): number {
  const fs = framesIn(fr, a, b);
  if (fs.length === 0) return NaN;
  let sum = 0;
  for (const f of fs) {
    let best = 0;
    for (const m of ps) best = Math.max(best, fr.note(f, m));
    sum += best;
  }
  return sum / fs.length;
}

/** Mean note activation per MIDI note (E2..E6) over frames in [a,b]; null with no frames. */
export function meanNotes(fr: Frames, a: number, b: number): Float64Array | null {
  const fs = framesIn(fr, a, b);
  if (fs.length === 0) return null;
  const mean = new Float64Array(HIGH_MIDI - LOW_MIDI + 1);
  for (const f of fs) for (let m = LOW_MIDI; m <= HIGH_MIDI; m++) mean[m - LOW_MIDI] = (mean[m - LOW_MIDI] as number) + fr.note(f, m);
  for (let i = 0; i < mean.length; i++) mean[i] = (mean[i] as number) / fs.length;
  return mean;
}

/** The MIDI note with the highest mean activation; null with no frames. */
export function dominantMidi(mean: Float64Array | null): number | null {
  if (mean === null) return null;
  let best = 0;
  for (let i = 1; i < mean.length; i++) if ((mean[i] as number) > (mean[best] as number)) best = i;
  return LOW_MIDI + best;
}

/** The lowest MIDI note whose mean activation reaches `threshold`; null if none. */
export function bassMidi(mean: Float64Array | null, threshold: number): number | null {
  if (mean === null) return null;
  for (let i = 0; i < mean.length; i++) if ((mean[i] as number) >= threshold) return LOW_MIDI + i;
  return null;
}

/**
 * The largest onset over PS that is a local maximum in time, in frames centred
 * in [a, b] and passing `keep`; 0 if there is none. A frame needs both
 * neighbours readable.
 */
export function localOnsetPeak(
  fr: Frames,
  a: number,
  b: number,
  ps: readonly number[],
  keep: (t: number) => boolean = () => true,
): number {
  let best = 0;
  for (const f of framesIn(fr, a, b)) {
    if (f < 1 || f + 1 >= fr.count) continue;
    if (!keep(fr.timeMs(f))) continue;
    for (const m of ps) {
      const v = fr.onset(f, m);
      if (v >= fr.onset(f - 1, m) && v > fr.onset(f + 1, m) && v > best) best = v;
    }
  }
  return best;
}
