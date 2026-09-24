/**
 * Door 3 (ledger row C3): the OUTCOME-shaped rows a retrospective classifier
 * is trained and judged on, from this repository's own tuning takes.
 *
 * A row is a Note opened by an accepted, settled, same-pitch re-articulation
 * (the population `scripts/measure-rate-relative-merge.ts` widened to), and
 * its target is the outcome question DECISION-032 names: did the matcher pair
 * that Note with a label? An unpaired one is a surplus Note.
 *
 * Two engine configurations are written, because they answer different
 * questions:
 *
 *  - `off`: the rate-relative fragment gate (DECISION-030, DECISION-045)
 *    disabled, so every same-pitch fragment it would have refused is still a
 *    row. This is the population the rate feature's 0.826 was read on, and
 *    the one the falsifier's first clause compares on.
 *  - `shipped`: the engine as it is. Rows whose Note survived the gate are
 *    what a vote BESIDE the gate could still remove; the second clause (more
 *    extras removed at zero missed than the gate already removes) is read here.
 *
 * Only the tuning takes are read. The twelve 140bpm takes are never loaded.
 *
 *   npx tsx training/extract-outcome-rows.ts --out training/out/outcome
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { matchEvents, type LabeledEvent } from "../src/offline/matcher.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import type { EngineConfig } from "../src/engine/config.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "../scripts/decode-fixtures.js";

export const TUNING = [
  "chords-a-bm-g-d-2x-120bpm",
  "clean-lead-120bpm",
  "cowboy-chords-c-d-em-g-c-d-em-am-120bpm",
  "power-chords-c-a-g-e-c-d-fsharp-e-120bpm",
  "spicy-chords-cmaj9-g-am11",
  "same-pitch-quarters-a3-e5-120bpm-di",
  "same-pitch-quarters-a3-e5-120bpm-amped",
  "same-pitch-eighths-a3-120bpm-di",
  "same-pitch-eighths-a3-120bpm-amped",
  "same-pitch-eighths-sixteenths-e5-120bpm-di",
  "same-pitch-eighths-sixteenths-e5-120bpm-amped",
  "held-then-picked-six-strings-120bpm-di",
  "held-then-picked-six-strings-120bpm-amped",
  "rest-repick-g2-60-120bpm-di",
  "rest-repick-g2-60-120bpm-amped",
];

const CONFIGS: Record<string, ((c: EngineConfig) => void) | undefined> = {
  shipped: undefined,
  off: (c) => {
    // Neither suspicion can fire: the dip bar is unreachable and no rise is
    // below zero. `rateFragmentSpanFraction` then returns null everywhere.
    c.tracking.rateFragmentDipRatio = Number.POSITIVE_INFINITY;
    c.tracking.rateFragmentNoRiseRatio = 0;
  },
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

const outDir = arg("out", "training/out/outcome");
mkdirSync(outDir, { recursive: true });

for (const fixture of decodeFixtures({ quiet: true })) {
  if (!TUNING.includes(fixture.stem)) continue;
  const wav = readWav(readFileSync(fixture.wavPath));
  const mono = downmixToMono(wav.samples, wav.channels);
  const labels = fixture.label.events as LabeledEvent[];

  for (const [name, override] of Object.entries(CONFIGS)) {
    const events: TrackerTraceEvent[] = [];
    const analysis = analyzeSamples(mono, wav.sampleRate, {
      trackerTrace: (e) => events.push(e),
      ...(override !== undefined ? { overrideConfig: override } : {}),
    });
    const detections = projectEmissions(analysis.emissions).final;
    const match = matchEvents(labels, detections);
    const pairedWith = new Map(match.matches.map((m) => [m.detection.id, m.label.id]));

    const opened = new Map<string, Extract<TrackerTraceEvent, { kind: "opened" }>>();
    const ended = new Map<string, Extract<TrackerTraceEvent, { kind: "ended" }>>();
    for (const e of events) {
      if (e.kind === "opened") opened.set(e.noteId, e);
      else if (e.kind === "ended") ended.set(e.noteId, e);
    }
    const openings = [...opened.values()].map((e) => e.at).sort((a, b) => a - b);
    const emitted = new Set(detections.map((d) => d.id));

    const rows: unknown[] = [];
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
      const death = ended.get(child.noteId);
      if (death === undefined) continue;
      const previousOpen = opened.get(split.noteId);
      const detection = detections.find((d) => d.id === child.noteId);
      const nextOnset = openings.find((t) => t > child.at + 1);
      rows.push({
        id: child.noteId,
        previousId: split.noteId,
        boundaryAt: split.at,
        startedAt: detection?.startedAt ?? child.at,
        endedAt: detection?.endedAt ?? death.at,
        fragmentMs: death.soundedMs,
        previousOpenAt: previousOpen?.at ?? null,
        nextOnsetAt: nextOnset ?? null,
        reason: split.reason,
        soundedMs: split.soundedMs,
        sharpness: split.sharpness,
        heldSharpness: split.heldSharpness,
        fluxRatio: split.fluxRatio,
        heldFluxRatio: split.heldFluxRatio,
        riseRatio: split.riseRatio,
        dipRatio: split.dipRatio,
        envelopeOverBaseline: split.envelopeOverBaseline,
        levelOverPeak: split.levelOverPeak ?? null,
        kernelOnset: split.kernelOnset,
        decayExcess: split.decayExcess,
        bloomed: split.bloomed,
        localIoiMs: split.localIoiMs ?? null,
        emitted: emitted.has(child.noteId),
        paired: pairedWith.has(child.noteId),
        label: pairedWith.get(child.noteId) ?? null,
      });
    }
    writeFileSync(
      join(outDir, `${fixture.stem}.${name}.json`),
      JSON.stringify({
        stem: fixture.stem,
        config: name,
        wavPath: fixture.wavPath,
        sampleRate: wav.sampleRate,
        labels,
        detections,
        openings,
        missed: match.missed.length,
        falsePositives: match.falsePositives.length,
        rows,
      })
    );
    console.log(
      `${fixture.stem.padEnd(48)} ${name.padEnd(8)} rows ${String(rows.length).padStart(4)}` +
        `  surplus ${rows.filter((r) => !(r as { paired: boolean }).paired).length}` +
        `  missed ${match.missed.length}  fp ${match.falsePositives.length}`
    );
  }
}
