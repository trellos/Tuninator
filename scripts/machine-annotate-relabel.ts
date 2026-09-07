/**
 * Annotator M: complete the relabel answer sheet from signal evidence alone.
 *
 * This is the independent machine pass of the label-ceiling measurement. It
 * reads ONLY the anonymised snippets in `.cache/relabel/audio/` — never the
 * manifest, never `fixtures/labels/`, never the recognizer's output — and
 * answers, for each snippet, whether a new note starts in the middle third
 * and where. Its answers are scored against the shipped labels by
 * `score-relabel.ts` exactly like a human annotator's.
 *
 * THE ANNOTATOR (final; the calibration trail is below):
 *
 *  1. Onset strength is positive-rectified spectral flux (FFT 1024, hop 5ms,
 *     Hann) with the previous frame max-filtered ±1 bin — deliberately NOT
 *     the engine's 12ms/23ms grid, so this pass measures the signal at its
 *     own timescale rather than echoing the recognizer.
 *  2. A candidate is a local flux maximum (±30ms) above an adaptive bar:
 *     1.5x the median flux over the surrounding ±150ms, plus 1% of the
 *     snippet's own 95th-percentile flux. Candidates closer than 50ms keep
 *     only the stronger. Any candidate in the middle third -> `yes` with its
 *     offset; a near-miss (>= 0.6x the bar) -> `unsure`; otherwise `no`.
 *  3. Each offset is TAGGED with its corroboration, carried in the notes
 *     column as `tags:` (same order as the offsets): `s` (strong) when the
 *     broadband 5ms RMS envelope rose >= 1.1x across the moment, or the
 *     2-8kHz fine envelope (`kernels/click.ts`, 1ms resolution) shows a
 *     compact click — peak within ±15ms at >= 2.5x the median of the
 *     surrounding 8-45ms ring, which also refines the offset to the spike —
 *     or flux prominence >= 8; `w` (weak) otherwise. The scorer reports the
 *     liberal reading (all offsets) as the primary numbers and the strict
 *     reading (strong offsets only) as a secondary bound.
 *
 * CALIBRATION, done before any contested number was read, on sanctioned
 * evidence only (the kit's CONTROL points and label-free pick density):
 *  - The first cut (flux bar exactly as above) passed the control bar — 96%
 *    at 50ms, 100% at 70ms — but marked 4-20x as many onsets on full takes
 *    as the take has played strokes, so a hard precision gate was tried.
 *  - Requiring energy arrival (broadband rise >= 1.25x, or a >= 4x click)
 *    dropped the control agreement to 71%: measured at the control strokes
 *    themselves, a quarter of CLEAR strokes neither lift the envelope 1.1x
 *    nor leave a 2.5x click (envelope-rise p5 = 0.80, click-ratio p5 = 1.45,
 *    flux-prominence p5 = 2.35). No corroboration gate keeps 95% of clear
 *    strokes on this material — the same recall/precision wall the engine's
 *    own witnesses hit, measured from the other side.
 *  - Hence the graded design above: the liberal reading satisfies the
 *    pre-stated control bar; the strict reading (which does NOT meet that
 *    bar, holding ~83% of controls) bounds how much of the liberal
 *    reading's "unlabelled onset" claims survive corroboration.
 *
 * Usage:
 *   npx tsx scripts/machine-annotate-relabel.ts
 *     -> .cache/relabel/answers-machine.csv
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RealFFT, hannWindow } from "../src/engine/kernels/fft.js";
import { clickBandEnvelope } from "../src/engine/kernels/click.js";
import { readWav, downmixToMono } from "../src/offline/wav.js";
import { CACHE_DIR } from "./decode-fixtures.js";

const KIT_DIR = join(CACHE_DIR, "relabel");
const AUDIO_DIR = join(KIT_DIR, "audio");

const FFT_SIZE = 1024;
const HOP_MS = 5;
const LAMBDA = 1.5;
const DELTA_OF_P95 = 0.01;
const GRAY_ZONE = 0.6;
const MEDIAN_HALF_MS = 150;
const PEAK_HALF_MS = 30;
const MIN_SEPARATION_MS = 50;
const CLICK_RATIO = 2.5;
const CLICK_SEARCH_MS = 15;
const RING_IN_MS = 8;
const RING_OUT_MS = 45;
/** Strong-corroboration tags: broadband rise, click, or overwhelming flux. */
const ENV_RMS_MS = 5;
const ENV_NEAR_MS = 10;
const ENV_FAR_MS = 40;
const ENV_RISE = 1.1;
const STRONG_PROMINENCE = 8;

type Verdict = { answer: "yes" | "no" | "unsure"; offsetsMs: number[]; tags: string[] };

function fluxCurve(mono: Float32Array, sampleRate: number): { at: number[]; flux: number[] } {
  const hop = Math.round((HOP_MS / 1000) * sampleRate);
  const fft = new RealFFT(FFT_SIZE);
  const hann = hannWindow(FFT_SIZE);
  const windowed = new Float32Array(FFT_SIZE);
  const magnitude = new Float32Array(fft.bins);
  const previous = new Float32Array(fft.bins);
  const at: number[] = [];
  const flux: number[] = [];
  let first = true;
  for (let start = 0; start + FFT_SIZE <= mono.length; start += hop) {
    for (let i = 0; i < FFT_SIZE; i++) {
      windowed[i] = (mono[start + i] as number) * (hann[i] as number);
    }
    fft.magnitudes(windowed, magnitude);
    let sum = 0;
    if (!first) {
      for (let k = 0; k < fft.bins; k++) {
        // Reference is the max over the previous frame's k-1..k+1 — the
        // one-bin frequency tolerance that keeps vibrato and beating partials
        // from reading as arrivals.
        let ref = previous[k] as number;
        if (k > 0) ref = Math.max(ref, previous[k - 1] as number);
        if (k + 1 < fft.bins) ref = Math.max(ref, previous[k + 1] as number);
        const d = (magnitude[k] as number) - ref;
        if (d > 0) sum += d;
      }
    }
    previous.set(magnitude);
    first = false;
    // Attribute the flux to the centre of the analysis window.
    at.push(((start + FFT_SIZE / 2) / sampleRate) * 1000);
    flux.push(sum);
  }
  return { at, flux };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
}

/** Broadband RMS envelope at 1ms resolution: square, boxcar, sqrt. */
function rmsEnvelope(mono: Float32Array, sampleRate: number): Float32Array {
  const window = Math.max(1, Math.round((ENV_RMS_MS / 1000) * sampleRate));
  const out = new Float32Array(mono.length);
  let sum = 0;
  for (let i = 0; i < mono.length; i++) {
    const v = mono[i] as number;
    sum += v * v;
    if (i >= window) {
      const old = mono[i - window] as number;
      sum -= old * old;
    }
    out[i] = Math.sqrt(Math.max(0, sum) / Math.min(i + 1, window));
  }
  return out;
}

export function annotateSnippet(mono: Float32Array, sampleRate: number): Verdict {
  const snippetMs = (mono.length / sampleRate) * 1000;
  const windowLo = snippetMs / 3;
  const windowHi = (2 * snippetMs) / 3;

  const { at, flux } = fluxCurve(mono, sampleRate);
  const fine = clickBandEnvelope(mono, sampleRate);
  const broadband = rmsEnvelope(mono, sampleRate);
  const delta = DELTA_OF_P95 * percentile(flux, 0.95);

  const medianHalf = Math.round(MEDIAN_HALF_MS / HOP_MS);
  const peakHalf = Math.round(PEAK_HALF_MS / HOP_MS);

  const envMean = (fromMs: number, toMs: number): number => {
    const from = Math.max(0, Math.round((fromMs / 1000) * sampleRate));
    const to = Math.min(broadband.length, Math.round((toMs / 1000) * sampleRate));
    if (to <= from) return 0;
    let sum = 0;
    for (let i = from; i < to; i++) sum += broadband[i] as number;
    return sum / (to - from);
  };

  const clickAt = (timeMs: number): { strong: boolean; peakMs: number } => {
    const centre = Math.round((timeMs / 1000) * sampleRate);
    const search = Math.round((CLICK_SEARCH_MS / 1000) * sampleRate);
    let peak = 0;
    let peakIndex = centre;
    for (let i = Math.max(0, centre - search); i < Math.min(fine.length, centre + search); i++) {
      if ((fine[i] as number) > peak) {
        peak = fine[i] as number;
        peakIndex = i;
      }
    }
    const ringIn = Math.round((RING_IN_MS / 1000) * sampleRate);
    const ringOut = Math.round((RING_OUT_MS / 1000) * sampleRate);
    const ring: number[] = [];
    for (let i = Math.max(0, peakIndex - ringOut); i < peakIndex - ringIn; i++) {
      ring.push(fine[i] as number);
    }
    for (let i = peakIndex + ringIn; i < Math.min(fine.length, peakIndex + ringOut); i++) {
      ring.push(fine[i] as number);
    }
    const floor = Math.max(median(ring), 1e-7);
    return { strong: peak / floor >= CLICK_RATIO, peakMs: (peakIndex / sampleRate) * 1000 };
  };

  type Pick = { atMs: number; strength: number; bar: number; strong: boolean };
  const picks: Pick[] = [];
  for (let n = 1; n < flux.length; n++) {
    const t = at[n] as number;
    if (t < windowLo - PEAK_HALF_MS || t > windowHi + PEAK_HALF_MS) continue;
    let isPeak = true;
    for (let k = Math.max(0, n - peakHalf); k <= Math.min(flux.length - 1, n + peakHalf); k++) {
      if ((flux[k] as number) > (flux[n] as number)) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;
    const around: number[] = [];
    for (let k = Math.max(0, n - medianHalf); k <= Math.min(flux.length - 1, n + medianHalf); k++) {
      around.push(flux[k] as number);
    }
    const localMedian = median(around);
    const bar = LAMBDA * localMedian + delta;
    const strength = flux[n] as number;
    if (strength < GRAY_ZONE * bar) continue;

    // Corroboration tag. A churn peak moves energy around without adding
    // any; a stroke usually lifts the broadband envelope, leaves a compact
    // 2-8kHz click, or towers over the local flux.
    const click = clickAt(t);
    const clickTime = click.strong ? click.peakMs : t;
    const before = envMean(clickTime - ENV_FAR_MS, clickTime - ENV_NEAR_MS);
    const after = envMean(clickTime + ENV_NEAR_MS, clickTime + ENV_FAR_MS);
    const rose = before > 0 ? after / before >= ENV_RISE : after > 0;
    const prominent = strength / Math.max(localMedian, 1e-9) >= STRONG_PROMINENCE;
    picks.push({
      atMs: clickTime,
      strength: strength / bar,
      bar,
      strong: rose || click.strong || prominent,
    });
  }

  // Closer than the separation, keep the stronger.
  picks.sort((a, b) => b.strength - a.strength);
  const kept: Pick[] = [];
  for (const pick of picks) {
    if (kept.some((k) => Math.abs(k.atMs - pick.atMs) < MIN_SEPARATION_MS)) continue;
    kept.push(pick);
  }
  kept.sort((a, b) => a.atMs - b.atMs);

  const inWindow = kept.filter((p) => p.atMs >= windowLo && p.atMs <= windowHi);
  const accepted = inWindow.filter((p) => p.strength >= 1);
  if (accepted.length > 0) {
    return {
      answer: "yes",
      offsetsMs: accepted.map((p) => Math.round(p.atMs)),
      tags: accepted.map((p) => (p.strong ? "s" : "w")),
    };
  }
  if (inWindow.length > 0) {
    return {
      answer: "unsure",
      offsetsMs: inWindow.map((p) => Math.round(p.atMs)),
      tags: inWindow.map((p) => (p.strong ? "s" : "w")),
    };
  }
  return { answer: "no", offsetsMs: [], tags: [] };
}

function main(): void {
  const files = readdirSync(AUDIO_DIR)
    .filter((f) => f.endsWith(".wav"))
    .sort();
  const lines = ["id,new_note_middle_third,onset_offset_ms,notes"];
  const tally = { yes: 0, no: 0, unsure: 0 };
  for (const file of files) {
    const wav = readWav(readFileSync(join(AUDIO_DIR, file)));
    const mono = downmixToMono(wav.samples, wav.channels);
    const verdict = annotateSnippet(mono, wav.sampleRate);
    tally[verdict.answer]++;
    lines.push(
      `${file.replace(/\.wav$/, "")},${verdict.answer},${verdict.offsetsMs.join(";")},` +
        (verdict.tags.length > 0 ? `tags:${verdict.tags.join(";")}` : "")
    );
  }
  writeFileSync(join(KIT_DIR, "answers-machine.csv"), `${lines.join("\n")}\n`);
  console.log(
    `  ${files.length} snippets annotated: ${tally.yes} yes, ${tally.no} no, ${tally.unsure} unsure`
  );
  console.log(`  -> ${join(KIT_DIR, "answers-machine.csv")}`);
}

main();
