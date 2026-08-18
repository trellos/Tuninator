/**
 * A synthetic `Tuninator` implementation.
 *
 * The real detector is built by a concurrent workstream and its `dist/` does not
 * exist yet, so the entire demo UI is developed and verified against this. It
 * plays a fixed 16-beat guitar phrase at 90bpm -- single notes, two chords and
 * one bent note -- emitting the same `pitchFrame` / `musicEvent*` streams the
 * real library promises.
 *
 * It stays useful after the detector lands: it is a deterministic UI test
 * harness that needs no microphone, no permission prompt and no audio hardware,
 * which is exactly what the headless smoke test drives.
 *
 * It implements the PUBLIC `Tuninator` type and imports nothing but types from
 * the package entry point.
 */

import type {
  EventPitch,
  MusicEvent,
  MusicEventState,
  PitchClass,
  PitchFrame,
  PitchNote,
  Tuninator,
  TuninatorError,
  TuninatorErrorCode,
  TuninatorEventHandler,
  TuninatorEventName,
  TuninatorMode,
  TuninatorOptions,
  TuninatorState,
} from "tuninator";

/* -------------------------------------------------------------------------- */
/* Note helpers (synthesis-side only -- the real library derives these itself)  */
/* -------------------------------------------------------------------------- */

const PITCH_CLASSES: readonly PitchClass[] = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

const A4_MIDI = 69;
const A4_HZ = 440;

function midiToHz(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

function hzToMidiFloat(hz: number): number {
  return A4_MIDI + 12 * Math.log2(hz / A4_HZ);
}

function pitchClassOf(midi: number): PitchClass {
  const index = ((Math.round(midi) % 12) + 12) % 12;
  return PITCH_CLASSES[index] ?? "C";
}

function octaveOf(midi: number): number {
  return Math.floor(Math.round(midi) / 12) - 1;
}

function noteNameOf(midi: number): string {
  return `${pitchClassOf(midi)}${octaveOf(midi)}`;
}

/** Build the `PitchNote` the library would report for a detected frequency. */
function nearestNote(frequencyHz: number): PitchNote {
  const exact = hzToMidiFloat(frequencyHz);
  const midi = Math.round(exact);
  let cents = (exact - midi) * 100;
  // Range is documented as (-50, +50].
  if (cents <= -50) cents += 100;
  if (cents > 50) cents -= 100;
  return {
    midi,
    name: noteNameOf(midi),
    pitchClass: pitchClassOf(midi),
    octave: octaveOf(midi),
    frequencyHz,
    cents,
  };
}

/* -------------------------------------------------------------------------- */
/* The score                                                                   */
/* -------------------------------------------------------------------------- */

const BPM = 90;
const BEAT_MS = 60_000 / BPM;

type ScoreEntry = {
  /** Beat offset from the top of the 16-beat loop. */
  beat: number;
  /** Length in beats. */
  beats: number;
  kind: "note" | "chord";
  name: string;
  root?: PitchClass;
  quality?: string;
  /** MIDI numbers, lowest first. */
  midi: number[];
  /** Index into `midi` carrying the melody. Defaults to 0. */
  primaryIndex?: number;
  /** Cents reached at the end of the event, if this note is bent. */
  bendCents?: number;
  /** Fraction (0..1) into the event where the bend begins. */
  bendFrom?: number;
  /** Runner-up interpretations the detector might report. */
  alternatives?: Array<{ label: string; confidence: number }>;
};

/**
 * Sixteen beats -- exactly one full timeline window -- then it loops.
 * An open-position phrase in E minor: a lick, a bent B, and three chords.
 */
const SCORE: readonly ScoreEntry[] = [
  { beat: 0.0, beats: 0.9, kind: "note", name: "E4", midi: [64] },
  { beat: 1.0, beats: 0.7, kind: "note", name: "G4", midi: [67] },
  { beat: 1.75, beats: 0.7, kind: "note", name: "A4", midi: [69] },
  {
    beat: 2.5,
    beats: 1.4,
    kind: "note",
    name: "B4",
    midi: [71],
    bendCents: 200,
    bendFrom: 0.45,
  },
  { beat: 4.0, beats: 0.45, kind: "note", name: "A4", midi: [69] },
  { beat: 4.5, beats: 0.45, kind: "note", name: "G4", midi: [67] },
  {
    beat: 5.0,
    beats: 1.9,
    kind: "chord",
    name: "Em",
    root: "E",
    quality: "min",
    midi: [52, 55, 59, 64],
    alternatives: [
      { label: "G6", confidence: 0.31 },
      { label: "E5", confidence: 0.18 },
    ],
  },
  { beat: 7.0, beats: 0.9, kind: "note", name: "D4", midi: [62] },
  { beat: 8.0, beats: 0.7, kind: "note", name: "E4", midi: [64] },
  { beat: 8.75, beats: 0.7, kind: "note", name: "G4", midi: [67] },
  { beat: 9.5, beats: 0.45, kind: "note", name: "A4", midi: [69] },
  {
    beat: 10.0,
    beats: 1.9,
    kind: "chord",
    name: "Cmaj",
    root: "C",
    quality: "maj",
    midi: [48, 52, 55, 60],
    alternatives: [{ label: "Am7", confidence: 0.27 }],
  },
  { beat: 12.0, beats: 0.7, kind: "note", name: "B3", midi: [59] },
  { beat: 12.75, beats: 0.7, kind: "note", name: "A3", midi: [57] },
  { beat: 13.5, beats: 0.45, kind: "note", name: "G3", midi: [55] },
  {
    beat: 14.0,
    beats: 1.9,
    kind: "chord",
    name: "G",
    root: "G",
    quality: "maj",
    midi: [43, 47, 50, 55],
    alternatives: [{ label: "G5", confidence: 0.22 }],
  },
];

const LOOP_BEATS = 16;
const LOOP_MS = LOOP_BEATS * BEAT_MS;

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export type MockTuninatorOptions = TuninatorOptions & {
  /** Make `start()` fail with this code, to exercise the error UI. */
  failWith?: TuninatorErrorCode;
  /** Milliseconds `start()` spends in the `starting` state. */
  startupMs?: number;
};

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

/** 128 samples x 4 quanta at 44.1kHz -- the library's default-ish hop. */
const HOP_MS = (128 * 4 * 1000) / 44_100;
const EFFECTIVE_SAMPLE_RATE = 11_025;
const UPDATE_INTERVAL_MS = 60;
/** Never emit more than this many hops in one tick, after a tab-throttle stall. */
const MAX_HOPS_PER_TICK = 24;

type LiveEvent = {
  entry: ScoreEntry;
  event: MusicEvent;
  startMs: number;
  endMs: number;
  lastUpdateMs: number;
};

const ERROR_MESSAGES: Record<TuninatorErrorCode, string> = {
  "mic-unavailable": "No microphone input device was found.",
  "mic-permission-denied": "Microphone permission was denied.",
  "audio-context-failed": "The browser refused to create an AudioContext.",
  "worklet-unavailable": "This browser does not support AudioWorklet.",
  "worklet-load-failed": "The tuninator worklet asset could not be loaded.",
  unknown: "An unknown error occurred.",
};

/**
 * Payload per event name. `TuninatorEventHandler` is a conditional type, which
 * TypeScript cannot resolve through a still-generic `E`, so the emit side needs
 * this map to stay type-safe.
 */
type EventPayloads = {
  stateChange: TuninatorState;
  status: string;
  pitchFrame: PitchFrame;
  musicEventStart: MusicEvent;
  musicEventUpdate: MusicEvent;
  musicEventEnd: MusicEvent;
  error: TuninatorError;
};

class MockTuninator implements Tuninator {
  #state: TuninatorState = "idle";
  #mode: TuninatorMode;
  #options: MockTuninatorOptions;

  #handlers = new Map<TuninatorEventName, Set<(payload: never) => void>>();

  #timer: ReturnType<typeof setInterval> | null = null;
  /** Timeline origin, in the same clock as every emitted timestamp. */
  #originMs = 0;
  /** Timestamp of the last hop already emitted. */
  #cursorMs = 0;
  #eventSeq = 0;
  #live = new Map<string, LiveEvent>();
  /** `iteration:beat` -> event id, so the looping score does not restart events. */
  #instanceKeys = new Map<string, string>();

  constructor(options: MockTuninatorOptions = {}) {
    this.#options = options;
    this.#mode = options.mode ?? "lead";
  }

  /* ---- public surface ---- */

  async start(): Promise<void> {
    if (this.#state === "listening" || this.#state === "starting") return;

    this.#setState("starting");
    this.#emit("status", "mock: warming up synthetic input…");
    await delay(this.#options.startupMs ?? 140);

    const failWith = this.#options.failWith;
    if (failWith) {
      const error: TuninatorError = {
        code: failWith,
        message: `${ERROR_MESSAGES[failWith]} (simulated by the mock)`,
      };
      this.#setState("error");
      this.#emit("error", error);
      throw error;
    }

    this.#originMs = now();
    this.#cursorMs = this.#originMs;
    this.#setState("listening");
    this.#emit("status", `mock: playing a 16-beat phrase at ${BPM}bpm`);
    this.#timer = setInterval(() => this.#tick(), 16);
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const t = now();
    for (const live of [...this.#live.values()]) this.#endEvent(live, t);
    this.#live.clear();
    this.#instanceKeys.clear();
    if (this.#state !== "idle") {
      this.#setState("idle");
      this.#emit("status", "mock: stopped");
    }
  }

  setMode(mode: TuninatorMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#emit("status", `mock: mode → ${mode}`);
  }

  getMode(): TuninatorMode {
    return this.#mode;
  }

  getState(): TuninatorState {
    return this.#state;
  }

  getActiveEvents(): MusicEvent[] {
    return [...this.#live.values()].map((live) => live.event);
  }

  on<E extends TuninatorEventName>(
    eventName: E,
    handler: TuninatorEventHandler<E>
  ): () => void {
    let set = this.#handlers.get(eventName);
    if (!set) {
      set = new Set();
      this.#handlers.set(eventName, set);
    }
    const fn = handler as unknown as (payload: never) => void;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /* ---- internals ---- */

  #emit<E extends TuninatorEventName>(eventName: E, payload: EventPayloads[E]): void {
    const set = this.#handlers.get(eventName);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as (p: unknown) => void)(payload);
      } catch (cause) {
        console.error(`mock-tuninator: handler for "${eventName}" threw`, cause);
      }
    }
  }

  #setState(state: TuninatorState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#emit("stateChange", state);
  }

  #tick(): void {
    const wallNow = now();

    // After a long stall (backgrounded tab) skip ahead rather than firing a
    // burst of stale frames -- a real detector would have dropped them too.
    if (wallNow - this.#cursorMs > MAX_HOPS_PER_TICK * HOP_MS) {
      this.#cursorMs = wallNow - HOP_MS;
    }

    let hops = 0;
    while (this.#cursorMs + HOP_MS <= wallNow && hops < MAX_HOPS_PER_TICK) {
      this.#cursorMs += HOP_MS;
      hops += 1;
      this.#step(this.#cursorMs);
    }
  }

  /** Advance the simulation to one hop boundary. */
  #step(t: number): void {
    const elapsed = t - this.#originMs;
    const iteration = Math.floor(elapsed / LOOP_MS);
    const loopMs = elapsed - iteration * LOOP_MS;

    // Start / update / end events for this instant.
    this.#syncEvents(t, iteration);

    // Then the continuous frame, derived from whatever is sounding.
    this.#emit("pitchFrame", this.#frameAt(t, loopMs));
  }

  #syncEvents(t: number, iteration: number): void {
    // End anything whose window has passed.
    for (const live of [...this.#live.values()]) {
      if (t >= live.endMs) this.#endEvent(live, live.endMs);
    }

    // Start anything whose window has opened.
    for (const entry of SCORE) {
      const startMs = this.#originMs + iteration * LOOP_MS + entry.beat * BEAT_MS;
      const endMs = startMs + entry.beats * BEAT_MS;
      if (t < startMs || t >= endMs) continue;

      const key = `${iteration}:${entry.beat}`;
      if (this.#hasInstance(key)) continue;

      const id = `mock-${++this.#eventSeq}`;
      const event = this.#makeEvent(id, entry, startMs, t, 0);
      const live: LiveEvent = {
        entry,
        event,
        startMs,
        endMs,
        lastUpdateMs: t,
      };
      // Stash the instance key on the live record via the id map.
      this.#live.set(id, live);
      this.#instanceKeys.set(key, id);
      this.#emit("musicEventStart", event);
    }

    // Update whatever is still sounding.
    for (const live of this.#live.values()) {
      if (t - live.lastUpdateMs < UPDATE_INTERVAL_MS) continue;
      live.lastUpdateMs = t;
      const progress = clamp01((t - live.startMs) / (live.endMs - live.startMs));
      live.event = this.#makeEvent(
        live.event.id,
        live.entry,
        live.startMs,
        t,
        this.#bendCentsAt(live.entry, progress)
      );
      this.#emit("musicEventUpdate", live.event);
    }
  }

  #hasInstance(key: string): boolean {
    const id = this.#instanceKeys.get(key);
    if (id === undefined) return false;
    if (this.#live.has(id)) return true;
    this.#instanceKeys.delete(key);
    return false;
  }

  #endEvent(live: LiveEvent, endedAt: number): void {
    const ended: MusicEvent = {
      ...this.#makeEvent(
        live.event.id,
        live.entry,
        live.startMs,
        endedAt,
        this.#bendCentsAt(live.entry, 1)
      ),
      state: "ended",
      endedAt,
    };
    live.event = ended;
    this.#live.delete(ended.id);
    this.#emit("musicEventEnd", ended);
  }

  #bendCentsAt(entry: ScoreEntry, progress: number): number {
    if (entry.bendCents === undefined) return 0;
    const from = entry.bendFrom ?? 0.5;
    if (progress <= from) return 0;
    const bendProgress = clamp01((progress - from) / (1 - from));
    // Ease-out: a real bend arrives fast then holds.
    const eased = 1 - Math.pow(1 - bendProgress, 2);
    return entry.bendCents * eased;
  }

  #makeEvent(
    id: string,
    entry: ScoreEntry,
    startedAt: number,
    updatedAt: number,
    bendCents: number
  ): MusicEvent {
    const durationMs = entry.beats * BEAT_MS;
    const progress = clamp01((updatedAt - startedAt) / durationMs);
    const envelope = envelopeAt(progress);
    const bendActive = Math.abs(bendCents) >= (this.#options.tracking?.bendThresholdCents ?? 25);

    const state: MusicEventState = bendActive
      ? "bend"
      : progress < 0.12
        ? "attack"
        : progress > 0.82
          ? "release"
          : "sustain";

    const primaryIndex = entry.primaryIndex ?? 0;
    const confidence = clamp01(
      (entry.kind === "chord" ? 0.78 : 0.9) * (0.72 + 0.28 * envelope) - jitter(updatedAt, 0.03)
    );

    const pitches: EventPitch[] = entry.midi.map((midi, index) => {
      const isPrimary = index === primaryIndex;
      const bent = isPrimary ? bendCents : 0;
      const frequencyHz = midiToHz(midi + bent / 100);
      const role: EventPitch["role"] =
        entry.kind === "chord"
          ? index === 0
            ? "bass"
            : "chordTone"
          : isPrimary
            ? "primary"
            : "overtone";
      return {
        frequencyHz,
        midi,
        name: noteNameOf(midi),
        pitchClass: pitchClassOf(midi),
        octave: octaveOf(midi),
        cents: bent + jitter(updatedAt + index * 97, 2.5),
        role,
        confidence: clamp01(confidence - index * 0.06),
        amplitude: envelope * (index === 0 ? 1 : 0.72),
        salience: clamp01(1 - index * 0.18),
      };
    });

    const primaryPitch = pitches[primaryIndex] ?? pitches[0] ?? null;

    return {
      id,
      kind: entry.kind,
      startedAt,
      updatedAt,
      endedAt: null,
      state,
      label: {
        name: entry.name,
        ...(entry.root !== undefined ? { root: entry.root } : {}),
        ...(entry.quality !== undefined ? { quality: entry.quality } : {}),
      },
      primaryPitch,
      pitches,
      confidence,
      confidenceParts: {
        pitch: clamp01(confidence + 0.04),
        stability: clamp01(0.6 + 0.4 * progress),
        amplitude: envelope,
        continuity: clamp01(0.7 + 0.3 * progress),
        ...(entry.kind === "chord"
          ? { spectralFit: clamp01(confidence - 0.05), noteCoverage: 0.75 }
          : {}),
      },
      ambiguity: {
        polyphony: entry.kind === "chord" ? entry.midi.length : 1,
        transientNoise: clamp01(0.5 * (1 - progress * 6)),
        ...(entry.alternatives ? { alternatives: entry.alternatives } : {}),
      },
      amplitude: {
        rms: 0.02 + envelope * 0.16,
        peak: 0.05 + envelope * 0.38,
      },
      bend: {
        isActive: bendActive,
        centsFromStart: bendCents,
        semitonesFromStart: bendCents / 100,
      },
    };
  }

  /** The continuous stream, including silence between events. */
  #frameAt(t: number, loopMs: number): PitchFrame {
    // Find the sounding score entry, honouring a short release tail.
    let sounding: { entry: ScoreEntry; progress: number } | null = null;
    for (const entry of SCORE) {
      const startMs = entry.beat * BEAT_MS;
      const endMs = startMs + entry.beats * BEAT_MS;
      if (loopMs >= startMs && loopMs < endMs) {
        sounding = { entry, progress: (loopMs - startMs) / (endMs - startMs) };
        break;
      }
    }

    if (!sounding) {
      // Gated silence: the library still emits a frame.
      return {
        timestamp: t,
        frequencyHz: null,
        confidence: 0.04 + Math.abs(jitter(t, 0.06)),
        nearest: null,
        amplitude: { rms: 0.0015 + Math.abs(jitter(t, 0.001)), peak: 0.006 },
        detector: {
          tau: null,
          cmnd: null,
          zeroCrossingHz: null,
          effectiveSampleRate: EFFECTIVE_SAMPLE_RATE,
        },
      };
    }

    const { entry, progress } = sounding;
    const envelope = envelopeAt(progress);
    const primaryIndex = entry.primaryIndex ?? 0;
    // The pitch detector locks onto the lowest strong partial of a chord.
    const baseMidi = entry.kind === "chord" ? (entry.midi[0] ?? 60) : (entry.midi[primaryIndex] ?? 60);
    const bendCents = this.#bendCentsAt(entry, progress);

    // Vibrato + a little intonation drift, so the needle and the timeline move.
    const vibratoCents = 4.5 * Math.sin((t / 1000) * 2 * Math.PI * 5.2) * (progress > 0.25 ? 1 : 0);
    const driftCents = jitter(t, entry.kind === "chord" ? 6 : 3.5);
    const frequencyHz = midiToHz(baseMidi + (bendCents + vibratoCents + driftCents) / 100);

    const confidence = clamp01(
      (entry.kind === "chord" ? 0.74 : 0.93) * (0.55 + 0.45 * envelope) - Math.abs(jitter(t, 0.05))
    );

    return {
      timestamp: t,
      frequencyHz,
      confidence,
      nearest: nearestNote(frequencyHz),
      amplitude: {
        rms: 0.02 + envelope * 0.16,
        peak: 0.05 + envelope * 0.38,
      },
      detector: {
        tau: EFFECTIVE_SAMPLE_RATE / frequencyHz,
        cmnd: clamp01(1 - confidence) * 0.35,
        zeroCrossingHz: frequencyHz * (1 + jitter(t + 13, 0.02)),
        effectiveSampleRate: EFFECTIVE_SAMPLE_RATE,
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function now(): number {
  return performance.now();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Deterministic pseudo-noise in [-amount, +amount], driven by time. */
function jitter(seed: number, amount: number): number {
  const x = Math.sin(seed * 0.017 + 1.3) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amount;
}

/** A plucked-string amplitude envelope over normalised event progress. */
function envelopeAt(progress: number): number {
  const attack = clamp01(progress / 0.06);
  const decay = Math.exp(-2.1 * progress);
  const release = clamp01((1 - progress) / 0.18);
  return clamp01(attack * decay * release + 0.05);
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

/** Mirrors `createTuninator(options)` from the library. */
export function createMockTuninator(options: MockTuninatorOptions = {}): Tuninator {
  return new MockTuninator(options);
}

/** Exposed so the UI can label the timeline's beat grid consistently. */
export const MOCK_BPM = BPM;
