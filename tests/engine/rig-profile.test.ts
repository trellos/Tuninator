/**
 * What a rig profile has to be true of, stated against handwritten sequences.
 *
 * The estimator's job is to describe the SIGNAL CHAIN and not the performance,
 * so the properties worth pinning are the ones that separate those two: one
 * loud stroke must not move it, a hop that belongs to an attack must not set the
 * floor that attack is measured against, and silence must not be mistaken for a
 * quiet rig. Measured behaviour on the corpus lives in
 * `scripts/measure-rig-profile.ts` and `docs/DETECTION-FINDINGS.md`; this file
 * holds the invariants a recording cannot argue with.
 */

import { describe, expect, it } from "vitest";
import { RigProfileEstimator, type RigObservation } from "../../src/engine/rig-profile.js";

/** Hop interval used by these sequences, ms. Near the engine's own. */
const HOP_MS = 13;

function hop(at: number, overrides: Partial<RigObservation> = {}): RigObservation {
  return {
    at,
    rms: 0.05,
    peak: 0.12,
    gated: false,
    riseRatio: 1,
    sharpness: 0.4,
    fluxRatio: 0.5,
    heldSharpness: 0.3,
    heldFluxRatio: 0.6,
    highShare: 0.1,
    lowShare: 0.7,
    confidentAttack: false,
    ...overrides,
  };
}

/**
 * A steady passage of `hops` ordinary hops, with an attack every `every` hops.
 * The attack hop reads `attackSharpness`; the four hops after it ring out at
 * half that, which is what the holdoff exists to keep out of the floor.
 */
function passage(
  estimator: RigProfileEstimator,
  hops: number,
  options: { every: number; floorSharpness: number; attackSharpness: number }
): void {
  for (let i = 0; i < hops; i++) {
    const sinceAttack = i % options.every;
    const attack = sinceAttack === 0;
    const ringing = sinceAttack > 0 && sinceAttack <= 4;
    estimator.observe(
      hop(i * HOP_MS, {
        confidentAttack: attack,
        heldSharpness: attack
          ? options.attackSharpness
          : ringing
            ? options.attackSharpness / 2
            : options.floorSharpness,
      })
    );
  }
}

describe("RigProfileEstimator", () => {
  it("reports nothing until it has seen enough", () => {
    const estimator = new RigProfileEstimator();
    for (let i = 0; i < 20; i++) estimator.observe(hop(i * HOP_MS));
    const profile = estimator.profile();
    expect(profile.brightness).toBeNull();
    expect(profile.heldSharpness.floor).toBeNull();
    expect(profile.heldSharpness.contrast).toBeNull();
  });

  it("measures the contrast between attacks and everything else", () => {
    const estimator = new RigProfileEstimator();
    passage(estimator, 1200, { every: 20, floorSharpness: 0.3, attackSharpness: 3 });
    const profile = estimator.profile();
    expect(profile.heldSharpness.attack).toBeCloseTo(3, 6);
    expect(profile.heldSharpness.floor).toBeCloseTo(0.3, 6);
    expect(profile.heldSharpness.contrast).toBeCloseTo(10, 6);
  });

  it("keeps an attack's own ring-out out of the floor it is measured against", () => {
    // The same passage; the only difference is that the hops right after each
    // attack are loud. Without the holdoff they would raise the floor to 1.5
    // and read the contrast as 2 instead of 10.
    const estimator = new RigProfileEstimator();
    passage(estimator, 1200, { every: 20, floorSharpness: 0.3, attackSharpness: 3 });
    expect(estimator.profile().heldSharpness.floor).toBeLessThan(0.5);
  });

  it("is not moved by one loud stroke", () => {
    const quiet = new RigProfileEstimator();
    passage(quiet, 1200, { every: 20, floorSharpness: 0.3, attackSharpness: 3 });
    const before = quiet.profile();

    const shouted = new RigProfileEstimator();
    passage(shouted, 1200, { every: 20, floorSharpness: 0.3, attackSharpness: 3 });
    shouted.observe(
      hop(1200 * HOP_MS, { confidentAttack: true, heldSharpness: 400, rms: 4, peak: 40 })
    );
    const after = shouted.profile();

    expect(after.heldSharpness.attack).toBeCloseTo(before.heldSharpness.attack as number, 6);
    expect(after.crest).toBeCloseTo(before.crest as number, 6);
  });

  it("ignores gated hops entirely", () => {
    // Silence is `NoiseFloorTracker`'s subject. A profile that folded it in
    // would read a take that opens on ten seconds of room tone as a rig with
    // no transients in it.
    const estimator = new RigProfileEstimator();
    for (let i = 0; i < 2000; i++) {
      estimator.observe(hop(i * HOP_MS, { gated: true, heldSharpness: 0.001 }));
    }
    expect(estimator.profile().hops).toBe(0);
    expect(estimator.profile().heldSharpness.floor).toBeNull();
  });

  it("separates two rigs that differ only in their floor", () => {
    const clean = new RigProfileEstimator();
    passage(clean, 1200, { every: 20, floorSharpness: 0.3, attackSharpness: 3 });
    const noisy = new RigProfileEstimator();
    passage(noisy, 1200, { every: 20, floorSharpness: 1.2, attackSharpness: 3 });

    expect(clean.profile().heldSharpness.contrast as number).toBeGreaterThan(
      3 * (noisy.profile().heldSharpness.contrast as number)
    );
  });

  it("fits a decay time constant from the hops after a strike", () => {
    const estimator = new RigProfileEstimator();
    const tau = 300;
    let at = 0;
    for (let stroke = 0; stroke < 12; stroke++) {
      for (let i = 0; i < 60; i++) {
        const since = i * HOP_MS;
        estimator.observe(
          hop(at, { confidentAttack: i === 0, rms: 0.4 * Math.exp(-since / tau) })
        );
        at += HOP_MS;
      }
    }
    expect(estimator.profile().decayTauMs as number).toBeCloseTo(tau, -1);
  });
});
