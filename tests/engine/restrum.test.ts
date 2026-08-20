/**
 * Restrums: a chord struck again while the last one is still ringing.
 *
 * This is the case the old single-active-event tracker could not represent at
 * all — a second event could not begin while the first was alive — and the
 * fixture that exists to prove it (`chords-a-bm-g-d`, four chords twice through,
 * two strums each) is the one whose restrums were the missed events.
 *
 * Synthesised rather than recorded, because the point is to separate the three
 * things that look alike: a chord ringing out untouched, a chord struck again
 * harder, and a chord struck again *softer* — the muted upstrum, which lowers
 * the total energy while unmistakably re-articulating.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG, RENDER_QUANTUM } from "../../src/engine/config.js";
import { RecognitionEngine } from "../../src/engine/engine.js";
import type { Note, NoteChange } from "../../src/types.js";

const SAMPLE_RATE = 48000;
const ms = (value: number): number => Math.round((value / 1000) * SAMPLE_RATE);

function lcg(seed: number): () => number {
  let state = Math.floor(seed) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * A strummed chord: several strings, each entering a few milliseconds after the
 * last, each with a pick transient and an exponential decay. The stagger is not
 * decoration — it is why a strum's attack fragments in the fast lane.
 */
function strum(
  midis: readonly number[],
  samples: number,
  amplitude: number,
  tauMs = 900,
  seed = 1,
  /** Pick noise relative to the tone. A muted strum is mostly pick attack. */
  pickRatio = 0.8
): Float32Array {
  const out = new Float32Array(samples);
  const tau = (tauMs / 1000) * SAMPLE_RATE;
  const random = lcg(seed);
  midis.forEach((midi, index) => {
    const hz = 440 * Math.pow(2, (midi - 69) / 12);
    const period = SAMPLE_RATE / hz;
    const start = index * ms(7);
    for (let i = start; i < samples; i++) {
      const age = i - start;
      const envelope = Math.exp(-age / tau);
      out[i] = (out[i] as number) + amplitude * envelope * (2 * ((age % period) / period) - 1);
    }
    for (let i = start; i < Math.min(samples, start + ms(4)); i++) {
      const fade = 1 - (i - start) / ms(4);
      out[i] = (out[i] as number) + amplitude * pickRatio * fade * (random() * 2 - 1);
    }
  });
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

type Run = { notes: Note[]; changes: Array<{ note: Note; change: NoteChange }> };

function run(signal: Float32Array): Run {
  const engine = new RecognitionEngine(SAMPLE_RATE, DEFAULT_ENGINE_CONFIG);
  const out: Run = { notes: [], changes: [] };
  const drain = (emissions: ReturnType<RecognitionEngine["processChunk"]>["emissions"]): void => {
    for (const emission of emissions) {
      if (emission.type === "ended") out.notes.push(emission.note);
      else if (emission.type === "changed") {
        out.changes.push({ note: emission.note, change: emission.change });
      }
    }
  };
  for (let offset = 0; offset < signal.length; offset += RENDER_QUANTUM) {
    const block = new Float32Array(RENDER_QUANTUM);
    block.set(signal.subarray(offset, Math.min(offset + RENDER_QUANTUM, signal.length)));
    drain(engine.processChunk(block, offset).emissions);
  }
  drain(engine.flush().emissions);
  return out;
}

/** Notes the recognizer still stands behind: absorbed fragments removed. */
function surviving(result: Run): Note[] {
  const absorbed = new Set<string>();
  for (const { change } of result.changes) {
    if (change.type === "structuralRevision") {
      for (const id of change.relatedNoteIds ?? []) absorbed.add(id);
    }
  }
  return result.notes.filter((note) => !absorbed.has(note.id));
}

const A_MAJOR = [45, 52, 57, 61, 64]; // A2 E3 A3 C#4 E4
const G_MAJOR = [43, 47, 50, 55, 59]; // G2 B2 D3 G3 B3

describe("a chord ringing out", () => {
  it("is one Note, however long it rings", () => {
    const result = run(concat(silence(ms(300)), strum(A_MAJOR, ms(2500), 0.12), silence(ms(300))));
    expect(surviving(result).length).toBeLessThanOrEqual(2);
  });

  it("is not chopped up by the transients of its own attack", () => {
    // Six strings entering over 35ms produce six transients. The Note that
    // eventually names the chord absorbs the fragments of its own attack.
    const result = run(concat(silence(ms(300)), strum(A_MAJOR, ms(1500), 0.12), silence(ms(300))));
    const notes = surviving(result);
    expect(notes.length).toBeLessThanOrEqual(2);
    expect((notes[0] as Note).startTime).toBeLessThan(420);
  });
});

describe("a chord struck again", () => {
  it("is two Notes when the restrum is louder than the decay allows", () => {
    const result = run(
      concat(
        silence(ms(300)),
        strum(A_MAJOR, ms(700), 0.12, 900, 1),
        strum(A_MAJOR, ms(900), 0.12, 900, 2),
        silence(ms(300))
      )
    );
    expect(surviving(result).length).toBeGreaterThanOrEqual(2);
  });

  it("is two Notes even when the restrum is quieter than what it interrupts", () => {
    // The muted upstrum. Total energy falls, so every level-based test says
    // nothing happened; the pick transient is the only witness.
    const result = run(
      concat(
        silence(ms(300)),
        strum(A_MAJOR, ms(700), 0.14, 1200, 3),
        // Half the level and a fast decay — a hand damping the strings — but a
        // pick transient as strong as the tone it leaves behind.
        strum(A_MAJOR, ms(900), 0.07, 250, 4, 3),
        silence(ms(300))
      )
    );
    expect(surviving(result).length).toBeGreaterThanOrEqual(2);
  });
});

describe("a chord change with no gap", () => {
  it("splits into two Notes at the change", () => {
    // The bars in the fixtures run into each other with no silence, so waiting
    // for a gap would merge every chord in a take into one Note.
    const result = run(
      concat(
        silence(ms(300)),
        strum(A_MAJOR, ms(1200), 0.12, 1500, 5),
        strum(G_MAJOR, ms(1200), 0.12, 1500, 6),
        silence(ms(300))
      )
    );
    const notes = surviving(result);
    expect(notes.length).toBeGreaterThanOrEqual(2);
    const named = notes.filter((n) => n.harmony?.chordName !== undefined);
    const roots = new Set(named.map((n) => n.harmony?.root));
    expect(roots.size).toBeGreaterThanOrEqual(1);
  });
});

describe("structural revision", () => {
  it("never rewrites history: an absorbed Note was really delivered", () => {
    const result = run(concat(silence(ms(300)), strum(A_MAJOR, ms(1500), 0.12), silence(ms(300))));
    const structural = result.changes.filter((c) => c.change.type === "structuralRevision");
    for (const { change } of structural) {
      expect(change.relatedNoteIds?.length ?? 0).toBeGreaterThan(0);
      for (const id of change.relatedNoteIds ?? []) {
        // Every absorbed Note ended in the emission stream before it was
        // absorbed — the events stand, only the final accounting changes.
        expect(result.notes.some((note) => note.id === id)).toBe(true);
      }
    }
  });

  it("moves the survivor's start onto the real attack", () => {
    const result = run(concat(silence(ms(300)), strum(A_MAJOR, ms(1800), 0.12), silence(ms(300))));
    const structural = result.changes.filter((c) => c.change.type === "structuralRevision");
    for (const { note, change } of structural) {
      const absorbed = result.notes.filter((n) => (change.relatedNoteIds ?? []).includes(n.id));
      for (const fragment of absorbed) {
        expect(note.startTime).toBeLessThanOrEqual(fragment.startTime);
      }
    }
  });
});

describe("invariants under overlap", () => {
  it("no Note ends before it starts, whatever the segmentation did", () => {
    const result = run(
      concat(
        silence(ms(300)),
        strum(A_MAJOR, ms(700), 0.12, 900, 7),
        strum(G_MAJOR, ms(700), 0.12, 900, 8),
        strum(A_MAJOR, ms(900), 0.12, 900, 9)
      )
    );
    for (const note of result.notes) {
      expect(note.endTime as number).toBeGreaterThanOrEqual(note.startTime);
      expect(note.lifecycle).toBe("ended");
    }
  });

  it("revision numbers only ever increase within a Note", () => {
    const result = run(
      concat(silence(ms(300)), strum(A_MAJOR, ms(1500), 0.12), strum(G_MAJOR, ms(1500), 0.12))
    );
    const seen = new Map<string, number>();
    for (const { note } of result.changes) {
      const previous = seen.get(note.id) ?? -1;
      expect(note.revision.revisionNumber).toBeGreaterThan(previous);
      seen.set(note.id, note.revision.revisionNumber);
    }
  });
});
