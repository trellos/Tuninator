/**
 * The room mic does not record the note the player fretted.
 *
 * A `B5` power chord is `B2` and `F#3`. Measuring the partial series of that
 * chord's first strike on the three signal paths, normalised within each file:
 *
 * ```
 *   partial of B2   direct   amp sim   room mic
 *   n=1  123.5Hz     0.726    0.714     0.037     <- the fundamental
 *   n=2  246.9Hz     0.439    0.641     0.619
 *   n=3  370.4Hz     1.000    1.000     1.000
 *   n=4  493.9Hz     0.775    0.601     0.384
 *   n=5  617.4Hz     0.075    0.005     0.069
 *   n=6  740.8Hz     0.437    0.611     0.966
 * ```
 *
 * The room mic has 5% of the fundamental the direct input has. It is not
 * masked, mis-cancelled or mis-estimated: a guitar speaker and a room have
 * rolled 123Hz off, and the multi-pitch analyser correctly reports what is
 * there. Its lowest activation on that chord is `F#3` — the FIFTH — and every
 * naming error on the take follows from it: with no `B2` to subtract partials
 * from, the `D#5` sitting 28 semitones above it (its fifth partial) survives
 * cancellation and turns the power chord into a triad called `B`.
 *
 * That is the classic missing fundamental, and the partials that remain still
 * determine it: 247, 370, 494 and 741 are the 2nd, 3rd, 4th and 6th of 123.5,
 * and no other fundamental in the guitar's range explains all four.
 *
 * This matters beyond the three labels it costs. Microphone input is the case
 * this library exists for, and a mic is exactly where the fundamental goes
 * missing.
 *
 * Usage:
 *   npx tsx scripts/measure-missing-fundamental.ts
 */

import { readFileSync } from "node:fs";
import { nameToMidi, midiToFrequency } from "../src/engine/kernels/notes.js";
import { type LabeledEvent } from "../src/offline/matcher.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/** Long enough to resolve 123Hz from 116Hz: about a third of a second. */
const WINDOW = 16384;
/** How far into the labelled event the window is taken. */
const OFFSET_MS = 120;
/** Partials reported, as harmonic numbers of the chord's root. */
const HARMONICS = [1, 2, 3, 4, 5, 6] as const;

/**
 * Magnitude at one frequency, without an FFT.
 *
 * A single-bin DFT is the right tool here: the question is about six known
 * frequencies, not about a spectrum, and this answers it at exactly the
 * frequency asked rather than at the nearest bin centre.
 */
function goertzel(x: Float32Array, sampleRate: number, hz: number): number {
  const w = (2 * Math.PI * hz) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s = (x[i] as number) + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / x.length;
}

function main(): void {
  console.log("\n  partial series of the first labelled chord, normalised within each file\n");
  for (const fixture of decodeFixtures({ quiet: true })) {
    if (!fixture.stem.includes("power-chords") || fixture.stem.includes("120bpm")) continue;
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const label = (fixture.label.events as LabeledEvent[])[0];
    if (label === undefined) continue;

    // The root, at the octave a power chord's lowest string actually sounds.
    const root = String(label.label).replace(/5$/, "");
    const midi = nameToMidi(`${root}2`);
    if (midi === null) continue;
    const f0 = midiToFrequency(midi);

    const at = Math.round(((label.startMs + OFFSET_MS) / 1000) * wav.sampleRate);
    if (at + WINDOW > mono.length) continue;
    const window = mono.subarray(at, at + WINDOW);

    const values = HARMONICS.map((n) => goertzel(window, wav.sampleRate, f0 * n));
    const max = Math.max(...values, 1e-12);
    console.log(`  ${fixture.stem}  ${label.id} ${label.label}`);
    HARMONICS.forEach((n, i) => {
      const share = (values[i] as number) / max;
      const flag = n === 1 && share < 0.1 ? "   <- the fundamental is not there" : "";
      console.log(
        `    n=${n}  ${(f0 * n).toFixed(1).padStart(6)}Hz  ${share.toFixed(3)}${flag}`
      );
    });
    console.log("");
  }
  console.log(
    "  Compare down a column, not across. Each file is normalised to its own\n" +
      "  loudest partial; the levels between files are recording levels.\n"
  );
}

main();
