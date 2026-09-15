/**
 * How fast is the player going, read from the strokes the tracker acted on.
 *
 * This is the third attempt at a live pace in this repository and it exists
 * because the first two failed for reasons that each have a repair in the
 * other's write-up. `docs/DETECTION-FINDINGS.md`, "The two pace attempts, side
 * by side", records the pair; the two corrections they yield are both built in
 * here and are worth stating at the declaration:
 *
 *  - **Fed once per attack BURST, never per transient.** One pick crossing six
 *    strings is one stroke with several transients. The first attempt fed every
 *    accepted transient and read the amp-path lead take (197ms per note) as
 *    FASTER than the sixteenths take (105ms) — a straight inversion, not noise.
 *    The caller is responsible for feeding bursts; `NoteTracker` reads its own
 *    `attackBurstStart`, which is the tracker's existing answer to "how many
 *    strokes was that", so the pace and the segmentation agree by construction.
 *  - **Read at a low quantile, not the median.** The asymmetry is not
 *    symmetric: reading a passage as SLOWER than it is merges notes somebody
 *    played, while reading it as faster only declines merges. So the quantity
 *    to control is the upper tail, and the second attempt derived 0.25 on the
 *    five 120bpm fixtures for that reason rather than by best fit.
 *
 * `null` is a real answer meaning "no opinion", and a consumer that gets one
 * must leave the boundary alone. It is returned until `minGaps` gaps are in
 * hand and after `silenceResetMs` without a stroke, because a pace carried
 * across a pause describes the phrase before it.
 *
 * What this CANNOT escape, and no amount of material fixes: the gaps come from
 * the tracker's own accepted strokes, which include the spurious boundaries a
 * pace gate exists to remove. The estimate is corrupted by the error it would
 * correct. The burst feed reduces that — a phantom same-pitch boundary inside
 * one articulation is usually inside one burst — but does not remove it, and
 * the second attempt measured the residue at 0.82 of the true rate.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports,
 * and allocation-free after construction.
 */

import type { SourceTimeMs } from "../../types.js";

export type PaceOptions = {
  /** Gaps held. Widening this to 12, 16 and 24 left the distribution unchanged. */
  ringSize: number;
  /** Quantile of the held gaps to report, 0..1. */
  quantile: number;
  /** Gaps below this are one articulation, not two strokes. */
  minIntervalMs: number;
  /** Silence after which the pace is forgotten. */
  silenceResetMs: number;
  /** Gaps needed before there is an opinion at all. */
  minGaps: number;
};

export class PaceEstimator {
  private readonly gaps: Float64Array;
  /** Scratch for the quantile read, so `paceMs` allocates nothing. */
  private readonly sorted: Float64Array;
  private count = 0;
  private next = 0;
  private lastAt: SourceTimeMs | null = null;

  constructor(private readonly options: PaceOptions) {
    const size = Math.max(1, Math.floor(options.ringSize));
    this.gaps = new Float64Array(size);
    this.sorted = new Float64Array(size);
  }

  /**
   * One stroke happened, at `at`.
   *
   * Must be called once per attack burst. Calling it per transient is the
   * first attempt's defect and reads a passage as several times too fast.
   */
  feed(at: SourceTimeMs): void {
    const previous = this.lastAt;
    if (previous !== null) {
      const gap = at - previous;
      if (gap > this.options.silenceResetMs) {
        // The pace before a pause describes the phrase before it.
        this.count = 0;
        this.next = 0;
      } else if (gap >= this.options.minIntervalMs) {
        this.gaps[this.next] = gap;
        this.next = (this.next + 1) % this.gaps.length;
        if (this.count < this.gaps.length) this.count++;
      }
      // A gap under minIntervalMs is the same articulation: not a gap at all,
      // and deliberately not a reset either.
    }
    this.lastAt = at;
  }

  /**
   * Silence has run long enough that the held pace is about a finished phrase.
   *
   * Called with the current time rather than inferred at `feed`, so a pace does
   * not survive to the far side of a rest merely because nothing was fed.
   */
  observe(at: SourceTimeMs): void {
    if (this.lastAt === null) return;
    if (at - this.lastAt <= this.options.silenceResetMs) return;
    this.count = 0;
    this.next = 0;
    this.lastAt = null;
  }

  /** The local stroke length in ms, or `null` for no opinion. */
  paceMs(): number | null {
    if (this.count < this.options.minGaps) return null;
    const n = this.count;
    for (let i = 0; i < n; i++) this.sorted[i] = this.gaps[i] as number;
    // Insertion sort over at most `ringSize` entries: allocation-free, and the
    // ring is eight long.
    for (let i = 1; i < n; i++) {
      const value = this.sorted[i] as number;
      let j = i - 1;
      while (j >= 0 && (this.sorted[j] as number) > value) {
        this.sorted[j + 1] = this.sorted[j] as number;
        j--;
      }
      this.sorted[j + 1] = value;
    }
    const index = Math.min(n - 1, Math.max(0, Math.round((n - 1) * this.options.quantile)));
    return this.sorted[index] as number;
  }

  reset(): void {
    this.count = 0;
    this.next = 0;
    this.lastAt = null;
  }
}
