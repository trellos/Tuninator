/**
 * What this rig sounds like when nobody is playing.
 *
 * `analysis.rmsGate` is an absolute level, and an absolute level means a
 * different thing on every rig. Measured over the corpus, the fixed gate of
 * 0.008 stands 20 to 53 times above the fifth-percentile frame RMS of the five
 * 120bpm takes, 97 to 126 times above a direct input's, and 3.9 to 4.2 times
 * above a room mic's. One number, three meanings: on a direct input it throws
 * away quiet playing, and on a room mic it barely clears the room.
 *
 * So the gate is derived from a measurement instead. The measurement has to be
 * continuous rather than a one-shot fit over the opening seconds — every take
 * in this corpus opens with between 2.4 and 10 seconds of room tone, so a
 * one-shot fit would be fitting the only thing there — and it has to survive a
 * passage with no silence in it at all.
 *
 * This is a quantile tracker in the log domain: each hop it steps up by
 * `rate * quantile` when the frame is louder than the current estimate and down
 * by `rate * (1 - quantile)` when it is quieter, which converges on the
 * `quantile` quantile of log RMS and needs one number of state. Asymmetric on
 * purpose: it falls to a newly quiet passage quickly and climbs out of one
 * slowly, because a floor that rises with a sustained chord would gate that
 * chord's own decay.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

export type NoiseFloorOptions = {
  /** Quantile of frame RMS tracked. Low: this is the floor, not the level. */
  quantile: number;
  /** Step size per hop, in log units. */
  rate: number;
  /**
   * Level below which a frame is not evidence about the rig at all.
   *
   * A muted stream and a quiet room are different things, and only one of them
   * says anything about what this microphone or this interface sounds like. The
   * room-mic takes here open with several seconds of decoded digital silence
   * before the room tone starts, and a quantile tracker fed those frames
   * converges on 1e-7 — the codec, not the room. Frames below this are skipped
   * rather than folded in, and the estimate never goes below it either.
   */
  minimum: number;
};

export class NoiseFloorTracker {
  private readonly quantile: number;
  private readonly rate: number;
  private readonly minimum: number;
  private readonly logMinimum: number;
  private log: number | null = null;

  constructor(options: NoiseFloorOptions) {
    this.quantile = options.quantile;
    this.rate = options.rate;
    this.minimum = options.minimum;
    this.logMinimum = Math.log(options.minimum);
  }

  /** The current estimate. Equals `minimum` until the first frame arrives. */
  get floor(): number {
    return this.log === null ? this.minimum : Math.exp(this.log);
  }

  reset(): void {
    this.log = null;
  }

  /** Fold one hop's RMS in, and return the updated estimate. */
  observe(rms: number): number {
    // Digital silence is not a rig. Skipping rather than clamping matters: a
    // take that opens on ten seconds of decoded zeros would otherwise spend
    // them driving the estimate to the clamp and the gate to the floor.
    if (rms < this.minimum) return this.floor;
    const value = Math.log(rms);
    if (this.log === null) {
      // Starting at the first frame rather than at the minimum matters: a take
      // that opens on a loud chord would otherwise spend its first seconds
      // climbing, with the gate wide open underneath it.
      this.log = value;
      return this.floor;
    }
    this.log +=
      this.rate * (value > this.log ? this.quantile : this.quantile - 1);
    if (this.log < this.logMinimum) this.log = this.logMinimum;
    return this.floor;
  }
}
