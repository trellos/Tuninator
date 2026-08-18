/**
 * A 90bpm metronome built on the standard Web Audio *lookahead scheduler*.
 *
 * The rule this file exists to honour: clicks are scheduled AHEAD of time
 * against `AudioContext.currentTime`, from a plain `setInterval` that only ever
 * decides *what* to schedule. Nothing here is driven by `requestAnimationFrame`
 * -- rAF is tied to display refresh, is throttled in background tabs, and jitters
 * by whole frames, which is plainly audible on a click track. rAF is used only
 * for *drawing* (see `timeline.ts`).
 *
 * See "A Tale of Two Clocks" (Chris Wilson) for the canonical write-up.
 */

export const DEFAULT_BPM = 90;
export const BEATS_PER_BAR = 4;

/** How often the scheduler wakes up to look for beats to queue. */
const LOOKAHEAD_TICK_MS = 25;
/** How far ahead of `currentTime` beats get queued. */
const SCHEDULE_AHEAD_S = 0.1;

const CLICK_S = 0.04;
const ACCENT_HZ = 1600;
const BEAT_HZ = 900;

/**
 * A beat grid expressed in `performance.now()` milliseconds, so the timeline can
 * draw gridlines that line up with what you hear.
 */
export type BeatGrid = {
  /** `performance.now()` time of beat 0. May be in the past. */
  originMs: number;
  periodMs: number;
  beatsPerBar: number;
};

export type MetronomeStatus = {
  running: boolean;
  /** Set when the browser refused to start audio (autoplay policy, no device). */
  message: string | null;
};

export class Metronome {
  readonly bpm: number;
  readonly beatsPerBar: number;

  #context: AudioContext | null = null;
  #ownsContext = false;
  #gain: GainNode | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  #running = false;
  #muted = false;
  #message: string | null = null;

  /** Next beat index to schedule, and its time on the audio clock. */
  #nextBeat = 0;
  #nextBeatTime = 0;

  /**
   * Beat 0 in `performance.now()` space. Free-running even while stopped, so
   * the timeline always has a grid to draw and it does not jump when you start
   * the click mid-phrase.
   */
  #gridOriginMs: number;

  #onChange: (status: MetronomeStatus) => void = () => {};

  constructor(bpm: number = DEFAULT_BPM, beatsPerBar: number = BEATS_PER_BAR) {
    this.bpm = bpm;
    this.beatsPerBar = beatsPerBar;
    this.#gridOriginMs = performance.now();
  }

  get periodMs(): number {
    return 60_000 / this.bpm;
  }

  get running(): boolean {
    return this.#running;
  }

  get muted(): boolean {
    return this.#muted;
  }

  onChange(handler: (status: MetronomeStatus) => void): void {
    this.#onChange = handler;
  }

  /**
   * Adopt an externally owned `AudioContext` so metronome time and analysis
   * time share one clock.
   *
   * NOTE: as of `types.ts` the library exposes no way to pass an AudioContext in
   * (`TuninatorOptions` has no `audioContext` field) and no way to read the one
   * it created (the worker has no getter), so in practice the metronome always
   * ends up creating its own. This hook is here for the day the API allows it.
   */
  useContext(context: AudioContext): void {
    if (this.#context === context) return;
    this.#teardownContext();
    this.#context = context;
    this.#ownsContext = false;
  }

  getAudioContext(): AudioContext | null {
    return this.#context;
  }

  /** The beat grid, in `performance.now()` ms. Always valid, running or not. */
  getGrid(): BeatGrid {
    return {
      originMs: this.#gridOriginMs,
      periodMs: this.periodMs,
      beatsPerBar: this.beatsPerBar,
    };
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (this.#gain && this.#context) {
      this.#gain.gain.setTargetAtTime(muted ? 0 : 1, this.#context.currentTime, 0.01);
    }
    this.#notify();
  }

  async start(): Promise<void> {
    if (this.#running) return;

    try {
      if (!this.#context) {
        const Ctor = window.AudioContext ?? (window as unknown as {
          webkitAudioContext?: typeof AudioContext;
        }).webkitAudioContext;
        if (!Ctor) throw new Error("Web Audio is not available in this browser.");
        this.#context = new Ctor();
        this.#ownsContext = true;
      }

      if (this.#context.state === "suspended") {
        await this.#context.resume();
      }
      if (this.#context.state !== "running") {
        this.#message =
          "Audio is blocked until you interact with the page — click Start again.";
        this.#notify();
        return;
      }

      if (!this.#gain) {
        this.#gain = this.#context.createGain();
        this.#gain.gain.value = this.#muted ? 0 : 1;
        this.#gain.connect(this.#context.destination);
      }
    } catch (cause) {
      this.#message =
        cause instanceof Error
          ? `Metronome audio failed: ${cause.message}`
          : "Metronome audio failed.";
      this.#notify();
      return;
    }

    // Anchor the beat grid to the first beat we are about to schedule, and
    // record the audio-clock <-> wall-clock correspondence at the same instant.
    const context = this.#context;
    const startAt = context.currentTime + 0.08;
    this.#nextBeat = 0;
    this.#nextBeatTime = startAt;
    this.#gridOriginMs = performance.now() + (startAt - context.currentTime) * 1000;

    this.#running = true;
    this.#message = null;
    // A plain interval, NOT requestAnimationFrame.
    this.#timer = setInterval(() => this.#schedule(), LOOKAHEAD_TICK_MS);
    this.#schedule();
    this.#notify();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (!this.#running) return;
    this.#running = false;
    // Keep the grid phase so gridlines stay put after the click stops.
    this.#notify();
  }

  async toggle(): Promise<void> {
    if (this.#running) this.stop();
    else await this.start();
  }

  dispose(): void {
    this.stop();
    this.#teardownContext();
  }

  /* ---- internals ---- */

  #teardownContext(): void {
    this.#gain?.disconnect();
    this.#gain = null;
    if (this.#context && this.#ownsContext) void this.#context.close();
    this.#context = null;
    this.#ownsContext = false;
  }

  /**
   * Queue every beat that falls inside the lookahead horizon. This runs on a
   * coarse timer; precision comes entirely from the sample-accurate `start()`
   * times handed to the oscillators.
   */
  #schedule(): void {
    const context = this.#context;
    if (!context || !this.#running) return;

    const period = this.periodMs / 1000;
    const horizon = context.currentTime + SCHEDULE_AHEAD_S;

    while (this.#nextBeatTime < horizon) {
      this.#click(this.#nextBeatTime, this.#nextBeat % this.beatsPerBar === 0);
      this.#nextBeat += 1;
      this.#nextBeatTime += period;
    }
  }

  #click(when: number, accent: boolean): void {
    const context = this.#context;
    const output = this.#gain;
    if (!context || !output) return;

    const osc = context.createOscillator();
    const env = context.createGain();

    osc.type = "square";
    osc.frequency.setValueAtTime(accent ? ACCENT_HZ : BEAT_HZ, when);

    const peak = accent ? 0.28 : 0.16;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(peak, when + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, when + CLICK_S);

    osc.connect(env);
    env.connect(output);
    osc.start(when);
    osc.stop(when + CLICK_S + 0.02);
    osc.onended = () => {
      osc.disconnect();
      env.disconnect();
    };
  }

  #notify(): void {
    this.#onChange({ running: this.#running, message: this.#message });
  }
}
