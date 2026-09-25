/**
 * A deterministic test clip with known notes, for the two checks that must not
 * touch the corpus: running the model card's advertised example, and the
 * numeric parity of the runtime against `reference-forward.ts`.
 *
 * Struck-string tones (a hard attack, an exponential decay, eight partials at
 * 1/h amplitude with a slight stretch), 16kHz, 7s:
 *   single notes C4 E4 G4 C5 at 0.25s spacing, then a C major triad,
 *   then A4 struck four times at 250ms, then A4 four times at 107ms
 *   (a 140bpm sixteenth, the corpus's tightest subdivision).
 * The expected notes are written next to the audio so the CLI's output can be
 * read against them.
 *
 * Usage:
 *   npx tsx training/hft-transformer/synth-test-signal.ts <outdir>
 * Writes <outdir>/test16k.f32 (raw float32), <outdir>/test16k.wav (16-bit PCM)
 * and <outdir>/test16k.notes.txt ("onset_s midi").
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeWav } from "../../src/offline/wav.js";

const SR = 16000;
const SECONDS = 7;
const outdir = process.argv[2] ?? "training/out/hft-transformer/test";
mkdirSync(outdir, { recursive: true });

const notes: Array<{ at: number; midi: number }> = [];
[60, 64, 67, 72].forEach((m, i) => notes.push({ at: 0.5 + 0.25 * i, midi: m }));
for (const m of [60, 64, 67]) notes.push({ at: 2.0, midi: m });
for (let i = 0; i < 4; i++) notes.push({ at: 3.5 + 0.25 * i, midi: 69 });
for (let i = 0; i < 4; i++) notes.push({ at: 5.0 + 0.107 * i, midi: 69 });

const pcm = new Float32Array(SR * SECONDS);
for (const n of notes) {
  const f0 = 440 * 2 ** ((n.midi - 69) / 12);
  const start = Math.round(n.at * SR);
  for (let i = start; i < pcm.length; i++) {
    const t = (i - start) / SR;
    const env = Math.exp(-3 * t) * Math.min(1, t / 0.002);
    if (t > 0.01 && env < 1e-4) break;
    let v = 0;
    for (let h = 1; h <= 8; h++) {
      const fh = f0 * h * Math.sqrt(1 + 0.0004 * h * h);
      if (fh >= SR / 2) break;
      v += (Math.sin(2 * Math.PI * fh * t) / h) * Math.exp(-0.4 * (h - 1) * t);
    }
    pcm[i] = (pcm[i] as number) + 0.12 * env * v;
  }
}

writeFileSync(join(outdir, "test16k.f32"), Buffer.from(pcm.buffer));
writeFileSync(join(outdir, "test16k.wav"), writeWav(pcm, SR));
writeFileSync(join(outdir, "test16k.notes.txt"), notes.map((n) => `${n.at.toFixed(3)} ${n.midi}`).join("\n") + "\n");
let peak = 0;
for (const v of pcm) peak = Math.max(peak, Math.abs(v));
console.log(`${notes.length} notes, ${SECONDS}s at ${SR}Hz, peak ${peak.toFixed(3)} -> ${outdir}`);
