/**
 * Which input channel should the pitch detector actually listen to?
 *
 * A 2-in interface presents to the browser as one *stereo* device, so the two
 * physical inputs arrive as channel 0 and channel 1 of a single stream. What is
 * on them is not knowable in advance:
 *
 *   - one instrument in input 2, input 1 unplugged (channel 0 is noise floor),
 *   - a mic on the cab AND a DI of the same guitar,
 *   - a genuinely stereo source, near-identical on both channels.
 *
 * Summing all channels solves the first case and actively breaks the second.
 * Two captures of one source separated by milliseconds of acoustic travel sum
 * into a comb filter: a spectrum with periodic notches. Half a period of delay
 * cancels the odd harmonics outright, and what reaches the detector is a signal
 * whose strongest remaining periodicity is an octave up. That is the single
 * worst input a pitch detector can be handed, and it is an ordinary rig.
 *
 * Selecting one channel cannot comb-filter, so this picks the loudest channel
 * instead — but "loudest" has to be decided carefully, hence everything below.
 *
 * This lives in the DEMO, not in the library. Which physical input an
 * instrument is plugged into is a property of the host's rig, not of pitch
 * detection: the library is handed one mono channel and analyses it. Choosing
 * that channel is the host's job, and this is one reasonable way to do it.
 *
 * Allocation-free after construction, so it is safe to drive per analysis hop.
 */

/** How the host should combine (or not combine) the input channels. */
export type ChannelStrategy = "auto" | "sum" | number;

export type ChannelSelectorConfig = {
  /** Number of input channels. 1 makes every method a no-op. */
  channelCount: number;

  /**
   * Length of one decision window, in milliseconds.
   *
   * Per-hop argmax jitters: a 12ms hop lands anywhere in a note's attack, and
   * two channels carrying the same instrument trade the lead constantly. Energy
   * is therefore accumulated across a window and the decision is taken once per
   * window, on the accumulated total.
   */
  windowMs?: number;

  /**
   * How much louder, in decibels, a challenger must be than the incumbent
   * before it counts as winning a window.
   */
  marginDb?: number;

  /** Consecutive won windows a challenger needs before the selection switches. */
  sustainWindows?: number;

  /**
   * RMS below which a window is discarded as "nobody is playing".
   *
   * Pass the library's `analysis.rmsGate`, the same threshold that gates the
   * detector: under it nothing would be detected on any channel, so the choice
   * is both arbitrary and irrelevant.
   */
  silenceRms?: number;
};

/**
 * 250ms. Long enough to average over an attack and into the sustain of a note
 * (a quarter note at 120bpm is 500ms), short enough that the very first note
 * played latches a selection almost immediately.
 */
export const DEFAULT_WINDOW_MS = 250;

/**
 * 6dB — a factor of two in amplitude.
 *
 * This governs *switching*, not the first choice, and switching is the
 * expensive direction: changing channel mid-note splices two uncorrelated
 * waveforms together in the ring buffer, which is a worse input than either
 * channel alone. So the bar is set above anything a genuine stereo pair
 * produces (two mics on one cab, or a stereo source, sit within a few dB and
 * wander either side of level) and far below the case that matters (an
 * unplugged input sits 30dB or more under a plugged one).
 */
export const DEFAULT_MARGIN_DB = 6;

/**
 * 3 windows — 750ms of uninterrupted dominance.
 *
 * A cable moved from input 1 to input 2 stays moved, so a second of latency
 * costs nothing. A momentary imbalance — one channel's note decaying while the
 * other is re-picked — does not survive three windows.
 */
export const DEFAULT_SUSTAIN_WINDOWS = 3;

/** Matches the default `analysis.rmsGate`. */
export const DEFAULT_SILENCE_RMS = 0.008;

/**
 * Windowed, hysteretic "which channel is the instrument on?".
 *
 * Fed one observation per analysis hop (the per-channel RMS the worklet already
 * measures before mixing), it answers with a channel index or `null` for "no
 * decision yet — do something safe".
 *
 * Behaviour worth stating outright:
 *
 * - **Silence never latches.** Before anyone plays, every channel is noise
 *   floor and the loudest one is whichever has the worse preamp. Windows whose
 *   loudest channel is under `silenceRms` are dropped entirely: they neither
 *   latch a decision nor challenge an existing one. `selected()` stays `null`
 *   until real signal has been heard, and the caller is expected to sum in the
 *   meantime — summing can be wrong, but it cannot miss a signal, which is the
 *   right failure mode while waiting.
 * - **A latched decision survives silence.** Once chosen, a channel is kept
 *   through pauses between phrases; only sustained louder signal elsewhere
 *   moves it.
 * - **Mono is a no-op.** With one channel there is nothing to decide.
 */
export class ChannelSelector {
  readonly channelCount: number;
  readonly windowMs: number;
  readonly sustainWindows: number;
  readonly silenceRms: number;
  /** `marginDb` pre-converted to an amplitude ratio. */
  readonly marginRatio: number;

  /** Accumulated sum of `rms^2 * ms` for the window in progress. */
  private readonly energy: number[];
  private windowElapsedMs = 0;

  /** Latched selection, or -1 while no window has ever carried real signal. */
  private selectedIndex = -1;

  /** Channel currently mounting a challenge, and how many windows it has won. */
  private challenger = -1;
  private challengerStreak = 0;

  /** Windows evaluated (i.e. not discarded as silent). Diagnostics only. */
  private decisionCount = 0;

  constructor(config: ChannelSelectorConfig) {
    this.channelCount = Math.max(1, Math.floor(config.channelCount));
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    this.sustainWindows = Math.max(1, config.sustainWindows ?? DEFAULT_SUSTAIN_WINDOWS);
    this.silenceRms = config.silenceRms ?? DEFAULT_SILENCE_RMS;
    this.marginRatio = dbToRatio(config.marginDb ?? DEFAULT_MARGIN_DB);
    this.energy = new Array<number>(this.channelCount).fill(0);
  }

  /**
   * The channel to analyse, or `null` when no decision has been latched yet.
   *
   * Mono answers 0 immediately: with one channel the "selection" is not a
   * decision, and making the caller wait for a window would be theatre.
   */
  selected(): number | null {
    if (this.channelCount <= 1) return 0;
    return this.selectedIndex < 0 ? null : this.selectedIndex;
  }

  /** Number of non-silent windows evaluated so far. For tests and diagnostics. */
  windowsEvaluated(): number {
    return this.decisionCount;
  }

  /**
   * Feeds one hop of per-channel RMS, and returns the (possibly updated)
   * selection. `hopMs` weights the observation, so an irregular final hop
   * cannot count as much as a full one.
   *
   * Allocation-free. `rms` is read, never retained.
   */
  observe(rms: readonly number[], hopMs: number): number | null {
    if (this.channelCount <= 1) return 0;
    if (!(hopMs > 0)) return this.selected();

    const channels = Math.min(this.channelCount, rms.length);
    for (let c = 0; c < channels; c++) {
      const level = rms[c] ?? 0;
      this.energy[c] = this.energy[c]! + level * level * hopMs;
    }
    this.windowElapsedMs += hopMs;

    if (this.windowElapsedMs >= this.windowMs) this.closeWindow();
    return this.selected();
  }

  /** Forgets the latched selection and any window in progress. */
  reset(): void {
    for (let c = 0; c < this.energy.length; c++) this.energy[c] = 0;
    this.windowElapsedMs = 0;
    this.selectedIndex = -1;
    this.challenger = -1;
    this.challengerStreak = 0;
    this.decisionCount = 0;
  }

  /** Evaluates the completed window and starts a new one. */
  private closeWindow(): void {
    const elapsed = this.windowElapsedMs;

    let best = 0;
    let bestRms = 0;
    for (let c = 0; c < this.channelCount; c++) {
      // Ties go to the lower index, so an exactly symmetric stereo pair is
      // deterministic rather than dependent on floating-point noise.
      const level = Math.sqrt(this.energy[c]! / elapsed);
      if (level > bestRms) {
        bestRms = level;
        best = c;
      }
    }

    if (bestRms >= this.silenceRms) {
      this.decisionCount += 1;
      if (this.selectedIndex < 0) {
        // First real signal: take the loudest outright. There is no incumbent
        // to protect, and making the user play for a second before anything is
        // heard would be a worse bug than choosing slightly early.
        this.selectedIndex = best;
        this.challenger = -1;
        this.challengerStreak = 0;
      } else if (best === this.selectedIndex) {
        this.challengerStreak = 0;
        this.challenger = -1;
      } else {
        const incumbentRms = Math.sqrt(this.energy[this.selectedIndex]! / elapsed);
        if (bestRms >= incumbentRms * this.marginRatio) {
          if (best === this.challenger) {
            this.challengerStreak += 1;
          } else {
            this.challenger = best;
            this.challengerStreak = 1;
          }
          if (this.challengerStreak >= this.sustainWindows) {
            this.selectedIndex = best;
            this.challenger = -1;
            this.challengerStreak = 0;
          }
        } else {
          // Louder, but not by enough. A near-tie must not count towards a
          // switch at all, or a stereo pair accumulates a streak by drifting.
          this.challenger = -1;
          this.challengerStreak = 0;
        }
      }
    }

    for (let c = 0; c < this.energy.length; c++) this.energy[c] = 0;
    this.windowElapsedMs = 0;
  }
}

/**
 * Resolves the caller's strategy against the channel count the browser actually
 * delivered, returning the channel index to read, or `null` to sum.
 *
 * The precedence rules — mono wins, an out-of-range explicit index falls back
 * to summing rather than reading `undefined` — are kept here so they are
 * unit-testable without any audio graph at all.
 */
export function resolveChannel(
  strategy: ChannelStrategy,
  channelCount: number,
  selector: ChannelSelector | null
): number | null {
  if (channelCount <= 1) return 0;
  if (strategy === "sum") return null;
  if (typeof strategy === "number") {
    const index = Math.floor(strategy);
    // An index the device does not have is a host configuration mistake.
    // Summing keeps every channel audible to the detector, so the mistake shows
    // up as "it works but I asked for input 3", not as silence.
    return index >= 0 && index < channelCount ? index : null;
  }
  return selector ? selector.selected() : null;
}

function dbToRatio(db: number): number {
  return Math.pow(10, db / 20);
}
