/**
 * The same playing through a compressor, which is what an amp sim is.
 *
 * Every constant in the re-articulation path was fitted against recordings of a
 * clean, largely uncompressed signal, and two of them meant something different
 * once a compressor sat in the chain. This file holds that ground with evidence
 * vectors taken from the corpus rather than from a synthesiser: the numbers
 * below were measured on the recordings named beside them, so a change that
 * moves them is a change to what the recognizer believes about real audio.
 *
 *  - `transient.restrumSharpness` is spectral flux over the frame's RMS. A
 *    compressor holds the RMS flat while the spectrum keeps churning, so the
 *    ordinary sustain of a compressed chord reads as sharp as a real pick does
 *    on a direct input. Across the corpus the sharpness of attacks landing on
 *    no played event has a median of 0.46 on the clean 120bpm takes and 1.37 on
 *    the amp-sim ones — either side of the fitted 0.9. `fluxRatio`, which has
 *    the signal's own recent flux in its denominator, has an off-label median
 *    of 1.02-1.24 on every path in the corpus.
 *  - the polyphonic branch was entered only once a Note had NAMED a chord.
 *    Naming needs a chord template to fit, and a saturated signal is where
 *    templates stop fitting, so the one path that protects a ringing chord from
 *    being chopped switched itself off on the signal that needed it most.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG } from "../../src/engine/config.js";
import { RearticulationDetector } from "../../src/engine/fast/rearticulation.js";
import type { AttackEvidence, FastFrame } from "../../src/engine/contracts.js";

const detector = new RearticulationDetector(DEFAULT_ENGINE_CONFIG);

function attack(sharpness: number, fluxRatio: number, riseRatio = 1): AttackEvidence {
  return {
    at: 1000,
    atSample: 48000,
    flux: true,
    fluxValue: 0.3,
    envelope: riseRatio >= DEFAULT_ENGINE_CONFIG.transient.envelopeRiseRatio,
    riseRatio,
    sharpness,
    fluxRatio,
    strength: 0.8,
  };
}

function frame(rms: number): FastFrame {
  return {
    sampleIndex: 48000,
    at: 1000,
    pitch: {
      frequencyHz: null,
      confidence: 0.2,
      tau: null,
      cmnd: null,
      zeroCrossingHz: null,
      source: "long",
      nearest: null,
    },
    rms,
    peak: rms * 2,
    gated: rms < DEFAULT_ENGINE_CONFIG.analysis.rmsGate,
    attack: null,
    riseRatio: 1,
    bandOnset: false,
    hop: 100,
  };
}

/** A ringing chord, re-articulated only if this attack says so. */
function overRingingChord(
  a: AttackEvidence,
  options: { rms: number; sustainedRms: number; decayExcess: number | null; soundedMs: number }
): boolean {
  return detector.isRearticulation(
    a,
    frame(options.rms),
    false,
    options.sustainedRms,
    false,
    options.decayExcess,
    true,
    options.soundedMs
  );
}

describe("an amp sim's sustain is not a re-strum", () => {
  // Ten separate re-articulations were accepted inside four ringing chords on
  // `cowboy-chords-amped-d-em-g-c-2x-140bpm`, every one of them with a rise
  // ratio of about 1.00 — no energy arrived at all. These are their measured
  // evidence vectors.
  const measured: Array<[number, number, number]> = [
    [1.49, 1.21, 1.04],
    [1.33, 1.05, 1.04],
    [1.26, 1.17, 1.13],
    [1.40, 1.01, 0.97],
    [1.28, 1.02, 0.97],
    [1.37, 1.02, 1.01],
    [1.53, 1.13, 1.07],
    [1.53, 1.07, 0.94],
    [1.26, 1.05, 1.03],
    [1.32, 1.10, 0.99],
  ];

  it.each(measured)(
    "rejects sustain measured at sharpness %f, flux ratio %f",
    (sharpness, fluxRatio, riseRatio) => {
      // Every one of these clears `restrumSharpness` on its own.
      expect(sharpness).toBeGreaterThanOrEqual(DEFAULT_ENGINE_CONFIG.transient.restrumSharpness);
      expect(
        overRingingChord(attack(sharpness, fluxRatio, riseRatio), {
          rms: 0.065,
          sustainedRms: 0.064,
          decayExcess: 1.05,
          soundedMs: 400,
        })
      ).toBe(false);
    }
  );
});

describe("a real strum on the same signal path still gets through", () => {
  // From the same file and the 120bpm fixtures the escape was fitted on.
  const genuine: Array<[string, number, number]> = [
    ["cowboy amped, the C on beat 1", 4.5, 3.17],
    ["cowboy amped, mid-bar restrum", 2.26, 1.75],
    ["chords-a-bm, a muted upstrum", 1.26, 1.78],
    ["chords-a-bm, a muted upstrum", 0.99, 1.58],
  ];

  it.each(genuine)("accepts %s", (_name, sharpness, fluxRatio) => {
    expect(
      overRingingChord(attack(sharpness, fluxRatio, 1.05), {
        rms: 0.065,
        sustainedRms: 0.064,
        decayExcess: 1.0,
        soundedMs: 400,
      })
    ).toBe(true);
  });

  it("still accepts a strum that put real energy back into the strings", () => {
    // The decay-excess witness is untouched: energy above the chord's own
    // measured curve had to come from outside, whatever the transient looks
    // like, and that is how a re-strum is caught when its pick noise is buried.
    expect(
      overRingingChord(attack(0.1, 1.0, 1.4), {
        rms: 0.09,
        sustainedRms: 0.064,
        decayExcess: 1.66,
        soundedMs: 900,
      })
    ).toBe(true);
  });
});

describe("a chord the recognizer could not NAME is still a chord", () => {
  // The second half of the fix. A saturated signal defeats the chord templates
  // long before it defeats the evidence that six strings are ringing, so the
  // protection has to key on the Note having bloomed, not on it having a name.
  it("takes the strict polyphonic route rather than the monophonic fallback", () => {
    const evidence = attack(1.53, 1.13, 1.07);
    const state = { rms: 0.065, sustainedRms: 0.064, decayExcess: null, soundedMs: 400 };

    // Treated as a chord: sustain is rejected.
    expect(overRingingChord(evidence, state)).toBe(false);

    // Treated as a single note, the weak fallback accepts it on sharpness
    // alone, which is the behaviour that chopped the amped chords.
    expect(
      detector.isRearticulation(
        evidence,
        frame(state.rms),
        false,
        state.sustainedRms,
        false,
        state.decayExcess,
        false,
        state.soundedMs
      )
    ).toBe(true);
  });
});
