/**
 * Door 3's external population: the same OUTCOME-shaped rows as
 * `extract-outcome-rows.ts`, from GuitarSet run through the signal-path
 * chains in `augment.ts`.
 *
 * GuitarSet's note annotations become labels in this repository's shape:
 * notes starting within `mergeMs` of each other are one event (a strum is one
 * labelled chord in `fixtures/labels/**`), named by its pitch when it is one
 * note and `unknown` when it is several. The matcher's eligibility rule is
 * pitch-agnostic, so the name only breaks ties. The engine runs with the rate
 * gate OFF, the population the corpus bench's first clause reads.
 *
 * Output per take x flavour x chain: `<take>-<flavour>-<chain>.off.json` in
 * the corpus extractor's format (the `stem` carries the player as its first
 * two characters), plus the chained audio as a WAV when the chain is not
 * `clean`, so `bench-outcome.py` computes its audio features from exactly
 * what the engine heard.
 *
 *   npx tsx training/extract-guitarset-outcome.ts --data <root> --out <dir> \
 *       [--flavors mic,pickup] [--chains clean,amp,room] [--limit N] [--shard i/n]
 *
 * `<root>` holds `annotation/*.jams` and `wav48/{mic,pickup}` (training/README.md).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { matchEvents, type LabeledEvent } from "../src/offline/matcher.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";
import type { EngineConfig } from "../src/engine/config.js";
import { downmixToMono, readWav, writeWav } from "../src/offline/wav.js";
import { applyChain, CHAINS, type Chain } from "./augment.js";
import { listTakes, type GuitarSetTake } from "./guitarset.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function noteName(midi: number): string {
  const m = Math.round(midi);
  return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/** GuitarSet notes as this repository's labels. See the header. */
export function loadLabels(take: GuitarSetTake, mergeMs = 30): LabeledEvent[] {
  const jams = JSON.parse(readFileSync(take.jamsPath, "utf8")) as {
    annotations: Array<{
      namespace: string;
      data: Array<{ time: number; duration: number; value: number }>;
    }>;
  };
  const notes: Array<{ start: number; end: number; midi: number }> = [];
  for (const a of jams.annotations) {
    if (a.namespace !== "note_midi") continue;
    for (const n of a.data) {
      notes.push({ start: n.time * 1000, end: (n.time + n.duration) * 1000, midi: n.value });
    }
  }
  notes.sort((a, b) => a.start - b.start);
  const groups: Array<typeof notes> = [];
  for (const n of notes) {
    const last = groups[groups.length - 1];
    if (last !== undefined && n.start - (last[0] as (typeof notes)[number]).start < mergeMs) last.push(n);
    else groups.push([n]);
  }
  return groups.map((g, i) => {
    const pitches = [...new Set(g.map((n) => noteName(n.midi)))];
    const one = pitches.length === 1;
    return {
      id: `g${i}`,
      startMs: (g[0] as (typeof notes)[number]).start,
      endMs: Math.max(...g.map((n) => n.end)),
      kind: one ? "note" : "unknown",
      label: one ? (pitches[0] as string) : "?",
      pitches,
    };
  });
}

const dataRoot = arg("data", "/home/user/datasets/guitarset");
const outDir = arg("out", "training/out/guitarset-outcome");
const flavors = arg("flavors", "mic,pickup").split(",");
const chains = arg("chains", "clean,amp,room").split(",") as Chain[];
const limit = Number(arg("limit", "0"));
const [shardIndex, shardCount] = arg("shard", "0/1").split("/").map(Number) as [number, number];
for (const chain of chains) {
  if (!(CHAINS as readonly string[]).includes(chain)) throw new Error(`unknown chain ${chain}`);
}

const off = (c: EngineConfig): void => {
  c.tracking.rateFragmentDipRatio = Number.POSITIVE_INFINITY;
  c.tracking.rateFragmentNoRiseRatio = 0;
};

const takes = listTakes(join(dataRoot, "annotation"));
const selected = (limit > 0 ? takes.slice(0, limit) : takes).filter((_, i) => i % shardCount === shardIndex);
mkdirSync(join(outDir, "audio"), { recursive: true });
const started = Date.now();
let totalRows = 0;
let totalSurplus = 0;

for (const take of selected) {
  const labels = loadLabels(take);
  for (const flavor of flavors) {
    const source = join(dataRoot, "wav48", flavor, `${take.name}.wav`);
    if (!existsSync(source)) {
      console.log(`missing ${source}`);
      continue;
    }
    const wav = readWav(readFileSync(source));
    const mono = downmixToMono(wav.samples, wav.channels);
    for (const chain of chains) {
      const stem = `${take.name}-${flavor}-${chain}`;
      const target = join(outDir, `${stem}.off.json`);
      if (existsSync(target)) continue;
      const audio = applyChain(mono, wav.sampleRate, take.name, chain);
      let wavPath = source;
      if (chain !== "clean") {
        wavPath = join(outDir, "audio", `${stem}.wav`);
        writeFileSync(wavPath, writeWav(audio, wav.sampleRate));
      }
      const events: TrackerTraceEvent[] = [];
      const analysis = analyzeSamples(audio, wav.sampleRate, {
        trackerTrace: (e) => events.push(e),
        overrideConfig: off,
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
        const detection = detections.find((d) => d.id === child.noteId);
        rows.push({
          id: child.noteId,
          previousId: split.noteId,
          boundaryAt: split.at,
          startedAt: detection?.startedAt ?? child.at,
          endedAt: detection?.endedAt ?? death.at,
          fragmentMs: death.soundedMs,
          previousOpenAt: opened.get(split.noteId)?.at ?? null,
          nextOnsetAt: openings.find((t) => t > child.at + 1) ?? null,
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
        target,
        JSON.stringify({
          stem,
          config: "off",
          player: take.player,
          flavor,
          chain,
          wavPath,
          sampleRate: wav.sampleRate,
          labels: labels.length,
          missed: match.missed.length,
          falsePositives: match.falsePositives.length,
          openings,
          rows,
        })
      );
      totalRows += rows.length;
      totalSurplus += rows.filter((r) => !(r as { paired: boolean }).paired).length;
    }
  }
  console.log(
    `${take.name}: rows so far ${totalRows}, surplus ${totalSurplus}, ` +
      `${((Date.now() - started) / 1000).toFixed(0)}s`
  );
}
