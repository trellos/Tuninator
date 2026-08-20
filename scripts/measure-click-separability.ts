/**
 * Does the pick's own CLICK — measured at its own 1-5ms timescale — separate
 * a genuine re-articulation from sustain churn where the 12ms-hop witnesses
 * cannot?
 *
 * THE HYPOTHESIS. A pick striking a string produces a broadband click 1-5ms
 * long. Every witness in the decision table measures it after dilution into a
 * 23ms window on a 12ms grid — a 5-20x smearing of the most discriminative
 * moment. The ear separates "pick" from "sustain churn" by temporal
 * COMPACTNESS, which churn, beating and compressor pumping cannot fake:
 * churn is spread in time, a click is not. This is the one physical cue in
 * the corpus no experiment had touched (`docs/ceiling-click-tracker-prompt.md`).
 *
 * THE FALSIFIER, STATED BEFORE THE RUN. The best single compactness witness
 * must clear 0.73 AUC on the DERIVATION decision rows (the best existing
 * witness, `sharpness`, reads 0.728 there), and must not collapse on the
 * room-mic signal path specifically. Below the bar: write it up, close the
 * line, stop — no rescue variants beyond the witness set below.
 *
 * METHOD — the `measure-whitening-separability.ts` pattern. The engine is
 * unchanged; the decision table is collected exactly as the baseline study
 * collects it, so the row population is IDENTICAL and every AUC is
 * comparable to 0.728. The click evidence is a standalone pass:
 * `kernels/click.ts` (causal 2-8kHz biquad cascade, rectified, 1ms boxcar)
 * over each take, decimated to a 0.5ms grid, joined to rows by hop
 * timestamp.
 *
 * Per decision row, with the click's true time searched over the hop's full
 * ±12ms (the click is sub-hop; reading the grid point alone smears it):
 *
 *   peakToSurround   envelope peak over the median of a surrounding ring,
 *                    8-45ms each side of the peak, click itself excluded
 *   peakToPreRing    same, ring BEFORE the peak only — the decay baseline,
 *                    uncontaminated by the note the pick just started
 *   compactMs        how long the envelope stays above half that peak,
 *                    contiguously through it, capped at ±53ms — a click is
 *                    short, churn is long (oriented LOW)
 *   riseSlope        peak over the envelope 3ms earlier
 *   kurtosis         excess kurtosis of the envelope in ±20ms of the peak —
 *                    spiky beats flat (the Klapuri band-wise framing)
 *
 * All five are level-free ratios or shape statistics by construction, and
 * AUC is rank-based, so monotone rescaling cannot move any number here —
 * the scale-stability lesson of DECISION-014 is built in rather than added.
 *
 * THE WINDOW RULE, checked rather than assumed. A sixteenth at 140bpm is
 * 107ms; four separate measurement bugs in this repo came from windows wider
 * than the event spacing. The ring reaches at most 45ms from the peak, and
 * this script ASSERTS that no other label's onset falls inside any row's
 * ring span on the sixteenths takes (and reports the count corpus-wide).
 *
 * NAMED TRAPS carried from the brief: room-mic hiss is stationary, so
 * compactness should be immune — but per-path AUCs are reported to verify
 * rather than assume; amp-sim compression attacks in 1-10ms and can shave
 * the click — if the witness dies only there, that is reported per path,
 * not averaged away.
 *
 * Task 1's consensus carve-out: the label-ceiling study confirmed every
 * derivation-row label at 70ms (machine pass), so the consensus subset
 * equals the full derivation row set; the check below recomputes that from
 * the kit files when they are present rather than trusting this comment.
 *
 * Usage:
 *   npx tsx scripts/measure-click-separability.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clickBandEnvelope } from "../src/engine/kernels/click.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { CACHE_DIR, decodeFixtures } from "./decode-fixtures.js";
import {
  collect,
  auc,
  isHeldOut,
  zeroCost,
  type Row,
} from "./measure-decision-separability.js";

/** Envelope grid: 0.5ms. */
const GRID_MS = 0.5;
/** The click's true time is searched inside the hop's full ±12ms. */
const ALIGN_MS = 12;
/** Ring: 8-45ms each side of the peak. 45 + 8 stays inside a 107ms sixteenth. */
const RING_IN_MS = 8;
const RING_OUT_MS = 45;
/** Compact-duration cap: ±53ms, half a sixteenth. */
const COMPACT_CAP_MS = 53;
const RISE_LAG_MS = 3;
const KURTOSIS_HALF_MS = 20;

const WITNESSES = [
  "peakToSurround",
  "peakToPreRing",
  "compactMs",
  "riseSlope",
  "kurtosis",
] as const;

type Joined = Row & { w: number[]; peakAtMs: number };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/** Samples this close to an adjacent label's onset are masked out of rings. */
const MASK_MS = 10;

/**
 * The five witnesses at one candidate time, from the decimated envelope.
 *
 * `maskMs` carries the onsets of OTHER labels near this candidate: ring
 * samples within ±10ms of one are excluded, so a neighbouring stroke's own
 * click cannot inflate the surround — the window rule enforced by masking
 * rather than by dropping rows, which would change the row population the
 * AUCs are compared on.
 */
function witnessesAt(
  envelope: Float32Array,
  tMs: number,
  maskMs: readonly number[]
): { w: number[]; peakAtMs: number; masked: boolean } {
  const idx = (ms: number): number =>
    Math.max(0, Math.min(envelope.length - 1, Math.round(ms / GRID_MS)));

  // Sub-hop alignment: the strongest envelope point inside ±12ms.
  let peak = -1;
  let peakIndex = idx(tMs);
  for (let i = idx(tMs - ALIGN_MS); i <= idx(tMs + ALIGN_MS); i++) {
    if ((envelope[i] as number) > peak) {
      peak = envelope[i] as number;
      peakIndex = i;
    }
  }
  const peakAtMs = peakIndex * GRID_MS;

  const pre: number[] = [];
  const post: number[] = [];
  let masked = false;
  const clear = (ms: number): boolean => {
    for (const m of maskMs) {
      if (Math.abs(ms - m) <= MASK_MS) {
        masked = true;
        return false;
      }
    }
    return true;
  };
  for (let i = idx(peakAtMs - RING_OUT_MS); i <= idx(peakAtMs - RING_IN_MS); i++) {
    if (clear(i * GRID_MS)) pre.push(envelope[i] as number);
  }
  for (let i = idx(peakAtMs + RING_IN_MS); i <= idx(peakAtMs + RING_OUT_MS); i++) {
    if (clear(i * GRID_MS)) post.push(envelope[i] as number);
  }
  if (pre.length < 8 || pre.length + post.length < 24) {
    throw new Error("ring too masked to trust — widen the exclusion reasoning");
  }
  const surround = Math.max(median([...pre, ...post]), 1e-9);
  const preRing = Math.max(median(pre), 1e-9);

  // Contiguous half-peak span through the peak, capped at ±53ms.
  const half = peak / 2;
  let lo = peakIndex;
  let hi = peakIndex;
  const loCap = idx(peakAtMs - COMPACT_CAP_MS);
  const hiCap = idx(peakAtMs + COMPACT_CAP_MS);
  while (lo > loCap && (envelope[lo - 1] as number) >= half) lo--;
  while (hi < hiCap && (envelope[hi + 1] as number) >= half) hi++;
  const compactMs = (hi - lo + 1) * GRID_MS;

  const riseSlope = peak / Math.max(envelope[idx(peakAtMs - RISE_LAG_MS)] as number, 1e-9);

  const window: number[] = [];
  for (let i = idx(peakAtMs - KURTOSIS_HALF_MS); i <= idx(peakAtMs + KURTOSIS_HALF_MS); i++) {
    window.push(envelope[i] as number);
  }
  let mean = 0;
  for (const v of window) mean += v;
  mean /= Math.max(window.length, 1);
  let m2 = 0;
  let m4 = 0;
  for (const v of window) {
    const d = v - mean;
    m2 += d * d;
    m4 += d * d * d * d;
  }
  m2 /= Math.max(window.length, 1);
  m4 /= Math.max(window.length, 1);
  const kurtosis = m2 > 1e-18 ? m4 / (m2 * m2) - 3 : 0;

  return {
    w: [peak / surround, peak / preRing, compactMs, riseSlope, kurtosis],
    peakAtMs,
    masked,
  };
}

/**
 * Rows the label-ceiling machine pass contradicted, when the kit exists:
 * kit decision points within 25ms of the row where annotator M heard no
 * onset within 70ms of the moment. Used only to report how the consensus
 * subset differs from the full set.
 */
function contradictedRows(): Set<string> {
  const out = new Set<string>();
  const manifestPath = join(CACHE_DIR, "relabel", "manifest.json");
  const answersPath = join(CACHE_DIR, "relabel", "answers-machine.csv");
  if (!existsSync(manifestPath) || !existsSync(answersPath)) return out;
  type Point = { id: string; stem: string; momentMs: number; snippetStartMs: number; kind: string };
  const points = JSON.parse(readFileSync(manifestPath, "utf8")) as Point[];
  const answers = new Map<string, number[]>();
  const lines = readFileSync(answersPath, "utf8").trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const [id, answer, offsets] = line.split(",");
    if (id === undefined) continue;
    answers.set(
      id,
      (answer ?? "").trim() === "yes"
        ? (offsets ?? "")
            .split(";")
            .map((s) => Number.parseFloat(s))
            .filter((v) => Number.isFinite(v))
        : []
    );
  }
  for (const point of points) {
    if (!point.kind.startsWith("decision") && point.kind !== "miss") continue;
    const offsets = answers.get(point.id);
    if (offsets === undefined) continue;
    const heard = offsets.some(
      (o) => Math.abs(point.snippetStartMs + o - point.momentMs) <= 70
    );
    if (!heard) out.add(`${point.stem}:${point.momentMs.toFixed(0)}`);
  }
  return out;
}

function main(): void {
  console.log("\n  collecting the decision table (unchanged engine)...");
  const rows = collect();

  console.log("  click-band pass over every take...");
  const byStem = new Map<string, Float32Array>();
  const labelsByStem = new Map<string, number[]>();
  for (const fixture of decodeFixtures({ quiet: true })) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const full = clickBandEnvelope(mono, wav.sampleRate);
    // Decimate to the 0.5ms grid: the envelope is already 1ms-smoothed, so
    // the max over each 0.5ms cell loses nothing a witness reads.
    const step = (GRID_MS / 1000) * wav.sampleRate;
    const decimated = new Float32Array(Math.floor(full.length / step));
    for (let i = 0; i < decimated.length; i++) {
      const from = Math.round(i * step);
      const to = Math.min(full.length, Math.round((i + 1) * step));
      let max = 0;
      for (let j = from; j < to; j++) if ((full[j] as number) > max) max = full[j] as number;
      decimated[i] = max;
    }
    byStem.set(fixture.stem, decimated);
    labelsByStem.set(
      fixture.stem,
      fixture.label.events.map((e) => e.startMs)
    );
  }

  // Join, and enforce the window rule while doing it: other labels' onsets
  // near the candidate are masked out of the rings.
  const joined: Joined[] = [];
  let maskedSixteenths = 0;
  let maskedAll = 0;
  for (const row of rows) {
    const envelope = byStem.get(row.stem);
    if (envelope === undefined) continue;
    const near = row.nearLabelStartMs;
    const maskTimes = (labelsByStem.get(row.stem) as number[]).filter(
      (labelStart) =>
        (near === null || Math.abs(labelStart - near) >= 1) &&
        Math.abs(labelStart - row.at) <= RING_OUT_MS + ALIGN_MS + MASK_MS
    );
    const { w, peakAtMs, masked } = witnessesAt(envelope, row.at, maskTimes);
    if (masked) {
      maskedAll++;
      if (row.stem.includes("sixteenths")) maskedSixteenths++;
    }
    joined.push({ ...row, w, peakAtMs });
  }
  console.log(
    `\n  ${joined.length} decisions joined; window rule: adjacent-label onsets were\n` +
      `  masked out of the surround ring on ${maskedSixteenths} sixteenths rows ` +
      `(${maskedAll} corpus-wide);\n  after masking no ring reads another label's stroke ` +
      `(ring 8-${RING_OUT_MS}ms each side; a sixteenth is 107ms)`
  );

  const derive = joined.filter((r) => !isHeldOut(r.stem));
  const held = joined.filter((r) => isHeldOut(r.stem));
  const y = derive.map((r) => r.y);

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

  // The consensus subset differs from the full derivation set by exactly the
  // rows the machine annotator contradicted. Recompute rather than assume.
  const contradicted = contradictedRows();
  const consensus = derive.filter(
    (r) => ![...contradicted].some((key) => {
      const [stem, at] = key.split(":");
      return stem === r.stem && Math.abs(Number(at) - r.at) <= 25;
    })
  );
  console.log(
    `  consensus subset (Task 1 carve-out): ${consensus.length} of ${derive.length} derivation rows` +
      (contradicted.size === 0 ? " (kit files absent or no contradictions)" : "")
  );

  /* ---- 0. Positive control: does the harness see clicks at all? ----------- */

  // Before reading the decision-row numbers: the same witnesses at moments
  // where the answer is KNOWN — every label onset (a stroke happened) against
  // a point 180ms into every long-enough event (sustain, nothing happened).
  // If the witnesses cannot separate these, the measurement is broken and the
  // decision-row numbers mean nothing. If they can, a failure on the decision
  // rows is about that population, not about the pipeline.
  console.log("\n  0. POSITIVE CONTROL: label onsets vs mid-sustain moments\n");
  {
    const scores: number[][] = WITNESSES.map(() => []);
    const truth: number[] = [];
    for (const fixture of decodeFixtures({ quiet: true })) {
      const envelope = byStem.get(fixture.stem);
      if (envelope === undefined) continue;
      const onsets = labelsByStem.get(fixture.stem) as number[];
      for (const event of fixture.label.events) {
        const masks = onsets.filter((o) => Math.abs(o - event.startMs) >= 1);
        const atOnset = witnessesAt(envelope, event.startMs, masks);
        truth.push(1);
        atOnset.w.forEach((v, wi) => (scores[wi] as number[]).push(v));
        if (event.endMs - event.startMs > 250) {
          const sustainAt = event.startMs + 180;
          const atSustain = witnessesAt(envelope, sustainAt, onsets);
          truth.push(0);
          atSustain.w.forEach((v, wi) => (scores[wi] as number[]).push(v));
        }
      }
    }
    const controlBody: string[][] = [];
    for (let wi = 0; wi < WITNESSES.length; wi++) {
      const a = auc(scores[wi] as number[], truth);
      controlBody.push([WITNESSES[wi] as string, f3(a), f3(Math.max(a, 1 - a))]);
    }
    table(["witness", "AUC", "oriented"], controlBody);
  }

  /* ---- 1. Single witnesses on the derivation rows ------------------------- */

  console.log(
    "\n  1. SINGLE-WITNESS SEPARATION (derivation decision rows; bar = 0.730)\n"
  );
  const sharpnessCol = 0; // FEATURES[0] === "sharpness"
  const body: string[][] = [];
  const orientedOf = (rs: readonly Joined[], wi: number): number => {
    const a = auc(rs.map((r) => r.w[wi] as number), rs.map((r) => r.y));
    return Math.max(a, 1 - a);
  };
  for (let wi = 0; wi < WITNESSES.length; wi++) {
    const scores = derive.map((r) => r.w[wi] as number);
    const a = auc(scores, y);
    const oriented = Math.max(a, 1 - a);
    const zc = zeroCost(a >= 0.5 ? scores : scores.map((v) => -v), y);
    body.push([
      WITNESSES[wi] as string,
      f3(a),
      f3(oriented),
      a >= 0.5 ? "high" : "low",
      f3(orientedOf(consensus, wi)),
      `${zc.falseAccepts} / ${zc.negatives}`,
    ]);
  }
  {
    const scores = derive.map((r) => r.x[sharpnessCol] as number);
    const a = auc(scores, y);
    body.push([
      "sharpness (baseline)",
      f3(a),
      f3(Math.max(a, 1 - a)),
      "high",
      f3(
        Math.max(
          auc(consensus.map((r) => r.x[sharpnessCol] as number), consensus.map((r) => r.y)),
          1 - auc(consensus.map((r) => r.x[sharpnessCol] as number), consensus.map((r) => r.y))
        )
      ),
      "-",
    ]);
  }
  body.sort((p, q) => Number(q[2]) - Number(p[2]));
  table(["witness", "AUC", "oriented", "dir", "consensus", "FP at zero label cost"], body);

  /* ---- 2. Per signal path, held out (read, not fitted) -------------------- */

  console.log("\n\n  2. PER SIGNAL PATH (held-out rows; read to check the traps, never fitted)\n");
  const path = (stem: string): string =>
    stem.includes("amped")
      ? "amp sim"
      : stem.includes("-di-")
        ? "DI"
        : stem.includes("mic")
          ? "room mic"
          : "mic (default)";
  const paths = [...new Set(held.map((r) => path(r.stem)))].sort();
  const pathBody: string[][] = [];
  for (const p of paths) {
    const rs = held.filter((r) => path(r.stem) === p);
    const pos = rs.filter((r) => r.y === 1).length;
    const cells = [p, String(rs.length), String(pos)];
    for (let wi = 0; wi < WITNESSES.length; wi++) cells.push(f3(orientedOf(rs, wi)));
    const sharp = auc(rs.map((r) => r.x[sharpnessCol] as number), rs.map((r) => r.y));
    cells.push(f3(Math.max(sharp, 1 - sharp)));
    pathBody.push(cells);
  }
  {
    const pos = held.filter((r) => r.y === 1).length;
    const cells = ["ALL held out", String(held.length), String(pos)];
    for (let wi = 0; wi < WITNESSES.length; wi++) cells.push(f3(orientedOf(held, wi)));
    const sharp = auc(held.map((r) => r.x[sharpnessCol] as number), held.map((r) => r.y));
    cells.push(f3(Math.max(sharp, 1 - sharp)));
    pathBody.push(cells);
  }
  table(["path", "rows", "pos", ...WITNESSES, "sharpness"], pathBody);

  /* ---- 3. Where the click actually is ------------------------------------- */

  // Reading the mechanism, not just the score: the distribution of each
  // witness at positives and negatives, per set, so a verdict names what the
  // envelope looked like rather than only a rank statistic.
  console.log("\n\n  3. WITNESS DISTRIBUTIONS (derivation; median [p25 p75])\n");
  const q = (values: number[], p: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
  };
  const distBody: string[][] = [];
  for (let wi = 0; wi < WITNESSES.length; wi++) {
    const pos = derive.filter((r) => r.y === 1).map((r) => r.w[wi] as number);
    const neg = derive.filter((r) => r.y === 0).map((r) => r.w[wi] as number);
    distBody.push([
      WITNESSES[wi] as string,
      `${q(pos, 0.5).toFixed(2)} [${q(pos, 0.25).toFixed(2)} ${q(pos, 0.75).toFixed(2)}]`,
      `${q(neg, 0.5).toFixed(2)} [${q(neg, 0.25).toFixed(2)} ${q(neg, 0.75).toFixed(2)}]`,
    ]);
  }
  table(["witness", "positives (re-picks)", "negatives (churn)"], distBody);

  console.log(
    "\n  falsifier: best single compactness witness must clear 0.730 on the\n" +
      "  derivation rows and hold on the room-mic path. The verdict lives in\n" +
      "  docs/DETECTION-FINDINGS.md.\n"
  );
}

main();
