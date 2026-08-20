/**
 * Period-to-period dissimilarity: the one candidate witness that is NOT an
 * energy-increase detector.
 *
 * A freely decaying plucked string is a sum of decaying quasi-harmonic
 * partials with FIXED relative phases, so x[n] ~ a * x[n - T] for the period
 * T, with `a` slightly below 1 and slowly varying. A pluck is a new
 * excitation: it changes the amplitude ratios across partials and resets
 * their relative phases. The invariant that breaks at a re-pick is therefore
 * not energy but the shape-and-phase continuation of the waveform — and that
 * holds whether the new pick is louder, equal, or muted and quieter.
 *
 * Per hop, with T from YIN (the 2048-sample window, taken from the hop BEFORE
 * the decision so the estimate describes the note that was sounding, not the
 * attack) and N ~ 2T:
 *
 *   num = sum x[n] * x[n-T]                    n over the last N samples
 *   den = sqrt( sum x[n]^2 * sum x[n-T]^2 )
 *   r   = num / (den + eps)                    NCC at lag T, in [-1, 1]
 *   D   = 1 - r                                cycle dissimilarity
 *   g   = num / (sum x[n-T]^2 + eps)           best-fit gain, ~ the decay
 *
 * A YIN period error of one sample at high f0 destroys r, so the lag is
 * searched +/-2 samples and the best r kept. `D` is amplitude-invariant by
 * construction — the normalisation divides out the decay and any compressor
 * gain — which is precisely the property all twelve existing witnesses lack.
 *
 * KNOWN WEAKNESSES, measured here rather than discovered late: polyphony
 * breaks the single-period premise (gate on the Note not having bloomed, and
 * on YIN aperiodicity being low); reverberation superimposes a delayed copy
 * of the previous note and lowers baseline r on the room-mic path; vibrato
 * and bends break cycle similarity too (the existing glide flag is a veto).
 *
 * THE FALSIFIER, STATED BEFORE THE RUN: if D-shape does not clear 0.73 AUC —
 * the best existing single witness — on the MONOPHONIC derivation subset
 * under leave-one-take-out (a single witness has nothing to fit, so that is
 * its plain AUC on those rows), the line stops here. The whole argument for
 * this feature is that amplitude-invariance beats the take-scale problem; if
 * that does not show up on the easiest subset, it will not show up anywhere.
 *
 * The engine is unchanged: rows come from the same decision table as
 * `measure-decision-separability.ts` (identical population), witnesses from a
 * standalone pass over the same audio on the same hop grid, joined by hop
 * timestamp.
 *
 * Usage:
 *   npx tsx scripts/measure-cycle-dissimilarity.ts
 *   npx tsx scripts/measure-cycle-dissimilarity.ts --rows    dump joined rows
 */

import { readFileSync } from "node:fs";
import { YinDetector } from "../src/engine/kernels/yin.js";
import { DEFAULT_ENGINE_CONFIG, snapHop } from "../src/engine/config.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";
import {
  collect,
  FEATURES,
  auc,
  isHeldOut,
  type Row,
} from "./measure-decision-separability.js";

const EPS = 1e-12;

/** Columns the pass emits per hop. */
const WITNESSES = [
  /** 1 - best r, window ending at this hop, lag from the previous hop's YIN. */
  "d0",
  /** Same lag, window one hop later — the attack sits mid-window. Deep-lane timing. */
  "d1",
  /** max(d0, d1). */
  "dMax",
  /** Best-fit gain at the chosen lag. */
  "gain",
  /** |ln g|: the gain moved, in either direction. */
  "gainMoved",
  /** dMax * max(0, 1 - g): the muted-repick signature, shape break AND gain drop. */
  "dGdrop",
  /** YIN cmnd at this hop's chosen lag — aperiodicity, scale-free, already computed by the engine. */
  "aper",
  /** The previous hop's aperiodicity: how periodic the note WAS before this landed. */
  "aperPrev",
  /** Median d0 over the five preceding hops: the take's own running baseline. */
  "dBase",
  /** d0 - dBase: deviation from that baseline. */
  "dExcess",
] as const;

type HopReadings = { at: number; valid: boolean; values: Float64Array };

function ncc(
  mono: Float32Array,
  end: number,
  T: number
): { r: number; g: number } | null {
  const N = Math.min(2 * T, 1400);
  const from = end - N;
  if (from - T - 2 < 0 || end > mono.length) return null;
  let best: { r: number; g: number } | null = null;
  for (let lag = T - 2; lag <= T + 2; lag++) {
    if (lag < 2) continue;
    let num = 0;
    let xx = 0;
    let yy = 0;
    for (let n = from; n < end; n++) {
      const a = mono[n] as number;
      const b = mono[n - lag] as number;
      num += a * b;
      xx += a * a;
      yy += b * b;
    }
    if (xx < EPS || yy < EPS) continue;
    const r = num / (Math.sqrt(xx * yy) + EPS);
    if (best === null || r > best.r) best = { r, g: num / (yy + EPS) };
  }
  return best;
}

function cyclePass(mono: Float32Array, sampleRate: number): HopReadings[] {
  const config = DEFAULT_ENGINE_CONFIG;
  const hop = snapHop(config.analysis.hopMs, sampleRate);
  const windowSize = config.pitch.longWindow;
  const yin = new YinDetector({
    sampleRate,
    windowSize,
    minFrequencyHz: config.analysis.minFrequencyHz,
    maxFrequencyHz: config.analysis.maxFrequencyHz,
    threshold: config.pitch.yinThreshold,
  });

  const window = new Float32Array(windowSize);
  const out: HopReadings[] = [];
  let prevTau: number | null = null;
  let prevCmnd: number | null = null;
  const d0History: number[] = [];

  for (let end = windowSize; end + hop <= mono.length; end += hop) {
    window.set(mono.subarray(end - windowSize, end));
    const result = yin.detect(window);
    const at = (end / sampleRate) * 1000;

    const values = new Float64Array(WITNESSES.length);
    let valid = false;
    if (prevTau !== null) {
      const T = Math.round(prevTau);
      const here = ncc(mono, end, T);
      const next = ncc(mono, end + hop, T);
      if (here !== null && next !== null) {
        valid = true;
        const d0 = 1 - here.r;
        const d1 = 1 - next.r;
        const dMax = Math.max(d0, d1);
        const g = here.g;
        let dBase = 0;
        if (d0History.length >= 5) {
          const sorted = [...d0History.slice(-5)].sort((a, b) => a - b);
          dBase = sorted[2] as number;
        }
        values[0] = d0;
        values[1] = d1;
        values[2] = dMax;
        values[3] = g;
        values[4] = Math.abs(Math.log(Math.max(g, 1e-6)));
        values[5] = dMax * Math.max(0, 1 - g);
        values[6] = result.cmnd ?? 1;
        values[7] = prevCmnd ?? 1;
        values[8] = dBase;
        values[9] = d0 - dBase;
        d0History.push(d0);
        if (d0History.length > 8) d0History.shift();
      }
    }
    out.push({ at, valid, values });
    prevTau = result.tau;
    prevCmnd = result.cmnd;
  }
  return out;
}

function main(): void {
  const dumpRows = process.argv.includes("--rows");
  console.log("\n  collecting the decision table (unchanged engine)...");
  const rows = collect();

  console.log("  cycle-dissimilarity pass over every take...");
  const byStem = new Map<string, HopReadings[]>();
  for (const fixture of decodeFixtures({ quiet: true })) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    byStem.set(fixture.stem, cyclePass(mono, wav.sampleRate));
  }

  type Joined = Row & { valid: boolean; w: Float64Array };
  const joined: Joined[] = [];
  for (const row of rows) {
    const hops = byStem.get(row.stem);
    if (hops === undefined) continue;
    let best: HopReadings | null = null;
    for (const h of hops) {
      if (best === null || Math.abs(h.at - row.at) < Math.abs(best.at - row.at)) best = h;
    }
    if (best === null || Math.abs(best.at - row.at) > 6.5) continue;
    joined.push({ ...row, valid: best.valid, w: best.values });
  }

  const bloomedCol = FEATURES.indexOf("bloomed");
  const glidingCol = FEATURES.indexOf("gliding");
  const f3 = (x: number): string => x.toFixed(3);

  const table = (head: readonly string[], body: readonly (readonly string[])[]): void => {
    const all = [head, ...body];
    const width: number[] = [];
    for (const row of all) row.forEach((c, i) => (width[i] = Math.max(width[i] ?? 0, c.length)));
    const line = (row: readonly string[]): string =>
      "  " +
      row.map((c, i) => (i === 0 ? c.padEnd(width[i] as number) : c.padStart(width[i] as number))).join("  ");
    console.log(line(head));
    console.log("  " + width.map((w) => "-".repeat(w)).join("  "));
    for (const row of body) console.log(line(row));
  };

  const report = (name: string, rs: readonly Joined[]): void => {
    const pos = rs.filter((r) => r.y === 1).length;
    console.log(`\n  ${name}: ${rs.length} rows, ${pos} positives`);
    if (pos === 0 || pos === rs.length) {
      console.log("    (degenerate — no AUC)");
      return;
    }
    const y = rs.map((r) => r.y);
    const body = WITNESSES.map((w, i) => {
      const scores = rs.map((r) => r.w[i] as number);
      const a = auc(scores, y);
      return [w as string, f3(a), f3(Math.max(a, 1 - a)), a >= 0.5 ? "high" : "low"];
    });
    // The existing best single witness on the same rows, for the bar.
    const sharpCol = FEATURES.indexOf("sharpness");
    const sharpness = auc(rs.map((r) => r.x[sharpCol] as number), y);
    body.push(["(sharpness, same rows)", f3(sharpness), f3(Math.max(sharpness, 1 - sharpness)), "high"]);
    body.sort((p, q) => Number(q[2]) - Number(p[2]));
    table(["witness", "AUC", "oriented", "dir"], body);
  };

  const derive = joined.filter((r) => !isHeldOut(r.stem));
  const held = joined.filter((r) => isHeldOut(r.stem));

  const mono = (rs: readonly Joined[]): Joined[] =>
    rs.filter((r) => r.valid && r.x[bloomedCol] === 0);
  const gated = (rs: readonly Joined[]): Joined[] =>
    mono(rs).filter((r) => r.x[glidingCol] === 0 && (r.w[7] as number) <= 0.25);

  console.log(
    `\n  ${joined.length} decisions joined; ${joined.filter((r) => r.valid).length} with a usable period`
  );

  console.log("\n  THE FALSIFIER SUBSET — monophonic derivation rows, usable period");
  report("monophonic derivation", mono(derive));

  console.log("\n  tighter gate: also not gliding, and periodic before the attack (aperPrev <= 0.25)");
  report("gated derivation", gated(derive));

  console.log("\n  everything else, read only after the falsifier:");
  report("ALL derivation rows (valid period)", derive.filter((r) => r.valid));
  report("monophonic held-out", mono(held));
  report("gated held-out", gated(held));

  // Per-take view of the leading witness on the monophonic subset: a witness
  // that only separates inside one take is the defect under investigation.
  console.log("\n  per take, monophonic subset, oriented AUC of dMax and sharpness\n");
  const takes = [...new Set(joined.map((r) => r.stem))];
  const perTake: string[][] = [];
  for (const stem of takes) {
    const rs = mono(joined).filter((r) => r.stem === stem);
    const pos = rs.filter((r) => r.y === 1).length;
    if (pos === 0 || pos === rs.length || rs.length < 4) continue;
    const y = rs.map((r) => r.y);
    const dmax = auc(rs.map((r) => r.w[2] as number), y);
    const sharpCol = FEATURES.indexOf("sharpness");
    const sharp = auc(rs.map((r) => r.x[sharpCol] as number), y);
    perTake.push([
      stem,
      String(rs.length),
      String(pos),
      f3(Math.max(dmax, 1 - dmax)),
      f3(Math.max(sharp, 1 - sharp)),
    ]);
  }
  table(["take", "rows", "pos", "dMax AUC", "sharpness AUC"], perTake);

  if (dumpRows) {
    console.log("\n  EVERY MONOPHONIC ROW\n");
    table(
      ["take", "at", "y", "acc", ...WITNESSES],
      mono(joined).map((r) => [
        r.stem,
        r.at.toFixed(0),
        String(r.y),
        r.accepted ? "y" : "n",
        ...Array.from(r.w).map((v) => v.toFixed(3)),
      ])
    );
  }
  console.log("");
}

main();
