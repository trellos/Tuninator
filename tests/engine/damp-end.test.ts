/**
 * A Note ending in silence ends at the player's damp (DECISION-073).
 *
 * Through an amp the string rings on past the damp, quiet but above the gate,
 * for about 0.45s; the Note used to end where that ring fell under the gate.
 * Driven by handwritten frames, like `release-clock.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { SampleClock } from "../../src/engine/clock.js";
import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "../../src/engine/config.js";
import type { FastFrame } from "../../src/engine/contracts.js";
import type { FineOnset } from "../../src/engine/kernels/fine-onset.js";
import { midiToFrequency, midiToOctave, midiToPitchClass } from "../../src/engine/kernels/notes.js";
import { NoteTracker, type TrackerEmission } from "../../src/engine/tracker/note-tracker.js";

const SAMPLE_RATE = 48000;
const HOP = 640;
const HOP_MS = (HOP / SAMPLE_RATE) * 1000;
const MIDI = 43; // G2

/**
 * With `anyPick`, every sharp attack re-articulates: whether the rattle of a
 * damp gets past the ring-out test is `rearticulation.ts`'s question, and
 * here it is given that it did.
 */
function config(dampFallDb: number, anyPick = false): EngineConfig {
  return {
    ...DEFAULT_ENGINE_CONFIG,
    tracking: { ...DEFAULT_ENGINE_CONFIG.tracking, dampFallDb },
    transient: anyPick ? { ...DEFAULT_ENGINE_CONFIG.transient, ringOutMs: Infinity } : DEFAULT_ENGINE_CONFIG.transient,
  };
}

function frame(
  index: number,
  options: { voiced: boolean; rms: number; attack?: boolean; riseRatio?: number; sharpness?: number; fineOnsets?: FineOnset[] }
): FastFrame {
  const at = index * HOP_MS;
  const sampleIndex = index * HOP;
  const hz = options.voiced ? midiToFrequency(MIDI) : null;
  return {
    sampleIndex,
    at,
    pitch: {
      frequencyHz: hz,
      confidence: hz === null ? 0 : 0.95,
      nearest:
        hz === null
          ? null
          : {
              midi: MIDI,
              name: `${midiToPitchClass(MIDI)}${midiToOctave(MIDI)}`,
              pitchClass: midiToPitchClass(MIDI),
              octave: midiToOctave(MIDI),
              frequencyHz: midiToFrequency(MIDI),
              cents: 0,
            },
      tau: null,
      cmnd: null,
      zeroCrossingHz: null,
      source: "long",
    },
    rms: options.rms,
    peak: options.rms * 2,
    gated: options.rms < DEFAULT_ENGINE_CONFIG.analysis.rmsGate,
    attack:
      options.attack === true
        ? {
            at,
            atSample: sampleIndex,
            flux: true,
            fluxValue: 0.4,
            envelope: true,
            riseRatio: options.riseRatio ?? 3,
            sharpness: options.sharpness ?? 0.6,
            fluxRatio: 2,
            heldSharpness: 0.6,
            heldFluxRatio: 2,
            dipRatio: 0.05,
            strength: 0.9,
          }
        : null,
    riseRatio: options.riseRatio ?? 1,
    bandOnset: false,
    fineOnsets: options.fineOnsets ?? [],
    hop: index,
  };
}

/** Plays `levels`, picked on the `struck` hops, then silence; returns the Notes left standing. */
function notes(dampFallDb: number, levels: number[], struck: number[] = [0]): { start: number; end: number }[] {
  const tracker = new NoteTracker(new SampleClock(SAMPLE_RATE), config(dampFallDb, struck.length > 1));
  let index = 0;
  const ended: { id: string; start: number; end: number }[] = [];
  const emissions: TrackerEmission[] = [];
  const feed = (f: Parameters<typeof frame>[1]): void => {
    for (const emission of tracker.process(frame(index++, f))) emissions.push(emission);
  };
  levels.forEach((rms, i) =>
    feed({
      voiced: rms >= DEFAULT_ENGINE_CONFIG.analysis.rmsGate,
      rms,
      attack: struck.includes(i),
      sharpness: i === 0 ? 0.6 : 3,
    })
  );
  for (let i = 0; i < 80; i++) feed({ voiced: false, rms: 0.001 });
  tracker.releaseClosed(new Set(), emissions, true);
  for (const emission of emissions) {
    if (emission.type === "ended") {
      ended.push({ id: emission.note.id, start: emission.note.startTime, end: emission.note.endTime as number });
    }
  }
  const absorbed = new Set(
    [...emissions].flatMap((e) =>
      e.type === "changed" && e.change.type === "structuralRevision" ? (e.change.relatedNoteIds ?? []) : []
    )
  );
  return ended.filter((note) => !absorbed.has(note.id));
}

/** The one Note `levels` should read as. */
function play(dampFallDb: number, levels: number[], struck: number[] = [0]): { start: number; end: number } {
  const kept = notes(dampFallDb, levels, struck);
  expect(kept).toHaveLength(1);
  return kept[0] as { start: number; end: number };
}

const HELD = 60;
/** Held at 0.3, damped over two hops, then the amp's ring above the gate for 30 hops. */
const DAMPED = [...Array(HELD).fill(0.3), 0.1, 0.03, ...Array(30).fill(0.012)];
/** The same damp rattling the string once, 15dB under the note, on its third hop. */
const RATTLED = DAMPED.map((rms, i) => (i === HELD + 2 ? 0.05 : rms));
/** Held, then let decay about 0.5dB a hop until it falls under the gate. */
const DECAYING = [...Array(HELD).fill(0.3), ...Array.from({ length: 70 }, (_, i) => 0.3 * 0.94 ** (i + 1))];

describe("a Note ending in silence", () => {
  it("ends on the damp, not where the ring falls under the gate", () => {
    expect(play(10, DAMPED).end).toBeCloseTo(HELD * HOP_MS, 6);
  });

  it("off, ends where the ring falls under the gate", () => {
    expect(play(0, DAMPED).end).toBeCloseTo(DAMPED.length * HOP_MS, 6);
  });

  it("left to decay, ends where the sound does", () => {
    const gated = DECAYING.findIndex((rms) => rms < DEFAULT_ENGINE_CONFIG.analysis.rmsGate);
    expect(play(10, DECAYING).end).toBeCloseTo(gated * HOP_MS, 6);
  });

  it("absorbs a Note the damp itself opened, and ends the one before at the damp", () => {
    const struck = [0, HELD + 2];
    expect(notes(0, RATTLED, struck)).toHaveLength(2);
    expect(play(10, RATTLED, struck).end).toBeCloseTo(HELD * HOP_MS, 6);
  });

  it("is on by default", () => {
    expect(DEFAULT_ENGINE_CONFIG.tracking.dampFallDb).toBe(10);
  });
});
