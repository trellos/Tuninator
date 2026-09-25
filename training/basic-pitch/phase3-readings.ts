/**
 * Phase 3 precompute: the model's DEEP reading at every Note opening the
 * baseline recognizer makes, on every take, for the dev-only gate in
 * `phase3-hook.patch` to look up.
 *
 * For each `opened` trace event at time S the reading is the causal window cut
 * at S + 200ms (`causal.ts`; the same DEEP reading Phase 2 used), and what is
 * stored is, per MIDI note from E2 to E6, the largest onset activation in the
 * frames centred within 40ms of S. The gate then takes the maximum over the
 * pitch set of the Note it is judging, exactly as Phase 2's O(S).
 *
 * A gated run can open a Note at a time the baseline never did (dropping a
 * Note changes the tracker's later state). The gate has no reading for such a
 * Note and abstains; it counts how often.
 *
 * Takes are keyed by the engine's own input, `takeKey` below, which the dev
 * patch computes identically inside `src/offline/analyzer.ts`.
 *
 * Usage:
 *   npx tsx training/basic-pitch/phase3-readings.ts --dir training/out/basic-pitch
 *   (writes <dir>/phase3/readings.json)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFixtures } from "../../scripts/decode-fixtures.js";
import { BARS } from "./phase2.js";
import { causalWindow } from "./causal.js";
import { runTake } from "./engine-run.js";
import { HIGH_MIDI, LOW_MIDI, causalFrames } from "./features.js";
import { SAMPLE_RATE } from "./framing.js";
import { resample } from "./resample.js";
import { loadModel } from "./runtime.js";

/**
 * Identifies a take by the samples the engine is given: their count and the
 * sum of their magnitudes over the whole take (a DI render and its amped twin
 * can share a length and a silent opening). Mirrored in the dev patch.
 */
export function takeKey(samples: Float32Array): string {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += Math.abs(samples[i] as number);
  return `${samples.length}:${Math.round(s * 1e3)}`;
}

const i = process.argv.indexOf("--dir");
const dir = i >= 0 ? process.argv[i + 1] : undefined;
if (!dir) {
  console.error("usage: npx tsx training/basic-pitch/phase3-readings.ts --dir <dir>");
  process.exit(2);
}
const model = await loadModel(join(dir, "src/basic_pitch/saved_models/icassp_2022/nmp.onnx"));
const out: Record<string, { stem: string; starts: Record<string, number[]> }> = {};
for (const fixture of decodeFixtures({ quiet: true })) {
  const run = runTake(fixture);
  const key = takeKey(run.mono);
  if (out[key] !== undefined) throw new Error(`takeKey collision: ${fixture.stem} and ${out[key]?.stem}`);
  const audio = resample(run.mono, run.sampleRate, SAMPLE_RATE);
  const starts = [...new Set(run.events.filter((e) => e.kind === "opened").map((e) => Math.round(e.at * 10) / 10))].sort(
    (a, b) => a - b,
  );
  const table: Record<string, number[]> = {};
  for (let b = 0; b < starts.length; b += 8) {
    const batch = starts.slice(b, b + 8);
    const outs = await model.run(batch.map((s) => causalWindow(audio, s + BARS.deepDelayMs)));
    outs.forEach((o, j) => {
      const s = batch[j] as number;
      const fr = causalFrames(o, s + BARS.deepDelayMs);
      const perMidi: number[] = [];
      for (let m = LOW_MIDI; m <= HIGH_MIDI; m++) {
        let best = 0;
        for (let f = 0; f < fr.count; f++) {
          if (Math.abs(fr.timeMs(f) - s) <= BARS.windowMs) best = Math.max(best, fr.onset(f, m));
        }
        perMidi.push(Math.round(best * 1e4) / 1e4);
      }
      table[s.toFixed(1)] = perMidi;
    });
  }
  out[key] = { stem: fixture.stem, starts: table };
  console.log(`${fixture.stem.padEnd(48)} key ${key.padEnd(20)} ${starts.length} openings`);
}
mkdirSync(join(dir, "phase3"), { recursive: true });
writeFileSync(join(dir, "phase3", "readings.json"), JSON.stringify(out));
