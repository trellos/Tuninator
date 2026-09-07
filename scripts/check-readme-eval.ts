/**
 * Checks README.md's evaluation numbers against .cache/eval-report.json.
 *
 * The README's per-fixture table and four of its prose figures are derived
 * numbers. They drifted once already: ten of seventeen rows fell behind the
 * recognizer, all of them understating it, because `npm run eval` gates on
 * thresholds and has no opinion about what the README claims. This closes that
 * loop.
 *
 * Usage:
 *   npx tsx scripts/check-readme-eval.ts            # check; nonzero on drift
 *   npx tsx scripts/check-readme-eval.ts --write    # rewrite README from the report
 *
 * Requires a report, so run `npm run eval` first. CI runs eval immediately
 * before this.
 *
 * Column semantics, which are NOT uniform and must not be "tidied":
 *   Labels / Notes / Missed      the overall figures
 *   Exact / Pitch class / Onset  the GATED subset — the rows the thresholds
 *                                actually judge. The three triplet takes have
 *                                every section marked informational, so their
 *                                gated subset is empty and they read "—".
 *                                Sourcing these from `overall` would make the
 *                                table look more complete while reporting a
 *                                different metric than the eval gates on.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const README = join(REPO_ROOT, "README.md");
const REPORT = join(REPO_ROOT, ".cache", "eval-report.json");

/**
 * Row order and display names, matching the README. Names are abbreviated
 * there for width; the stem is the join key, so renaming a column heading is
 * safe but reordering or renaming a fixture must be reflected here.
 */
const ROWS: ReadonlyArray<readonly [stem: string, display: string, required: boolean]> = [
  ["chords-a-bm-g-d-2x-120bpm", "`chords-a-bm-g-d-2x-120bpm`", true],
  ["clean-lead-120bpm", "`clean-lead-120bpm`", true],
  ["power-chords-c-a-g-e-c-d-fsharp-e-120bpm", "`power-chords-c-a-g-e-...-120bpm`", true],
  ["cowboy-chords-c-d-em-g-c-d-em-am-120bpm", "`cowboy-chords-...-120bpm`", false],
  ["cowboy-chords-di-d-em-g-c-2x-140bpm", "`cowboy-chords-di-...-140bpm`", false],
  ["cowboy-chords-mic-d-em-g-c-2x-140bpm", "`cowboy-chords-mic-...-140bpm`", false],
  ["cowboy-chords-amped-d-em-g-c-2x-140bpm", "`cowboy-chords-amped-...-140bpm`", false],
  ["power-chords-di-b-a-g-fsharp-b-a-g-e-140bpm", "`power-chords-di-...-140bpm`", false],
  ["power-chords-b-a-g-fsharp-b-a-g-e-140bpm", "`power-chords-...-140bpm` (mic)", false],
  ["power-chords-amped-b-a-g-fsharp-b-a-g-e-140bpm", "`power-chords-amped-...-140bpm`", false],
  ["spicy-chords-cmaj9-g-am11", "`spicy-chords-cmaj9-g-am11`", false],
  ["lead-line-di-sixteenths-e-fsharp-140bpm", "`lead-line-di-sixteenths-...-140bpm`", false],
  ["lead-line-sixteenths-e-fsharp-140bpm", "`lead-line-sixteenths-...-140bpm` (mic)", false],
  ["lead-line-amped-sixteenths-e-fsharp-140bpm", "`lead-line-amped-sixteenths-...-140bpm`", false],
  ["lead-line-di-quarter-eighth-triplet-140bpm", "`lead-line-di-quarter-eighth-triplet-140bpm`", false],
  ["lead-line-quarter-eighth-triplet-140bpm", "`lead-line-quarter-eighth-triplet-140bpm` (mic)", false],
  ["lead-line-amped-quarter-eighth-triplet-140bpm", "`lead-line-amped-quarter-eighth-triplet-140bpm`", false],
];

const SIXTEENTH_STEMS = [
  "lead-line-di-sixteenths-e-fsharp-140bpm",
  "lead-line-sixteenths-e-fsharp-140bpm",
  "lead-line-amped-sixteenths-e-fsharp-140bpm",
];
const TRIPLET_STEMS = [
  "lead-line-di-quarter-eighth-triplet-140bpm",
  "lead-line-quarter-eighth-triplet-140bpm",
  "lead-line-amped-quarter-eighth-triplet-140bpm",
];
/** The one required fixture whose pitch class the README quotes. */
const REQUIRED_LEAD_STEM = "clean-lead-120bpm";

type Stats = {
  labelCount: number;
  detectionCount: number;
  matchedCount: number;
  missedCount: number;
  scoredLabelCount: number;
  exactCorrect: number;
  pitchClassCorrect: number;
  onsetErrorMs: { medianAbs: number | null };
};
type Fixture = { stem: string; overall: Stats; gated?: Stats };

function loadReport(): Map<string, Fixture> {
  let raw: string;
  try {
    raw = readFileSync(REPORT, "utf8");
  } catch {
    console.error(`no eval report at ${REPORT} — run \`npm run eval\` first`);
    process.exit(2);
  }
  const parsed = JSON.parse(raw) as { fixtures: Fixture[] };
  return new Map(parsed.fixtures.map((f) => [f.stem, f]));
}

const pct = (n: number | undefined, d: number): string =>
  d > 0 && n !== undefined ? `${((100 * n) / d).toFixed(1)}%` : "—";

function buildTable(report: Map<string, Fixture>): string[] {
  const out = [
    "| Fixture | Required | Labels | Notes | Missed | Exact | Pitch class | Onset median |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const [stem, display, required] of ROWS) {
    const f = report.get(stem);
    if (!f) {
      console.error(`fixture in README table but not in the eval report: ${stem}`);
      process.exit(2);
    }
    const o = f.overall;
    const g = f.gated;
    const scored = g?.scoredLabelCount ?? 0;
    const median = g?.onsetErrorMs?.medianAbs;
    const onset = median === null || median === undefined ? "—" : `${Math.round(median)}ms`;
    out.push(
      `| ${display} | ${required ? "**yes**" : "no"} | ${o.labelCount} | ${o.detectionCount} | ` +
        `${o.missedCount} | ${pct(g?.exactCorrect, scored)} | ${pct(g?.pitchClassCorrect, scored)} | ${onset} |`
    );
  }
  return out;
}

/** Prose figures the report can derive. Each is `find` -> the correct text. */
function proseFigures(report: Map<string, Fixture>): Array<{ what: string; pattern: RegExp; correct: string }> {
  const get = (stem: string): Fixture => {
    const f = report.get(stem);
    if (!f) {
      console.error(`missing fixture ${stem}`);
      process.exit(2);
    }
    return f;
  };

  const lead = get(REQUIRED_LEAD_STEM).gated!;
  const leadPc = ((100 * lead.pitchClassCorrect) / lead.scoredLabelCount).toFixed(1);

  const sixteenth = SIXTEENTH_STEMS.map((s) => get(s).overall.matchedCount);
  const triplet = TRIPLET_STEMS.map((s) => get(s).overall.detectionCount);

  const onsets = [...report.values()]
    .map((f) => f.gated?.onsetErrorMs?.medianAbs)
    .filter((v): v is number => v !== null && v !== undefined);
  const scoring = onsets.length;
  const under25 = onsets.filter((v) => v < 25).length;
  const worst = Math.round(Math.max(...onsets));

  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen"];

  return [
    {
      what: "required lead fixture pitch class",
      pattern: /Pitch class on the required lead fixture is\n[\d.]+%\./,
      correct: `Pitch class on the required lead fixture is\n${leadPc}%.`,
    },
    {
      what: "sixteenth-note strokes found",
      pattern: /The sixteenth-note takes find [\d]+–[\d]+ of 48 strokes\./,
      correct: `The sixteenth-note takes find ${Math.min(...sixteenth)}–${Math.max(...sixteenth)} of 48 strokes.`,
    },
    {
      what: "triplet Notes emitted",
      pattern: /The triplet takes emit [\d]+–[\d]+ Notes for 55\n  labels\./,
      correct: `The triplet takes emit ${Math.min(...triplet)}–${Math.max(...triplet)} Notes for 55\n  labels.`,
    },
    {
      what: "onset spread",
      pattern: /of the [a-z]+ takes that score it, [a-z]+ have a median absolute error under\n25ms and the worst is \d+ms/,
      correct:
        `of the ${words[scoring] ?? scoring} takes that score it, ${words[under25] ?? under25} have a median absolute error under\n` +
        `25ms and the worst is ${worst}ms`,
    },
  ];
}

function main(): void {
  const write = process.argv.includes("--write");
  const report = loadReport();
  const original = readFileSync(README, "utf8");
  let text = original;

  const problems: string[] = [];

  // --- the table -----------------------------------------------------------
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("| Fixture | Required |"));
  if (start === -1) {
    console.error("could not find the eval table in README.md (no '| Fixture | Required |' header)");
    process.exit(2);
  }
  let end = start;
  while (end < lines.length && lines[end]!.startsWith("|")) end += 1;

  const actual = lines.slice(start, end);
  const expected = buildTable(report);

  if (actual.join("\n") !== expected.join("\n")) {
    const width = Math.max(actual.length, expected.length);
    for (let i = 0; i < width; i += 1) {
      if (actual[i] !== expected[i]) {
        problems.push(`  table row ${i + 1}:\n    README: ${actual[i] ?? "(missing)"}\n    report: ${expected[i] ?? "(missing)"}`);
      }
    }
    lines.splice(start, end - start, ...expected);
    text = lines.join("\n");
  }

  // --- prose figures -------------------------------------------------------
  for (const { what, pattern, correct } of proseFigures(report)) {
    const found = text.match(pattern);
    if (!found) {
      problems.push(`  ${what}: the sentence this check anchors on is no longer in README.md — update scripts/check-readme-eval.ts`);
      continue;
    }
    if (found[0] !== correct) {
      problems.push(`  ${what}:\n    README: ${JSON.stringify(found[0])}\n    report: ${JSON.stringify(correct)}`);
      text = text.replace(pattern, correct);
    }
  }

  if (problems.length === 0) {
    console.log("README evaluation numbers match .cache/eval-report.json");
    return;
  }

  if (write) {
    writeFileSync(README, text);
    console.log(`README.md updated from the eval report (${problems.length} figure(s) refreshed):`);
    console.log(problems.join("\n"));
    return;
  }

  console.error("README.md disagrees with .cache/eval-report.json:\n");
  console.error(problems.join("\n"));
  console.error("\nThe eval output is authoritative (AGENTS.md §5).");
  console.error("Refresh with: npx tsx scripts/check-readme-eval.ts --write");
  process.exit(1);
}

main();
