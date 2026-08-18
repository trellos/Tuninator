/**
 * Parameter sweep: run every fixture at several values of one policy field and
 * print the scores side by side.
 *
 * Tuning one shared constant against five fixtures by hand is how you overfit
 * to whichever one you looked at last. This shows all of them at once.
 *
 *   npx tsx scripts/sweep.ts chords.restrikeRmsRise 1.0 1.2 1.35 1.5 2.0
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSamples } from "../src/workers/offline.js";
import { readWav, downmixToMono } from "../src/eval/wav.js";
import { matchEvents, scoreMatches, type DetectedEvent, type LabeledEvent } from "../src/eval/matcher.js";
import { resolvePolicy } from "../src/core/policy.js";
import type { TuninatorMode } from "../src/types.js";
import { REPO_ROOT, CACHE_DIR } from "./decode-fixtures.js";

const [path, ...values] = process.argv.slice(2);
if (!path || values.length === 0) {
  process.stderr.write("usage: sweep.ts <policy.path> <value>...\n");
  process.exit(1);
}

const config = JSON.parse(
  readFileSync(join(REPO_ROOT, "fixtures", "eval.config.json"), "utf8")
) as Record<string, { mode?: string; gateOn?: string }>;

const stems = Object.keys(config);

function setPath(target: Record<string, unknown>, dotted: string, value: number): void {
  const parts = dotted.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>;
  node[parts.at(-1) as string] = value;
}

const rows: string[] = [];
for (const raw of values) {
  const value = Number(raw);
  const cells: string[] = [];
  for (const stem of stems) {
    const mode = (config[stem]?.mode ?? "lead") as TuninatorMode;
    const wav = readWav(readFileSync(join(CACHE_DIR, "fixtures", `${stem}.wav`)));
    const mono = downmixToMono(wav.samples, wav.channels);

    const policy = resolvePolicy({ mode });
    setPath(policy as unknown as Record<string, unknown>, path, value);

    const labels = JSON.parse(
      readFileSync(join(REPO_ROOT, "fixtures", "labels", `${stem}.json`), "utf8")
    ).events as LabeledEvent[];
    const events = analyzeSamples(mono, wav.sampleRate, { mode, policy })
      .events as unknown as DetectedEvent[];
    const stats = scoreMatches(matchEvents(labels, events));
    const gateOn = config[stem]?.gateOn ?? "pitchClass";
    const acc = gateOn === "exact" ? stats.exactAccuracy : stats.pitchClassAccuracy;
    cells.push(
      `${((acc ?? 0) * 100).toFixed(1).padStart(5)}% m${String(stats.missedCount).padStart(2)} f${String(
        stats.falsePositiveCount
      ).padStart(2)} o${(stats.onsetErrorMs.medianAbs ?? 0).toFixed(0).padStart(4)}`
    );
  }
  rows.push(`${raw.padStart(6)}  ${cells.join(" | ")}`);
}

process.stdout.write(`\n${path}\n`);
process.stdout.write(`${" ".repeat(8)}${stems.map((s) => s.slice(0, 22).padEnd(24)).join("| ")}\n`);
for (const row of rows) process.stdout.write(`${row}\n`);
process.stdout.write("\n(acc = the fixture's own gate metric; m=missed f=falsePos o=onset median ms)\n");
