/**
 * Phase 3 before/after, split derivation / held-out, from the outputs
 * `phase3-run.ts` saved per configuration: the eval report's missed labels and
 * false positives, the ledger's missed labels by branch, and the split counts
 * overall and on the slow subset. Reads files only.
 *
 * What it printed on 2026-09-25 (missed / false positives, derivation and
 * held-out; all takes' split events / extra Notes; ledger MISSED):
 *   ungated (= HEAD)         100 / 191   27 / 63   232 / 265   127
 *   every Note, 0.15         100 / 188   27 / 62   231 / 262   127   withheld 4
 *   every Note, 0.50         147 /  93   66 / 26   119 / 129   213   withheld 209; clean-lead fails
 *   same-pitch child, 0.15   100 / 191   27 / 63   232 / 265   127   withheld 0
 *   same-pitch child, 0.50   134 / 110   55 / 34   142 / 153   189   withheld 150; clean-lead fails
 * No configuration lowers one error count without raising the other, except
 * by the 4 Notes the zero-cost gate withholds.
 *
 * Usage: npx tsx training/basic-pitch/phase3-summary.ts --dir training/out/basic-pitch
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const i = process.argv.indexOf("--dir");
const dir = i >= 0 ? process.argv[i + 1] : undefined;
if (!dir) {
  console.error("usage: npx tsx training/basic-pitch/phase3-summary.ts --dir <dir>");
  process.exit(2);
}
const CONFIGS = ["ungated", "all-0.15", "all-0.50", "samepitch-0.15", "samepitch-0.50"];
const held = (stem: string): boolean => stem.includes("140bpm");

type Row = Record<string, string>;
const rows: Row[] = [];
const branches = new Map<string, Map<string, number>>();
for (const c of CONFIGS) {
  const d = join(dir, "phase3", c);
  if (!existsSync(join(d, "splits-slow.txt"))) continue;
  const report = JSON.parse(readFileSync(join(d, "eval-report.json"), "utf8")) as {
    fixtures: Array<{ stem: string; overall: { missedCount: number; falsePositiveCount: number } }>;
  };
  const ev = { dm: 0, dfp: 0, hm: 0, hfp: 0 };
  for (const f of report.fixtures) {
    if (held(f.stem)) {
      ev.hm += f.overall.missedCount;
      ev.hfp += f.overall.falsePositiveCount;
    } else {
      ev.dm += f.overall.missedCount;
      ev.dfp += f.overall.falsePositiveCount;
    }
  }
  const splitTable = (file: string) => {
    const t = { dLabels: 0, dSplit: 0, dExtra: 0, hLabels: 0, hSplit: 0, hExtra: 0 };
    for (const line of readFileSync(join(d, file), "utf8").split("\n")) {
      const m = /^ {2}(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/.exec(line);
      if (m === null) continue;
      const [, stem, labels, split, extra] = m as unknown as [string, string, string, string, string];
      if (held(stem)) {
        t.hLabels += Number(labels);
        t.hSplit += Number(split);
        t.hExtra += Number(extra);
      } else {
        t.dLabels += Number(labels);
        t.dSplit += Number(split);
        t.dExtra += Number(extra);
      }
    }
    return t;
  };
  const all = splitTable("splits.txt");
  const slow = splitTable("splits-slow.txt");
  const ledger = readFileSync(join(d, "ledger.txt"), "utf8").split("\n");
  const causes = new Map<string, number>();
  let inTable = false;
  for (const line of ledger) {
    if (/^\s+cause\s/.test(line)) inTable = true;
    if (!inTable) continue;
    if (/^\s*$/.test(line)) break;
    const m = /^ {2}(.+?)\s{2,}.*\s(\d+)$/.exec(line);
    if (m === null || m[1] === undefined || m[1].startsWith("-") || m[1] === "cause" || m[1] === "detections") continue;
    causes.set(m[1].trim(), Number(m[2]));
  }
  branches.set(c, causes);
  const g = /\[phase3 gate[^\]]*\] ([^\n]*)/.exec(readFileSync(join(d, "eval.txt"), "utf8"));
  rows.push({
    config: c,
    "deriv missed": String(ev.dm),
    "deriv FP": String(ev.dfp),
    "held missed": String(ev.hm),
    "held FP": String(ev.hfp),
    "deriv split / extra": `${all.dSplit} / ${all.dExtra}`,
    "held split / extra": `${all.hSplit} / ${all.hExtra}`,
    "slow split / extra": `${slow.dSplit + slow.hSplit} / ${slow.dExtra + slow.hExtra}`,
    gate: g?.[1] ?? "-",
  });
}

const table = (head: string[], body: string[][]): void => {
  const w = head.map((h, k) => Math.max(h.length, ...body.map((r) => (r[k] ?? "").length)));
  const line = (r: string[]): string => r.map((c, k) => (k === 0 ? c.padEnd(w[k] as number) : c.padStart(w[k] as number))).join("  ");
  console.log(line(head));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of body) console.log(line(r));
};
const head = Object.keys(rows[0] ?? {});
table(head, rows.map((r) => head.map((h) => r[h] ?? "")));
console.log("");
const allCauses = [...new Set([...branches.values()].flatMap((m) => [...m.keys()]))].filter((c) => c !== "MISSED");
table(
  ["ledger branch (all takes)", ...branches.keys()],
  [...allCauses, "MISSED"].map((c) => [c, ...[...branches.values()].map((m) => String(m.get(c) ?? 0))]),
);
