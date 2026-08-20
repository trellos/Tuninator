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

/**
 * A measured transient, on BOTH the scales the flux kernel reports.
 *
 * `sharpness`/`fluxRatio` are taken against the short reference the onset
 * decision uses — "how much arrived since a few hops ago" — and
 * `heldSharpness`/`heldFluxRatio` against the decaying peak hold — "how much
 * of this frame is new since the note began". Every vector in this file was
 * read off the recording named beside it by running the engine over it, so a
 * change that moves them is a change to what the recognizer believes about
 * real audio.
 */
function attack(
  sharpness: number,
  fluxRatio: number,
  heldSharpness: number,
  heldFluxRatio: number,
  riseRatio = 1
): AttackEvidence {
  return {
    at: 1000,
    atSample: 48000,
    flux: true,
    fluxValue: 0.3,
    envelope: riseRatio >= DEFAULT_ENGINE_CONFIG.transient.envelopeRiseRatio,
    riseRatio,
    sharpness,
    fluxRatio,
    heldSharpness,
    heldFluxRatio,
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
  // Transients accepted inside the ringing chords of
  // `cowboy-chords-amped-d-em-g-c-2x-140bpm`, every one with a rise ratio of
  // about 1.00 — no energy arrived at all. Each clears `restrumSharpness` on
  // the held reading, which is the reading the re-strum test is made against,
  // so sharpness alone would let all of them through.
  //
  // Honest about what this does NOT cover: a twenty-first transient on the
  // same take reads [3.74, 1.07, 2.62, 1.64] and clears both held bars. It is
  // one of that fixture's three false positives, and no threshold on these two
  // figures separates it from the strums below.
  const measured: Array<[number, number, number, number, number]> = [
    [3.01, 0.9, 1.46, 0.96, 1.04],
    [2.74, 0.92, 1.15, 0.85, 0.95],
    [2.74, 0.98, 0.91, 0.71, 0.97],
    [2.08, 0.75, 1.33, 1.05, 1.04],
    [2.33, 0.77, 1.0, 0.73, 1.05],
    [2.1, 1.1, 1.12, 1.29, 0.76],
    [2.46, 0.86, 1.12, 0.86, 1.01],
    [2.42, 0.87, 1.01, 0.8, 0.94],
    [3.05, 0.91, 1.51, 0.99, 1.0],
    [2.9, 0.88, 1.12, 0.75, 1.04],
    [2.48, 0.8, 1.14, 0.81, 1.02],
    [2.38, 0.82, 1.1, 0.83, 0.91],
    [2.37, 0.72, 1.1, 0.74, 0.93],
  ];

  it.each(measured)(
    "rejects sustain measured at held sharpness %#",
    (sharpness, fluxRatio, heldSharpness, heldFluxRatio, riseRatio) => {
      // Every one of these clears `restrumSharpness` on its own.
      expect(heldSharpness).toBeGreaterThanOrEqual(
        DEFAULT_ENGINE_CONFIG.transient.restrumSharpness
      );
      expect(
        overRingingChord(attack(sharpness, fluxRatio, heldSharpness, heldFluxRatio, riseRatio), {
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
  // From the same file and from `chords-a-bm-g-d-2x-120bpm`, whose second
  // strum of every pair is a muted upstrum quieter than what it interrupts.
  const genuine: Array<[string, number, number, number, number]> = [
    ["cowboy amped, the C on beat 1", 8.6, 2.46, 8.64, 5.44],
    ["cowboy amped, a mid-bar restrum", 4.63, 1.39, 4.05, 2.67],
    ["cowboy amped, a mid-bar restrum", 3.39, 1.2, 2.73, 2.13],
    ["cowboy amped, a mid-bar restrum", 3.27, 1.07, 2.69, 1.94],
    ["cowboy amped, a mid-bar restrum", 2.83, 1.05, 1.82, 1.49],
    ["chords-a-bm, a muted upstrum", 1.26, 0.91, 0.99, 1.58],
    ["chords-a-bm, a muted upstrum", 1.85, 1.18, 1.26, 1.78],
    ["chords-a-bm, a muted upstrum", 1.77, 1.02, 1.08, 1.38],
  ];

  it.each(genuine)("accepts %s", (_name, sharpness, fluxRatio, heldSharpness, heldFluxRatio) => {
    expect(
      overRingingChord(attack(sharpness, fluxRatio, heldSharpness, heldFluxRatio, 1.05), {
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
      overRingingChord(attack(0.1, 1.0, 0.1, 1.0, 1.4), {
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
    const evidence = attack(3.05, 0.91, 1.51, 0.99, 1.0);
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
