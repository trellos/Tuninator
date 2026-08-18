import { describe, expect, it } from "vitest";

import { OnsetDetector } from "../src/core/onset.js";
import { YinDetector } from "../src/core/yin.js";

const SR = 44100;
const FFT = 1024;
/** 256 samples ~= 5.8ms; 512 ~= 11.6ms, which is the 12ms policy hop snapped to quanta. */
const HOPS = [256, 512];

/* -------------------------------------------------------------------------- */
/* Signal helpers                                                              */
/* -------------------------------------------------------------------------- */

/** One sample of a band-limited sawtooth — a stand-in for a plucked string. */
function sawSample(hz: number, t: number, harmonics = 12): number {
  let v = 0;
  const maxHarmonic = Math.min(harmonics, Math.floor(SR / 2 / hz));
  for (let k = 1; k <= maxHarmonic; k++) v += Math.sin(2 * Math.PI * hz * k * t) / k;
  return v * (2 / Math.PI);
}

/**
 * `count` attacks of the *same* pitch, each a short exponential decay. Nothing
 * about the pitch changes between them, so only a spectral-flux detector can
 * see the re-picks; an RMS envelope would smear straight through them.
 */
function repeatedAttacks(options: {
  hz: number;
  count: number;
  spacingMs: number;
  decayMs: number;
  leadMs?: number;
  amp?: number;
}): { signal: Float32Array; attacksMs: number[] } {
  const { hz, count, spacingMs, decayMs } = options;
  const leadMs = options.leadMs ?? 100;
  const amp = options.amp ?? 0.5;

  const totalMs = leadMs + count * spacingMs + Math.max(300, decayMs * 2);
  const signal = new Float32Array(Math.round((totalMs / 1000) * SR));
  const attacksMs: number[] = [];

  for (let p = 0; p < count; p++) {
    const startMs = leadMs + p * spacingMs;
    attacksMs.push(startMs);
    const start = Math.round((startMs / 1000) * SR);
    for (let i = start; i < signal.length; i++) {
      const dt = (i - start) / SR;
      const envelope = Math.exp(-dt / (decayMs / 1000));
      if (envelope < 1e-4) break;
      signal[i] = signal[i]! + amp * envelope * sawSample(hz, dt);
    }
  }
  return { signal, attacksMs };
}

/** One unbroken note: silence, then a tone that never stops or changes. */
function steadyTone(hz: number, durationMs: number, leadMs = 60, amp = 0.5): Float32Array {
  const signal = new Float32Array(Math.round(((leadMs + durationMs) / 1000) * SR));
  const start = Math.round((leadMs / 1000) * SR);
  for (let i = start; i < signal.length; i++) signal[i] = amp * sawSample(hz, (i - start) / SR);
  return signal;
}

function whiteNoise(n: number, seed: number, amp: number): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * amp;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Driver                                                                      */
/* -------------------------------------------------------------------------- */

type Options = Partial<{ minIntervalMs: number; medianWindow: number; sensitivity: number }>;

function makeDetector(options: Options = {}): OnsetDetector {
  return new OnsetDetector({
    sampleRate: SR,
    fftSize: FFT,
    minIntervalMs: options.minIntervalMs ?? 60,
    medianWindow: options.medianWindow ?? 17,
    sensitivity: options.sensitivity ?? 1.6,
  });
}

/**
 * Slide the detector over `signal`, one hop at a time. `timestampMs` is the
 * time of the most recent sample in the window, exactly as an engine driving
 * this from a ring buffer would supply it.
 */
function collectOnsets(
  signal: Float32Array,
  hop: number,
  detector: OnsetDetector = makeDetector()
): { onsetsMs: number[]; maxFlux: number; results: Array<{ ms: number; flux: number; threshold: number }> } {
  const frame = new Float32Array(FFT);
  const onsetsMs: number[] = [];
  const results: Array<{ ms: number; flux: number; threshold: number }> = [];
  let maxFlux = 0;

  for (let start = 0; start + FFT <= signal.length; start += hop) {
    frame.set(signal.subarray(start, start + FFT));
    const ms = ((start + FFT) / SR) * 1000;
    const result = detector.process(frame, ms);
    results.push({ ms, flux: result.flux, threshold: result.threshold });
    maxFlux = Math.max(maxFlux, result.flux);
    if (result.isOnset) onsetsMs.push(ms);
  }
  return { onsetsMs, maxFlux, results };
}

const FREQUENCIES: Array<[string, number]> = [
  ["E2", 82.41],
  ["A2", 110],
  ["G3", 196],
  ["E4", 329.63],
];

/* -------------------------------------------------------------------------- */

describe("repeated attacks at an unchanging pitch", () => {
  it("reports one onset per attack", () => {
    const cases = [
      { count: 6, spacingMs: 300, decayMs: 220 },
      { count: 8, spacingMs: 125, decayMs: 90 },
      { count: 4, spacingMs: 500, decayMs: 400 },
      { count: 10, spacingMs: 150, decayMs: 400 },
    ];
    for (const shape of cases) {
      for (const [name, hz] of FREQUENCIES) {
        for (const hop of HOPS) {
          const { signal } = repeatedAttacks({ hz, ...shape });
          const { onsetsMs } = collectOnsets(signal, hop);
          expect(
            onsetsMs.length,
            `${name} ${shape.count}x @${shape.spacingMs}ms decay=${shape.decayMs}ms hop=${hop}`
          ).toBe(shape.count);
        }
      }
    }
  });

  it("places each onset just after its attack", () => {
    const { signal, attacksMs } = repeatedAttacks({ hz: 196, count: 6, spacingMs: 300, decayMs: 220 });
    const { onsetsMs } = collectOnsets(signal, 256);
    expect(onsetsMs).toHaveLength(attacksMs.length);
    for (let i = 0; i < attacksMs.length; i++) {
      const lag = onsetsMs[i]! - attacksMs[i]!;
      // The window is 1024 samples (23ms) and its timestamp is its last sample,
      // so an onset can never precede its attack and should land within a
      // window-and-a-hop of it.
      expect(lag, `attack ${i} at ${attacksMs[i]}ms -> ${onsetsMs[i]}ms`).toBeGreaterThanOrEqual(0);
      expect(lag, `attack ${i} at ${attacksMs[i]}ms -> ${onsetsMs[i]}ms`).toBeLessThan(40);
    }
  });

  it("fires on re-picks that leave the detected pitch unchanged", () => {
    // The point of spectral flux: the note is identical every time, so the only
    // evidence of a new event is energy reappearing across the spectrum.
    const hz = 110;
    const { signal, attacksMs } = repeatedAttacks({ hz, count: 5, spacingMs: 300, decayMs: 250 });
    const { onsetsMs } = collectOnsets(signal, 256);
    expect(onsetsMs).toHaveLength(5);

    const yin = new YinDetector({
      sampleRate: SR,
      windowSize: 2048,
      minFrequencyHz: 70,
      maxFrequencyHz: 1400,
    });
    const window = new Float32Array(2048);
    for (const attackMs of attacksMs) {
      const start = Math.round(((attackMs + 40) / 1000) * SR);
      window.set(signal.subarray(start, start + 2048));
      const pitch = yin.detect(window);
      expect(pitch.frequencyHz! / hz, `pitch at ${attackMs}ms`).toBeCloseTo(1, 2);
    }
  });

  it("is level independent", () => {
    for (const amp of [0.02, 0.1, 0.5, 0.9]) {
      const { signal } = repeatedAttacks({ hz: 196, count: 6, spacingMs: 300, decayMs: 220, amp });
      expect(collectOnsets(signal, 256).onsetsMs.length, `amp=${amp}`).toBe(6);
    }
  });

  it("holds across the sensitivities the policy uses", () => {
    for (const sensitivity of [1.35, 1.6, 1.9]) {
      const { signal } = repeatedAttacks({ hz: 246.94, count: 6, spacingMs: 300, decayMs: 220 });
      expect(
        collectOnsets(signal, 256, makeDetector({ sensitivity })).onsetsMs.length,
        `sensitivity=${sensitivity}`
      ).toBe(6);
    }
  });
});

describe("a steady unbroken tone", () => {
  it("yields exactly one onset, at the start", () => {
    for (const [name, hz] of FREQUENCIES) {
      for (const hop of HOPS) {
        const { onsetsMs } = collectOnsets(steadyTone(hz, 2000), hop);
        expect(onsetsMs.length, `${name} hop=${hop}`).toBe(1);
        // The tone starts 60ms in; the onset must be right there, not later.
        expect(onsetsMs[0]!, `${name} hop=${hop}`).toBeGreaterThanOrEqual(60);
        expect(onsetsMs[0]!, `${name} hop=${hop}`).toBeLessThan(120);
      }
    }
  });

  it("keeps flux under threshold for the whole sustain", () => {
    const { results } = collectOnsets(steadyTone(196, 2000), 256);
    const sustain = results.filter((r) => r.ms > 200);
    expect(sustain.length).toBeGreaterThan(200);
    for (const r of sustain) {
      expect(r.flux, `flux at ${r.ms}ms`).toBeLessThanOrEqual(r.threshold);
    }
  });

  it("holds across the sensitivities the policy uses", () => {
    for (const sensitivity of [1.35, 1.6, 1.9]) {
      expect(
        collectOnsets(steadyTone(82.41, 2000), 512, makeDetector({ sensitivity })).onsetsMs.length,
        `sensitivity=${sensitivity}`
      ).toBe(1);
    }
  });
});

describe("minIntervalMs", () => {
  it("suppresses a double trigger inside the interval", () => {
    // Two attacks only 40ms apart.
    const { signal } = repeatedAttacks({ hz: 196, count: 2, spacingMs: 40, decayMs: 200 });
    const counts = [10, 60, 200, 400].map(
      (minIntervalMs) => collectOnsets(signal, 256, makeDetector({ minIntervalMs })).onsetsMs.length
    );
    // A short interval lets the second attack (and the attack transient) through;
    // anything at or above the 40ms spacing collapses them into one event.
    expect(counts[0]!).toBeGreaterThan(1);
    expect(counts.slice(1)).toEqual([1, 1, 1]);
  });

  it("never reports two onsets closer together than the interval", () => {
    for (const minIntervalMs of [60, 125, 180, 300]) {
      const { signal } = repeatedAttacks({ hz: 196, count: 10, spacingMs: 125, decayMs: 90 });
      const { onsetsMs } = collectOnsets(signal, 256, makeDetector({ minIntervalMs }));
      for (let i = 1; i < onsetsMs.length; i++) {
        expect(
          onsetsMs[i]! - onsetsMs[i - 1]!,
          `minIntervalMs=${minIntervalMs}`
        ).toBeGreaterThanOrEqual(minIntervalMs);
      }
    }
  });

  it("uses the supplied timestamps, not elapsed calls", () => {
    // Same signal, same hop, but timestamps scaled 10x: the gate must follow
    // the timestamps. `src/core/` reads no clock, so this is the only input.
    const { signal } = repeatedAttacks({ hz: 196, count: 6, spacingMs: 300, decayMs: 220 });
    const detector = makeDetector({ minIntervalMs: 2000 });
    const frame = new Float32Array(FFT);
    let onsets = 0;
    for (let start = 0; start + FFT <= signal.length; start += 256) {
      frame.set(signal.subarray(start, start + FFT));
      if (detector.process(frame, ((start + FFT) / SR) * 1000).isOnset) onsets++;
    }
    // 6 attacks 300ms apart, all inside a single 2000ms gate window.
    expect(onsets).toBe(1);
  });
});

describe("silence and noise", () => {
  it("reports nothing for digital silence", () => {
    const { onsetsMs, maxFlux } = collectOnsets(new Float32Array(SR), 256);
    expect(onsetsMs).toEqual([]);
    expect(maxFlux).toBe(0);
  });

  it("reports nothing further once a noise floor is established", () => {
    // The first frame is audio appearing out of nothing, which is an onset.
    // What must not happen is the noise floor retriggering.
    for (const amp of [0.0005, 0.002, 0.01]) {
      const { onsetsMs } = collectOnsets(whiteNoise(SR, 4242, amp), 256);
      expect(onsetsMs.length, `amp=${amp}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("detector mechanics", () => {
  it("reset() restores the initial state", () => {
    const detector = makeDetector();
    const { signal } = repeatedAttacks({ hz: 110, count: 4, spacingMs: 300, decayMs: 220 });
    const first = collectOnsets(signal, 256, detector).onsetsMs;
    detector.reset();
    const afterReset = collectOnsets(signal, 256, detector).onsetsMs;
    expect(afterReset).toEqual(first);
    expect(first).toHaveLength(4);
  });

  it("reset() clears the inter-onset gate as well as the spectrum", () => {
    const detector = makeDetector({ minIntervalMs: 5000 });
    const { signal } = repeatedAttacks({ hz: 110, count: 2, spacingMs: 300, decayMs: 220 });
    expect(collectOnsets(signal, 256, detector).onsetsMs).toHaveLength(1);
    detector.reset();
    expect(collectOnsets(signal, 256, detector).onsetsMs).toHaveLength(1);
  });

  it("exposes windowSize equal to fftSize and rejects other lengths", () => {
    const detector = makeDetector();
    expect(detector.windowSize).toBe(FFT);
    expect(() => detector.process(new Float32Array(FFT - 1), 0)).toThrow();
    expect(() => detector.process(new Float32Array(FFT * 2), 0)).toThrow();
  });

  it("always returns a non-negative flux and a positive threshold", () => {
    const { signal } = repeatedAttacks({ hz: 196, count: 4, spacingMs: 300, decayMs: 220 });
    for (const r of collectOnsets(signal, 256).results) {
      expect(r.flux).toBeGreaterThanOrEqual(0);
      expect(r.threshold).toBeGreaterThan(0);
      expect(Number.isFinite(r.flux)).toBe(true);
      expect(Number.isFinite(r.threshold)).toBe(true);
    }
  });

  it("rejects an impossible configuration at construction", () => {
    expect(() => makeDetectorWith({ fftSize: 1000 })).toThrow();
    expect(() => makeDetectorWith({ sampleRate: 0 })).toThrow();
    expect(() => makeDetectorWith({ medianWindow: 0 })).toThrow();
  });
});

function makeDetectorWith(over: Partial<ConstructorParameters<typeof OnsetDetector>[0]>): OnsetDetector {
  return new OnsetDetector({
    sampleRate: SR,
    fftSize: FFT,
    minIntervalMs: 60,
    medianWindow: 17,
    sensitivity: 1.6,
    ...over,
  });
}
