/**
 * The live pace estimator.
 *
 * The two defects that sank the earlier attempts are both properties of this
 * class rather than of the gate it feeds, so they are the first two tests: a
 * pace read from transients rather than strokes inverts, and a pace carried
 * across a rest describes the phrase before it. Both are asserted against a
 * handwritten sequence with no audio in sight.
 */

import { describe, expect, it } from "vitest";
import { PaceEstimator, type PaceOptions } from "../../src/engine/tracker/pace.js";

const OPTIONS: PaceOptions = {
  ringSize: 8,
  quantile: 0.25,
  minIntervalMs: 60,
  silenceResetMs: 1500,
  minGaps: 3,
};

/** Strokes every `everyMs`, `count` of them, starting at `from`. */
function strokes(pace: PaceEstimator, everyMs: number, count: number, from = 0): number {
  let at = from;
  for (let i = 0; i < count; i++) {
    pace.feed(at);
    at += everyMs;
  }
  return at - everyMs;
}

describe("having an opinion at all", () => {
  it("says nothing until three gaps are in hand", () => {
    const pace = new PaceEstimator(OPTIONS);
    expect(pace.paceMs()).toBeNull();
    pace.feed(0);
    expect(pace.paceMs()).toBeNull();
    pace.feed(250);
    pace.feed(500);
    expect(pace.paceMs()).toBeNull();
    pace.feed(750);
    expect(pace.paceMs()).toBe(250);
  });

  it("reads an even passage at its true stroke length", () => {
    const pace = new PaceEstimator(OPTIONS);
    strokes(pace, 250, 6);
    expect(pace.paceMs()).toBe(250);
  });
});

describe("the two defects that sank the earlier attempts", () => {
  it("is not fooled by a slower passage read at a faster one's rate", () => {
    // 197ms per note must not read as faster than 105ms per note. The first
    // attempt inverted exactly this pair, because it was fed every transient.
    const slow = new PaceEstimator(OPTIONS);
    strokes(slow, 197, 8);
    const fast = new PaceEstimator(OPTIONS);
    strokes(fast, 105, 8);
    const slowMs = slow.paceMs();
    const fastMs = fast.paceMs();
    expect(slowMs).not.toBeNull();
    expect(fastMs).not.toBeNull();
    expect(slowMs as number).toBeGreaterThan(fastMs as number);
  });

  it("forgets a pace across a rest rather than carrying it", () => {
    const pace = new PaceEstimator(OPTIONS);
    strokes(pace, 250, 6);
    expect(pace.paceMs()).toBe(250);
    pace.observe(1250 + OPTIONS.silenceResetMs + 1);
    expect(pace.paceMs()).toBeNull();
  });

  it("forgets it on the far side of the rest too, when a stroke is what reveals it", () => {
    const pace = new PaceEstimator(OPTIONS);
    const last = strokes(pace, 250, 6);
    pace.feed(last + OPTIONS.silenceResetMs + 100);
    expect(pace.paceMs()).toBeNull();
  });
});

describe("what counts as a gap, and why the caller must feed bursts", () => {
  it("reads the true stroke length when fed once per burst", () => {
    // What `NoteTracker` does: one feed per burst, at the burst's FIRST attack.
    const pace = new PaceEstimator(OPTIONS);
    strokes(pace, 250, 6);
    expect(pace.paceMs()).toBe(250);
  });

  it("cannot recover the stroke length from every transient, which is why it is not fed them", () => {
    // A pick crossing six strings, fed wrongly. The minIntervalMs filter keeps
    // this from collapsing to 8ms — the first attempt's inversion — but it
    // cannot reconstruct the burst start, so the gap it sees runs from the LAST
    // transient of one stroke to the first of the next and reads short. The
    // filter is a safety net, not a substitute for the burst feed.
    const pace = new PaceEstimator(OPTIONS);
    let at = 0;
    for (let i = 0; i < 6; i++) {
      pace.feed(at);
      pace.feed(at + 8);
      pace.feed(at + 19);
      at += 250;
    }
    const reading = pace.paceMs() as number;
    expect(reading).toBeGreaterThan(19);
    expect(reading).toBeLessThan(250);
  });

  it("does not treat a sub-articulation gap as a reset", () => {
    const pace = new PaceEstimator(OPTIONS);
    strokes(pace, 250, 5);
    pace.feed(1000 + 10);
    expect(pace.paceMs()).toBe(250);
  });
});

describe("the quantile, and why it is low", () => {
  it("leans toward the FASTER readings in a mixed passage", () => {
    // Reading slow merges notes somebody played; reading fast only declines
    // merges. So a mixed passage must not report its slow half.
    const mixed = new PaceEstimator(OPTIONS);
    let at = 0;
    for (const gap of [125, 125, 125, 125, 500, 500, 500, 500]) {
      mixed.feed(at);
      at += gap;
    }
    mixed.feed(at);
    const reading = mixed.paceMs();
    expect(reading).not.toBeNull();
    expect(reading as number).toBeLessThanOrEqual(250);
  });

  it("holds only the most recent strokes, so a tempo change is followed", () => {
    const pace = new PaceEstimator(OPTIONS);
    const last = strokes(pace, 500, 9);
    expect(pace.paceMs()).toBe(500);
    strokes(pace, 125, 9, last + 125);
    expect(pace.paceMs()).toBe(125);
  });
});

describe("reset", () => {
  it("drops every held gap", () => {
    const pace = new PaceEstimator(OPTIONS);
    strokes(pace, 250, 6);
    pace.reset();
    expect(pace.paceMs()).toBeNull();
  });
});
