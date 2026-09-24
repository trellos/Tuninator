/**
 * Two ways a slow re-pick on a direct input loses its boundary, and the rules
 * that read them. Driven by handwritten frames, like `release-clock.test.ts`:
 * whether real audio produces these frames is the corpus's question.
 *
 * A note damped nearly silent before its re-pick falls under the amplitude
 * gate, and the pick's transient lands on a hop the gate refuses. When the
 * Note is still open (its tail kept a pitch reading), the re-pick is lost
 * into it unless the level coming back is read. See
 * `tracking.gatedRepickDipRatio`.
 *
 * A re-pick whose burst began on the pick landing — a transient that carried
 * no energy and was refused — is split at the release, not backdated onto the
 * contact. See `tracking.burstContactRiseRatio`.
 */

import { describe, expect, it } from "vitest";
import { SampleClock } from "../../src/engine/clock.js";
import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "../../src/engine/config.js";
import type { FastFrame } from "../../src/engine/contracts.js";
import { midiToFrequency, midiToOctave, midiToPitchClass } from "../../src/engine/kernels/notes.js";
import { NoteTracker, type TrackerEmission } from "../../src/engine/tracker/note-tracker.js";

const SAMPLE_RATE = 48000;
const HOP = 640;
const HOP_MS = (HOP / SAMPLE_RATE) * 1000;
const MIDI = 57; // A3

type FrameOptions = {
  voiced: boolean;
  rms: number;
  attack?: boolean;
  riseRatio?: number;
  dipRatio?: number;
};

function frame(index: number, options: FrameOptions): FastFrame {
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
            dipRatio: options.dipRatio ?? 0.05,
            strength: 0.9,
          }
        : null,
    riseRatio: options.riseRatio ?? 1,
    bandOnset: false,
    fineOnsets: [],
    hop: index,
  };
}

function tracking(overrides: Partial<EngineConfig["tracking"]>): EngineConfig {
  return { ...DEFAULT_ENGINE_CONFIG, tracking: { ...DEFAULT_ENGINE_CONFIG.tracking, ...overrides } };
}

function play(config: EngineConfig, script: (feed: (f: FrameOptions) => void) => void): TrackerEmission[] {
  const tracker = new NoteTracker(new SampleClock(SAMPLE_RATE), config);
  const emissions: TrackerEmission[] = [];
  let index = 0;
  script((f) => {
    for (const emission of tracker.process(frame(index++, f))) emissions.push(emission);
  });
  return emissions;
}

function starts(emissions: TrackerEmission[]): number[] {
  return emissions.filter((e) => e.type === "started").map((e) => e.note.startTime);
}

/**
 * A3 sounded for 30 hops, then one hop damped under the gate carrying the
 * re-pick's transient, then the string back at full level with no transient
 * of its own, as the fast lane reads the held-then-picked DI take at 29467ms.
 */
const GATED_AT = 31 * HOP_MS;
function gatedRepick(feed: (f: FrameOptions) => void, dipRatio = 0.05): void {
  feed({ voiced: true, rms: 0.05, attack: true });
  for (let i = 0; i < 30; i++) feed({ voiced: true, rms: 0.05 });
  feed({ voiced: true, rms: 0.0001, attack: true, riseRatio: 3, dipRatio });
  feed({ voiced: true, rms: 0.05, riseRatio: 3 });
  for (let i = 0; i < 20; i++) feed({ voiced: true, rms: 0.05 });
  for (let i = 0; i < 20; i++) feed({ voiced: false, rms: 0.0001 });
}

describe("a re-pick whose transient the amplitude gate refused", () => {
  it("splits the Note at the refused transient once the level comes back", () => {
    const notes = starts(play(tracking({ gatedRepickDipRatio: 0.25 }), (feed) => gatedRepick(feed)));
    expect(notes).toHaveLength(2);
    expect(notes[1]).toBeCloseTo(GATED_AT, 6);
  });

  it("does not, when the envelope had not fallen before it", () => {
    const notes = starts(play(tracking({ gatedRepickDipRatio: 0.25 }), (feed) => gatedRepick(feed, 0.6)));
    expect(notes).toHaveLength(1);
  });

  it("off, the re-pick is lost into the Note as the gate shipped", () => {
    const notes = starts(play(tracking({ gatedRepickDipRatio: 0 }), (feed) => gatedRepick(feed)));
    expect(notes).toHaveLength(1);
  });

  it("is on by default", () => {
    expect(DEFAULT_ENGINE_CONFIG.tracking.gatedRepickDipRatio).toBeGreaterThan(0);
  });
});

/**
 * A3 sounded for 30 hops, then the pick lands (a transient that rose 0.8,
 * refused), then four hops later its release (rise 3, accepted), then the
 * string speaking.
 */
const CONTACT_AT = 31 * HOP_MS;
const RELEASE_AT = 35 * HOP_MS;
function contactThenRelease(feed: (f: FrameOptions) => void): void {
  feed({ voiced: true, rms: 0.05, attack: true });
  for (let i = 0; i < 30; i++) feed({ voiced: true, rms: 0.05 });
  feed({ voiced: true, rms: 0.04, attack: true, riseRatio: 0.8, dipRatio: 0.7 });
  for (let i = 0; i < 3; i++) feed({ voiced: true, rms: 0.04 });
  feed({ voiced: true, rms: 0.12, attack: true, riseRatio: 3, dipRatio: 0.3 });
  for (let i = 0; i < 20; i++) feed({ voiced: true, rms: 0.1 });
  for (let i = 0; i < 20; i++) feed({ voiced: false, rms: 0.0001 });
}

describe("a split whose burst began on a refused contact", () => {
  it("is placed on the release", () => {
    const notes = starts(play(tracking({ burstContactRiseRatio: 1.2 }), contactThenRelease));
    expect(notes).toHaveLength(2);
    expect(notes[1]).toBeCloseTo(RELEASE_AT, 6);
  });

  it("off, is backdated onto the contact as the burst rule shipped", () => {
    const notes = starts(play(tracking({ burstContactRiseRatio: 0 }), contactThenRelease));
    expect(notes).toHaveLength(2);
    expect(notes[1]).toBeCloseTo(CONTACT_AT, 6);
  });

  it("is on by default", () => {
    expect(DEFAULT_ENGINE_CONFIG.tracking.burstContactRiseRatio).toBeGreaterThan(0);
  });
});
