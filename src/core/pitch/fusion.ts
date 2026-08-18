/**
 * Several pitch estimators, one answer.
 *
 * The methods fail in different directions and that is the whole point of
 * running more than one: autocorrelation slips to sub-harmonics, spectral
 * summation slips to harmonics, and a residual method is sharp at an attack
 * and noise in the middle of a held note. Where they disagree, the
 * disagreement is information.
 *
 * WHY NOT SIMPLY TAKE THE MOST CONFIDENT. Because confidence is not evenly
 * distributed over the failures. The incumbent reads note t6 of the lead
 * fixture as the previous note of the phrase at 0.95 confidence -- a pull-off
 * that never breaks the ringing D, so the periodicity really is D and the
 * method really is certain. Picking the single loudest voice hands that note
 * to whoever is most sure, which is exactly the estimator that is wrong. Two
 * quieter estimators agreeing against one confident one is the case worth
 * catching, and argmax cannot see it.
 *
 * So: confidence-weighted voting over semitones. Each member contributes its
 * confidence as mass to the note it names, the heaviest note wins, and the
 * margin between first and second place becomes the fused confidence. That
 * keeps the contract's promise -- a number meaning "probability this is the
 * note being played" -- because a split vote reports its own ambiguity
 * instead of inheriting the certainty of whichever member shouted loudest.
 *
 * Part of `src/core/` — no DOM, no globals, no npm imports.
 */

import type { PitchEstimate, PitchEstimator, PitchEstimatorOptions } from "./estimator.js";

/**
 * Weight on a member's vote for the octave-displaced neighbours of the note it
 * named.
 *
 * Every method here can miss by an octave, and they do it in opposite
 * directions, so a member naming D5 is weak evidence for D4 and D6 as well.
 * Without this an octave disagreement splits the vote three ways and a
 * lower-ranked note wins on a plurality; with it the pitch class is agreed on
 * first and the octave is decided among the members that named one.
 */
const OCTAVE_LEAK = 0.25;

/**
 * Below this, a member is treated as abstaining rather than voting quietly.
 *
 * A method that has found nothing still returns its best lag, and that reading
 * is not merely uncertain -- it is drawn from noise. Letting it in at low
 * weight adds mass to an arbitrary note, which matters when the honest members
 * are also quiet.
 */
const ABSTAIN_BELOW = 0.15;

type Member = {
  estimator: PitchEstimator;
  /** Preallocated: `estimate()` must not allocate, and neither may we. */
  buffer: Float32Array;
  /** Relative trust, from the shared bench. Not a hand-tuned dial. */
  weight: number;
};

export type FusionMemberSpec = {
  estimator: PitchEstimator;
  /**
   * How much this member's confidence is worth relative to the others.
   *
   * This is the one place a measured result enters as a constant, and it must
   * come from `scripts/bench-estimator.ts` on the recorded fixtures, not from
   * an opinion about which paper is better.
   */
  weight?: number;
};

export type FusionDiagnostic = {
  name: string;
  frequencyHz: number | null;
  confidence: number;
  /** Relative trust. Defaults to 1 when a caller has no reason to differ. */
  weight?: number;
};

export class FusedEstimator implements PitchEstimator {
  readonly name: string;
  readonly windowSize: number;
  private readonly members: Member[];
  /** Vote mass per MIDI note, indexed by note number. Reused every frame. */
  private readonly votes: Float64Array;
  private readonly minMidi: number;
  private readonly maxMidi: number;
  /** What each member said last frame, for reports. Never read by the vote. */
  readonly lastVote: FusionDiagnostic[];

  constructor(specs: FusionMemberSpec[], options: PitchEstimatorOptions) {
    if (specs.length === 0) throw new Error("FusedEstimator needs at least one member");
    this.members = specs.map((spec) => ({
      estimator: spec.estimator,
      buffer: new Float32Array(spec.estimator.windowSize),
      weight: spec.weight ?? 1,
    }));
    this.name = `fused(${specs.map((s) => s.estimator.name).join("+")})`;
    // The caller feeds the longest window any member wants; shorter members
    // read the most recent tail of it, so every member sees audio ending at
    // the same instant. Anything else would fuse readings of different moments.
    this.windowSize = Math.max(...specs.map((s) => s.estimator.windowSize));
    this.minMidi = Math.max(0, Math.floor(midiOfHz(options.minFrequencyHz)) - 1);
    this.maxMidi = Math.min(127, Math.ceil(midiOfHz(options.maxFrequencyHz)) + 1);
    this.votes = new Float64Array(256);
    this.lastVote = specs.map((s) => ({
      name: s.estimator.name,
      frequencyHz: null,
      confidence: 0,
    }));
  }

  estimate(window: Float32Array): PitchEstimate {
    for (let i = 0; i < this.members.length; i++) {
      const member = this.members[i]!;
      member.buffer.set(window.subarray(window.length - member.estimator.windowSize));
      const result = member.estimator.estimate(member.buffer);
      const diagnostic = this.lastVote[i]!;
      diagnostic.frequencyHz = result.frequencyHz;
      diagnostic.confidence = result.confidence;
      diagnostic.weight = member.weight;
    }
    return votePitch(this.lastVote, this.votes, this.minMidi, this.maxMidi);
  }
}

/**
 * The vote itself, over readings that have already been taken.
 *
 * Separate from `FusedEstimator` because the pipeline arrives at its witnesses
 * by a different route — two YIN windows with a measured arbitration between
 * them, plus a zero-crossing estimate — and those deserve the same voting rule
 * rather than a second copy of it that can drift out of step.
 *
 * `scratch` must be a 256-element buffer owned by the caller; it is cleared
 * here. Nothing is allocated.
 */
export function votePitch(
  readings: readonly FusionDiagnostic[],
  scratch: Float64Array,
  minMidi: number,
  maxMidi: number
): PitchEstimate {
  // Two tallies over one buffer: direct votes in the low half, direct plus
  // octave leak in the high half. The leak decides WHICH note wins, so members
  // an octave apart coalesce instead of splitting the vote three ways; the
  // margin is read off the direct votes only, because a lone member's own leak
  // is not a rival opinion and must not be counted as one. Scoring the margin
  // against the combined tally capped a unanimous single witness at 0.75
  // confidence -- it was competing with its own echo.
  scratch.fill(0);
  const direct = scratch.subarray(0, 128);
  const combined = scratch.subarray(128, 256);
  let cast = 0;
  let totalWeight = 0;

  for (const reading of readings) {
    const weight = reading.weight ?? 1;
    totalWeight += weight;
    if (reading.frequencyHz === null || reading.confidence < ABSTAIN_BELOW) continue;
    const midi = Math.round(midiOfHz(reading.frequencyHz));
    if (midi < minMidi || midi > maxMidi) continue;
    const mass = weight * reading.confidence;
    direct[midi]! += mass;
    combined[midi]! += mass;
    if (midi - 12 >= minMidi) combined[midi - 12]! += mass * OCTAVE_LEAK;
    if (midi + 12 <= maxMidi) combined[midi + 12]! += mass * OCTAVE_LEAK;
    cast++;
  }
  if (cast === 0) return { frequencyHz: null, confidence: 0 };

  let winner = -1;
  let first = 0;
  for (let midi = minMidi; midi <= maxMidi; midi++) {
    if (combined[midi]! > first) {
      first = combined[midi]!;
      winner = midi;
    }
  }
  if (winner < 0) return { frequencyHz: null, confidence: 0 };

  // The strongest genuine dissent: the heaviest direct vote for anything else.
  let second = 0;
  for (let midi = minMidi; midi <= maxMidi; midi++) {
    if (midi !== winner && direct[midi]! > second) second = direct[midi]!;
  }
  first = Math.max(first, direct[winner]!);

  // Report the members' own frequencies rather than the semitone's nominal
  // pitch: the vote decides WHICH note, but the winning members already
  // measured it, bends and detuning included, and rounding that away would
  // throw out the sub-semitone accuracy each of them worked for.
  let sum = 0;
  let sumMass = 0;
  /** Weight, not mass: the denominator of the supporters' mean confidence. */
  let supporterWeight = 0;
  for (const reading of readings) {
    if (reading.frequencyHz === null || reading.confidence < ABSTAIN_BELOW) continue;
    if (Math.round(midiOfHz(reading.frequencyHz)) !== winner) continue;
    const weight = reading.weight ?? 1;
    const mass = weight * reading.confidence;
    sum += reading.frequencyHz * mass;
    sumMass += mass;
    supporterWeight += weight;
  }
  const frequencyHz = sumMass > 0 ? sum / sumMass : hzOfMidi(winner);

  // How sure the members who backed the winner were, times how much of the
  // opinion was theirs. Both factors are needed: the first alone would let a
  // panel be unanimously wrong at full confidence, the second alone would let a
  // barely-voiced reading win a walkover and report certainty.
  //
  // The scale is deliberately preserved rather than merely ordered. A lone
  // witness reporting 0.5 must come out at 0.5, because the pipeline gates on
  // this number against a threshold tuned for YIN's own scale -- an earlier
  // version took a square root here and, with a single witness voting, turned
  // that 0.5 into 0.71 and quietly lowered the gate. It read as the fusion
  // finding a note more, when it was only the gate letting more through.
  const support = supporterWeight > 0 ? sumMass / supporterWeight : 0;
  const share = first + second > 0 ? first / (first + second) : 0;
  return { frequencyHz, confidence: Math.min(1, support * share) };
}

function midiOfHz(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}
function hzOfMidi(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
