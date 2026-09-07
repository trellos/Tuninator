/**
 * Score a completed relabel answer sheet against the shipped labels.
 *
 * The other half of `build-relabel-kit.ts`: joins an annotator's answers
 * (machine or human) to the kit manifest and to `fixtures/labels/`, and
 * reports agreement at 25/50/70ms tolerances, split by contested vs control,
 * derivation vs held-out, signal path, point kind, and ledger cause.
 *
 * WHAT AGREEMENT MEANS HERE. Every kit point is a moment t* in a fixture.
 * At tolerance T:
 *   shipped says yes  iff a shipped label onset lies within T of t*.
 *   annotator says yes iff their answer is `yes` AND one of their offsets
 *     (converted to fixture time) lies within T of t*.
 *   agreement = the two match. `unsure` rows are excluded from the agreement
 *   denominator and reported separately. A bare `yes` with no offset cannot
 *   be scored at a tolerance; it is scored only at window level (was there
 *   any shipped onset in the middle third at all) and counted.
 *
 * THE DECISION RULE, restated from `docs/ceiling-click-tracker-prompt.md`
 * before any number is read:
 *   - CONTROL points: the annotator must agree with the shipped labels on
 *     >= 95% (headline tolerance 50ms). Below that the kit or the pass is
 *     broken — fix it before reading anything else.
 *   - CONTESTED points: disagreement under ~10% -> label noise is not the
 *     binding constraint; over ~30%, concentrated on muted strums and the
 *     room-mic path -> the 0.73 ceiling is substantially annotation noise.
 *
 * The implied ceiling is computed directly: an oracle that scores 1 where
 * the annotator heard a new note and 0 where they did not, graded against
 * the shipped-label targets on the same points, has AUC (1 + TPR - FPR)/2.
 * That is the best any detector agreeing with this annotator could look on
 * these rows under the shipped grading.
 *
 * This script never edits `fixtures/labels/` — disagreements are reported as
 * proposals and compared against `.cache/proposed-label-corrections.json`.
 *
 * Usage:
 *   npx tsx scripts/score-relabel.ts .cache/relabel/answers-machine.csv
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, LABELS_DIR, type LabelFile } from "./decode-fixtures.js";
import type { KitPoint } from "./build-relabel-kit.js";

const KIT_DIR = join(CACHE_DIR, "relabel");
const TOLERANCES_MS = [25, 50, 70] as const;
/** The tolerance the control bar is judged at. */
const HEADLINE_MS = 50;
const CONTROL_BAR = 0.95;

type Answer = {
  id: string;
  answer: "yes" | "no" | "unsure" | "";
  offsetsMs: number[];
  /** Optional per-offset corroboration tags ("s"/"w"), from a `tags:` note. */
  tags: string[];
};

function readAnswers(path: string): Map<string, Answer> {
  const out = new Map<string, Answer>();
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const [id, answer, offsets, notes] = line.split(",");
    if (id === undefined) continue;
    const tagsMatch = /tags:([sw;]+)/.exec(notes ?? "");
    out.set(id.trim(), {
      id: id.trim(),
      answer: (answer ?? "").trim().toLowerCase() as Answer["answer"],
      offsetsMs: (offsets ?? "")
        .split(";")
        .map((s) => Number.parseFloat(s.trim()))
        .filter((v) => Number.isFinite(v)),
      tags: tagsMatch !== null ? (tagsMatch[1] as string).split(";") : [],
    });
  }
  return out;
}

const path = (stem: string): string =>
  stem.includes("amped")
    ? "amp sim"
    : stem.includes("-di-")
      ? "DI"
      : stem.includes("mic")
        ? "room mic"
        : "mic (default)";

const isHeldOut = (stem: string): boolean => stem.includes("140bpm");

type Scored = {
  point: KitPoint;
  answer: Answer;
  /** Per tolerance: shipped yes/no, annotator yes/no/null (null = unscoreable). */
  shipped: boolean[];
  annotator: (boolean | null)[];
  windowShipped: boolean;
  windowAnnotator: boolean | null;
};

function agreementTable(rows: Scored[], title: string): void {
  const buckets = new Map<string, Scored[]>();
  const keyOf = (s: Scored): string => {
    if (title === "contested vs control") return s.point.control ? "control" : "contested";
    if (title === "by kind") return s.point.kind;
    if (title === "derivation vs held out") return isHeldOut(s.point.stem) ? "held out" : "derivation";
    if (title === "by signal path") return path(s.point.stem);
    if (title === "misses, by ledger cause") return s.point.cause ?? "-";
    return "all";
  };
  for (const s of rows) {
    const k = keyOf(s);
    (buckets.get(k) ?? buckets.set(k, []).get(k))?.push(s);
  }
  console.log(`\n  ${title}\n`);
  const head = [
    "subset",
    "n",
    ...TOLERANCES_MS.map((t) => `agree@${t}`),
    "window",
    "ann+ lab-",
    "ann- lab+",
    "unsure",
  ];
  const body: string[][] = [];
  for (const [key, subset] of [...buckets.entries()].sort()) {
    const cells: string[] = [key, String(subset.length)];
    for (let ti = 0; ti < TOLERANCES_MS.length; ti++) {
      let agree = 0;
      let scored = 0;
      for (const s of subset) {
        const a = s.annotator[ti];
        if (a === null) continue;
        scored++;
        if (a === s.shipped[ti]) agree++;
      }
      cells.push(scored === 0 ? "-" : `${((100 * agree) / scored).toFixed(0)}% (${agree}/${scored})`);
    }
    let windowAgree = 0;
    let windowScored = 0;
    let annYesLabNo = 0;
    let annNoLabYes = 0;
    let unsure = 0;
    const hi = TOLERANCES_MS.length - 1;
    for (const s of subset) {
      if (s.windowAnnotator !== null) {
        windowScored++;
        if (s.windowAnnotator === s.windowShipped) windowAgree++;
      }
      if (s.answer.answer === "unsure") unsure++;
      const a = s.annotator[hi];
      if (a === true && s.shipped[hi] === false) annYesLabNo++;
      if (a === false && s.shipped[hi] === true) annNoLabYes++;
    }
    cells.push(
      windowScored === 0 ? "-" : `${((100 * windowAgree) / windowScored).toFixed(0)}%`,
      String(annYesLabNo),
      String(annNoLabYes),
      String(unsure)
    );
    body.push(cells);
  }
  const width: number[] = [];
  for (const row of [head, ...body]) {
    row.forEach((c, i) => (width[i] = Math.max(width[i] ?? 0, c.length)));
  }
  const line = (row: readonly string[]): string =>
    "  " +
    row.map((c, i) => (i === 0 ? c.padEnd(width[i] as number) : c.padStart(width[i] as number))).join("  ");
  console.log(line(head));
  console.log("  " + width.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}

function main(): void {
  const answersPath = process.argv[2];
  if (answersPath === undefined) {
    console.error("usage: npx tsx scripts/score-relabel.ts <answers.csv>");
    process.exit(1);
  }

  const points = JSON.parse(readFileSync(join(KIT_DIR, "manifest.json"), "utf8")) as KitPoint[];
  const answers = readAnswers(answersPath);

  const labelsByStem = new Map<string, number[]>();
  for (const point of points) {
    if (labelsByStem.has(point.stem)) continue;
    const file = JSON.parse(
      readFileSync(join(LABELS_DIR, `${point.stem}.json`), "utf8")
    ) as LabelFile;
    labelsByStem.set(
      point.stem,
      file.events.map((e) => e.startMs).sort((a, b) => a - b)
    );
  }

  const scored: Scored[] = [];
  let unanswered = 0;
  for (const point of points) {
    const answer = answers.get(point.id);
    if (answer === undefined || answer.answer === "") {
      unanswered++;
      continue;
    }
    const onsets = labelsByStem.get(point.stem) as number[];
    const windowLo = point.snippetStartMs + point.snippetMs / 3;
    const windowHi = point.snippetStartMs + (2 * point.snippetMs) / 3;
    const offsetsFixture = answer.offsetsMs.map((o) => point.snippetStartMs + o);

    const shipped: boolean[] = [];
    const annotator: (boolean | null)[] = [];
    for (const t of TOLERANCES_MS) {
      shipped.push(onsets.some((o) => Math.abs(o - point.momentMs) <= t));
      if (answer.answer === "unsure") annotator.push(null);
      else if (answer.answer === "no") annotator.push(false);
      else if (offsetsFixture.length === 0) annotator.push(null);
      else annotator.push(offsetsFixture.some((o) => Math.abs(o - point.momentMs) <= t));
    }
    scored.push({
      point,
      answer,
      shipped,
      annotator,
      windowShipped: onsets.some((o) => o >= windowLo && o <= windowHi),
      windowAnnotator:
        answer.answer === "unsure" ? null : answer.answer === "yes",
    });
  }

  console.log(`\n  ${scored.length} of ${points.length} kit points answered`);
  if (unanswered > 0) console.log(`  ${unanswered} unanswered — not scored`);

  agreementTable(scored, "contested vs control");
  agreementTable(scored, "by kind");
  agreementTable(scored, "derivation vs held out");
  agreementTable(scored, "by signal path");
  agreementTable(
    scored.filter((s) => s.point.kind === "miss"),
    "misses, by ledger cause"
  );

  /* ---- The strict reading: corroborated offsets only --------------------- */

  // When the sheet carries per-offset corroboration tags (the machine pass
  // does), a second, conservative reading counts only the `s` offsets. Its
  // control agreement is reported alongside — this reading does NOT satisfy
  // the pre-stated bar and is a secondary bound, not the primary answer.
  const tagged = scored.filter((s) => s.answer.tags.length === s.answer.offsetsMs.length && s.answer.offsetsMs.length > 0);
  if (tagged.length > 0) {
    console.log("\n  strict reading: corroborated (s-tagged) offsets only\n");
    const head = ["subset", "n", ...TOLERANCES_MS.map((t) => `agree@${t}`)];
    const body: string[][] = [];
    for (const [name, subset] of [
      ["control", scored.filter((s) => s.point.control)],
      ["contested", scored.filter((s) => !s.point.control)],
    ] as const) {
      const cells = [name, String(subset.length)];
      for (let ti = 0; ti < TOLERANCES_MS.length; ti++) {
        const t = TOLERANCES_MS[ti] as number;
        let agree = 0;
        let n = 0;
        for (const s of subset) {
          if (s.answer.answer === "unsure" || s.answer.answer === "") continue;
          n++;
          const strictOffsets = s.answer.offsetsMs.filter((_, i) => s.answer.tags[i] === "s");
          const annYes =
            s.answer.answer === "yes" &&
            strictOffsets.some((o) => Math.abs(s.point.snippetStartMs + o - s.point.momentMs) <= t);
          if (annYes === s.shipped[ti]) agree++;
        }
        cells.push(n === 0 ? "-" : `${((100 * agree) / n).toFixed(0)}% (${agree}/${n})`);
      }
      body.push(cells);
    }
    const width: number[] = [];
    for (const row of [head, ...body]) row.forEach((c, i) => (width[i] = Math.max(width[i] ?? 0, c.length)));
    const line = (row: readonly string[]): string =>
      "  " + row.map((c, i) => (i === 0 ? c.padEnd(width[i] as number) : c.padStart(width[i] as number))).join("  ");
    console.log(line(head));
    console.log("  " + width.map((w) => "-".repeat(w)).join("  "));
    for (const row of body) console.log(line(row));
  }

  /* ---- The pre-stated control bar ---------------------------------------- */

  const hIdx = TOLERANCES_MS.indexOf(HEADLINE_MS);
  const controls = scored.filter((s) => s.point.control && s.annotator[hIdx] !== null);
  const controlAgree = controls.filter((s) => s.annotator[hIdx] === s.shipped[hIdx]).length;
  const controlRate = controls.length === 0 ? 0 : controlAgree / controls.length;
  console.log(
    `\n  CONTROL BAR (${HEADLINE_MS}ms): ${(100 * controlRate).toFixed(1)}% ` +
      `(${controlAgree}/${controls.length}) — ${controlRate >= CONTROL_BAR ? "PASS" : "FAIL: the kit or the pass is broken; fix before reading the contested numbers"}`
  );

  /* ---- Onset timing, where both sides name a time ------------------------ */

  const deltas: number[] = [];
  for (const s of scored) {
    if (s.answer.answer !== "yes") continue;
    const onsets = labelsByStem.get(s.point.stem) as number[];
    for (const offset of s.answer.offsetsMs) {
      const t = s.point.snippetStartMs + offset;
      let best: number | null = null;
      for (const o of onsets) {
        if (best === null || Math.abs(o - t) < Math.abs(best)) best = o - t;
      }
      if (best !== null && Math.abs(best) <= 70) deltas.push(-best);
    }
  }
  deltas.sort((a, b) => a - b);
  if (deltas.length > 0) {
    const q = (p: number): number => deltas[Math.floor(deltas.length * p)] as number;
    console.log(
      `\n  annotator onset minus shipped onset, where within 70ms (n=${deltas.length}): ` +
        `p10 ${q(0.1).toFixed(0)}ms  median ${q(0.5).toFixed(0)}ms  p90 ${q(0.9).toFixed(0)}ms`
    );
  }

  /* ---- Implied ceiling on the decision rows ------------------------------ */

  console.log("\n  implied ceiling: annotator-oracle AUC against the shipped grading");
  console.log("  (a detector that agrees perfectly with this annotator can do no better)\n");
  for (const [name, subset] of [
    ["contested decision rows", scored.filter((s) => s.point.kind.startsWith("decision"))],
    ["all contested", scored.filter((s) => !s.point.control)],
  ] as const) {
    const parts: string[] = [];
    for (let ti = 0; ti < TOLERANCES_MS.length; ti++) {
      const usable = subset.filter((s) => s.annotator[ti] !== null);
      const pos = usable.filter((s) => s.shipped[ti]);
      const neg = usable.filter((s) => !s.shipped[ti]);
      if (pos.length === 0 || neg.length === 0) {
        parts.push(`@${TOLERANCES_MS[ti]} -`);
        continue;
      }
      const tpr = pos.filter((s) => s.annotator[ti] === true).length / pos.length;
      const fpr = neg.filter((s) => s.annotator[ti] === true).length / neg.length;
      parts.push(`@${TOLERANCES_MS[ti]} ${((1 + tpr - fpr) / 2).toFixed(3)}`);
    }
    console.log(`    ${name.padEnd(24)} ${parts.join("   ")}  (n=${subset.length})`);
  }

  /* ---- Against the eval's own proposed corrections ----------------------- */

  // The eval's proposed corrections are pitch-NAMING disagreements (octave,
  // quality) — a different axis from onset time. Overlap is reported for
  // completeness: a moment where the name is contested AND the onset is
  // contested is doubly suspect.
  const proposalsPath = join(CACHE_DIR, "proposed-label-corrections.json");
  if (existsSync(proposalsPath)) {
    const raw = JSON.parse(readFileSync(proposalsPath, "utf8")) as {
      fixtures?: Array<{
        fixture: string;
        disagreements: Array<{ detectedStartMs: number }>;
      }>;
    };
    const flagged: Array<{ stem: string; atMs: number }> = [];
    for (const f of raw.fixtures ?? []) {
      for (const d of f.disagreements) flagged.push({ stem: f.fixture, atMs: d.detectedStartMs });
    }
    const hIdx2 = TOLERANCES_MS.indexOf(HEADLINE_MS);
    const disagreed = scored.filter(
      (s) => !s.point.control && s.annotator[hIdx2] !== null && s.annotator[hIdx2] !== s.shipped[hIdx2]
    );
    const overlap = disagreed.filter((s) =>
      flagged.some((p) => p.stem === s.point.stem && Math.abs(p.atMs - s.point.momentMs) <= 70)
    ).length;
    console.log(
      `\n  onset disagreements that also carry a naming disagreement in the eval's\n` +
        `  proposed corrections (${flagged.length} naming proposals): ${overlap} of ${disagreed.length}`
    );
  }

  if (process.argv.includes("--detail")) {
    const hIdx3 = TOLERANCES_MS.indexOf(HEADLINE_MS);
    console.log("\n  every disagreement (headline tolerance)\n");
    for (const s of scored) {
      if (s.annotator[hIdx3] === null || s.annotator[hIdx3] === s.shipped[hIdx3]) continue;
      const direction = s.annotator[hIdx3] ? "annotator hears a new note; labels have none" : "labels claim one; annotator does not hear it";
      console.log(
        `    ${s.point.stem}  @${s.point.momentMs.toFixed(0).padStart(6)}  ${s.point.kind.padEnd(22)} ${direction}` +
          (s.answer.offsetsMs.length > 0
            ? `  [heard at ${s.answer.offsetsMs.map((o) => (s.point.snippetStartMs + o).toFixed(0)).join(", ")}]`
            : "")
      );
    }
  }

  console.log(
    "\n  fixtures/labels/ is untouched by this study; disagreements above are\n" +
      "  PROPOSALS for the maintainer, not corrections.\n"
  );
}

main();
