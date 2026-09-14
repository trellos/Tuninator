/**
 * Propose onset corrections for the GENERATED-GRID label sections.
 *
 * `docs/SAME-PITCH-MATERIAL.md` records that two of the four 120bpm same-pitch
 * takes could not have their picks resolved one-to-one: `eighths-a3` and
 * `eighths-sixteenths-e5` sit on a fixed subdivision grid anchored on the first
 * measured onset, with a single median-offset correction fitted across the
 * take. The subdivision is musical; only the anchor is measured. A player's
 * timing wanders, so a grid drifts away from the playing — and where a pick was
 * ghosted or skipped, the grid still puts a label there.
 *
 * The owner confirmed both failure modes by ear over fifteen points: four grid
 * labels with no pick under them at all, and timing errors up to 87ms on picks
 * that are real.
 *
 * WHAT THIS DOES NOT DO. It does not edit `fixtures/labels/**` — those are
 * read-only ground truth (`AGENTS.md` §3) — and it does not use Tuninator to
 * decide anything, which would be the circularity that file calls out by name.
 * It writes a PROPOSAL for a human to accept or reject, one row per grid label.
 *
 * THE ONSET DETECTOR is a plain RMS envelope, peak-picked by PROMINENCE — how
 * far a peak climbed out of its own preceding trough. It shares no code and no
 * constant with `src/engine/**`. Its thresholds are checked against the OWNER'S
 * EAR, the nineteen points he judged, and the script reports that agreement
 * every run so a change that breaks it says so rather than silently proposing
 * nonsense.
 *
 * **STATUS: NOT GOOD ENOUGH TO APPLY. Read this before running it.**
 *
 * This rediscovers, from the other side, the limitation that produced the grid
 * in the first place. `docs/SAME-PITCH-MATERIAL.md` says the two fast takes were
 * gridded because "the runs are too fast for the envelope rule to resolve every
 * pick" — and an envelope rule is what this is. It finds 11 of the 14 picks the
 * owner confirmed, and flags 145 of 752 labels as having no pick under them,
 * which cannot be right on material the player says has nothing missing.
 *
 * Three matching strategies were tried against his ear and none rescues it,
 * because the problem is upstream of matching. Nearest-onset at a 110ms window
 * let a spurious label be adopted by its neighbour's pick (4 of 5
 * confirmed-silent labels came back as `move`); narrowing to 55ms made real
 * drifted picks read as missing (256 of 752); monotonic sequence alignment,
 * which needs no window at all, lands between them at 145. The grid drifts up
 * to 87ms while a sixteenth is 125ms, so drift is comparable to spacing and no
 * matching rule can separate the two cases when the onsets themselves are
 * incomplete.
 *
 * SO: the two gridded takes cannot be re-timed by this method, and detection
 * work that needs accurate onsets should use `same-pitch-quarters-a3-e5` and
 * `held-then-picked-six-strings`, whose 72 and 120 events were measured
 * one-to-one and are trustworthy. Fixing the gridded takes wants a human ear or
 * a genuinely better onset method, and this file is kept as the record of what
 * an envelope method does, not as a tool to run against the labels.
 *
 * READ THE CALIBRATION BEFORE ACTING ON THE OUTPUT. As it stands it finds 5 of
 * 5 grid labels he confirmed have no pick under them — that half is reliable,
 * and the removal candidates are worth a listen. It finds only 11 of 14 picks,
 * missing three in the fastest sixteenth run where it locks onto the preceding
 * pick about 100ms early. Those fourteen are a deliberately hard subset, being
 * the moments the recognizer disputed, so this is not the rate over all 752
 * labels — but it is not good enough to apply six hundred timing moves
 * wholesale either. Treat the `move` rows as a worklist, not an answer.
 *
 * DI IS THE SOURCE. The amped render is the same performance through an amp
 * sim, so the true onsets are identical and the DI is where they are easiest to
 * see. One correction set therefore serves both renders of a take, which is
 * also a consistency check: a pick present in one must be present in the other.
 *
 * Usage:
 *   npx tsx scripts/propose-label-corrections.ts
 *   npx tsx scripts/propose-label-corrections.ts --write   # writes the proposal
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { CACHE_DIR, decodeFixtures } from "./decode-fixtures.js";

/** Envelope resolution. Fine enough that a 125ms sixteenth is 50 hops. */
const WIN_MS = 20;
const HOP_MS = 2.5;

/**
*/


/**
 * Peak prominence that counts as a pick, and the least separation between two.
 *
 * Calibrated against the owner's ear on the twenty points he judged, NOT
 * against the recognizer. `MIN_INTERVAL_MS` sits below a 120bpm sixteenth
 * (125ms) so a genuine fast run is resolvable, and above the width of a single
 * pick's attack so one pick is not counted twice.
 */
const MIN_PROMINENCE = 1.12;
const MIN_INTERVAL_MS = 70;
/** How far back the trough a peak climbed out of is looked for. */
const TROUGH_LOOKBACK_MS = 90;

/**
 * How far from a grid label a measured onset may sit and still be ITS pick.
 *
 * Must stay well under HALF the spacing of the events it is matching, or a
 * label with no pick under it is simply adopted by its neighbour's. At 110ms
 * against 125ms sixteenths it was: four of the five labels the owner confirmed
 * silent came back as `move` rather than as removal candidates, because a pick
 * one subdivision away was inside the window. A sixteenth at 120bpm is 125ms,
 * so half is 62.5, and this sits below that.
 */
const MATCH_WINDOW_MS = 55;

/** The takes whose labels came off a grid rather than off measured onsets. */
const GRID_TAKES = ["same-pitch-eighths-a3-120bpm", "same-pitch-eighths-sixteenths-e5-120bpm"];

/**
 * The owner's listening pass, verbatim, as the calibration set.
 *
 * `pick` are moments he confirmed a pick; `silent` are grid labels he confirmed
 * have no pick under them. Times in ms, taken from his own timeline.
 */
const EAR: Record<string, { pick: number[]; silent: number[] }> = {
  "same-pitch-eighths-sixteenths-e5-120bpm-amped": {
    pick: [19700, 22078, 25572, 28325, 30075, 31344],
    silent: [21325, 34050],
  },
  "same-pitch-eighths-sixteenths-e5-120bpm-di": {
    pick: [19613, 25572, 28339, 30075, 31344],
    silent: [21325],
  },
  "same-pitch-eighths-a3-120bpm-di": { pick: [23275], silent: [31355] },
  "same-pitch-eighths-a3-120bpm-amped": { pick: [27800, 31050], silent: [11425] },
};

function envelope(x: Float32Array, sampleRate: number): number[] {
  const win = Math.max(1, Math.round((WIN_MS / 1000) * sampleRate));
  const hop = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate));
  const out: number[] = [];
  for (let i = 0; i + win <= x.length; i += hop) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += (x[j] as number) * (x[j] as number);
    out.push(Math.sqrt(sum / win));
  }
  return out;
}

/**
 * Onsets in ms: envelope peaks with real PROMINENCE behind them.
 *
 * A rise ratio was tried first and is not good enough — on the amp-sim render
 * compression holds the level up between picks, so the rise test finds almost
 * nothing (158 of 184 labels left unmatched). Prominence asks a different
 * question: how far did the signal have to climb out of its own trough to reach
 * this peak. That survives compression, and on this material it reproduces the
 * owner's ear.
 *
 * Run on the DI render only. The amped render is the same performance through
 * an amp sim, so its onsets are the DI's; detecting on the clean signal and
 * carrying the answer across is both more accurate and a consistency check.
 */
function detectOnsets(env: readonly number[]): number[] {
  const guard = Math.max(1, Math.round(MIN_INTERVAL_MS / 2 / HOP_MS));
  const back = Math.max(1, Math.round(TROUGH_LOOKBACK_MS / HOP_MS));
  const peaks: Array<{ at: number; prom: number }> = [];
  for (let i = 1; i < env.length - 1; i++) {
    const v = env[i] as number;
    let isPeak = true;
    for (let j = Math.max(0, i - guard); j <= Math.min(env.length - 1, i + guard); j++) {
      if ((env[j] as number) > v) { isPeak = false; break; }
    }
    if (!isPeak) continue;
    let trough = v;
    for (let j = Math.max(0, i - back); j < i; j++) trough = Math.min(trough, env[j] as number);
    const prom = trough > 1e-9 ? v / trough : Infinity;
    if (prom < MIN_PROMINENCE) continue;
    peaks.push({ at: i * HOP_MS, prom });
  }
  // Strongest first, then rate-limit, so a weak neighbour never displaces a pick.
  peaks.sort((a, b) => b.prom - a.prom);
  const kept: number[] = [];
  for (const p of peaks) {
    if (kept.some((k) => Math.abs(k - p.at) < MIN_INTERVAL_MS)) continue;
    kept.push(p.at);
  }
  return kept.sort((a, b) => a - b);
}

/**
 * Align labels to onsets MONOTONICALLY, in order, one to one.
 *
 * Nearest-onset matching cannot work on this material and the reason is
 * structural rather than a matter of picking a better window. The grid drifts
 * from the playing by up to 87ms — the owner's own measurement — while a
 * sixteenth at 120bpm is 125ms apart. Drift is comparable to spacing, so at any
 * window a label that drifted is indistinguishable from a label whose neighbour
 * has been adopted: wide, and a spurious label silently attaches to the next
 * pick along (four of five confirmed-silent labels came back as `move`);
 * narrow, and real picks that drifted read as missing (256 of 752).
 *
 * What resolves it is the constraint the owner stated: the picks and the labels
 * are both in time order, and the playing has no notes missing, so the two
 * sequences should correspond in order. This is a standard monotonic alignment:
 * match in order, or pay to skip a label (a label with no pick under it) or to
 * skip an onset (a pick with no label). No window decides anything; the costs
 * do, and they are compared against each other rather than against a bar.
 */
const SKIP_LABEL_COST = 90;
const SKIP_ONSET_COST = 90;

function alignMonotonic(labels: readonly number[], onsets: readonly number[]): Array<number | null> {
  const n = labels.length, m = onsets.length;
  const INF = Number.POSITIVE_INFINITY;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(INF));
  const from: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  cost[0]![0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = cost[i]![j] as number;
      if (!Number.isFinite(here)) continue;
      if (i < n && j < m) {
        const c = here + Math.abs((labels[i] as number) - (onsets[j] as number));
        if (c < (cost[i + 1]![j + 1] as number)) { cost[i + 1]![j + 1] = c; from[i + 1]![j + 1] = 1; }
      }
      if (i < n) {
        const c = here + SKIP_LABEL_COST;
        if (c < (cost[i + 1]![j] as number)) { cost[i + 1]![j] = c; from[i + 1]![j] = 2; }
      }
      if (j < m) {
        const c = here + SKIP_ONSET_COST;
        if (c < (cost[i]![j + 1] as number)) { cost[i]![j + 1] = c; from[i]![j + 1] = 3; }
      }
    }
  }
  const out = new Array<number | null>(n).fill(null);
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const f = from[i]![j] as number;
    if (f === 1) { out[i - 1] = onsets[j - 1] as number; i--; j--; }
    else if (f === 2) { i--; }
    else if (f === 3) { j--; }
    else break;
  }
  return out;
}

type Row = {
  stem: string;
  id: string;
  label: string;
  currentMs: number;
  proposedMs: number | null;
  offsetMs: number | null;
  verdict: "move" | "keep" | "no onset — candidate for removal";
};

function main(): void {
  const write = process.argv.includes("--write");
  const rows: Row[] = [];
  let earHit = 0, earTotal = 0, silentOk = 0, silentTotal = 0;
  const missedEar: string[] = [];

  // Detect on the DI render of each take; the amped render is the same
  // performance, so its onsets are these. One detection, two proposals.
  const fixtures = [...decodeFixtures({ quiet: true })];
  const onsetsByTake = new Map<string, number[]>();
  for (const f of fixtures) {
    if (!f.stem.endsWith("-di")) continue;
    const take = f.stem.slice(0, -"-di".length);
    if (!GRID_TAKES.some((t) => take.startsWith(t))) continue;
    const wav = readWav(readFileSync(f.wavPath));
    onsetsByTake.set(take, detectOnsets(envelope(downmixToMono(wav.samples, wav.channels), wav.sampleRate)));
  }

  for (const fixture of fixtures) {
    const take = fixture.stem.replace(/-(di|amped)$/, "");
    const onsets = onsetsByTake.get(take);
    if (onsets === undefined) continue;

    const ear = EAR[fixture.stem];
    if (ear !== undefined) {
      for (const t of ear.pick) {
        earTotal++;
        const near = onsets.filter((o) => Math.abs(o - t) <= 45);
        if (near.length > 0) earHit++;
        else {
          const closest = onsets.reduce((a, o) => (Math.abs(o - t) < Math.abs(a - t) ? o : a), onsets[0] ?? 0);
          missedEar.push(`${fixture.stem.replace("same-pitch-","").replace("-120bpm","")} ${(t/1000).toFixed(3)}s  nearest onset ${(closest/1000).toFixed(3)}s (${(closest-t).toFixed(0)}ms away)`);
        }
      }
      for (const t of ear.silent) {
        silentTotal++;
        if (!onsets.some((o) => Math.abs(o - t) <= MATCH_WINDOW_MS)) silentOk++;
      }
    }

    const evts = fixture.label.events;
    const aligned = alignMonotonic(evts.map((l) => l.startMs), onsets);
    for (let k = 0; k < evts.length; k++) {
      const label = evts[k] as (typeof evts)[number];
      const best = aligned[k] ?? null;
      const offset = best === null ? null : best - label.startMs;
      rows.push({
        stem: fixture.stem,
        id: label.id,
        label: label.label,
        currentMs: label.startMs,
        proposedMs: best,
        offsetMs: offset,
        verdict:
          best === null
            ? "no onset — candidate for removal"
            : Math.abs(offset as number) >= 10
              ? "move"
              : "keep",
      });
    }
  }

  console.log(
    `\n  CALIBRATION against the owner's ear (not against the recognizer)\n` +
      `    picks he heard, found by this detector:   ${earHit}/${earTotal}\n` +
      `    grid labels he called silent, correctly not found: ${silentOk}/${silentTotal}\n` +
      (missedEar.length ? `\n    picks it did NOT find:\n${missedEar.map((m) => `      ${m}`).join("\n")}\n` : "")
  );

  const byStem = new Map<string, Row[]>();
  for (const r of rows) byStem.set(r.stem, [...(byStem.get(r.stem) ?? []), r]);
  console.log("  PROPOSALS\n");
  console.log("  fixture                                          labels  keep  move  no onset  median |offset|");
  for (const [stem, rs] of byStem) {
    const moves = rs.filter((r) => r.verdict === "move");
    const offs = moves.map((r) => Math.abs(r.offsetMs as number)).sort((a, b) => a - b);
    console.log(
      `  ${stem.padEnd(46)} ${String(rs.length).padStart(6)} ${String(rs.filter((r) => r.verdict === "keep").length).padStart(5)} ` +
        `${String(moves.length).padStart(5)} ${String(rs.filter((r) => r.proposedMs === null).length).padStart(9)} ` +
        `${(offs.length ? (offs[Math.floor(offs.length / 2)] as number).toFixed(0) : "—").padStart(16)}ms`
    );
  }

  const removals = rows.filter((r) => r.proposedMs === null);
  if (removals.length > 0) {
    console.log(`\n  LABELS WITH NO ONSET UNDER THEM (${removals.length}) — the ones to listen to first\n`);
    for (const r of removals) {
      console.log(`    ${r.stem.replace("same-pitch-", "").replace("-120bpm", "").padEnd(28)} ${r.id.padEnd(7)} ${r.label.padEnd(4)} at ${(r.currentMs / 1000).toFixed(3)}s`);
    }
  }

  if (write) {
    const dir = join(CACHE_DIR, "label-corrections");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "proposals.json");
    writeFileSync(path, JSON.stringify({ generatedBy: "scripts/propose-label-corrections.ts", rows }, null, 2));
    console.log(`\n  wrote ${rows.length} proposals to ${path}`);
    console.log("  fixtures/labels/** is untouched; these are proposals for a human.\n");
  } else {
    console.log("\n  (run with --write to save the full proposal list)\n");
  }
}

main();
