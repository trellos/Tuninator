/**
 * Re-time the gridded label sections against the DI audio, by COUNT.
 *
 * The two fast same-pitch takes were labelled on a fixed subdivision grid
 * because, as `docs/SAME-PITCH-MATERIAL.md` puts it, "the runs are too fast for
 * the envelope rule to resolve every pick". A grid does not follow a player, so
 * the labels drift: the owner's listening pass found offsets up to 87ms and five
 * grid positions with no pick under them at all.
 *
 * An earlier attempt (`propose-label-corrections.ts`) tried to find the picks by
 * thresholding an onset detector, and failed for a reason worth stating: with a
 * free-floating count, every threshold trades one error for the other. Loose and
 * a label with no pick is adopted by its neighbour's; tight and real picks that
 * drifted read as missing. Nothing in between works, because the grid drift
 * (up to 87ms) is comparable to the spacing being resolved (125ms).
 *
 * **The count is the constraint that removes the threshold.** The player states
 * the structure and that he dropped no notes, so the number of picks in a
 * section is known. Rank every peak in that span by prominence, take the N best,
 * and assign them to the N labels in time order. There is no bar to tune and no
 * window to get wrong; the only inputs are the section's extent and its count.
 *
 * DI ONLY. The amp sim's noise floor runs above a tenth of its own peak, which
 * is what defeated the threshold approach on those renders. The DI is the clean
 * source and the amped render is the same performance, so the DI is where the
 * picks should be found.
 *
 * NOT APPLIED AUTOMATICALLY. `--write` updates `fixtures/labels/**`, which is
 * otherwise read-only: the rule exists so the DETECTOR never defines its own
 * ground truth, and nothing here consults Tuninator — the onsets come from a
 * plain RMS envelope sharing no code with `src/engine/**`. Run without `--write`
 * first and read the agreement against the owner's ear that it prints.
 *
 * **STATUS: applied once (7a216fe) and validated (DECISION-029). Do not re-run
 * with `--write` without reading the findings entry first.** Two limitations
 * were measured there. (1) The lock holds an (id, time) PAIR, but the owner's
 * ear supplies a TIME, not an id: at 19.613s the count-consistent assignment
 * put that pick on `s1614` while the lock pinned it to `s1615`, freezing
 * `s1614` on a grid position 38ms before a real pick. The owner's second
 * listening pass settled it (s1614 = 19.614s, s1615 = 19.744s) and the tables
 * below now carry every time he gave. (2) Where a section's off-beat
 * picks are too weak for the envelope (a third of `a3-di`'s sixteenths), the
 * skipped labels stay on the grid interleaved with re-timed neighbours, and
 * the alignment's skip choice can be an exact cost tie between two adjacent
 * labels. Both need the owner's ear, not a re-run.
 *
 * Usage:
 *   npx tsx scripts/retime-gridded-labels.ts
 *   npx tsx scripts/retime-gridded-labels.ts --write
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures, REPO_ROOT } from "./decode-fixtures.js";

export const WIN_MS = 20;
export const HOP_MS = 2.5;
/** Two peaks closer than this are one pick. Below a 120bpm sixteenth (125ms). */
export const MIN_INTERVAL_MS = 80;
/** How far outside a section's labelled extent a pick may still belong to it. */
export const MARGIN_MS = 150;

/** Takes whose labels came off a grid, and the DI render to measure. */
const TAKES = [
  "same-pitch-eighths-a3-120bpm-di",
  "same-pitch-eighths-sixteenths-e5-120bpm-di",
];

/**
 * Labels the owner set by ear. These are LOCKED: human annotation outranks
 * anything measured here, and without the lock this pass overwrote his 19.613s
 * onset with 19.745s — a worse value, from a weaker source, silently.
 */
const LOCKED: Record<string, readonly string[]> = {
  "same-pitch-eighths-sixteenths-e5-120bpm-di": [
    "s1610", "s1611", "s1612", "s1613", "s1614", "s1615", "s1616", "s1617", "s1618", "s1619", "s1620",
    "s1626", "s1627", "s1628", "s1629", "s1630", "s1631", "s1632", "s1684", "s16108",
  ],
  "same-pitch-eighths-a3-120bpm-di": [
    "e869", "e871", "e872", "s160", "s161", "s162", "s163", "s164", "s165", "s166", "s167", "s1627",
    "s16108", "s16109", "s16110", "s16111", "s16112", "s16113",
  ],
};

/** The owner's listening pass on the DI renders, as the check. */
const EAR: Record<string, { pick: number[] }> = {
  "same-pitch-eighths-sixteenths-e5-120bpm-di": {
    pick: [
      19039, 19271, 19368, 19510, 19614, 19744, 19836, 19972, 20086, 20204, 20298,
      21044, 21188, 21297, 21422, 21548, 21687, 21805, 25572, 28339, 30075, 31344,
    ],
  },
  "same-pitch-eighths-a3-120bpm-di": {
    pick: [
      19019, 19494, 19747, 19875, 20011, 20117, 20254, 20375, 20518, 20613, 20744, 23275,
      33296, 33416, 33563, 33689, 33809, 33955,
    ],
  },
};

export function envelope(x: Float32Array, sampleRate: number): number[] {
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
 * Every peak in the envelope with the prominence it carries.
 *
 * Prominence is measured against the quietest point since the previous peak —
 * walked forward, with no fixed lookback, because a fixed one reaches past the
 * previous pick at sixteenth spacing. No threshold is applied here: the caller
 * decides how many to keep, which is the whole point.
 */
export function peaks(env: readonly number[]): Array<{ at: number; prom: number }> {
  const out: Array<{ at: number; prom: number }> = [];
  let trough = Number.POSITIVE_INFINITY;
  let peak = 0;
  let peakAt = -1;
  for (let i = 0; i < env.length; i++) {
    const v = env[i] as number;
    if (v < trough) { trough = v; peak = v; peakAt = -1; continue; }
    if (v > peak) { peak = v; peakAt = i; }
    if (peakAt >= 0 && v < peak * 0.9) {
      out.push({ at: peakAt * HOP_MS, prom: trough > 1e-9 ? peak / trough : Infinity });
      trough = v; peak = v; peakAt = -1;
    }
  }
  return out;
}

/**
 * Candidate picks in a span: the most prominent peaks, over-selected.
 *
 * Deliberately more than the label count. Taking exactly N and assigning them
 * positionally is brittle — one pick the envelope misses shifts every label
 * after it by a whole note, which is what produced 248ms and 1780ms median
 * offsets on the sixteenth sections. Over-select, then let the alignment below
 * decide which candidates are real.
 */
export function candidates(all: readonly { at: number; prom: number }[], from: number, to: number, n: number) {
  const inSpan = all
    .filter((p) => p.at >= from - MARGIN_MS && p.at <= to + MARGIN_MS)
    .sort((a, b) => b.prom - a.prom);
  const kept: Array<{ at: number; prom: number }> = [];
  for (const p of inSpan) {
    if (kept.length >= Math.ceil(n * 1.6)) break;
    if (kept.some((k) => Math.abs(k.at - p.at) < MIN_INTERVAL_MS)) continue;
    kept.push(p);
  }
  return kept.sort((a, b) => a.at - b.at);
}

/**
 * Assign labels to candidates in order, one to one, allowing either to be
 * skipped. Monotonic, so a missing pick costs one label rather than shifting
 * every label after it.
 */
export const SKIP_COST = 140;
export function align(labels: readonly number[], picks: readonly number[]): Array<number | null> {
  const n = labels.length, m = picks.length;
  const cost = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Infinity));
  const from = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  cost[0]![0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = cost[i]![j] as number;
      if (!Number.isFinite(here)) continue;
      if (i < n && j < m) {
        const c = here + Math.abs((labels[i] as number) - (picks[j] as number));
        if (c < (cost[i + 1]![j + 1] as number)) { cost[i + 1]![j + 1] = c; from[i + 1]![j + 1] = 1; }
      }
      if (i < n && here + SKIP_COST < (cost[i + 1]![j] as number)) { cost[i + 1]![j] = here + SKIP_COST; from[i + 1]![j] = 2; }
      if (j < m && here + SKIP_COST < (cost[i]![j + 1] as number)) { cost[i]![j + 1] = here + SKIP_COST; from[i]![j + 1] = 3; }
    }
  }
  const out = new Array<number | null>(n).fill(null);
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const f = from[i]![j] as number;
    if (f === 1) { out[i - 1] = picks[j - 1] as number; i--; j--; }
    else if (f === 2) i--;
    else if (f === 3) j--;
    else break;
  }
  return out;
}

function main(): void {
  const write = process.argv.includes("--write");
  let earHit = 0, earTotal = 0;
  const summary: string[] = [];

  for (const fixture of decodeFixtures({ quiet: true })) {
    if (!TAKES.includes(fixture.stem)) continue;
    const wav = readWav(readFileSync(fixture.wavPath));
    const env = envelope(downmixToMono(wav.samples, wav.channels), wav.sampleRate);
    const all = peaks(env);
    const events = fixture.label.events;

    // Sections are the label id prefixes the generator used: eighths, then
    // sixteenths. Each is re-timed against its OWN count.
    const sections = new Map<string, typeof events>();
    for (const e of events) {
      const key = e.id.startsWith("s16") ? "sixteenths" : "eighths";
      sections.set(key, [...(sections.get(key) ?? []), e]);
    }

    const proposed = new Map<string, number>();
    for (const [name, evs] of sections) {
      const from = (evs[0] as (typeof evs)[number]).startMs;
      const to = (evs[evs.length - 1] as (typeof evs)[number]).startMs;
      const locked = new Set(LOCKED[fixture.stem] ?? []);
      const cand = candidates(all, from, to, evs.length);
      const assigned = align(evs.map((e) => e.startMs), cand.map((c) => c.at));
      const offs: number[] = [];
      let matched = 0;
      for (let i = 0; i < evs.length; i++) {
        const at = assigned[i];
        if (at === null || at === undefined) continue;
        const e = evs[i] as (typeof evs)[number];
        if (locked.has(e.id)) continue;
        proposed.set(e.id, at);
        offs.push(at - e.startMs);
        matched++;
      }
      const picks = { length: matched };
      const abs = offs.map(Math.abs).sort((a, b) => a - b);
      summary.push(
        `  ${fixture.stem.replace("same-pitch-", "").padEnd(34)} ${name.padEnd(11)} ` +
          `labels ${String(evs.length).padStart(3)}  picks found ${String(picks.length).padStart(3)}  ` +
          `median |offset| ${(abs.length ? (abs[Math.floor(abs.length / 2)] as number) : 0).toFixed(0).padStart(3)}ms  ` +
          `p90 ${(abs.length ? (abs[Math.floor(abs.length * 0.9)] as number) : 0).toFixed(0).padStart(4)}ms`
      );
    }

    const ear = EAR[fixture.stem];
    if (ear !== undefined) {
      for (const t of ear.pick) {
        earTotal++;
        const nearest = events.reduce((a, e) => (Math.abs(e.startMs - t) < Math.abs(a.startMs - t) ? e : a), events[0]!);
        const got = proposed.get(nearest.id) ?? nearest.startMs;
        if (Math.abs(got - t) <= 30) earHit++;
        else console.log(`    EAR MISS ${fixture.stem.replace("same-pitch-","")} ${(t/1000).toFixed(3)}s -> label ${nearest.id} was ${nearest.startMs}, proposed ${got ?? "none"}`);
      }
    }

    if (write) {
      const path = join(REPO_ROOT, "fixtures", "labels", `${fixture.stem}.json`);
      const doc = JSON.parse(readFileSync(path, "utf8")) as {
        timingNotes: string;
        events: Array<{ id: string; startMs: number; endMs: number }>;
      };
      // A proposal yields to its neighbours' final times. A locked label is an
      // immovable point — the owner heard it — so a proposal that would step
      // over one is dropped rather than allowed to reorder the take. Without
      // this, s1614 was moved to 19618 past a locked 19613 and left a
      // negative-length event behind it.
      const finalAt = doc.events.map((e) => e.startMs);
      for (let i = 0; i < doc.events.length; i++) {
        const e = doc.events[i] as { id: string; startMs: number };
        const at = proposed.get(e.id);
        if (at === undefined) continue;
        const lo = i > 0 ? (finalAt[i - 1] as number) : Number.NEGATIVE_INFINITY;
        const hi = i + 1 < finalAt.length ? (finalAt[i + 1] as number) : Number.POSITIVE_INFINITY;
        const want = Math.round(at);
        if (want <= lo || want >= hi) continue;
        finalAt[i] = want;
      }
      for (let i = 0; i < doc.events.length; i++) {
        const e = doc.events[i] as { startMs: number; endMs: number };
        const previous = doc.events[i - 1] as { endMs: number } | undefined;
        if (previous !== undefined && previous.endMs === e.startMs) previous.endMs = finalAt[i] as number;
        e.startMs = finalAt[i] as number;
      }
      for (let i = 0; i < doc.events.length - 1; i++) {
        const a = doc.events[i] as { endMs: number };
        const b = doc.events[i + 1] as { startMs: number };
        if (a.endMs > b.startMs) a.endMs = b.startMs;
      }
      doc.timingNotes +=
        " RE-TIMED by scripts/retime-gridded-labels.ts: each section's picks located in the DI" +
        " audio by taking the N most prominent envelope peaks, N being the section's own label" +
        " count, and assigning them in time order. No threshold and no detector output is" +
        " involved. The grid is gone from these sections; the count is unchanged.";
      writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    }
  }

  console.log("\n  RE-TIMING BY COUNT (DI renders)\n");
  for (const line of summary) console.log(line);
  console.log(
    `\n  CHECK against the owner's ear: ${earHit}/${earTotal} of the picks he confirmed` +
      ` land within 30ms of a proposed onset\n`
  );
  console.log(write ? "  fixtures/labels/** UPDATED.\n" : "  (dry run - pass --write to apply)\n");
}

/* Run only when invoked directly, so another script can import the envelope,
   peak-picking and alignment helpers above without this pass running and
   without duplicating a single one of its constants. Same guard
   `decode-fixtures.ts` uses. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) main();
