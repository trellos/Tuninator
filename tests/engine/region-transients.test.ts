/**
 * What the tracker tells the region lane about the transients it saw.
 *
 * The rise witness reads the long window, which lags the flux by one hop: the
 * hop that carries a transient reads the rise of the hop before it, and the
 * release's rise shows on the hop after. The record the region lane reads
 * carries the larger of the two, so a transient at the release reads as the
 * release (DECISION-054 found `a2`'s at 1.03 on its hop and 2.67 on the next).
 */

import { describe, expect, it } from "vitest";
import { SampleClock } from "../../src/engine/clock.js";
import { DEFAULT_ENGINE_CONFIG } from "../../src/engine/config.js";
import type { FastFrame } from "../../src/engine/contracts.js";
import { midiToFrequency, midiToOctave, midiToPitchClass } from "../../src/engine/kernels/notes.js";
import { NoteTracker } from "../../src/engine/tracker/note-tracker.js";

const SAMPLE_RATE = 48000;
const HOP = 640;
const HOP_MS = (HOP / SAMPLE_RATE) * 1000;
const MIDI = 57;

function frame(index: number, options: { rms: number; attack?: boolean; band?: boolean; riseRatio?: number }): FastFrame {
  const at = index * HOP_MS;
  const sampleIndex = index * HOP;
  const hz = midiToFrequency(MIDI);
  return {
    sampleIndex,
    at,
    pitch: {
      frequencyHz: hz,
      confidence: 0.95,
      nearest: {
        midi: MIDI,
        name: `${midiToPitchClass(MIDI)}${midiToOctave(MIDI)}`,
        pitchClass: midiToPitchClass(MIDI),
        octave: midiToOctave(MIDI),
        frequencyHz: hz,
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
            riseRatio: options.riseRatio ?? 1,
            sharpness: 0.6,
            fluxRatio: 2,
            heldSharpness: 0.6,
            heldFluxRatio: 2,
            dipRatio: 0.3,
            strength: 0.9,
          }
        : null,
    riseRatio: options.riseRatio ?? 1,
    bandOnset: options.band === true,
    fineOnsets: [],
    hop: index,
  };
}

describe("the transients the region lane is told about", () => {
  it("carry the witness, and the larger rise of the transient's hop and the next", () => {
    const tracker = new NoteTracker(new SampleClock(SAMPLE_RATE), DEFAULT_ENGINE_CONFIG);
    let index = 0;
    const feed = (o: Parameters<typeof frame>[1]): void => {
      tracker.process(frame(index++, o));
    };
    feed({ rms: 0.05, attack: true, riseRatio: 3 });
    for (let i = 0; i < 12; i++) feed({ rms: 0.04 });
    feed({ rms: 0.01, band: true, riseRatio: 0.4 }); // the mute's onset, band-only
    feed({ rms: 0.004, riseRatio: 0.3 });
    feed({ rms: 0.009, attack: true, riseRatio: 1.03 }); // the release's transient
    feed({ rms: 0.03, riseRatio: 2.67 }); // its rise, one hop later
    feed({ rms: 0.04, riseRatio: 1.9 });

    const transients = tracker.transientsIn(0, index * HOP);
    expect(transients.map((t) => [t.sample / HOP, t.broadband, t.riseRatio])).toEqual([
      [0, true, 3],
      [13, false, 0.4],
      [15, true, 2.67],
    ]);
    expect(tracker.transientSamplesIn(0, index * HOP)).toEqual([0, 13 * HOP, 15 * HOP]);
  });
});
