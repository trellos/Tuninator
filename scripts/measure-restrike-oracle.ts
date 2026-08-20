/**
 * Can the local note rate tell a false same-pitch boundary from a real re-pick?
 *
 * `docs/DETECTION-FINDINGS.md` records the retroactive undo of a same-pitch
 * boundary: it removes 11 spurious Notes and costs 4 labels, and neither
 * duration, nor the energy witnesses at the boundary, nor whether the split
 * stood alone separates the merges it should make from the ones it must not.
 * The remaining idea was the inter-onset interval — a false split makes a
 * stroke about half its neighbours' length, a real re-pick makes one the same
 * length as its neighbours'.
 *
 * That idea is close enough to the refuted "constants at a reference pace" work
 * in the same document to deserve the same treatment, and to deserve it BEFORE
 * an estimator is built. So the rate here is an ORACLE — the median gap between
 * the LABELS within `ORACLE_WINDOW_MS` of the candidate, which no causal
 * detector can have. If perfect knowledge of the local rate does not separate
 * the two populations, no estimator built on the detector's own onsets can,
 * because that estimator is corrupted by the very errors it would fix.
 *
 * The candidate set is reconstructed from the tracker's trace, so this script
 * changes no engine code and measures the rule as it was built and reverted:
 * a Note opened by an accepted, settled, SAME-pitch re-articulation, ended
 * within one articulation by a pitch step.
 *
 * Ground truth for each candidate is the matcher's own verdict. A candidate the
 * matcher paired with a label is a Note the rule must NOT swallow; one it left
 * unpaired is a spurious Note the rule exists to remove.
 *
 * Usage:
 *   npx tsx scripts/measure-restrike-oracle.ts
 *   npx tsx scripts/measure-restrike-oracle.ts --detail
 */

import { readFileSync } from "node:fs";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { matchEvents, type DetectedEvent, type LabeledEvent } from "../src/offline/matcher.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/** Half-width of the window the oracle takes its median gap from. */
const ORACLE_WINDOW_MS = 700;
/**
 * The widest fragment collected. Deliberately far above the reverted rule's
 * bound of `transient.articulationMs`: filtering the candidate set to short
 * fragments up front makes any "is it shorter than its head" test inert by
 * construction, so the gates below have to do their own filtering.
 */
const ARTICULATION_MS = 100000;

type Candidate = {
  stem: string;
  id: string;
  previousId: string;
  startedAt: number;
  soundedMs: number;
  previousSpanMs: number;
  oracleIoiMs: number;
  /** The matcher paired this Note with a label, so removing it costs one. */
  paired: boolean;
};

type Take = {
  stem: string;
  labels: readonly LabeledEvent[];
  detections: DetectedEvent[];
  candidates: Candidate[];
};

/** Median gap between labels whose starts sit within the window of `at`. */
function oracleIoi(labels: readonly LabeledEvent[], at: number): number {
  const near = labels
    .filter((l) => Math.abs(l.startMs - at) <= ORACLE_WINDOW_MS)
    .map((l) => l.startMs)
    .sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < near.length; i++) {
    gaps.push((near[i] as number) - (near[i - 1] as number));
  }
  if (gaps.length === 0) return NaN;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1
    ? (gaps[mid] as number)
    : ((gaps[mid - 1] as number) + (gaps[mid] as number)) / 2;
}

function collect(): Take[] {
  const takes: Take[] = [];
  for (const fixture of decodeFixtures({ quiet: true })) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const events: TrackerTraceEvent[] = [];
    const analysis = analyzeSamples(mono, wav.sampleRate, {
      trackerTrace: (e) => events.push(e),
    });
    const detections = projectEmissions(analysis.emissions).final;
    const labels = fixture.label.events as LabeledEvent[];
    const paired = new Set(matchEvents(labels, detections).matches.map((m) => m.detection.id));
    const out: Candidate[] = [];

    const opened = new Map<string, Extract<TrackerTraceEvent, { kind: "opened" }>>();
    const ended = new Map<string, Extract<TrackerTraceEvent, { kind: "ended" }>>();
    for (const e of events) {
      if (e.kind === "opened") opened.set(e.noteId, e);
      else if (e.kind === "ended") ended.set(e.noteId, e);
    }

    // A same-pitch split: an accepted, settled re-articulation with
    // pitchDiffers false, and the Note that opened at that same instant.
    for (let i = 0; i < events.length; i++) {
      const split = events[i] as TrackerTraceEvent;
      if (split.kind !== "rearticulation") continue;
      if (!split.accepted || !split.settled || split.pitchDiffers) continue;
      let child: Extract<TrackerTraceEvent, { kind: "opened" }> | null = null;
      for (let j = i + 1; j < events.length && j < i + 8; j++) {
        const next = events[j] as TrackerTraceEvent;
        if (next.kind !== "opened") continue;
        if (Math.abs(next.at - split.at) > 30) continue;
        child = next;
        break;
      }
      if (child === null) continue;

      // Ended within one articulation, by a pitch step: the successor that
      // opened where it ended carries the `pitchChange` trigger.
      const death = ended.get(child.noteId);
      if (death === undefined) continue;
      const soundedMs = death.soundedMs;
      if (soundedMs >= ARTICULATION_MS) continue;
      let steppedAway = false;
      for (const e of events) {
        if (e.kind !== "opened") continue;
        if (Math.abs(e.at - death.at) > 5) continue;
        if (e.noteId === child.noteId) continue;
        if (e.trigger === "pitchChange") steppedAway = true;
      }
      if (!steppedAway) continue;

      const previousOpen = opened.get(split.noteId);
      const previousEnd = ended.get(split.noteId);
      out.push({
        stem: fixture.stem,
        id: child.noteId,
        previousId: split.noteId,
        startedAt: child.at,
        soundedMs,
        previousSpanMs:
          previousOpen === undefined || previousEnd === undefined
            ? NaN
            : previousEnd.at - previousOpen.at,
        oracleIoiMs: oracleIoi(labels, child.at),
        paired: paired.has(child.noteId),
      });
    }
    takes.push({ stem: fixture.stem, labels, detections: [...detections], candidates: out });
  }
  return takes;
}

/**
 * The rule's end-to-end cost, simulated on the detection list.
 *
 * Removing a spurious Note is not the only thing the merge does: the survivor's
 * span grows, and the matcher then re-pairs around it. That second-order effect
 * is where the label loss came from last time, so counting candidates is not
 * enough — the matcher has to be re-run over the merged list.
 *
 * Two counts, and the difference between them matters more than either. Most of
 * what this gate merges never reached the announcement bar and so was never a
 * detection at all: removing it changes nothing anybody can see. `removed`
 * counts every merge; `removedEmitted` counts only the ones that were emitted,
 * and that is the number the fragmentation figure moves by. An earlier version
 * of this script reported only the first, which overstated what the gate can
 * buy by a factor of five.
 */
function endToEnd(
  takes: readonly Take[],
  gate: (c: Candidate) => boolean
): { missed: number; removed: number; removedEmitted: number } {
  let missed = 0;
  let removed = 0;
  let removedEmitted = 0;
  for (const take of takes) {
    const merged = new Map<string, number>();
    const drop = new Set<string>();
    for (const c of take.candidates) {
      if (!gate(c)) continue;
      drop.add(c.id);
      removed++;
      if (take.detections.some((d) => d.id === c.id)) removedEmitted++;
      const fragment = take.detections.find((d) => d.id === c.id);
      const end = fragment?.endedAt ?? null;
      if (end !== null) merged.set(c.previousId, Math.max(merged.get(c.previousId) ?? 0, end));
    }
    const after = take.detections
      .filter((d) => !drop.has(d.id))
      .map((d) => {
        const extended = merged.get(d.id);
        return extended === undefined ? d : { ...d, endedAt: Math.max(d.endedAt ?? 0, extended) };
      });
    missed += matchEvents(take.labels, after).missed.length;
  }
  return { missed, removed, removedEmitted };
}

function span(values: number[]): string {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return "none";
  const q = (p: number): string => (v[Math.round((v.length - 1) * p)] as number).toFixed(2);
  return `n=${v.length}  min ${q(0)}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  max ${q(1)}`;
}

function main(): void {
  const detail = process.argv.includes("--detail");
  const takes = collect();
  const candidates = takes.flatMap((t) => t.candidates);
  const good = candidates.filter((c) => !c.paired);
  const bad = candidates.filter((c) => c.paired);

  if (detail) {
    console.log("\n  every candidate the reverted rule would merge\n");
    let stem = "";
    for (const c of candidates) {
      if (c.stem !== stem) {
        stem = c.stem;
        console.log(`  ${stem}`);
      }
      const ratio = c.soundedMs / c.oracleIoiMs;
      console.log(
        `    ${c.paired ? "KEEP" : "drop"}  ${c.id.padEnd(4)}<-${c.previousId.padEnd(4)}` +
          ` @${c.startedAt.toFixed(0).padStart(6)}  sounded ${c.soundedMs.toFixed(0).padStart(3)}` +
          `  prev ${c.previousSpanMs.toFixed(0).padStart(4)}` +
          `  oracle IOI ${c.oracleIoiMs.toFixed(0).padStart(4)}` +
          `  sounded/IOI ${ratio.toFixed(2)}` +
          `  prev/IOI ${(c.previousSpanMs / c.oracleIoiMs).toFixed(2)}`
      );
    }
  }

  console.log(`\n  candidates ${candidates.length}   spurious (drop) ${good.length}` +
    `   matched to a label (KEEP) ${bad.length}\n`);
  console.log("  the discriminator the proposal rests on: fragment span / oracle IOI");
  console.log(`    spurious  ${span(good.map((c) => c.soundedMs / c.oracleIoiMs))}`);
  console.log(`    matched   ${span(bad.map((c) => c.soundedMs / c.oracleIoiMs))}`);
  console.log("\n  the head/tail test: fragment span / predecessor span");
  console.log(`    spurious  ${span(good.map((c) => c.soundedMs / c.previousSpanMs))}`);
  console.log(`    matched   ${span(bad.map((c) => c.soundedMs / c.previousSpanMs))}`);
  console.log("\n  and the predecessor's span / oracle IOI");
  console.log(`    spurious  ${span(good.map((c) => c.previousSpanMs / c.oracleIoiMs))}`);
  console.log(`    matched   ${span(bad.map((c) => c.previousSpanMs / c.oracleIoiMs))}`);
  console.log("\n  the raw oracle IOI at each candidate (ms)");
  console.log(`    spurious  ${span(good.map((c) => c.oracleIoiMs))}`);
  console.log(`    matched   ${span(bad.map((c) => c.oracleIoiMs))}`);

  // The best a threshold could do, swept over every value it takes. Reported
  // for the ratio AND for the raw duration, because the raw duration is the
  // control: if it does as well, the oracle is carrying nothing.
  const sweep = (key: (c: Candidate) => number, name: string, digits: number): void => {
    const all = candidates
      .map((c) => ({ x: key(c), paired: c.paired }))
      .filter((c) => Number.isFinite(c.x));
    let best = { at: NaN, dropped: 0 };
    for (const { x } of all) {
      const dropped = all.filter((c) => c.x <= x && !c.paired).length;
      const lost = all.filter((c) => c.x <= x && c.paired).length;
      if (lost === 0 && dropped > best.dropped) best = { at: x, dropped };
    }
    console.log(
      `    ${name.padEnd(24)} ` +
        (Number.isFinite(best.at)
          ? `<= ${best.at.toFixed(digits).padStart(6)}  removes ${best.dropped} of ${good.length}`
          : "no threshold removes anything without taking a label")
    );
  };
  console.log("\n  best threshold that loses NO label");
  sweep((c) => c.soundedMs / c.oracleIoiMs, "sounded / oracle IOI", 2);
  sweep((c) => c.soundedMs, "sounded alone (control)", 0);
  sweep((c) => c.previousSpanMs / c.oracleIoiMs, "prev span / oracle IOI", 2);
  // A tail is shorter than the head it belongs to; a real event swallowed by a
  // stub is LONGER than what precedes it. That is a ratio with no constant in
  // it, so it is swept the same way but the value that matters is 1.
  sweep((c) => c.soundedMs / c.previousSpanMs, "sounded / prev span", 2);
  const base = endToEnd(takes, () => false);
  console.log(`\n  end to end, matcher re-run over the merged detections`);
  console.log(`    rule off                              missed ${base.missed}`);
  const report = (name: string, gate: (c: Candidate) => boolean): void => {
    const r = endToEnd(takes, gate);
    const delta = r.missed - base.missed;
    console.log(
      `    ${name.padEnd(37)} missed ${String(r.missed).padStart(3)}` +
        ` (${delta >= 0 ? "+" : ""}${delta})  merged ${String(r.removed).padStart(3)}` +
        `  of which emitted ${r.removedEmitted}`
    );
  };
  report("sounded < 80 (the reverted rule)", (c) => c.soundedMs < 80);
  report("sounded <= 67", (c) => c.soundedMs <= 67);
  report("sounded/IOI <= 0.40 (oracle)", (c) => c.soundedMs / c.oracleIoiMs <= 0.4);
  report("sounded/IOI <= 0.35 (oracle)", (c) => c.soundedMs / c.oracleIoiMs <= 0.35);
  report("sounded/IOI <= 0.30 (oracle)", (c) => c.soundedMs / c.oracleIoiMs <= 0.3);
  report("sounded/IOI <= 0.25 (oracle)", (c) => c.soundedMs / c.oracleIoiMs <= 0.25);
  report("sounded/IOI <= 0.20 (oracle)", (c) => c.soundedMs / c.oracleIoiMs <= 0.2);
  report("shorter than what precedes it", (c) => c.soundedMs < c.previousSpanMs);
  report("shorter than half what precedes it", (c) => c.soundedMs * 2 < c.previousSpanMs);

  // How wrong may the rate be? The causal estimator this would have to be built
  // on is documented in DETECTION-FINDINGS.md reading a 197ms-per-note take as
  // 107ms — a factor of 0.54 — so the gate is only worth building if it
  // survives errors of that size.
  console.log("\n  the same gate with the rate scaled, standing in for estimator error");
  for (const factor of [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2]) {
    const r = endToEnd(takes, (c) => c.soundedMs / (c.oracleIoiMs * factor) <= 0.4);
    const delta = r.missed - base.missed;
    console.log(
      `    rate x ${factor.toFixed(2)}   missed ${String(r.missed).padStart(3)}` +
        ` (${delta >= 0 ? "+" : ""}${delta})  merged ${String(r.removed).padStart(3)}` +
        `  of which emitted ${r.removedEmitted}`
    );
  }
  console.log("");
}

main();
