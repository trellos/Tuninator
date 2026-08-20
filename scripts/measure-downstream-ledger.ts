/**
 * Every labelled event with no detection, and the exact test that discarded it.
 *
 * `measure-onset-coverage.ts` answers what the detector SAW. This answers what
 * became of it: the onset kernel now reaches 44-45 of the 48 strokes on each
 * sixteenths take while the tracker emits 36-41 Notes, so the losses are
 * downstream of the evidence and a ledger of causes has to name code sites
 * rather than categories.
 *
 * It is built on the tracker's own trace (`TrackerTraceEvent`) rather than on a
 * re-implementation of its rules, so it cannot describe a version of the
 * tracker that no longer exists. Every cause below is one branch in
 * `note-tracker.ts` or `fast/rearticulation.ts`, named in `SITES`.
 *
 * Usage:
 *   npx tsx scripts/measure-downstream-ledger.ts              lead + sixteenths
 *   npx tsx scripts/measure-downstream-ledger.ts --all        every fixture
 *   npx tsx scripts/measure-downstream-ledger.ts sixteenths   one subset
 *   npx tsx scripts/measure-downstream-ledger.ts --detail     every missed label
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { matchEvents, type LabeledEvent } from "../src/offline/matcher.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";

/**
 * How near a label a decision has to be to be that label's decision. The
 * matcher's own window is far wider (300ms) because it also scores overlap;
 * attributing a rejected transient to a stroke needs the tight one, and 70ms is
 * two thirds of a 107ms sixteenth at 140bpm.
 */
export const WINDOW_MS = 70;

/** The takes this exists for. Everything else is available behind `--all`. */
const FOCUS = ["sixteenths", "quarter-eighth-triplet"];

/** Where each cause lives, so the ledger names a line rather than a mood. */
const SITES: Readonly<Record<string, string>> = {
  "paired with a neighbouring label":
    "a Note opened here and the matcher gave it the label either side",
  "no boundary here; the nearest Note is a neighbour's":
    "no segmentation decision was taken at this stroke at all",
  "split made; successor never announced":
    "note-tracker.ts end(): the split's successor sounded < announceThresholdMs",
  "split made; successor absorbed as an articulation stub":
    "note-tracker.ts absorbArticulationFragment(): the split's successor was swallowed",
  "split made; successor paired with a neighbouring label":
    "the split happened and its Note took the label either side",
  "never announced": "note-tracker.ts end(): soundedMs < announceThresholdMs",
  "absorbed as an articulation stub": "note-tracker.ts absorbArticulationFragment()",
  "too young to be ended": "note-tracker.ts process() `settled`: soundedMs < minStableMs",
  "too soon to re-strike a chord":
    "note-tracker.ts process() `settled`: lastSeenAt - startTime < minRestrumMs",
  "rejected: glide-rise": "rearticulation.ts: gliding && riseRatio < glideRiseOverride",
  "rejected: chord-past-muted-window":
    "rearticulation.ts: polyphonic && soundedMs > mutedRestrumWindowMs",
  "rejected: chord-not-sharp": "rearticulation.ts: polyphonic && !sharpEnough()",
  "rejected: ring-out-below-floor":
    "rearticulation.ts: decayExcess < ringOutDecayFloor",
  "rejected: ring-out-not-sharp":
    "rearticulation.ts: heldSharpness < restrumSharpness || heldFluxRatio < ringOutFluxRatio",
  "rejected: no-energy-not-sharp":
    "rearticulation.ts: rms < sustainedRms * rearticulationRiseRatio && sharpness < rearticulationSharpness",
  "rejected: gated": "rearticulation.ts: frame.gated",
  "band-only transient": "the fast lane may not act on FastFrame.bandOnset",
  "split made; no successor opened":
    "note-tracker.ts process(): the boundary was made and nothing sounded after it",
  "absorbed as an articulation stub (into a bloomed Note)":
    "note-tracker.ts absorbAttackFragments()",
  "transient below the amplitude gate": "fast-lane.ts: frame.gated, no Note may open",
  "no transient within the window": "kernels/onset.ts never fired here",
};

export type Cause = { cause: string; detail: string };

/** What became of one Note, gathered from the trace. */
export type Fate = {
  id: string;
  openedAt: number;
  trigger: string;
  absorbedInto: string | null;
  announced: boolean | null;
  soundedMs: number;
  announceBarMs: number;
  emitted: boolean;
};

export function fatesOf(
  events: readonly TrackerTraceEvent[],
  emittedNoteIds: ReadonlySet<string>
): Map<string, Fate> {
  const fates = new Map<string, Fate>();
  for (const event of events) {
    if (event.kind === "opened") {
      fates.set(event.noteId, {
        id: event.noteId,
        openedAt: event.at,
        trigger: event.trigger,
        absorbedInto: null,
        announced: null,
        soundedMs: 0,
        announceBarMs: 0,
        emitted: emittedNoteIds.has(event.noteId),
      });
    } else if (event.kind === "absorbed") {
      const fate = fates.get(event.noteId);
      if (fate !== undefined) fate.absorbedInto = event.intoId;
    } else if (event.kind === "ended") {
      const fate = fates.get(event.noteId);
      if (fate === undefined) continue;
      fate.announced = event.announced;
      fate.soundedMs = event.soundedMs;
      fate.announceBarMs = event.announceBarMs;
    }
  }
  return fates;
}

function fmt(x: number | null, digits = 2): string {
  return x === null ? "-" : x.toFixed(digits);
}

/**
 * What happened to a Note that WAS opened for this stroke.
 *
 * An absorbed Note is followed to whatever absorbed it, because absorption is
 * not by itself a loss: the survivor inherits the stub's start time, so the
 * boundary this stroke produced is still on the timeline under another id. What
 * decides whether the stroke was detected is what became of the SURVIVOR, and
 * reporting the absorb hides a stroke that was really lost one step later
 * behind a rule that was doing its job. Only when the survivor is itself gone
 * does the absorb become the answer, and then it is named as a chain.
 */
function fateOf(fate: Fate, prefix: string, fates: ReadonlyMap<string, Fate>): Cause {
  if (fate.absorbedInto !== null) {
    const chain = [fate.id];
    let current = fate;
    for (let guard = 0; guard < 16 && current.absorbedInto !== null; guard++) {
      const next = fates.get(current.absorbedInto);
      if (next === undefined) break;
      chain.push(next.id);
      current = next;
    }
    if (current !== fate && current.absorbedInto === null) {
      const downstream = fateOf(current, prefix, fates);
      return {
        cause: `absorbed, then ${downstream.cause}`,
        detail: `${chain.join(" -> ")}: ${downstream.detail}`,
      };
    }
    return {
      cause: `${prefix}absorbed as an articulation stub`,
      detail: chain.join(" -> "),
    };
  }
  if (fate.announced === false) {
    return {
      cause: `${prefix}never announced`,
      detail: `${fate.id} sounded ${fate.soundedMs.toFixed(0)} < ${fate.announceBarMs.toFixed(0)}`,
    };
  }
  if (fate.emitted) {
    return {
      cause: `${prefix}paired with a neighbouring label`,
      detail: `${fate.id} @${fate.openedAt.toFixed(0)}`,
    };
  }
  return { cause: `${prefix}opened but never emitted`, detail: fate.id };
}

/** Classify one missed label from the decisions taken around it. */
export function classify(
  labelStart: number,
  events: readonly TrackerTraceEvent[],
  fates: ReadonlyMap<string, Fate>,
  /** Notes the matcher already gave to some OTHER label. */
  spokenFor: ReadonlySet<string>,
  /**
   * Every label onset in the fixture. A trace event within the window is only
   * this label's when this label is the NEAREST one — six of the corpus's
   * missed labels sit 55-77ms after their neighbour (rushed pairs, closer
   * than the 70ms window), and without the nearest-label test the
   * neighbour's own correct boundary was attributed to the missed stroke,
   * reading a kernel dead-time loss as a split-pairing defect. The fifth
   * instance of the window-wider-than-the-spacing error class in this
   * project, this time inside the diagnostic itself.
   */
  allLabelStarts: readonly number[] = []
): Cause {
  const nearestToThis = (at: number): boolean => {
    for (const other of allLabelStarts) {
      if (Math.abs(other - labelStart) < 1) continue;
      if (Math.abs(at - other) < Math.abs(at - labelStart)) return false;
    }
    return true;
  };
  const near = events.filter(
    (e) => Math.abs(e.at - labelStart) <= WINDOW_MS && nearestToThis(e.at)
  );

  // 1. A Note opened on this stroke. Whatever else happened, the boundary was
  //    found; what is missing is a detection carrying it.
  //
  // Unless that Note is already some other label's. A stroke 107ms from its
  // neighbours has both of them inside this window, so "a Note opened near
  // here" is not evidence that anything was detected HERE — and calling it
  // "the matcher paired it with a neighbour" hides a stroke that produced no
  // boundary at all behind an accounting complaint.
  let stolen: Fate | null = null;
  for (const event of near) {
    if (event.kind !== "opened") continue;
    const fate = fates.get(event.noteId);
    if (fate === undefined) continue;
    if (fate.emitted && spokenFor.has(fate.id)) {
      if (stolen === null) stolen = fate;
      continue;
    }
    return fateOf(fate, "", fates);
  }

  // 2. A re-articulation was considered over a sounding Note.
  const attempts = near.filter(
    (e): e is Extract<TrackerTraceEvent, { kind: "rearticulation" }> =>
      e.kind === "rearticulation"
  );
  const accepted = attempts.find((a) => a.accepted);
  if (accepted !== undefined) {
    if (!accepted.settled) {
      return {
        cause: accepted.bloomed ? "too soon to re-strike a chord" : "too young to be ended",
        detail:
          `${accepted.noteId} sounded ${accepted.soundedMs.toFixed(0)} < ` +
          `${accepted.settleBarMs.toFixed(0)} [accepted via ${accepted.reason}]`,
      };
    }
    // The boundary was made. Whatever the successor became is the answer.
    let successor: Fate | null = null;
    for (const fate of fates.values()) {
      if (fate.openedAt < accepted.at - 1) continue;
      if (fate.openedAt > accepted.at + WINDOW_MS) continue;
      if (successor === null || fate.openedAt < successor.openedAt) successor = fate;
    }
    if (successor !== null) return fateOf(successor, "split made; successor ", fates);
    return { cause: "split made; no successor opened", detail: accepted.noteId };
  }
  if (attempts.length > 0) {
    const best = attempts[0] as Extract<TrackerTraceEvent, { kind: "rearticulation" }>;
    return {
      cause: `rejected: ${best.reason}`,
      detail:
        `${best.noteId} sharp ${fmt(best.sharpness)}/${fmt(best.heldSharpness)}` +
        ` flux ${fmt(best.fluxRatio)}/${fmt(best.heldFluxRatio)}` +
        ` env ${fmt(best.envelopeOverBaseline)} rise ${fmt(best.riseRatio)}` +
        `${best.gliding ? ` glide ${best.glideCents.toFixed(0)}c` : ""}` +
        `${best.pitchDiffers ? " new-pitch" : ""}` +
        ` excess ${fmt(best.decayExcess)} kernel ${best.kernelOnset ? "fired" : "envelope only"}` +
        ` sounded ${best.soundedMs.toFixed(0)}`,
    };
  }

  // 3. A Note opened near here and belongs to a neighbour, and nothing else
  //    happened at this stroke: the boundary this label needed was never made.
  if (stolen !== null) {
    return {
      cause: "no boundary here; the nearest Note is a neighbour's",
      detail: `${stolen.id} @${stolen.openedAt.toFixed(0)}`,
    };
  }

  // 4. Nothing was decided, so nothing reached the decision.
  const onsets = near.filter(
    (e): e is Extract<TrackerTraceEvent, { kind: "onset" }> => e.kind === "onset"
  );
  if (onsets.length === 0) return { cause: "no transient within the window", detail: "" };
  const usable = onsets.find((o) => o.broadband && !o.gated);
  if (usable !== undefined) {
    return {
      cause: "transient accepted, no decision recorded",
      detail: `@${usable.at.toFixed(0)}`,
    };
  }
  if (onsets.some((o) => o.broadband && o.gated)) {
    return { cause: "transient below the amplitude gate", detail: "" };
  }
  return { cause: "band-only transient", detail: "" };
}

type FixtureLedger = {
  stem: string;
  labels: number;
  detections: number;
  missed: Array<{ id: string; startMs: number; label: string } & Cause>;
};

function run(stems: (stem: string) => boolean): FixtureLedger[] {
  const out: FixtureLedger[] = [];
  for (const fixture of decodeFixtures({ quiet: true })) {
    if (!stems(fixture.stem)) continue;
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const events: TrackerTraceEvent[] = [];
    const analysis = analyzeSamples(mono, wav.sampleRate, {
      trackerTrace: (event) => events.push(event),
    });
    const detections = projectEmissions(analysis.emissions).final;
    const labels = fixture.label.events as LabeledEvent[];
    const result = matchEvents(labels, detections);
    const fates = fatesOf(events, new Set(detections.map((d) => d.id)));
    const spokenFor = new Set(result.matches.map((m) => m.detection.id));

    out.push({
      stem: fixture.stem,
      labels: labels.length,
      detections: detections.length,
      missed: result.missed.map(({ label }) => ({
        id: label.id,
        startMs: label.startMs,
        label: label.label,
        ...classify(
          label.startMs,
          events,
          fates,
          spokenFor,
          labels.map((l) => l.startMs)
        ),
      })),
    });
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const detail = args.includes("--detail");
  const all = args.includes("--all");
  const filter = args.find((a) => !a.startsWith("--"));
  const select = (stem: string): boolean => {
    if (filter !== undefined) return stem.includes(filter);
    if (all) return true;
    return FOCUS.some((f) => stem.includes(f));
  };

  const ledgers = run(select);
  const causes = new Map<string, Map<string, number>>();
  for (const ledger of ledgers) {
    for (const miss of ledger.missed) {
      const row = causes.get(miss.cause) ?? new Map<string, number>();
      row.set(ledger.stem, (row.get(ledger.stem) ?? 0) + 1);
      causes.set(miss.cause, row);
    }
  }

  const stems = ledgers.map((l) => l.stem);
  const short = (stem: string): string =>
    stem
      .replace("lead-line-", "")
      .replace("-e-fsharp-140bpm", "")
      .replace("-140bpm", "")
      .replace("quarter-eighth-triplet", "triplet");

  console.log("\n  detections / labels, and missed labels by cause\n");
  const head = ["cause", ...stems.map(short), "total"];
  const table: string[][] = [head];
  table.push([
    "detections",
    ...ledgers.map((l) => `${l.detections}/${l.labels}`),
    String(ledgers.reduce((n, l) => n + l.detections, 0)),
  ]);
  const ordered = [...causes.entries()].sort(
    (a, b) =>
      [...b[1].values()].reduce((x, y) => x + y, 0) -
      [...a[1].values()].reduce((x, y) => x + y, 0)
  );
  for (const [cause, row] of ordered) {
    table.push([
      cause,
      ...stems.map((s) => String(row.get(s) ?? 0)),
      String([...row.values()].reduce((x, y) => x + y, 0)),
    ]);
  }
  table.push([
    "MISSED",
    ...ledgers.map((l) => String(l.missed.length)),
    String(ledgers.reduce((n, l) => n + l.missed.length, 0)),
  ]);

  const width: number[] = [];
  for (const row of table) row.forEach((c, i) => (width[i] = Math.max(width[i] ?? 0, c.length)));
  table.splice(1, 0, width.map((w) => "-".repeat(w)));
  for (const row of table) {
    console.log(
      "  " +
        row
          .map((c, i) => (i === 0 ? c.padEnd(width[i] as number) : c.padStart(width[i] as number)))
          .join("  ")
    );
  }

  console.log("\n  where each cause lives");
  for (const [cause] of ordered) {
    console.log(`    ${cause.padEnd(54)} ${SITES[cause] ?? "(unattributed)"}`);
  }

  if (detail) {
    for (const ledger of ledgers) {
      if (ledger.missed.length === 0) continue;
      console.log(`\n  ${ledger.stem}`);
      for (const miss of ledger.missed) {
        console.log(
          `    ${miss.id.padEnd(4)} @${miss.startMs.toFixed(0).padStart(6)}  ${miss.label.padEnd(6)}` +
            `  ${miss.cause}${miss.detail === "" ? "" : `  [${miss.detail}]`}`
        );
      }
    }
  }
  console.log("");
}

// Runs when invoked, stays quiet when imported: `build-relabel-kit.ts` reuses
// `classify`/`fatesOf` to name each missed label's cause in its manifest.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
