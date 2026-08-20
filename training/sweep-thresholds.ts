/**
 * Derives the learned witness's decision thresholds on the FIVE 120bpm
 * derivation takes only — the same discipline every other bar in
 * `config.transient` was derived under. Nothing here reads a 140bpm take:
 * the fixture list is filtered before any audio is decoded.
 *
 * For each (accept, veto) candidate the real engine runs end to end over the
 * five takes and the two project axes are counted exactly as the standing
 * scripts count them: missed labels via the eval matcher
 * (`measure-downstream-ledger.ts`'s rule), split events and extra Notes via
 * the ownership rule of `measure-splits.ts` (40ms onset tolerance, 400ms
 * orphan gap). The bar for wiring anything: strictly better on one axis, no
 * worse on the other, against the derivation baseline printed in the first
 * row (both thresholds off).
 *
 * Usage:  bun training/sweep-thresholds.ts [--accepts 0.5,0.6,...] [--vetoes off,0.1,...]
 */

import { readFileSync } from "node:fs";
import { RecognitionEngine } from "../src/engine/engine.js";
import { DEFAULT_ENGINE_CONFIG, RENDER_QUANTUM } from "../src/engine/config.js";
import type { TrackerEmission } from "../src/engine/tracker/note-tracker.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { matchEvents, type LabeledEvent } from "../src/offline/matcher.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "../scripts/decode-fixtures.js";

const ONSET_TOLERANCE_MS = 40;
const ORPHAN_GAP_MS = 400;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] as string) : fallback;
}

const parseList = (s: string): Array<number | null> =>
  s.split(",").map((v) => (v === "off" ? null : Number(v)));

const accepts = parseList(arg("accepts", "off,0.5,0.6,0.7,0.8,0.9"));
const vetoes = parseList(arg("vetoes", "off,0.05,0.1,0.15,0.2"));

const fixtures = decodeFixtures({ quiet: true }).filter((f) => !f.stem.includes("140bpm"));
if (fixtures.length !== 5) {
  throw new Error(`expected the five derivation takes, found ${fixtures.length}`);
}
const audio = fixtures.map((fixture) => {
  const wav = readWav(readFileSync(fixture.wavPath));
  return {
    fixture,
    mono: downmixToMono(wav.samples, wav.channels),
    sampleRate: wav.sampleRate,
  };
});

type Counts = { missed: number; split: number; extras: number; strays: number; notes: number };

function evaluate(accept: number | null, veto: number | null): Counts {
  const totals: Counts = { missed: 0, split: 0, extras: 0, strays: 0, notes: 0 };
  for (const { fixture, mono, sampleRate } of audio) {
    const config = structuredClone(DEFAULT_ENGINE_CONFIG);
    config.transient.learnedAcceptThreshold = accept;
    config.transient.learnedVetoThreshold = veto;
    const engine = new RecognitionEngine(sampleRate, config);
    const emissions: TrackerEmission[] = [];
    const block = new Float32Array(RENDER_QUANTUM);
    for (let offset = 0; offset < mono.length; offset += RENDER_QUANTUM) {
      const available = Math.min(RENDER_QUANTUM, mono.length - offset);
      if (available === RENDER_QUANTUM) block.set(mono.subarray(offset, offset + RENDER_QUANTUM));
      else {
        block.fill(0);
        block.set(mono.subarray(offset, offset + available));
      }
      emissions.push(...engine.processChunk(block, offset).emissions);
    }
    emissions.push(...engine.flush().emissions);
    const detections = projectEmissions(emissions).final;
    totals.notes += detections.length;

    const labels = fixture.label.events as LabeledEvent[];
    const matched = new Set(matchEvents(labels, detections).matches.map((m) => m.label.id));
    totals.missed += labels.filter((l) => !matched.has(l.id)).length;

    const rows = labels
      .map((l) => ({ startMs: l.startMs, endMs: l.endMs, notes: 0 }))
      .sort((a, b) => a.startMs - b.startMs);
    for (const detection of detections) {
      let owner: (typeof rows)[number] | null = null;
      for (const candidate of rows) {
        if (detection.startedAt + ONSET_TOLERANCE_MS < candidate.startMs) break;
        owner = candidate;
      }
      if (owner === null || detection.startedAt > owner.endMs + ORPHAN_GAP_MS) {
        totals.strays++;
        continue;
      }
      owner.notes++;
    }
    for (const row of rows) {
      if (row.notes > 1) {
        totals.split++;
        totals.extras += row.notes - 1;
      }
    }
  }
  return totals;
}

const fmt = (v: number | null): string => (v === null ? "  off" : v.toFixed(2));
console.log("derivation-five sweep (missed | split | extras | strays | notes)\n");
console.log("  accept   veto   missed  split  extras  strays  notes");
const results: Array<{ accept: number | null; veto: number | null; c: Counts }> = [];
for (const accept of accepts) {
  for (const veto of vetoes) {
    const c = evaluate(accept, veto);
    results.push({ accept, veto, c });
    console.log(
      `    ${fmt(accept)}   ${fmt(veto)}   ${String(c.missed).padStart(5)}  ${String(c.split).padStart(5)}  ` +
        `${String(c.extras).padStart(6)}  ${String(c.strays).padStart(6)}  ${String(c.notes).padStart(5)}`
    );
  }
}

const base = results.find((r) => r.accept === null && r.veto === null);
if (base !== undefined) {
  const dominating = results.filter(
    (r) =>
      (r.c.missed < base.c.missed && r.c.extras <= base.c.extras) ||
      (r.c.extras < base.c.extras && r.c.missed <= base.c.missed)
  );
  console.log(
    `\n  baseline (off/off): ${base.c.missed} missed, ${base.c.extras} extras.` +
      ` ${dominating.length} candidate(s) dominate on the derivation five.`
  );
  for (const r of dominating) {
    console.log(
      `    accept ${fmt(r.accept)} veto ${fmt(r.veto)}: ${r.c.missed} missed, ${r.c.split} split, ${r.c.extras} extras, ${r.c.strays} strays`
    );
  }
}
