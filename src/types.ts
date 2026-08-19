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

  /**
   * RMS of each *input* channel over this hop, measured before the channels are
   * summed into the single signal that `amplitude` and the detector describe.
   *
   * `channelRms.length` is the number of channels the browser actually handed
   * the worklet, so this doubles as the input channel count. It exists because
   * the alternative diagnosis is invisible: a 2-in interface presents as one
   * stereo device ("Analogue 1/2"), and an instrument in input 2 lands entirely
   * on channel 1 — a UI that only sees the mixed level cannot tell "no signal"
   * from "signal on a channel nobody read".
   *
   * Absent outside the worklet (the offline harness feeds mono buffers), so
   * always treat it as optional.
   */
  channelRms?: number[];

  /**
   * Which input channel this frame was actually analysed from.
   *
   * - a number — only that channel reached the detector,
   * - `null` — every channel was summed together,
   * - absent — no channel information at all (the offline harness).
   *
   * `channelRms` alone cannot answer this once selection exists, and its argmax
   * is *not* the answer: selection is hysteretic on purpose, so the loudest
   * channel in any one frame is routinely not the selected one. A UI that wants
   * to show "listening to input 2" has to be told, not left to infer.
   */
  selectedChannel?: number | null;

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
    /**
     * Channels to ask `getUserMedia` for. Defaults to 2.
     *
     * Requested as an *ideal* constraint, never `exact`: a genuinely mono
     * built-in microphone still opens, it just reports 1. Chrome opens a
     * capture device in mono unless a channel count is explicitly asked for,
     * which silently loses whatever is on input 2 of a 2-in interface.
     */
    channelCount?: number;
    /**
     * What to do with the channels once they arrive. Defaults to `"auto"`.
     *
     * - `"auto"` — analyse the loudest channel, decided over a window and with
     *   hysteresis so a stereo pair cannot flip back and forth. Until real
     *   signal has been heard the channels are summed, because summing can be
     *   wrong but cannot miss an instrument.
     * - `"sum"` — always sum every channel. Guaranteed to hear whatever is
     *   plugged in anywhere, at the cost of comb filtering when two channels
     *   carry the same source (a mic and a DI of one guitar).
     * - a number — always analyse that channel index, for a host that already
     *   knows where the instrument is. Out of range falls back to summing.
     *
     * Ignored for mono input, where there is nothing to decide.
     */
    channels?: "auto" | "sum" | number;
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

/* -------------------------------------------------------------------------- */
/* Source time (new surface — see src/engine/clock.ts)                         */
/* -------------------------------------------------------------------------- */

/**
 * Milliseconds of *source audio* since the first processed sample (epoch = 0).
 *
 * Derived only from sample count / sample rate, never from a wall clock, so an
 * offline run over a WAV and a live run over the same audio agree exactly. Both
 * lanes, pitch frames, Notes and the hypothesis trail all share this one scale.
 */
export type SourceTimeMs = number;

/** How `SourceTimeMs` relates to the host's own clock, when there is one. */
export type Timebase = {
  sampleRate: number;
  /** `AudioContext.currentTime` at source time 0. Absent offline. */
  originContextTime?: number;
};
