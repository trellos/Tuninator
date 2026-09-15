/**
 * Propose re-timed onsets for the four AMPED 120bpm same-pitch takes.
 *
 * WHAT THIS WRITES. A proposal, to a directory you name with `--out`, in the
 * same JSON schema as `fixtures/labels/*.json` so a reviewer can diff it
 * against the real file. It NEVER writes under `fixtures/` and has no `--write`
 * mode: `fixtures/labels/**` and `fixtures/eval.config.json` are read-only
 * ground truth (`AGENTS.md` §3). Nothing here consults Tuninator — no
 * `analyzeSamples`, no `projectEmissions`, no engine onset — because using the
 * detector to decide where a label goes is the circularity that file names.
 *
 * WHY THE JOB EXISTS. The eight same-pitch fixtures are four performances
 * rendered twice, DI and through an amp sim. The labels were derived from the
 * DI and applied to the amped render, since each pair is one performance. Then
 * commit "Re-time the gridded DI sections by count instead of by threshold"
 * re-timed the two gridded takes' DI labels and LEFT THEIR AMPED TWINS ON THE
 * GRID, so those two amped label sets are now stale by far more than the 65ms
 * the docs record.
 *
 * ---------------------------------------------------------------------------
 * THE METHOD, IN FOUR MEASUREMENTS. Every one is a plain signal measurement
 * over the decoded audio; none shares a constant or a line of code with
 * `src/engine/**`.
 *
 * 1. RENDER OFFSET (`measureRenderOffset`). Each pair is one performance at an
 *    identical file length, so the difference between the true DI onset and the
 *    true amped onset is a single render offset, not a per-event quantity.
 *    Measured around every DI label by cross-correlating the two RAW waveforms,
 *    decimated to 6kHz (the highest labelled fundamental here is D5 = 588Hz, so
 *    3kHz of bandwidth is ample and the search is cheap).
 *
 *    THE WINDOW IS THE WHOLE RISK HERE. A window wider than the spacing of the
 *    events it discriminates has produced a false finding at least four times in
 *    this project (`docs/DETECTION-FINDINGS.md`), so both numbers are pinned to
 *    the take's own subdivision and neither can reach a neighbouring pick:
 *      - quarters / held-then-picked, 500ms spacing: 200ms window, +-60ms lag.
 *      - eighths 250ms and sixteenths 125ms:         100ms window, +-40ms lag.
 *    A 125ms sixteenth has a 62.5ms half-spacing, so a +-40ms search cannot
 *    alias onto the pick before or after. A first pass of this script used a 4s
 *    block and a +-200ms lag and duly returned 200ms — pinned at its own bound,
 *    i.e. the documented failure, which is why the bounds are stated here.
 *    Only probes reaching r >= 0.5 are counted.
 *
 * 2. FIRST-PICK ANCHOR (`measureAnchor`). Every render opens with at least 1.9s
 *    of nobody playing, so the first pick is the one point in these takes that
 *    can be located with no window and no threshold at all: the frame of
 *    STEEPEST RELATIVE ENVELOPE RISE inside the first 2.6s. Alias-free, because
 *    there is only one pick in that span. This is the one reading that is purely
 *    amped-native and it is what shows the two gridded amped label sets starting
 *    ~200ms late.
 *
 * 3. AMPED-NATIVE RE-TIMING (`retimeFromAudio`). The house count-constrained
 *    prominence method, imported wholesale from `scripts/retime-gridded-labels.ts`
 *    — `envelope`, `peaks`, `candidates`, `align` and all five of its constants
 *    (WIN_MS 20, HOP_MS 2.5, MIN_INTERVAL_MS 80, MARGIN_MS 150, SKIP_COST 140).
 *    NOTHING IS RETUNED and no constant is added, so a reviewer can see this
 *    proposal contains no number fitted to the amped renders. Run per structural
 *    section, with the section's own label count as the constraint, and SEEDED
 *    FROM THE DI TIME for the same id: seeding from the amped label's own time
 *    anchors the alignment to the stale grid and measures the grid rather than
 *    the audio.
 *
 *    Each take is also run against its DI render as a CONTROL, which is what
 *    makes the amped numbers readable. On the two gridded takes the control is
 *    only a faithfulness check (those DI labels were made by this method, so it
 *    must reproduce them, and it does, to 1ms). On `quarters` and
 *    `held-then-picked` the control is independent and is the method's own
 *    accuracy against a label set the verifier already likes.
 *
 * 4. THE FALSIFIER, stated before the measurement. Since the renders are one
 *    performance and (1) puts the render offset within a few ms of zero, a
 *    method that is really finding picks in the amped audio must land close to
 *    the DI label for the same id. Bar: the interquartile spread of
 *    (amped-native minus DI) must be <= 20ms, which is two hops of
 *    `verify-fixtures.ts`'s 10ms envelope. A section that yields fewer
 *    candidate peaks than it has labels fails outright — the count constraint
 *    is meaningless when the peaks are not there.
 *
 * WHAT IS PROPOSED. Per take, whichever of these the evidence supports:
 *   - the amped-native times, if (3) clears the (4) bar;
 *   - else the DI times id-for-id plus the measured render offset, if (1) puts
 *     that offset within +-20ms of zero, since then the DI labels ARE the amped
 *     labels and the DI is where the onsets are visible;
 *   - else nothing, reported as "could not do".
 * An id present in the amped file but not the DI file keeps its place by
 * proportional interpolation between its neighbours' proposed times. The event
 * count, ids, order, pitches, names and `required` flags are never touched:
 * this is a re-timing, and the structure is confirmed correct
 * (`docs/SAME-PITCH-MATERIAL.md`, "Where the structure came from").
 *
 * SCORING. The before/after concern counts come from `verifyFixture`, IMPORTED
 * from `scripts/verify-fixtures.ts` rather than reimplemented, so the two
 * columns are the same statistic by construction. Read the ceiling it prints
 * first: every concern on these renders is "no energy rise near startMs", and
 * that rule fires on the amped audio far less often than there are picks, so the
 * concern count is bounded well above zero no matter where the labels go.
 *
 * Usage:
 *   npx tsx scripts/propose-amped-onsets.ts --out <dir>
 *   npx tsx scripts/propose-amped-onsets.ts --out <dir> --no-score   # skip (5)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures, type DecodeOutcome, type LabelFile } from "./decode-fixtures.js";
import { align, candidates, envelope, peaks } from "./retime-gridded-labels.js";
import { attackTimesMs, envelopeOf, verifyFixture } from "./verify-fixtures.js";

/* -------------------------------------------------------------------------- */
/* Constants — where each one came from                                        */
/* -------------------------------------------------------------------------- */

/** Decimation for the raw-waveform cross-correlation. 48000/8 = 6kHz; the
 *  highest labelled fundamental in this material is D5 = 588Hz. */
const DECIMATE = 8;
/** A cross-correlation probe below this correlation is not evidence of anything. */
const MIN_PROBE_R = 0.5;
/** The falsifier bar: 2 hops of verify-fixtures.ts's 10ms analysis envelope. */
const FALSIFIER_IQR_MS = 20;
/** Zero-offset band for the render offset, same two hops. */
const ZERO_OFFSET_BAND_MS = 20;
/** verify-fixtures.ts's own envelope, for the anchor measurement. */
const ANCHOR_HOP_MS = 10;
const ANCHOR_WINDOW_MS = 20;
const ANCHOR_BASELINE_MS = 60;
/** Every render has >= 1.9s of nobody playing at the head. */
const ANCHOR_SEARCH_MS = 2600;

type Take = {
  base: string;
  /** Cross-correlation window and lag bound, pinned to the take's own spacing. */
  windowMs: number;
  maxLagMs: number;
  /** Structural sections, by label id, for the count constraint. */
  section: (id: string) => string;
};

const TAKES: Take[] = [
  {
    base: "same-pitch-quarters-a3-e5-120bpm",
    windowMs: 200, maxLagMs: 60, // 500ms quarters
    section: (id) => id[0] as string, // a = the A3 run, e = the E5 run
  },
  {
    base: "same-pitch-eighths-a3-120bpm",
    windowMs: 100, maxLagMs: 40, // 250ms eighths then 125ms sixteenths
    section: (id) => (id.startsWith("s16") ? "sixteenths" : "eighths"),
  },
  {
    base: "same-pitch-eighths-sixteenths-e5-120bpm",
    windowMs: 100, maxLagMs: 40,
    section: (id) => (id.startsWith("s16") ? "sixteenths" : "eighths"),
  },
  {
    base: "held-then-picked-six-strings-120bpm",
    windowMs: 200, maxLagMs: 60, // 500ms quarters; the held notes are 2000ms
    section: (id) => id.slice(0, 2), // p1..p6, one section per string
  },
];

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

const quantile = (sorted: readonly number[], f: number): number =>
  sorted.length === 0 ? NaN : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] as number);

function stats(values: readonly number[]) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0] ?? NaN,
    p10: quantile(s, 0.1),
    q25: quantile(s, 0.25),
    median: quantile(s, 0.5),
    q75: quantile(s, 0.75),
    p90: quantile(s, 0.9),
    max: s[s.length - 1] ?? NaN,
    iqr: quantile(s, 0.75) - quantile(s, 0.25),
  };
}

function readMono(fixture: DecodeOutcome): { x: Float32Array; sampleRate: number } {
  const wav = readWav(readFileSync(fixture.wavPath));
  return { x: downmixToMono(wav.samples, wav.channels), sampleRate: wav.sampleRate };
}

function decimate(x: Float32Array, by: number): Float64Array {
  const n = Math.floor(x.length / by);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < by; j++) s += x[i * by + j] as number;
    out[i] = s / by;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 1. Render offset                                                            */
/* -------------------------------------------------------------------------- */

function localLagMs(
  a: Float64Array, b: Float64Array, sr: number,
  centreMs: number, windowMs: number, maxLagMs: number
): { lagMs: number; r: number } | null {
  const half = Math.round((windowMs / 2000) * sr);
  const c = Math.round((centreMs / 1000) * sr);
  const maxLag = Math.round((maxLagMs / 1000) * sr);
  const from = c - half, to = c + half;
  if (from - maxLag < 0 || to + maxLag >= Math.min(a.length, b.length)) return null;
  const n = to - from;
  let ma = 0;
  for (let i = 0; i < n; i++) ma += a[from + i] as number;
  ma /= n;
  let va = 0;
  for (let i = 0; i < n; i++) { const d = (a[from + i] as number) - ma; va += d * d; }
  if (va < 1e-14) return null;
  let best = { lagMs: 0, r: -2 };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let mb = 0;
    for (let i = 0; i < n; i++) mb += b[from + lag + i] as number;
    mb /= n;
    let vb = 0, s = 0;
    for (let i = 0; i < n; i++) {
      const da = (a[from + i] as number) - ma;
      const db = (b[from + lag + i] as number) - mb;
      vb += db * db; s += da * db;
    }
    if (vb < 1e-14) continue;
    const r = s / Math.sqrt(va * vb);
    if (r > best.r) best = { lagMs: (lag / sr) * 1000, r };
  }
  return best;
}

function measureRenderOffset(take: Take, di: DecodeOutcome, amped: DecodeOutcome) {
  const a = readMono(di), b = readMono(amped);
  const sr = a.sampleRate / DECIMATE;
  const xa = decimate(a.x, DECIMATE), xb = decimate(b.x, DECIMATE);
  const lags: number[] = [];
  const rs: number[] = [];
  let pinned = 0;
  for (const event of di.label.events) {
    // Centre the window ON the note, not on its attack: an attack sits at the
    // edge of a window and half the correlation is then over the silence or the
    // previous note's tail.
    const m = localLagMs(xa, xb, sr, event.startMs + take.windowMs / 2, take.windowMs, take.maxLagMs);
    if (m === null) continue;
    if (m.r < MIN_PROBE_R) { rs.push(m.r); continue; }
    if (Math.abs(Math.abs(m.lagMs) - take.maxLagMs) < 0.3) pinned++;
    lags.push(m.lagMs);
    rs.push(m.r);
  }
  return { lag: stats(lags), r: stats(rs), pinnedAtBound: pinned, probes: rs.length };
}

/* -------------------------------------------------------------------------- */
/* 2. First-pick anchor                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The frame of steepest relative envelope rise in the first `ANCHOR_SEARCH_MS`.
 * No threshold on the rise itself: the maximum of `here / baseline` is taken,
 * which is the envelope-rise rule with its bar removed. Alias-free because every
 * render has a single pick in that span.
 *
 * ONE PRECONDITION, and it is needed. The frame must be at least as loud as the
 * MEDIAN frame of the whole render. Two of these amped renders open with true
 * digital silence and then the amp switches on, which is a relative rise of five
 * orders of magnitude and dwarfs any pick — the first draft of this function
 * duly reported an anchor of 190ms on both of them. The median frame of a render
 * that is one pitch sounding for nine tenths of its length is "a note is
 * sounding", so a pick attack clears it and amp hiss does not. It is the
 * render's own median, so it is not a tuned constant.
 *
 * Also returns the head noise floor, because on those two renders it is what
 * breaks every other envelope test.
 */
function measureAnchor(fixture: DecodeOutcome): {
  atMs: number; ratio: number; headFloor: number; peak: number; median: number;
} {
  const { x, sampleRate } = readMono(fixture);
  const hop = Math.round((ANCHOR_HOP_MS / 1000) * sampleRate);
  const win = Math.round((ANCHOR_WINDOW_MS / 1000) * sampleRate);
  const frames = Math.floor((x.length - win) / hop) + 1;
  const rms = new Float64Array(frames);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    let s = 0;
    const off = i * hop;
    for (let j = 0; j < win; j++) { const v = x[off + j] as number; s += v * v; }
    rms[i] = Math.sqrt(s / win);
    if ((rms[i] as number) > peak) peak = rms[i] as number;
  }
  const median = quantile([...rms].sort((a, b) => a - b), 0.5);
  const baselineFrames = Math.max(2, Math.round(ANCHOR_BASELINE_MS / ANCHOR_HOP_MS));
  let headFloor = 0;
  for (let i = 0; i < Math.min(frames, Math.round(1500 / ANCHOR_HOP_MS)); i++) {
    if ((rms[i] as number) > headFloor) headFloor = rms[i] as number;
  }
  let best = { atMs: NaN, ratio: 0 };
  const to = Math.min(frames, Math.round(ANCHOR_SEARCH_MS / ANCHOR_HOP_MS));
  for (let i = baselineFrames; i < to; i++) {
    if ((rms[i] as number) < median) continue;
    let baseline = 0;
    for (let j = i - baselineFrames; j < i; j++) baseline += rms[j] as number;
    baseline = Math.max(baseline / baselineFrames, 1e-9);
    const ratio = (rms[i] as number) / baseline;
    if (ratio > best.ratio) best = { atMs: i * ANCHOR_HOP_MS, ratio };
  }
  return { ...best, headFloor, peak, median };
}

/**
 * The CEILING on the concern count: every concern on these renders is "no energy
 * rise within Xms of startMs", so a label can only ever clear it by sitting on
 * an attack `verify-fixtures.ts`'s own rule actually found. With N labels and A
 * attacks, at most min(N, A) labels can be attack-aligned no matter where they
 * are put, so the concern count cannot fall below N - min(N, A). Computed with
 * that script's `envelopeOf` and `attackTimesMs`, imported.
 */
function concernCeiling(fixture: DecodeOutcome): { attacks: number; labels: number; floor: number } {
  const { x, sampleRate } = readMono(fixture);
  const attacks = attackTimesMs(envelopeOf(x, sampleRate)).length;
  const labels = fixture.label.events.length;
  return { attacks, labels, floor: labels - Math.min(labels, attacks) };
}

/* -------------------------------------------------------------------------- */
/* 3. Amped-native re-timing, by count                                        */
/* -------------------------------------------------------------------------- */

type Retimed = {
  at: Map<string, number>;
  /** Labels in a section whose candidate list was shorter than the label count. */
  shortfall: number;
  /** Labels the monotonic alignment left with no pick. */
  unmatched: number;
  sections: Array<{ name: string; labels: number; cands: number; hits: number }>;
};

function retimeFromAudio(
  take: Take,
  fixture: DecodeOutcome,
  seedFor: (id: string) => number | undefined
): Retimed {
  const { x, sampleRate } = readMono(fixture);
  const all = peaks(envelope(x, sampleRate));

  const bySection = new Map<string, LabelFile["events"]>();
  for (const event of fixture.label.events) {
    const key = take.section(event.id);
    bySection.set(key, [...(bySection.get(key) ?? []), event]);
  }

  const out: Retimed = { at: new Map(), shortfall: 0, unmatched: 0, sections: [] };
  for (const [name, events] of bySection) {
    const seed = events.map((e) => seedFor(e.id) ?? e.startMs);
    const cand = candidates(all, Math.min(...seed), Math.max(...seed), events.length);
    if (cand.length < events.length) out.shortfall += events.length - cand.length;
    const assigned = align(seed, cand.map((c) => c.at));
    let hits = 0;
    for (let i = 0; i < events.length; i++) {
      const at = assigned[i];
      if (at === null || at === undefined) { out.unmatched++; continue; }
      out.at.set((events[i] as LabelFile["events"][number]).id, at);
      hits++;
    }
    out.sections.push({ name, labels: events.length, cands: cand.length, hits });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 4. Building the proposal                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Proposed startMs for every amped event, preserving count, ids and order.
 *
 * `want` gives a time for the ids it can; an id it cannot place keeps its
 * position by proportional interpolation between the nearest placed neighbours
 * on each side, so a label the source set does not carry never reorders the
 * take. endMs is then rebuilt to the amped file's own convention: the source
 * event's endMs where there is one, otherwise the event's own duration, and in
 * either case clamped so it never runs past the next startMs.
 */
function buildProposal(
  current: LabelFile,
  want: (id: string) => number | undefined,
  wantEnd: (id: string) => number | undefined
): LabelFile {
  const events = [...current.events].sort((a, b) => a.startMs - b.startMs);
  const placed = events.map((e) => want(e.id));

  // Interpolate the unplaced, proportionally to their current spacing.
  const starts = events.map((e, i) => {
    const at = placed[i];
    if (at !== undefined) return at;
    let lo = i - 1; while (lo >= 0 && placed[lo] === undefined) lo--;
    let hi = i + 1; while (hi < events.length && placed[hi] === undefined) hi++;
    const loOk = lo >= 0, hiOk = hi < events.length;
    if (!loOk && !hiOk) return (events[i] as LabelFile["events"][number]).startMs;
    if (!loOk) return (placed[hi] as number) - ((events[hi] as LabelFile["events"][number]).startMs - (events[i] as LabelFile["events"][number]).startMs);
    if (!hiOk) return (placed[lo] as number) + ((events[i] as LabelFile["events"][number]).startMs - (events[lo] as LabelFile["events"][number]).startMs);
    const spanNow = (events[hi] as LabelFile["events"][number]).startMs - (events[lo] as LabelFile["events"][number]).startMs;
    const f = spanNow === 0 ? 0.5 : ((events[i] as LabelFile["events"][number]).startMs - (events[lo] as LabelFile["events"][number]).startMs) / spanNow;
    return (placed[lo] as number) + f * ((placed[hi] as number) - (placed[lo] as number));
  }).map((v) => Math.round(v));

  // Strictly increasing, or the take has been reordered.
  for (let i = 1; i < starts.length; i++) {
    if ((starts[i] as number) <= (starts[i - 1] as number)) starts[i] = (starts[i - 1] as number) + 1;
  }

  const out: LabelFile = {
    ...current,
    events: events.map((event, i) => {
      const start = starts[i] as number;
      const proposedEnd = wantEnd(event.id);
      const duration = event.endMs - event.startMs;
      let end = proposedEnd ?? start + duration;
      const nextStart = i + 1 < starts.length ? (starts[i + 1] as number) : Infinity;
      if (end > nextStart) end = nextStart;
      if (end <= start) end = Math.min(start + Math.max(1, duration), nextStart);
      return { ...event, startMs: start, endMs: end };
    }),
  };
  return out;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  const outDir = argValue("--out");
  if (outDir === undefined) {
    process.stderr.write("propose-amped-onsets: --out <dir> is required (never fixtures/).\n");
    return 1;
  }
  if (/(^|\/)fixtures(\/|$)/.test(outDir)) {
    process.stderr.write("propose-amped-onsets: refusing to write inside fixtures/.\n");
    return 1;
  }
  const score = !process.argv.includes("--no-score");
  mkdirSync(outDir, { recursive: true });

  const fixtures = new Map(decodeFixtures({ quiet: true }).map((f) => [f.stem, f]));
  const summary: unknown[] = [];

  for (const take of TAKES) {
    const di = fixtures.get(`${take.base}-di`);
    const amped = fixtures.get(`${take.base}-amped`);
    if (di === undefined || amped === undefined) throw new Error(`missing render for ${take.base}`);

    process.stdout.write(`\n${"=".repeat(96)}\n${take.base}\n${"=".repeat(96)}\n`);

    /* --- 1. render offset ------------------------------------------------- */
    const off = measureRenderOffset(take, di, amped);
    process.stdout.write(
      `\n  [1] RENDER OFFSET  raw-waveform xcorr, ${take.windowMs}ms window, lag <= +-${take.maxLagMs}ms\n` +
      `      probes ${off.probes}, of which r>=${MIN_PROBE_R}: ${off.lag.n}   r median ${off.r.median.toFixed(2)}\n` +
      `      amped minus di:  p10 ${off.lag.p10.toFixed(1)}  q25 ${off.lag.q25.toFixed(1)}  ` +
      `MEDIAN ${off.lag.median.toFixed(1)}ms  q75 ${off.lag.q75.toFixed(1)}  p90 ${off.lag.p90.toFixed(1)}\n` +
      `      probes pinned at the lag bound (a pinned majority means the bound is too tight): ${off.pinnedAtBound}/${off.lag.n}\n`
    );

    /* --- 2. anchors ------------------------------------------------------- */
    const anchors = { di: measureAnchor(di), amped: measureAnchor(amped) };
    const firstDi = (di.label.events[0] as LabelFile["events"][number]).startMs;
    const firstAmped = (amped.label.events[0] as LabelFile["events"][number]).startMs;
    process.stdout.write(
      `\n  [2] FIRST-PICK ANCHOR  steepest relative envelope rise inside ${ANCHOR_SEARCH_MS}ms, no threshold\n` +
      `      di    anchor ${anchors.di.atMs}ms (rise x${anchors.di.ratio.toFixed(1)})  ` +
      `head floor ${anchors.di.headFloor.toExponential(2)} = ${((anchors.di.headFloor / anchors.di.peak) * 100).toFixed(1)}% of peak\n` +
      `      amped anchor ${anchors.amped.atMs}ms (rise x${anchors.amped.ratio.toFixed(1)})  ` +
      `head floor ${anchors.amped.headFloor.toExponential(2)} = ${((anchors.amped.headFloor / anchors.amped.peak) * 100).toFixed(1)}% of peak` +
      `${anchors.amped.headFloor >= 0.008 ? "   ** ABOVE the engine's rmsGate **" : ""}\n` +
      `      first label:  di ${firstDi}ms (${firstDi - anchors.di.atMs >= 0 ? "+" : ""}${firstDi - anchors.di.atMs} vs anchor)   ` +
      `amped ${firstAmped}ms (${firstAmped - anchors.amped.atMs >= 0 ? "+" : ""}${firstAmped - anchors.amped.atMs} vs anchor)\n`
    );

    /* --- 3. amped-native re-timing, with the DI control ------------------- */
    const diBy = new Map(di.label.events.map((e) => [e.id, e]));
    const seed = (id: string): number | undefined => diBy.get(id)?.startMs;
    const runs = {
      di: retimeFromAudio(take, di, seed),
      amped: retimeFromAudio(take, amped, seed),
    };
    process.stdout.write(`\n  [3] AMPED-NATIVE RE-TIMING BY COUNT (+ the DI control), seeded from the DI times\n`);
    const falsifier: Record<string, { iqr: number; pass: boolean; n: number }> = {};
    for (const which of ["di", "amped"] as const) {
      const run = runs[which];
      const deltas: number[] = [];
      for (const [id, at] of run.at) {
        const d = diBy.get(id);
        if (d !== undefined) deltas.push(at - d.startMs);
      }
      const s = stats(deltas);
      const pass = s.iqr <= FALSIFIER_IQR_MS && run.shortfall === 0;
      falsifier[which] = { iqr: s.iqr, pass, n: s.n };
      process.stdout.write(
        `      ${which.padEnd(5)}  ${run.sections.map((x) => `${x.name} ${x.labels}lab/${x.cands}cand/${x.hits}hit`).join("  ")}\n` +
        `             candidate shortfall ${run.shortfall}, unmatched ${run.unmatched};  ` +
        `minus DI (n=${s.n}): q25 ${s.q25.toFixed(0)} median ${s.median.toFixed(0)} q75 ${s.q75.toFixed(0)}  ` +
        `IQR ${s.iqr.toFixed(0)}ms  -> ${pass ? "PASS" : "FAIL"} (bar: IQR <= ${FALSIFIER_IQR_MS}ms and no shortfall)\n`
      );
    }

    /* --- 4. decide -------------------------------------------------------- */
    const offsetIsZero = Math.abs(off.lag.median) <= ZERO_OFFSET_BAND_MS && off.pinnedAtBound * 2 < off.lag.n;
    let source: "amped-native" | "di-transfer" | "none";
    let rationale: string;
    if (falsifier.amped?.pass === true) {
      source = "amped-native";
      rationale = "the amped-native count method cleared the falsifier, so its own times are proposed";
    } else if (offsetIsZero) {
      source = "di-transfer";
      rationale =
        `the amped-native method failed the falsifier, and the measured render offset ` +
        `(${off.lag.median.toFixed(1)}ms, n=${off.lag.n}) is inside the +-${ZERO_OFFSET_BAND_MS}ms zero band, ` +
        `so the DI onsets are the amped onsets and are transferred id-for-id`;
    } else {
      source = "none";
      rationale =
        `the amped-native method failed the falsifier AND the render offset ` +
        `(${off.lag.median.toFixed(1)}ms) is not inside the +-${ZERO_OFFSET_BAND_MS}ms zero band: no proposal`;
    }

    let proposal: LabelFile | null = null;
    if (source === "amped-native") {
      const at = runs.amped.at;
      proposal = buildProposal(amped.label, (id) => at.get(id), () => undefined);
    } else if (source === "di-transfer") {
      proposal = buildProposal(amped.label, (id) => diBy.get(id)?.startMs, (id) => diBy.get(id)?.endMs);
    }

    /* --- 5. shifts ------------------------------------------------------- */
    const currentBy = new Map(amped.label.events.map((e) => [e.id, e.startMs]));
    const shiftsOf = (p: LabelFile): number[] => p.events.map((e) => e.startMs - (currentBy.get(e.id) as number));
    let shifts = proposal === null ? [] : shiftsOf(proposal);
    let sh = stats(shifts);

    /**
     * RESOLVABILITY. A re-timing smaller than the uncertainty of the measurement
     * that justifies it is not a finding, it is noise with a sign. The render
     * offset is measured to an interquartile spread of `off.lag.iqr`, so a
     * whole-take shift whose own median is inside that spread is withdrawn.
     * This is what stops a 15ms "correction" being proposed off a reading whose
     * own spread is 40ms.
     */
    let withdrawn = false;
    if (proposal !== null && Math.abs(sh.median) < off.lag.iqr && Math.abs(sh.median) > 0) {
      withdrawn = true;
      source = "none";
      rationale =
        `the amped-native method failed the falsifier; the DI transfer would move the take by ` +
        `${sh.median.toFixed(0)}ms, which is INSIDE the ${off.lag.iqr.toFixed(0)}ms interquartile spread of ` +
        `the render-offset measurement that would justify it, so the move is not resolvable and is withdrawn`;
      proposal = null;
      shifts = [];
      sh = stats(shifts);
    }

    const worst = proposal === null ? null : proposal.events
      .map((e) => ({ id: e.id, d: e.startMs - (currentBy.get(e.id) as number) }))
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];

    process.stdout.write(
      `\n  [4] DECISION: ${source.toUpperCase()}${withdrawn ? " (withdrawn as unresolvable)" : ""}\n      ${rationale}.\n` +
      `\n  [5] SHIFT vs the current amped labels   events in ${amped.label.events.length} -> out ${proposal?.events.length ?? amped.label.events.length}\n` +
      (proposal === null
        ? "      no shift: nothing proposed.\n"
        : `      p10 ${sh.p10.toFixed(0)}  MEDIAN ${sh.median.toFixed(0)}ms  p90 ${sh.p90.toFixed(0)}  ` +
          `min ${sh.min.toFixed(0)}  max ${sh.max.toFixed(0)}   ` +
          `largest single shift ${worst?.d.toFixed(0)}ms on ${worst?.id}\n` +
          `      labels actually moved: ${shifts.filter((d) => d !== 0).length}/${shifts.length}\n`)
    );

    let before: number | null = null;
    let after: number | null = null;
    let diConcerns: number | null = null;
    const ceilingAmped = concernCeiling(amped);
    const ceilingDi = concernCeiling(di);
    if (score) {
      before = verifyFixture(amped).concerningLabelIds.length;
      after = proposal === null
        ? before
        : verifyFixture({ ...amped, label: proposal }).concerningLabelIds.length;
      diConcerns = verifyFixture(di).concerningLabelIds.length;
      process.stdout.write(
        `\n  [6] verify-fixtures.ts CONCERNS (its own verifyFixture, imported not reimplemented)\n` +
        `      amped: before ${before}/${amped.label.events.length}   after ${after}/${proposal?.events.length ?? amped.label.events.length}\n` +
        `      di (reference): ${diConcerns}/${di.label.events.length}\n` +
        `      CEILING - the verifier's own attack rule fires ${ceilingAmped.attacks} times in this amped render ` +
        `against ${ceilingAmped.labels} labels, so NO placement can score below ${ceilingAmped.floor} concerns.\n` +
        `                (the DI render: ${ceilingDi.attacks} attacks, ${ceilingDi.labels} labels, floor ${ceilingDi.floor}.)\n`
      );
    }

    if (proposal !== null) {
      const note =
        source === "di-transfer"
          ? ` PROPOSED ${new Date().toISOString().slice(0, 10)} by scripts/propose-amped-onsets.ts:` +
            ` startMs/endMs taken id-for-id from the DI render of this same performance, whose gridded` +
            ` sections were re-timed onto measured picks. Justified by a measured render offset of` +
            ` ${off.lag.median.toFixed(0)}ms (raw-waveform cross-correlation at ${off.lag.n} onsets,` +
            ` ${take.windowMs}ms window, lag bounded to +-${take.maxLagMs}ms) and a first-pick anchor` +
            ` ${anchors.amped.atMs}ms in this render against ${anchors.di.atMs}ms in the DI. Re-timing only:` +
            ` count, ids, order, pitches and names are unchanged. A count-constrained prominence` +
            ` re-timing of the amped audio itself was attempted first and rejected against its stated` +
            ` falsifier. NOT ground truth - this is a proposal outside fixtures/.`
          : ` PROPOSED ${new Date().toISOString().slice(0, 10)} by scripts/propose-amped-onsets.ts:` +
            ` startMs re-timed onto the amped render's own envelope picks by the count-constrained` +
            ` prominence method of scripts/retime-gridded-labels.ts. NOT ground truth - a proposal` +
            ` outside fixtures/.`;
      proposal.timingNotes = `${proposal.timingNotes ?? ""}${note}`;
      const path = join(outDir, `${amped.stem}.json`);
      writeFileSync(path, `${JSON.stringify(proposal, null, 2)}\n`);
      process.stdout.write(`\n  written: ${path}\n`);
    }

    summary.push({
      take: take.base,
      renderOffset: off.lag,
      renderOffsetR: off.r.median,
      pinnedAtBound: off.pinnedAtBound,
      anchors,
      firstLabel: { di: firstDi, amped: firstAmped },
      falsifier,
      sections: { di: runs.di.sections, amped: runs.amped.sections },
      shortfall: { di: runs.di.shortfall, amped: runs.amped.shortfall },
      decision: source,
      withdrawn,
      rationale,
      eventsIn: amped.label.events.length,
      eventsOut: proposal?.events.length ?? amped.label.events.length,
      shift: proposal === null ? null : sh,
      largestShift: worst ?? null,
      moved: shifts.filter((d) => d !== 0).length,
      concerns: { beforeAmped: before, afterAmped: after, di: diConcerns },
      ceiling: { amped: ceilingAmped, di: ceilingDi },
    });
  }

  const path = join(outDir, "summary.json");
  writeFileSync(path, `${JSON.stringify({ generatedAt: new Date().toISOString(), takes: summary }, null, 2)}\n`);
  process.stdout.write(`\n\nsummary: ${path}\n`);
  process.stdout.write("fixtures/ was not written to.\n");
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`propose-amped-onsets: ${(error as Error).stack ?? (error as Error).message}\n`);
  process.exitCode = 1;
}
