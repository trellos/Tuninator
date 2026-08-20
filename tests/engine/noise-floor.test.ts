/**
 * What the amplitude gate is measured against.
 *
 * `analysis.rmsGate` was a fixed level, and a fixed level means a different
 * thing on every rig: across the corpus 0.008 stands 20-53x above the five
 * 120bpm takes' fifth-percentile frame RMS, 97-126x above a direct input's and
 * 3.9-4.2x above a room mic's. These are the properties the replacement has to
 * have, stated against handwritten sequences rather than against a recording.
 */

import { describe, expect, it } from "vitest";
import { NoiseFloorTracker } from "../../src/engine/fast/noise-floor.js";

function tracker(): NoiseFloorTracker {
  return new NoiseFloorTracker({ quantile: 0.05, rate: 0.02, minimum: 1e-5 });
}

/** Feed `count` hops of a level and hand back the estimate. */
function settle(t: NoiseFloorTracker, level: number, count: number): number {
  let floor = t.floor;
  for (let i = 0; i < count; i++) floor = t.observe(level);
  return floor;
}

describe("NoiseFloorTracker", () => {
  it("converges on a steady level", () => {
    const t = tracker();
    expect(settle(t, 3e-4, 2000)).toBeCloseTo(3e-4, 6);
  });

  it("finds the floor of a signal that is mostly loud", () => {
    // A take with no silence in it at all: playing at 0.05 nineteen hops out of
    // twenty and dropping to 4e-4 between notes. The floor is the quiet part.
    const t = tracker();
    let floor = t.floor;
    for (let i = 0; i < 40000; i++) floor = t.observe(i % 20 === 0 ? 4e-4 : 0.05);
    expect(floor).toBeGreaterThan(2e-4);
    expect(floor).toBeLessThan(4e-3);
  });

  it("falls to a quiet passage faster than it climbs out of one", () => {
    // Asymmetric on purpose: a floor that rose with a sustained chord would
    // gate that chord's own decay.
    const down = tracker();
    settle(down, 1e-2, 400);
    const beforeFall = down.floor;
    settle(down, 1e-4, 200);
    const fell = beforeFall / down.floor;

    const up = tracker();
    settle(up, 1e-4, 400);
    const beforeRise = up.floor;
    settle(up, 1e-2, 200);
    const rose = up.floor / beforeRise;

    expect(fell).toBeGreaterThan(rose * 10);
  });

  it("ignores digital silence rather than tracking it", () => {
    // Every room-mic take here opens with seconds of decoded zeros before the
    // room tone starts. Folding those in converges on the codec, not the rig,
    // and would open the gate to nothing.
    const t = tracker();
    settle(t, 0, 3000);
    expect(t.floor).toBe(1e-5);
    const roomTone = settle(t, 8e-4, 3000);
    expect(roomTone).toBeGreaterThan(4e-4);
  });

  it("starts at the first frame it is given, not at the minimum", () => {
    // A take that opens on a loud chord would otherwise spend its first seconds
    // climbing, with the gate wide open underneath it.
    const t = tracker();
    expect(t.observe(0.05)).toBeCloseTo(0.05, 6);
  });
});
