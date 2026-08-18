/**
 * Wiring: build a worker, pump its two streams into the timeline and the
 * panels, and keep the metronome running alongside.
 *
 * Only the public API is used. The single import from the library is
 * `createWorkerWebAudio` plus types, from the package entry points.
 */

import { createWorkerWebAudio } from "tuninator/web";
import type {
  MusicEvent,
  PitchFrame,
  TuninatorWorker,
  TuninatorError,
  TuninatorErrorCode,
  TuninatorMode,
  TuninatorOptions,
  TuninatorState,
} from "tuninator";

import { DEFAULT_BPM, Metronome } from "./metronome.js";
import { createMockTuninator } from "./mock-tuninator.js";
import { openChannelInput, type ChannelInput } from "./channel-input.js";
import { Timeline, WINDOW_BEATS } from "./timeline.js";
import { Ui, type SourceChoice } from "./ui.js";

import "./styles.css";

/** Where vite.config.ts drops the library's built worklet. */
const WORKLET_URL = "/assets/tuninator-worklet.js";

const ERROR_CODES: ReadonlySet<string> = new Set<TuninatorErrorCode>([
  "mic-unavailable",
  "mic-permission-denied",
  "audio-context-failed",
  "worklet-unavailable",
  "worklet-load-failed",
  "unknown",
]);

const MODES: ReadonlySet<string> = new Set<TuninatorMode>(["lead", "chords", "rhythm", "raw"]);

/* -------------------------------------------------------------------------- */
/* Timebase                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `PitchFrame.timestamp` is documented as "milliseconds, monotonic, comparable
 * with MusicEvent timestamps" -- but NOT as sharing an epoch with
 * `performance.now()`. The timeline has to place events relative to *now*, so
 * this estimates the offset between the two clocks instead of assuming one.
 *
 * The smallest observed `wall - lib` is the least-delayed sample and therefore
 * the best alignment estimate; a slow relaxation term keeps it from sticking to
 * an outlier if the clocks drift.
 */
class Timebase {
  #offset: number | null = null;

  observe(libMs: number): void {
    if (!Number.isFinite(libMs)) return;
    const sample = performance.now() - libMs;
    if (this.#offset === null || sample < this.#offset) {
      this.#offset = sample;
      return;
    }
    this.#offset += (sample - this.#offset) * 0.0008;
  }

  toWall(libMs: number): number {
    return libMs + (this.#offset ?? 0);
  }

  reset(): void {
    this.#offset = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Error normalisation                                                         */
/* -------------------------------------------------------------------------- */

function isTuninatorError(value: unknown): value is TuninatorError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === "string" &&
    ERROR_CODES.has(candidate.code) &&
    typeof candidate.message === "string"
  );
}

/**
 * `start()` is typed `Promise<void>`, so what it rejects *with* is not
 * part of the contract. Anything that escapes is folded into a `TuninatorError`
 * here so the UI always has a code and a readable message, never a raw throw.
 */
/** "channel 1", or "all channels summed" while no decision has latched. */
function describeSelection(channel: number | null): string {
  return channel === null ? "all channels summed" : `channel ${channel}`;
}

function toTuninatorError(cause: unknown): TuninatorError {
  if (isTuninatorError(cause)) return cause;

  if (typeof DOMException !== "undefined" && cause instanceof DOMException) {
    if (cause.name === "NotAllowedError" || cause.name === "SecurityError") {
      return { code: "mic-permission-denied", message: cause.message || cause.name, cause };
    }
    if (cause.name === "NotFoundError" || cause.name === "OverconstrainedError") {
      return { code: "mic-unavailable", message: cause.message || cause.name, cause };
    }
  }

  if (cause instanceof Error) {
    return { code: "unknown", message: cause.message || String(cause), cause };
  }
  return { code: "unknown", message: String(cause), cause };
}

/* -------------------------------------------------------------------------- */
/* URL configuration                                                           */
/* -------------------------------------------------------------------------- */

type Settings = {
  source: SourceChoice;
  mode: TuninatorMode;
  workletUrl: string;
  failWith: TuninatorErrorCode | null;
  autostart: boolean;
  metronome: boolean;
};

function readSettings(): Settings {
  const params = new URLSearchParams(window.location.search);

  const mockParam = params.get("mock");
  const source: SourceChoice =
    mockParam === null
      ? "auto"
      : mockParam === "0" || mockParam === "false"
        ? "live"
        : "mock";

  const modeParam = params.get("mode");
  const mode: TuninatorMode = modeParam && MODES.has(modeParam) ? (modeParam as TuninatorMode) : "lead";

  const failParam = params.get("failWith");
  const failWith =
    failParam && ERROR_CODES.has(failParam) ? (failParam as TuninatorErrorCode) : null;

  const truthy = (value: string | null): boolean =>
    value !== null && value !== "0" && value !== "false";

  return {
    source,
    mode,
    workletUrl: params.get("workletUrl") ?? WORKLET_URL,
    failWith,
    autostart: truthy(params.get("autostart")),
    metronome: truthy(params.get("metronome")),
  };
}

/* -------------------------------------------------------------------------- */
/* App                                                                         */
/* -------------------------------------------------------------------------- */

/** Counters the headless smoke test reads to assert the streams really flowed. */
type DemoProbe = {
  frames: number;
  eventsStarted: number;
  eventsEnded: number;
  source: "mock" | "live";
  state: TuninatorState;
  lastError: TuninatorError | null;
};

class App {
  #settings: Settings;
  #ui: Ui;
  #timeline: Timeline;
  #metronome: Metronome;
  #timebase = new Timebase();

  #tuninator: TuninatorWorker | null = null;
  /**
   * The demo's own input stage, when running live. The library is handed one
   * mono channel out of this; choosing which one is this demo's job.
   */
  #input: ChannelInput | null = null;
  #unsubscribes: Array<() => void> = [];
  #effectiveSource: "mock" | "live" = "mock";
  #listening = false;
  #busy = false;

  #probe: DemoProbe;

  constructor(settings: Settings) {
    this.#settings = settings;

    this.#ui = new Ui({
      onToggleListen: () => void this.#toggleListen(),
      onModeChange: (mode) => this.#setMode(mode),
      onSourceChange: (source) => void this.#setSource(source),
      onToggleMetronome: () => void this.#toggleMetronome(),
      onMuteChange: (muted) => this.#metronome.setMuted(muted),
    });

    this.#timeline = new Timeline(this.#ui.canvas, {
      toWall: (libMs) => this.#timebase.toWall(libMs),
    });

    this.#metronome = new Metronome(DEFAULT_BPM);
    this.#metronome.onChange((status) => {
      this.#ui.setMetronome(status, DEFAULT_BPM);
      this.#timeline.setGrid(this.#metronome.getGrid());
    });

    this.#probe = {
      frames: 0,
      eventsStarted: 0,
      eventsEnded: 0,
      source: "mock",
      state: "idle",
      lastError: null,
    };

    this.#timeline.setGrid(this.#metronome.getGrid());
    this.#timeline.start();

    this.#ui.setMode(settings.mode);
    this.#ui.setState("idle");
    this.#ui.setListening(false);
    this.#ui.setMetronome({ running: false, message: null }, DEFAULT_BPM);
    this.#ui.setStatus(
      `Ready. ${WINDOW_BEATS} beats of history at ${DEFAULT_BPM} bpm ` +
        `= ${((WINDOW_BEATS * 60_000) / DEFAULT_BPM / 1000).toFixed(2)}s on screen.`
    );

    this.#installGlobalErrorHandlers();
    this.#build(settings.source);

    if (settings.metronome) void this.#metronome.start();
    if (settings.autostart) void this.#toggleListen();
  }

  get probe(): DemoProbe {
    return this.#probe;
  }

  /* ---- construction ---- */

  #baseOptions(): TuninatorOptions {
    return {
      mode: this.#settings.mode,
      workletUrl: this.#settings.workletUrl,
      analysis: { minFrequencyHz: 70, maxFrequencyHz: 1400 },
    };
  }

  /**
   * `auto` prefers the real library and falls back to the mock if it cannot be
   * constructed at all -- which is exactly the situation while the detector is
   * unavailable (`createWorkerWebAudio` throws).
   */
  #build(choice: SourceChoice): void {
    this.#teardown();

    let instance: TuninatorWorker | null = null;
    let note: string | undefined;

    if (choice !== "mock") {
      try {
        instance = createWorkerWebAudio(this.#baseOptions());
        this.#effectiveSource = "live";
      } catch (cause) {
        const error = toTuninatorError(cause);
        if (choice === "live") {
          this.#ui.setError(error);
          this.#ui.logNote(`live source unavailable: ${error.message}`);
        } else {
          note = `The real library could not be constructed (${error.message}); using the mock.`;
          this.#ui.logNote(note);
          this.#ui.setStatus(note);
        }
        instance = null;
      }
    }

    if (!instance) {
      instance = createMockTuninator({
        ...this.#baseOptions(),
        ...(this.#settings.failWith ? { failWith: this.#settings.failWith } : {}),
      });
      this.#effectiveSource = "mock";
    }

    this.#tuninator = instance;
    this.#probe.source = this.#effectiveSource;
    this.#ui.setSource(choice, this.#effectiveSource, note);
    this.#ui.setMode(instance.getMode());
    this.#ui.setState(instance.getState());
    this.#timeline.setHint(
      this.#effectiveSource === "mock"
        ? "Press Start — the mock plays a 16-beat phrase."
        : "Press Start and play something."
    );
    this.#subscribe(instance);
  }

  #subscribe(tuninator: TuninatorWorker): void {
    this.#unsubscribes.push(
      tuninator.on("stateChange", (state: TuninatorState) => {
        this.#probe.state = state;
        this.#ui.setState(state);
        this.#listening = state === "listening";
        this.#ui.setListening(this.#listening, this.#busy);
        if (state === "waiting-for-user-gesture") {
          this.#ui.setStatus("Audio is waiting for a click — press Start again.");
        }
        if (state !== "error") this.#ui.setError(null);
      })
    );

    this.#unsubscribes.push(
      tuninator.on("status", (message: string) => this.#ui.setStatus(message))
    );

    this.#unsubscribes.push(
      tuninator.on("error", (error: TuninatorError) => {
        this.#probe.lastError = error;
        this.#ui.setError(error);
        this.#ui.logNote(`error (${error.code}): ${error.message}`);
      })
    );

    this.#unsubscribes.push(
      tuninator.on("pitchFrame", (frame: PitchFrame) => {
        this.#timebase.observe(frame.timestamp);
        this.#probe.frames += 1;
        this.#ui.setFrame(frame);
      })
    );

    this.#unsubscribes.push(
      tuninator.on("musicEventStart", (event: MusicEvent) => {
        this.#timebase.observe(event.startedAt);
        this.#probe.eventsStarted += 1;
        this.#timeline.track(event);
        this.#ui.logEvent("start", event);
        this.#ui.setActiveEvents(tuninator.getActiveEvents());
      })
    );

    this.#unsubscribes.push(
      tuninator.on("musicEventUpdate", (event: MusicEvent) => {
        this.#timebase.observe(event.updatedAt);
        this.#timeline.track(event);
        this.#ui.setActiveEvents(tuninator.getActiveEvents());
      })
    );

    this.#unsubscribes.push(
      tuninator.on("musicEventEnd", (event: MusicEvent) => {
        this.#timebase.observe(event.endedAt ?? event.updatedAt);
        this.#probe.eventsEnded += 1;
        this.#timeline.track(event);
        this.#ui.logEvent("end", event);
        this.#ui.setActiveEvents(tuninator.getActiveEvents());
      })
    );
  }

  /** Drops the worker and its subscriptions, leaving the input stage alone. */
  #teardownWorker(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes = [];
    this.#tuninator?.stop();
    this.#tuninator = null;
  }

  #teardown(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes = [];
    this.#tuninator?.stop();
    this.#tuninator = null;
    // Ours to close: the library never opened it and never will.
    this.#input?.dispose();
    this.#input = null;
    this.#listening = false;
    this.#timebase.reset();
  }

  /* ---- transport ---- */

  async #toggleListen(): Promise<void> {
    let tuninator = this.#tuninator;
    if (!tuninator || this.#busy) return;

    if (this.#listening || tuninator.getState() === "listening") {
      tuninator.stop();
      this.#listening = false;
      this.#ui.setListening(false);
      this.#ui.setActiveEvents([]);
      return;
    }

    this.#busy = true;
    this.#ui.setListening(false, true);
    this.#ui.setError(null);
    try {
      // A user gesture is on the stack here, so the AudioContexts can legally
      // start -- the metronome's, and the one our input stage creates.
      //
      // The live worker is built lazily, here rather than in #build(), because
      // it needs an input node and opening the microphone is async. That is the
      // whole shape of the split: the demo acquires and chooses, the library
      // analyses what it is given.
      if (this.#effectiveSource === "live" && this.#input === null) {
        this.#input = await openChannelInput({ channelCount: 2 });
        this.#ui.logNote(
          `input: ${this.#input.channelCount} channel(s); ` +
            `analysing ${describeSelection(this.#input.selected())}`
        );
        this.#teardownWorker();
        tuninator = createWorkerWebAudio({
          ...this.#baseOptions(),
          input: { source: this.#input.node },
        });
        this.#tuninator = tuninator;
        this.#subscribe(tuninator);
      }
      await tuninator.start();
      this.#listening = tuninator.getState() === "listening";
    } catch (cause) {
      const error = toTuninatorError(cause);
      this.#probe.lastError = error;
      this.#ui.setError(error);
      this.#ui.setStatus(`Could not start: ${error.message}`);
      this.#listening = false;
    } finally {
      this.#busy = false;
      this.#ui.setListening(this.#listening, false);
    }
  }

  #setMode(mode: TuninatorMode): void {
    this.#settings.mode = mode;
    try {
      // Documented as safe while listening, and never restarting the graph.
      this.#tuninator?.setMode(mode);
      this.#ui.logNote(`mode → ${mode}`);
    } catch (cause) {
      const error = toTuninatorError(cause);
      this.#ui.setError(error);
    }
    this.#ui.setMode(this.#tuninator?.getMode() ?? mode);
  }

  async #setSource(choice: SourceChoice): Promise<void> {
    const wasListening = this.#listening;
    this.#settings.source = choice;
    this.#ui.setError(null);
    this.#timeline.clear();
    this.#ui.clearLog();
    this.#ui.setActiveEvents([]);
    this.#build(choice);
    if (wasListening) await this.#toggleListen();
  }

  async #toggleMetronome(): Promise<void> {
    await this.#metronome.toggle();
    this.#timeline.setGrid(this.#metronome.getGrid());
  }

  /* ---- safety net ---- */

  #installGlobalErrorHandlers(): void {
    window.addEventListener("error", (event) => {
      this.#ui.setError(toTuninatorError(event.error ?? event.message));
    });
    window.addEventListener("unhandledrejection", (event) => {
      this.#ui.setError(toTuninatorError(event.reason));
      event.preventDefault();
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

declare global {
  interface Window {
    __tuninatorDemo?: DemoProbe;
  }
}

function boot(): void {
  try {
    const app = new App(readSettings());
    window.__tuninatorDemo = app.probe;
  } catch (cause) {
    // The UI itself failed to construct; there is no banner to render into.
    const error = toTuninatorError(cause);
    const fallback = document.createElement("pre");
    fallback.style.cssText = "padding:24px;color:#ff7b72;font:13px ui-monospace,monospace";
    fallback.textContent = `Demo failed to start (${error.code}): ${error.message}`;
    document.body.prepend(fallback);
    console.error(cause);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
