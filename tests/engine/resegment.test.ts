/**
 * The segmentation rule, decided from a sequence and nothing else.
 *
 * `segmentRegion` is the whole reason the deep lane can now say something the
 * window-tagger could not: how many events a span of audio contains. Its input
 * is a list of window readings, so every property below is stated against a
 * handwritten sequence — no FFT, no fixtures, no audio. If a boundary rule can
 * only be demonstrated by running the recognizer over a recording, it is not a
 * rule, it is a coincidence.
 */

import { describe, expect, it } from "vitest";
import type { PitchActivation, RegionWindowReading } from "../../src/engine/contracts.js";
import { segmentRegion, type SegmentOptions } from "../../src/engine/deep/resegment.js";
import { midiToOctave, midiToPitchClass, midiToFrequency } from "../../src/engine/kernels/notes.js";

const SAMPLE_RATE = 48000;
const SAMPLES_PER_MS = SAMPLE_RATE / 1000;
const WINDOW = 4096;
const HOP = 1024;

const OPTIONS: SegmentOptions = {
  minSegmentMs: 90,
  holdWindows: 2,
  riseRatio: 2,
  attackSamples: [],
  attackRiseRatio: 1.25,
  windowSize: WINDOW,
  samplesPerMs: SAMPLES_PER_MS,
};

function activation(midi: number, salience: number): PitchActivation {
  return {
    frequencyHz: midiToFrequency(midi),
    midi,
    pitchClass: midiToPitchClass(midi),
    octave: midiToOctave(midi),
    salience,
    confidence: 0.5 + 0.5 * salience,
  };
}

/**
 * Build a window sequence from a shorthand: one entry per window, giving the
 * fundamentals present and the envelope. The first named fundamental is the
 * loudest, which is what makes "the leader moved" expressible.
 */
function windows(
  entries: ReadonlyArray<{ pitches: readonly number[]; rms: number }>
): RegionWindowReading[] {
  return entries.map((entry, index) => {
    const to = WINDOW + index * HOP;
    const activations = entry.pitches.map((midi, rank) =>
      activation(midi, 1 - rank * 0.3)
    );
    return {
      fromSample: to - WINDOW,
      toSample: to,
      at: to / SAMPLES_PER_MS,
      dominantMidi: activations[0]?.midi ?? null,
      runnerUpSalience: activations[1]?.salience ?? 0,
      rms: entry.rms,
      activations,
      evidence: {
        chroma: new Float32Array(12),
        bassPitchClass: null,
        bassFrequencyHz: null,
        salience: 1,
        polyphony: entry.pitches.length,
        voiceSpreadSemitones: 0,
      },
      reading: {
        root: null,
        quality: null,
        chordName: null,
        bass: null,
        intervals: [],
        confidence: 0.4,
        alternatives: [],
        isConfident: false,
      },
    };
  });
}

/** A steady note: same leader, same level, for `count` windows. */
function steady(midi: number, count: number, rms = 0.01) {
  return Array.from({ length: count }, () => ({ pitches: [midi], rms }));
}

describe("a region with nothing in it", () => {
  it("returns no segments for no windows", () => {
    expect(segmentRegion([], OPTIONS)).toHaveLength(0);
  });

  it("returns exactly one segment when nothing changes", () => {
    // The honest answer when the fast lane got it right. A re-segmenter that
    // cannot say "one event" is a fragmenter.
    const segments = segmentRegion(windows(steady(74, 12)), OPTIONS);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.dominantMidi).toBe(74);
    expect(segments[0]?.boundary).toBe("regionStart");
  });

  it("spans the whole region", () => {
    const sequence = windows(steady(74, 12));
    const segments = segmentRegion(sequence, OPTIONS);
    expect(segments[0]?.fromSample).toBe(0);
    expect(segments[0]?.toSample).toBe(sequence[sequence.length - 1]?.toSample);
  });
});

describe("the leader moving is a boundary", () => {
  it("splits where the dominant fundamental changes and holds", () => {
    const segments = segmentRegion(
      windows([...steady(74, 8), ...steady(69, 8)]),
      OPTIONS
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]?.dominantMidi).toBe(74);
    expect(segments[1]?.dominantMidi).toBe(69);
    expect(segments[1]?.boundary).toBe("pitchChange");
  });

  it("places the boundary at the START of the window that first saw it", () => {
    // A window ending at E describes [E-windowSize, E). Dating the boundary at
    // E would hand the new event a whole window of its predecessor's audio —
    // the exact failure that made reaching the window forward so destructive.
    const sequence = windows([...steady(74, 8), ...steady(69, 8)]);
    const segments = segmentRegion(sequence, OPTIONS);
    expect(segments[1]?.fromSample).toBe((sequence[8] as RegionWindowReading).toSample - WINDOW);
  });

  it("ignores a leader that flaps for one window", () => {
    // An 85ms transform straddling a boundary reports whichever of the two
    // notes is momentarily louder, then changes its mind. One window is noise.
    const segments = segmentRegion(
      windows([...steady(74, 6), { pitches: [69], rms: 0.01 }, ...steady(74, 6)]),
      OPTIONS
    );
    expect(segments).toHaveLength(1);
  });

  it("follows the leader rather than the loudest voice overall", () => {
    // The sixteenths run has an open B ringing under the melody. In any single
    // window the drone can be the strongest fundamental; what identifies the
    // melody is that the leader moves while the drone does not.
    const segments = segmentRegion(
      windows([
        ...Array.from({ length: 6 }, () => ({ pitches: [71, 59], rms: 0.01 })),
        ...Array.from({ length: 6 }, () => ({ pitches: [69, 59], rms: 0.01 })),
      ]),
      OPTIONS
    );
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.dominantMidi)).toEqual([71, 69]);
  });

  it("refuses a boundary too near the end to have held", () => {
    const segments = segmentRegion(
      windows([...steady(74, 10), { pitches: [69], rms: 0.01 }]),
      OPTIONS
    );
    expect(segments).toHaveLength(1);
  });
});

describe("the envelope rising is a boundary", () => {
  it("splits a note re-picked at its own pitch", () => {
    // Nothing about the spectrum can separate a D5 picked twice from a D5
    // picked once. The trough between the two picks can.
    const segments = segmentRegion(
      windows([
        { pitches: [74], rms: 0.012 },
        { pitches: [74], rms: 0.009 },
        { pitches: [74], rms: 0.006 },
        { pitches: [74], rms: 0.005 },
        { pitches: [74], rms: 0.004 },
        { pitches: [74], rms: 0.011 },
        { pitches: [74], rms: 0.018 },
        { pitches: [74], rms: 0.016 },
      ]),
      OPTIONS
    );
    expect(segments).toHaveLength(2);
    expect(segments[1]?.boundary).toBe("energyRise");
    expect(segments.map((s) => s.dominantMidi)).toEqual([74, 74]);
  });

  it("does not split on sustain ripple", () => {
    const segments = segmentRegion(
      windows([
        { pitches: [74], rms: 0.010 },
        { pitches: [74], rms: 0.008 },
        { pitches: [74], rms: 0.009 },
        { pitches: [74], rms: 0.007 },
        { pitches: [74], rms: 0.010 },
        { pitches: [74], rms: 0.008 },
        { pitches: [74], rms: 0.011 },
        { pitches: [74], rms: 0.009 },
      ]),
      OPTIONS
    );
    expect(segments).toHaveLength(1);
  });

  it("measures the rise against the trough since the last boundary, not the region's", () => {
    // Two picks, each decaying. The second pick's own decay must not be
    // measured against the first pick's trough, or every ring-out re-splits.
    const segments = segmentRegion(
      windows([
        { pitches: [74], rms: 0.004 },
        { pitches: [74], rms: 0.003 },
        { pitches: [74], rms: 0.010 },
        { pitches: [74], rms: 0.009 },
        { pitches: [74], rms: 0.008 },
        { pitches: [74], rms: 0.007 },
        { pitches: [74], rms: 0.006 },
        { pitches: [74], rms: 0.006 },
      ]),
      OPTIONS
    );
    expect(segments).toHaveLength(2);
  });
});

describe("a boundary has to be worth having", () => {
  it("refuses to carve out less than one note's worth of audio", () => {
    // 90ms at 48kHz is four hops. A change two hops in is the window sliding
    // across a boundary that is already there.
    const segments = segmentRegion(
      windows([{ pitches: [74], rms: 0.01 }, ...steady(69, 10)]),
      { ...OPTIONS, minSegmentMs: 200 }
    );
    expect(segments).toHaveLength(1);
  });
});

describe("determinism", () => {
  it("gives the same answer on every run", () => {
    const sequence = windows([
      ...steady(74, 5),
      ...steady(69, 5),
      { pitches: [69], rms: 0.02 },
      ...steady(69, 5),
    ]);
    const first = JSON.stringify(segmentRegion(sequence, OPTIONS));
    for (let i = 0; i < 5; i++) {
      expect(JSON.stringify(segmentRegion(sequence, OPTIONS))).toBe(first);
    }
  });

  it("breaks a salience tie toward the lower note", () => {
    // Two fundamentals with identical accumulated salience must not be ordered
    // by whichever the Map saw first.
    const sequence = windows([
      { pitches: [74], rms: 0.01 },
      { pitches: [69], rms: 0.01 },
      { pitches: [74], rms: 0.01 },
      { pitches: [69], rms: 0.01 },
    ]);
    expect(segmentRegion(sequence, OPTIONS)[0]?.dominantMidi).toBe(69);
  });
});

/* -------------------------------------------------------------------------- */
/* Quiet alternate picking: the fast lane proposes, the region disposes         */
/* -------------------------------------------------------------------------- */

describe("transients the fast lane recorded and could not act on", () => {
  /**
   * A run of same-pitch sixteenths at 140bpm — 107ms apart — where every other
   * stroke is a quiet upstroke. Nothing in the spectrum separates the strokes:
   * they are the same note, so the leader never moves, and an 85ms window
   * straddling a 107ms boundary never sees the envelope double. The only thing
   * that says a second stroke happened is that a transient landed there.
   */
  function alternatePicking(count: number): {
    sequence: RegionWindowReading[];
    attacks: number[];
  } {
    const strokeMs = 107;
    const entries: { pitches: readonly number[]; rms: number }[] = [];
    const attacks: number[] = [];
    const totalWindows = Math.ceil((count * strokeMs * SAMPLES_PER_MS) / HOP);
    for (let i = 0; i < totalWindows; i++) {
      const at = ((WINDOW + i * HOP - WINDOW) / SAMPLES_PER_MS);
      const stroke = Math.floor(at / strokeMs);
      const into = at - stroke * strokeMs;
      // Loud downstroke, quieter upstroke, each decaying across its own
      // stroke. The rises this produces — 1.38 into an upstroke and 1.91 into
      // the downstroke that answers it — both sit below `riseRatio`, so the
      // envelope alone finds nothing here. That is the point: at 107ms an 85ms
      // window still holds most of the stroke before the one it is about.
      const peak = stroke % 2 === 0 ? 1 : 0.85;
      entries.push({ pitches: [64], rms: peak * Math.exp(-into / 220) });
    }
    for (let s = 1; s < count; s++) attacks.push(Math.round(s * strokeMs * SAMPLES_PER_MS));
    return { sequence: windows(entries), attacks };
  }

  it("finds a stroke the spectrum cannot see, at the sample the pick landed", () => {
    const { sequence, attacks } = alternatePicking(6);
    const without = segmentRegion(sequence, OPTIONS);
    const withAttacks = segmentRegion(sequence, { ...OPTIONS, attackSamples: attacks });

    expect(without.length).toBeLessThan(withAttacks.length);
    // Every boundary the attacks bought sits exactly on a transient, not on the
    // start of whichever 85ms window happened to notice it.
    for (const segment of withAttacks.slice(1)) {
      if (segment.boundary !== "attack") continue;
      expect(attacks).toContain(segment.fromSample);
    }
  });

  it("does not invent a boundary where no transient was recorded", () => {
    const { sequence } = alternatePicking(6);
    const segments = segmentRegion(sequence, { ...OPTIONS, attackSamples: [] });
    expect(segments.every((segment) => segment.boundary !== "attack")).toBe(true);
  });

  it("still requires the envelope to answer the pick", () => {
    // The same transients over an envelope that only ever falls: a pick that
    // put nothing into the string is a pick that landed on a muted string, or
    // a transient that was never a pick at all.
    const entries = [];
    for (let i = 0; i < 30; i++) entries.push({ pitches: [64], rms: Math.exp(-i / 8) });
    const attacks = [1, 2, 3, 4].map((s) => Math.round(s * 107 * SAMPLES_PER_MS));
    const segments = segmentRegion(windows(entries), { ...OPTIONS, attackSamples: attacks });
    expect(segments.every((segment) => segment.boundary !== "attack")).toBe(true);
  });
});
