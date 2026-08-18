/**
 * Everything that is not the canvas: transport controls, state/status/error
 * surfaces, the live tuner readout, the active-event list and the event log.
 *
 * `ui.ts` knows about the DOM and about the library's public types; it knows
 * nothing about how a worker is created or driven. `main.ts` owns that.
 */

import type {
  MusicEvent,
  PitchFrame,
  TuninatorError,
  TuninatorErrorCode,
  TuninatorMode,
  TuninatorState,
} from "tuninator";

import type { MetronomeStatus } from "./metronome.js";

export type SourceChoice = "auto" | "mock" | "live";

export type UiCallbacks = {
  onToggleListen: () => void;
  onModeChange: (mode: TuninatorMode) => void;
  onSourceChange: (source: SourceChoice) => void;
  onToggleMetronome: () => void;
  onMuteChange: (muted: boolean) => void;
};

const MODES: readonly TuninatorMode[] = ["lead", "chords", "rhythm", "raw"];
const LOG_LIMIT = 150;

/**
 * Human-readable copy for every code in `TuninatorErrorCode`. A raw code is
 * never shown on its own, and nothing is ever left to an uncaught console throw.
 */
const ERROR_COPY: Record<TuninatorErrorCode, { title: string; hint: string }> = {
  "mic-unavailable": {
    title: "No microphone found",
    hint: "Plug in or enable an input device, then press Start again.",
  },
  "mic-permission-denied": {
    title: "Microphone access was denied",
    hint:
      "The browser blocked microphone access. Allow it for this site " +
      "(the padlock icon in the address bar), then press Start again. " +
      "You can explore the demo without a microphone using the mock source.",
  },
  "audio-context-failed": {
    title: "Audio could not be started",
    hint: "The browser refused to create an AudioContext. Reload the page and press Start.",
  },
  "worklet-unavailable": {
    title: "AudioWorklet is not supported",
    hint: "This browser cannot run the analysis worklet. Try a current Chrome, Edge, Firefox or Safari.",
  },
  "worklet-load-failed": {
    title: "The analysis worklet could not be loaded",
    hint:
      "Check that `workletUrl` points at a real file. This demo expects " +
      "/assets/tuninator-worklet.js, copied from the library's dist/ by vite.config.ts.",
  },
  unknown: {
    title: "Something went wrong",
    hint: "See the message below. Reload the page and try again.",
  },
};

const STATE_COPY: Record<TuninatorState, string> = {
  idle: "idle",
  starting: "starting…",
  listening: "listening",
  "waiting-for-user-gesture": "tap to allow audio",
  error: "error",
};

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`ui: missing #${id} in index.html`);
  return element as T;
}

function formatHz(hz: number): string {
  return hz >= 1000 ? hz.toFixed(0) : hz.toFixed(1);
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export class Ui {
  readonly canvas: HTMLCanvasElement;

  #listenBtn: HTMLButtonElement;
  #modeSelect: HTMLSelectElement;
  #sourceSelect: HTMLSelectElement;
  #metronomeBtn: HTMLButtonElement;
  #muteCheckbox: HTMLInputElement;

  #sourceBadge: HTMLElement;
  #statePill: HTMLElement;
  #statusMessage: HTMLElement;
  #errorBanner: HTMLElement;
  #errorTitle: HTMLElement;
  #errorCode: HTMLElement;
  #errorMessage: HTMLElement;
  #errorHint: HTMLElement;

  #noteName: HTMLElement;
  #noteDetail: HTMLElement;
  #centsValue: HTMLElement;
  #needle: HTMLElement;
  #frequency: HTMLElement;
  #confidenceFill: HTMLElement;
  #confidenceValue: HTMLElement;
  #levelFill: HTMLElement;

  #activeEvents: HTMLElement;
  #eventLog: HTMLElement;
  #logCount = 0;

  #pendingFrame: PitchFrame | null = null;
  #pendingEvents: MusicEvent[] | null = null;
  #flushScheduled = false;

  constructor(callbacks: UiCallbacks) {
    this.canvas = must<HTMLCanvasElement>("timeline-canvas");

    this.#listenBtn = must<HTMLButtonElement>("listen-btn");
    this.#modeSelect = must<HTMLSelectElement>("mode-select");
    this.#sourceSelect = must<HTMLSelectElement>("source-select");
    this.#metronomeBtn = must<HTMLButtonElement>("metronome-btn");
    this.#muteCheckbox = must<HTMLInputElement>("metronome-mute");

    this.#sourceBadge = must("source-badge");
    this.#statePill = must("state-pill");
    this.#statusMessage = must("status-message");
    this.#errorBanner = must("error-banner");
    this.#errorTitle = must("error-title");
    this.#errorCode = must("error-code");
    this.#errorMessage = must("error-message");
    this.#errorHint = must("error-hint");

    this.#noteName = must("note-name");
    this.#noteDetail = must("note-detail");
    this.#centsValue = must("cents-value");
    this.#needle = must("needle");
    this.#frequency = must("frequency-value");
    this.#confidenceFill = must("confidence-fill");
    this.#confidenceValue = must("confidence-value");
    this.#levelFill = must("level-fill");

    this.#activeEvents = must("active-events");
    this.#eventLog = must("event-log");

    for (const mode of MODES) {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = mode;
      this.#modeSelect.append(option);
    }

    this.#listenBtn.addEventListener("click", () => callbacks.onToggleListen());
    this.#metronomeBtn.addEventListener("click", () => callbacks.onToggleMetronome());
    this.#muteCheckbox.addEventListener("change", () =>
      callbacks.onMuteChange(this.#muteCheckbox.checked)
    );
    // setMode() is documented as safe while listening, so this stays enabled.
    this.#modeSelect.addEventListener("change", () =>
      callbacks.onModeChange(this.#modeSelect.value as TuninatorMode)
    );
    this.#sourceSelect.addEventListener("change", () =>
      callbacks.onSourceChange(this.#sourceSelect.value as SourceChoice)
    );
  }

  /* ---- transport / state ---- */

  setListening(listening: boolean, busy = false): void {
    this.#listenBtn.textContent = listening ? "Stop" : "Start listening";
    this.#listenBtn.classList.toggle("is-active", listening);
    this.#listenBtn.disabled = busy;
  }

  setState(state: TuninatorState): void {
    this.#statePill.textContent = STATE_COPY[state] ?? state;
    this.#statePill.dataset["state"] = state;
  }

  setStatus(message: string): void {
    this.#statusMessage.textContent = message;
  }

  setMode(mode: TuninatorMode): void {
    this.#modeSelect.value = mode;
  }

  setSource(choice: SourceChoice, effective: "mock" | "live", note?: string): void {
    this.#sourceSelect.value = choice;
    this.#sourceBadge.textContent = effective === "mock" ? "mock input" : "live microphone";
    this.#sourceBadge.dataset["kind"] = effective;
    this.#sourceBadge.title = note ?? "";
  }

  setMetronome(status: MetronomeStatus, bpm: number): void {
    this.#metronomeBtn.textContent = status.running
      ? `Metronome on · ${bpm} bpm`
      : `Metronome off · ${bpm} bpm`;
    this.#metronomeBtn.classList.toggle("is-active", status.running);
    if (status.message) this.setStatus(status.message);
  }

  /* ---- errors ---- */

  setError(error: TuninatorError | null): void {
    if (!error) {
      this.#errorBanner.hidden = true;
      return;
    }
    const copy = ERROR_COPY[error.code] ?? ERROR_COPY.unknown;
    this.#errorTitle.textContent = copy.title;
    this.#errorCode.textContent = error.code;
    this.#errorMessage.textContent = error.message;
    this.#errorHint.textContent = copy.hint;
    this.#errorBanner.hidden = false;
  }

  /* ---- live readouts (batched to one paint per frame) ---- */

  setFrame(frame: PitchFrame): void {
    this.#pendingFrame = frame;
    this.#scheduleFlush();
  }

  setActiveEvents(events: MusicEvent[]): void {
    this.#pendingEvents = events;
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    requestAnimationFrame(() => {
      this.#flushScheduled = false;
      if (this.#pendingFrame) {
        this.#renderFrame(this.#pendingFrame);
        this.#pendingFrame = null;
      }
      if (this.#pendingEvents) {
        this.#renderActiveEvents(this.#pendingEvents);
        this.#pendingEvents = null;
      }
    });
  }

  #renderFrame(frame: PitchFrame): void {
    const { frequencyHz, nearest, confidence } = frame;

    if (frequencyHz === null || nearest === null) {
      this.#noteName.textContent = "—";
      this.#noteName.dataset["tuned"] = "off";
      this.#noteDetail.textContent = "no pitch";
      this.#centsValue.textContent = "";
      this.#needle.style.transform = "rotate(0deg)";
      this.#needle.dataset["tuned"] = "off";
      this.#frequency.textContent = "— Hz";
    } else {
      const cents = nearest.cents;
      this.#noteName.textContent = nearest.pitchClass;
      this.#noteDetail.textContent = `${nearest.name} · MIDI ${nearest.midi}`;
      this.#centsValue.textContent = `${cents >= 0 ? "+" : ""}${cents.toFixed(1)}¢`;
      // -50..+50 cents maps to -45..+45 degrees.
      this.#needle.style.transform = `rotate(${clamp(cents, -50, 50) * 0.9}deg)`;
      const inTune = Math.abs(cents) <= 5 ? "in" : Math.abs(cents) <= 15 ? "near" : "out";
      this.#needle.dataset["tuned"] = inTune;
      this.#noteName.dataset["tuned"] = inTune;
      this.#frequency.textContent = `${formatHz(frequencyHz)} Hz`;
    }

    const pct = clamp(confidence, 0, 1) * 100;
    this.#confidenceFill.style.width = `${pct.toFixed(1)}%`;
    this.#confidenceValue.textContent = confidence.toFixed(2);

    // rms is roughly 0..0.3 for guitar; a log scale keeps the meter readable.
    const rms = frame.amplitude.rms;
    const level = rms <= 0 ? 0 : clamp((20 * Math.log10(rms) + 60) / 60, 0, 1);
    this.#levelFill.style.width = `${(level * 100).toFixed(1)}%`;
  }

  #renderActiveEvents(events: MusicEvent[]): void {
    if (events.length === 0) {
      this.#activeEvents.innerHTML = '<p class="empty">nothing sounding</p>';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const event of events) {
      const row = document.createElement("div");
      row.className = "event-card";
      row.dataset["kind"] = event.kind;

      const heading = document.createElement("div");
      heading.className = "event-card-head";

      const name = document.createElement("span");
      name.className = "event-name";
      name.textContent = event.label.name;
      heading.append(name);

      const state = document.createElement("span");
      state.className = "chip";
      state.dataset["state"] = event.state;
      state.textContent = event.state;
      heading.append(state);

      const kind = document.createElement("span");
      kind.className = "chip subtle";
      kind.textContent = event.kind;
      heading.append(kind);

      row.append(heading);

      const meta = document.createElement("dl");
      meta.className = "event-meta";
      const duration = Math.round(event.updatedAt - event.startedAt);
      addMeta(meta, "conf", event.confidence.toFixed(2));
      addMeta(meta, "held", `${duration} ms`);
      if (event.primaryPitch?.frequencyHz !== undefined) {
        addMeta(meta, "f0", `${formatHz(event.primaryPitch.frequencyHz)} Hz`);
      }
      if (event.label.quality) addMeta(meta, "quality", event.label.quality);
      if (event.bend.isActive || Math.abs(event.bend.centsFromStart) >= 1) {
        const cents = event.bend.centsFromStart;
        addMeta(
          meta,
          "bend",
          `${cents >= 0 ? "+" : ""}${cents.toFixed(0)}¢ (${event.bend.semitonesFromStart.toFixed(2)} st)`
        );
      }
      if (event.ambiguity.polyphony !== undefined) {
        addMeta(meta, "poly", String(event.ambiguity.polyphony));
      }
      row.append(meta);

      if (event.pitches.length > 1) {
        const tones = document.createElement("div");
        tones.className = "event-tones";
        tones.textContent = event.pitches
          .map((pitch) => pitch.name ?? (pitch.frequencyHz ? `${formatHz(pitch.frequencyHz)}Hz` : "?"))
          .join(" · ");
        row.append(tones);
      }

      const alternatives = event.ambiguity.alternatives;
      if (alternatives && alternatives.length > 0) {
        const alt = document.createElement("div");
        alt.className = "event-alt";
        alt.textContent = `also: ${alternatives
          .map((a) => `${a.label} (${a.confidence.toFixed(2)})`)
          .join(", ")}`;
        row.append(alt);
      }

      fragment.append(row);
    }

    this.#activeEvents.replaceChildren(fragment);
  }

  /* ---- log ---- */

  logEvent(phase: "start" | "end", event: MusicEvent): void {
    const line = document.createElement("div");
    line.className = "log-line";
    line.dataset["phase"] = phase;

    const marker = document.createElement("span");
    marker.className = "log-marker";
    marker.textContent = phase === "start" ? "▶" : "■";

    const label = document.createElement("span");
    label.className = "log-label";
    label.textContent = event.label.name;

    const detail = document.createElement("span");
    detail.className = "log-detail";
    if (phase === "start") {
      detail.textContent = `${event.kind} · conf ${event.confidence.toFixed(2)}`;
    } else {
      const held = event.endedAt === null ? 0 : Math.round(event.endedAt - event.startedAt);
      const bend = Math.abs(event.bend.centsFromStart) >= 20
        ? ` · bend ${event.bend.centsFromStart >= 0 ? "+" : ""}${event.bend.centsFromStart.toFixed(0)}¢`
        : "";
      detail.textContent = `${held} ms${bend}`;
    }

    line.append(marker, label, detail);
    this.#eventLog.prepend(line);

    this.#logCount += 1;
    while (this.#eventLog.childElementCount > LOG_LIMIT) {
      this.#eventLog.lastElementChild?.remove();
    }
  }

  logNote(message: string): void {
    const line = document.createElement("div");
    line.className = "log-line";
    line.dataset["phase"] = "note";
    const detail = document.createElement("span");
    detail.className = "log-detail";
    detail.textContent = message;
    line.append(detail);
    this.#eventLog.prepend(line);
  }

  clearLog(): void {
    this.#eventLog.replaceChildren();
    this.#logCount = 0;
  }

  get loggedCount(): number {
    return this.#logCount;
  }
}

function addMeta(list: HTMLDListElement, term: string, value: string): void {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  list.append(dt, dd);
}
