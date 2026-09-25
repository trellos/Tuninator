/**
 * Phase 2: does spotify/basic-pitch carry note-boundary information the
 * engine's witnesses lack? The report over the rows `phase2-rows.ts` collects.
 *
 * EVERYTHING BELOW WAS FIXED IN WRITING, AND COMMITTED, BEFORE THE MODEL WAS
 * READ ON ANY FIXTURE (2026-09-25). Nothing in this header was changed after
 * a number was seen; any later note says so and why.
 *
 * ---------------------------------------------------------------------------
 * SETS
 * ---------------------------------------------------------------------------
 * Derivation: the 15 tuning takes (`engine-run.ts` DERIVATION): the five
 * originals, the eight 120bpm same-pitch takes, the two rest-repick takes.
 * Every bar, threshold and operating point is decided on these alone.
 * Held-out: the twelve 140bpm takes, read ONCE by `phase2-rows.ts --heldout`
 * after this file is committed, reported in a section labelled HELD-OUT, with
 * the operating points taken from derivation unchanged.
 *
 * ---------------------------------------------------------------------------
 * HOW THE MODEL IS READ (`causal.ts`, fixed in Phase 1)
 * ---------------------------------------------------------------------------
 * A reading at decision time T is one model window whose frame 156 is centred
 * on T, holding the 1807ms of audio before T and ZEROS after it; only frames
 * at or before T are used. Audio is the engine's own 48kHz decode, downmixed
 * as the engine does and resampled to 22050Hz by `resample.ts` (validated in
 * `parity.ts`).
 *   FAST  T = the engine's own decision time for that row (below). What a
 *         fast-lane decision could have had.
 *   DEEP  T = the row's event time + 200ms: `deep.regionSettleMs`, the audio
 *         the engine's deep lane already waits for after a Note before it
 *         rules on a region. The deep lane's ring is 4s; a reading holds
 *         1.8s of it and nothing that has not arrived.
 *   WHOLE the package's own windowing over the whole take (`framing.ts`):
 *         every frame with its look-ahead. NOT buildable in either lane;
 *         reported only to show what the look-ahead is worth. No bar may be
 *         met by a WHOLE reading.
 * Every window used here against 107ms: the onset window +-40ms (80ms wide);
 * the model's frame 11.6ms; its onset output's CNN reach +-116ms and the CQT
 * filters (313ms half-span at E2) are look-ahead, removed by the zeros in FAST
 * and DEEP, and their cost is the FAST/DEEP/WHOLE gap.
 *
 * ---------------------------------------------------------------------------
 * FEATURES (read on a reading R; pitch set PS; model bins are MIDI 21..108)
 * ---------------------------------------------------------------------------
 * PS for a single note of MIDI m: m's pitch class in every octave from E2 to
 * E6 (MIDI 40..88), so an octave error on either side does not hide it. For a
 * chord label, the union of its listed pitches' classes; for an engine chord
 * or "unknown" Note, all of MIDI 40..88.
 *   O(S)     onset: the largest onset activation over PS in the frames whose
 *            centre is within 40ms of the event time S (and at or before T).
 *   N(a,b)   sounding: the mean over frames centred in [a,b] of the largest
 *            note activation over PS.
 *   P(a,b,m) pitch agreement: 1 when the pitch class of the MIDI note with
 *            the highest mean note activation over [a,b] (MIDI 40..88) is m's,
 *            else 0. Single-note Notes only.
 * The model's own thresholds, from the package, are the fixed operating
 * points of every 2x2 table: onset 0.5, note 0.3.
 *
 * ---------------------------------------------------------------------------
 * Q1  GHOSTS  (OUTCOME-shaped: is this emitted Note surplus?)
 * ---------------------------------------------------------------------------
 * Rows: every Note in the final projection of a derivation take that the
 * matcher either paired with a required label (matched, y=0) or left unpaired
 * (extra, y=1). Notes paired with an optional label are neither and excluded.
 * S = the Note's start, E = its end (S + 1ms if none).
 *   FAST: T = the time the engine emitted the Note's `started` (announce).
 *         O(S); N(S, T); P(S, T).
 *   DEEP: O(S) read at T = S + 200; N and P over [S, min(E, S+1500)] read at
 *         T = min(E, S+1500) + 200.
 * AUC oriented in advance: LOW onset, LOW sounding, disagreeing pitch =
 * surplus. BAR: AUC >= 0.80 for O, N or P in the DEEP reading (a deep-lane
 * witness); the same in FAST makes it a fast-lane witness too.
 *
 * ---------------------------------------------------------------------------
 * Q2  SPLITS, pitch unchanged
 * ---------------------------------------------------------------------------
 * Rows: every `rearticulation` trace event on a derivation take that was
 * accepted, settled and same-pitch and opened a child Note — the rows of
 * `scripts/measure-decision-separability.ts`'s `collectFixture` with those
 * filters (its child rule: the next `opened` before any further decision).
 * S = the child's opening time, t = the decision's time. PS from the
 * predecessor Note's final label (else the child's, else all).
 * Q2a, BOUNDARY-shaped, "should this cut have been made?": target y = that
 * script's own (a label begins within 70ms of t and no Note opened before
 * the decision within 70ms of that label). Feature O(S): FAST at T = t, DEEP
 * at T = S + 200. HIGH onset = a real cut. BAR: AUC > 0.698 (DECISION-028's
 * best boundary witness, on its boundary-shaped target) in FAST or DEEP. The
 * engine's own witnesses on the same rows (sharpness, fluxRatio, dipRatio)
 * are printed beside it.
 * Q2b, OUTCOME-shaped, on the rows DECISION-030's rate gate lets through:
 * the Q2 rows whose child is in the final projection (announced, not
 * absorbed). Target: the matcher left the child unpaired (surplus, y=1) —
 * the target the gate itself acts on (DECISION-032). Feature O(S): FAST at T
 * = the child's announce time, DEEP at T = S + 200. LOW onset = surplus.
 * BAR: conditional AUC >= 0.70 in FAST or DEEP (the scale of the boundary
 * bar, asked of the rows the gate could not decide).
 * Q2 clears only if Q2a AND Q2b clear. The two AUCs are on different targets
 * and are never compared with each other.
 *
 * ---------------------------------------------------------------------------
 * Q3  LOST FAST NOTES
 * ---------------------------------------------------------------------------
 * Rows: every label the matcher missed on a derivation take, with the branch
 * `scripts/measure-downstream-ledger.ts`'s `classify` gives it. "The model sees
 * a distinct note" at label start L: in the DEEP reading at T = L + 200, some
 * frame centred within 40ms of L and nearer L than any other label's start
 * holds, at a bin of the label's PS, an onset activation that is a local
 * maximum in time and >= theta.
 * False alarms, on MATCHED labels: the same rule over the label's interior,
 * [L+40, min(end, next label start) - 40] (at most 1500ms, read at T = its end
 * + 200): a second distinct onset inside one played note. theta = 0.5, the
 * package's onset threshold, unless that fires on more than 10% of matched
 * labels' interiors; then the smallest theta in 0.55, 0.60, ... 0.95 at or
 * under 10%. theta is fixed on derivation and carried to held-out unchanged.
 * BAR: in some ledger branch with at least 4 derivation misses, the model sees
 * at least half of them, at a false-alarm rate <= 10%.
 *
 * ---------------------------------------------------------------------------
 * Q4  PITCH (secondary, descriptive, no bar)
 * ---------------------------------------------------------------------------
 * Matched required labels on derivation: the model's note (single notes: the
 * MIDI note with the highest mean note activation over the label's span; a
 * chord: the lowest MIDI note whose mean activation is >= 0.3, as its bass)
 * against the label, exact and pitch class, beside the engine's own matched
 * Note, by signal path, single note vs chord, and register (E2-D#3, E3-D#4,
 * E4 and up). DEEP reading at T = min(end, start+1500) + 200.
 *
 * ---------------------------------------------------------------------------
 * EVERY QUESTION: the 2x2 agreement table (only model right / only engine
 * right / both / neither) by signal path, at the fixed operating points above;
 * AUCs with a take-cluster bootstrap 95% interval (1000 resamples, seeded).
 * A clean negative is a result.
 * ---------------------------------------------------------------------------
 *
 * ADDED AFTER THE DERIVATION READ, BEFORE THE HELD-OUT ONE (not a bar): the
 * gate sweep under Q1 and Q2b — how many surplus and paired rows a gate
 * withholding onsets below theta would take, derivation only. It is where
 * `phase3-gate.ts`'s two operating points come from.
 *
 * Usage:
 *   npx tsx training/basic-pitch/phase2-rows.ts --dir training/out/basic-pitch
 *   npx tsx training/basic-pitch/phase2.ts --dir training/out/basic-pitch
 *   npx tsx training/basic-pitch/phase2-rows.ts --dir training/out/basic-pitch --heldout   # ONCE
 *   npx tsx training/basic-pitch/phase2.ts --dir training/out/basic-pitch --heldout
 */

export const BARS = {
  q1Auc: 0.8,
  q2aAuc: 0.698,
  q2bAuc: 0.7,
  q3SeenShare: 0.5,
  q3MinBranch: 4,
  q3MaxFalseAlarm: 0.1,
  onsetThreshold: 0.5,
  noteThreshold: 0.3,
  windowMs: 40,
  deepDelayMs: 200,
  maxSpanMs: 1500,
} as const;

/* ========================================================================== */
/* The report. Everything below reads the rows; nothing here chooses a bar.    */
/* ========================================================================== */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TakeRows } from "./phase2-rows.js";

const PATHS = ["DI", "amped", "clean", "mic"] as const;

/** Rows from JSON: NaN was written as null. */
function loadRows(dir: string, sub: string): TakeRows[] {
  const folder = join(dir, sub);
  const files = readdirSync(folder).filter((f) => f.endsWith(".json")).sort();
  const revive = (_k: string, v: unknown): unknown => (v === null ? NaN : v);
  return files.map((f) => {
    const t = JSON.parse(readFileSync(join(folder, f), "utf8"), revive) as TakeRows;
    // Fields that are legitimately null (not NaN) come back as NaN; restore them.
    for (const r of t.q1) if (Number.isNaN(r.announceMs as number)) r.announceMs = null;
    for (const r of t.q1) if (Number.isNaN(r.midi as number)) r.midi = null;
    for (const r of t.q2) {
      if (Number.isNaN(r.childAnnounceMs as number)) r.childAnnounceMs = null;
      if (Number.isNaN(r.localIoiMs as number)) r.localIoiMs = null;
      if (Number.isNaN(r.childSoundedMs as number)) r.childSoundedMs = null;
      if (typeof r.parentLabel !== "string") r.parentLabel = null;
    }
    for (const r of t.q3) {
      if (typeof r.branch !== "string") r.branch = null;
      if (Number.isNaN(r.interiorMs as number)) r.interiorMs = null;
    }
    for (const r of t.q4) {
      for (const k of ["labelMidi", "rootPc", "modelDominant", "modelBass"] as const) {
        if (Number.isNaN(r[k] as number)) r[k] = null;
      }
    }
    return t;
  });
}

/* ---- statistics ------------------------------------------------------------ */

/** P(score of a positive > score of a negative), ties half. NaN scores dropped. */
function aucHigh(scores: readonly number[], y: readonly number[]): { auc: number; n: number; pos: number } {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i] as number;
    if (Number.isFinite(s)) pairs.push([s, y[i] as number]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  let sumRank = 0;
  for (let i = 0; i < pairs.length; ) {
    let j = i;
    while (j + 1 < pairs.length && (pairs[j + 1] as [number, number])[0] === (pairs[i] as [number, number])[0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      if ((pairs[k] as [number, number])[1] === 1) {
        pos++;
        sumRank += rank;
      }
    }
    i = j + 1;
  }
  const neg = pairs.length - pos;
  if (pos === 0 || neg === 0) return { auc: NaN, n: pairs.length, pos };
  return { auc: (sumRank - (pos * (pos + 1)) / 2) / (pos * neg), n: pairs.length, pos };
}

type Scored = { take: string; score: number; y: number };

/** AUC with a take-cluster bootstrap 95% interval. `low` = a LOW score predicts y=1. */
function aucCi(rows: readonly Scored[], low: boolean): { auc: number; lo: number; hi: number; n: number; pos: number } {
  const sign = low ? -1 : 1;
  const base = aucHigh(rows.map((r) => sign * r.score), rows.map((r) => r.y));
  const takes = [...new Set(rows.map((r) => r.take))];
  const byTake = new Map(takes.map((t) => [t, rows.filter((r) => r.take === t)]));
  let seed = 20260925;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const stats: number[] = [];
  for (let b = 0; b < 1000; b++) {
    const s: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < takes.length; i++) {
      const t = takes[Math.floor(rand() * takes.length)] as string;
      for (const r of byTake.get(t) ?? []) {
        s.push(sign * r.score);
        y.push(r.y);
      }
    }
    const a = aucHigh(s, y).auc;
    if (Number.isFinite(a)) stats.push(a);
  }
  stats.sort((a, b) => a - b);
  const q = (p: number): number => stats[Math.min(stats.length - 1, Math.max(0, Math.round(p * (stats.length - 1))))] ?? NaN;
  return { auc: base.auc, lo: q(0.025), hi: q(0.975), n: base.n, pos: base.pos };
}

const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "  -  ");
const pct = (a: number, b: number): string => (b === 0 ? "   -" : `${((100 * a) / b).toFixed(0).padStart(3)}%`);

function table(head: readonly string[], body: readonly (readonly string[])[]): void {
  const all = [head, ...body];
  const width: number[] = [];
  for (const row of all) row.forEach((c, i) => (width[i] = Math.max(width[i] ?? 0, c.length)));
  const line = (row: readonly string[]): string =>
    "  " + row.map((c, i) => (i === 0 ? c.padEnd(width[i] as number) : c.padStart(width[i] as number))).join("  ");
  console.log(line(head));
  console.log("  " + width.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}

/** The 2x2 agreement table by signal path. `modelRight`/`engineRight` per row. */
function agreement<T>(rows: readonly (T & { path: string })[], modelRight: (r: T) => boolean, engineRight: (r: T) => boolean): void {
  const body: string[][] = [];
  for (const p of [...PATHS, "all"]) {
    const rs = rows.filter((r) => p === "all" || r.path === p);
    if (rs.length === 0) continue;
    let onlyModel = 0;
    let onlyEngine = 0;
    let both = 0;
    let neither = 0;
    for (const r of rs) {
      const m = modelRight(r);
      const e = engineRight(r);
      if (m && e) both++;
      else if (m) onlyModel++;
      else if (e) onlyEngine++;
      else neither++;
    }
    body.push([p, String(rs.length), String(onlyModel), String(onlyEngine), String(both), String(neither)]);
  }
  table(["path", "rows", "only model right", "only engine right", "both", "neither"], body);
}

/**
 * What a gate withholding every row whose score is below theta would take:
 * surplus rows (the point) and paired rows (the cost), by signal path. Row
 * level only; the matcher can re-pair around a withheld Note end to end.
 */
function gateSweep(rows: ReadonlyArray<{ score: number; surplus: boolean; path: string }>, what: string): void {
  console.log(`\n  gate sweep (${what}): rows withheld below theta — surplus / paired`);
  const body: string[][] = [];
  for (const theta of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]) {
    const below = rows.filter((r) => Number.isFinite(r.score) && r.score < theta);
    const cell = (p: string | null): string => {
      const rs = below.filter((r) => p === null || r.path === p);
      return `${rs.filter((r) => r.surplus).length} / ${rs.filter((r) => !r.surplus).length}`;
    };
    body.push([theta.toFixed(2), cell(null), ...PATHS.filter((p) => rows.some((r) => r.path === p)).map(cell)]);
  }
  table(["theta", "all", ...PATHS.filter((p) => rows.some((r) => r.path === p))], body);
}

/* ---- the questions ----------------------------------------------------------- */

type Flat<R> = R & { take: string; path: string };
const flat = <K extends "q1" | "q2" | "q3" | "q4">(takes: readonly TakeRows[], k: K): Array<Flat<TakeRows[K][number]>> =>
  takes.flatMap((t) => (t[k] as Array<TakeRows[K][number]>).map((r) => ({ ...r, take: t.stem, path: t.path })));

type Verdicts = { q1: boolean; q2a: boolean; q2b: boolean; q3: boolean; theta: number };

function report(takes: readonly TakeRows[], title: string, fixedTheta: number | null): Verdicts {
  console.log(`\n${"=".repeat(100)}\n${title}\n${"=".repeat(100)}`);
  const paths = new Map<string, number>();
  for (const t of takes) paths.set(t.path, (paths.get(t.path) ?? 0) + 1);
  console.log(
    `  ${takes.length} takes (${[...paths].map(([p, n]) => `${n} ${p}`).join(", ")}), ` +
      `${takes.reduce((n, t) => n + t.labels, 0)} labels, ${takes.reduce((n, t) => n + t.detections, 0)} Notes, ` +
      `${takes.reduce((n, t) => n + t.windows, 0)} model windows read causally`,
  );

  /* Q1 */
  const q1 = flat(takes, "q1");
  console.log(`\n  Q1 GHOSTS (outcome-shaped: is this emitted Note surplus?)`);
  console.log(`  rows: ${q1.length} Notes, ${q1.filter((r) => r.y === 1).length} extra, ${q1.filter((r) => r.y === 0).length} matched`);
  const q1Body: string[][] = [];
  let q1Pass = false;
  for (const [name, key] of [
    ["O onset at the Note's start", "O"],
    ["N sounding at its pitch", "N"],
    ["P pitch class agrees", "P"],
  ] as const) {
    const cells: string[] = [name];
    for (const reading of ["fast", "deep", "whole"] as const) {
      const field = `${key}_${reading}` as keyof (typeof q1)[number];
      const c = aucCi(
        q1.map((r) => ({ take: r.take, score: r[field] as number, y: r.y })),
        true,
      );
      cells.push(`${f3(c.auc)} [${f3(c.lo)}, ${f3(c.hi)}] n=${c.n}`);
      if (reading === "deep" && c.auc >= BARS.q1Auc) q1Pass = true;
    }
    q1Body.push(cells);
  }
  table(["feature (low = surplus)", "FAST (at announce)", "DEEP (+200ms)", "WHOLE (not buildable)"], q1Body);
  console.log(`\n  per signal path, DEEP`);
  table(
    ["path", "rows", "extra", "O", "N", "P"],
    PATHS.filter((p) => q1.some((r) => r.path === p)).map((p) => {
      const rs = q1.filter((r) => r.path === p);
      const a = (k: "O_deep" | "N_deep" | "P_deep"): string => f3(aucHigh(rs.map((r) => -(r[k] as number)), rs.map((r) => r.y)).auc);
      return [p, String(rs.length), String(rs.filter((r) => r.y === 1).length), a("O_deep"), a("N_deep"), a("P_deep")];
    }),
  );
  console.log(`\n  2x2, O DEEP at the package's onset threshold ${BARS.onsetThreshold} (model: surplus when below)`);
  agreement(q1, (r) => (r.O_deep < BARS.onsetThreshold) === (r.y === 1), (r) => r.y === 0);
  console.log(`\n  2x2, N DEEP at the package's note threshold ${BARS.noteThreshold}`);
  agreement(q1, (r) => (r.N_deep < BARS.noteThreshold) === (r.y === 1), (r) => r.y === 0);
  console.log(`\n  Q1 bar: AUC >= ${BARS.q1Auc} for O, N or P in DEEP: ${q1Pass ? "CLEARS" : "does not clear"}`);
  gateSweep(q1.map((r) => ({ score: r.O_deep, surplus: r.y === 1, path: r.path })), "every Note, O DEEP");

  /* Q2a */
  const q2 = flat(takes, "q2");
  console.log(`\n  Q2a SAME-PITCH CUTS as a boundary witness (boundary-shaped: should this cut have been made?)`);
  console.log(
    `  rows: ${q2.length} accepted, settled, same-pitch cuts that opened a child; ` +
      `${q2.filter((r) => r.yBoundary === 1).length} with a label to cut for, ${q2.filter((r) => r.yBoundary === 0).length} without`,
  );
  const s2 = (score: (r: (typeof q2)[number]) => number, low: boolean): ReturnType<typeof aucCi> =>
    aucCi(q2.map((r) => ({ take: r.take, score: score(r), y: r.yBoundary })), low);
  const q2aRows: Array<[string, ReturnType<typeof aucCi>]> = [
    ["model O, FAST (at the decision)", s2((r) => r.O_fast, false)],
    ["model O, DEEP (+200ms)", s2((r) => r.O_deep, false)],
    ["model O, WHOLE (not buildable)", s2((r) => r.O_whole, false)],
    ["engine sharpness (high = cut)", s2((r) => r.sharpness, false)],
    ["engine fluxRatio (high = cut)", s2((r) => r.fluxRatio, false)],
    ["engine dipRatio (low = cut)", s2((r) => r.dipRatio, true)],
  ];
  table(
    ["witness, same rows", "AUC", "95% (take bootstrap)", "n", "positives"],
    q2aRows.map(([n, c]) => [n, f3(c.auc), `[${f3(c.lo)}, ${f3(c.hi)}]`, String(c.n), String(c.pos)]),
  );
  const q2aPass = (q2aRows[0]?.[1].auc ?? 0) > BARS.q2aAuc || (q2aRows[1]?.[1].auc ?? 0) > BARS.q2aAuc;
  console.log(`\n  per signal path`);
  table(
    ["path", "rows", "positives", "O FAST", "O DEEP", "sharpness", "dipRatio"],
    PATHS.filter((p) => q2.some((r) => r.path === p)).map((p) => {
      const rs = q2.filter((r) => r.path === p);
      const y = rs.map((r) => r.yBoundary);
      return [
        p,
        String(rs.length),
        String(rs.filter((r) => r.yBoundary === 1).length),
        f3(aucHigh(rs.map((r) => r.O_fast), y).auc),
        f3(aucHigh(rs.map((r) => r.O_deep), y).auc),
        f3(aucHigh(rs.map((r) => r.sharpness), y).auc),
        f3(aucHigh(rs.map((r) => -r.dipRatio), y).auc),
      ];
    }),
  );
  console.log(`\n  2x2, O DEEP >= ${BARS.onsetThreshold} = "a new articulation"; the engine cut every row`);
  agreement(q2, (r) => (r.O_deep >= BARS.onsetThreshold) === (r.yBoundary === 1), (r) => r.yBoundary === 1);
  console.log(`\n  Q2a bar: AUC > ${BARS.q2aAuc} in FAST or DEEP: ${q2aPass ? "CLEARS" : "does not clear"}`);

  /* Q2b */
  const q2b = q2.filter((r) => r.childEmitted);
  console.log(`\n  Q2b ON THE ROWS DECISION-030'S RATE GATE LETS THROUGH (outcome-shaped: is the child surplus?)`);
  console.log(
    `  rows: ${q2b.length} cuts whose child was announced and kept; ${q2b.filter((r) => !r.childPaired).length} children ` +
      `the matcher left unpaired (surplus), ${q2b.filter((r) => r.childPaired).length} paired. ` +
      `(${q2.length - q2b.length} children the gate or the announce bar already dropped.)`,
  );
  const s2b = (score: (r: (typeof q2)[number]) => number, low: boolean): ReturnType<typeof aucCi> =>
    aucCi(q2b.map((r) => ({ take: r.take, score: score(r), y: r.childPaired ? 0 : 1 })), low);
  const rate = (r: (typeof q2)[number]): number =>
    r.localIoiMs !== null && r.childSoundedMs !== null ? r.childSoundedMs / r.localIoiMs : NaN;
  const q2bRows: Array<[string, ReturnType<typeof aucCi>]> = [
    ["model O, FAST (at the child's announce)", s2b((r) => r.O_fastB, true)],
    ["model O, DEEP (+200ms)", s2b((r) => r.O_deep, true)],
    ["model O, WHOLE (not buildable)", s2b((r) => r.O_whole, true)],
    ["engine: child span / local IOI (low = surplus)", s2b(rate, true)],
    ["engine: dipRatio (high = surplus)", s2b((r) => r.dipRatio, false)],
  ];
  table(
    ["witness, same rows", "AUC", "95% (take bootstrap)", "n", "surplus"],
    q2bRows.map(([n, c]) => [n, f3(c.auc), `[${f3(c.lo)}, ${f3(c.hi)}]`, String(c.n), String(c.pos)]),
  );
  const q2bPass = (q2bRows[0]?.[1].auc ?? 0) >= BARS.q2bAuc || (q2bRows[1]?.[1].auc ?? 0) >= BARS.q2bAuc;
  console.log(`\n  per signal path`);
  table(
    ["path", "rows", "surplus", "O FAST", "O DEEP", "span / IOI"],
    PATHS.filter((p) => q2b.some((r) => r.path === p)).map((p) => {
      const rs = q2b.filter((r) => r.path === p);
      const y = rs.map((r) => (r.childPaired ? 0 : 1));
      return [
        p,
        String(rs.length),
        String(rs.filter((r) => !r.childPaired).length),
        f3(aucHigh(rs.map((r) => -r.O_fastB), y).auc),
        f3(aucHigh(rs.map((r) => -r.O_deep), y).auc),
        f3(aucHigh(rs.map((r) => -rate(r)), y).auc),
      ];
    }),
  );
  console.log(`\n  2x2, O DEEP < ${BARS.onsetThreshold} = "surplus"; the engine kept every row`);
  agreement(q2b, (r) => (r.O_deep < BARS.onsetThreshold) === !r.childPaired, (r) => r.childPaired);
  console.log(`\n  Q2b bar: conditional AUC >= ${BARS.q2bAuc} in FAST or DEEP: ${q2bPass ? "CLEARS" : "does not clear"}`);
  gateSweep(q2b.map((r) => ({ score: r.O_deep, surplus: !r.childPaired, path: r.path })), "same-pitch children the rate gate kept, O DEEP");
  console.log(`  Q2 clears only if Q2a and Q2b both do: ${q2aPass && q2bPass ? "CLEARS" : "does not clear"}`);

  /* Q3 */
  const q3 = flat(takes, "q3");
  const matched = q3.filter((r) => r.matched);
  const interiors = matched.filter((r) => r.interiorMs !== null && Number.isFinite(r.interior_deep));
  const fa = (theta: number): number => interiors.filter((r) => r.interior_deep >= theta).length / Math.max(1, interiors.length);
  let theta = fixedTheta ?? BARS.onsetThreshold;
  if (fixedTheta === null && fa(theta) > BARS.q3MaxFalseAlarm) {
    theta = NaN;
    for (let t = 0.55; t <= 0.951; t += 0.05) {
      if (fa(t) <= BARS.q3MaxFalseAlarm) {
        theta = Math.round(t * 100) / 100;
        break;
      }
    }
  }
  const missedRows = q3.filter((r) => !r.matched);
  console.log(`\n  Q3 LOST NOTES: does the model see a distinct note where the tracker lost the label?`);
  console.log(
    `  rows: ${missedRows.length} missed labels; false alarms read on ${interiors.length} matched labels' interiors. ` +
      `theta ${theta}${fixedTheta === null ? " (set on this set)" : " (carried from derivation)"}: ` +
      `false alarms ${(100 * fa(theta)).toFixed(1)}% (at 0.5: ${(100 * fa(0.5)).toFixed(1)}%); ` +
      `matched labels seen ${pct(matched.filter((r) => r.seen_deep >= theta).length, matched.length)}`,
  );
  const branches = [...new Set(missedRows.map((r) => r.branch ?? "?"))];
  const branchBody = branches
    .map((b) => {
      const rs = missedRows.filter((r) => r.branch === b);
      const seen = rs.filter((r) => r.seen_deep >= theta).length;
      const seenW = rs.filter((r) => r.seen_whole >= theta).length;
      return { b, n: rs.length, seen, seenW };
    })
    .sort((a, b) => b.n - a.n);
  table(
    ["ledger branch", "misses", "seen DEEP", "share", "seen WHOLE", "share"],
    branchBody.map((x) => [x.b, String(x.n), String(x.seen), pct(x.seen, x.n), String(x.seenW), pct(x.seenW, x.n)]),
  );
  const q3Pass =
    Number.isFinite(theta) &&
    fa(theta) <= BARS.q3MaxFalseAlarm &&
    branchBody.some((x) => x.n >= BARS.q3MinBranch && x.seen / x.n >= BARS.q3SeenShare);
  console.log(`\n  per signal path`);
  table(
    ["path", "missed", "seen DEEP", "matched", "seen DEEP", "interior false alarms"],
    PATHS.filter((p) => q3.some((r) => r.path === p)).map((p) => {
      const m = missedRows.filter((r) => r.path === p);
      const k = matched.filter((r) => r.path === p);
      const i = interiors.filter((r) => r.path === p);
      return [
        p,
        String(m.length),
        `${m.filter((r) => r.seen_deep >= theta).length} ${pct(m.filter((r) => r.seen_deep >= theta).length, m.length)}`,
        String(k.length),
        `${k.filter((r) => r.seen_deep >= theta).length} ${pct(k.filter((r) => r.seen_deep >= theta).length, k.length)}`,
        `${i.filter((r) => r.interior_deep >= theta).length}/${i.length} ${pct(i.filter((r) => r.interior_deep >= theta).length, i.length)}`,
      ];
    }),
  );
  console.log(`\n  2x2 over every label, at theta: model right = sees the note; engine right = matched it`);
  agreement(q3, (r) => r.seen_deep >= theta, (r) => r.matched);
  console.log(
    `\n  Q3 bar: a branch with >= ${BARS.q3MinBranch} misses, half of them seen, at <= ${100 * BARS.q3MaxFalseAlarm}% false alarms: ` +
      `${q3Pass ? "CLEARS" : "does not clear"}`,
  );

  /* Q4 */
  const q4 = flat(takes, "q4");
  console.log(`\n  Q4 PITCH (secondary, descriptive): matched labels, DEEP reading over the label's span`);
  const reg = (m: number | null): string => (m === null ? "?" : m < 52 ? "E2-D#3" : m < 64 ? "E3-D#4" : "E4+");
  const q4Body: string[][] = [];
  const groups: Array<[string, (r: (typeof q4)[number]) => boolean]> = [
    ["single notes, all", (r) => r.kind === "note"],
    ...PATHS.map((p): [string, (r: (typeof q4)[number]) => boolean] => [`  ${p}`, (r) => r.kind === "note" && r.path === p]),
    ...["E2-D#3", "E3-D#4", "E4+"].map((g): [string, (r: (typeof q4)[number]) => boolean] => [
      `  register ${g}`,
      (r) => r.kind === "note" && reg(r.labelMidi) === g,
    ]),
  ];
  for (const [name, keep] of groups) {
    const rs = q4.filter(keep);
    if (rs.length === 0) continue;
    const mExact = rs.filter((r) => r.modelDominant !== null && r.modelDominant === r.labelMidi).length;
    const mPc = rs.filter((r) => r.modelDominant !== null && r.labelMidi !== null && r.modelDominant % 12 === r.labelMidi % 12).length;
    q4Body.push([
      name,
      String(rs.length),
      pct(mExact, rs.length),
      pct(mPc, rs.length),
      pct(rs.filter((r) => r.engineExact).length, rs.length),
      pct(rs.filter((r) => r.enginePc).length, rs.length),
    ]);
  }
  const chords = q4.filter((r) => r.kind === "chord");
  if (chords.length > 0) {
    q4Body.push([
      "chords (model: bass = root)",
      String(chords.length),
      "   -",
      pct(chords.filter((r) => r.modelBass !== null && r.rootPc !== null && r.modelBass % 12 === r.rootPc).length, chords.length),
      pct(chords.filter((r) => r.engineExact).length, chords.length),
      pct(chords.filter((r) => r.enginePc).length, chords.length),
    ]);
  }
  table(["labels", "n", "model exact", "model pitch class", "engine exact", "engine pitch class"], q4Body);

  console.log(
    `\n  VERDICTS: Q1 ${q1Pass ? "clears" : "no"}; Q2a ${q2aPass ? "clears" : "no"}; Q2b ${q2bPass ? "clears" : "no"}; ` +
      `Q3 ${q3Pass ? "clears" : "no"} (theta ${theta})`,
  );
  return { q1: q1Pass, q2a: q2aPass, q2b: q2bPass, q3: q3Pass, theta };
}

function main(): void {
  const i = process.argv.indexOf("--dir");
  const dir = i >= 0 ? process.argv[i + 1] : undefined;
  if (!dir) {
    console.error("usage: npx tsx training/basic-pitch/phase2.ts --dir <dir> [--heldout]");
    process.exit(2);
  }
  const derivation = loadRows(dir, "rows");
  if (derivation.length !== 15 || derivation.some((t) => t.heldout)) throw new Error("expected the 15 derivation takes' rows");
  const d = report(derivation, "DERIVATION: the 15 tuning takes", null);
  if (process.argv.includes("--heldout")) {
    const held = loadRows(dir, "rows-heldout");
    if (held.length !== 12 || held.some((t) => !t.heldout)) throw new Error("expected the 12 held-out takes' rows");
    report(held, "HELD-OUT: the twelve 140bpm takes, read once, every operating point carried from derivation", d.theta);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
