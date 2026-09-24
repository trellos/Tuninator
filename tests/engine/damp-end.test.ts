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

function config(dampFallDb: number): EngineConfig {
  return { ...DEFAULT_ENGINE_CONFIG, tracking: { ...DEFAULT_ENGINE_CONFIG.tracking, dampFallDb } };
}

function frame(
  index: number,
  options: { voiced: boolean; rms: number; attack?: boolean; riseRatio?: number; fineOnsets?: FineOnset[] }
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
            sharpness: 0.6,
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

/** Plays `levels` as one picked note, then silence; returns the Note's start and end. */
function play(dampFallDb: number, levels: number[]): { start: number; end: number } {
  const tracker = new NoteTracker(new SampleClock(SAMPLE_RATE), config(dampFallDb));
  let index = 0;
  const ended: { start: number; end: number }[] = [];
  const feed = (f: Parameters<typeof frame>[1]): void => {
    for (const emission of tracker.process(frame(index++, f))) {
      if (emission.type === "ended") ended.push({ start: emission.note.startTime, end: emission.note.endTime as number });
    }
  };
  levels.forEach((rms, i) => feed({ voiced: rms >= DEFAULT_ENGINE_CONFIG.analysis.rmsGate, rms, attack: i === 0 }));
  for (let i = 0; i < 80; i++) feed({ voiced: false, rms: 0.001 });
  const closing: TrackerEmission[] = [];
  tracker.releaseClosed(new Set(), closing, true);
  for (const emission of closing) {
    if (emission.type === "ended") ended.push({ start: emission.note.startTime, end: emission.note.endTime as number });
  }
  expect(ended).toHaveLength(1);
  return ended[0] as { start: number; end: number };
}

const HELD = 60;
/** Held at 0.3, damped over two hops, then the amp's ring above the gate for 30 hops. */
const DAMPED = [...Array(HELD).fill(0.3), 0.1, 0.03, ...Array(30).fill(0.012)];
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

  it("is on by default", () => {
    expect(DEFAULT_ENGINE_CONFIG.tracking.dampFallDb).toBe(10);
  });
});
