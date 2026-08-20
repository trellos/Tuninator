/**
 * The mute is the most reliable witness in the corpus, and nothing reads it.
 *
 * The three 140bpm power-chord takes play one figure: a chord on the 1, the
 * same chord again on the 2, then the hand comes down and stops it. The second
 * strike is a MUTED restrum — it damps the strings, so it puts total energy
 * DOWN while plainly re-articulating the chord — and on the amp-sim path its
 * transient is flattened by the compression until no flux test can see it.
 * Three of those strikes are missed for that reason.
 *
 * The mute that follows is not flattened by anything. This script measures it:
 * for every labelled stroke, the energy shortly after the stroke against the
 * lowest energy over the following third of a second.
 *
 * The separation is total, WITHIN each file, on all three signal paths:
 *
 * ```
 *   path        odd strikes (answered)   even strikes (muted)   gap
 *   amp sim     0.885 - 1.061            0.243 - 0.641          0.641 | 0.885
 *   room mic    0.932 - 1.498            0.229 - 0.538          0.538 | 0.932
 *   direct      0.455 - 0.604            0.037 - 0.140          0.140 | 0.455
 * ```
 *
 * Forty-eight strokes, forty-eight correct sides. No other measurement in this
 * project separates on-label from off-label that cleanly, and the reason is
 * physical rather than statistical: a mute REMOVES energy, and removal is not
 * something a compressor, a room, or a decaying string can imitate.
 *
 * Read the columns and not the absolute numbers. The direct take's ANSWERED
 * strokes sit at 0.455, below the amp take's MUTED ones at 0.641, so any fixed
 * threshold across paths is measuring the recording. Within a file the two
 * populations do not touch. That is the same trap this project has walked into
 * before (see `docs/DETECTION-FINDINGS.md`), which is why the summary line
 * reports each file's own gap rather than a corpus-wide bar.
 *
 * What it is FOR: a mute is the end of something somebody played. A transient
 * that the re-articulation detector rejected for being too weak, followed by a
 * mute, is a rejection the mute contradicts — and the contradiction arrives
 * after the decision, which is exactly the case the deep lane and the
 * structural-revision protocol exist for.
 *
 * Usage:
 *   npx tsx scripts/measure-mute-witness.ts            the power-chord takes
 *   npx tsx scripts/measure-mute-witness.ts --all      every fixture
 *   npx tsx scripts/measure-mute-witness.ts --detail   every stroke
 */

import { readFileSync } from "node:fs";
import { type LabeledEvent } from "../src/offline/matcher.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/** Window the energy is measured over, ms. Two periods of low E, rounded up. */
const WINDOW_MS = 20;
/** How long after the annotated onset the stroke's own level is read. */
const AT_MS = 40;
/** Where the following collapse is looked for. A muted eighth at 140bpm. */
const AFTER_MS = [200, 260, 320] as const;

type Stroke = { id: string; label: string; startMs: number; ratio: number };

function measure(stem: (s: string) => boolean): Array<{ stem: string; strokes: Stroke[] }> {
  const out: Array<{ stem: string; strokes: Stroke[] }> = [];
  for (const fixture of decodeFixtures({ quiet: true })) {
    if (!stem(fixture.stem)) continue;
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const width = Math.round((WINDOW_MS / 1000) * wav.sampleRate);

    const rmsAt = (ms: number): number => {
      const from = Math.max(0, Math.round((ms / 1000) * wav.sampleRate));
      const to = Math.min(mono.length, from + width);
      let sum = 0;
      for (let i = from; i < to; i++) sum += mono[i]! * mono[i]!;
      return to <= from ? 0 : Math.sqrt(sum / (to - from));
    };

    const strokes = (fixture.label.events as LabeledEvent[]).map((label) => {
      const struck = rmsAt(label.startMs + AT_MS);
      const after = Math.min(...AFTER_MS.map((ms) => rmsAt(label.startMs + ms)));
      return {
        id: label.id,
        label: label.label,
        startMs: label.startMs,
        ratio: after / (struck === 0 ? 1e-9 : struck),
      };
    });
    out.push({ stem: fixture.stem, strokes });
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const detail = args.includes("--detail");
  const select = (stem: string): boolean =>
    all || (stem.includes("power-chords") && !stem.includes("120bpm"));

  console.log(
    `\n  energy ${AT_MS}ms after each stroke, against the lowest over the next third of a second`
  );
  console.log("  a ratio well under 1 means the note was stopped rather than left to ring\n");

  for (const { stem, strokes } of measure(select)) {
    // Split on the figure the power-chord takes play: odd strokes are answered
    // by the next strike, even ones are muted. Elsewhere this is just a spread.
    const odd = strokes.filter((s) => Number(s.id.replace(/\D/g, "")) % 2 === 1);
    const even = strokes.filter((s) => Number(s.id.replace(/\D/g, "")) % 2 === 0);
    const span = (xs: Stroke[]): string =>
      xs.length === 0
        ? "-"
        : `${Math.min(...xs.map((x) => x.ratio)).toFixed(3)} - ${Math.max(
            ...xs.map((x) => x.ratio)
          ).toFixed(3)}`;
    const lowestOdd = odd.length === 0 ? NaN : Math.min(...odd.map((x) => x.ratio));
    const highestEven = even.length === 0 ? NaN : Math.max(...even.map((x) => x.ratio));
    const separated = Number.isFinite(lowestOdd) && Number.isFinite(highestEven)
      ? highestEven < lowestOdd
      : false;

    console.log(`  ${stem}`);
    console.log(`    odd  (answered) ${span(odd)}`);
    console.log(`    even (muted)    ${span(even)}`);
    console.log(
      `    ${separated ? "SEPARATED" : "overlapping"}` +
        (separated ? `: every muted stroke below every answered one` : "")
    );
    if (detail) {
      for (const s of strokes) {
        console.log(
          `      ${s.id.padEnd(5)} ${String(s.label).padEnd(6)}@${String(s.startMs).padStart(6)}` +
            `  ${s.ratio.toFixed(3)}`
        );
      }
    }
    console.log("");
  }

  console.log(
    "  Compare WITHIN a file only. The direct take's answered strokes sit at 0.455,\n" +
      "  below the amp take's muted ones at 0.641: a bar chosen across paths measures\n" +
      "  the recording rather than the playing.\n"
  );
}

main();
