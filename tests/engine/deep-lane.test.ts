/**
 * The deep lane's contract with time.
 *
 * The interesting properties are not about spectra — those are the chroma
 * kernel's tests — but about *when*: a job queued about one window of audio
 * must analyse that window however long it took to run, must be dropped rather
 * than answered wrongly once its audio has aged out, and must produce the same
 * results on every replay.
 */

import { describe, expect, it } from "vitest";
import { SampleClock } from "../../src/engine/clock.js";
import { DEFAULT_ENGINE_CONFIG } from "../../src/engine/config.js";
import { DeepLane } from "../../src/engine/deep/deep-lane.js";
import { AudioRing } from "../../src/engine/ring-buffer.js";

const SAMPLE_RATE = 48000;

function lane(): { deep: DeepLane; ring: AudioRing; clock: SampleClock } {
  const clock = new SampleClock(SAMPLE_RATE);
  return {
    clock,
    deep: new DeepLane(clock, DEFAULT_ENGINE_CONFIG),
    ring: new AudioRing(SAMPLE_RATE),
  };
}

/** A chord, so the analysis has something real to say. */
function chord(midis: readonly number[], samples: number): Float32Array {
  const out = new Float32Array(samples);
  for (const midi of midis) {
    const hz = 440 * Math.pow(2, (midi - 69) / 12);
    const period = SAMPLE_RATE / hz;
    for (let i = 0; i < samples; i++) {
      out[i] = (out[i] as number) + 0.12 * (2 * ((i % period) / period) - 1);
    }
  }
  return out;
}

describe("scheduling", () => {
  it("runs nothing before its time", () => {
    const { deep, ring } = lane();
    ring.write(chord([48, 55, 60], 8192));
    deep.request({
      noteId: "n1", purpose: "harmony",
      fromSample: 0, toSample: deep.windowSize, notBefore: 500,
    });
    expect(deep.drain(499, ring).results).toHaveLength(0);
    expect(deep.pendingCount).toBe(1);
    expect(deep.drain(500, ring).results).toHaveLength(1);
    expect(deep.pendingCount).toBe(0);
  });

  it("analyses the audio it was queued about, not the newest audio", () => {
    // The whole reason jobs carry a sample range. A job queued at 4.10s and run
    // at 4.25s must describe the music it was queued about.
    const { deep, ring } = lane();
    const window = DEFAULT_ENGINE_CONFIG.harmony.fftSize;
    ring.write(chord([48, 55, 60], window)); // C
    deep.request({
      noteId: "n1", purpose: "harmony",
      fromSample: 0, toSample: window, notBefore: 0,
    });
    ring.write(chord([50, 57, 62], window)); // D, written after queueing

    const result = deep.drain(1e9, ring).results[0];
    expect(result?.reading.root).toBe("C");
  });

  it("drops a job whose audio has aged out rather than answering wrongly", () => {
    const { deep } = lane();
    const ring = new AudioRing(8192);
    ring.write(chord([48, 55, 60], 8192));
    deep.request({
      noteId: "n1", purpose: "harmony",
      fromSample: 0, toSample: deep.windowSize, notBefore: 0,
    });
    ring.write(chord([50, 57, 62], 8192)); // pushes the queued range out

    const drain = deep.drain(1e9, ring);
    expect(drain.results).toHaveLength(0);
    expect(drain.dropped).toBe(1);
  });

  it("coalesces a repeated request for the same window", () => {
    const { deep } = lane();
    const request = {
      noteId: "n1", purpose: "harmony" as const,
      fromSample: 0, toSample: 4096, notBefore: 0,
    };
    deep.request(request);
    deep.request(request);
    expect(deep.pendingCount).toBe(1);
  });

  it("keeps successive windows of the same Note", () => {
    // A chord's identity is voted on across its whole life; coalescing these
    // would throw away the readings that separate a Bm from the B5 its decayed
    // tail looks like.
    const { deep } = lane();
    deep.request({ noteId: "n1", purpose: "harmony", fromSample: 0, toSample: 4096, notBefore: 0 });
    deep.request({ noteId: "n1", purpose: "harmony", fromSample: 640, toSample: 4736, notBefore: 0 });
    expect(deep.pendingCount).toBe(2);
  });

  it("reports which Notes it still owes an answer to", () => {
    const { deep, ring } = lane();
    ring.write(chord([48, 55, 60], 8192));
    deep.request({ noteId: "n1", purpose: "harmony", fromSample: 0, toSample: 4096, notBefore: 100 });
    expect([...deep.busyNoteIds()]).toEqual(["n1"]);
    deep.drain(100, ring);
    expect(deep.busyNoteIds().size).toBe(0);
  });

  it("forgets a Note's work when the Note is gone", () => {
    const { deep } = lane();
    deep.request({ noteId: "n1", purpose: "harmony", fromSample: 0, toSample: 4096, notBefore: 0 });
    deep.request({ noteId: "n2", purpose: "harmony", fromSample: 0, toSample: 4096, notBefore: 0 });
    deep.forget("n1");
    expect([...deep.busyNoteIds()]).toEqual(["n2"]);
  });

  it("timestamps a result by the audio it describes, not by when it ran", () => {
    const { deep, ring, clock } = lane();
    ring.write(chord([48, 55, 60], 16384));
    const toSample = 8192;
    deep.request({
      noteId: "n1", purpose: "harmony",
      fromSample: toSample - deep.windowSize, toSample, notBefore: 0,
    });
    const result = deep.drain(9999, ring).results[0];
    expect(result?.at).toBeCloseTo(clock.toMs(toSample), 6);
  });
});

describe("determinism", () => {
  it("replays identically", () => {
    // There is no clock in the engine, so "150ms later" means 150ms of audio
    // later — which is what makes an offline run reproducible bit for bit.
    const run = (): string => {
      const { deep, ring } = lane();
      ring.write(chord([48, 55, 60, 64, 67], 16384));
      for (let i = 0; i < 4; i++) {
        deep.request({
          noteId: "n1", purpose: "harmony",
          fromSample: i * 640, toSample: i * 640 + deep.windowSize, notBefore: i * 13,
        });
      }
      return deep
        .drain(1e9, ring)
        .results.map((r) => `${r.at.toFixed(6)}:${r.reading.chordName}:${r.reading.confidence.toFixed(9)}`)
        .join("|");
    };
    expect(run()).toBe(run());
    expect(run().length).toBeGreaterThan(0);
  });
});

describe("what it hears", () => {
  it("finds the voicing with its register intact", () => {
    const { deep, ring } = lane();
    ring.write(chord([48, 52, 55], 16384)); // C3 E3 G3
    deep.request({
      noteId: "n1", purpose: "harmony",
      fromSample: 8192 - deep.windowSize, toSample: 8192, notBefore: 0,
    });
    const result = deep.drain(1e9, ring).results[0];
    expect(result).toBeDefined();
    const activations = result?.activations ?? [];
    expect(activations.length).toBeGreaterThan(1);
    // Register, not pitch class: every activation names an octave, and the
    // lowest of them is down in the third octave where it was played.
    for (const activation of activations) {
      expect(Number.isInteger(activation.octave)).toBe(true);
      expect(Number.isInteger(activation.midi)).toBe(true);
    }
    expect(Math.min(...activations.map((a) => a.midi))).toBeLessThanOrEqual(52);
  });

  it("reports the voices' spread, which is what a chord looks like", () => {
    const { deep, ring } = lane();
    ring.write(chord([40, 47, 52], 16384));
    deep.request({
      noteId: "n1", purpose: "harmony",
      fromSample: 8192 - deep.windowSize, toSample: 8192, notBefore: 0,
    });
    const result = deep.drain(1e9, ring).results[0];
    expect(result?.evidence.voiceSpreadSemitones ?? 0).toBeGreaterThan(6);
  });
});
