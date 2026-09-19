/**
 * The release test on a Note the fine witness opened, on the frame that opens
 * it, and the announce clock that move must not restart.
 *
 * The fine witness confirms an onset 65ms after it, so the contact it delivers
 * can arrive on the same hop as the pick's release. The Note it opens is born
 * settled, and DECISION-050's release test read unsettled Notes only, so the
 * Note kept the contact. Reading it there moves the start; a stroke whose
 * release barely re-excites the string then has one hop on a clock that used
 * to read from the contact, and would be dropped where it used to be
 * announced. Driven by handwritten frames, like `region-reconcile.test.ts`:
 * whether the hop is really the release is `release-boundary.test.ts`'s
 * question.
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
const MIDI = 57; // A3

function config(on: boolean): EngineConfig {
  return {
    ...DEFAULT_ENGINE_CONFIG,
    tracking: { ...DEFAULT_ENGINE_CONFIG.tracking, releaseOnFineOpenedFrame: on },
  };
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

/**
 * One note, then the pick lands (three gated hops), then a gated hop carrying
 * the release's rise and the fine witness's word that the contact was 77ms
 * ago, then `voicedAfter` hops of the string speaking, then silence.
 */
function play(on: boolean, voicedAfter: number): TrackerEmission[] {
  const tracker = new NoteTracker(new SampleClock(SAMPLE_RATE), config(on));
  const emissions: TrackerEmission[] = [];
  let index = 0;
  const feed = (f: Parameters<typeof frame>[1]): void => {
    for (const emission of tracker.process(frame(index++, f))) emissions.push(emission);
  };
  feed({ voiced: true, rms: 0.05, attack: true });
  for (let i = 0; i < 16; i++) feed({ voiced: true, rms: 0.05 });
  for (let i = 0; i < 3; i++) feed({ voiced: false, rms: 0.001 });
  const releaseAt = index * HOP_MS;
  const contact: FineOnset = {
    atSample: Math.round(((releaseAt - 77) / 1000) * SAMPLE_RATE),
    value: 3,
    dipDb: -15,
    reboundDb: 8,
  };
  feed({ voiced: false, rms: 0.001, attack: true, riseRatio: 3, fineOnsets: [contact] });
  for (let i = 0; i < voicedAfter; i++) feed({ voiced: true, rms: 0.05 });
  for (let i = 0; i < 20; i++) feed({ voiced: false, rms: 0.001 });
  return emissions;
}

function starts(emissions: TrackerEmission[]): number[] {
  return emissions.filter((e) => e.type === "started").map((e) => e.note.startTime);
}

const RELEASE_AT = 20 * HOP_MS;

describe("the release on the frame the fine witness opens a Note", () => {
  it("moves the Note it opened onto the gated release hop", () => {
    const [, second] = starts(play(true, 19));
    expect(second).toBeCloseTo(RELEASE_AT, 6);
  });

  it("keeps the announce clock on the contact, so one hop of string after the release is still a Note", () => {
    const on = starts(play(true, 1));
    expect(on).toHaveLength(2);
    expect(on[1]).toBeCloseTo(RELEASE_AT, 6);
  });

  it("off, the Note keeps the contact as DECISION-050 shipped it", () => {
    const [, second] = starts(play(false, 19));
    expect(second).toBeCloseTo(RELEASE_AT - 77, 1);
  });

  it("is on by default", () => {
    expect(DEFAULT_ENGINE_CONFIG.tracking.releaseOnFineOpenedFrame).toBe(true);
  });
});
