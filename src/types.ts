/**
 * tuninator — public type surface.
 *
 * This module is types-only: it must never emit runtime code, so that it can be
 * imported from the main thread, the AudioWorklet bundle, and the Node eval
 * harness without pulling anything into any of those bundles.
 */

/* -------------------------------------------------------------------------- */
/* Pitch primitives                                                            */
/* -------------------------------------------------------------------------- */

/** Sharp-spelled pitch classes. Flats are normalised to their sharp equivalent. */
export type PitchClass =
  | "C" | "C#" | "D" | "D#" | "E" | "F"
  | "F#" | "G" | "G#" | "A" | "A#" | "B";

/** A single identified pitch, snapped to the nearest equal-tempered note. */
export type PitchNote = {
  /** MIDI note number. A4 = 69. */
  midi: number;
  /** Scientific pitch notation, e.g. "A4", "F#3". */
  name: string;
  pitchClass: PitchClass;
  /** Scientific octave. A4 is octave 4; C4 is middle C. */
  octave: number;
  /** The *detected* frequency, not the ideal frequency of `midi`. */
  frequencyHz: number;
  /** Signed deviation from equal temperament, in cents. Range (-50, +50]. */
  cents: number;
};

/* -------------------------------------------------------------------------- */
/* Low-level continuous stream                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One analysis hop. Emitted continuously while listening, including during
 * silence (with `frequencyHz: null`). This is the stream to build a tuner on.
 */
export type PitchFrame = {
  /** Milliseconds. Monotonic, and comparable with `MusicEvent` timestamps. */
  timestamp: number;

  /** Detected fundamental, or null when gated or unvoiced. */
  frequencyHz: number | null;
  /** 0..1. Derived primarily from the YIN CMND value at the chosen lag. */
  confidence: number;

  /** `frequencyHz` resolved to the nearest note. Null whenever `frequencyHz` is. */
  nearest: PitchNote | null;

  amplitude: {
    rms: number;
    peak?: number;
  };

  /** Detector internals, exposed for debugging and offline evaluation. */
  detector: {
    /** Chosen lag in samples, at `effectiveSampleRate` (post-decimation). */
    tau?: number | null;
    /** Cumulative mean normalised difference at `tau`. Lower is more periodic. */
    cmnd?: number | null;
    /** Independent zero-crossing estimate, used as an octave sanity check. */
    zeroCrossingHz?: number | null;
    /** Rate the pitch detector actually ran at, after decimation. */
    effectiveSampleRate?: number | null;
  };
};

/* -------------------------------------------------------------------------- */
/* High-level musical events                                                   */
/* -------------------------------------------------------------------------- */

export type MusicEventKind = "note" | "chord" | "unknown";

export type MusicEventState =
  | "attack"
  | "sustain"
  | "bend"
  | "release"
  | "ended";

/** One pitch participating in a `MusicEvent`. */
export type EventPitch = {
  frequencyHz?: number;
  midi?: number;
  name?: string;
  pitchClass?: PitchClass;
  octave?: number;
  cents?: number;
  role: "primary" | "bass" | "chordTone" | "overtone" | "unknown";
  confidence: number;
  amplitude?: number;
  salience?: number;
};

/**
 * A musical interpretation spanning many `PitchFrame`s. A single note and a
 * chord are both `MusicEvent`s; consumers that only care about notes can
 * ignore `kind !== "note"`.
 */
export type MusicEvent = {
  /** Stable for the lifetime of the event, across start/update/end. */
  id: string;
  kind: MusicEventKind;

  /** Milliseconds, same clock as `PitchFrame.timestamp`. */
  startedAt: number;
  updatedAt: number;
  /** Null until the event has ended. */
  endedAt: number | null;

  state: MusicEventState;

  label: {
    /** "A4", "G", "Am7", or "unknown" when interpretation is not confident. */
    name: string;
    root?: PitchClass;
    /** Chord quality, e.g. "5", "maj", "min", "m7", "maj9". Absent for notes. */
    quality?: string;
  };

  primaryPitch: EventPitch | null;
  pitches: EventPitch[];

  /** 0..1 overall. A blend of `confidenceParts`. */
  confidence: number;
  confidenceParts: {
    pitch?: number;
    stability?: number;
    amplitude?: number;
    continuity?: number;
    spectralFit?: number;
    noteCoverage?: number;
  };

  ambiguity: {
    /** Estimated number of simultaneous fundamentals. */
    polyphony?: number;
    transientNoise?: number;
    /** Runner-up interpretations, most confident first. */
    alternatives?: Array<{
      label: string;
      confidence: number;
    }>;
  };

  amplitude: {
    rms: number;
    peak?: number;
  };

  /**
   * Pitch displacement from the event's reference pitch. A bent note stays one
   * event: `label.name` keeps the origin note and this records the excursion.
   */
  bend: {
    isActive: boolean;
    centsFromStart: number;
    semitonesFromStart: number;
  };
};

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/** Changes detection *policy*, never the event model. */
export type TuninatorMode = "lead" | "chords" | "rhythm" | "raw";

export type TuninatorOptions = {
  mode?: TuninatorMode;
  /** URL of the built `tuninator-worklet.js` asset. */
  workletUrl?: string | URL;
  input?: {
    deviceId?: string;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  };
  analysis?: {
    minFrequencyHz?: number;
    maxFrequencyHz?: number;
    /** Snapped to a whole number of 128-sample render quanta. */
    pitchHopMs?: number;
    rmsGate?: number;
    confidenceGate?: number;
  };
  tracking?: {
    minStableMs?: number;
    releaseGraceMs?: number;
    bendThresholdCents?: number;
  };
};

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TuninatorErrorCode =
  | "mic-unavailable"
  | "mic-permission-denied"
  | "audio-context-failed"
  | "worklet-unavailable"
  | "worklet-load-failed"
  | "unknown";

export type TuninatorError = {
  code: TuninatorErrorCode;
  message: string;
  cause?: unknown;
};

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export type TuninatorState =
  | "idle"
  | "starting"
  | "listening"
  | "waiting-for-user-gesture"
  | "error";

export type TuninatorEventName =
  | "stateChange"
  | "status"
  | "pitchFrame"
  | "musicEventStart"
  | "musicEventUpdate"
  | "musicEventEnd"
  | "error";

export type TuninatorEventHandler<E extends TuninatorEventName> =
  E extends "stateChange" ? (state: TuninatorState) => void :
  E extends "status" ? (message: string) => void :
  E extends "pitchFrame" ? (frame: PitchFrame) => void :
  E extends "musicEventStart" ? (event: MusicEvent) => void :
  E extends "musicEventUpdate" ? (event: MusicEvent) => void :
  E extends "musicEventEnd" ? (event: MusicEvent) => void :
  E extends "error" ? (error: TuninatorError) => void :
  never;

/* -------------------------------------------------------------------------- */
/* Main interface                                                              */
/* -------------------------------------------------------------------------- */

export type Tuninator = {
  start(): Promise<void>;
  stop(): void;
  /** Safe to call while listening; never restarts the audio graph. */
  setMode(mode: TuninatorMode): void;
  getMode(): TuninatorMode;
  getState(): TuninatorState;
  /** Every event not yet in the `ended` state. */
  getActiveEvents(): MusicEvent[];

  /** Subscribe. Returns an unsubscribe function. */
  on<E extends TuninatorEventName>(
    eventName: E,
    handler: TuninatorEventHandler<E>
  ): () => void;
};
