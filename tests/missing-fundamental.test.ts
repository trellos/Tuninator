/**
 * `estimateMissingFundamental` against synthesized partial series.
 *
 * The estimator is asked one question — which note has this spacing — and the
 * interesting cases are the ones where it must refuse to answer. The series are
 * built here by hand rather than analysed out of audio, so that "the 5th
 * partial is absent" is a fact of the test rather than a property of a signal.
 */

import { describe, expect, it } from "vitest";
import {
  estimateMissingFundamental,
  MIN_FUNDAMENTAL_MIDI,
  type PartialSpectrum,
} from "../src/engine/kernels/missing-fundamental.js";

const BIN_HZ = 48000 / 4096;
/** Top of the bass range, as `chroma.ts` uses it: 200Hz is a hair below G3. */
const MAX_MIDI = 55;

function hzOf(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** A note's partials, `harmonics` of them, each at 1/n of the first's weight. */
function series(midi: number, harmonics: readonly number[]): Array<[number, number]> {
  return harmonics.map((h) => [hzOf(midi) * h, 1 / h] as [number, number]);
}

/** Peaks from one or more series, merged and sorted the way a spectrum is. */
function spectrumOf(...parts: Array<Array<[number, number]>>): PartialSpectrum {
  const peaks = parts.flat().sort((a, b) => a[0] - b[0]);
  return {
    hz: Float64Array.from(peaks.map((p) => p[0])),
    weight: Float64Array.from(peaks.map((p) => p[1])),
    count: peaks.length,
    presenceThreshold: 0.02,
    binHz: BIN_HZ,
    maxFrequencyHz: 1300,
  };
}

const B2 = 47;
const FSHARP3 = 54;
const E3 = 52;
const B3 = 59;
const C3 = 48;
const E4 = 64;
const G3 = 55;

const ALL = [1, 2, 3, 4, 5, 6, 7, 8];
const NO_FIRST = [2, 3, 4, 5, 6, 7, 8];

describe("estimateMissingFundamental", () => {
  it("declines when the fundamental is in the spectrum", () => {
    // Nothing to infer: a peak sits at 123.5Hz and the peak pickers own it.
    expect(estimateMissingFundamental(spectrumOf(series(B2, ALL)), MAX_MIDI)).toBeNull();
  });

  it("names the note from the spacing when its own partial is gone", () => {
    const found = estimateMissingFundamental(spectrumOf(series(B2, NO_FIRST)), MAX_MIDI);
    expect(found?.midi).toBe(B2);
  });

  it("declines on the 2nd, 3rd, 4th and 6th alone — the guard's price", () => {
    // Those four partials are what a `B5` looks like in the loud part of the
    // spectrum, and they are also exactly what an octave-below fiction over a
    // power chord looks like: 2 and 4 are the root, 3 and 6 are the fifth.
    // Nothing here is odd-and-unexplained, so the estimate is refused. The
    // room-mic capture does clear the bar, because the 5th and 7th partials are
    // present as peaks there even at a few percent of the loudest partial.
    expect(estimateMissingFundamental(spectrumOf(series(B2, [2, 3, 4, 6])), MAX_MIDI)).toBeNull();
  });

  it("finds the root of a power chord whose root partial is gone", () => {
    // B5 as the mic records it: no 123.5Hz, and the fifth's own series on top.
    const found = estimateMissingFundamental(
      spectrumOf(series(B2, NO_FIRST), series(FSHARP3, ALL)),
      MAX_MIDI
    );
    expect(found?.midi).toBe(B2);
  });

  it("does not invent a fundamental an octave below a real one", () => {
    // A whole E3, fundamental included. E2 explains every even partial of it
    // and is a fiction; the 5th and 7th partials E2 would need are not there.
    const found = estimateMissingFundamental(spectrumOf(series(E3, ALL)), MAX_MIDI);
    expect(found).toBeNull();
  });

  it("does not invent one an octave below a power chord either", () => {
    // The harder decoy: the fifth supplies E2's 3rd partial, so one odd
    // harmonic is not enough evidence and two are required.
    const found = estimateMissingFundamental(
      spectrumOf(series(E3, ALL), series(B3, ALL)),
      MAX_MIDI
    );
    expect(found).toBeNull();
  });

  it("does not invent one below the lowest string", () => {
    // A root-position major triad is the decoy that beats the odd-harmonic
    // test: C2's 3rd partial is the chord's fifth and its 5th partial is the
    // third two octaves up, 14 cents away. The instrument's range rejects it.
    const found = estimateMissingFundamental(
      spectrumOf(series(C3, ALL), series(E4, ALL), series(G3, ALL)),
      MAX_MIDI
    );
    expect(found).toBeNull();
    expect(MIN_FUNDAMENTAL_MIDI).toBeGreaterThan(C3 - 12);
  });

  it("declines when only the high partials are there", () => {
    // 5f, 6f, 7f, 8f alone: at this spacing the match window is wide enough to
    // be hit by accident, and the 2nd and 3rd partials are required.
    const found = estimateMissingFundamental(spectrumOf(series(B2, [5, 6, 7, 8])), MAX_MIDI);
    expect(found).toBeNull();
  });

  it("declines on an empty spectrum", () => {
    expect(estimateMissingFundamental(spectrumOf(), MAX_MIDI)).toBeNull();
  });
});
