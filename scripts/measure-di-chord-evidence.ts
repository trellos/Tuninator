/**
 * What the harmonic front end reads at each moment of a chord's life.
 *
 * Two direct-input chord labels are misnamed: `cowboy-chords-di` c2 (Em read
 * as Em7) and `power-chords-di` p14 (G5 read as Gsus2). A Note's chord name
 * is a vote pooled over every deep-lane reading in its life, so the question
 * is WHEN the wrong tone is heard: in the first windows, where the previous
 * chord is still ringing under the new strum, or throughout. This prints the
 * harmonic-sum fundamentals, the bass, and the interpreted chord name for a
 * 4096-point window starting at a series of offsets after each labelled
 * onset, using the engine's own spectral, multi-pitch and harmonic stages.
 *
 * Usage:
 *   npx tsx scripts/measure-di-chord-evidence.ts                 the DI chord takes
 *   npx tsx scripts/measure-di-chord-evidence.ts <substring>     one subset
 *   npx tsx scripts/measure-di-chord-evidence.ts ... --labels c2,p14
 */

import { readFileSync } from "node:fs";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/config.js";
import { HarmonicInterpreter } from "../src/engine/deep/harmonic.js";
import { MultiPitchAnalyzer } from "../src/engine/deep/multi-pitch.js";
import { SpectralAnalyzer } from "../src/engine/deep/spectral.js";
import { midiToName } from "../src/engine/kernels/notes.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/** Window START relative to the labelled onset, ms. */
const OFFSETS_MS = [-100, 40, 120, 200, 300, 500, 800, 1200];

function main(): void {
  const args = process.argv.slice(2);
  const filter = args.find((a) => !a.startsWith("--"));
  const only = args.find((a) => a.startsWith("--labels="))?.slice("--labels=".length).split(",");
  const fixtures = decodeFixtures({ quiet: true }).filter((f) => {
    if (filter !== undefined) return f.stem.includes(filter);
    return f.stem.includes("-di-") && f.label.events.some((e) => e.kind === "chord");
  });

  for (const fixture of fixtures) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const sampleRate = wav.sampleRate;
    const spectral = new SpectralAnalyzer(sampleRate, DEFAULT_ENGINE_CONFIG);
    const multi = new MultiPitchAnalyzer(spectral);
    const harmonic = new HarmonicInterpreter(DEFAULT_ENGINE_CONFIG);
    const window = new Float32Array(spectral.windowSize);

    console.log(`\n  ${fixture.stem}`);
    for (const event of fixture.label.events) {
      if (event.kind !== "chord") continue;
      if (only !== undefined && !only.includes(event.id)) continue;
      console.log(`    ${event.id} ${event.label} @${event.startMs}ms (${event.pitches?.join(" ") ?? ""})`);
      for (const offset of OFFSETS_MS) {
        const start = Math.round(((event.startMs + offset) / 1000) * sampleRate);
        if (start < 0 || start + window.length > mono.length) continue;
        window.set(mono.subarray(start, start + window.length));
        const evidence = spectral.analyze(window);
        const activations = multi.activations(evidence);
        const reading = harmonic.interpret(evidence, activations);
        const fundamentals = spectral
          .fundamentals()
          .map((f) => `${midiToName(f.midi)}:${f.salience.toFixed(2)}`)
          .join(" ");
        const bass = evidence.bassFrequencyHz === null ? "-" : `${evidence.bassFrequencyHz.toFixed(0)}Hz`;
        console.log(
          `      ${`${offset >= 0 ? "+" : ""}${offset}ms`.padStart(8)}  ${(reading.chordName ?? "unknown").padEnd(8)} conf ${reading.confidence.toFixed(2)} ` +
            `poly ${evidence.polyphony} bass ${bass.padEnd(6)}  ${fundamentals}`
        );
      }
    }
  }
}

main();
