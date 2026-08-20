/**
 * The hypothesis trail.
 *
 * The old surface had a flat `alternatives` list rebuilt from whatever the
 * newest frame saw, which could not answer the question a player actually asks
 * when they disagree with the answer: "did you consider X?" Nothing remembered
 * that X had been leading 200ms ago and then lost.
 *
 * So the properties under test are about *history*, not about ranking: that a
 * reading accumulates support over time, that losing is recorded rather than
 * forgotten, and that a hypothesis which was folded into a larger explanation
 * is distinguishable from one that was simply wrong.
 */

import { describe, expect, it } from "vitest";
import { StatefulHypothesisTracker } from "../../src/engine/tracker/hypotheses.js";
import { isHarmonyEnrichment, classifyPitchChange } from "../../src/engine/tracker/revision.js";

function tracker(): StatefulHypothesisTracker {
  return new StatefulHypothesisTracker("n1");
}

describe("promotion by support, not by a single frame", () => {
  it("a reading seen once is only a candidate", () => {
    const h = tracker();
    h.observe("pitch", "A4", 0.9, 0);
    h.settle("pitch", 0);
    const active = h.snapshot().active;
    expect(active).toHaveLength(1);
    expect(active[0]?.state).toBe("leading");
    expect(active[0]?.label).toBe("A4");
  });

  it("a long-supported reading outranks a briefly-brilliant one", () => {
    // The point of accumulating support: a reading that has been climbing for
    // 300ms and one that appeared this hop are not equally believable, even at
    // identical instantaneous confidence.
    const h = tracker();
    for (let i = 0; i < 10; i++) h.observe("pitch", "A4", 0.6, i * 12);
    h.observe("pitch", "A#4", 0.99, 120);
    h.settle("pitch", 120);
    expect(h.leader("pitch")?.label).toBe("A4");
  });

  it("confirms a leader that has held a clear margin", () => {
    const h = tracker();
    for (let i = 0; i < 20; i++) h.observe("pitch", "A4", 0.9, i * 12);
    h.settle("pitch", 240);
    expect(h.leader("pitch")?.state).toBe("confirmed");
  });

  it("will not confirm a leader a rival is level with", () => {
    const h = tracker();
    for (let i = 0; i < 20; i++) {
      h.observe("pitch", "A4", 0.9, i * 12);
      h.observe("pitch", "A#4", 0.9, i * 12);
    }
    h.settle("pitch", 240);
    expect(h.leader("pitch")?.state).toBe("leading");
  });

  it("remembers the best a hypothesis ever did, not just where it ended", () => {
    const h = tracker();
    h.observe("pitch", "A4", 0.95, 0);
    h.observe("pitch", "A4", 0.2, 12);
    h.settle("pitch", 12);
    const leader = h.leader("pitch");
    expect(leader?.confidence).toBeCloseTo(0.2, 5);
    expect(leader?.peakConfidence).toBeCloseTo(0.95, 5);
  });

  it("dates a hypothesis from when it was first seen", () => {
    const h = tracker();
    h.observe("pitch", "A4", 0.8, 100);
    h.observe("pitch", "A4", 0.8, 400);
    h.settle("pitch", 400);
    const leader = h.leader("pitch");
    expect(leader?.firstSeenAt).toBe(100);
    expect(leader?.lastUpdatedAt).toBe(400);
  });
});

describe("the trail", () => {
  it("keeps losers rather than deleting them", () => {
    const h = tracker();
    for (const label of ["A4", "A#4", "B4", "C5", "C#5", "D5"]) {
      for (let i = 0; i < 3; i++) h.observe("pitch", label, 0.5, i * 12);
    }
    h.settle("pitch", 100);
    const snapshot = h.snapshot();
    expect(snapshot.active.length).toBeLessThanOrEqual(4);
    expect(snapshot.trail.length).toBeGreaterThan(0);
    expect(snapshot.trail.every((entry) => entry.state === "discredited")).toBe(true);
  });

  it("records what superseded a reading, so a correction can be followed", () => {
    const h = tracker();
    h.observe("harmony", "C", 0.7, 0);
    h.observe("harmony", "Cmaj7", 0.8, 100);
    h.supersede("harmony", "C", "Cmaj7", 100);
    const { active, trail } = h.snapshot();
    const superseded = trail.find((entry) => entry.label === "C");
    expect(superseded?.state).toBe("superseded");
    expect(superseded?.resolvedInto).toBe(active.find((a) => a.label === "Cmaj7")?.id);
  });

  it("distinguishes being folded in from being wrong", () => {
    // "E3" inside "C:maj" was never a mistake; it was part of the answer. A
    // consumer showing the recognizer's reasoning has to be able to say so.
    const h = tracker();
    h.observe("pitch", "E3", 0.8, 0);
    h.observe("harmony", "C", 0.8, 50);
    h.incorporate("pitch", "E3", "C", 50);
    const { trail } = h.snapshot();
    const folded = trail.find((entry) => entry.label === "E3");
    expect(folded?.state).toBe("incorporated");
    expect(folded?.resolvedInto).toBeDefined();
  });

  it("gives every hypothesis a stable id derived from its Note", () => {
    const h = tracker();
    h.observe("pitch", "A4", 0.8, 0);
    const first = h.leader("pitch")?.id;
    h.observe("pitch", "A4", 0.9, 12);
    expect(h.leader("pitch")?.id).toBe(first);
    expect(first?.startsWith("n1-")).toBe(true);
  });

  it("keeps pitch and harmony hypotheses in separate races", () => {
    const h = tracker();
    for (let i = 0; i < 5; i++) h.observe("pitch", "C3", 0.9, i * 12);
    h.observe("harmony", "C", 0.4, 60);
    h.settle("pitch", 60);
    h.settle("harmony", 60);
    expect(h.leader("pitch")?.label).toBe("C3");
    expect(h.leader("harmony")?.label).toBe("C");
  });

  it("reports transitions so a consumer never has to diff snapshots", () => {
    const h = tracker();
    h.observe("pitch", "A4", 0.9, 0);
    const first = h.settle("pitch", 0);
    expect(first.map((t) => [t.hypothesis.label, t.from, t.to])).toEqual([["A4", "candidate", "leading"]]);
    // Settling again with nothing new must not manufacture a transition.
    expect(h.settle("pitch", 12)).toEqual([]);
  });
});

describe("classifying a revision", () => {
  it("treats a more specific chord over the same root as enrichment", () => {
    expect(isHarmonyEnrichment("C", "maj", "C", "maj7")).toBe(true);
    expect(isHarmonyEnrichment("C", "maj7", "C", "maj9")).toBe(true);
    expect(isHarmonyEnrichment("A", "5", "A", "min")).toBe(true);
  });

  it("treats a different root or a contradicted quality as a correction", () => {
    expect(isHarmonyEnrichment("C", "maj", "A", "min")).toBe(false);
    expect(isHarmonyEnrichment("C", "maj7", "C", "min")).toBe(false);
    // Going the other way is losing information, not gaining it.
    expect(isHarmonyEnrichment("C", "maj9", "C", "maj7")).toBe(false);
  });

  it("separates a sharper answer from a different one", () => {
    expect(classifyPitchChange("A4", "A4", false)).toBe("pitchRefinement");
    expect(classifyPitchChange("A4", "A#4", false)).toBe("pitchCorrection");
    // Mid-bend a changing pitch is the Note doing what it is for.
    expect(classifyPitchChange("A4", "B4", true)).toBe("pitchMovement");
  });
});
