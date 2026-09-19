/**
 * The rate gate's two witnesses, on vectors read off the corpus.
 *
 * A Note opened by a same-pitch re-articulation is held back from announcement
 * for a fraction of the local interval when the boundary under it looks
 * invented. Two shapes look invented, and the recordings they were read on
 * are named beside each vector: a boundary with no envelope dip under it
 * (`tracking.rateFragmentDipRatio`), and one over which no energy arrived
 * (`tracking.rateFragmentNoRiseRatio`). Every number below was measured by
 * running the engine over the recording named, so a change that moves the
 * verdict is a change to what the recognizer believes about real audio.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG } from "../../src/engine/config.js";
import { rateFragmentSpanFraction } from "../../src/engine/tracker/note-tracker.js";

const bars = DEFAULT_ENGINE_CONFIG.tracking;

describe("a same-pitch boundary over which no energy arrived", () => {
  // Emitted fragments on `same-pitch-eighths-sixteenths-e5-120bpm-di`, each a
  // piece of one played eighth: [riseRatio, dipRatio, ms it sounded, local
  // interval]. None dipped far enough for the dip form to see it.
  const fragments: Array<[number, number, number, number]> = [
    [0.79, 0.53, 67, 213],
    [0.63, 0.74, 107, 229],
    [0.77, 0.64, 67, 160],
    [0.68, 0.6, 93, 200],
    [0.57, 0.55, 80, 227],
  ];

  it.each(fragments)("holds a fragment %#", (rise, dip, soundedMs, ioi) => {
    expect(dip).toBeLessThan(bars.rateFragmentDipRatio);
    const fraction = rateFragmentSpanFraction(dip, rise, bars);
    expect(fraction).toBe(bars.rateFragmentNoRiseSpanFraction);
    // The bar it sets is longer than the fragment lived, so `end()` drops it.
    expect((fraction as number) * ioi).toBeGreaterThan(soundedMs);
  });

  it("is a different witness from the dip: a deep dip means a pick made contact", () => {
    // Real re-picks on `same-pitch-eighths-a3-120bpm-di` whose rise the 80ms
    // baseline under-reads, because the note before was still loud. The dip
    // under each is the contact damping a pick leaves.
    expect(rateFragmentSpanFraction(0.17, 0.75, bars)).toBeNull();
    expect(rateFragmentSpanFraction(0.28, 0.78, bars)).toBeNull();
  });

  it("lets a real re-pick through on the rise alone", () => {
    // `held-then-picked-six-strings-120bpm-di`: the string re-picked after a
    // long hold. Energy arrived, whatever the dip reads.
    expect(rateFragmentSpanFraction(0.16, 2.69, bars)).toBeNull();
    expect(rateFragmentSpanFraction(0.73, 0.88, bars)).toBeNull();
    expect(rateFragmentSpanFraction(0.12, 1.86, bars)).toBeNull();
  });
});

describe("the two witnesses together", () => {
  it("a boundary with no dip keeps the shipped bar", () => {
    expect(rateFragmentSpanFraction(0.9, 1.3, bars)).toBe(bars.rateFragmentSpanFraction);
  });

  it("a boundary that fails both takes the longer bar", () => {
    // `same-pitch-eighths-a3-120bpm-di`: a 93ms fragment at 0.78 rise with no
    // dip at all under it.
    expect(rateFragmentSpanFraction(1.0, 0.78, bars)).toBe(
      Math.max(bars.rateFragmentSpanFraction, bars.rateFragmentNoRiseSpanFraction)
    );
  });

  it("says nothing when nothing split at the same pitch", () => {
    expect(rateFragmentSpanFraction(null, null, bars)).toBeNull();
    expect(rateFragmentSpanFraction(null, 0.5, bars)).toBeNull();
  });

  it("is inert when the no-rise bar is off", () => {
    const off = { ...bars, rateFragmentNoRiseRatio: 0 };
    expect(rateFragmentSpanFraction(0.64, 0.77, off)).toBeNull();
    expect(rateFragmentSpanFraction(0.9, 0.77, off)).toBe(bars.rateFragmentSpanFraction);
  });
});
