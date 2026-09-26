/**
 * On the recorded corpus: how long after a Note's end does `noteEnded` arrive,
 * how much of that is the hold in `releaseClosed()`, and what did the hold buy?
 *
 * Replays every decoded fixture through the real engine exactly as the eval
 * does (128-sample quanta, zero-padded last block, default config, flush), and
 * stamps each emission with the source time of the block that delivered it.
 * For every Note that ends while the take is running (not by the flush) and is
 * not absorbed:
 *
 *   late    = ended@ - the endTime it carries   what a consumer waits today
 *   hold    = ended@ - decided@                  the closing hold alone
 *   early   = decided@ - the endTime the Note had at decided@: what `late`
 *             would be if `noteEnded` went out when the fast lane ended it
 *
 * where decided@ is the block in which the tracker's `ended` trace fired for
 * the Note (`NoteTracker.end()`), i.e. when the fast lane, or a region carve
 * for a Note it creates already over, decided the Note was over.
 *
 * and whether the `ended` payload differs from the Note as it stood when the
 * fast lane ended it: its endTime or startTime moved, or its label changed.
 * That is exactly the set of Notes that would need a revision after
 * `noteEnded` if the hold were removed.
 *
 * Usage: npx tsx scripts/measure-end-latency-fixtures.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RENDER_QUANTUM, resolveEngineConfig } from "../src/engine/config.js";
import { RecognitionEngine } from "../src/engine/engine.js";
import type { TrackerEmission } from "../src/engine/tracker/note-tracker.js";
import { labelOf } from "../src/offline/eval-adapter.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import type { Note } from "../src/types.js";
import { WAV_DIR } from "./decode-fixtures.js";

type Track = {
  decidedAt: number | null;
  atDecision: { endTime: number | null; startTime: number; label: string } | null;
  endedAt: number | null;
  final: Note | null;
  flushed: boolean;
  absorbed: boolean;
  absorbedAt: number | null;
  announced: boolean;
};

type Row = { fixture: string; late: number; early: number; hold: number; moved: number; startMoved: number; relabelled: boolean };

const rows: Row[] = [];
let absorbedTotal = 0;
let absorbedAfterEnd = 0;
const absorbedDelay: number[] = [];
const perFixture: string[] = [];

function q(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))] ?? Number.NaN;
}

for (const file of readdirSync(WAV_DIR).filter((name) => name.endsWith(".wav")).sort()) {
  const wav = readWav(readFileSync(join(WAV_DIR, file)));
  const samples = downmixToMono(wav.samples, wav.channels);
  const engine = new RecognitionEngine(wav.sampleRate, resolveEngineConfig(undefined, {}));
  const tracks = new Map<string, Track>();
  const track = (id: string): Track => {
    let t = tracks.get(id);
    if (t === undefined) {
      t = { decidedAt: null, atDecision: null, endedAt: null, final: null, flushed: false, absorbed: false, absorbedAt: null, announced: false };
      tracks.set(id, t);
    }
    return t;
  };
  let decidedThisBlock: string[] = [];
  engine.setTrackerTrace((event) => {
    if (event.kind === "ended") decidedThisBlock.push(event.noteId);
  });

  const handle = (emissions: readonly TrackerEmission[], at: number, flushing: boolean): void => {
    for (const emission of emissions) {
      const t = track(emission.note.id);
      if (emission.type === "started") t.announced = true;
      if (emission.type === "changed" && emission.change.type === "structuralRevision") {
        if ((emission.change.relation ?? "absorbed") === "absorbed") {
          for (const id of emission.change.relatedNoteIds ?? []) {
            const absorbed = track(id);
            absorbed.absorbed = true;
            absorbed.absorbedAt ??= at;
          }
        }
      }
      if (emission.type === "ended" && t.endedAt === null) {
        t.endedAt = at;
        t.final = emission.note;
        t.flushed = flushing;
      }
    }
  };

  const block = new Float32Array(RENDER_QUANTUM);
  for (let offset = 0; offset < samples.length; offset += RENDER_QUANTUM) {
    const available = Math.min(RENDER_QUANTUM, samples.length - offset);
    block.fill(0);
    block.set(samples.subarray(offset, offset + available));
    decidedThisBlock = [];
    const at = ((offset + RENDER_QUANTUM) / wav.sampleRate) * 1000;
    const output = engine.processChunk(block, offset);
    for (const id of decidedThisBlock) {
      const t = track(id);
      if (t.decidedAt !== null) continue;
      t.decidedAt = at;
      const snapshot = engine.getNote(id);
      if (snapshot !== undefined) {
        t.atDecision = { endTime: snapshot.endTime, startTime: snapshot.startTime, label: labelOf(snapshot) };
      }
    }
    handle(output.emissions, at, false);
  }
  decidedThisBlock = [];
  handle(engine.flush().emissions, (samples.length / wav.sampleRate) * 1000, true);

  const stem = file.replace(/\.wav$/, "");
  const mine: Row[] = [];
  let flushedCount = 0;
  let absorbedCount = 0;
  for (const t of tracks.values()) {
    if (!t.announced || t.final === null) continue;
    if (t.absorbed) {
      absorbedCount += 1;
      absorbedTotal += 1;
      if (t.decidedAt !== null && t.absorbedAt !== null && t.absorbedAt > t.decidedAt) {
        absorbedAfterEnd += 1;
        absorbedDelay.push(t.absorbedAt - t.decidedAt);
      }
      continue;
    }
    if (t.flushed) { flushedCount += 1; continue; }
    const endTime = t.final.endTime;
    if (endTime === null || t.endedAt === null || t.decidedAt === null || t.atDecision === null) continue;
    const row: Row = {
      fixture: stem,
      late: t.endedAt - endTime,
      early: t.atDecision.endTime === null ? Number.NaN : t.decidedAt - t.atDecision.endTime,
      hold: t.endedAt - t.decidedAt,
      moved: t.atDecision.endTime === null ? Number.NaN : endTime - t.atDecision.endTime,
      startMoved: t.final.startTime - t.atDecision.startTime,
      relabelled: labelOf(t.final) !== t.atDecision.label,
    };
    mine.push(row);
    rows.push(row);
  }
  const late = mine.map((r) => r.late);
  const changed = mine.filter((r) => Math.abs(r.moved) > 1 || Math.abs(r.startMoved) > 1 || r.relabelled).length;
  perFixture.push(
    `${stem.slice(0, 48).padEnd(48)} n=${String(mine.length).padStart(3)}  late p50 ${q(late, 0.5).toFixed(0).padStart(4)}` +
      ` p90 ${q(late, 0.9).toFixed(0).padStart(4)} max ${q(late, 1).toFixed(0).padStart(5)}` +
      `  >500ms ${String(mine.filter((r) => r.late > 500).length).padStart(3)}` +
      `  changed-in-hold ${String(changed).padStart(3)}  flush-only ${flushedCount} absorbed ${absorbedCount}`
  );
}

console.log(perFixture.join("\n"));
const all = (f: (r: Row) => number): number[] => rows.map(f);
const share = (pred: (r: Row) => boolean): string => `${rows.filter(pred).length} (${((100 * rows.filter(pred).length) / rows.length).toFixed(1)}%)`;
console.log(`\nALL ${rows.length} Notes ended live, not absorbed`);
for (const [name, values] of [["late", all((r) => r.late)], ["hold", all((r) => r.hold)], ["early", all((r) => r.early)]] as const) {
  console.log(`  ${name.padEnd(6)} p10 ${q(values, 0.1).toFixed(0)}  p50 ${q(values, 0.5).toFixed(0)}  p90 ${q(values, 0.9).toFixed(0)}  p95 ${q(values, 0.95).toFixed(0)}  max ${q(values, 1).toFixed(0)}`);
}
console.log(`  late > 250ms: ${share((r) => r.late > 250)}   > 500ms: ${share((r) => r.late > 500)}   > 1000ms: ${share((r) => r.late > 1000)}`);
console.log(`  payload differs from the Note at its fast-lane end: ${share((r) => Math.abs(r.moved) > 1 || Math.abs(r.startMoved) > 1 || r.relabelled)}`);
console.log(`    endTime moved: ${share((r) => Math.abs(r.moved) > 1)}  startTime moved: ${share((r) => Math.abs(r.startMoved) > 1)}  label changed: ${share((r) => r.relabelled)}`);
const moved = rows.filter((r) => Math.abs(r.moved) > 1).map((r) => r.moved);
if (moved.length > 0) console.log(`    endTime moves (ms): p10 ${q(moved, 0.1).toFixed(0)} p50 ${q(moved, 0.5).toFixed(0)} p90 ${q(moved, 0.9).toFixed(0)} min ${q(moved, 0).toFixed(0)} max ${q(moved, 1).toFixed(0)}`);
console.log(`announced Notes absorbed: ${absorbedTotal}, of which after the fast lane had ended them: ${absorbedAfterEnd}` +
  (absorbedDelay.length > 0 ? ` (absorbed p50 ${q(absorbedDelay, 0.5).toFixed(0)}ms, max ${q(absorbedDelay, 1).toFixed(0)}ms after that end)` : ""));
