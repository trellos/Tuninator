/**
 * The Note timeline: what starts a Note, what ends one, and what it is called.
 *
 * Successor to the monophonic half of the old `event-tracker.test.ts`. The
 * synthesised cases are the valuable part and they carry over almost verbatim;
 * what changed is the shape of the answer — Notes with a lifecycle and typed
 * changes rather than events with an envelope state.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG, RENDER_QUANTUM } from "../../src/engine/config.js";
import { RecognitionEngine } from "../../src/engine/engine.js";
import type { Note, NoteChange } from "../../src/types.js";

const SAMPLE_RATE = 48000;

type Run = {
  started: Note[];
  ended: Note[];
  changes: Array<{ note: Note; change: NoteChange }>;
  resolved: Note[];
};

function sawtooth(hz: number, samples: number, amplitude = 0.3): Float32Array {
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

function silence(samples: number): Float32Array {
  return new Float32Array(samples);
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

function run(signal: Float32Array): Run {
  const engine = new RecognitionEngine(SAMPLE_RATE, DEFAULT_ENGINE_CONFIG);
  const out: Run = { started: [], ended: [], changes: [], resolved: [] };
  const collect = (emissions: ReturnType<RecognitionEngine["processChunk"]>["emissions"]): void => {
    for (const emission of emissions) {
      if (emission.type === "started") out.started.push(emission.note);
      else if (emission.type === "ended") out.ended.push(emission.note);
      else if (emission.type === "resolved") out.resolved.push(emission.note);
      else out.changes.push({ note: emission.note, change: emission.change });
    }
  };
  for (let offset = 0; offset < signal.length; offset += RENDER_QUANTUM) {
    const block = new Float32Array(RENDER_QUANTUM);
    block.set(signal.subarray(offset, Math.min(offset + RENDER_QUANTUM, signal.length)));
    collect(engine.processChunk(block, offset).emissions);
  }
  collect(engine.flush().emissions);
  return out;
}

const ms = (value: number): number => Math.round((value / 1000) * SAMPLE_RATE);

describe("Note lifecycle", () => {
  it("a single sustained note is one Note, named after its pitch", () => {
    const result = run(concat(silence(ms(300)), sawtooth(220, ms(800)), silence(ms(300))));
    expect(result.ended).toHaveLength(1);
    const note = result.ended[0] as Note;
    expect(note.pitch.current?.name).toBe("A3");
    expect(note.lifecycle).toBe("ended");
    expect(note.endTime).not.toBeNull();
  });

  it("every ended Note was announced first, and resolved before it ended", () => {
    const result = run(concat(silence(ms(300)), sawtooth(220, ms(800)), silence(ms(300))));
    expect(result.started.map((n) => n.id)).toEqual(result.ended.map((n) => n.id));
    expect(result.resolved.map((n) => n.id)).toEqual(result.ended.map((n) => n.id));
  });

  it("records what triggered it and what it first looked like", () => {
    const result = run(concat(silence(ms(300)), sawtooth(220, ms(800)), silence(ms(300))));
    const note = result.ended[0] as Note;
    expect(note.origin.trigger).toBe("attack");
    expect(note.origin.firstDetectedPitch?.pitchClass).toBe("A");
  });

  it("origin is frozen even when the label is later revised", () => {
    const result = run(
      concat(silence(ms(300)), sawtooth(220, ms(500)), sawtooth(246.94, ms(500)), silence(ms(300)))
    );
    for (const note of result.ended) {
      const started = result.started.find((n) => n.id === note.id) as Note;
      expect(note.origin.firstDetectedPitch?.name).toBe(
        started.origin.firstDetectedPitch?.name
      );
      expect(note.origin.trigger).toBe(started.origin.trigger);
    }
  });

  it("ends a Note after silence rather than leaving it open forever", () => {
    const result = run(concat(silence(ms(300)), sawtooth(220, ms(500)), silence(ms(800))));
    const note = result.ended[0] as Note;
    expect(note.endTime).not.toBeNull();
    // The end is the moment it went quiet, not the moment the grace expired.
    expect(note.endTime as number).toBeLessThan(300 + 500 + 200);
  });

  it("does not announce a Note too short to have been played", () => {
    const result = run(concat(silence(ms(300)), sawtooth(220, ms(20)), silence(ms(400))));
    expect(result.started).toHaveLength(0);
    expect(result.ended).toHaveLength(0);
  });

  it("says nothing at all about silence", () => {
    const result = run(silence(ms(2000)));
    expect(result.started).toHaveLength(0);
    expect(result.ended).toHaveLength(0);
  });
});

describe("segmentation", () => {
  it("a legato step splits one sustain into two Notes", () => {
    // No re-attack anywhere: only the pitch moves. Attack-driven segmentation
    // alone would report this as one Note.
    const result = run(
      concat(silence(ms(300)), sawtooth(440, ms(400)), sawtooth(587.33, ms(400)), silence(ms(300)))
    );
    expect(result.ended.length).toBeGreaterThanOrEqual(2);
    const names = result.ended.map((n) => n.pitch.current?.name);
    expect(names).toContain("A4");
    expect(names).toContain("D5");
  });

  it("the second Note starts where the pitch changed, not where it was confirmed", () => {
    const result = run(
      concat(silence(ms(300)), sawtooth(440, ms(400)), sawtooth(587.33, ms(400)), silence(ms(300)))
    );
    const second = result.ended.find((n) => n.pitch.current?.name === "D5") as Note;
    expect(second).toBeDefined();
    // The real boundary is 700ms. A tracker that waits for its confirmation
    // frames without backdating lands 30-40ms late and compounds over a run.
    expect(Math.abs(second.startTime - 700)).toBeLessThan(70);
  });

  it("a re-picked note at the same pitch is two Notes, not one sustain", () => {
    const result = run(
      concat(silence(ms(300)), pluck(220, ms(400)), pluck(220, ms(400)), silence(ms(300)))
    );
    expect(result.ended.length).toBeGreaterThanOrEqual(2);
    expect(result.ended.every((n) => n.pitch.current?.pitchClass === "A")).toBe(true);
  });

  it("a steady tone is not chopped up by sustain ripple", () => {
    const result = run(concat(silence(ms(300)), sawtooth(220, ms(2000)), silence(ms(300))));
    expect(result.ended).toHaveLength(1);
  });
});

describe("labels and evidence", () => {
  it("labels from the weight of evidence, not from the last frame", () => {
    // The tail of a Note routinely bleeds into its neighbour when a boundary is
    // a hop late; labelling from the newest frame hands it the wrong name.
    const result = run(
      concat(silence(ms(300)), sawtooth(220, ms(900)), sawtooth(246.94, ms(60)), silence(ms(300)))
    );
    const first = result.ended[0] as Note;
    expect(first.pitch.current?.name).toBe("A3");
  });

  it("carries hypotheses for what it considered", () => {
    const result = run(concat(silence(ms(300)), sawtooth(220, ms(800)), silence(ms(300))));
    const note = result.ended[0] as Note;
    const all = [...note.hypotheses.active, ...note.hypotheses.trail];
    expect(all.some((h) => h.kind === "pitch" && h.label === "A3")).toBe(true);
    const leader = note.hypotheses.active[0];
    expect(leader).toBeDefined();
    expect(["leading", "confirmed"]).toContain((leader as { state: string }).state);
  });

  it("hands out snapshots a consumer cannot mutate into the tracker", () => {
    const result = run(concat(silence(ms(300)), sawtooth(220, ms(800)), silence(ms(300))));
    const started = result.started[0] as Note;
    const ended = result.ended[0] as Note;
    expect(started).not.toBe(ended);
    expect(ended.revision.revisionNumber).toBeGreaterThanOrEqual(
      started.revision.revisionNumber
    );
  });
});

describe("bends", () => {
  it("a bend stays one Note, with the excursion recorded", () => {
    // A whole-tone bend over 400ms, then held. Total displacement is identical
    // to a legato step; only the per-hop rate distinguishes them.
    const samples = ms(700);
    const out = new Float32Array(samples);
    const bendSamples = ms(400);
    let phase = 0;
    for (let i = 0; i < samples; i++) {
      const progress = Math.min(1, i / bendSamples);
      const hz = 220 * Math.pow(2, (progress * 200) / 1200);
      phase += hz / SAMPLE_RATE;
      out[i] = 0.3 * (2 * (phase % 1) - 1);
    }
    const result = run(concat(silence(ms(300)), out, silence(ms(300))));
    expect(result.ended).toHaveLength(1);
    const note = result.ended[0] as Note;
    expect(note.bend).toBeDefined();
    expect(Math.abs((note.bend as { peakAmountCents: number }).peakAmountCents)).toBeGreaterThan(
      DEFAULT_ENGINE_CONFIG.tracking.bendThresholdCents
    );
    // The label keeps the ORIGIN note; the excursion lives in `bend`.
    expect(note.origin.firstDetectedPitch?.pitchClass).toBe("A");
  });
});

describe("queries", () => {
  it("getActiveNotes reports what is sounding, and getNote outlives it", () => {
    const engine = new RecognitionEngine(SAMPLE_RATE, DEFAULT_ENGINE_CONFIG);
    const signal = concat(silence(ms(300)), sawtooth(220, ms(800)));
    let seenId: string | null = null;
    for (let offset = 0; offset < signal.length; offset += RENDER_QUANTUM) {
      const block = new Float32Array(RENDER_QUANTUM);
      block.set(signal.subarray(offset, Math.min(offset + RENDER_QUANTUM, signal.length)));
      engine.processChunk(block, offset);
      const active = engine.getActiveNotes();
      if (active.length > 0) seenId = (active[0] as Note).id;
    }
    expect(seenId).not.toBeNull();
    engine.flush();
    expect(engine.getActiveNotes()).toHaveLength(0);
    expect(engine.getNote(seenId as string)?.endTime).not.toBeNull();
  });
});
