/**
 * Measure a combination of estimators, and show where the combination helps.
 *
 *   npx tsx scripts/bench-fusion.ts src/core/pitch/yin-estimator.ts src/core/pitch/mpm-estimator.ts
 *   npx tsx scripts/bench-fusion.ts <modules...> --per-note --members
 *
 * `--members` also benches each member alone, so the fused number can be read
 * against what it is supposed to be improving on. A fusion that does not beat
 * its best member is not worth the code, and this is the only way to know.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PitchEstimator, PitchEstimatorOptions } from "../src/core/pitch/estimator.js";
import { FusedEstimator } from "../src/core/pitch/fusion.js";
import { benchEstimator, formatBench, type BenchResult } from "./bench-estimator.js";

const OPTIONS: PitchEstimatorOptions = {
  sampleRate: 48000,
  minFrequencyHz: 70,
  maxFrequencyHz: 1400,
};

async function load(modulePath: string): Promise<PitchEstimator> {
  const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    default: (options: PitchEstimatorOptions) => PitchEstimator;
  };
  return loaded.default(OPTIONS);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modules = args.filter((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));
  if (modules.length === 0) {
    process.stderr.write("usage: bench-fusion.ts <modules...> [--per-note] [--members]\n");
    process.exit(1);
  }

  const members = await Promise.all(modules.map(load));
  const alone = new Map<string, BenchResult>();
  if (flags.includes("--members")) {
    for (const member of members) {
      const result = benchEstimator(member);
      alone.set(member.name, result);
      process.stdout.write(formatBench(result, member.windowSize));
    }
    process.stdout.write("\n");
  }

  const fused = new FusedEstimator(
    members.map((estimator) => ({ estimator })),
    OPTIONS
  );
  const result = benchEstimator(fused);
  process.stdout.write(formatBench(result, fused.windowSize));

  if (alone.size > 0) {
    // The question is never "is the fusion good" but "does it beat the best
    // thing it contains". Anything else is a number without a comparison.
    const best = [...alone.values()].reduce((a, b) => (b.exact > a.exact ? b : a));
    const delta = result.exact - best.exact;
    process.stdout.write(
      `\n  vs best member (${best.name} at ${best.exact}/${best.total}): ` +
        `${delta >= 0 ? "+" : ""}${delta}\n`
    );
    const gained = result.notes.filter(
      (n, i) => n.got === n.want && best.notes[i]!.got !== best.notes[i]!.want
    );
    const lost = result.notes.filter(
      (n, i) => n.got !== n.want && best.notes[i]!.got === best.notes[i]!.want
    );
    if (gained.length) {
      process.stdout.write(`  gained  ${gained.map((n) => `${n.id} ${n.want}`).join(", ")}\n`);
    }
    if (lost.length) {
      process.stdout.write(
        `  LOST    ${lost.map((n) => `${n.id} ${n.want}->${n.got}`).join(", ")}\n`
      );
    }
  }

  if (flags.includes("--per-note")) {
    for (const n of result.notes) {
      process.stdout.write(
        `    ${n.id.padEnd(4)} want ${n.want.padEnd(4)} got ${n.got.padEnd(6)} ` +
          `agree ${(n.agreement * 100).toFixed(0).padStart(3)}%  conf ${n.confidence.toFixed(2)}` +
          `${n.tooShort ? "  [shorter than the window]" : ""}` +
          `${n.buried ? "  [drowned out by a louder note]" : ""}` +
          `${n.got === n.want ? "" : "   <-"}\n`
      );
    }
  }
}

await main();
