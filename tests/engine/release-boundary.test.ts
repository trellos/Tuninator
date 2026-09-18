/**
 * A slow pick stroke on a direct input is two events: the pick lands on the
 * string and mutes it, then lets go and the note sounds. The boundary belongs
 * on the release. See `tracking.releaseRiseRatio`.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG, RENDER_QUANTUM, type EngineConfig } from "../../src/engine/config.js";
import { RecognitionEngine } from "../../src/engine/engine.js";
import type { Note } from "../../src/types.js";

const SAMPLE_RATE = 48000;
const ms = (value: number): number => Math.round((value / 1000) * SAMPLE_RATE);

function sawtooth(hz: number, samples: number, amplitude: number): Float32Array {
  const out = new Float32Array(samples);
  const period = SAMPLE_RATE / hz;
  for (let i = 0; i < samples; i++) out[i] = amplitude * (2 * ((i % period) / period) - 1);
  return out;
}

/** A plucked note: sharp attack, exponential decay, like a real string. */
function pluck(hz: number, samples: number, amplitude = 0.35, tauMs = 400): Float32Array {
  const out = sawtooth(hz, samples, amplitude);
  const tau = (tauMs / 1000) * SAMPLE_RATE;
  for (let i = 0; i < samples; i++) out[i] = (out[i] as number) * Math.exp(-i / tau);
  return out;
}

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

function run(signal: Float32Array, config: EngineConfig): Note[] {
  const engine = new RecognitionEngine(SAMPLE_RATE, config);
  const ended: Note[] = [];
  const collect = (emissions: ReturnType<RecognitionEngine["processChunk"]>["emissions"]): void => {
    for (const emission of emissions) if (emission.type === "ended") ended.push(emission.note);
  };
  for (let offset = 0; offset < signal.length; offset += RENDER_QUANTUM) {
    const block = new Float32Array(RENDER_QUANTUM);
    block.set(signal.subarray(offset, Math.min(offset + RENDER_QUANTUM, signal.length)));
    collect(engine.processChunk(block, offset).emissions);
  }
  collect(engine.flush().emissions);
  return ended.sort((a, b) => a.startTime - b.startTime);
}

const withRatio = (ratio: number): EngineConfig => ({
  ...DEFAULT_ENGINE_CONFIG,
  tracking: { ...DEFAULT_ENGINE_CONFIG.tracking, releaseRiseRatio: ratio },
});

/** The pick landing: a short broadband click, then the string damped under it. */
function contact(hz: number, samples: number): Float32Array {
  const out = sawtooth(hz, samples, 0.35 / 30);
  let seed = 7;
  for (let i = 0; i < ms(3); i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = 0.25 * ((seed / 0x7fffffff) * 2 - 1);
  }
  return out;
}

/**
 * A4 held, then the pick lands on it — a click, then 60ms of the string
 * damped to a thirtieth of its level — then lets go: the same note again at
 * full level. The release is at 300 + 400 + 60 = 760ms.
 */
const CONTACT_MS = 60;
const RELEASE_AT = 300 + 400 + CONTACT_MS;
const stroke = concat(
  new Float32Array(ms(300)),
  pluck(220, ms(400)),
  contact(220, ms(CONTACT_MS)),
  pluck(220, ms(500)),
  new Float32Array(ms(300))
);

describe("a pick's contact and its release", () => {
  it("the second Note starts on the release, not on the contact", () => {
    const notes = run(stroke, DEFAULT_ENGINE_CONFIG);
    expect(notes.length).toBe(2);
    const second = notes[1] as Note;
    expect(Math.abs(second.startTime - RELEASE_AT)).toBeLessThanOrEqual(15);
  });

  it("with the rule off the boundary sits on the contact, which is what it repairs", () => {
    const notes = run(stroke, withRatio(0));
    const second = notes[notes.length - 1] as Note;
    expect(second.startTime).toBeLessThan(RELEASE_AT - 30);
  });

  it("does not move a note that was simply picked quietly and then louder", () => {
    // Two strokes 200ms apart, the first at a third of the level: a real
    // quiet note followed by a loud one is two Notes with their own starts.
    const two = concat(
      new Float32Array(ms(300)),
      pluck(220, ms(200), 0.12),
      pluck(220, ms(400)),
      new Float32Array(ms(300))
    );
    const notes = run(two, DEFAULT_ENGINE_CONFIG);
    expect(notes.length).toBe(2);
    expect(Math.abs((notes[0] as Note).startTime - 300)).toBeLessThanOrEqual(15);
    expect(Math.abs((notes[1] as Note).startTime - 500)).toBeLessThanOrEqual(15);
  });
});
