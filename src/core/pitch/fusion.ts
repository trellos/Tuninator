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
    this.votes = new Float64Array(128);
    this.lastVote = specs.map((s) => ({
      name: s.estimator.name,
      frequencyHz: null,
      confidence: 0,
    }));
  }

  estimate(window: Float32Array): PitchEstimate {
    this.votes.fill(0);
    let cast = 0;
    let totalWeight = 0;

    for (let i = 0; i < this.members.length; i++) {
      const member = this.members[i]!;
      const size = member.estimator.windowSize;
      member.buffer.set(window.subarray(window.length - size));
      const result = member.estimator.estimate(member.buffer);
      const diagnostic = this.lastVote[i]!;
      diagnostic.frequencyHz = result.frequencyHz;
      diagnostic.confidence = result.confidence;

      totalWeight += member.weight;
      if (result.frequencyHz === null || result.confidence < ABSTAIN_BELOW) continue;
      const midi = Math.round(midiOfHz(result.frequencyHz));
      if (midi < this.minMidi || midi > this.maxMidi) continue;
      const mass = member.weight * result.confidence;
      this.votes[midi]! += mass;
      if (midi - 12 >= this.minMidi) this.votes[midi - 12]! += mass * OCTAVE_LEAK;
      if (midi + 12 <= this.maxMidi) this.votes[midi + 12]! += mass * OCTAVE_LEAK;
      cast++;
    }
    if (cast === 0) return { frequencyHz: null, confidence: 0 };

    let winner = -1;
    let first = 0;
    let second = 0;
    for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
      const mass = this.votes[midi]!;
      if (mass > first) {
        second = first;
        first = mass;
        winner = midi;
      } else if (mass > second) {
        second = mass;
      }
    }
    if (winner < 0) return { frequencyHz: null, confidence: 0 };

    // Report the members' own frequencies rather than the semitone's nominal
    // pitch: the vote decides WHICH note, but the winning members already
    // measured it, bends and detuning included, and rounding that away would
    // throw out the sub-semitone accuracy each of them worked for.
    let sum = 0;
    let sumWeight = 0;
    for (let i = 0; i < this.members.length; i++) {
      const vote = this.lastVote[i]!;
      if (vote.frequencyHz === null || vote.confidence < ABSTAIN_BELOW) continue;
      if (Math.round(midiOfHz(vote.frequencyHz)) !== winner) continue;
      const mass = this.members[i]!.weight * vote.confidence;
      sum += vote.frequencyHz * mass;
      sumWeight += mass;
    }
    const frequencyHz = sumWeight > 0 ? sum / sumWeight : hzOfMidi(winner);

    // Two independent factors, and both have to hold. Agreement alone would
    // let every member be unanimously unsure; strength alone would let one
    // certain member override a tie. Their product is low if either is.
    const agreement = first > 0 ? (first - second) / first : 0;
    const strength = first / Math.max(1e-9, totalWeight);
    return { frequencyHz, confidence: Math.min(1, agreement * Math.min(1, strength) ** 0.5) };
  }
}

function midiOfHz(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}
function hzOfMidi(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
