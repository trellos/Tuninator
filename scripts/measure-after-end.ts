/**
 * What reaches a consumer about a Note after its `noteEnded`, and after its
 * `noteResolved`?
 *
 * Replays every decoded fixture through the real engine as the eval does, and
 * for every announced Note counts the `changed` emissions that follow its
 * `ended`, by kind:
 *
 *   boundary   a `structuralRevision` on the Note itself that moved its
 *              `startTime` or `endTime`
 *   label      a `changed` whose snapshot names it differently (`labelOf`)
 *   absorbed   the Note named by another Note's `structuralRevision` with
 *              relation "absorbed", after its own `ended`
 *
 * and, separately, anything at all that arrives on a Note after its
 * `resolved` (which the contract says is its last word), and any Note that
 * gets two `ended`s or two `resolved`s, or an `ended` after its `resolved`.
 *
 * Usage: npx tsx scripts/measure-after-end.ts
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

type Seen = {
  last: Note | null;
  ended: number;
  resolved: number;
  endedAfterResolved: boolean;
  boundary: boolean;
  label: boolean;
  absorbed: boolean;
  afterResolved: string[];
};

let announced = 0;
let ended = 0;
let boundary = 0;
let label = 0;
let absorbed = 0;
let any = 0;
let doubled = 0;
let unresolved = 0;
const afterResolved = new Map<string, number>();
const perFixture: string[] = [];

for (const file of readdirSync(WAV_DIR).filter((name) => name.endsWith(".wav")).sort()) {
  const wav = readWav(readFileSync(join(WAV_DIR, file)));
  const samples = downmixToMono(wav.samples, wav.channels);
  const engine = new RecognitionEngine(wav.sampleRate, resolveEngineConfig(undefined, {}));
  const seen = new Map<string, Seen>();
  const get = (id: string): Seen => {
    let s = seen.get(id);
    if (s === undefined) {
      s = { last: null, ended: 0, resolved: 0, endedAfterResolved: false, boundary: false, label: false, absorbed: false, afterResolved: [] };
      seen.set(id, s);
    }
    return s;
  };
  const handle = (emissions: readonly TrackerEmission[]): void => {
    for (const emission of emissions) {
      const s = get(emission.note.id);
      if (s.resolved > 0) s.afterResolved.push(emission.type === "changed" ? emission.change.type : emission.type);
      if (emission.type === "changed" && s.ended > 0 && s.last !== null) {
        const change = emission.change;
        if (
          change.type === "structuralRevision" &&
          (emission.note.endTime !== s.last.endTime || emission.note.startTime !== s.last.startTime)
        ) {
          s.boundary = true;
        }
        if (labelOf(emission.note) !== labelOf(s.last)) s.label = true;
      }
      if (emission.type === "changed" && emission.change.type === "structuralRevision") {
        if ((emission.change.relation ?? "absorbed") === "absorbed") {
          for (const id of emission.change.relatedNoteIds ?? []) {
            const other = get(id);
            if (other.ended > 0) other.absorbed = true;
          }
        }
      }
      if (emission.type === "ended") {
        s.ended += 1;
        if (s.resolved > 0) s.endedAfterResolved = true;
      }
      if (emission.type === "resolved") s.resolved += 1;
      s.last = emission.note;
    }
  };
  const block = new Float32Array(RENDER_QUANTUM);
  for (let offset = 0; offset < samples.length; offset += RENDER_QUANTUM) {
    block.fill(0);
    block.set(samples.subarray(offset, Math.min(samples.length, offset + RENDER_QUANTUM)));
    handle(engine.processChunk(block, offset).emissions);
  }
  handle(engine.flush().emissions);

  let mine = 0;
  let mineAfter = 0;
  for (const s of seen.values()) {
    if (s.last === null) continue;
    announced += 1;
    if (s.ended > 0) ended += 1;
    if (s.boundary) boundary += 1;
    if (s.label) label += 1;
    if (s.absorbed) absorbed += 1;
    if (s.boundary || s.label || s.absorbed) {
      any += 1;
      mine += 1;
    }
    if (s.ended > 1 || s.resolved > 1 || s.endedAfterResolved) doubled += 1;
    if (s.resolved === 0) unresolved += 1;
    if (s.afterResolved.length > 0) mineAfter += 1;
    for (const type of s.afterResolved) afterResolved.set(type, (afterResolved.get(type) ?? 0) + 1);
  }
  perFixture.push(`${file.replace(/\.wav$/, "").slice(0, 48).padEnd(48)} revised after ended ${String(mine).padStart(3)}  touched after resolved ${mineAfter}`);
}

console.log(perFixture.join("\n"));
console.log(`\n${announced} Notes announced, ${ended} got noteEnded, ${unresolved} never got noteResolved`);
console.log(`after noteEnded: ${any} Notes revised — boundary ${boundary}, label ${label}, absorbed ${absorbed}`);
console.log(`two ended, two resolved, or ended after resolved: ${doubled}`);
console.log(
  `emissions after noteResolved: ${[...afterResolved.values()].reduce((a, b) => a + b, 0)}` +
    ([...afterResolved].length > 0 ? ` (${[...afterResolved].map(([k, v]) => `${k} ${v}`).join(", ")})` : "")
);
