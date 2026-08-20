/**
 * What the tracker does with a verdict about a span of audio.
 *
 * The deep lane's old contract could only improve a Note that already existed,
 * so reconciliation was not a thing that could go wrong. A segmentation says
 * how many events a region contained, which means it can disagree with the
 * Notes already emitted — and every way of disagreeing has to be handled
 * without rewriting history: a Note may be cut in two, several may turn out to
 * be one, an event nobody emitted may be inserted, and a Note that has already
 * been let go may still be renamed.
 *
 * Driven by handwritten segmentations rather than by audio on purpose. Whether
 * a boundary is really there is `resegment.test.ts`'s question; this file is
 * about what the tracker does once it has been told.
 */

import { describe, expect, it } from "vitest";
import { SampleClock } from "../../src/engine/clock.js";
import { DEFAULT_ENGINE_CONFIG, RENDER_QUANTUM, type EngineConfig } from "../../src/engine/config.js";
import { RecognitionEngine } from "../../src/engine/engine.js";
import type {
  DeepSegmentation,
  FastFrame,
  PitchActivation,
  RegionSegment,
} from "../../src/engine/contracts.js";
import { NoteTracker, type TrackerEmission } from "../../src/engine/tracker/note-tracker.js";
import { midiToFrequency, midiToOctave, midiToPitchClass } from "../../src/engine/kernels/notes.js";

const SAMPLE_RATE = 48000;
const HOP = 640;
const HOP_MS = (HOP / SAMPLE_RATE) * 1000;

function config(overrides: Partial<EngineConfig["deep"]> = {}): EngineConfig {
  return {
    ...DEFAULT_ENGINE_CONFIG,
    deep: { ...DEFAULT_ENGINE_CONFIG.deep, ...overrides },
  };
}

function frame(
  index: number,
  options: { midi: number | null; rms?: number; attack?: boolean }
): FastFrame {
  const at = index * HOP_MS;
  const sampleIndex = index * HOP;
  const rms = options.rms ?? 0.05;
  const hz = options.midi === null ? null : midiToFrequency(options.midi);
  return {
    sampleIndex,
    at,
    pitch: {
      frequencyHz: hz,
      confidence: hz === null ? 0 : 0.95,
      nearest:
        options.midi === null
          ? null
          : {
              midi: options.midi,
              name: `${midiToPitchClass(options.midi)}${midiToOctave(options.midi)}`,
              pitchClass: midiToPitchClass(options.midi),
              octave: midiToOctave(options.midi),
              frequencyHz: midiToFrequency(options.midi),
              cents: 0,
            },
      tau: null,
      cmnd: null,
      zeroCrossingHz: null,
      source: "long",
    },
    rms,
    peak: rms * 2,
    gated: rms < DEFAULT_ENGINE_CONFIG.analysis.rmsGate,
    attack:
      options.attack === true
        ? {
            at,
            atSample: sampleIndex,
            flux: true,
            fluxValue: 0.4,
            envelope: true,
            riseRatio: 3,
            sharpness: 0.6,
            fluxRatio: 2,
            strength: 0.9,
          }
        : null,
    riseRatio: 1,
    bandOnset: false,
    hop: index,
  };
}

function activation(midi: number, salience = 1): PitchActivation {
  return {
    frequencyHz: midiToFrequency(midi),
    midi,
    pitchClass: midiToPitchClass(midi),
    octave: midiToOctave(midi),
    salience,
    confidence: 0.9,
  };
}

function segment(
  fromMs: number,
  toMs: number,
  midi: number,
  boundary: RegionSegment["boundary"]
): RegionSegment {
  return {
    fromSample: Math.round((fromMs / 1000) * SAMPLE_RATE),
    toSample: Math.round((toMs / 1000) * SAMPLE_RATE),
    from: fromMs,
    to: toMs,
    dominantMidi: midi,
    activations: [activation(midi)],
    reading: {
      root: null,
      quality: null,
      chordName: null,
      bass: null,
      intervals: [],
      confidence: 0.3,
      alternatives: [],
      isConfident: false,
    },
    windows: 6,
    confidence: 0.5,
    boundary,
  };
}

function segmentation(segments: readonly RegionSegment[]): DeepSegmentation {
  const first = segments[0] as RegionSegment;
  const last = segments[segments.length - 1] as RegionSegment;
  return {
    fromSample: first.fromSample,
    toSample: last.toSample,
    from: first.from,
    to: last.to,
    segments: [...segments],
    windowCount: segments.length * 6,
    confidence: 0.5,
  };
}

/**
 * A tracker holding one finished Note per entry, still waiting on a verdict.
 *
 * The Notes are built by feeding the tracker frames, so they are ordinary Notes
 * with ordinary vote tallies — not fixtures shaped to make the assertion pass.
 */
function trackerWithNotes(
  events: ReadonlyArray<{ midi: number; hops: number; attackAt?: number }>,
  options: Partial<EngineConfig["deep"]> = {}
): { tracker: NoteTracker; emissions: TrackerEmission[] } {
  const tracker = new NoteTracker(new SampleClock(SAMPLE_RATE), config(options));
  const emissions: TrackerEmission[] = [];
  let index = 0;
  const feed = (o: Parameters<typeof frame>[1], count: number): void => {
    for (let i = 0; i < count; i++) {
      for (const emission of tracker.process(frame(index++, o))) emissions.push(emission);
    }
  };

  events.forEach((event, position) => {
    for (let i = 0; i < event.hops; i++) {
      feed({ midi: event.midi, attack: i === 0 || i === event.attackAt }, 1);
    }
    // A gap short enough to be one gesture, long enough that the release grace
    // closes the Note — which is how the fast lane over-segments in the first
    // place.
    if (position < events.length - 1) feed({ midi: null, rms: 0 }, 8);
  });
  feed({ midi: null, rms: 0 }, 16);
  return { tracker, emissions };
}

describe("a boundary the fast lane missed", () => {
  it("cuts the Note in two and announces that it did", () => {
    const { tracker } = trackerWithNotes([{ midi: 74, hops: 40 }]);
    const out = tracker.applySegmentation(
      segmentation([
        segment(0, 250, 74, "regionStart"),
        segment(250, 600, 69, "pitchChange"),
      ])
    );
    const revision = out.find(
      (e) => e.type === "changed" && e.change.type === "structuralRevision"
    );
    expect(revision).toBeDefined();
    if (revision?.type !== "changed") throw new Error("unreachable");
    // The opposite claim from an absorption, on the same field.
    expect(revision.change.relation).toBe("split");
    expect(revision.change.relatedNoteIds).toHaveLength(1);
  });

  it("announces the new Note before it ends it, backdated onto the boundary", () => {
    const { tracker } = trackerWithNotes([{ midi: 74, hops: 40 }]);
    const out = tracker.applySegmentation(
      segmentation([
        segment(0, 250, 74, "regionStart"),
        segment(250, 600, 69, "pitchChange"),
      ])
    );
    const started = out.find((e) => e.type === "started");
    expect(started).toBeDefined();
    expect(started?.note.startTime).toBeCloseTo(250, 0);
    // A consumer must never see a Note finish it was never told about.
    const released: TrackerEmission[] = [];
    tracker.releaseClosed(new Set<string>(), released);
    const ends = released.filter((e) => e.type === "ended").map((e) => e.note.id);
    expect(ends).toContain(started?.note.id);
  });

  it("leaves the original ending where the second event began", () => {
    const { tracker } = trackerWithNotes([{ midi: 74, hops: 40 }]);
    tracker.applySegmentation(
      segmentation([
        segment(0, 250, 74, "regionStart"),
        segment(250, 600, 69, "pitchChange"),
      ])
    );
    const released: TrackerEmission[] = [];
    tracker.releaseClosed(new Set<string>(), released);
    const ended = released.filter((e) => e.type === "ended").map((e) => e.note);
    const original = ended.find((n) => n.id === "n1");
    expect(original?.endTime).toBeCloseTo(250, 0);
  });

  it("will not cut a Note where the name would not change", () => {
    // A C#5 cut in two, both halves called C#5, is fragmentation whatever the
    // transform saw in between.
    const { tracker } = trackerWithNotes([{ midi: 74, hops: 40 }]);
    const out = tracker.applySegmentation(
      segmentation([
        segment(0, 250, 74, "regionStart"),
        segment(250, 600, 86, "pitchChange"),
      ])
    );
    expect(out.filter((e) => e.type === "started")).toHaveLength(0);
  });

  it("re-articulates only where the fast lane saw energy arrive", () => {
    // Same pitch on both sides, which is the case no spectrum can ever settle:
    // a D5 picked twice is D5 throughout. The region's envelope witness
    // proposes and the fast lane's transient confirms, and neither is enough
    // on its own — which is why the fast lane, which saw this transient and
    // declined to act on it, still left one Note here.
    const boundaryMs = 20 * HOP_MS;
    const proposal = segmentation([
      segment(0, boundaryMs, 74, "regionStart"),
      segment(boundaryMs, 700, 74, "energyRise"),
    ]);

    const heard = trackerWithNotes([{ midi: 74, hops: 40, attackAt: 20 }]);
    expect(heard.tracker.applySegmentation(proposal).length).toBeGreaterThan(0);

    const unheard = trackerWithNotes([{ midi: 74, hops: 40 }]);
    expect(unheard.tracker.applySegmentation(proposal)).toHaveLength(0);
  });
});

describe("a region the fast lane over-segmented", () => {
  it("absorbs the extra Notes into the one event the region found", () => {
    const events = [
      { midi: 74, hops: 14 },
      { midi: 74, hops: 14 },
      { midi: 74, hops: 14 },
    ];
    const { tracker } = trackerWithNotes(events, { regionMerge: true });
    const out = tracker.applySegmentation(
      segmentation([segment(0, 1000, 74, "regionStart")])
    );
    const revision = out.find(
      (e) => e.type === "changed" && e.change.type === "structuralRevision"
    );
    expect(revision).toBeDefined();
    if (revision?.type !== "changed") throw new Error("unreachable");
    expect(revision.change.relation).toBe("absorbed");
    expect((revision.change.relatedNoteIds ?? []).length).toBeGreaterThan(0);
    // The survivor now spans what it swallowed.
    expect(revision.note.endTime).toBeGreaterThan(30 * HOP_MS);
  });

  it("does not absorb anything while merging is switched off", () => {
    // Off by default, and measured: see `deep.regionMerge`.
    const { tracker } = trackerWithNotes([
      { midi: 74, hops: 14 },
      { midi: 74, hops: 14 },
    ]);
    const out = tracker.applySegmentation(
      segmentation([segment(0, 1000, 74, "regionStart")])
    );
    expect(
      out.filter((e) => e.type === "changed" && e.change.type === "structuralRevision")
    ).toHaveLength(0);
  });
});

describe("a Note that has already ended", () => {
  it("can still be corrected", () => {
    // Its extent is history and cannot be rewritten, but its name is a belief,
    // and a lane allowed to be late may arrive after the fact knowing better.
    const { tracker } = trackerWithNotes([{ midi: 74, hops: 30 }], {
      regionCorrectPitch: true,
    });
    const released: TrackerEmission[] = [];
    tracker.releaseClosed(new Set<string>(), released, true);
    expect(released.some((e) => e.type === "ended")).toBe(true);

    const out = tracker.applySegmentation(
      segmentation([segment(0, 600, 69, "regionStart")])
    );
    const correction = out.find(
      (e) => e.type === "changed" && e.change.type === "pitchCorrection"
    );
    expect(correction).toBeDefined();
    if (correction?.type !== "changed") throw new Error("unreachable");
    expect(correction.note.pitch.current?.name).toBe("A4");
    expect(correction.change.previous?.label).toBe("D5");
    // History stands: the Note still ended where it ended.
    expect(correction.note.endTime).not.toBeNull();
  });

  it("is left alone while correction is switched off", () => {
    const { tracker } = trackerWithNotes([{ midi: 74, hops: 30 }]);
    tracker.releaseClosed(new Set<string>(), [], true);
    const out = tracker.applySegmentation(
      segmentation([segment(0, 600, 69, "regionStart")])
    );
    expect(out.filter((e) => e.type === "changed")).toHaveLength(0);
  });
});

describe("determinism", () => {
  it("produces the identical emission stream on every replay", () => {
    // The offline scheduler is what makes an eval number mean anything, and
    // region work reaches back over Notes that have already been reported on —
    // exactly the shape that goes non-deterministic first.
    const signal = new Float32Array(SAMPLE_RATE * 2);
    const events = [
      { hz: 587.33, from: 0.1, to: 0.35 },
      { hz: 587.33, from: 0.4, to: 0.7 },
      { hz: 440, from: 0.75, to: 1.1 },
      { hz: 493.88, from: 1.15, to: 1.6 },
    ];
    for (const event of events) {
      const start = Math.round(event.from * SAMPLE_RATE);
      const end = Math.round(event.to * SAMPLE_RATE);
      const period = SAMPLE_RATE / event.hz;
      for (let i = start; i < end; i++) {
        const decay = Math.exp(-(i - start) / (0.25 * SAMPLE_RATE));
        signal[i] = 0.4 * decay * (2 * (((i - start) % period) / period) - 1);
      }
    }

    const once = (): string => {
      const engine = new RecognitionEngine(SAMPLE_RATE, DEFAULT_ENGINE_CONFIG);
      const emissions: TrackerEmission[] = [];
      for (let offset = 0; offset < signal.length; offset += RENDER_QUANTUM) {
        const block = new Float32Array(RENDER_QUANTUM);
        block.set(signal.subarray(offset, Math.min(offset + RENDER_QUANTUM, signal.length)));
        emissions.push(...engine.processChunk(block, offset).emissions);
      }
      emissions.push(...engine.flush().emissions);
      return JSON.stringify(
        emissions.map((e) => [e.type, e.note.id, e.note.startTime, e.note.endTime])
      );
    };

    const reference = once();
    for (let i = 0; i < 4; i++) expect(once()).toBe(reference);
  });

  it("never lets a Note finish before the region it lives in has been ruled on", () => {
    // The hold is what makes the whole thing possible: once a Note is gone from
    // `closing` there is nothing left to correct.
    const signal = new Float32Array(SAMPLE_RATE);
    const period = SAMPLE_RATE / 440;
    for (let i = 0; i < SAMPLE_RATE / 2; i++) {
      signal[i] = 0.4 * Math.exp(-i / (0.3 * SAMPLE_RATE)) * (2 * ((i % period) / period) - 1);
    }
    const engine = new RecognitionEngine(SAMPLE_RATE, DEFAULT_ENGINE_CONFIG);
    const ended: string[] = [];
    for (let offset = 0; offset < signal.length; offset += RENDER_QUANTUM) {
      const block = new Float32Array(RENDER_QUANTUM);
      block.set(signal.subarray(offset, Math.min(offset + RENDER_QUANTUM, signal.length)));
      for (const emission of engine.processChunk(block, offset).emissions) {
        if (emission.type === "ended") ended.push(emission.note.id);
      }
    }
    for (const emission of engine.flush().emissions) {
      if (emission.type === "ended") ended.push(emission.note.id);
    }
    expect(ended.length).toBeGreaterThan(0);
    expect(engine.droppedDeepRegionCount).toBe(0);
  });
});
