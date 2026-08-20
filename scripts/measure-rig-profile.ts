/**
 * Is a rig a measurable thing, or is every take its own animal?
 *
 * Every remaining failure in this recogniser traces to one fact: the contrast
 * between a genuine re-pick and a decaying string's own noise varies by more
 * than an order of magnitude across this corpus, so no fixed bar on any witness
 * separates them everywhere. The proposed answer is to stop looking for the
 * constant and calibrate to the signal chain that is actually present, the way
 * `NoiseFloorTracker` already derives the amplitude gate from the rig's own
 * measured noise floor.
 *
 * That answer is only worth building if a rig HAS a signature — if a statistic
 * reads the same on four different performances through one chain and reads
 * differently through another. This script tests exactly that and nothing else.
 * It changes no decision: it runs the real recogniser, folds the same per-hop
 * evidence into `RigProfileEstimator`, and prints what the estimator believes.
 *
 * The corpus makes the test possible. Four groups, each a fixed signal chain:
 *
 * ```
 *   original 120bpm   5 takes   the Destroyer, mixed sources
 *   LP DI             4 takes   direct input
 *   LP mic            4 takes   room mic
 *   LP amped          4 takes   amp sim
 * ```
 *
 * The four takes inside an LP group are the same guitar, the same session and
 * the same chain, playing four different things. So a statistic's spread WITHIN
 * a group is what the playing does to it, and its spread BETWEEN groups is what
 * the rig does. A statistic whose within-group spread is as large as its
 * between-group spread is measuring the performance and is useless for
 * calibration, however clean its numbers look.
 *
 * WHAT THE NUMBERS MEAN
 *   within    the widest max/min ratio inside any one group — the playing
 *   between   max/min of the four group medians — the rig
 *   sep       between / within. Above 1 the rig moves it more than the playing
 *   overlap   of the six group pairs, how many have overlapping ranges
 *
 *   A statistic QUALIFIES at sep >= 1.5 with at most two of six pairs
 *   overlapping: the rig has to dominate the playing by half again, and the
 *   groups have to be mostly told apart by it. MARGINAL is sep >= 1.0. Anything
 *   else is reported as failing, not quietly dropped.
 *
 * WHAT IT FOUND, so the tables below can be read against a claim
 *
 * Two statistics of twenty-four qualify, and they are the same statistic twice:
 * the FLOOR of the flux family — what the spectrum does on the hops where
 * nothing was struck. `sharpness.floor` runs 0.70-1.10 on the 120bpm originals,
 * 0.91-1.27 direct, 1.31-2.04 through the room mic and 1.87-2.60 through the
 * amp sim, at 1.58x within a chain against 2.95x between them. It tells the two
 * clean paths from the two coloured ones and does not tell mic from amp.
 *
 * Everything measured AT an attack fails: `sharpness.attack` moves 3.88x within
 * a chain against 3.56x between, so it is a statistic of the playing wearing a
 * rig's clothes. So do `brightness` and `bassShare`, which separate the group
 * MEDIANS by 8.9x and 3.6x — a room mic really is brighter than a direct input
 * — while varying 25x and 9.7x inside a single chain, because a sixteenths run
 * on the top two strings and a cowboy chord are not the same spectrum. The
 * decay time constant varies 24x within a chain: it is a property of the note.
 *
 * And the test that matters most is negative. Rescaling the decision witnesses
 * by these profiles does NOT restore comparability across takes: the twelve-
 * witness leave-one-take-out AUC moves 0.434 -> 0.451 dividing by a cross-take
 * floor, 0.518 with the affine form, against 0.758 for folds that mix takes.
 * Calibrating on the take being scored — the upper bound, which cannot be
 * beaten by anything honest — makes it WORSE, at 0.359. The per-take scale that
 * defeats the fit is not the scale this profile measures.
 *
 * WHAT WOULD FALSIFY THIS
 *   A statistic that qualifies here but whose value on a held-out take of a
 *   group does not fall inside that group's range — that is the four-takes-per-
 *   chain structure being used as a fit rather than as a test, and the
 *   cross-take protocol in `docs/DETECTION-FINDINGS.md` is what catches it.
 *   Also: if the warm-up column shows a statistic needs more source time than a
 *   take contains, its per-take figure here is an artifact of the take's length.
 *
 * The mirror: per-hop witness readings (`heldSharpness` and friends) exist
 * inside `FluxTransientDetector` on every hop but only leave it on the hops
 * where an attack fires, so this script runs a second `OnsetDetector` over the
 * same windows in the same order. `--verify` checks it against the real kernel
 * on every hop where the real one reported a flux value; agreement must be
 * exact, and anything else invalidates every number below it.
 *
 * Usage:
 *   npx tsx scripts/measure-rig-profile.ts             profiles + separation
 *   npx tsx scripts/measure-rig-profile.ts --warmup    + the warm-up table
 *   npx tsx scripts/measure-rig-profile.ts --verify    check the mirror only
 *   npx tsx scripts/measure-rig-profile.ts --holdoff   sweep ATTACK_HOLDOFF_MS
 *   npx tsx scripts/measure-rig-profile.ts --normalise the calibration test only
 */

import { readFileSync } from "node:fs";
import { RecognitionEngine } from "../src/engine/engine.js";
import { RENDER_QUANTUM, resolveEngineConfig, snapHop } from "../src/engine/config.js";
import { OnsetDetector } from "../src/engine/kernels/onset.js";
import { RealFFT, hannWindow } from "../src/engine/kernels/fft.js";
import {
  HIGH_HZ,
  LOW_BAND_HZ,
  RigProfileEstimator,
  type RigObservation,
  type RigProfile,
  type RigProfileOptions,
} from "../src/engine/rig-profile.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";
import {
  FEATURES,
  auc,
  collect,
  outOfFold,
  zeroCost,
  type Row,
} from "./measure-decision-separability.js";

/** Source times, ms, the profile is snapshotted at for the warm-up table. */
const SNAPSHOTS_MS = [2000, 4000, 6000, 8000, 10000, 15000, 20000, 30000, 45000, 60000];

/** How close to its final value a statistic counts as settled. */
const SETTLED_TOLERANCE = 0.15;

/**
 * Ridge strength for the normalisation experiment. Not chosen here: it is the
 * setting `measure-decision-separability.ts` reports its headline figures at,
 * and changing it would make the comparison meaningless.
 */
const NORMALISATION_LAMBDA = 0.01;

type Chain = "120bpm original" | "LP DI" | "LP mic" | "LP amped";

const CHAINS: Chain[] = ["120bpm original", "LP DI", "LP mic", "LP amped"];

/** Which signal chain a fixture stem was recorded through. */
function chainOf(stem: string): Chain {
  if (stem.includes("120bpm") || stem.includes("spicy")) return "120bpm original";
  if (stem.includes("-di-")) return "LP DI";
  if (stem.includes("-amped-")) return "LP amped";
  // The room-mic takes are the ones with no path in the stem at all.
  return "LP mic";
}

type Snapshot = { atMs: number; profile: RigProfile };

type TakeResult = {
  stem: string;
  chain: Chain;
  /** Every above-gate hop's evidence, in order, for replay at any settings. */
  observations: RigObservation[];
  profile: RigProfile;
  snapshots: Snapshot[];
  /** Hops where the mirror's flux disagreed with the real kernel's. */
  disagreements: number;
  /** Hops the mirror was compared on. */
  compared: number;
};

/**
 * Run the recogniser over one take and collect the per-hop evidence a profile
 * is built from. Nothing is decided here and nothing is thresholded: the
 * observations are replayed into estimators afterwards, so a sweep costs one
 * pass over the audio rather than one per setting.
 */
function observationsOf(
  samples: Float32Array,
  sampleRate: number
): { observations: RigObservation[]; disagreements: number; compared: number } {
  const config = resolveEngineConfig({}, { pitchFrames: true });
  const engine = new RecognitionEngine(sampleRate, config);
  const observations: RigObservation[] = [];

  const fftSize = config.transient.fluxFftSize;
  const longWindow = config.pitch.longWindow;
  // The engine's own hop, so the mirror sees exactly the windows the fast lane
  // saw. Blocks are fed one render quantum at a time and the hop is a whole
  // number of quanta, so every hop boundary lands at the end of a block and the
  // window ends exactly at `FastFrame.sampleIndex`.
  snapHop(config.analysis.hopMs, sampleRate);

  const hopMs = (snapHop(config.analysis.hopMs, sampleRate) / sampleRate) * 1000;
  const mirror = new OnsetDetector({
    sampleRate,
    fftSize,
    minIntervalMs: config.transient.minIntervalMs,
    medianWindow: config.transient.fluxMedianWindow,
    sensitivity: config.transient.fluxSensitivity,
    referenceFrames: Math.max(1, Math.round(config.transient.fluxReferenceMs / hopMs)),
  });

  const fft = new RealFFT(fftSize);
  const hann = hannWindow(fftSize);
  const windowed = new Float32Array(fftSize);
  const magnitude = new Float32Array(fft.bins);
  const window = new Float32Array(fftSize);
  const binHz = sampleRate / fftSize;
  const highFrom = Math.round(HIGH_HZ / binHz);
  const lowFrom = Math.round(LOW_BAND_HZ[0] / binHz);
  const lowTo = Math.round(LOW_BAND_HZ[1] / binHz);

  let disagreements = 0;
  let compared = 0;

  const collect = (output: ReturnType<RecognitionEngine["processChunk"]>): void => {
    for (const frame of output.fast) {
      // Before the ring holds a full long window the fast lane suppresses the
      // transient detector entirely, so the mirror must not see those hops
      // either or its reference spectrum starts from a different place.
      if (frame.sampleIndex < longWindow) continue;

      const start = frame.sampleIndex - fftSize;
      window.fill(0);
      if (start >= 0) window.set(samples.subarray(start, frame.sampleIndex));
      else window.set(samples.subarray(0, frame.sampleIndex), -start);

      const result = mirror.process(window, frame.at, true);

      // `sharpness` normalises by the raw window RMS, as the detector does.
      let energy = 0;
      for (let i = 0; i < fftSize; i++) energy += (window[i] as number) ** 2;
      const windowRms = Math.sqrt(energy / fftSize);

      if (frame.attack !== null) {
        compared++;
        if (Math.abs(frame.attack.fluxValue - result.flux) > 1e-9) disagreements++;
      }

      for (let i = 0; i < fftSize; i++) windowed[i] = (window[i] as number) * (hann[i] as number);
      fft.magnitudes(windowed, magnitude);
      let total = 0;
      let high = 0;
      let low = 0;
      for (let k = 0; k < magnitude.length; k++) {
        const m = magnitude[k] as number;
        total += m;
        if (k >= highFrom) high += m;
        if (k >= lowFrom && k < lowTo) low += m;
      }

      observations.push({
        at: frame.at,
        rms: frame.rms,
        peak: frame.peak,
        gated: frame.gated,
        riseRatio: frame.riseRatio,
        sharpness: result.flux / Math.max(windowRms, 1e-9),
        fluxRatio: result.flux / Math.max(result.threshold, 1e-12),
        heldSharpness: result.heldFlux / Math.max(windowRms, 1e-9),
        heldFluxRatio: result.heldFlux / Math.max(result.heldThreshold, 1e-12),
        highShare: total > 0 ? high / total : 0,
        lowShare: total > 0 ? low / total : 0,
        confidentAttack: frame.attack !== null && frame.attack.flux,
      });
    }
  };

  const block = new Float32Array(RENDER_QUANTUM);
  for (let offset = 0; offset < samples.length; offset += RENDER_QUANTUM) {
    const available = Math.min(RENDER_QUANTUM, samples.length - offset);
    if (available === RENDER_QUANTUM) {
      block.set(samples.subarray(offset, offset + RENDER_QUANTUM));
    } else {
      block.fill(0);
      block.set(samples.subarray(offset, offset + available));
    }
    collect(engine.processChunk(block, offset));
  }
  collect(engine.flush());

  return { observations, disagreements, compared };
}

/** Replay observations into a fresh estimator, snapshotting as time passes. */
function profileFrom(
  observations: readonly RigObservation[],
  wantSnapshots: boolean,
  options: RigProfileOptions = {}
): { profile: RigProfile; snapshots: Snapshot[] } {
  const estimator = new RigProfileEstimator(options);
  const snapshots: Snapshot[] = [];
  let next = 0;
  for (const observation of observations) {
    estimator.observe(observation);
    while (
      wantSnapshots &&
      next < SNAPSHOTS_MS.length &&
      observation.at >= (SNAPSHOTS_MS[next] as number)
    ) {
      snapshots.push({ atMs: SNAPSHOTS_MS[next] as number, profile: estimator.profile() });
      next++;
    }
  }
  return { profile: estimator.profile(), snapshots };
}

/* -------------------------------------------------------------------------- */
/* The statistics under test                                                   */
/* -------------------------------------------------------------------------- */

type Stat = { name: string; of: (p: RigProfile) => number | null };

const WITNESS_NAMES = [
  "heldSharpness",
  "heldFluxRatio",
  "riseRatio",
  "sharpness",
  "fluxRatio",
] as const;

const STATS: Stat[] = [
  { name: "brightness", of: (p) => p.brightness },
  { name: "bassShare", of: (p) => p.bassShare },
  { name: "crest", of: (p) => p.crest },
  { name: "decayTauMs", of: (p) => p.decayTauMs },
  ...WITNESS_NAMES.flatMap((w): Stat[] => [
    { name: `${w}.floor`, of: (p) => p[w].floor },
    { name: `${w}.attack`, of: (p) => p[w].attack },
    { name: `${w}.attackLow`, of: (p) => p[w].attackLow },
    { name: `${w}.contrast`, of: (p) => p[w].contrast },
  ]),
];

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  return (
    ((sorted[Math.floor(mid)] as number) + (sorted[Math.ceil(mid)] as number)) / 2
  );
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function fixed(value: number | null, digits = 3): string {
  return value === null ? "-" : value.toFixed(digits);
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                     */
/* -------------------------------------------------------------------------- */

function reportProfiles(takes: TakeResult[]): void {
  console.log("\n  what each take reads, grouped by signal chain");
  console.log(
    `  ${pad("take", 48)}${padLeft("hops", 6)}${padLeft("bg", 6)}${padLeft(
      "atk",
      5
    )}${padLeft("bright", 8)}${padLeft("bass", 8)}${padLeft("crest", 7)}${padLeft(
      "tau ms",
      8
    )}`
  );
  for (const chain of CHAINS) {
    console.log(`  ${chain}`);
    for (const take of takes.filter((t) => t.chain === chain)) {
      const p = take.profile;
      console.log(
        `    ${pad(take.stem, 46)}${padLeft(String(p.hops), 6)}${padLeft(
          String(p.backgroundHops),
          6
        )}${padLeft(String(p.attacks), 5)}${padLeft(fixed(p.brightness), 8)}${padLeft(fixed(p.bassShare), 8)}${padLeft(
          fixed(p.crest, 2),
          7
        )}${padLeft(p.decayTauMs === null ? "-" : p.decayTauMs.toFixed(0), 8)}`
      );
    }
  }

  for (const w of WITNESS_NAMES) {
    console.log(`\n  ${w}: what it reads at confident attacks, and everywhere else`);
    console.log(
      `  ${pad("take", 48)}${padLeft("floor q90", 11)}${padLeft(
        "attack q25",
        12
      )}${padLeft("attack q50", 12)}${padLeft("contrast", 10)}`
    );
    for (const chain of CHAINS) {
      console.log(`  ${chain}`);
      for (const take of takes.filter((t) => t.chain === chain)) {
        const p = take.profile[w];
        console.log(
          `    ${pad(take.stem, 46)}${padLeft(fixed(p.floor), 11)}${padLeft(
            fixed(p.attackLow),
            12
          )}${padLeft(fixed(p.attack), 12)}${padLeft(fixed(p.contrast, 2), 10)}`
        );
      }
    }
  }
}

type Separation = {
  stat: string;
  ranges: Map<Chain, [number, number]>;
  medians: Map<Chain, number>;
  within: number;
  between: number;
  sep: number;
  overlaps: number;
  verdict: "QUALIFIES" | "marginal" | "no";
};

function separation(takes: TakeResult[], stat: Stat): Separation | null {
  const ranges = new Map<Chain, [number, number]>();
  const medians = new Map<Chain, number>();
  for (const chain of CHAINS) {
    const values = takes
      .filter((t) => t.chain === chain)
      .map((t) => stat.of(t.profile))
      .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
    if (values.length < 2) return null;
    ranges.set(chain, [Math.min(...values), Math.max(...values)]);
    medians.set(chain, median(values));
  }

  let within = 1;
  for (const [lo, hi] of ranges.values()) within = Math.max(within, hi / lo);
  const mids = [...medians.values()];
  const between = Math.max(...mids) / Math.min(...mids);

  let overlaps = 0;
  for (let i = 0; i < CHAINS.length; i++) {
    for (let j = i + 1; j < CHAINS.length; j++) {
      const a = ranges.get(CHAINS[i] as Chain) as [number, number];
      const b = ranges.get(CHAINS[j] as Chain) as [number, number];
      if (a[0] <= b[1] && b[0] <= a[1]) overlaps++;
    }
  }

  const sep = between / within;
  const verdict = sep >= 1.5 && overlaps <= 2 ? "QUALIFIES" : sep >= 1 ? "marginal" : "no";
  return { stat: stat.name, ranges, medians, within, between, sep, overlaps, verdict };
}

function reportSeparation(takes: TakeResult[]): void {
  console.log("\n  does the rig move this statistic more than the playing does?");
  console.log(
    `  ${pad("statistic", 24)}${CHAINS.map((c) => padLeft(c, 21)).join("")}${padLeft(
      "within",
      8
    )}${padLeft("between", 9)}${padLeft("sep", 7)}${padLeft("ovl", 5)}  verdict`
  );
  const rows = STATS.map((stat) => separation(takes, stat)).filter(
    (r): r is Separation => r !== null
  );
  rows.sort((a, b) => b.sep - a.sep);
  for (const row of rows) {
    const cells = CHAINS.map((chain) => {
      const [lo, hi] = row.ranges.get(chain) as [number, number];
      const digits = hi < 10 ? 3 : 0;
      return padLeft(`${lo.toFixed(digits)}-${hi.toFixed(digits)}`, 21);
    }).join("");
    console.log(
      `  ${pad(row.stat, 24)}${cells}${padLeft(row.within.toFixed(2), 8)}${padLeft(
        row.between.toFixed(2),
        9
      )}${padLeft(row.sep.toFixed(2), 7)}${padLeft(String(row.overlaps), 5)}  ${row.verdict}`
    );
  }
  console.log(
    "\n  the decisive question: is the FLUX SCALE tight within one chain, across\n" +
      "  four different performances on it? If it is not, no per-rig profile can\n" +
      "  make these witnesses comparable and the adaptation would have to be per-\n" +
      "  passage instead.\n"
  );
  console.log(
    `  ${pad("flux-family statistic", 28)}${padLeft("widest within one chain", 25)}${padLeft(
      "between chain medians",
      23
    )}${padLeft("verdict", 16)}`
  );
  for (const name of [
    "sharpness.floor",
    "heldSharpness.floor",
    "fluxRatio.floor",
    "heldFluxRatio.floor",
    "sharpness.attack",
    "heldSharpness.attack",
    "fluxRatio.attack",
    "heldFluxRatio.attack",
  ]) {
    const row = rows.find((r) => r.stat === name);
    if (row === undefined) continue;
    console.log(
      `  ${pad(name, 28)}${padLeft(`${row.within.toFixed(2)}x`, 25)}${padLeft(
        `${row.between.toFixed(2)}x`,
        23
      )}${padLeft(row.within < row.between ? "rig leads" : "playing leads", 16)}`
    );
  }

  const qualifying = rows.filter((r) => r.verdict === "QUALIFIES");
  console.log(
    `\n  ${qualifying.length} of ${rows.length} statistics qualify: ${
      qualifying.map((r) => r.stat).join(", ") || "none"
    }`
  );
}

function reportWarmup(takes: TakeResult[]): void {
  console.log(
    `\n  warm-up: source time before a statistic stays within ${
      SETTLED_TOLERANCE * 100
    }% of its final value`
  );
  console.log(
    `  ${pad("statistic", 24)}${padLeft("median", 9)}${padLeft("worst", 8)}${padLeft(
      "never",
      7
    )}  per-take settle times, ms`
  );
  for (const stat of STATS) {
    const settled: number[] = [];
    let never = 0;
    for (const take of takes) {
      const final = stat.of(take.profile);
      if (final === null || !Number.isFinite(final) || final <= 0) continue;
      const series = take.snapshots
        .map((s) => ({ atMs: s.atMs, value: stat.of(s.profile) }))
        .filter((s): s is { atMs: number; value: number } => s.value !== null);
      let settleAt: number | null = null;
      for (let i = 0; i < series.length; i++) {
        const ok = series
          .slice(i)
          .every((s) => Math.abs(s.value - final) <= SETTLED_TOLERANCE * final);
        if (ok) {
          settleAt = (series[i] as { atMs: number }).atMs;
          break;
        }
      }
      if (settleAt === null) never++;
      else settled.push(settleAt);
    }
    if (settled.length === 0) {
      console.log(`  ${pad(stat.name, 24)}${padLeft("-", 9)}${padLeft("-", 8)}${padLeft(String(never), 7)}`);
      continue;
    }
    console.log(
      `  ${pad(stat.name, 24)}${padLeft(median(settled).toFixed(0), 9)}${padLeft(
        Math.max(...settled).toFixed(0),
        8
      )}${padLeft(String(never), 7)}  ${settled
        .slice()
        .sort((a, b) => a - b)
        .join(" ")}`
    );
  }
  console.log(
    "\n  `never` counts takes whose estimate was still moving at the last snapshot,"
  );
  console.log(
    "  which on a take shorter than the statistic needs is a fact about the take."
  );
}


/* -------------------------------------------------------------------------- */
/* The holdoff sweep, on the derivation fixtures only                          */
/* -------------------------------------------------------------------------- */

/**
 * `ATTACK_HOLDOFF_MS` decides which hops are allowed to set a floor. Too short
 * and the attack's own ring-out sets the floor it is measured against; too long
 * and dense playing has no hop left that belongs to no attack.
 *
 * Swept on the five 120bpm fixtures, which is where every constant in this
 * project is derived, and reported against a sixteenths take from each 140bpm
 * chain purely to show where the estimate stops being available at all.
 */
function reportHoldoff(takes: TakeResult[]): void {
  const sweep = [0, 20, 40, 60, 80, 100, 140, 200];
  const derivation = takes.filter((t) => t.chain === "120bpm original");
  const dense = takes.filter((t) => t.stem.includes("sixteenths"));

  console.log("\n  ATTACK_HOLDOFF_MS swept: heldSharpness.floor on the five derivation takes");
  console.log(
    `  ${pad("holdoff ms", 12)}${derivation
      .map((t) => padLeft(t.stem.slice(0, 16), 18))
      .join("")}${padLeft("min bg hops", 13)}`
  );
  for (const attackHoldoffMs of sweep) {
    const floors = derivation.map(
      (t) => profileFrom(t.observations, false, { attackHoldoffMs }).profile
    );
    console.log(
      `  ${pad(String(attackHoldoffMs), 12)}${floors
        .map((p) => padLeft(fixed(p.heldSharpness.floor), 18))
        .join("")}${padLeft(String(Math.min(...floors.map((p) => p.backgroundHops))), 13)}`
    );
  }

  console.log("\n  and what is left to measure on the densest playing in the corpus");
  console.log(
    `  ${pad("holdoff ms", 12)}${dense.map((t) => padLeft(t.stem.slice(0, 20), 22)).join("")}`
  );
  for (const attackHoldoffMs of sweep) {
    const cells = dense.map((t) => {
      const p = profileFrom(t.observations, false, { attackHoldoffMs }).profile;
      return padLeft(`${p.backgroundHops} hops ${fixed(p.heldSharpness.floor, 2)}`, 22);
    });
    console.log(`  ${pad(String(attackHoldoffMs), 12)}${cells.join("")}`);
  }
}

/* -------------------------------------------------------------------------- */
/* The decisive test: does a profile make the witnesses comparable?            */
/* -------------------------------------------------------------------------- */

/**
 * Which profile floor each decision witness is measured against.
 *
 * `measure-decision-separability.ts` found the twelve witnesses are about four:
 * one flux divided four ways and one envelope divided two. So each flux witness
 * is divided by that same witness's own floor on this rig, and both envelope
 * witnesses by the `riseRatio` floor. Nothing else is touched — `soundedMs` and
 * the booleans are not scale-dependent, and `decayExcess` is already a ratio
 * against a per-Note fit.
 */
const NORMALISED_BY: Readonly<Record<string, keyof RigProfile>> = {
  sharpness: "sharpness",
  heldSharpness: "heldSharpness",
  fluxRatio: "fluxRatio",
  heldFluxRatio: "heldFluxRatio",
  riseRatio: "riseRatio",
  envelopeOverBaseline: "riseRatio",
};

type Witnessed = Extract<keyof RigProfile, "sharpness" | "heldSharpness" | "fluxRatio" | "heldFluxRatio" | "riseRatio">;

/** How a witness is rescaled by a profile. */
type Mode = "divide" | "affine";

/**
 * Rescale the scale-dependent witnesses of every row by a profile.
 *
 * `divide` puts each reading in units of what this rig's own quiet hops do:
 * "1.0" means "no sharper than this signal is when nothing was struck".
 * `affine` also uses the attack quantile, mapping the floor to 0 and the median
 * confident attack to 1, which is a stronger claim — it assumes the profile
 * knows the top of the range as well as the bottom.
 *
 * A profile with no floor yet (too few background hops) leaves its rows alone
 * and is counted, because silently passing them through would hide exactly the
 * takes where calibration is unavailable.
 */
function rescale(
  rows: readonly Row[],
  profileOf: (stem: string) => RigProfile | null,
  mode: Mode
): { rows: Row[]; uncalibrated: number } {
  let uncalibrated = 0;
  const out = rows.map((row) => {
    const profile = profileOf(row.stem);
    if (profile === null) {
      uncalibrated++;
      return row;
    }
    const x = row.x.slice();
    let missed = false;
    FEATURES.forEach((name, i) => {
      const key = NORMALISED_BY[name];
      if (key === undefined) return;
      const witness = profile[key as Witnessed];
      const floor = witness.floor;
      if (floor === null || floor <= 0) {
        missed = true;
        return;
      }
      if (mode === "divide") {
        x[i] = (row.x[i] as number) / floor;
        return;
      }
      const attack = witness.attack;
      if (attack === null || attack <= floor) {
        missed = true;
        return;
      }
      x[i] = ((row.x[i] as number) - floor) / (attack - floor);
    });
    if (missed) uncalibrated++;
    return { ...row, x };
  });
  return { rows: out, uncalibrated };
}

/** Leave-one-take-out AUC and the zero-label-cost operating point. */
function loto(rows: readonly Row[], lambda: number): { auc: number; fp: string } {
  const cols = FEATURES.map((_, i) => i);
  const stems = [...new Set(rows.map((r) => r.stem))];
  const folds = rows.map((r) => stems.indexOf(r.stem));
  const y = rows.map((r) => r.y);
  const scores = outOfFold(rows, cols, folds, lambda);
  const zc = zeroCost(scores, y);
  return { auc: auc(scores, y), fp: `${zc.falseAccepts} / ${zc.negatives}` };
}

/**
 * The experiment the whole premise turns on.
 *
 * `measure-decision-separability.ts` measured the same twelve witnesses under a
 * fit whose folds MIX takes (5-fold, AUC 0.758) and under one that holds a whole
 * take out (0.434, worse than chance). The gap is the model learning each take's
 * own scale. If a rig profile makes the witnesses comparable across takes, then
 * rescaling by it must move the leave-one-take-out figure toward the mixed-fold
 * one. If it does not, per-rig calibration does not address this defect and the
 * result is a negative that saves building it.
 *
 * Three calibrations, and the difference between them is the whole discipline:
 *
 *   same-take     the take's own profile. An UPPER BOUND and nothing else: the
 *                 profile is unsupervised, but it is still measured on the
 *                 audio being scored.
 *   cross-take    the median profile of the OTHER takes of that chain. This is
 *                 the honest one — it answers whether calibration transfers
 *                 across playing styles on one rig, which is what a user gets
 *                 after a minute on their own rig.
 *   all-other     the median profile of every other take in the corpus,
 *                 ignoring which chain it came from. The control: if this does
 *                 as well as cross-take, nothing rig-specific is being learned
 *                 and the gain is just a global rescaling.
 */
function reportNormalisation(takes: TakeResult[], lambda: number): void {
  const rows = collect();
  const byStem = new Map(takes.map((t) => [t.stem, t]));

  /** A profile whose every field is the median of the given takes'. */
  const pooled = (group: TakeResult[]): RigProfile | null => {
    if (group.length === 0) return null;
    const pick = (f: (p: RigProfile) => number | null): number | null => {
      const values = group.map((t) => f(t.profile)).filter((v): v is number => v !== null);
      return values.length === 0 ? null : median(values);
    };
    const witness = (w: Witnessed) => ({
      attack: pick((p) => p[w].attack),
      attackLow: pick((p) => p[w].attackLow),
      floor: pick((p) => p[w].floor),
      contrast: pick((p) => p[w].contrast),
    });
    return {
      hops: 0,
      attacks: 0,
      backgroundHops: 0,
      elapsedMs: 0,
      brightness: pick((p) => p.brightness),
      bassShare: pick((p) => p.bassShare),
      crest: pick((p) => p.crest),
      decayTauMs: pick((p) => p.decayTauMs),
      heldSharpness: witness("heldSharpness"),
      heldFluxRatio: witness("heldFluxRatio"),
      riseRatio: witness("riseRatio"),
      sharpness: witness("sharpness"),
      fluxRatio: witness("fluxRatio"),
    };
  };

  const sameTake = (stem: string): RigProfile | null => byStem.get(stem)?.profile ?? null;
  const crossTake = (stem: string): RigProfile | null => {
    const take = byStem.get(stem);
    if (take === undefined) return null;
    return pooled(takes.filter((t) => t.chain === take.chain && t.stem !== stem));
  };
  const allOther = (stem: string): RigProfile | null =>
    pooled(takes.filter((t) => t.stem !== stem));

  const derivation = rows.filter((r) => !r.stem.includes("140bpm"));

  console.log(
    "\n  does calibration make the witnesses comparable across takes?" +
      `\n  leave-one-take-out AUC over the twelve decision witnesses, lambda ${lambda}\n`
  );
  console.log(
    `  ${pad("calibration", 34)}${padLeft("derivation LOTO", 17)}${padLeft(
      "FP at zero cost",
      17
    )}${padLeft("all 17 takes LOTO", 19)}${padLeft("FP at zero cost", 17)}${padLeft(
      "uncal rows",
      12
    )}`
  );

  const variants: Array<[string, (stem: string) => RigProfile | null, Mode | null]> = [
    ["raw (nothing calibrated)", () => null, null],
    ["same-take, divide  UPPER BOUND", sameTake, "divide"],
    ["same-take, affine  UPPER BOUND", sameTake, "affine"],
    ["cross-take within chain, divide", crossTake, "divide"],
    ["cross-take within chain, affine", crossTake, "affine"],
    ["all-other takes, divide", allOther, "divide"],
  ];

  for (const [name, profileOf, mode] of variants) {
    const d = mode === null ? { rows: derivation, uncalibrated: 0 } : rescale(derivation, profileOf, mode);
    const a = mode === null ? { rows: [...rows], uncalibrated: 0 } : rescale(rows, profileOf, mode);
    const dLoto = loto(d.rows, lambda);
    const aLoto = loto(a.rows, lambda);
    console.log(
      `  ${pad(name, 34)}${padLeft(dLoto.auc.toFixed(3), 17)}${padLeft(
        dLoto.fp,
        17
      )}${padLeft(aLoto.auc.toFixed(3), 19)}${padLeft(aLoto.fp, 17)}${padLeft(
        String(a.uncalibrated),
        12
      )}`
    );
  }

  console.log(
    "\n  The comparison point is the mixed-fold figure from" +
      " measure-decision-separability.ts:\n  5-fold folds that MIX takes reach 0.758 on the" +
      " same rows and the same fit, while\n  holding a whole take out reaches 0.434. Anything" +
      " that closes that gap has made\n  the witnesses comparable across takes; anything that" +
      " does not, has not."
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const holdoffOnly = args.includes("--holdoff");
  const normaliseOnly = args.includes("--normalise");
  const wantWarmup = !verifyOnly && !holdoffOnly && !normaliseOnly;

  const takes: TakeResult[] = [];
  for (const fixture of decodeFixtures({ quiet: true })) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const mono = downmixToMono(wav.samples, wav.channels);
    const collected = observationsOf(mono, wav.sampleRate);
    const { profile, snapshots } = profileFrom(collected.observations, wantWarmup);
    takes.push({
      stem: fixture.stem,
      chain: chainOf(fixture.stem),
      profile,
      snapshots,
      ...collected,
    });
  }

  const disagreements = takes.reduce((n, t) => n + t.disagreements, 0);
  const compared = takes.reduce((n, t) => n + t.compared, 0);
  console.log(
    `\n  mirror: ${disagreements} disagreements over ${compared} hops the real kernel reported`
  );
  if (disagreements > 0) {
    console.log("  the mirror does not reproduce the kernel; nothing below is trustworthy");
    return;
  }
  if (verifyOnly) return;

  if (holdoffOnly) {
    reportHoldoff(takes);
    return;
  }
  if (normaliseOnly) {
    reportNormalisation(takes, NORMALISATION_LAMBDA);
    return;
  }

  reportProfiles(takes);
  reportSeparation(takes);
  reportWarmup(takes);
  reportNormalisation(takes, NORMALISATION_LAMBDA);
}

main();
