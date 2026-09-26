/**
 * How late does a consumer hear that a Note has ended, and does it hear it at all?
 *
 * Drives the real `RecognitionEngine` over synthetic plucked notes, in the
 * 128-sample quanta the worklet delivers, and stamps every emission with the
 * source time of the block that delivered it. Per Note announced:
 *
 *   seen@     when its `started` emission was delivered
 *   damp      when the synthetic note was damped (ground truth; "-" for none)
 *   endTime   the `endTime` the `ended` emission carries
 *   ended@    when the `ended` emission was delivered
 *   late      ended@ - endTime: how long a consumer waited to be told
 *   endErr    endTime - damp: how far the reported end is from the damp
 *   flags     phantom:    opened after the last damp, and no pluck accounts for it
 *             flush-only: ended by `flush()` alone, so never while the take ran
 *             absorbed:   retracted into a neighbour by a structural revision
 *
 * The signals are synthetic and seeded, so a run is bit-reproducible. They say
 * nothing about accuracy, only about when an ending reaches a consumer.
 *
 * Usage: npx tsx scripts/measure-end-latency.ts
 */
import { RENDER_QUANTUM, resolveEngineConfig } from "../src/engine/config.js";
import { RecognitionEngine } from "../src/engine/engine.js";
import type { TrackerEmission } from "../src/engine/tracker/note-tracker.js";

const SR = 48000;
/** The gate a consumer measured on a quiet direct input: 8x a 1e-4 noise floor. */
const CALIBRATED_GATE = 0.0008;

type Pluck = { midi: number; at: number; damp: number | null };
type Residual = { at: number; hz: number; level: number; until?: number };
type Row = {
  id: string;
  name: string;
  start: number;
  seenAt: number;
  endTime: number | null;
  endedAt: number | null;
  flushOnly: boolean;
  absorbed: boolean;
};

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Plucked strings over a 1e-4 RMS noise floor; a damp takes 40ms to fall 60dB. */
function render(seconds: number, plucks: readonly Pluck[], residuals: readonly Residual[]): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const rand = lcg(7);
  for (let i = 0; i < out.length; i++) out[i] = (rand() * 2 - 1) * 1e-4 * Math.sqrt(3);
  for (const pluck of plucks) {
    const f0 = 440 * 2 ** ((pluck.midi - 69) / 12);
    const start = Math.round(pluck.at * SR);
    const damp = pluck.damp === null ? out.length : Math.round(pluck.damp * SR);
    for (let i = start; i < out.length; i++) {
      const t = (i - start) / SR;
      let s = 0;
      for (let k = 1; k <= 8; k++) {
        s += (Math.sin(2 * Math.PI * f0 * k * t) / k) * Math.exp(-t * (0.7 + 0.5 * k));
      }
      if (t < 0.004) s += (rand() * 2 - 1) * 0.8 * (1 - t / 0.004);
      let env = Math.min(1, t / 0.002);
      if (i >= damp) {
        const since = (i - damp) / SR;
        env *= Math.exp(-since * (Math.log(1000) / 0.04));
        if (since > 0.25) break;
      }
      out[i] = (out[i] ?? 0) + 0.15 * env * s * 0.4;
    }
  }
  // Whatever is still audible after the damp: a sympathetic string, hum, bleed.
  for (const r of residuals) {
    const start = Math.round(r.at * SR);
    const end = r.until === undefined ? out.length : Math.round(r.until * SR);
    for (let i = start; i < end; i++) {
      const t = (i - start) / SR;
      out[i] = (out[i] ?? 0) + r.level * Math.sin(2 * Math.PI * r.hz * t) * Math.min(1, t / 0.01);
    }
  }
  return out;
}

function run(
  label: string,
  seconds: number,
  plucks: readonly Pluck[],
  residuals: readonly Residual[] = [],
  rmsGate?: number
): void {
  const samples = render(seconds, plucks, residuals);
  const engine = new RecognitionEngine(SR, resolveEngineConfig(rmsGate === undefined ? {} : { rmsGate }));
  const rows = new Map<string, Row>();
  const handle = (emissions: readonly TrackerEmission[], at: number, flushing: boolean): void => {
    for (const emission of emissions) {
      const note = emission.note;
      let row = rows.get(note.id);
      if (row === undefined && emission.type === "started") {
        row = { id: note.id, name: "?", start: note.startTime, seenAt: at, endTime: null, endedAt: null, flushOnly: false, absorbed: false };
        rows.set(note.id, row);
      }
      if (row === undefined) continue;
      row.start = note.startTime;
      row.name = note.pitch.current?.name ?? row.name;
      if (emission.type === "changed" && emission.change.type === "structuralRevision") {
        if ((emission.change.relation ?? "absorbed") === "absorbed") {
          for (const id of emission.change.relatedNoteIds ?? []) {
            const absorbed = rows.get(id);
            if (absorbed !== undefined) absorbed.absorbed = true;
          }
        }
      }
      if (emission.type === "ended") {
        row.endTime = note.endTime;
        row.endedAt = at;
        row.flushOnly = flushing;
      }
    }
  };

  const block = new Float32Array(RENDER_QUANTUM);
  for (let offset = 0; offset < samples.length; offset += RENDER_QUANTUM) {
    block.fill(0);
    block.set(samples.subarray(offset, Math.min(samples.length, offset + RENDER_QUANTUM)));
    handle(engine.processChunk(block, offset).emissions, ((offset + RENDER_QUANTUM) / SR) * 1000, false);
  }
  handle(engine.flush().emissions, (samples.length / SR) * 1000, true);

  const lastDampMs = Math.max(...plucks.map((p) => (p.damp ?? seconds) * 1000));
  const ms = (v: number | null | undefined): string => (v === null || v === undefined ? "-" : v.toFixed(0)).padStart(6);
  console.log(`\n${label}`);
  console.log("  id     name  start  seen@   damp endTime ended@   late endErr  flags");
  let worst = 0;
  for (const row of rows.values()) {
    const pluck = plucks.find((p) => Math.abs(p.at * 1000 - row.start) < 120);
    const late = row.endTime !== null && row.endedAt !== null ? row.endedAt - row.endTime : null;
    if (late !== null && !row.flushOnly) worst = Math.max(worst, late);
    const flags = [
      pluck === undefined && row.start > lastDampMs - 5 ? "phantom" : "",
      row.flushOnly ? "flush-only" : "",
      row.absorbed ? "absorbed" : "",
    ].filter(Boolean).join(" ");
    const damp = pluck?.damp === null || pluck === undefined ? null : pluck.damp * 1000;
    const endErr = damp !== null && row.endTime !== null ? row.endTime - damp : null;
    console.log(
      `  ${row.id.padEnd(6)} ${row.name.padEnd(4)} ${ms(row.start)} ${ms(row.seenAt)} ${ms(damp)} ` +
        `${ms(row.endTime)} ${ms(row.endedAt)} ${ms(late)} ${ms(endErr)}  ${flags}`
    );
  }
  console.log(`  worst live late: ${worst.toFixed(0)}ms`);
}

const scale = [57, 59, 60, 62, 64, 65, 67, 69];
const quarter = (bpm: number): Pluck[] => [{ midi: 57, at: 1.0, damp: 1.0 + 60 / bpm }];
const detached = (notes: readonly number[], stepS: number, held: number): Pluck[] =>
  notes.map((midi, i) => ({ midi, at: 1.0 + i * stepS, damp: 1.0 + i * stepS + held * stepS }));
const openE = [{ at: 1.5, hz: 82.41, level: 0.0012 }];
const hum = [{ at: 1.5, hz: 50, level: 0.0015 }, { at: 1.5, hz: 150, level: 0.0005 }];

run("1. one quarter at 120bpm, damped on the beat", 4, quarter(120));
run("2. detached quarters at 120bpm, damped at 90%", 8, detached(scale, 0.5, 0.9));
const sixteenths = [...scale, ...[...scale].reverse()];
run("3. detached sixteenths at 100bpm (150ms apart), damped at 80%", 1 + 16 * 0.15 + 3, detached(sixteenths, 0.15, 0.8));
run("4. as 1, then an open E rings on at -32dB; calibrated gate", 6, quarter(120), openE, CALIBRATED_GATE);
run("5. as 4 with the default gate", 6, quarter(120), openE);
run("6. as 1, then 50Hz hum (never a pitch) above the gate; calibrated gate", 6, quarter(120), hum, CALIBRATED_GATE);
run("7. as 6 with the default gate", 6, quarter(120), hum);
