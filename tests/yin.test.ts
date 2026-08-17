import { describe, expect, it } from "vitest";

import { YinDetector, peak, rms, zeroCrossingRateHz } from "../src/core/yin.js";
import { centsBetween } from "../src/core/notes.js";

const SR = 44100;
const LONG_WINDOW = 2048;
const SHORT_WINDOW = 512;

/* -------------------------------------------------------------------------- */
/* Signal helpers                                                              */
/* -------------------------------------------------------------------------- */

function sine(hz: number, n: number, amp = 0.5, phase = 0, sr = SR): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * hz * (i / sr) + phase);
  return out;
}

/**
 * Additive band-limited sawtooth: every harmonic present at 1/k. Rich harmonics
 * are the realistic guitar case and the reason octave errors happen at all.
 */
function sawtooth(hz: number, n: number, amp = 0.5, phase = 0, sr = SR): Float32Array {
  const out = new Float32Array(n);
  const maxHarmonic = Math.floor(sr / 2 / hz);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 1; k <= maxHarmonic; k++) {
      v += Math.sin(2 * Math.PI * hz * k * (i / sr) + phase) / k;
    }
    out[i] = amp * (2 / Math.PI) * v;
  }
  return out;
}

/** Harmonic series with explicit per-partial amplitudes; `amps[k - 1]` is harmonic k. */
function partials(hz: number, n: number, amps: number[], phase = 0, sr = SR): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 1; k <= amps.length; k++) {
      if (hz * k >= sr / 2) break;
      v += amps[k - 1]! * Math.sin(2 * Math.PI * hz * k * (i / sr) + phase);
    }
    out[i] = v;
  }
  return out;
}

/**
 * A sawtooth whose *alternate* periods differ in level: exactly periodic at 2T,
 * only nearly periodic at T. This is what uneven picking or a beating pair of
 * strings does, and it is the classic way YIN is pushed one octave down.
 */
function alternatingSawtooth(hz: number, n: number, depth: number, sr = SR): Float32Array {
  const base = sawtooth(hz, n, 0.5, 0, sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = base[i]! * (1 + depth * Math.sin(2 * Math.PI * (hz / 2) * (i / sr)));
  }
  return out;
}

/** Deterministic white noise (LCG), so a failure is always reproducible. */
function whiteNoise(n: number, seed: number, amp = 0.5): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * amp;
  }
  return out;
}

function longDetector(): YinDetector {
  return new YinDetector({
    sampleRate: SR,
    windowSize: LONG_WINDOW,
    minFrequencyHz: 70,
    maxFrequencyHz: 1400,
    threshold: 0.13,
  });
}

/** The six open strings — the frequencies that actually have to work. */
const OPEN_STRINGS: Array<[string, number]> = [
  ["E2", 82.41],
  ["A2", 110],
  ["D3", 146.83],
  ["G3", 196],
  ["B3", 246.94],
  ["E4", 329.63],
];

/** Eight starting phases, because YIN's accuracy is phase-dependent. */
const PHASES = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (i * Math.PI) / 4);

/* -------------------------------------------------------------------------- */

describe("YinDetector on synthetic tones", () => {
  it("detects a sine at every open-string pitch to within 2 cents", () => {
    const detector = longDetector();
    for (const [name, hz] of OPEN_STRINGS) {
      for (const phase of PHASES) {
        const result = detector.detect(sine(hz, LONG_WINDOW, 0.5, phase));
        expect(result.frequencyHz, `${name} phase=${phase}`).not.toBeNull();
        const cents = centsBetween(result.frequencyHz!, hz);
        expect(Math.abs(cents), `${name} phase=${phase} -> ${result.frequencyHz}Hz`).toBeLessThan(2);
        expect(result.confidence).toBeGreaterThan(0.9);
      }
    }
  });

  it("detects a sawtooth at every open-string pitch to within 2 cents", () => {
    const detector = longDetector();
    for (const [name, hz] of OPEN_STRINGS) {
      for (const phase of PHASES) {
        const result = detector.detect(sawtooth(hz, LONG_WINDOW, 0.5, phase));
        expect(result.frequencyHz, `${name} phase=${phase}`).not.toBeNull();
        const cents = centsBetween(result.frequencyHz!, hz);
        expect(Math.abs(cents), `${name} phase=${phase} -> ${result.frequencyHz}Hz`).toBeLessThan(2);
        expect(result.confidence).toBeGreaterThan(0.9);
      }
    }
  });

  it("reports tau and cmnd consistent with the returned frequency", () => {
    const detector = longDetector();
    const result = detector.detect(sawtooth(196, LONG_WINDOW));
    expect(result.tau).not.toBeNull();
    expect(result.cmnd).not.toBeNull();
    expect(SR / result.tau!).toBeCloseTo(result.frequencyHz!, 6);
    expect(result.confidence).toBeCloseTo(1 - result.cmnd!, 10);
    expect(result.cmnd!).toBeLessThan(0.13);
  });

  it("is stateless: repeated calls on the same window agree exactly", () => {
    const detector = longDetector();
    const window = sawtooth(146.83, LONG_WINDOW);
    const first = detector.detect(window);
    detector.detect(whiteNoise(LONG_WINDOW, 7));
    const second = detector.detect(window);
    expect(second).toEqual(first);
  });

  it("works with a short window at higher pitches", () => {
    const detector = new YinDetector({
      sampleRate: SR,
      windowSize: SHORT_WINDOW,
      minFrequencyHz: 150,
      maxFrequencyHz: 1400,
      threshold: 0.13,
    });
    for (const hz of [329.63, 440, 659.26, 987.77, 1318.51]) {
      const result = detector.detect(sawtooth(hz, SHORT_WINDOW));
      expect(result.frequencyHz, `${hz}Hz`).not.toBeNull();
      expect(Math.abs(centsBetween(result.frequencyHz!, hz)), `${hz}Hz`).toBeLessThan(5);
    }
  });

  it("never reports outside the configured frequency bounds", () => {
    const detector = new YinDetector({
      sampleRate: SR,
      windowSize: LONG_WINDOW,
      minFrequencyHz: 150,
      maxFrequencyHz: 500,
    });
    // 1000Hz is above the search range; whatever it locks onto must stay inside.
    for (const hz of [90, 1000, 1500]) {
      const result = detector.detect(sawtooth(hz, LONG_WINDOW));
      if (result.frequencyHz !== null) {
        expect(result.frequencyHz, `${hz}Hz`).toBeGreaterThan(150 * 0.95);
        expect(result.frequencyHz, `${hz}Hz`).toBeLessThan(500 * 1.05);
      }
    }
  });

  it("rejects a window of the wrong length", () => {
    const detector = longDetector();
    expect(() => detector.detect(new Float32Array(LONG_WINDOW - 1))).toThrow();
    expect(() => detector.detect(new Float32Array(LONG_WINDOW + 1))).toThrow();
  });
});

describe("YinDetector on unvoiced input", () => {
  it("returns a null frequency for digital silence", () => {
    const detector = longDetector();
    const result = detector.detect(new Float32Array(LONG_WINDOW));
    expect(result.frequencyHz).toBeNull();
    expect(result.tau).toBeNull();
    expect(result.cmnd).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("returns a null frequency for a constant (DC-only) window", () => {
    const detector = longDetector();
    const dc = new Float32Array(LONG_WINDOW);
    dc.fill(0.3);
    expect(detector.detect(dc).frequencyHz).toBeNull();
  });

  it("gives white noise very low confidence", () => {
    const detector = longDetector();
    for (const seed of [1, 2, 3, 99, 12345, 777]) {
      const result = detector.detect(whiteNoise(LONG_WINDOW, seed));
      expect(result.confidence, `seed=${seed}`).toBeLessThan(0.1);
      // Well under the 0.5 confidence gate the policy applies.
      expect(result.confidence, `seed=${seed}`).toBeLessThan(0.5);
    }
  });

  it("still ranks a real tone far above noise", () => {
    const detector = longDetector();
    const tone = detector.detect(sawtooth(110, LONG_WINDOW)).confidence;
    const noise = detector.detect(whiteNoise(LONG_WINDOW, 42)).confidence;
    expect(tone).toBeGreaterThan(noise * 10);
  });
});

/* -------------------------------------------------------------------------- */
/* Octave-error regressions — the single biggest threat to accuracy.           */
/* -------------------------------------------------------------------------- */

describe("octave errors: weak fundamental, strong 2nd harmonic", () => {
  /** Sawtooth-like partials with the fundamental attenuated to `h1`. */
  function weakFundamental(h1: number): number[] {
    const amps = [h1];
    for (let k = 2; k <= 8; k++) amps.push(0.5 / (k - 1));
    return amps;
  }

  it("reports the fundamental, not double it, when h1 is weak", () => {
    const detector = longDetector();
    for (const h1 of [0.15, 0.1, 0.05]) {
      for (const [name, hz] of OPEN_STRINGS) {
        const result = detector.detect(partials(hz, LONG_WINDOW, weakFundamental(h1)));
        expect(result.frequencyHz, `h1=${h1} ${name}`).not.toBeNull();
        const ratio = result.frequencyHz! / hz;
        expect(ratio, `h1=${h1} ${name} -> ${result.frequencyHz}Hz`).toBeGreaterThan(0.98);
        expect(ratio, `h1=${h1} ${name} -> ${result.frequencyHz}Hz`).toBeLessThan(1.02);
      }
    }
  });

  it("recovers a missing fundamental from the odd harmonics", () => {
    const detector = longDetector();
    for (const [name, hz] of OPEN_STRINGS) {
      const result = detector.detect(partials(hz, LONG_WINDOW, weakFundamental(0)));
      const ratio = result.frequencyHz! / hz;
      expect(ratio, `${name} -> ${result.frequencyHz}Hz`).toBeGreaterThan(0.98);
      expect(ratio, `${name} -> ${result.frequencyHz}Hz`).toBeLessThan(1.02);
    }
  });

  it("holds the fundamental across every phase of a weak-h1 sawtooth", () => {
    const detector = longDetector();
    for (const phase of PHASES) {
      const result = detector.detect(partials(110, LONG_WINDOW, weakFundamental(0.1), phase));
      expect(result.frequencyHz! / 110, `phase=${phase}`).toBeCloseTo(1, 1);
    }
  });

  it(
    "KNOWN LIMITATION: doubles the pitch once the odd harmonics carry under ~3% " +
      "of the power — YIN alone cannot separate that from a tone an octave up",
    () => {
      const detector = longDetector();
      // h1=0.1, h3=0.15, h5=0.05, h7=0.02 against h2=1.0, h4=0.4: the odd
      // partials hold ~2.9% of the power, so the CMND dips below threshold at
      // T/2 and the first-dip rule takes it. Asserting the real behaviour so a
      // future change to the threshold or the sub-harmonic guard is noticed.
      const amps = [0.1, 1.0, 0.15, 0.4, 0.05, 0.1, 0.02, 0.05];
      for (const [name, hz] of OPEN_STRINGS) {
        const result = detector.detect(partials(hz, LONG_WINDOW, amps));
        expect(result.frequencyHz! / hz, `${name} -> ${result.frequencyHz}Hz`).toBeCloseTo(2, 1);
      }
    }
  );
});

describe("octave errors: sub-harmonic guard", () => {
  // 2T must be inside the search range for the guard to matter, which needs
  // sampleRate/minFrequencyHz >= 2T. At 70Hz that means f0 above ~140Hz.
  const GUARDED: Array<[string, number]> = [
    ["D3", 146.83],
    ["G3", 196],
    ["B3", 246.94],
    ["E4", 329.63],
  ];

  it("keeps the true period when alternate periods differ", () => {
    const detector = longDetector();
    for (const [name, hz] of GUARDED) {
      for (const depth of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
        const result = detector.detect(alternatingSawtooth(hz, LONG_WINDOW, depth));
        expect(result.frequencyHz, `${name} depth=${depth}`).not.toBeNull();
        const ratio = result.frequencyHz! / hz;
        expect(ratio, `${name} depth=${depth} -> ${result.frequencyHz}Hz`).toBeGreaterThan(0.98);
        expect(ratio, `${name} depth=${depth} -> ${result.frequencyHz}Hz`).toBeLessThan(1.02);
      }
    }
  });

  it(
    "KNOWN LIMITATION: falls an octave down past ~65% period-to-period " +
      "modulation, where the signal really is more periodic at 2T",
    () => {
      const detector = longDetector();
      for (const [name, hz] of [
        ["G3", 196],
        ["B3", 246.94],
      ] as Array<[string, number]>) {
        const result = detector.detect(alternatingSawtooth(hz, LONG_WINDOW, 0.7));
        expect(result.frequencyHz! / hz, `${name} -> ${result.frequencyHz}Hz`).toBeCloseTo(0.5, 2);
      }
    }
  );
});

/* -------------------------------------------------------------------------- */

describe("zeroCrossingRateHz", () => {
  it("estimates a sine within 1% — an independent check on YIN", () => {
    for (const [name, hz] of OPEN_STRINGS) {
      const estimate = zeroCrossingRateHz(sine(hz, LONG_WINDOW), SR);
      expect(estimate / hz, `${name} -> ${estimate}Hz`).toBeGreaterThan(0.99);
      expect(estimate / hz, `${name} -> ${estimate}Hz`).toBeLessThan(1.01);
    }
  });

  it("estimates a harmonically rich sawtooth within 2%", () => {
    for (const [name, hz] of OPEN_STRINGS) {
      const estimate = zeroCrossingRateHz(sawtooth(hz, LONG_WINDOW), SR);
      expect(estimate / hz, `${name} -> ${estimate}Hz`).toBeGreaterThan(0.98);
      expect(estimate / hz, `${name} -> ${estimate}Hz`).toBeLessThan(1.02);
    }
  });

  it("is unmoved by a large DC offset", () => {
    for (const [name, hz] of OPEN_STRINGS) {
      const clean = sine(hz, LONG_WINDOW);
      const drifted = new Float32Array(LONG_WINDOW);
      for (let i = 0; i < LONG_WINDOW; i++) drifted[i] = clean[i]! + 0.4;
      expect(zeroCrossingRateHz(drifted, SR), name).toBeCloseTo(zeroCrossingRateHz(clean, SR), 6);
    }
  });

  it("does not inflate the count on noise riding near zero", () => {
    // A hysteresis-free counter would report roughly the sample rate over two.
    const hz = 196;
    const clean = sine(hz, LONG_WINDOW);
    const dithered = new Float32Array(LONG_WINDOW);
    const dither = whiteNoise(LONG_WINDOW, 5, 0.02);
    for (let i = 0; i < LONG_WINDOW; i++) dithered[i] = clean[i]! + dither[i]!;
    const estimate = zeroCrossingRateHz(dithered, SR);
    expect(estimate / hz).toBeGreaterThan(0.97);
    expect(estimate / hz).toBeLessThan(1.03);
  });

  it("returns 0 for silence and a constant window", () => {
    expect(zeroCrossingRateHz(new Float32Array(LONG_WINDOW), SR)).toBe(0);
    const dc = new Float32Array(LONG_WINDOW);
    dc.fill(0.25);
    expect(zeroCrossingRateHz(dc, SR)).toBe(0);
  });

  it("fails differently from YIN: noise reads implausibly high", () => {
    for (const seed of [1, 7, 4242]) {
      expect(zeroCrossingRateHz(whiteNoise(LONG_WINDOW, seed), SR), `seed=${seed}`).toBeGreaterThan(
        2000
      );
    }
  });
});

describe("rms and peak", () => {
  it("match the closed form for a sine", () => {
    const window = sine(440, LONG_WINDOW, 0.5);
    expect(rms(window)).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(peak(window)).toBeCloseTo(0.5, 4);
  });

  it("are zero for silence", () => {
    expect(rms(new Float32Array(LONG_WINDOW))).toBe(0);
    expect(peak(new Float32Array(LONG_WINDOW))).toBe(0);
  });

  it("peak uses absolute value", () => {
    const window = new Float32Array([0.1, -0.9, 0.4]);
    expect(peak(window)).toBeCloseTo(0.9, 6);
    expect(rms(window)).toBeCloseTo(Math.sqrt((0.01 + 0.81 + 0.16) / 3), 6);
  });

  it("scale linearly with amplitude", () => {
    expect(rms(sine(220, LONG_WINDOW, 0.2))).toBeCloseTo(rms(sine(220, LONG_WINDOW, 0.1)) * 2, 4);
    expect(peak(sine(220, LONG_WINDOW, 0.2))).toBeCloseTo(peak(sine(220, LONG_WINDOW, 0.1)) * 2, 4);
  });
});
