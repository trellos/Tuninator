/**
 * The decay model.
 *
 * A plucked string decays exponentially, and the time constant is measurable
 * from the note's own envelope. That is what turns "is this louder?" — which a
 * muted upstrum fails and sustain ripple passes — into "is this louder than the
 * strings already sounding could possibly still be?", which only fresh energy
 * can pass.
 */

import { describe, expect, it } from "vitest";
import { VoiceDecay } from "../../src/engine/tracker/voices.js";

/** Feed an exponential decay of the given time constant, one hop at a time. */
function feed(decay: VoiceDecay, peak: number, tauMs: number, ms: number, hopMs = 13): void {
  for (let t = 0; t <= ms; t += hopMs) decay.observe(t, peak * Math.exp(-t / tauMs));
}

describe("fitting a decay", () => {
  it("says nothing until it has seen enough", () => {
    const decay = new VoiceDecay();
    decay.observe(0, 0.4);
    decay.observe(13, 0.39);
    expect(decay.tauMs()).toBeNull();
    expect(decay.predict(100)).toBeNull();
    expect(decay.excess(100, 0.5)).toBeNull();
  });

  it("recovers the time constant it was given", () => {
    const decay = new VoiceDecay();
    feed(decay, 0.4, 600, 500);
    expect(decay.tauMs() as number).toBeGreaterThan(500);
    expect(decay.tauMs() as number).toBeLessThan(700);
  });

  it("predicts forward along its own curve", () => {
    const decay = new VoiceDecay();
    feed(decay, 0.4, 600, 400);
    const predicted = decay.predict(600) as number;
    expect(predicted).toBeCloseTo(0.4 * Math.exp(-1), 2);
  });

  it("reads a signal on its own curve as no excess", () => {
    const decay = new VoiceDecay();
    feed(decay, 0.4, 600, 400);
    const onCurve = 0.4 * Math.exp(-600 / 600);
    expect(decay.excess(600, onCurve) as number).toBeCloseTo(1, 1);
  });

  it("reads fresh energy as excess even when it is quieter than the peak", () => {
    // The case the whole model exists for: 500ms into a decay, a re-pick at
    // half the original level is well below the peak and well ABOVE the curve.
    const decay = new VoiceDecay();
    feed(decay, 0.4, 400, 500);
    expect(decay.excess(500, 0.2) as number).toBeGreaterThan(1.5);
    expect(0.2).toBeLessThan(0.4);
  });

  it("restarts the fit when a louder attack overtakes it", () => {
    const decay = new VoiceDecay();
    feed(decay, 0.4, 400, 400);
    decay.observe(400, 0.9);
    expect(decay.tauMs()).toBeNull();
    expect(decay.observations).toBe(0);
  });

  it("refuses to fit a rising or flat envelope", () => {
    const decay = new VoiceDecay();
    for (let t = 0; t <= 400; t += 13) decay.observe(t, 0.3);
    expect(decay.tauMs()).toBeNull();
  });

  it("clamps an implausible fit rather than extrapolating it", () => {
    // A fit is only as good as the envelope it saw; an unbounded time constant
    // would let one noisy stretch predict silence forever, or never.
    const decay = new VoiceDecay();
    feed(decay, 0.4, 50000, 400);
    const tau = decay.tauMs() as number;
    expect(tau).toBeLessThanOrEqual(4000);
    expect(tau).toBeGreaterThanOrEqual(80);
  });
});
