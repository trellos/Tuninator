/**
 * Articulation: what makes one Note two, and what makes two Notes one.
 *
 * Every case here is a pair of signals that a naive detector cannot tell apart,
 * which is the whole reason the fast lane reports separate witnesses instead of
 * a single "onset" boolean:
 *
 *  - a bend and a legato step have identical total displacement,
 *  - a re-pick and sustain ripple both raise spectral flux,
 *  - a muted restrum over a ringing chord is *quieter* than what it interrupts,
 *    so an energy test alone calls it nothing at all.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG, RENDER_QUANTUM } from "../../src/engine/config.js";
import { RecognitionEngine } from "../../src/engine/engine.js";
import type { Note } from "../../src/types.js";

const SAMPLE_RATE = 48000;
const ms = (value: number): number => Math.round((value / 1000) * SAMPLE_RATE);

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function silence(samples: number): Float32Array {
  return new Float32Array(samples);
}

/** A sawtooth built from a phase accumulator, so the frequency may vary. */
function tone(
  samples: number,
  hzAt: (i: number) => number,
  ampAt: (i: number) => number
): Float32Array {
  const out = new Float32Array(samples);
  let phase = 0;
  for (let i = 0; i < samples; i++) {
    phase += hzAt(i) / SAMPLE_RATE;
    out[i] = ampAt(i) * (2 * (phase % 1) - 1);
  }
  return out;
}

function steady(hz: number, samples: number, amplitude = 0.3): Float32Array {
  return tone(samples, () => hz, () => amplitude);
}

/**
 * A plucked string: a short broadband pick transient, then a decaying tone.
 *
 * The transient matters. A pick striking a string is mostly noise for the first
 * few milliseconds, and that noise is what a spectral-flux detector actually
 * sees — a synthesised tone that simply switches on is a much *easier* target
 * than real playing, so testing against one would flatter the detector.
 */
function pluck(hz: number, samples: number, amplitude = 0.35, tauMs = 500): Float32Array {
  const tau = (tauMs / 1000) * SAMPLE_RATE;
  const out = tone(samples, () => hz, (i) => amplitude * Math.exp(-i / tau));
  const pickSamples = Math.min(samples, ms(4));
  const random = lcg(hz * 1000 + samples);
  for (let i = 0; i < pickSamples; i++) {
    const envelope = 1 - i / pickSamples;
    out[i] = (out[i] as number) + amplitude * 0.9 * envelope * (random() * 2 - 1);
  }
  return out;
}

/** Deterministic LCG, so "noisy" tests fail the same way every run. */
function lcg(seed: number): () => number {
  let state = Math.floor(seed) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function notesOf(signal: Float32Array): Note[] {
  const engine = new RecognitionEngine(SAMPLE_RATE, DEFAULT_ENGINE_CONFIG);
  const out: Note[] = [];
  const drain = (emissions: ReturnType<RecognitionEngine["processChunk"]>["emissions"]): void => {
    for (const emission of emissions) if (emission.type === "ended") out.push(emission.note);
  };
  for (let offset = 0; offset < signal.length; offset += RENDER_QUANTUM) {
    const block = new Float32Array(RENDER_QUANTUM);
    block.set(signal.subarray(offset, Math.min(offset + RENDER_QUANTUM, signal.length)));
    drain(engine.processChunk(block, offset).emissions);
  }
  drain(engine.flush().emissions);
  return out;
}

describe("bend versus legato step", () => {
  // Both move 200 cents from A3. Only the rate differs, which is exactly why
  // total displacement cannot be the discriminator.
  const bend = tone(
    ms(800),
    (i) => 220 * Math.pow(2, (Math.min(1, i / ms(500)) * 200) / 1200),
    () => 0.3
  );
  const step = concat(steady(220, ms(400)), steady(246.94, ms(400)));

  it("a bend is one Note", () => {
    const notes = notesOf(concat(silence(ms(300)), bend, silence(ms(300))));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.bend?.direction).toBe("up");
  });

  it("a step of the same size is two Notes", () => {
    const notes = notesOf(concat(silence(ms(300)), step, silence(ms(300))));
    expect(notes.length).toBeGreaterThanOrEqual(2);
  });

  it("a bend is not chopped up by the flux it generates", () => {
    // Sweeping the spectrum spikes spectral flux and lifts RMS, so both attack
    // witnesses fire mid-bend. Two such firings were measured inside a single
    // A3->B3 bend on the lead fixture, and treating them as attacks chopped one
    // bent note into four.
    const notes = notesOf(concat(silence(ms(300)), bend, silence(ms(300))));
    expect(notes).toHaveLength(1);
  });

  it("vibrato is neither a bend nor a split", () => {
    const vibrato = tone(
      ms(900),
      (i) => 220 * Math.pow(2, (15 * Math.sin((2 * Math.PI * 5 * i) / SAMPLE_RATE)) / 1200),
      () => 0.3
    );
    const notes = notesOf(concat(silence(ms(300)), vibrato, silence(ms(300))));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.pitch.current?.pitchClass).toBe("A");
  });
});

describe("re-articulation at an unchanging pitch", () => {
  it("a re-picked note is two Notes", () => {
    const notes = notesOf(
      concat(silence(ms(300)), pluck(220, ms(500)), pluck(220, ms(500)), silence(ms(300)))
    );
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.every((n) => n.pitch.current?.pitchClass === "A")).toBe(true);
  });

  it("a restrum quieter than what it interrupts is still a new Note", () => {
    // The muted upstrum case. A re-pick at 60% of the ringing level: an energy
    // test alone sees a fall, not a rise, and reports one long Note.
    const first = pluck(220, ms(500), 0.4, 900);
    const second = pluck(220, ms(500), 0.22, 900);
    const notes = notesOf(concat(silence(ms(300)), first, second, silence(ms(300))));
    expect(notes.length).toBeGreaterThanOrEqual(2);
  });

  it("a decaying note is not split by its own decay", () => {
    const notes = notesOf(concat(silence(ms(300)), pluck(220, ms(2500), 0.4, 700), silence(ms(300))));
    expect(notes).toHaveLength(1);
  });

  it("a long steady tone is one Note however long it is held", () => {
    const notes = notesOf(concat(silence(ms(300)), steady(220, ms(3000)), silence(ms(300))));
    expect(notes).toHaveLength(1);
  });
});

describe("fast runs", () => {
  it("resolves 125ms sixteenths as separate Notes", () => {
    const run = concat(
      pluck(440, ms(125), 0.35, 250),
      pluck(493.88, ms(125), 0.35, 250),
      pluck(554.37, ms(125), 0.35, 250),
      pluck(493.88, ms(125), 0.35, 250),
      pluck(440, ms(125), 0.35, 250)
    );
    const notes = notesOf(concat(silence(ms(300)), run, silence(ms(400))));
    expect(notes.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps Note boundaries close to the real attacks in a run", () => {
    const noteMs = 125;
    const run = concat(
      pluck(440, ms(noteMs), 0.35, 250),
      pluck(493.88, ms(noteMs), 0.35, 250),
      pluck(554.37, ms(noteMs), 0.35, 250),
      pluck(493.88, ms(noteMs), 0.35, 250)
    );
    const notes = notesOf(concat(silence(ms(300)), run, silence(ms(400))));
    // Real boundaries are 300, 425, 550, 675. Every Note must start nearer its
    // own boundary than the next one, or the run has slipped by a whole note.
    for (const note of notes.slice(0, 4)) {
      const nearest = [300, 425, 550, 675].reduce(
        (best, edge) => (Math.abs(edge - note.startTime) < Math.abs(best - note.startTime) ? edge : best),
        300
      );
      expect(Math.abs(note.startTime - nearest)).toBeLessThan(noteMs / 2);
    }
  });
});

describe("overlap", () => {
  it("a Note that ends and one that begins never share a span", () => {
    const notes = notesOf(
      concat(silence(ms(300)), pluck(220, ms(500)), pluck(293.66, ms(500)), silence(ms(300)))
    );
    for (let i = 1; i < notes.length; i++) {
      const previous = notes[i - 1] as Note;
      const current = notes[i] as Note;
      expect(current.startTime).toBeGreaterThanOrEqual(previous.startTime);
      expect(previous.endTime).not.toBeNull();
    }
  });

  it("no Note ends before it started", () => {
    const notes = notesOf(
      concat(silence(ms(300)), pluck(220, ms(400)), pluck(246.94, ms(400)), pluck(220, ms(400)))
    );
    for (const note of notes) {
      expect(note.endTime as number).toBeGreaterThanOrEqual(note.startTime);
    }
  });
});
