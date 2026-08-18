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
   * RMS of each channel that reached the worklet, measured before they are
   * folded to mono.
   *
   * Analysis input is contractually mono, so this is normally a single value —
   * it earns its place when the contract is broken. `channelRms.length` is the
   * channel count actually delivered, so a host that meant to hand over one
   * channel and finds two here has found its bug; and when a host does connect
   * a stereo device, this is what distinguishes "no signal" from "signal on a
   * channel nobody looked at".
   *
   * Absent outside the worklet (the offline worker feeds mono buffers), so
   * always treat it as optional.
   */
  channelRms?: number[];

  /** Detector internals, exposed for debugging and offline evaluation. */
  detector: {
    /** Chosen lag in samples, at `effectiveSampleRate`. May be fractional. */
    tau?: number | null;
    /** Cumulative mean normalised difference at `tau`. Lower is more periodic. */
    cmnd?: number | null;
    /** Independent zero-crossing estimate, used as an octave sanity check. */
    zeroCrossingHz?: number | null;
    /**
     * Rate the pitch detector ran at. Currently always the input rate — there
     * is no decimation stage — but `tau` is expressed in terms of it, so it is
     * reported rather than assumed.
     */
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
  /**
   * What this pitch is within the event. Only two exist because only two are
   * measurable: the detected fundamental, and the lowest partial the chroma
   * found. Distinguishing a played chord tone from an overtone would need
   * per-partial attribution the analyser does not attempt.
   */
  role: "primary" | "bass";
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
    spectralFit?: number;
  };

  ambiguity: {
    /** Estimated number of simultaneous fundamentals. */
    polyphony?: number;
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
  /**
   * How the browser worker gets its audio. Ignored by the library itself, which
   * is handed samples directly.
   */
  input?: {
    /**
     * Audio the host has already wired up. When present the worker opens no
     * microphone at all, and closes nothing it did not create.
     *
     * This is how a host chooses its own input channel. A 2-in interface
     * presents to the browser as one *stereo* device, so an instrument in input
     * 2 exists only on channel 1 — and which input it is plugged into is
     * something only the host can know. Split with a `ChannelSplitterNode`,
     * connect the channel you want, and pass that node here.
     *
     * An `AudioNode` brings its own `AudioContext`, which the worker will use
     * rather than creating a second one — nodes cannot cross contexts. A
     * `MediaStream` gets a context created for it.
     *
     * Whatever arrives should be mono. Anything wider is summed, and
     * `PitchFrame.channelRms` reports each channel unmixed so that is visible.
     */
    source?: MediaStream | AudioNode;

    /* The rest apply only when the worker opens the microphone itself. */
    deviceId?: string;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
    /**
     * Channels to ask `getUserMedia` for. Defaults to 1.
     *
     * Requested as an *ideal* constraint, never `exact`, so a device that
     * cannot honour it still opens. Ask for 2 if you intend to split the
     * result yourself — Chrome opens a capture device in mono unless a channel
     * count is explicitly requested, and a channel that never reaches the page
     * cannot be recovered later.
     */
    channelCount?: number;
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
/* Worker interface                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What a *worker* offers: a live, host-specific wrapper around the `Tuninator`
 * library.
 *
 * The library itself is synchronous and platform-free — audio in, results out
 * (see `src/tuninator.ts`). A worker is the part that knows how to get audio
 * out of one particular host and push it in: `WorkerWebAudio` opens an
 * `AudioContext` and an `AudioWorklet`, and hands results back as events on a
 * clock it manages itself. Anything with a lifecycle, a subscription, or a
 * permission prompt belongs here, not in the library.
 */
export type TuninatorWorker = {
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
