/**
 * Feature extraction shared by every dataset this pipeline touches.
 *
 * Three pieces, all deliberately re-using the engine's own code and constants
 * so that what the model is trained on is what the engine can compute live:
 *
 *  1. `collectPatches` — a standalone pass over the audio on the ENGINE'S OWN
 *     hop grid: windows of `fluxFftSize` ENDING at multiples of the snapped
 *     hop, zero-padded on the left exactly as the fast lane's fresh ring pads
 *     them (`readEndingAt`), timestamped by window end. A decision's `at` IS
 *     a point on this grid, so the join is exact rather than
 *     nearest-within-half-a-hop — and the magnitudes feeding
 *     `WhitenedBandExtractor` (the same `src/engine/kernels/` class the
 *     shipped inference path uses) are the ones the engine itself computes at
 *     that decision, so there is no train/serve skew to test away later.
 *     (The whitening study's grid — windows STARTING at hop multiples — sits
 *     5.33ms off the engine's at 48kHz; trained on that, the shipped model
 *     would run on inputs consistently 256 samples newer than it ever saw.)
 *
 *  2. `decisionRows` — the target rule, ported line for line from
 *     `scripts/measure-decision-separability.ts` `collect()`: every
 *     `rearticulation` trace event is one row; positive iff a label starts
 *     within 70ms and no Note already opened (in TRACE order — see the
 *     original's comment on split backdating) sits within 70ms of that
 *     label.
 *
 *  3. `RowWriter` / `readRowFile` — one `.meta.jsonl` + one `.x.f32` pair per
 *     shard. A row's x is [patch (PATCH_HOPS x BAND_COUNT)] then [12
 *     witnesses in `FEATURES` order] then [4 whitened flux readings], so the
 *     training loop never re-derives layout from names.
 */

import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { DEFAULT_ENGINE_CONFIG, snapHop } from "../src/engine/config.js";
import {
  BAND_COUNT,
  PATCH_HOPS,
  WhitenedBandPipeline,
} from "../src/engine/kernels/whitened-bands.js";
import type { TrackerTraceEvent } from "../src/engine/tracker/note-tracker.js";

export const WINDOW_MS = 70;
export const PATCH_SIZE = PATCH_HOPS * BAND_COUNT;
export const WITNESS_COUNT = 12;
export const WFLUX_COUNT = 4;
export const ROW_FLOATS = PATCH_SIZE + WITNESS_COUNT + WFLUX_COUNT;

/** Same order as `scripts/measure-decision-separability.ts` FEATURES. */
export const WITNESS_NAMES = [
  "sharpness",
  "heldSharpness",
  "fluxRatio",
  "heldFluxRatio",
  "riseRatio",
  "envelopeOverBaseline",
  "decayExcess",
  "soundedMs",
  "pitchDiffers",
  "gliding",
  "kernelOnset",
  "bloomed",
] as const;

export type RowMeta = {
  take: string;
  /** Grouping unit for splits: GuitarSet player, or the fixture stem. */
  group: string;
  flavor: string;
  chain: string;
  at: number;
  y: 0 | 1;
  accepted: boolean;
  reason: string;
  settled: boolean;
};

export type PatchAt = { at: number; patch: Float32Array; wflux: Float32Array };

/**
 * Run the standalone whitened pass and return patch + flux snapshots for the
 * requested timestamps. `wanted` need not be sorted. Returns a map keyed by
 * the wanted timestamp's index; a timestamp with no hop within half a hop is
 * absent from the map (the caller drops that row and counts it).
 */
export function collectPatches(
  mono: Float32Array,
  sampleRate: number,
  wanted: readonly number[]
): Map<number, PatchAt> {
  const config = DEFAULT_ENGINE_CONFIG;
  const fftSize = config.transient.fluxFftSize;
  const hop = snapHop(config.analysis.hopMs, sampleRate);
  const hopMs = (hop / sampleRate) * 1000;
  const referenceFrames = Math.max(1, Math.round(config.transient.fluxReferenceMs / hopMs));

  // The engine's grid: window i ends at endSample = i * hop, i >= 1, and its
  // timestamp is toMs(endSample). Which hop is each wanted timestamp?
  const byHop = new Map<number, number[]>();
  wanted.forEach((t, wi) => {
    const i = Math.round(((t / 1000) * sampleRate) / hop);
    const at = ((i * hop) / sampleRate) * 1000;
    if (i < 1 || Math.abs(at - t) > hopMs / 2 + 0.5) return;
    const list = byHop.get(i);
    if (list === undefined) byHop.set(i, [wi]);
    else list.push(wi);
  });

  const pipeline = new WhitenedBandPipeline(sampleRate, fftSize, referenceFrames);
  const window = new Float32Array(fftSize);
  const out = new Map<number, PatchAt>();

  for (let hopIndex = 1; hopIndex * hop <= mono.length; hopIndex++) {
    const end = hopIndex * hop;
    const start = end - fftSize;
    for (let i = 0; i < fftSize; i++) {
      const s = start + i;
      window[i] = s >= 0 ? (mono[s] as number) : 0;
    }
    pipeline.push(window);

    const wis = byHop.get(hopIndex);
    if (wis === undefined) continue;
    const at = (end / sampleRate) * 1000;
    const patch = pipeline.patch(new Float32Array(PATCH_SIZE));
    const flux = pipeline.whitenedFlux();
    const wflux = Float32Array.of(flux.wFlux, flux.wFluxNorm, flux.wHeldFlux, flux.wHeldNorm);
    for (const wi of wis) out.set(wi, { at, patch, wflux });
  }
  return out;
}

export type DecisionRow = {
  at: number;
  y: 0 | 1;
  accepted: boolean;
  reason: string;
  settled: boolean;
  witnesses: Float32Array;
};

/** The target rule. See the header; the trace-order accumulation is the point. */
export function decisionRows(
  events: readonly TrackerTraceEvent[],
  labels: readonly { startMs: number }[]
): DecisionRow[] {
  const rows: DecisionRow[] = [];
  const openedSoFar: number[] = [];
  for (const event of events) {
    if (event.kind === "opened") {
      openedSoFar.push(event.at);
      continue;
    }
    if (event.kind !== "rearticulation") continue;
    const t = event.at;

    let near: { startMs: number } | null = null;
    for (const label of labels) {
      const d = Math.abs(label.startMs - t);
      if (d > WINDOW_MS) continue;
      if (near === null || d < Math.abs(near.startMs - t)) near = label;
    }
    let covered = false;
    if (near !== null) {
      for (const at of openedSoFar) {
        if (Math.abs(at - near.startMs) <= WINDOW_MS) {
          covered = true;
          break;
        }
      }
    }
    rows.push({
      at: t,
      y: near !== null && !covered ? 1 : 0,
      accepted: event.accepted,
      reason: event.reason,
      settled: event.settled,
      witnesses: Float32Array.of(
        event.sharpness,
        event.heldSharpness,
        event.fluxRatio,
        event.heldFluxRatio,
        event.riseRatio,
        event.envelopeOverBaseline,
        event.decayExcess ?? 0,
        event.soundedMs,
        event.pitchDiffers ? 1 : 0,
        event.gliding ? 1 : 0,
        event.kernelOnset ? 1 : 0,
        event.bloomed ? 1 : 0
      ),
    });
  }
  return rows;
}

/* ---- Shard IO ------------------------------------------------------------ */

export class RowWriter {
  private readonly metaFd: number;
  private readonly xFd: number;
  count = 0;

  constructor(basePath: string) {
    this.metaFd = openSync(`${basePath}.meta.jsonl`, "w");
    this.xFd = openSync(`${basePath}.x.f32`, "w");
  }

  write(meta: RowMeta, patch: Float32Array, witnesses: Float32Array, wflux: Float32Array): void {
    if (patch.length !== PATCH_SIZE || witnesses.length !== WITNESS_COUNT || wflux.length !== WFLUX_COUNT) {
      throw new Error("row shape mismatch");
    }
    writeSync(this.metaFd, JSON.stringify(meta) + "\n");
    const x = new Float32Array(ROW_FLOATS);
    x.set(patch, 0);
    x.set(witnesses, PATCH_SIZE);
    x.set(wflux, PATCH_SIZE + WITNESS_COUNT);
    writeSync(this.xFd, new Uint8Array(x.buffer, 0, x.byteLength));
    this.count++;
  }

  close(): void {
    closeSync(this.metaFd);
    closeSync(this.xFd);
  }
}

export type RowFile = { meta: RowMeta[]; x: Float32Array };

export function readRowFile(basePath: string): RowFile {
  const meta = readFileSync(`${basePath}.meta.jsonl`, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RowMeta);
  const bytes = readFileSync(`${basePath}.x.f32`);
  const x = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (x.length !== meta.length * ROW_FLOATS) {
    throw new Error(`${basePath}: ${meta.length} meta rows but ${x.length / ROW_FLOATS} x rows`);
  }
  return { meta, x };
}
