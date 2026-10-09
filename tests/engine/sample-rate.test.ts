/**
 * The same audio gives the same Notes at any capture rate (DECISION-088).
 *
 * The engine's windows, FFT lengths, hop and per-hop rates were tuned at
 * 48kHz and many are counted in samples, bins or hops, so a 44.1kHz context
 * used to hear a differently tuned recognizer: 43 more missed labels on the
 * corpus, and on eighth-note triplets an onset reported 67ms late at one rate
 * and on time at the other. The engine now resamples to `ANALYSIS_SAMPLE_RATE`
 * on the way in. These tests render one score analytically at each rate — the
 * same sound, not a resampled copy — and require the same Notes from it.
 *
 * `scripts/measure-sample-rate-invariance.ts` asks the same of the recorded
 * corpus.
 */

import { describe, expect, it } from "vitest";
import { ANALYSIS_SAMPLE_RATE, RENDER_QUANTUM, resolveEngineConfig } from "../../src/engine/config.js";
import { RecognitionEngine } from "../../src/engine/engine.js";
import { Resampler } from "../../src/engine/resampler.js";
import type { Note } from "../../src/types.js";

const RATES = [44100, 48000, 88200, 96000] as const;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Pluck = { midi: number; at: number; duration: number };

/**
 * Eighth-note triplets in G2-G3 at 120bpm, 167ms apart: the material a
 * consumer's game saw go wrong at 48kHz, and where it did on the bench.
 */
function score(count: number, seed: number): Pluck[] {
  const rand = lcg(seed);
  const scale = [43, 45, 47, 48, 50, 52, 54, 55];
  const ioi = 60 / 120 / 3;
  return Array.from({ length: count }, (_, i) => ({
    midi: scale[Math.floor(rand() * scale.length)] as number,
    at: 0.5 + i * ioi,
    duration: ioi * 0.9,
  }));
}

/** Six harmonics, a 3ms attack, a 50ms release: a function of time, not of samples. */
function render(plucks: readonly Pluck[], sampleRate: number): Float32Array {
  const last = plucks[plucks.length - 1] as Pluck;
  const out = new Float32Array(Math.ceil((last.at + last.duration + 0.6) * sampleRate));
  for (const p of plucks) {
    const f0 = 440 * 2 ** ((p.midi - 69) / 12);
    const from = Math.ceil(p.at * sampleRate);
    const to = Math.min(out.length, Math.ceil((p.at + p.duration + 0.05) * sampleRate));
    for (let i = from; i < to; i++) {
      const t = i / sampleRate - p.at;
      const release = t > p.duration ? Math.max(0, 1 - (t - p.duration) / 0.05) : 1;
      const env = Math.min(1, t / 0.003) * Math.exp(-t * 6) * release;
      let s = 0;
      for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h;
      out[i] = (out[i] ?? 0) + 0.3 * env * s;
    }
  }
  return out;
}

/** Fed exactly as a worklet would: 128-sample quanta, positions in capture samples. */
function recognise(samples: Float32Array, sampleRate: number): Note[] {
  const engine = new RecognitionEngine(sampleRate, resolveEngineConfig());
  const notes: Note[] = [];
  const block = new Float32Array(RENDER_QUANTUM);
  const collect = (out: ReturnType<RecognitionEngine["processChunk"]>): void => {
    for (const e of out.emissions) if (e.type === "resolved") notes.push(e.note);
  };
  for (let offset = 0; offset < samples.length; offset += RENDER_QUANTUM) {
    block.fill(0);
    block.set(samples.subarray(offset, Math.min(samples.length, offset + RENDER_QUANTUM)));
    collect(engine.processChunk(block, offset));
  }
  collect(engine.flush());
  return notes.sort((a, b) => a.startTime - b.startTime);
}

describe("the same audio at any capture rate", () => {
  const plucks = score(36, 120);
  const byRate = new Map(RATES.map((rate) => [rate, recognise(render(plucks, rate), rate)]));
  const reference = byRate.get(48000) as Note[];

  it("hears every pluck at 48kHz, the rate the engine is tuned at", () => {
    expect(reference.length).toBeGreaterThanOrEqual(plucks.length - 2);
  });

  for (const rate of RATES.filter((r) => r !== 48000)) {
    it(`gives the 48kHz Notes at ${rate / 1000}kHz: same count and pitches, times within 3ms`, () => {
      const notes = byRate.get(rate) as Note[];
      expect(notes.map((n) => n.pitch.current?.name)).toEqual(
        reference.map((n) => n.pitch.current?.name)
      );
      notes.forEach((note, i) => {
        const ref = reference[i] as Note;
        expect(Math.abs(note.startTime - ref.startTime)).toBeLessThanOrEqual(3);
        expect(Math.abs((note.endTime ?? 0) - (ref.endTime ?? 0))).toBeLessThanOrEqual(3);
      });
    });
  }

  it("reports the capture rate as the timebase, and analyses at 48kHz", () => {
    const engine = new RecognitionEngine(44100, resolveEngineConfig(), 1.5);
    expect(engine.getTimebase()).toEqual({ sampleRate: 44100, originContextTime: 1.5 });
    expect(engine.sampleRate).toBe(44100);
    expect(engine.clock.sampleRate).toBe(ANALYSIS_SAMPLE_RATE);
    engine.processChunk(new Float32Array(RENDER_QUANTUM), 0);
    expect(engine.position).toBe(RENDER_QUANTUM);
  });

  it("fills a gap in capture samples, so time after it stays the source's", () => {
    const rate = 44100;
    const audio = render(plucks.slice(0, 6), rate);
    const gapAt = Math.round(0.4 * rate);
    const engine = new RecognitionEngine(rate, resolveEngineConfig());
    const starts: number[] = [];
    for (let offset = 0; offset < audio.length; offset += RENDER_QUANTUM) {
      // Drop the blocks covering 0.4-0.45s, a lost worklet message or two.
      if (offset >= gapAt && offset < gapAt + 0.05 * rate) continue;
      const block = new Float32Array(RENDER_QUANTUM);
      block.set(audio.subarray(offset, Math.min(audio.length, offset + RENDER_QUANTUM)));
      for (const e of engine.processChunk(block, offset).emissions) {
        if (e.type === "started") starts.push(e.note.startTime);
      }
    }
    const expected = recognise(audio, rate).map((n) => n.startTime);
    expect(starts.length).toBe(expected.length);
    starts.forEach((s, i) => expect(Math.abs(s - (expected[i] as number))).toBeLessThanOrEqual(3));
  });
});

describe("Resampler", () => {
  const OUT = 48000;

  for (const rate of [22050, 44100, 44101, 88200, 96000, 192000]) {
    it(`carries a 440Hz sine from ${rate}Hz at unit gain and on time`, () => {
      const r = new Resampler(rate, OUT);
      const input = new Float32Array(rate / 4 | 0).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / rate));
      const out = r.push(input);
      // Output n is the input at n / 48000 seconds; skip the edge transient.
      let worst = 0;
      for (let n = 200; n < out.length; n++) {
        worst = Math.max(worst, Math.abs((out[n] as number) - Math.sin((2 * Math.PI * 440 * n) / OUT)));
      }
      // Everything up to halfWidth input samples from the end is out.
      expect(out.length).toBeGreaterThanOrEqual(
        Math.floor(((input.length - r.halfWidth - 1) * OUT) / rate)
      );
      expect(worst).toBeLessThan(1e-3);
    });
  }

  it("does not depend on how the input was chunked", () => {
    const rate = 44100;
    const input = new Float32Array(20000).map((_, i) => Math.sin(i * 0.05) + 0.3 * Math.sin(i * 0.71));
    const whole = new Resampler(rate, OUT).push(input);
    const r = new Resampler(rate, OUT);
    const rand = lcg(3);
    const parts: number[] = [];
    for (let i = 0; i < input.length; ) {
      const n = 1 + Math.floor(rand() * 700);
      parts.push(...r.push(input.subarray(i, Math.min(input.length, i + n))));
      i += n;
    }
    expect(parts.length).toBe(whole.length);
    expect(Float32Array.from(parts)).toEqual(whole);
  });

  it("steps positions exactly, so a long stream does not drift off the source timeline", () => {
    // 147 inputs per 160 outputs, in integers: output n sits at input
    // floor(147n / 160) and is out once input up to there + halfWidth is in.
    const r = new Resampler(44100, OUT);
    let produced = 0;
    const block = new Float32Array(44100);
    for (let s = 0; s < 60; s++) produced += r.push(block).length;
    const newestUsable = 60 * 44100 - 1 - r.halfWidth;
    expect(produced).toBe(Math.ceil(((newestUsable + 1) * 160) / 147));
  });
});
