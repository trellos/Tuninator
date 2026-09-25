/**
 * Phase 3 runner: the repository's own end-to-end instruments, run with and
 * without the gate `phase3-gate.ts` installs, over the dev-only hook in
 * `phase3-hook.patch`. The configurations are the four `phase3-gate.ts` fixed
 * before any run; nothing here chooses one.
 *
 * Per configuration: `scripts/eval.ts` (what `npm run eval` runs after its
 * cached decode), `scripts/measure-downstream-ledger.ts --all`,
 * `scripts/measure-splits.ts` and `--subset=slow`. Outputs are kept under
 * <dir>/phase3/<config>/ and summarised against the ungated run.
 *
 * Requires the hook applied (`git apply training/basic-pitch/phase3-hook.patch`)
 * and <dir>/phase3/readings.json (`phase3-readings.ts`). Revert the hook
 * afterwards (`git checkout -- src/`); it is never committed.
 *
 * Usage:
 *   npx tsx training/basic-pitch/phase3-run.ts --dir training/out/basic-pitch [--only <config>]
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const i = process.argv.indexOf("--dir");
const dir = i >= 0 ? process.argv[i + 1] : undefined;
if (!dir) {
  console.error("usage: npx tsx training/basic-pitch/phase3-run.ts --dir <dir> [--only <config>]");
  process.exit(2);
}
const j = process.argv.indexOf("--only");
const only = j >= 0 ? process.argv[j + 1] : undefined;
const readings = resolve(join(dir, "phase3", "readings.json"));
if (!existsSync(readings)) throw new Error(`no ${readings}; run phase3-readings.ts first`);

const CONFIGS: Array<{ name: string; mode: string | null; theta: number | null }> = [
  { name: "ungated", mode: null, theta: null },
  { name: "all-0.15", mode: "all", theta: 0.15 },
  { name: "all-0.50", mode: "all", theta: 0.5 },
  { name: "samepitch-0.15", mode: "samepitch", theta: 0.15 },
  { name: "samepitch-0.50", mode: "samepitch", theta: 0.5 },
];

type Summary = {
  derivMissed: number;
  derivFp: number;
  heldMissed: number;
  heldFp: number;
  ledgerMissed: number;
  split: string;
  splitSlow: string;
  gate: string;
};

function run(args: string[], env: NodeJS.ProcessEnv, out: string): string {
  const r = spawnSync("npx", ["tsx", "--import", "./training/basic-pitch/phase3-gate.ts", ...args], {
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  writeFileSync(out, text);
  if (r.status !== 0 && !args[0]?.endsWith("eval.ts")) throw new Error(`${args.join(" ")} exited ${r.status}`);
  return text;
}

function evalTotals(reportPath: string): Pick<Summary, "derivMissed" | "derivFp" | "heldMissed" | "heldFp"> {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    fixtures: Array<{ stem: string; overall: { missedCount: number; falsePositiveCount: number } }>;
  };
  const t = { derivMissed: 0, derivFp: 0, heldMissed: 0, heldFp: 0 };
  for (const f of report.fixtures) {
    const held = f.stem.includes("140bpm");
    if (held) {
      t.heldMissed += f.overall.missedCount;
      t.heldFp += f.overall.falsePositiveCount;
    } else {
      t.derivMissed += f.overall.missedCount;
      t.derivFp += f.overall.falsePositiveCount;
    }
  }
  return t;
}

const summaries = new Map<string, Summary>();
for (const c of CONFIGS) {
  if (only !== undefined && c.name !== only && c.name !== "ungated") continue;
  const out = join(dir, "phase3", c.name);
  mkdirSync(out, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BP_GATE_MODE;
  if (c.mode !== null) {
    env.BP_GATE_MODE = c.mode;
    env.BP_GATE_THETA = String(c.theta);
    env.BP_GATE_READINGS = readings;
  }
  const t0 = Date.now();
  const evalText = run(["scripts/eval.ts"], env, join(out, "eval.txt"));
  copyFileSync(".cache/eval-report.json", join(out, "eval-report.json"));
  const ledger = run(["scripts/measure-downstream-ledger.ts", "--all"], env, join(out, "ledger.txt"));
  const splits = run(["scripts/measure-splits.ts"], env, join(out, "splits.txt"));
  const slow = run(["scripts/measure-splits.ts", "--subset=slow"], env, join(out, "splits-slow.txt"));
  const missedRow = ledger.split("\n").find((l) => /^\s+MISSED\s/.test(l)) ?? "";
  const total = (text: string): string => /TOTAL: (\d+ of \d+ events split, \d+ extra Notes)/.exec(text)?.[1] ?? "?";
  const gateLines = [evalText, ledger, splits, slow]
    .map((t) => /\[phase3 gate[^\]]*\] ([^\n]*)/.exec(t)?.[1] ?? "")
    .filter((s) => s !== "");
  summaries.set(c.name, {
    ...evalTotals(join(out, "eval-report.json")),
    ledgerMissed: Number(missedRow.trim().split(/\s+/).pop()),
    split: total(splits),
    splitSlow: total(slow),
    gate: gateLines[0] ?? "(no gate)",
  });
  console.log(`${c.name.padEnd(16)} done in ${((Date.now() - t0) / 1000).toFixed(0)}s; eval says ${/eval: (PASS|FAIL)[^\n]*/.exec(evalText)?.[0] ?? "?"}`);
}

console.log("");
const head = ["config", "deriv missed", "deriv FP", "held missed", "held FP", "ledger MISSED", "splits (all)", "splits (slow)", "gate on the eval run"];
const rows = [...summaries].map(([name, s]) => [
  name,
  String(s.derivMissed),
  String(s.derivFp),
  String(s.heldMissed),
  String(s.heldFp),
  String(s.ledgerMissed),
  s.split,
  s.splitSlow,
  s.gate,
]);
const width = head.map((h, k) => Math.max(h.length, ...rows.map((r) => (r[k] as string).length)));
const line = (r: string[]): string => r.map((c, k) => (k === 0 ? c.padEnd(width[k] as number) : c.padStart(width[k] as number))).join("  ");
const text = [line(head), width.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
console.log(text);
writeFileSync(join(dir, "phase3", `summary${only === undefined ? "" : `-${only}`}.txt`), `${text}\n`);
