/**
 * `IPitchChangeDetector`: has the pitch moved, and is that a step or a glide?
 *
 * This is the mechanism that makes a legato run more than one Note. In a slur
 * or hammer-on the pick never re-attacks, so both transient witnesses stay
 * quiet and attack-driven segmentation alone would merge twenty-four triplets
 * into a handful of Notes.
 *
 * Step versus glide cannot be settled by total displacement: a 200-cent bend
 * and a 200-cent legato D5->E5 are the same distance. The discriminator is the
 * per-hop *rate* — a bend sweeps through every intermediate cent over tens of
 * frames, a fretted step jumps in one or two — plus monotonicity, which is what
 * separates a real glide from vibrato oscillating around a centre.
 *
 * A candidate pitch is held for `stepConfirmFrames` before it splits anything,
 * and the split is backdated to the FIRST frame that showed the new pitch, not
 * the frame that confirmed it. Otherwise every note in a run starts late, and
 * on a 167ms triplet a late note spends most of its frames on its successor.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { EngineConfig } from "../config.js";
import type { FastFrame, IPitchChangeDetector, PitchChangeEvidence } from "../contracts.js";

const CENTS_PER_OCTAVE = 1200;

export function centsBetween(hz: number, refHz: number): number {
  return CENTS_PER_OCTAVE * Math.log2(hz / refHz);
}

export class PitchChangeDetector implements IPitchChangeDetector {
  private readonly config: EngineConfig;

  private lastVoicedHz: number | null = null;
  /** Recent voiced frequencies, oldest first. Drives the glide test. */
  private readonly recent: number[] = [];

  private candidateHz: number | null = null;
  private candidateFrames = 0;
  private candidateAt = 0;
  private candidateSample = 0;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  reset(): void {
    this.lastVoicedHz = null;
    this.recent.length = 0;
    this.candidateHz = null;
    this.candidateFrames = 0;
  }

  /** Forget the pitch history without forgetting the current pitch. */
  clearAfterSplit(hz: number, at: number): void {
    this.lastVoicedHz = hz;
    this.recent.length = 0;
    this.recent.push(hz);
    this.candidateHz = null;
    this.candidateFrames = 0;
    this.candidateAt = at;
  }

  isGliding(): boolean {
    const window = this.config.transient.glideWindowHops;
    if (this.recent.length <= window) return false;

    const first = this.recent[0] as number;
    const last = this.recent[this.recent.length - 1] as number;
    if (Math.abs(centsBetween(last, first)) < this.config.transient.glideMinCents) return false;

    // Monotonic AND gradual. Monotonicity alone is not enough: a single
    // fretted jump is trivially monotonic over any window that contains it, so
    // testing only for direction classifies every legato step as a glide and
    // the run never splits. A glide is defined by passing *through* the
    // intermediate pitches, which means no single hop may cross the step
    // threshold. Vibrato oscillates, so its net displacement stays small and it
    // never qualifies; a re-picked note holds steady and does not either.
    const rising = last > first;
    const step = this.config.pitch.stepThresholdCents;
    for (let i = 1; i < this.recent.length; i++) {
      const delta = centsBetween(this.recent[i] as number, this.recent[i - 1] as number);
      if (Math.abs(delta) >= step) return false;
      if (rising ? delta < -10 : delta > 10) return false;
    }
    return true;
  }

  observe(frame: FastFrame): PitchChangeEvidence | null {
    const hz = frame.pitch.frequencyHz;
    if (hz === null) {
      // Unvoiced hops do not extend the glide history; a gap is not a glide.
      return null;
    }

    const previous = this.lastVoicedHz;
    this.lastVoicedHz = hz;
    this.recent.push(hz);
    if (this.recent.length > this.config.transient.glideWindowHops + 1) this.recent.shift();

    if (previous === null) return null;

    const threshold = this.config.pitch.stepThresholdCents;
    const stepCents = Math.abs(centsBetween(hz, previous));

    // Resolve an in-flight candidate FIRST. `lastVoicedHz` advances every hop,
    // so by the second frame of a real step the per-hop delta is already back
    // to ~0; testing that first reads a genuine note change as a wobble and
    // merges the whole run into one Note.
    const pending = this.candidateHz !== null;
    const holds =
      pending && Math.abs(centsBetween(hz, this.candidateHz as number)) <= threshold;

    if (pending && !holds) {
      // Fell back toward where it came from: a wobble, not a note change.
      this.candidateHz = null;
      this.candidateFrames = 0;
    }

    if (!holds && stepCents <= threshold) return null;

    if (holds) {
      this.candidateFrames++;
    } else {
      this.candidateHz = hz;
      this.candidateFrames = 1;
      this.candidateAt = frame.at;
      this.candidateSample = frame.sampleIndex;
    }

    if (this.candidateFrames < this.config.pitch.stepConfirmFrames) return null;

    const fromHz = previous;
    const toHz = this.candidateHz as number;
    const evidence: PitchChangeEvidence = {
      kind: this.isGliding() ? "glide" : "step",
      fromHz,
      toHz,
      cents: centsBetween(toHz, fromHz),
      at: this.candidateAt,
      atSample: this.candidateSample,
      heldFrames: this.candidateFrames,
    };
    this.candidateHz = null;
    this.candidateFrames = 0;
    return evidence;
  }
}
