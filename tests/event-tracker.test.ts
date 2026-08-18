/**
 * The event tracker is driven entirely by synthetic `EngineFrame`s here — no
 * FFT, no YIN, no audio. That is deliberate: these are the semantics the eval
 * matcher depends on, so they must be verifiable independently of whether the
 * detector in front of them is any good.
 */

import { describe, expect, it } from "vitest";
import { EventTracker, type TrackerEmission } from "../src/core/event-tracker.js";
import type { EngineFrame } from "../src/core/pitch-engine.js";
import { resolvePolicy } from "../src/core/policy.js";
import type { PitchFrame } from "../src/types.js";

const HOP_MS = 12;

type FrameOptions = {
  onset?: boolean;
  rms?: number;
  confidence?: number;
};

function engineFrame(timestamp: number, hz: number | null, options: FrameOptions = {}): EngineFrame {
  const rms = options.rms ?? 0.05;
  const confidence = options.confidence ?? 0.9;

  const frame: PitchFrame = {
    timestamp,
    frequencyHz: hz,
    confidence: hz === null ? 0 : confidence,
    nearest: null,
    amplitude: { rms, peak: rms * 1.5 },
    detector: { tau: null, cmnd: null, zeroCrossingHz: null, effectiveSampleRate: 48000 },
  };

  return {
    frame,
    onset: options.onset ?? false,
    onsetFlux: options.onset ? 1 : 0,
    chroma: null,
    chord: null,
  };
}

/** Feeds a run of identical-pitch frames, returning every emission in order. */
function feed(
  tracker: EventTracker,
  startMs: number,
  count: number,
  hz: number | null,
  options: FrameOptions = {}
): { emissions: TrackerEmission[]; nextMs: number } {
  const emissions: TrackerEmission[] = [];
  let t = startMs;
  for (let i = 0; i < count; i++) {
    // An onset applies only to the first frame of the run.
    const frameOptions = i === 0 ? options : { ...options, onset: false };
    emissions.push(...tracker.process(engineFrame(t, hz, frameOptions)));
    t += HOP_MS;
  }
  return { emissions, nextMs: t };
}

const A4 = 440;
const B4 = 493.88;
const D5 = 587.33;
const E5 = 659.26;

describe("EventTracker", () => {
  it("emits start, then end, for a single sustained note", () => {
    const tracker = new EventTracker(resolvePolicy({ mode: "lead" }));

    const { emissions, nextMs } = feed(tracker, 0, 20, A4, { onset: true });
    const starts = emissions.filter((e) => e.type === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.event.label.name).toBe("A4");
    expect(starts[0]!.event.startedAt).toBe(0);

    const ends = tracker.flush(nextMs);
    expect(ends.filter((e) => e.type === "end")).toHaveLength(1);
    expect(ends.at(-1)!.event.state).toBe("ended");
    expect(ends.at(-1)!.event.endedAt).toBe(nextMs);
  });

  it("splits a re-picked note at the same pitch into two events", () => {
    const tracker = new EventTracker(resolvePolicy({ mode: "lead" }));
    const emissions: TrackerEmission[] = [];

    // A real re-pick puts energy back into the string, so the attack is louder
    // than the decayed tail it interrupts. Feeding a flat amplitude here would
    // test a signal no guitar produces.
    let t = 0;
    const pluck = (frames: number): void => {
      for (let i = 0; i < frames; i++) {
        const rms = 0.09 * Math.exp(-i / 14);
        emissions.push(...tracker.process(engineFrame(t, A4, { onset: i === 0, rms })));
        t += HOP_MS;
      }
    };

    pluck(20);
    pluck(20);
    emissions.push(...tracker.flush(t));

    expect(emissions.filter((e) => e.type === "start")).toHaveLength(2);
    expect(emissions.filter((e) => e.type === "end")).toHaveLength(2);
    expect(new Set(emissions.map((e) => e.event.id)).size).toBe(2);
  });

  it("ignores a mid-note onset that carries no rise in amplitude", () => {
    const tracker = new EventTracker(resolvePolicy({ mode: "lead" }));
    const emissions: TrackerEmission[] = [];

    // Spectral flux fires on more than attacks: as a note decays the adaptive
    // median falls with it, so sustain ripple keeps clearing the threshold.
    // Those onsets carry no new energy and must not halve the note.
    let t = 0;
    for (let i = 0; i < 40; i++) {
      const rms = 0.09 * Math.exp(-i / 25);
      const spuriousOnset = i === 14 || i === 27;
      emissions.push(
        ...tracker.process(engineFrame(t, A4, { onset: i === 0 || spuriousOnset, rms }))
      );
      t += HOP_MS;
    }
    emissions.push(...tracker.flush(t));

    expect(emissions.filter((e) => e.type === "start")).toHaveLength(1);
    expect(emissions.filter((e) => e.type === "end")).toHaveLength(1);
  });

  it("keeps a gradual bend as ONE event and records the excursion", () => {
    const tracker = new EventTracker(resolvePolicy({ mode: "lead" }));
    const emissions: TrackerEmission[] = [];

    // A3 -> B3 is 200 cents. Glide it over 30 hops (360ms), which is how a real
    // bend behaves: many frames, each a small step.
    const startHz = 220;
    const steps = 30;
    let t = 0;
    emissions.push(...tracker.process(engineFrame(t, startHz, { onset: true })));
    t += HOP_MS;
    for (let i = 1; i <= steps; i++) {
      const hz = startHz * Math.pow(2, (200 * (i / steps)) / 1200);
      emissions.push(...tracker.process(engineFrame(t, hz)));
      t += HOP_MS;
    }
    emissions.push(...tracker.flush(t));

    expect(emissions.filter((e) => e.type === "start")).toHaveLength(1);
    expect(emissions.filter((e) => e.type === "end")).toHaveLength(1);

    const final = emissions.at(-1)!.event;
    expect(final.bend.isActive).toBe(true);
    expect(final.bend.centsFromStart).toBeGreaterThan(180);
    expect(final.bend.centsFromStart).toBeLessThan(220);
    expect(final.bend.semitonesFromStart).toBeCloseTo(2, 0);
    // The label keeps the ORIGIN note; the excursion lives in `bend`.
    expect(final.label.name).toBe("A3");
  });

  it("splits a legato step of the same total interval into TWO events", () => {
    const tracker = new EventTracker(resolvePolicy({ mode: "lead" }));

    // D5 -> E5 is also 200 cents, but it JUMPS in one hop. Total displacement
    // cannot tell this apart from the bend above; only the per-hop rate can.
    const first = feed(tracker, 0, 15, D5, { onset: true });
    const second = feed(tracker, first.nextMs, 15, E5);
    const all = [...first.emissions, ...second.emissions, ...tracker.flush(second.nextMs)];

    expect(all.filter((e) => e.type === "start")).toHaveLength(2);
    const starts = all.filter((e) => e.type === "start");
    expect(starts[0]!.event.label.name).toBe("D5");
    expect(starts[1]!.event.label.name).toBe("E5");
    expect(starts.every((s) => s.event.bend.isActive === false)).toBe(true);
  });

  it("bridges a dropout shorter than releaseGraceMs", () => {
    const policy = resolvePolicy({ mode: "lead" });
    const tracker = new EventTracker(policy);

    const first = feed(tracker, 0, 20, B4, { onset: true });
    // 4 hops of silence = 48ms, well inside the 90ms grace.
    const gap = feed(tracker, first.nextMs, 4, null);
    const resumed = feed(tracker, gap.nextMs, 20, B4);
    const all = [...first.emissions, ...gap.emissions, ...resumed.emissions];

    expect(all.filter((e) => e.type === "end")).toHaveLength(0);
    expect(all.filter((e) => e.type === "start")).toHaveLength(1);
    expect(tracker.getActiveEvents()).toHaveLength(1);
  });

  it("ends the event when the dropout exceeds releaseGraceMs", () => {
    const tracker = new EventTracker(resolvePolicy({ mode: "lead" }));

    const first = feed(tracker, 0, 20, B4, { onset: true });
    const silenceStart = first.nextMs;
    // 10 hops = 120ms > 90ms grace.
    const gap = feed(tracker, silenceStart, 10, null);
    const all = [...first.emissions, ...gap.emissions];

    const ends = all.filter((e) => e.type === "end");
    expect(ends).toHaveLength(1);
    // The note ended when the sound stopped, not when the grace expired.
    expect(ends[0]!.event.endedAt).toBe(silenceStart);
    expect(tracker.getActiveEvents()).toHaveLength(0);
  });

  it("drops a blip shorter than minStableMs without emitting a start", () => {
    const tracker = new EventTracker(resolvePolicy({ mode: "lead" }));

    // 2 hops = 24ms, under the 45ms stability requirement.
    const blip = feed(tracker, 0, 2, A4, { onset: true });
    const gap = feed(tracker, blip.nextMs, 12, null);
    const all = [...blip.emissions, ...gap.emissions];

    expect(all.filter((e) => e.type === "start")).toHaveLength(0);
    expect(all.filter((e) => e.type === "end")).toHaveLength(0);
  });

  it("never emits an end without a matching start", () => {
    const tracker = new EventTracker(resolvePolicy({ mode: "lead" }));
    const emissions: TrackerEmission[] = [];

    // A deliberately chaotic sequence: blips, steps, dropouts, re-onsets.
    const pitches = [A4, null, A4, B4, null, null, D5, D5, null, E5, A4, null];
    let t = 0;
    for (let round = 0; round < 6; round++) {
      for (const hz of pitches) {
        emissions.push(...tracker.process(engineFrame(t, hz, { onset: round % 2 === 0 })));
        t += HOP_MS;
      }
    }
    emissions.push(...tracker.flush(t));

    const open = new Set<string>();
    for (const emission of emissions) {
      const id = emission.event.id;
      if (emission.type === "start") {
        expect(open.has(id)).toBe(false);
        open.add(id);
      } else {
        expect(open.has(id)).toBe(true);
        if (emission.type === "end") open.delete(id);
      }
    }
    expect(open.size).toBe(0);
  });

  it("resolves an unknown chord label in place rather than splitting", () => {
    const policy = resolvePolicy({ mode: "chords" });
    const tracker = new EventTracker(policy);
    const emissions: TrackerEmission[] = [];

    const withChord = (t: number, confident: boolean, label: string): EngineFrame => {
      const base = engineFrame(t, 130.81, { rms: 0.08 });
      return {
        ...base,
        chroma: {
          chroma: new Float32Array(12),
          bassPitchClass: 0,
          bassFrequencyHz: 130.81,
          salience: 0.8,
          polyphony: 3,
        },
        chord: {
          best: { label, root: "C", quality: "maj", score: confident ? 0.8 : 0.4 },
          alternatives: [{ label: "Am", root: "A", quality: "min", score: 0.35 }],
          isConfident: confident,
          margin: confident ? 0.2 : 0.05,
        },
      };
    };

    let t = 0;
    // The attack transient is unclassifiable...
    for (let i = 0; i < 12; i++) {
      emissions.push(...tracker.process(withChord(t, false, "C")));
      t += HOP_MS;
    }
    // ...then it resolves to C.
    for (let i = 0; i < 30; i++) {
      emissions.push(...tracker.process(withChord(t, true, "C")));
      t += HOP_MS;
    }
    emissions.push(...tracker.flush(t));

    expect(emissions.filter((e) => e.type === "start")).toHaveLength(1);
    // startedAt stays on the attack, which is what onset error measures.
    expect(emissions[0]!.event.startedAt).toBe(0);
    expect(emissions.at(-1)!.event.label.name).toBe("C");
    expect(emissions.at(-1)!.event.kind).toBe("chord");
  });

  it("names a chord event from its best evidence, not its most decayed frame", () => {
    // A guitar's third dies long before its root and fifth, so the tail of a Bm
    // reads as a bare B5. Labelling from the last hop hands the event the name
    // its own decay produced.
    const policy = resolvePolicy({ mode: "chords" });
    const tracker = new EventTracker(policy);
    const emissions: TrackerEmission[] = [];

    let t = 0;
    for (const [count, name, quality, score] of [
      [20, "Bm", "min", 0.86],
      // Shorter than `minStableMs`, so this is decay, not a chord change: it
      // must not split the event either.
      [8, "B5", "5", 0.93],
    ] as const) {
      for (let i = 0; i < count; i++) {
        const base = engineFrame(t, 246.94, { rms: 0.08 });
        emissions.push(
          ...tracker.process({
            ...base,
            chroma: {
              chroma: new Float32Array(12),
              bassPitchClass: 11,
              bassFrequencyHz: 246.94,
              salience: 0.8,
              polyphony: 3,
            },
            chord: {
              best: { label: name, root: "B", quality, score },
              alternatives: [],
              isConfident: true,
              margin: 0.2,
            },
          })
        );
        t += HOP_MS;
      }
    }
    emissions.push(...tracker.flush(t));

    expect(emissions.filter((e) => e.type === "start")).toHaveLength(1);
    // The decayed reading scores higher on the frames it owns, but twenty hops
    // of Bm outweigh eight of B5.
    expect(emissions.at(-1)!.event.label.name).toBe("Bm");
    expect(emissions.at(-1)!.event.label.quality).toBe("min");
  });

  it("stays unknown when the only confident reading is a single flash", () => {
    const tracker = new EventTracker(resolvePolicy({ mode: "chords" }));
    const emissions: TrackerEmission[] = [];

    const withChord = (t: number, confident: boolean): EngineFrame => {
      const base = engineFrame(t, 130.81, { rms: 0.08 });
      return {
        ...base,
        chroma: {
          chroma: new Float32Array(12),
          bassPitchClass: 0,
          bassFrequencyHz: 130.81,
          salience: 0.8,
          polyphony: 3,
        },
        chord: {
          best: { label: "C", root: "C", quality: "maj", score: confident ? 0.82 : 0.44 },
          alternatives: [{ label: "Am", root: "A", quality: "min", score: 0.4 }],
          isConfident: confident,
          margin: confident ? 0.2 : 0.04,
        },
      };
    };

    let t = 0;
    for (let i = 0; i < 20; i++) {
      // Two hops out of twenty cleared the margin rule, and they are the last
      // two — exactly where the old "label from the newest frame" rule would
      // have taken the event's name from. That is a flash, not a reading the
      // event can be named from.
      emissions.push(...tracker.process(withChord(t, i >= 18)));
      t += HOP_MS;
    }
    emissions.push(...tracker.flush(t));

    expect(emissions.at(-1)!.event.label.name).toBe("unknown");
  });

  it("reports unknown, with alternatives, when the chord margin rule fails", () => {
    const tracker = new EventTracker(resolvePolicy({ mode: "chords" }));
    const emissions: TrackerEmission[] = [];

    let t = 0;
    for (let i = 0; i < 40; i++) {
      const base = engineFrame(t, 130.81, { rms: 0.08 });
      emissions.push(
        ...tracker.process({
          ...base,
          chroma: {
            chroma: new Float32Array(12),
            bassPitchClass: 0,
            bassFrequencyHz: 130.81,
            salience: 0.6,
            polyphony: 5,
          },
          chord: {
            best: { label: "Cmaj9", root: "C", quality: "maj9", score: 0.58 },
            alternatives: [{ label: "Em", root: "E", quality: "min", score: 0.56 }],
            isConfident: false,
            margin: 0.02,
          },
        })
      );
      t += HOP_MS;
    }
    emissions.push(...tracker.flush(t));

    const final = emissions.at(-1)!.event;
    expect(final.label.name).toBe("unknown");
    // Abstaining is only useful if it shows its work.
    expect(final.ambiguity.alternatives?.map((a) => a.label)).toContain("Cmaj9");
    expect(final.ambiguity.alternatives?.map((a) => a.label)).toContain("Em");
  });
});
