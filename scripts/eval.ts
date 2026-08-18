/**
 * The offline eval harness: decode -> analyze -> match -> score, per fixture.
 *
 * This is what proves the detector against recorded guitar rather than
 * synthetic sine waves, and it is what fails loudly on regression. It exits
 * nonzero when any fixture marked `required: true` misses a threshold.
 *
 * Usage:
 *   npm run eval
 *   npx tsx scripts/eval.ts --trace clean-lead-120bpm
 *   npx tsx scripts/eval.ts --force-decode
 *
 * Outputs:
 *   .cache/eval-report.json                  full numbers, machine-readable
 *   .cache/proposed-label-corrections.json   written when the detector
 *                                            confidently disagrees with a label
 *   .cache/trace-<fixture>.csv               with --trace
 *
 * The label files are ground truth and are never written to. When the detector
 * is confident and the label disagrees, the evidence goes to
 * proposed-label-corrections.json for a human to judge.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { TuninatorMode } from "../src/types.js";
import type {
  ConfidentDisagreement,
  DetectedEvent,
  EvalStats,
  LabeledEvent,
  MatchResult,
  SectionSpec,
  ThresholdCheck,
  Thresholds,
} from "../src/eval/matcher.js";
import {
  checkThresholds,
  filterResult,
  matchEvents,
  scoreMatches,
  sectionForDetection,
  sectionForLabel,
} from "../src/eval/matcher.js";
import {
  analyzeSamples,
  analyzeSamplesDetailed,
  type DetailedAnalyzeResult,
  type TraceRow,
} from "../src/workers/offline.js";
import { downmixToMono, readWav } from "../src/eval/wav.js";
import {
  CACHE_DIR,
  REPO_ROOT,
  decodeFixtures,
  type DecodeOutcome,
} from "./decode-fixtures.js";

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

type ConfiguredSection = SectionSpec & { note?: string };

type FixtureConfig = Thresholds & {
  /** A required fixture missing any threshold fails the whole run. */
  required?: boolean;
  mode?: TuninatorMode;
  gateNote?: string;
  sections?: Record<string, ConfiguredSection>;
  confidentlyWrongOn?: "exact" | "pitchClass";
  confidentLabelThreshold?: number;
  onsetWindowMs?: number;
};

const CONFIG_PATH = join(REPO_ROOT, "fixtures", "eval.config.json");
const DEFAULT_CONFIDENT_THRESHOLD = 0.6;

function loadConfig(): Record<string, FixtureConfig> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, FixtureConfig>;
  } catch (error) {
    throw new Error(`could not read ${CONFIG_PATH}: ${(error as Error).message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

const NA = "n/a";

function num(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? NA : value.toFixed(digits);
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? NA : `${(value * 100).toFixed(1)}%`;
}

function rule(width = 78): string {
  return "-".repeat(width);
}

type Column = { header: string; stats: EvalStats };

function renderTable(columns: readonly Column[]): string {
  const rows: Array<[string, (s: EvalStats) => string]> = [
    ["labels", (s) => String(s.labelCount)],
    ["detections", (s) => String(s.detectionCount)],
    ["matched", (s) => String(s.matchedCount)],
    ["missed", (s) => String(s.missedCount)],
    ["false positives", (s) => String(s.falsePositiveCount)],
    ["abstained (unknown)", (s) => String(s.unknownDetectionCount)],
    ["abstention rate", (s) => pct(s.abstentionRate)],
    ["scored labels", (s) => String(s.scoredLabelCount)],
    ["label acc: exact", (s) => pct(s.exactAccuracy)],
    ["label acc: pitch class", (s) => pct(s.pitchClassAccuracy)],
    ["pitch-class-only (octave off)", (s) => String(s.octaveOnlyCount)],
    ["confidently wrong", (s) => String(s.confidentlyWrongCount)],
    ["onset err median (signed)", (s) => num(s.onsetErrorMs.medianSigned)],
    ["onset err p90 (signed)", (s) => num(s.onsetErrorMs.p90Signed)],
    ["onset err median (abs)", (s) => num(s.onsetErrorMs.medianAbs)],
    ["onset err p90 (abs)", (s) => num(s.onsetErrorMs.p90Abs)],
    ["end err median (signed)", (s) => num(s.endErrorMs.medianSigned)],
    ["end err median (abs)", (s) => num(s.endErrorMs.medianAbs)],
    ["mean conf (matched)", (s) => num(s.meanConfidenceMatched, 3)],
    ["mean conf (unmatched)", (s) => num(s.meanConfidenceUnmatched, 3)],
  ];

  const labelWidth = Math.max(...rows.map(([name]) => name.length));
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...rows.map(([, get]) => get(column.stats).length), i === 0 ? 7 : 5)
  );

  const lines: string[] = [];
  lines.push(
    `  ${"metric".padEnd(labelWidth)}  ` +
      columns.map((c, i) => c.header.padStart(widths[i] as number)).join("  ")
  );
  lines.push(`  ${"-".repeat(labelWidth)}  ` + widths.map((w) => "-".repeat(w)).join("  "));
  for (const [name, get] of rows) {
    lines.push(
      `  ${name.padEnd(labelWidth)}  ` +
        columns.map((c, i) => get(c.stats).padStart(widths[i] as number)).join("  ")
    );
  }
  return lines.join("\n");
}

function renderChecks(checks: readonly ThresholdCheck[]): string {
  if (checks.length === 0) return "    (no thresholds configured)";
  return checks
    .map((check) => {
      const verdict = check.passed ? "PASS" : "FAIL";
      const operator = check.comparison === "min" ? ">=" : "<=";
      const actual = check.actual === null ? NA : formatCheckValue(check);
      const limit = formatLimit(check);
      const note = check.note ? `   (${check.note})` : "";
      return `    ${verdict}  ${check.name.padEnd(32)} ${actual.padStart(8)} ${operator} ${limit}${note}`;
    })
    .join("\n");
}

type CheckUnit = "ratio" | "ms" | "count";

function checkUnit(check: ThresholdCheck): CheckUnit {
  if (check.name.startsWith("minLabelAccuracy")) return "ratio";
  return check.name.endsWith("Ms") ? "ms" : "count";
}

function formatCheckNumber(value: number | null, unit: CheckUnit): string {
  if (unit === "ratio") return pct(value);
  return num(value, unit === "ms" ? 1 : 0);
}

function formatCheckValue(check: ThresholdCheck): string {
  return formatCheckNumber(check.actual, checkUnit(check));
}

function formatLimit(check: ThresholdCheck): string {
  return formatCheckNumber(check.limit, checkUnit(check));
}

/* -------------------------------------------------------------------------- */
/* Per-fixture evaluation                                                      */
/* -------------------------------------------------------------------------- */

type SectionReport = { name: string; required: boolean; stats: EvalStats };

type FixtureReport = {
  stem: string;
  required: boolean;
  mode: TuninatorMode;
  sourceAudio: string;
  wavPath: string;
  audio: { sampleCount: number; sampleRate: number; channels: number; durationMs: number } | null;
  error: string | null;
  overall: EvalStats | null;
  gated: EvalStats | null;
  sections: SectionReport[];
  checks: ThresholdCheck[];
  passed: boolean;
  corrections: ConfidentDisagreement[];
  /** Every matched pair, for eyeballing what the detector actually did. */
  pairs: Array<{
    labelId: string;
    expected: string;
    detectionId: string;
    detected: string;
    onsetDeltaMs: number;
    endDeltaMs: number | null;
    exact: boolean;
    pitchClass: boolean;
    abstained: boolean;
    confidence: number;
  }>;
  missedLabels: Array<{ id: string; label: string; startMs: number; endMs: number }>;
  /** Together with `pairs`, this accounts for every detection the engine made. */
  falsePositiveDetections: Array<{
    id: string;
    label: string;
    startMs: number;
    endMs: number | null;
    confidence: number;
  }>;
};

function inferMode(labels: readonly LabeledEvent[]): TuninatorMode {
  return labels.some((event) => event.kind === "chord") ? "chords" : "lead";
}

function evaluateFixture(
  fixture: DecodeOutcome,
  config: FixtureConfig,
  traceStem: string | null
): FixtureReport {
  const labels = fixture.label.events as LabeledEvent[];
  const mode = config.mode ?? inferMode(labels);
  const required = config.required === true;
  const sections = config.sections ?? {};
  const sectionNames = Object.keys(sections);

  const report: FixtureReport = {
    stem: fixture.stem,
    required,
    mode,
    sourceAudio: relative(REPO_ROOT, fixture.audioPath),
    wavPath: relative(REPO_ROOT, fixture.wavPath),
    audio: {
      sampleCount: fixture.sampleCount,
      sampleRate: fixture.sampleRate,
      channels: fixture.channels,
      durationMs: fixture.durationMs,
    },
    error: null,
    overall: null,
    gated: null,
    sections: [],
    checks: [],
    passed: true,
    corrections: [],
    pairs: [],
    missedLabels: [],
    falsePositiveDetections: [],
  };

  let detections: DetectedEvent[];
  let trace: TraceRow[] = [];

  try {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    // Only the traced fixture pays for the per-hop trace array.
    const wantTrace = traceStem === fixture.stem;
    const analysis = wantTrace
      ? analyzeSamplesDetailed(mono, wav.sampleRate, { mode })
      : analyzeSamples(mono, wav.sampleRate, { mode });
    detections = analysis.events as unknown as DetectedEvent[];
    if (wantTrace) trace = (analysis as DetailedAnalyzeResult).trace;
  } catch (error) {
    report.error = (error as Error).message;
    report.passed = false;
    return report;
  }

  if (traceStem === fixture.stem) writeTrace(fixture.stem, trace);

  const scoreOptions = {
    confidentLabelThreshold: config.confidentLabelThreshold ?? DEFAULT_CONFIDENT_THRESHOLD,
    confidentlyWrongOn: config.confidentlyWrongOn ?? ("pitchClass" as const),
  };

  // Match ONCE over the whole take, then partition. Excluding a section from
  // the gate must never change how the rest of the fixture was matched.
  const result = matchEvents(labels, detections, { onsetWindowMs: config.onsetWindowMs });

  report.overall = scoreMatches(result, scoreOptions);
  report.pairs = result.matches.map((m) => ({
    labelId: m.label.id,
    expected: m.label.label,
    detectionId: m.detection.id,
    detected: m.detection.label.name,
    onsetDeltaMs: m.onsetDeltaMs,
    endDeltaMs: m.endDeltaMs,
    exact: m.agreement.exact,
    pitchClass: m.agreement.pitchClass,
    abstained: m.abstained,
    confidence: m.detection.confidence,
  }));
  report.missedLabels = result.missed.map(({ label: l }) => ({
    id: l.id,
    label: l.label,
    startMs: l.startMs,
    endMs: l.endMs,
  }));
  report.falsePositiveDetections = result.falsePositives.map(({ detection: d }) => ({
    id: d.id,
    label: d.label.name,
    startMs: d.startedAt,
    endMs: d.endedAt,
    confidence: d.confidence,
  }));
  // Corrections are collected on EXACT disagreement so octave-only cases —
  // the likeliest genuine label fixes — are captured regardless of the gate.
  report.corrections = scoreMatches(result, {
    confidentLabelThreshold: scoreOptions.confidentLabelThreshold,
    confidentlyWrongOn: "exact",
  }).confidentlyWrong;

  let gatedResult: MatchResult = result;
  if (sectionNames.length > 0) {
    for (const name of sectionNames) {
      const sectionStats = scoreMatches(
        filterResult(
          result,
          (label) => sectionForLabel(label, sections) === name,
          (detection) => sectionForDetection(detection, sections) === name
        ),
        scoreOptions
      );
      report.sections.push({
        name,
        required: (sections[name] as ConfiguredSection).required !== false,
        stats: sectionStats,
      });
    }

    const excluded = new Set(
      sectionNames.filter((name) => (sections[name] as ConfiguredSection).required === false)
    );
    gatedResult = filterResult(
      result,
      (label) => !excluded.has(sectionForLabel(label, sections) ?? ""),
      (detection) => !excluded.has(sectionForDetection(detection, sections) ?? "")
    );
  }

  report.gated = scoreMatches(gatedResult, scoreOptions);
  report.checks = checkThresholds(report.gated, config);
  report.passed = report.checks.every((check) => check.passed);

  return report;
}

function writeTrace(stem: string, trace: readonly TraceRow[]): void {
  const path = join(CACHE_DIR, `trace-${stem}.csv`);
  const header =
    "timestampMs,frequencyHz,confidence,rms,tau,cmnd,zeroCrossingHz,onset,onsetFlux,nearestNote";
  const csv = (value: number | string | boolean | null): string => {
    if (value === null) return "";
    if (typeof value === "boolean") return value ? "1" : "0";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    return value;
  };
  const lines = trace.map((row) =>
    [
      csv(row.timestampMs),
      csv(row.frequencyHz),
      csv(row.confidence),
      csv(row.rms),
      csv(row.tau),
      csv(row.cmnd),
      csv(row.zeroCrossingHz),
      csv(row.onset),
      csv(row.onsetFlux),
      csv(row.nearestNote),
    ].join(",")
  );
  writeFileSync(path, `${header}\n${lines.join("\n")}\n`);
  process.stdout.write(`  trace written: ${relative(REPO_ROOT, path)} (${trace.length} rows)\n`);
}

/* -------------------------------------------------------------------------- */
/* Printing                                                                    */
/* -------------------------------------------------------------------------- */

function printFixture(report: FixtureReport, config: FixtureConfig): void {
  const out = process.stdout;
  out.write(`\n${rule()}\n`);
  out.write(
    `${report.stem}\n  mode=${report.mode}  ${report.required ? "REQUIRED" : "informational"}\n`
  );
  out.write(`  source  ${report.sourceAudio}\n`);
  if (report.audio) {
    out.write(
      `  audio   ${(report.audio.durationMs / 1000).toFixed(3)}s  ` +
        `${report.audio.sampleCount} samples @ ${report.audio.sampleRate}Hz x${report.audio.channels}\n`
    );
  }

  if (report.error) {
    out.write(`\n  ERROR: ${report.error}\n`);
    out.write(
      report.required
        ? "  This fixture is required, so the run fails.\n"
        : "  This fixture is informational, so the run is not failed by it.\n"
    );
    return;
  }

  const overall = report.overall as EvalStats;
  const gated = report.gated as EvalStats;
  const columns: Column[] = [{ header: "overall", stats: overall }];
  if (report.sections.length > 0) {
    columns.push({ header: "gated", stats: gated });
    for (const section of report.sections) {
      columns.push({
        header: section.required ? section.name : `${section.name}*`,
        stats: section.stats,
      });
    }
  }

  out.write(`\n${renderTable(columns)}\n`);
  if (report.sections.some((section) => !section.required)) {
    out.write("  * excluded from the required gate by config; numbers still reported.\n");
  }

  // Abstention gets its own line: it is a feature, not an error, and it is the
  // headline number for the extended-voicing fixture.
  out.write(
    `\n  honest abstention: ${overall.unknownDetectionCount}/${overall.detectionCount} ` +
      `detections said "unknown" (${pct(overall.abstentionRate)}) - NOT counted as wrong labels\n`
  );
  out.write(
    `  confidently wrong: ${overall.confidentlyWrongCount} ` +
      `(confidence >= ${config.confidentLabelThreshold ?? DEFAULT_CONFIDENT_THRESHOLD}, ` +
      `disagrees on ${config.confidentlyWrongOn ?? "pitchClass"})\n`
  );

  if (config.gateNote) out.write(`\n  gate: ${config.gateNote}\n`);
  out.write(`\n  thresholds (gated subset)\n${renderChecks(report.checks)}\n`);

  if (overall.confidentlyWrong.length > 0) {
    out.write("\n  confident disagreements\n");
    for (const item of overall.confidentlyWrong.slice(0, 12)) {
      out.write(
        `    ${item.labelId.padEnd(5)} expected ${item.expected.padEnd(14)} ` +
          `got ${item.detected.padEnd(14)} conf ${item.confidence.toFixed(2)}  ` +
          `[${item.disagreement}]\n`
      );
    }
    if (overall.confidentlyWrong.length > 12) {
      out.write(`    ... ${overall.confidentlyWrong.length - 12} more (see eval-report.json)\n`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

function parseArgs(argv: readonly string[]): { trace: string | null; forceDecode: boolean } {
  let trace: string | null = null;
  let forceDecode = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--trace") {
      trace = argv[i + 1] ?? null;
      i += 1;
    } else if (arg !== undefined && arg.startsWith("--trace=")) {
      trace = arg.slice("--trace=".length);
    } else if (arg === "--force-decode") {
      forceDecode = true;
    }
  }
  return { trace, forceDecode };
}

function resolveTraceStem(requested: string | null, stems: readonly string[]): string | null {
  if (requested === null) return null;
  if (stems.includes(requested)) return requested;
  const partial = stems.filter((stem) => stem.includes(requested));
  if (partial.length === 1) return partial[0] as string;
  const detail = partial.length === 0 ? "no match" : `ambiguous: ${partial.join(", ")}`;
  throw new Error(
    `--trace "${requested}": ${detail}. Known fixtures:\n  ${stems.join("\n  ")}`
  );
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  mkdirSync(CACHE_DIR, { recursive: true });

  // Cached, so this is free when `npm run eval` already decoded. Keeps a bare
  // `tsx scripts/eval.ts` correct too.
  const fixtures = decodeFixtures({ quiet: true, force: args.forceDecode });
  const traceStem = resolveTraceStem(
    args.trace,
    fixtures.map((f) => f.stem)
  );

  process.stdout.write("tuninator offline eval\n");
  process.stdout.write(`  fixtures: ${fixtures.length}   config: ${relative(REPO_ROOT, CONFIG_PATH)}\n`);

  const unconfigured = fixtures.filter((f) => config[f.stem] === undefined).map((f) => f.stem);
  if (unconfigured.length > 0) {
    process.stdout.write(
      `  WARNING: no eval.config.json entry for: ${unconfigured.join(", ")} ` +
        "(treated as informational, no thresholds)\n"
    );
  }

  const reports: FixtureReport[] = [];
  for (const fixture of fixtures) {
    const fixtureConfig = config[fixture.stem] ?? {};
    const report = evaluateFixture(fixture, fixtureConfig, traceStem);
    reports.push(report);
    printFixture(report, fixtureConfig);
  }

  /* Summary */
  process.stdout.write(`\n${rule()}\nsummary\n`);
  const nameWidth = Math.max(...reports.map((r) => r.stem.length));
  let failures = 0;

  for (const report of reports) {
    const failed = report.error !== null || !report.passed;
    const blocking = failed && report.required;
    if (blocking) failures += 1;

    const verdict = report.error !== null ? "ERROR" : report.passed ? "PASS " : "FAIL ";
    const scope = report.required ? "required" : "informational";
    const reasons =
      report.error !== null
        ? report.error.split("\n")[0]
        : report.checks
            .filter((check) => !check.passed)
            .map((check) => check.name)
            .join(", ");
    process.stdout.write(
      `  ${verdict} ${report.stem.padEnd(nameWidth)}  ${scope.padEnd(13)} ${reasons}\n`
    );
  }

  /* Reports on disk */
  const reportPath = join(CACHE_DIR, "eval-report.json");
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        configPath: relative(REPO_ROOT, CONFIG_PATH),
        config,
        fixtures: reports,
        requiredFailures: failures,
      },
      null,
      2
    )}\n`
  );
  process.stdout.write(`\n  report: ${relative(REPO_ROOT, reportPath)}\n`);

  const corrections = reports
    .filter((report) => report.corrections.length > 0)
    .map((report) => ({ fixture: report.stem, disagreements: report.corrections }));

  const correctionsPath = join(CACHE_DIR, "proposed-label-corrections.json");
  writeFileSync(
    correctionsPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          "Evidence only. fixtures/labels/*.json is ground truth and is never " +
          "edited by the harness. A human decides whether any of these are real " +
          "label errors. 'octave' disagreements are the likeliest candidates: " +
          "the label files state that octaves are first-pass estimates.",
        fixtures: corrections,
      },
      null,
      2
    )}\n`
  );
  if (corrections.length > 0) {
    const total = corrections.reduce((sum, entry) => sum + entry.disagreements.length, 0);
    process.stdout.write(
      `  proposed label corrections: ${total} confident disagreement(s) -> ` +
        `${relative(REPO_ROOT, correctionsPath)}\n`
    );
  }

  if (failures > 0) {
    process.stdout.write(
      `\neval: FAIL - ${failures} required fixture(s) missed a threshold or errored\n`
    );
    return 1;
  }
  process.stdout.write("\neval: PASS - every required fixture met its thresholds\n");
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`eval: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
