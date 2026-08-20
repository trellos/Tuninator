import { describe, expect, it } from "vitest";
import { SampleClock } from "../../src/engine/clock.js";

describe("SampleClock", () => {
  it("derives ms from the sample index alone", () => {
    const clock = new SampleClock(48000);
    expect(clock.toMs(0)).toBe(0);
    expect(clock.toMs(48000)).toBe(1000);
    expect(clock.toMs(576)).toBeCloseTo(12, 6);
  });

  it("round-trips ms through sample indices", () => {
    const clock = new SampleClock(44100);
    for (const ms of [0, 12, 125, 1667, 20550]) {
      expect(clock.toMs(clock.toSamples(ms))).toBeCloseTo(ms, 1);
    }
  });

  it("never drifts across a long take", () => {
    // The whole point of integer sample indices: 20s of 12ms hops accumulated
    // as floats would drift, indexing cannot.
    const clock = new SampleClock(48000);
    const hop = 576;
    let index = 0;
    let summed = 0;
    for (let i = 0; i < 1667; i++) {
      index += hop;
      summed += (hop / 48000) * 1000;
    }
    expect(clock.toMs(index)).toBeCloseTo(summed, 6);
    expect(clock.toMs(index)).toBeCloseTo(20004, 3);
  });

  it("rounds a duration up to whole samples", () => {
    const clock = new SampleClock(48000);
    expect(clock.durationSamples(1)).toBe(48);
    expect(clock.durationSamples(0.001)).toBe(1);
  });

  it("rejects a nonsensical sample rate", () => {
    expect(() => new SampleClock(0)).toThrow(RangeError);
    expect(() => new SampleClock(Number.NaN)).toThrow(RangeError);
  });

  it("carries the host origin when it has one", () => {
    expect(new SampleClock(48000).timebase()).toEqual({ sampleRate: 48000 });
    expect(new SampleClock(48000, 3.5).timebase()).toEqual({
      sampleRate: 48000,
      originContextTime: 3.5,
    });
  });
});
