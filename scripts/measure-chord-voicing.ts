/**
 * What the deep lane actually finds under a chord, register intact.
 *
 * The three 140bpm power-chord takes are one performance through three signal
 * paths, and they name it three different ways: the direct input gets 15 of 16
 * exact, the amp sim 11 of 13, and the room mic 4 of 7 - naming `B5` as `B` and
 * `E5` as `E`, which is a claim about a third that the player did not fret.
 *
 * This prints every activation the multi-pitch analyser reports at each labelled
 * chord, with its offset from the lowest one, its degree from the root, and its
 * salience, so the difference between the paths is readable rather than
 * inferred.
 *
 * Usage:
 *   npx tsx scripts/measure-chord-voicing.ts
 */

import { readFileSync } from "node:fs";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/config.js";
import { SpectralAnalyzer } from "../src/engine/deep/spectral.js";
import { MultiPitchAnalyzer } from "../src/engine/deep/multi-pitch.js";
import { nameToMidi, PITCH_CLASSES } from "../src/engine/kernels/notes.js";
import { type LabeledEvent } from "../src/offline/matcher.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

for (const fixture of decodeFixtures({ quiet: true })) {
  const isPower = fixture.stem.includes("power-chords");
  const isTriad = fixture.stem.includes("cowboy") || fixture.stem.includes("chords-a-bm");
  if (!isPower && !isTriad) continue;
  const wav = readWav(readFileSync(fixture.wavPath));
  const mono = downmixToMono(wav.samples, wav.channels);
  const spectral = new SpectralAnalyzer(wav.sampleRate, DEFAULT_ENGINE_CONFIG);
  const mp = new MultiPitchAnalyzer(spectral);
  const size = DEFAULT_ENGINE_CONFIG.harmony.fftSize;
  const win = new Float32Array(size);
  console.log(`\n${fixture.stem} [${isPower ? "POWER" : "triad"}]`);
  for (const l of fixture.label.events as LabeledEvent[]) {
    const root = String(l.label).replace(/(5|m|maj7|maj9|m7|m11|7|sus2|sus4)$/, "");
    const rm = nameToMidi(root + "3");
    if (rm === null) continue;
    const pc = ((rm % 12) + 12) % 12;
    const at = Math.round(((l.startMs + 120) / 1000) * wav.sampleRate);
    if (at + size > mono.length) continue;
    win.set(mono.subarray(at, at + size));
    const ev = spectral.analyze(win);
    const acts = mp.activations(ev);
    if (acts.length === 0) { console.log(`  ${l.id.padEnd(4)} ${String(l.label).padEnd(6)} (no activations)`); continue; }
    const bass = Math.min(...acts.map((a) => a.midi));
    // The bass the chroma kernel reports, which is not always the lowest
    // activation: where the fundamental is missing from the recording it is
    // inferred from the spacing of the partials instead.
    const bassPc =
      ev.bassPitchClass === null ? "--" : PITCH_CLASSES[ev.bassPitchClass];
    const bassHz = ev.bassFrequencyHz === null ? "" : `@${ev.bassFrequencyHz.toFixed(1)}Hz`;
    const desc = acts
      .slice()
      .sort((a, b) => a.midi - b.midi)
      .map((a) => `${a.pitchClass}${a.octave}(+${a.midi - bass},${((a.midi - pc) % 12 + 12) % 12}deg,s=${a.salience.toFixed(2)})`)
      .join(" ");
    console.log(
      `  ${l.id.padEnd(4)} ${String(l.label).padEnd(6)} bass=${String(bassPc).padEnd(2)}${bassHz.padEnd(9)} ${desc}`
    );
  }
}
