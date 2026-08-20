/**
 * The projection from Notes to the flat shape the eval matcher scores.
 *
 * Hand-built emission streams rather than real audio: the question here is
 * whether the *decision* about which of a Note's answers is "the" answer is
 * right, and mixing that with a detector's behaviour makes both untestable.
 */

import { describe, expect, it } from "vitest";
import { projectEmissions, kindOf, labelOf } from "../../src/offline/eval-adapter.js";
import type { TrackerEmission } from "../../src/engine/tracker/note-tracker.js";
import type { Note } from "../../src/types.js";

function note(overrides: Partial<Note> & { id: string }): Note {
  return {
    startTime: 0,
    endTime: null,
    lifecycle: "started",
    origin: { firstDetectedPitch: null, initialConfidence: 0.5, trigger: "attack" },
    pitch: { confidence: 0.5 },
    hypotheses: { active: [], trail: [] },
    revision: { lastChangeType: null, revisionNumber: 0 },
    confidence: 0.7,
    amplitude: { rms: 0.05 },
    ...overrides,
  };
}

function pitched(id: string, name: string, start: number, end: number | null): Note {
  return note({
    id,
    startTime: start,
    endTime: end,
    pitch: {
      confidence: 0.8,
      current: {
        midi: 69,
        name,
        pitchClass: "A",
        octave: 4,
        role: "first",
        confidence: 0.8,
      },
    },
  });
}

describe("labelOf / kindOf", () => {
  it("a Note with no harmony answers to its pitch, as a note", () => {
    const n = pitched("n1", "A4", 0, 100);
    expect(labelOf(n)).toBe("A4");
    expect(kindOf(n)).toBe("note");
  });

  it("a bloomed Note answers to its chord name, as a chord", () => {
    const n = note({ id: "n2", harmony: { chordName: "C", root: "C", quality: "maj" } });
    expect(labelOf(n)).toBe("C");
    expect(kindOf(n)).toBe("chord");
  });

  it("a Note that knows it is a chord but will not name one abstains", () => {
    // Honest abstention has to survive the projection intact: the matcher
    // scores "unknown" as an abstention, not as a wrong answer, and collapsing
    // it to a guess here would quietly turn a virtue into an error.
    const n = note({ id: "n3", harmony: { confidence: 0.3 } });
    expect(labelOf(n)).toBe("unknown");
    expect(kindOf(n)).toBe("chord");
  });

  it("falls back to the origin pitch when the current pitch is gone", () => {
    const n = note({
      id: "n4",
      origin: {
        firstDetectedPitch: {
          midi: 69, name: "A4", pitchClass: "A", octave: 4, role: "first", confidence: 0.8,
        },
        initialConfidence: 0.8,
        trigger: "attack",
      },
    });
    expect(labelOf(n)).toBe("A4");
  });
});

describe("projectEmissions", () => {
  it("produces one final detection per ended Note, in start order", () => {
    const emissions: TrackerEmission[] = [
      { type: "started", note: pitched("n2", "B4", 500, null) },
      { type: "started", note: pitched("n1", "A4", 100, null) },
      { type: "ended", note: pitched("n1", "A4", 100, 400) },
      { type: "ended", note: pitched("n2", "B4", 500, 900) },
    ];
    const { final } = projectEmissions(emissions);
    expect(final.map((d) => d.id)).toEqual(["n1", "n2"]);
    expect(final.map((d) => d.label.name)).toEqual(["A4", "B4"]);
    expect(final[0]?.endedAt).toBe(400);
  });

  it("the fast projection keeps the label the Note started with", () => {
    const emissions: TrackerEmission[] = [
      { type: "started", note: pitched("n1", "A4", 100, null) },
      {
        type: "changed",
        note: pitched("n1", "A#4", 100, null),
        change: { type: "pitchCorrection", at: 200, revisionNumber: 1 },
      },
      { type: "ended", note: pitched("n1", "A#4", 100, 400) },
    ];
    const { fast, final, revisions } = projectEmissions(emissions);
    expect(fast[0]?.label.name).toBe("A4");
    expect(final[0]?.label.name).toBe("A#4");
    expect(revisions.corrected).toBe(1);
    expect(revisions.changes).toBe(1);
  });

  it("both projections span the same timeline, so only the labels differ", () => {
    const emissions: TrackerEmission[] = [
      { type: "started", note: pitched("n1", "A4", 100, null) },
      { type: "ended", note: pitched("n1", "A4", 100, 400) },
    ];
    const { fast, final } = projectEmissions(emissions);
    expect(fast[0]?.startedAt).toBe(final[0]?.startedAt);
    expect(fast[0]?.endedAt).toBe(final[0]?.endedAt);
  });

  it("drops a fast detection for a Note that never ended", () => {
    const emissions: TrackerEmission[] = [
      { type: "started", note: pitched("n1", "A4", 100, null) },
    ];
    const { fast, final } = projectEmissions(emissions);
    expect(final).toHaveLength(0);
    expect(fast).toHaveLength(0);
  });

  it("measures how long a Note took to reach the answer it kept", () => {
    const emissions: TrackerEmission[] = [
      { type: "started", note: pitched("n1", "A4", 100, null) },
      {
        type: "changed",
        note: pitched("n1", "B4", 100, null),
        change: { type: "pitchCorrection", at: 260, revisionNumber: 1 },
      },
      { type: "ended", note: pitched("n1", "B4", 100, 500) },
    ];
    const { revisions } = projectEmissions(emissions);
    expect(revisions.timeToFinalLabelMs).toEqual([160]);
  });
});
