/**
 * What this signal chain does to a guitar, measured while it plays.
 *
 * Every fixed threshold in the detector is a compromise across rigs that have
 * nothing in common. The contrast between a genuine pick and the noise a
 * decaying string makes on its own varies by more than an order of magnitude
 * across this corpus, so a bar that separates the two on a direct input is
 * either deaf on an amp sim or chops chords on a room mic. `NoiseFloorTracker`
 * already solved the same problem for the amplitude gate by measuring the rig
 * instead of assuming it; this is the same move for the transient witnesses.
 *
 * What it accumulates is a statistic of the RIG, not of the playing:
 *
 *  - the witness readings at hops the detector was confident about, against
 *    the readings at ordinary above-gate hops. The ratio between them is the
 *    headroom a threshold on that witness actually has HERE — which is the
 *    figure that varies across rigs and that no constant can stand in for.
 *  - how bright the chain is (share of frame magnitude above `HIGH_HZ`) and how
 *    much of the guitar's fundamental range survives it. A room mic and a
 *    direct input differ here for a physical reason rather than a statistical
 *    one.
 *  - crest factor, which is what a compressor takes away.
 *  - the time constant of a struck note's decay, fitted by `VoiceDecay` — the
 *    same fit the tracker already uses per Note, pooled per rig.
 *
 * Everything is a quantile over a bounded ring of recent observations. Medians
 * and quantiles rather than means throughout, because one loud stroke, one
 * dropped pick or one cough must not move a profile; and bounded rather than
 * cumulative, because a rig is something the player can change mid-session.
 *
 * This file decides nothing. It reports; whether anything reads the report is
 * a separate question with its own evidence.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { SourceTimeMs } from "../types.js";
import { VoiceDecay } from "./tracker/voices.js";

/**
 * One hop of evidence about the rig.
 *
 * Deliberately the SAME readings the fast lane already computes every hop —
 * `FastFrame` plus the flux kernel's per-hop witnesses — and no new DSP. A
 * profile that needs its own analysis is a second detector, and a second
 * detector is a second thing to be wrong.
 */
export type RigObservation = {
  at: SourceTimeMs;
  /** Long-window RMS, as `FastFrame.rms`. */
  rms: number;
  /** Long-window peak, as `FastFrame.peak`. */
  peak: number;
  /** The engine's amplitude gate closed on this hop. */
  gated: boolean;
  /** `AttackEvidence.riseRatio`, computed every hop whether or not one fired. */
  riseRatio: number;
  /** `AttackEvidence.sharpness`, every hop. */
  sharpness: number;
  /** `AttackEvidence.fluxRatio`, every hop. */
  fluxRatio: number;
  /** `AttackEvidence.heldSharpness`, every hop. */
  heldSharpness: number;
  /** `AttackEvidence.heldFluxRatio`, every hop. */
  heldFluxRatio: number;
  /** Share of this frame's magnitude above `HIGH_HZ`. */
  highShare: number;
  /** Share of this frame's magnitude inside the guitar's fundamental range. */
  lowShare: number;
  /**
   * The detector was CONFIDENT something was struck here.
   *
   * Confident means the flux kernel fired, not merely that the envelope rose:
   * the envelope witness is the one that fires on a swell, a bend and a hand
   * moving across the strings, and a profile built on those is a profile of
   * everything except picks. This is the detector's own opinion, so the profile
   * describes the population the detector actually acts on rather than a
   * population only a labelled corpus could name.
   */
  confidentAttack: boolean;
};

/** The rig, as far as the evidence so far can say. Nulls mean "not yet". */
export type RigProfile = {
  /** Above-gate hops folded in. */
  hops: number;
  /** Confident attacks folded in. */
  attacks: number;
  /** Above-gate hops that belonged to no attack, and so set the floors. */
  backgroundHops: number;
  /** Source time between the first and last observation. */
  elapsedMs: number;

  /** Median share of magnitude above `HIGH_HZ`, over above-gate hops. */
  brightness: number | null;
  /** Median share of magnitude in the fundamental range, over above-gate hops. */
  bassShare: number | null;
  /** Median peak/RMS over above-gate hops. Compression takes this down. */
  crest: number | null;
  /** Median fitted decay time constant of a struck note, ms. */
  decayTauMs: number | null;

  /** Per-witness contrast. See `WitnessProfile`. */
  heldSharpness: WitnessProfile;
  heldFluxRatio: WitnessProfile;
  riseRatio: WitnessProfile;
  sharpness: WitnessProfile;
  fluxRatio: WitnessProfile;
};

/**
 * What one transient witness reads on this rig, at attacks and everywhere else.
 *
 * `floor` is the HIGH quantile of ordinary hops rather than their median: a
 * threshold's job is to sit above what the signal does when nothing is being
 * played, and what it does at its 90th percentile is that bar. `attackLow` is
 * a LOW quantile of confident attacks for the mirrored reason — a threshold has
 * to sit under most attacks, not under the median one.
 */
export type WitnessProfile = {
  /** Median reading at confident attacks. */
  attack: number | null;
  /** `ATTACK_QUANTILE` of readings at confident attacks. */
  attackLow: number | null;
  /** `FLOOR_QUANTILE` of readings at above-gate hops away from any attack. */
  floor: number | null;
  /** `attack / floor` — the headroom a threshold on this witness has here. */
  contrast: number | null;
};

/**
 * Hops of history each quantile is taken over.
 *
 * At the engine's ~12ms hop this is about a minute of above-gate audio, which
 * is longer than every take in the corpus — so on the fixtures it is a
 * cumulative quantile, and the bound only starts mattering in a session long
 * enough for the player to have changed something. Bounded rather than
 * cumulative on purpose: a profile that can never forget cannot follow a player
 * who switches from a clean tone to a fuzz halfway through.
 */
const BACKGROUND_CAPACITY = 5000;

/**
 * Confident attacks each quantile is taken over. Attacks arrive at a few per
 * second at most, so this is a comparable span of time to the above.
 */
const ATTACK_CAPACITY = 200;

/**
 * How long after a confident attack a hop still belongs to that attack.
 *
 * The floor is meant to be what the signal does when nothing was just struck,
 * so the attack's own burst and the hops behind it have to come out of it or
 * the floor rises with the very thing it is the reference for. A pick is not
 * one hop — pick noise arrives, then the string speaks.
 *
 * Swept on the five 120bpm fixtures (`measure-rig-profile.ts --holdoff`), the
 * `heldSharpness` floor falls steeply as the holdoff opens from 0 to 60ms —
 * between 7% and 74% of the value comes out, and it is the attacks' own
 * ring-out — and then flattens: over the next 80ms it moves by 5-11% more on
 * every one of the five. 60ms is the knee, and it is also the flux kernel's own
 * dead time, so no second confident attack can land inside it.
 *
 * The far side of the knee is not free. At 140bpm a sixteenth is 107ms, so a
 * longer holdoff leaves a sixteenths take with almost no hop belonging to no
 * attack at all: at 60ms those takes keep 183-225 background hops and at 80ms
 * only 113-167, which is below `MIN_HOPS` and leaves them with no floor. Taking
 * the bottom of the flat region is what keeps the profile estimable at all on
 * dense playing — and even there it is close-run, which is a finding in its own
 * right rather than a tuning detail.
 */
const ATTACK_HOLDOFF_MS = 60;

/** Quantile of ordinary hops taken as the floor. See `WitnessProfile`. */
const FLOOR_QUANTILE = 0.9;

/** Quantile of confident attacks taken as `attackLow`. */
const ATTACK_QUANTILE = 0.25;

/** Above-gate hops needed before any quantile over them is reported. */
const MIN_HOPS = 200;

/** What the caller may override, for sweeps. Everything defaults to the above. */
export type RigProfileOptions = {
  attackHoldoffMs?: number;
  floorQuantile?: number;
  attackQuantile?: number;
  minHops?: number;
  minAttacks?: number;
};

/** Confident attacks needed before any attack quantile is reported. */
const MIN_ATTACKS = 8;

/** Boundary of the "bright" band, Hz — above a guitar's useful fundamentals. */
export const HIGH_HZ = 2000;

/** The guitar's fundamental range, Hz: low E to the 12th fret of the high E. */
export const LOW_BAND_HZ: readonly [number, number] = [70, 700];

/**
 * Longest a decay fit runs before it is read, ms. Beyond this a plucked string
 * on any rig in this corpus is into its noise floor and the fit is measuring
 * the room.
 */
const DECAY_WINDOW_MS = 1200;

/** Fixed-capacity ring of recent values, queried by exact quantile. */
class QuantileRing {
  private readonly values: Float64Array;
  private readonly scratch: Float64Array;
  private filled = 0;
  private index = 0;

  constructor(capacity: number) {
    this.values = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  get count(): number {
    return this.filled;
  }

  reset(): void {
    this.filled = 0;
    this.index = 0;
  }

  push(value: number): void {
    if (!Number.isFinite(value)) return;
    this.values[this.index] = value;
    this.index = (this.index + 1) % this.values.length;
    if (this.filled < this.values.length) this.filled++;
  }

  /** Linear-interpolated quantile of what is held, or null when empty. */
  quantile(q: number): number | null {
    if (this.filled === 0) return null;
    const view = this.scratch.subarray(0, this.filled);
    view.set(this.values.subarray(0, this.filled));
    view.sort();
    const position = q * (this.filled - 1);
    const lo = Math.floor(position);
    const hi = Math.ceil(position);
    const a = view[lo] as number;
    const b = view[hi] as number;
    return a + (b - a) * (position - lo);
  }
}

type Resolved = Required<RigProfileOptions>;

/** One witness's two populations. */
class WitnessRings {
  readonly atAttack = new QuantileRing(ATTACK_CAPACITY);
  readonly elsewhere = new QuantileRing(BACKGROUND_CAPACITY);

  constructor(private readonly options: Resolved) {}

  reset(): void {
    this.atAttack.reset();
    this.elsewhere.reset();
  }

  report(): WitnessProfile {
    const enoughAttacks = this.atAttack.count >= this.options.minAttacks;
    const enoughHops = this.elsewhere.count >= this.options.minHops;
    const attack = enoughAttacks ? this.atAttack.quantile(0.5) : null;
    const attackLow = enoughAttacks
      ? this.atAttack.quantile(this.options.attackQuantile)
      : null;
    const floor = enoughHops ? this.elsewhere.quantile(this.options.floorQuantile) : null;
    const contrast =
      attack !== null && floor !== null && floor > 0 ? attack / floor : null;
    return { attack, attackLow, floor, contrast };
  }
}

const WITNESSES = [
  "heldSharpness",
  "heldFluxRatio",
  "riseRatio",
  "sharpness",
  "fluxRatio",
] as const;

type WitnessName = (typeof WITNESSES)[number];

export class RigProfileEstimator {
  private readonly options: Resolved;
  private readonly witnesses: Map<WitnessName, WitnessRings>;
  private readonly highShare = new QuantileRing(BACKGROUND_CAPACITY);
  private readonly lowShare = new QuantileRing(BACKGROUND_CAPACITY);
  private readonly crest = new QuantileRing(BACKGROUND_CAPACITY);
  private readonly tau = new QuantileRing(ATTACK_CAPACITY);

  private hops = 0;
  private attacks = 0;
  private firstAt: SourceTimeMs | null = null;
  private lastAt: SourceTimeMs = 0;
  private lastAttackAt: SourceTimeMs | null = null;

  /** The decay fit running on the note struck at `decayFrom`, if any. */
  private decay: VoiceDecay | null = null;
  private decayFrom: SourceTimeMs = 0;

  constructor(options: RigProfileOptions = {}) {
    this.options = {
      attackHoldoffMs: options.attackHoldoffMs ?? ATTACK_HOLDOFF_MS,
      floorQuantile: options.floorQuantile ?? FLOOR_QUANTILE,
      attackQuantile: options.attackQuantile ?? ATTACK_QUANTILE,
      minHops: options.minHops ?? MIN_HOPS,
      minAttacks: options.minAttacks ?? MIN_ATTACKS,
    };
    this.witnesses = new Map<WitnessName, WitnessRings>(
      WITNESSES.map((name) => [name, new WitnessRings(this.options)])
    );
  }

  reset(): void {
    for (const rings of this.witnesses.values()) rings.reset();
    this.highShare.reset();
    this.lowShare.reset();
    this.crest.reset();
    this.tau.reset();
    this.hops = 0;
    this.attacks = 0;
    this.firstAt = null;
    this.lastAt = 0;
    this.lastAttackAt = null;
    this.decay = null;
  }

  /**
   * Fold one hop in.
   *
   * Gated hops say nothing about the rig's playing behaviour — the noise floor
   * is `NoiseFloorTracker`'s subject, not this one — so they are skipped
   * entirely rather than folded in as very quiet playing.
   */
  observe(observation: RigObservation): void {
    if (observation.gated) {
      // A gated stretch ends whatever note the decay fit was following: what
      // comes back after it is a different stroke.
      this.decay = null;
      return;
    }

    if (this.firstAt === null) this.firstAt = observation.at;
    this.lastAt = observation.at;
    this.hops++;

    if (observation.confidentAttack) {
      this.attacks++;
      this.lastAttackAt = observation.at;
      this.readDecay();
      this.decay = new VoiceDecay();
      this.decayFrom = observation.at;
    }

    // The witnesses split into two populations by whether an attack was just
    // detected. A hop inside the holdoff belongs to neither the attack (only
    // the firing hop is that) nor the floor (the arrival is still ringing out
    // of it), so it is dropped from both.
    const sinceAttack =
      this.lastAttackAt === null ? Infinity : observation.at - this.lastAttackAt;
    for (const name of WITNESSES) {
      const rings = this.witnesses.get(name) as WitnessRings;
      const value = observation[name];
      if (observation.confidentAttack) rings.atAttack.push(value);
      else if (sinceAttack > this.options.attackHoldoffMs) rings.elsewhere.push(value);
    }

    this.highShare.push(observation.highShare);
    this.lowShare.push(observation.lowShare);
    if (observation.rms > 0) this.crest.push(observation.peak / observation.rms);

    if (this.decay !== null) {
      this.decay.observe(observation.at, observation.rms);
      if (observation.at - this.decayFrom >= DECAY_WINDOW_MS) this.readDecay();
    }
  }

  /** Close the running decay fit and keep its time constant, if it has one. */
  private readDecay(): void {
    if (this.decay === null) return;
    const tau = this.decay.tauMs();
    if (tau !== null) this.tau.push(tau);
    this.decay = null;
  }

  /** The profile as it stands. Cheap enough to call per hop; nothing caches. */
  profile(): RigProfile {
    const enoughHops = this.hops >= this.options.minHops;
    const witness = (name: WitnessName): WitnessProfile =>
      (this.witnesses.get(name) as WitnessRings).report();
    return {
      hops: this.hops,
      attacks: this.attacks,
      backgroundHops: (
        this.witnesses.get("heldSharpness") as WitnessRings
      ).elsewhere.count,
      elapsedMs: this.firstAt === null ? 0 : this.lastAt - this.firstAt,
      brightness: enoughHops ? this.highShare.quantile(0.5) : null,
      bassShare: enoughHops ? this.lowShare.quantile(0.5) : null,
      crest: enoughHops ? this.crest.quantile(0.5) : null,
      decayTauMs:
        this.tau.count >= this.options.minAttacks ? this.tau.quantile(0.5) : null,
      heldSharpness: witness("heldSharpness"),
      heldFluxRatio: witness("heldFluxRatio"),
      riseRatio: witness("riseRatio"),
      sharpness: witness("sharpness"),
      fluxRatio: witness("fluxRatio"),
    };
  }
}
