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
import {
  REFERENCE_HELD_FLUX_RATIO_FLOOR,
  REFERENCE_HELD_SHARPNESS_FLOOR,
  REFERENCE_SHARPNESS_FLOOR,
  RigProfileEstimator,
  UNCALIBRATED,
  calibrationFrom,
  type RigObservation,
  type RigProfile,
} from "../../src/engine/rig-profile.js";
import { DEFAULT_ENGINE_CONFIG } from "../../src/engine/config.js";
import { RearticulationDetector } from "../../src/engine/fast/rearticulation.js";
import type { AttackEvidence, FastFrame } from "../../src/engine/contracts.js";

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

/* -------------------------------------------------------------------------- */
/* Reading a profile back into the decision                                    */
/* -------------------------------------------------------------------------- */

/** A profile with only the three floors a calibration reads set. */
function profileWithFloors(
  sharpness: number | null,
  heldSharpness: number | null,
  heldFluxRatio: number | null
): RigProfile {
  const witness = (floor: number | null) => ({
    attack: null,
    attackLow: null,
    floor,
    contrast: null,
  });
  return {
    hops: 0,
    attacks: 0,
    backgroundHops: 0,
    elapsedMs: 0,
    brightness: null,
    bassShare: null,
    crest: null,
    decayTauMs: null,
    heldSharpness: witness(heldSharpness),
    heldFluxRatio: witness(heldFluxRatio),
    riseRatio: witness(null),
    sharpness: witness(sharpness),
    fluxRatio: witness(null),
  };
}

describe("rig calibration", () => {
  it("is the identity on the rig the constants were derived on", () => {
    const calibration = calibrationFrom(
      profileWithFloors(
        REFERENCE_SHARPNESS_FLOOR,
        REFERENCE_HELD_SHARPNESS_FLOOR,
        REFERENCE_HELD_FLUX_RATIO_FLOOR
      )
    );
    expect(calibration).toEqual(UNCALIBRATED);
  });

  it("moves a bar by exactly the ratio of the floors", () => {
    const calibration = calibrationFrom(
      profileWithFloors(
        REFERENCE_SHARPNESS_FLOOR * 2,
        REFERENCE_HELD_SHARPNESS_FLOOR * 3,
        REFERENCE_HELD_FLUX_RATIO_FLOOR / 2
      )
    );
    expect(calibration.sharpnessScale).toBeCloseTo(2, 10);
    expect(calibration.heldSharpnessScale).toBeCloseTo(3, 10);
    expect(calibration.fluxRatioScale).toBeCloseTo(0.5, 10);
  });

  it("says nothing about a floor it could not estimate", () => {
    // Dense playing leaves too few hops belonging to no attack for a floor at
    // all. Silence about a rig is not evidence that it is the reference rig,
    // but 1 is the only answer that cannot make things worse.
    expect(calibrationFrom(profileWithFloors(null, null, null))).toEqual(UNCALIBRATED);
  });

  it("leaves every re-articulation verdict alone when uncalibrated", () => {
    // The control the whole measurement rests on: the shipped default must be
    // the same code path as no calibration at all.
    const t = DEFAULT_ENGINE_CONFIG.transient;
    const attack = {
      at: 1000,
      atSample: 48000,
      flux: true,
      fluxValue: 1,
      envelope: false,
      riseRatio: 1,
      sharpness: t.rearticulationSharpness,
      fluxRatio: 9,
      heldSharpness: t.restrumSharpness,
      heldFluxRatio: t.restrumFluxRatio,
      strength: 1,
    } satisfies AttackEvidence;
    const frame = { gated: false } as FastFrame;

    const plain = new RearticulationDetector(DEFAULT_ENGINE_CONFIG);
    const calibrated = new RearticulationDetector({
      ...DEFAULT_ENGINE_CONFIG,
      calibration: { ...UNCALIBRATED },
    });
    const verdict = (detector: RearticulationDetector) =>
      detector.verdict(attack, frame, false, 1, false, null, true, 10);
    expect(verdict(calibrated)).toEqual(verdict(plain));
    expect(verdict(plain).accepted).toBe(true);
  });

  it("refuses on a rig whose resting flux is where the bar used to be", () => {
    // Same transient, twice the measured floor: the bar it has to clear moves
    // with the floor, so a reading that was exactly at the bar no longer is.
    const t = DEFAULT_ENGINE_CONFIG.transient;
    const attack = {
      at: 1000,
      atSample: 48000,
      flux: true,
      fluxValue: 1,
      envelope: false,
      riseRatio: 1,
      sharpness: t.rearticulationSharpness,
      fluxRatio: 9,
      heldSharpness: t.restrumSharpness,
      heldFluxRatio: t.restrumFluxRatio,
      strength: 1,
    } satisfies AttackEvidence;
    const frame = { gated: false } as FastFrame;
    const detector = new RearticulationDetector({
      ...DEFAULT_ENGINE_CONFIG,
      calibration: { sharpnessScale: 2, heldSharpnessScale: 2, fluxRatioScale: 1 },
    });
    expect(detector.verdict(attack, frame, false, 1, false, null, true, 10).accepted).toBe(
      false
    );
  });
});
