/**
 * The general-purpose library: audio in, results out, no platform.
 *
 * The load-bearing property here is that `analyze()` does not care how the
 * caller chunks its audio. A worklet hands over 128 samples at a time; a file
 * reader might hand over 65536. Both must produce the same analysis, or the
 * offline eval stops predicting live behaviour — which is the one thing this
 * architecture exists to guarantee.
 */

import { describe, expect, it } from "vitest";
import { Tuninator, type AnalysisResult } from "../src/tuninator.js";
import { resolvePolicy } from "../src/core/policy.js";

const SAMPLE_RATE = 48000;
const RENDER_QUANTUM = 128;

/** A sawtooth: harmonically rich, so YIN has something real to lock onto. */
function saw(hz: number, samples: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(samples);
  const period = SAMPLE_RATE / hz;
  for (let i = 0; i < samples; i++) {
    out[i] = amplitude * (2 * ((i % period) / period) - 1);
  }
  return out;
}

function feed(tuninator: Tuninator, signal: Float32Array, blockSize: number): AnalysisResult[] {
  const results: AnalysisResult[] = [];
  for (let offset = 0; offset < signal.length; offset += blockSize) {
    const block = signal.subarray(offset, Math.min(offset + blockSize, signal.length));
    const timestampMs = (offset / SAMPLE_RATE) * 1000;
    results.push(...tuninator.analyze(block, timestampMs));
  }
  return results;
}

describe("Tuninator", () => {
  it("reports the hop it snapped to", () => {
    const tuninator = new Tuninator({ sampleRate: SAMPLE_RATE });
    expect(tuninator.hopSamples % RENDER_QUANTUM).toBe(0);
    expect(tuninator.sampleRate).toBe(SAMPLE_RATE);
  });

  it("returns nothing for an empty block", () => {
    const tuninator = new Tuninator({ sampleRate: SAMPLE_RATE });
    expect(tuninator.analyze(new Float32Array(0), 0)).toEqual([]);
  });

  it("returns nothing between hop boundaries", () => {
    const tuninator = new Tuninator({ sampleRate: SAMPLE_RATE });
    // One render quantum is far shorter than a hop, so the first few produce
    // nothing at all.
    expect(tuninator.analyze(saw(220, RENDER_QUANTUM), 0)).toHaveLength(0);
  });

  describe("block size independence", () => {
    // A whole number of hops, so both chunkings land on the same boundaries.
    const signal = saw(220, 640 * 40);

    it("produces identical analysis whether fed in quanta or in one big block", () => {
      const small = feed(new Tuninator({ sampleRate: SAMPLE_RATE }), signal, RENDER_QUANTUM);
      const huge = feed(new Tuninator({ sampleRate: SAMPLE_RATE }), signal, signal.length);

      expect(huge.length).toBe(small.length);
      // Pitch and level must agree exactly: the same samples reach the detector
      // in the same order, so anything else would mean the chunking changed
      // what was analysed.
      expect(huge.map((r) => [r.frame.frequencyHz, r.frame.amplitude.rms])).toEqual(
        small.map((r) => [r.frame.frequencyHz, r.frame.amplitude.rms])
      );
      // Timestamps agree to the last ulp rather than bit-exactly: one path adds
      // 512/48000 to 128/48000, the other divides 640/48000, and IEEE754 does
      // not promise those are the same double.
      huge.forEach((r, i) => {
        expect(r.frame.timestamp).toBeCloseTo(small[i]!.frame.timestamp, 9);
      });
    });

    it("holds for a block size that is neither a hop nor a quantum multiple", () => {
      const small = feed(new Tuninator({ sampleRate: SAMPLE_RATE }), signal, RENDER_QUANTUM);
      const odd = feed(new Tuninator({ sampleRate: SAMPLE_RATE }), signal, 1000);

      // A ragged block size puts the hop boundaries on different samples, so
      // the frames legitimately differ in detail. What must NOT happen is
      // losing hops, which is exactly what one hop-subtraction per push did.
      expect(odd.length).toBe(small.length);

      // And the pitch it lands on is still the pitch that was played.
      const voiced = odd.map((r) => r.frame.frequencyHz).filter((hz): hz is number => hz !== null);
      expect(voiced.length).toBeGreaterThan(20);
      for (const hz of voiced) {
        expect(Math.abs(1200 * Math.log2(hz / 220))).toBeLessThan(5);
      }
    });

    it("emits one frame per hop across a long oversized block", () => {
      const tuninator = new Tuninator({ sampleRate: SAMPLE_RATE });
      const hops = Math.floor(signal.length / tuninator.hopSamples);
      expect(feed(tuninator, signal, signal.length)).toHaveLength(hops);
    });
  });

  it("refuses a policy whose analysis window cannot fit the ring buffer", () => {
    const policy = resolvePolicy({ mode: "chords" });
    policy.chords.fftSize = 16384;
    expect(() => new Tuninator({ sampleRate: SAMPLE_RATE, policy })).toThrow(/ring buffer/);
  });

  it("rejects a nonsensical sample rate", () => {
    expect(() => new Tuninator({ sampleRate: 0 })).toThrow(/sampleRate/);
    expect(() => new Tuninator({ sampleRate: Number.NaN })).toThrow(/sampleRate/);
  });

  it("ends open events on flush", () => {
    const tuninator = new Tuninator({ sampleRate: SAMPLE_RATE });
    const signal = saw(220, 640 * 30);
    const results = feed(tuninator, signal, RENDER_QUANTUM);

    const started = results.flatMap((r) => r.emissions).filter((e) => e.type === "start");
    expect(started.length).toBeGreaterThan(0);

    const ends = tuninator.flush(1000).filter((e) => e.type === "end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.event.endedAt).toBe(1000);
    expect(tuninator.getActiveEvents()).toHaveLength(0);
  });

  it("reset ends the open event rather than losing it", () => {
    const tuninator = new Tuninator({ sampleRate: SAMPLE_RATE });
    feed(tuninator, saw(220, 640 * 30), RENDER_QUANTUM);
    expect(tuninator.getActiveEvents()).toHaveLength(1);

    const emissions = tuninator.reset(500);
    expect(emissions.filter((e) => e.type === "end")).toHaveLength(1);
    expect(tuninator.getActiveEvents()).toHaveLength(0);
  });

  it("swaps mode without discarding accumulated audio", () => {
    const tuninator = new Tuninator({ sampleRate: SAMPLE_RATE, mode: "lead" });
    feed(tuninator, saw(220, 640 * 20), RENDER_QUANTUM);
    expect(tuninator.getMode()).toBe("lead");

    tuninator.setMode("chords");
    expect(tuninator.getMode()).toBe("chords");
    expect(tuninator.getPolicy().chords.enabled).toBe(true);

    // The ring still holds the audio, so the very next hop still produces a
    // frame rather than waiting for the window to refill.
    const after = feed(tuninator, saw(220, 640 * 2), RENDER_QUANTUM);
    expect(after.length).toBeGreaterThan(0);
  });

  it("preserves caller-supplied timestamps", () => {
    const tuninator = new Tuninator({ sampleRate: SAMPLE_RATE });
    const results = tuninator.analyze(saw(220, 640 * 4), 10_000);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.frame.timestamp).toBeGreaterThanOrEqual(10_000);
  });
});
