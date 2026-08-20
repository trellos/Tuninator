/**
 * If the recogniser were told exactly what the signal chain does, would it
 * analyse that chain any better?
 *
 * This is the CEILING of the per-rig calibration idea and it is deliberately
 * fit on the test set: the profile for a chain is pooled from every take in
 * that chain, including the take being scored, and it is fully warmed before a
 * single sample is analysed. No deployed system can do either. The number is
 * therefore not an achievement and must never be quoted as one — it is an upper
 * bound, and its only job is to settle a direction.
 *
 *   If the ceiling is no better than the uncalibrated baseline, per-rig
 *   calibration is finished as an idea, whatever a proxy measurement says.
 *
 *   If the ceiling is substantially better, the proxy that said calibration
 *   would not help was measuring the wrong thing, and the real question becomes
 *   how much of the gain survives honest cross-take calibration — which is the
 *   third variant below, and it is free because each LP chain has four takes.
 *
 * `measure-decision-separability.ts` already asked a version of this question in
 * AUC and answered no. AUC is not the product: it scores a witness's ranking at
 * candidate hops, and the recogniser's output is Notes. So this script scores
 * Notes — the same three quantities the baseline is quoted in.
 *
 *   MISSED         `matchEvents` found no detection for a labelled event.
 *                  Identical to `measure-downstream-ledger.ts --all`.
 *   split/extras   how many labelled events came out as more than one Note.
 *                  Identical to `measure-splits.ts`, same ownership rule.
 *   strays         Notes belonging to no labelled event at all.
 *
 * WHAT IS WIRED, AND WHAT IS NOT
 *
 * `EngineConfig.calibration` carries three multipliers and nothing else, and
 * `fast/rearticulation.ts` applies them to the five bars that are levels on a
 * scale the signal chain sets. The choice of which bars comes from the two
 * statistics that qualified as rig-like in `measure-rig-profile.ts`
 * (`sharpness.floor` and `heldSharpness.floor`, 1.6x within a chain against
 * 3.0x between) and from nothing else:
 *
 *   sharpnessScale       rearticulationSharpness, newPitchSharpness
 *   heldSharpnessScale   restrumSharpness
 *   fluxRatioScale       restrumFluxRatio, ringOutFluxRatio
 *
 * The flux-RATIO family is included so its contribution can be measured and
 * refused separately (`--families`), not because the evidence asks for it: those
 * witnesses are already divided by the kernel's own running median, and
 * `heldFluxRatio.floor` separates chains at 1.14 — barely above the playing.
 * The same argument keeps `transient.fluxSensitivity` OUT entirely: it
 * multiplies an adaptive median, so it is self-normalising by construction and
 * a rig scale applied to it would be applied twice.
 *
 * THE CONTROL
 *
 * Multiplying a bar by a rig floor changes what the bar means, so the first
 * variant run is `UNCALIBRATED` — every multiplier exactly 1. It must reproduce
 * the shipped numbers exactly, per fixture, or nothing below it can be trusted;
 * the script says so in as many words and exits non-zero if it does not.
 *
 * Usage:
 *   npx tsx scripts/measure-rig-ceiling.ts              control, ceiling, cross-take
 *   npx tsx scripts/measure-rig-ceiling.ts --reference  the pooled 120bpm floors
 *   npx tsx scripts/measure-rig-ceiling.ts --families   ceiling, one family at a time
 *   npx tsx scripts/measure-rig-ceiling.ts --controls   + a global rise, for contrast
 *   npx tsx scripts/measure-rig-ceiling.ts --detail     per-fixture rows for every variant
 */

import { readFileSync } from "node:fs";
import {
  RigProfileEstimator,
  calibrationFrom,
  UNCALIBRATED,
  REFERENCE_SHARPNESS_FLOOR,
  REFERENCE_HELD_SHARPNESS_FLOOR,
  REFERENCE_HELD_FLUX_RATIO_FLOOR,
  type RigCalibration,
  type RigObservation,
  type RigProfile,
} from "../src/engine/rig-profile.js";
import { analyzeSamples } from "../src/offline/analyzer.js";
import { projectEmissions } from "../src/offline/eval-adapter.js";
import { matchEvents, type LabeledEvent } from "../src/offline/matcher.js";
import { downmixToMono, readWav } from "../src/offline/wav.js";
import { decodeFixtures } from "./decode-fixtures.js";
import { CHAINS, chainOf, observationsOf, type Chain } from "./measure-rig-profile.js";

/**
 * Ownership rule for the split count, copied from `measure-splits.ts` so the
 * two report the same quantity. See that file for why it is "nearest label"
 * rather than "most recent within a tolerance".
 */
const ONSET_TOLERANCE_MS = 40;
const ORPHAN_GAP_MS = 400;

/**
 * Silence inserted between two takes when they are pooled into one profile.
 *
 * The estimator reads source time, so takes concatenated head to tail would
 * hand it a clock that jumps backwards — and a backwards jump lands inside the
 * attack holdoff, which would drop the opening of every take but the first out
 * of the floor. A gap longer than any holdoff cannot do that.
 */
const POOL_GAP_MS = 5000;

/**
 * Background hops one pooled chain profile may hold.
 *
 * Four takes overrun the live default of 5000, and a profile that forgets is
 * exactly wrong here: pooling the chain is the point. This is an offline
 * setting for an offline question, and it is the only estimator option this
 * script moves.
 */
const POOL_CAPACITY = 100000;

/**
 * What the uncalibrated control has to score, whole corpus.
 *
 * Not a threshold — a tripwire. The control row runs `UNCALIBRATED`, so it must
 * reproduce the shipped recogniser exactly; if it does not, either the
 * calibration has leaked into the default path or the recogniser itself has
 * moved, and every delta below it is measured against the wrong thing. Matches
 * `measure-downstream-ledger.ts --all` and `measure-splits.ts` on the head this
 * was written against. A deliberate change to the recogniser re-derives these
 * from those two scripts.
 */
const CONTROL = { missed: 32, split: 99, extras: 107, strays: 10 };

type Take = {
  stem: string;
  chain: Chain;
  samples: Float32Array;
  sampleRate: number;
  labels: LabeledEvent[];
  observations: RigObservation[];
};

/** What one take scored under one calibration. */
type Score = {
  stem: string;
  chain: Chain;
  labels: number;
  detections: number;
  missed: number;
  /**
   * Matched events whose Note carried the RIGHT name.
   *
   * The eval's accuracy, over the whole take rather than per section: a
   * calibration that removed fragments but renamed what is left has not made
   * the analysis more accurate, and only this column would say so.
   */
  named: number;
  split: number;
  extras: number;
  strays: number;
};

/* -------------------------------------------------------------------------- */
/* Pass one: the profile                                                       */
/* -------------------------------------------------------------------------- */

/** Pool the given takes' per-hop evidence into one profile. */
function pool(takes: readonly Take[]): RigProfile {
  const estimator = new RigProfileEstimator({
    backgroundCapacity: POOL_CAPACITY,
    attackCapacity: POOL_CAPACITY,
  });
  let offset = 0;
  for (const take of takes) {
    let last = 0;
    for (const observation of take.observations) {
      estimator.observe({ ...observation, at: observation.at + offset });
      last = observation.at;
    }
    offset += last + POOL_GAP_MS;
  }
  return estimator.profile();
}

/** Zero out the families this run is not testing. */
function restrict(calibration: RigCalibration, families: readonly string[]): RigCalibration {
  return {
    sharpnessScale: families.includes("sharp") ? calibration.sharpnessScale : 1,
    heldSharpnessScale: families.includes("held") ? calibration.heldSharpnessScale : 1,
    fluxRatioScale: families.includes("ratio") ? calibration.fluxRatioScale : 1,
  };
}

/* -------------------------------------------------------------------------- */
/* Pass two: recognition                                                       */
/* -------------------------------------------------------------------------- */

function score(take: Take, calibration: RigCalibration): Score {
  const analysis = analyzeSamples(take.samples, take.sampleRate, { calibration });
  const detections = projectEmissions(analysis.emissions).final;
  const result = matchEvents(take.labels, detections);
  const missed = result.missed.length;
  const named = result.matches.filter((m) => m.agreement.exact).length;

  const labels = [...take.labels].sort((a, b) => a.startMs - b.startMs);
  const owned = new Map<string, number>(labels.map((l) => [l.id, 0]));
  let strays = 0;
  for (const detection of detections) {
    let owner: LabeledEvent | null = null;
    for (const candidate of labels) {
      if (detection.startedAt + ONSET_TOLERANCE_MS < candidate.startMs) break;
      owner = candidate;
    }
    if (owner === null || detection.startedAt > owner.endMs + ORPHAN_GAP_MS) {
      strays++;
      continue;
    }
    owned.set(owner.id, (owned.get(owner.id) ?? 0) + 1);
  }

  let split = 0;
  let extras = 0;
  for (const count of owned.values()) {
    if (count > 1) {
      split++;
      extras += count - 1;
    }
  }

  return {
    stem: take.stem,
    chain: take.chain,
    labels: labels.length,
    detections: detections.length,
    missed,
    named,
    split,
    extras,
    strays,
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

type Totals = {
  labels: number;
  missed: number;
  named: number;
  split: number;
  extras: number;
  strays: number;
};

function totals(scores: readonly Score[]): Totals {
  return scores.reduce<Totals>(
    (sum, s) => ({
      labels: sum.labels + s.labels,
      missed: sum.missed + s.missed,
      named: sum.named + s.named,
      split: sum.split + s.split,
      extras: sum.extras + s.extras,
      strays: sum.strays + s.strays,
    }),
    { labels: 0, missed: 0, named: 0, split: 0, extras: 0, strays: 0 }
  );
}

function delta(now: number, base: number): string {
  const d = now - base;
  return d === 0 ? "  ." : (d > 0 ? `+${d}` : String(d)).padStart(3);
}

function chainTable(
  title: string,
  runs: ReadonlyArray<{ name: string; scores: Score[] }>,
  baseline: readonly Score[]
): void {
  console.log(`\n  ${title}`);
  console.log(
    `  ${pad("chain", 18)}${pad("variant", 22)}${padLeft("labels", 7)}${padLeft(
      "missed",
      8
    )}${padLeft("d", 4)}${padLeft("named", 7)}${padLeft("d", 4)}${padLeft("split", 7)}${padLeft("d", 4)}${padLeft(
      "extras",
      8
    )}${padLeft("d", 4)}${padLeft("strays", 8)}${padLeft("d", 4)}`
  );
  for (const chain of [...CHAINS, null]) {
    for (const run of runs) {
      const pick = (rows: readonly Score[]): Score[] =>
        chain === null ? [...rows] : rows.filter((r) => r.chain === chain);
      const now = totals(pick(run.scores));
      const was = totals(pick(baseline));
      console.log(
        `  ${pad(chain ?? "ALL", 18)}${pad(run.name, 22)}${padLeft(String(now.labels), 7)}${padLeft(
          String(now.missed),
          8
        )}${padLeft(delta(now.missed, was.missed), 4)}${padLeft(String(now.named), 7)}${padLeft(
          delta(now.named, was.named),
          4
        )}${padLeft(String(now.split), 7)}${padLeft(
          delta(now.split, was.split),
          4
        )}${padLeft(String(now.extras), 8)}${padLeft(delta(now.extras, was.extras), 4)}${padLeft(
          String(now.strays),
          8
        )}${padLeft(delta(now.strays, was.strays), 4)}`
      );
    }
    console.log("");
  }
}

function detailTable(runs: ReadonlyArray<{ name: string; scores: Score[] }>): void {
  const base = runs[0] as { name: string; scores: Score[] };
  console.log("\n  per fixture: missed / named / split / extras / strays\n");
  const width = Math.max(...base.scores.map((s) => s.stem.length));
  console.log(
    `  ${pad("fixture", width + 2)}${runs.map((r) => padLeft(r.name, 26)).join("")}`
  );
  for (let i = 0; i < base.scores.length; i++) {
    const cells = runs.map((run) => {
      const s = run.scores[i] as Score;
      return padLeft(
        `${s.missed} / ${s.named} / ${s.split} / ${s.extras} / ${s.strays}`,
        26
      );
    });
    console.log(`  ${pad((base.scores[i] as Score).stem, width + 2)}${cells.join("")}`);
  }
}

/* -------------------------------------------------------------------------- */

function loadTakes(): Take[] {
  const takes: Take[] = [];
  for (const fixture of decodeFixtures({ quiet: true })) {
    const wav = readWav(readFileSync(fixture.wavPath));
    const samples = downmixToMono(wav.samples, wav.channels);
    const { observations } = observationsOf(samples, wav.sampleRate);
    takes.push({
      stem: fixture.stem,
      chain: chainOf(fixture.stem),
      samples,
      sampleRate: wav.sampleRate,
      labels: fixture.label.events as LabeledEvent[],
      observations,
    });
  }
  return takes;
}

function fixed(value: number | null, digits = 3): string {
  return value === null ? "-" : value.toFixed(digits);
}

function main(): void {
  const args = process.argv.slice(2);
  const takes = loadTakes();
  const byChain = new Map<Chain, Take[]>(
    CHAINS.map((chain) => [chain, takes.filter((t) => t.chain === chain)])
  );

  if (args.includes("--reference")) {
    console.log("\n  pooled profile per chain — the floors a calibration is read from\n");
    console.log(
      `  ${pad("chain", 18)}${padLeft("takes", 6)}${padLeft("hops", 8)}${padLeft(
        "bg",
        7
      )}${padLeft("atk", 6)}${padLeft("sharp.floor", 13)}${padLeft(
        "held.floor",
        12
      )}${padLeft("heldRatio.floor", 17)}`
    );
    for (const chain of CHAINS) {
      const profile = pool(byChain.get(chain) as Take[]);
      console.log(
        `  ${pad(chain, 18)}${padLeft(String((byChain.get(chain) as Take[]).length), 6)}${padLeft(
          String(profile.hops),
          8
        )}${padLeft(String(profile.backgroundHops), 7)}${padLeft(
          String(profile.attacks),
          6
        )}${padLeft(fixed(profile.sharpness.floor), 13)}${padLeft(
          fixed(profile.heldSharpness.floor),
          12
        )}${padLeft(fixed(profile.heldFluxRatio.floor), 17)}`
      );
    }
    console.log(
      `\n  in the code now: sharpness ${REFERENCE_SHARPNESS_FLOOR}, ` +
        `heldSharpness ${REFERENCE_HELD_SHARPNESS_FLOOR}, ` +
        `heldFluxRatio ${REFERENCE_HELD_FLUX_RATIO_FLOOR}\n`
    );
    return;
  }

  // The control the earlier finding taught this file to run. A chain profile
  // raises the sharpness bars on the two coloured paths, and RAISING A BAR
  // trades extras for misses all by itself. So two things have to be told
  // apart: what the calibration buys, and what any bar rise would have bought.
  //
  //  - "one profile, no chains" pools all seventeen takes into a single
  //    calibration applied everywhere. Everything rig-specific is gone and
  //    only the global rescaling remains.
  //  - "uniform xK" multiplies the two sharpness families by a constant on
  //    every take, tracing the trade-off curve directly. A calibration worth
  //    having lands OFF that curve — fewer extras at the same misses. One that
  //    lands on it is "raise the bars" with a measurement stapled to it.
  const controls = args.includes("--controls");
  const UNIFORM = [1.25, 1.5, 2.0, 2.5];

  const families = args.includes("--families")
    ? [["sharp"], ["held"], ["ratio"], ["sharp", "held", "ratio"]]
    : [["sharp", "held", "ratio"]];

  // The ceiling: one profile per chain, pooled over every take in it, the take
  // being scored included. Fit on test, on purpose.
  const ceiling = new Map<Chain, RigCalibration>(
    CHAINS.map((chain) => [chain, calibrationFrom(pool(byChain.get(chain) as Take[]))])
  );

  // The honest number: the same pooling with the scored take left out.
  const crossTake = new Map<string, RigCalibration>();
  for (const take of takes) {
    const others = (byChain.get(take.chain) as Take[]).filter((t) => t.stem !== take.stem);
    crossTake.set(take.stem, calibrationFrom(pool(others)));
  }

  console.log("\n  the multipliers each chain's pooled profile implies\n");
  console.log(
    `  ${pad("chain", 18)}${padLeft("sharpness", 11)}${padLeft("heldSharp", 11)}${padLeft(
      "fluxRatio",
      11
    )}`
  );
  for (const chain of CHAINS) {
    const c = ceiling.get(chain) as RigCalibration;
    console.log(
      `  ${pad(chain, 18)}${padLeft(c.sharpnessScale.toFixed(3), 11)}${padLeft(
        c.heldSharpnessScale.toFixed(3),
        11
      )}${padLeft(c.fluxRatioScale.toFixed(3), 11)}`
    );
  }

  const control = takes.map((take) => score(take, UNCALIBRATED));
  const runs: Array<{ name: string; scores: Score[] }> = [
    { name: "control (all ones)", scores: control },
  ];

  for (const family of families) {
    const tag = family.length === 3 ? "" : ` [${family.join("+")}]`;
    runs.push({
      name: `CEILING fit-on-test${tag}`,
      scores: takes.map((take) =>
        score(take, restrict(ceiling.get(take.chain) as RigCalibration, family))
      ),
    });
    runs.push({
      name: `cross-take honest${tag}`,
      scores: takes.map((take) =>
        score(take, restrict(crossTake.get(take.stem) as RigCalibration, family))
      ),
    });
  }

  if (controls) {
    const global = calibrationFrom(pool(takes));
    console.log(
      `\n  one profile over all seventeen takes: sharpness ${global.sharpnessScale.toFixed(
        3
      )}  heldSharp ${global.heldSharpnessScale.toFixed(
        3
      )}  fluxRatio ${global.fluxRatioScale.toFixed(3)}`
    );
    runs.push({
      name: "one profile, no chains",
      scores: takes.map((take) => score(take, global)),
    });
    for (const k of UNIFORM) {
      runs.push({
        name: `uniform x${k.toFixed(2)}`,
        scores: takes.map((take) =>
          score(take, { sharpnessScale: k, heldSharpnessScale: k, fluxRatioScale: 1 })
        ),
      });
    }
  }

  const check = totals(control);
  const drifted =
    check.missed !== CONTROL.missed ||
    check.split !== CONTROL.split ||
    check.extras !== CONTROL.extras ||
    check.strays !== CONTROL.strays;

  chainTable("end-to-end recognition, by signal chain", runs, control);
  if (args.includes("--detail")) detailTable(runs);

  console.log(
    "\n  The CEILING rows are fit on the take they score and warmed before it\n" +
      "  starts. They are an upper bound on what any per-rig calibration could\n" +
      "  reach, never a result. The cross-take rows are what an honest one gets.\n"
  );

  if (drifted) {
    console.error(
      `  CONTROL DRIFTED: all-ones scored ${check.missed} / ${check.split} / ` +
        `${check.extras} / ${check.strays}, expected ${CONTROL.missed} / ` +
        `${CONTROL.split} / ${CONTROL.extras} / ${CONTROL.strays}.\n` +
        "  Every delta above is measured against a baseline that no longer holds.\n"
    );
    process.exitCode = 1;
  }
}

main();
