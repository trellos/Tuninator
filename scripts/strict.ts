/**
 * The honest score: every labelled event, named exactly right.
 *
 * `npm run eval` reports label accuracy over the events the detector was
 * willing to name, which is the right way to measure honest abstention and the
 * wrong way to measure whether the detector heard the recording. An `unknown`
 * is not a wrong answer, but it is not a right one either, and a detector that
 * abstained on half the file can post 100% there.
 *
 * This scores what a listener would: of the N events in the label file, how
 * many did the detector name correctly? Abstentions count against. Extra
 * detections are reported alongside but not folded in — see `--help`.
 *
 *   npx tsx scripts/strict.ts
 *   npx tsx scripts/strict.ts chords.contrast=0.4 chords.presenceRatio=0.2
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSamples } from "../src/workers/offline.js";
import { readWav, downmixToMono } from "../src/eval/wav.js";
import { matchEvents, type DetectedEvent, type LabeledEvent } from "../src/eval/matcher.js";
import { resolvePolicy } from "../src/core/policy.js";
import type { TuninatorMode } from "../src/types.js";
import { REPO_ROOT, CACHE_DIR } from "./decode-fixtures.js";

const config = JSON.parse(
  readFileSync(join(REPO_ROOT, "fixtures", "eval.config.json"), "utf8")
) as Record<string, { mode?: string }>;

const overrides = process.argv.slice(2).map((a) => a.split("=") as [string, string]);

function apply(policy: Record<string, unknown>): void {
  for (const [path, value] of overrides) {
    const parts = path.split(".");
    let node = policy;
    for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>;
    node[parts.at(-1)!] = Number(value);
  }
}

let totalLabels = 0;
let totalExact = 0;
let totalExtra = 0;

if (overrides.length > 0) process.stdout.write(`${overrides.map((o) => o.join("=")).join(" ")}\n`);
process.stdout.write(`${"fixture".padEnd(42)}  named    extra  wrong\n`);

for (const stem of Object.keys(config)) {
  const mode = (config[stem]?.mode ?? "lead") as TuninatorMode;
  const wav = readWav(readFileSync(join(CACHE_DIR, "fixtures", `${stem}.wav`)));
  const mono = downmixToMono(wav.samples, wav.channels);
  const labels = JSON.parse(
    readFileSync(join(REPO_ROOT, "fixtures", "labels", `${stem}.json`), "utf8")
  ).events as LabeledEvent[];

  const policy = resolvePolicy({ mode });
  apply(policy as unknown as Record<string, unknown>);
  const events = analyzeSamples(mono, wav.sampleRate, { mode, policy })
    .events as unknown as DetectedEvent[];
  const result = matchEvents(labels, events);

  let exact = 0;
  let wrong = 0;
  for (const m of result.matches) {
    const name = m.detection?.label.name;
    if (name === m.label.label) exact++;
    else if (name !== undefined && name !== "unknown") wrong++;
  }
  const extra = result.falsePositives.length;

  totalLabels += labels.length;
  totalExact += exact;
  totalExtra += extra;

  process.stdout.write(
    `${stem.slice(0, 42).padEnd(42)}  ${String(exact).padStart(2)}/${String(labels.length).padEnd(3)} ` +
      `${((exact / labels.length) * 100).toFixed(0).padStart(4)}%  ${String(extra).padStart(3)}  ${String(
        wrong
      ).padStart(5)}\n`
  );
}

process.stdout.write(
  `${"TOTAL".padEnd(42)}  ${totalExact}/${totalLabels} ${((totalExact / totalLabels) * 100)
    .toFixed(1)
    .padStart(5)}%  ${totalExtra}\n`
);
