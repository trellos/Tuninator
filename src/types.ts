/**
 * tuninator — public type surface.
 *
 * This module is types-only: it must never emit runtime code, so that it can be
 * imported from the main thread, the AudioWorklet bundle, the engine worker and
 * the Node eval harness without pulling anything into any of those bundles.
 * The one runtime value the package exports lives in `src/errors.ts`.
 *
 * The model here is a *streaming musical event recognizer*, not a pitch
 * detector with extras. Its central claim: a `Note` is something the system
 * learns about over time. A Note starts as soon as there is evidence something
 * was played, and then improves — its pitch gets refined, a bend is recognised
 * as a bend rather than as three notes, a chord blooms out of what looked like
 * a single pitch. Every one of those steps is delivered as a `NoteChange` with
 * a type, so a consumer can tell "I know more now" apart from "I was wrong".
 */

/* -------------------------------------------------------------------------- */
/* Time                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Milliseconds of *source audio* since the first processed sample (epoch = 0).
 *
 * Derived only from sample count / sample rate, never from a wall clock, so an
 * offline run over a WAV and a live run over the same audio agree exactly. Both
 * lanes, pitch frames, Notes and the hypothesis trail share this one scale.
 *
 * Note this is NOT `AudioContext.currentTime`: it starts at zero when the
 * recognizer starts, and `Timebase.originContextTime` is what relates the two.
 */
export type SourceTimeMs = number;

/** How `SourceTimeMs` relates to the host's own clock, when there is one. */
export type Timebase = {
  sampleRate: number;
  /** `AudioContext.currentTime` at source time 0. Absent offline. */
  originContextTime?: number;
};

/* -------------------------------------------------------------------------- */
/* Pitch primitives                                                            */
/* -------------------------------------------------------------------------- */

/** Sharp-spelled pitch classes. Flats are normalised to their sharp equivalent. */
export type PitchClass =
  | "C" | "C#" | "D" | "D#" | "E" | "F"
  | "F#" | "G" | "G#" | "A" | "A#" | "B";

/** A frequency snapped to the nearest equal-tempered note. */
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

/**
 * One pitch the recognizer believes is sounding.
 *
 * `midi`/`name`/`pitchClass`/`octave` are all required: a detected pitch that
 * cannot say which octave it is in is not a detection, and making the register
 * optional is how a chord's voicing quietly degrades into a set of pitch
 * classes. If the register is genuinely unknown there is no `DetectedPitch`.
 */
export type DetectedPitch = {
  midi: number;
  name: string;
  pitchClass: PitchClass;
  octave: number;
  /** The measured frequency, when one was measured rather than inferred. */
  frequencyHz?: number;
  /** Signed deviation from equal temperament, in cents. */
  centsOffset?: number;
  role: "first" | "bass" | "root" | "chordTone" | "unknown";
  confidence: number;
  /** How much of the analysed spectrum this pitch accounts for. */
  salience?: number;
};

/* -------------------------------------------------------------------------- */
/* Hypotheses                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the recognizer is currently entertaining about a Note.
 *
 * These are first-class and stateful rather than a flat "alternatives" list,
 * because the interesting information is the *trajectory*: a reading that has
 * been climbing for 300ms and one that appeared this hop are not equally
 * believable, and a hypothesis that was leading and then lost is the single
 * most useful thing to show a player who disagrees with the answer.
 */
export type HypothesisState =
  /** Seen, not yet worth acting on. */
  | "candidate"
  /** Enough support to be worth tracking against the leader. */
  | "contender"
  /** Currently the best explanation, but not settled. */
  | "leading"
  /** Settled: further evidence would have to actively contradict it. */
  | "confirmed"
  /** Folded into a larger explanation — "E3" inside "C:maj". */
  | "incorporated"
  /** Replaced by a better explanation of the same evidence. */
  | "superseded"
  /** Actively contradicted by later evidence. */
  | "discredited";

export type HypothesisKind = "pitch" | "harmony" | "bend" | "structure";

export type Hypothesis = {
  id: string;
  kind: HypothesisKind;
  /** "G4", "C:maj7", "C/G", "bend", "split". */
  label: string;
  state: HypothesisState;
  confidence: number;
  /** The highest confidence this hypothesis ever reached. */
  peakConfidence: number;
  firstSeenAt: SourceTimeMs;
  lastUpdatedAt: SourceTimeMs;
  /** Id of the hypothesis that superseded or incorporated this one. */
  resolvedInto?: string;
};

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

export type NoteLifecycle =
  /** Something was played; the recognizer is still working out what. */
  | "started"
  /** Evidence is still arriving and still changing the answer. */
  | "enriching"
  /** The answer has settled. It can still be revised, but not cheaply. */
  | "resolved"
  /** The sound is over. */
  | "ended";

export type NoteChangeType =
  | "confidenceUpdate"
  /** Same answer, sharper — "G4" with a better frequency estimate. */
  | "pitchRefinement"
  /** Different answer. The previous one was wrong. */
  | "pitchCorrection"
  /** The pitch is moving, and that motion is part of this Note. */
  | "pitchMovement"
  | "bendUpdate"
  | "pitchAdded"
  | "pitchRemoved"
  /** More is known about the harmony — C became Cmaj7. */
  | "harmonyEnrichment"
  /** The harmony was wrong. */
  | "harmonyCorrection"
  | "hypothesisPromoted"
  | "hypothesisDiscredited"
  | "hypothesisIncorporated"
  /** The Note's extent changed: it split, absorbed another, or was backdated. */
  | "structuralRevision"
  | "resolved";

export type NoteChange = {
  type: NoteChangeType;
  /**
   * When the *evidence* is from — which may precede delivery, because the deep
   * lane analyses audio the fast lane already reported on.
   */
  at: SourceTimeMs;
  revisionNumber: number;
  /** What the Note used to say. Present on corrections. */
  previous?: { label: string; hypothesisId?: string };
  /** Other Notes involved. Present on splits and merges. */
  relatedNoteIds?: string[];
  /**
   * What `relatedNoteIds` are to this Note.
   *
   * `"absorbed"` — they were part of this event after all, and this Note now
   * stands for all of them; anything summarising the final state must count
   * this Note once and them not at all. `"split"` — this Note turned out to be
   * several events, and they are the rest of them; every one of them is a
   * separate event that really happened.
   *
   * The two are opposite claims about the same field, and a consumer that
   * cannot tell them apart either double-counts a strum or throws away notes
   * somebody played. Absent means `"absorbed"`, which is what the field meant
   * before splits existed.
   */
  relation?: "absorbed" | "split";
};

export type NoteOriginTrigger = "attack" | "pitchChange" | "rearticulation";

/**
 * The recognizer's evolving belief about one thing the player did.
 *
 * Handlers always receive an immutable snapshot; `revision.revisionNumber` makes
 * a held snapshot's staleness checkable without deep-comparing anything.
 */
export type Note = {
  id: string;
  startTime: SourceTimeMs;
  /** Null while the Note is still sounding. */
  endTime: SourceTimeMs | null;
  lifecycle: NoteLifecycle;

  /**
   * What was true at the start, frozen. Everything else on a Note may be
   * revised; this is the record of what triggered it and what it first looked
   * like, which is what makes a later correction inspectable.
   */
  origin: {
    firstDetectedPitch: DetectedPitch | null;
    initialConfidence: number;
    trigger: NoteOriginTrigger;
  };

  /** Continuous before categorical: the frequency is the measurement. */
  pitch: {
    currentFrequencyHz?: number;
    current?: DetectedPitch;
    confidence: number;
    /** `[time, frequencyHz, confidence]`, bounded. Opt-in via diagnostics. */
    contour?: ReadonlyArray<readonly [SourceTimeMs, number, number]>;
  };

  /** Present once a bend hypothesis reaches `leading`. */
  bend?: {
    active: boolean;
    direction: "up" | "down";
    amountCents: number;
    peakAmountCents: number;
    releaseDetected: boolean;
    confidence: number;
  };

  /**
   * Present once the recognizer believes more than one pitch is sounding.
   * A missing `quality` with a present `harmony` is honest abstention: the
   * recognizer knows it is a chord and will not guess which one.
   */
  harmony?: {
    root?: PitchClass;
    bass?: DetectedPitch;
    quality?: string;
    /** "C", "C/G", "Cmaj9", "C5". Absent when abstaining. */
    chordName?: string;
    intervals?: string[];
    /** Register-preserving: a voicing, not a set of pitch classes. */
    detectedPitches?: DetectedPitch[];
    uniquePitchClassCount?: number;
    estimatedVoiceCount?: { value: number; confidence: number };
    confidence?: number;
  };

  hypotheses: {
    active: Hypothesis[];
    /** Curated history: what was considered, and what became of it. */
    trail: Hypothesis[];
  };

  revision: {
    lastChangeType: NoteChangeType | null;
    revisionNumber: number;
  };

  /** Overall blend. Per-facet confidences live on the facets. */
  confidence: number;
  amplitude: { rms: number; peak?: number };
};

/* -------------------------------------------------------------------------- */
/* Diagnostic pitch stream                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One fast-lane hop, exposed for tuners, meters and debugging.
 *
 * Notes are the primary API; this is the raw stream underneath them and is
 * opt-in (`diagnostics.pitchFrames`) because it fires ~80 times a second.
 */
export type PitchFrame = {
  timestamp: SourceTimeMs;
  /** Detected fundamental, or null when gated or unvoiced. */
  frequencyHz: number | null;
  /** 0..1, derived primarily from the YIN CMND value at the chosen lag. */
  confidence: number;
  /** `frequencyHz` resolved to the nearest note. Null whenever `frequencyHz` is. */
  nearest: PitchNote | null;
  amplitude: { rms: number; peak?: number };

  /**
   * RMS of each *input* channel over this hop, before selection/downmix.
   *
   * A 2-in interface presents as one stereo device, and an instrument in input
   * 2 lands entirely on channel 1 — a UI that only sees the mixed level cannot
   * tell "no signal" from "signal on a channel nobody read". Absent offline.
   */
  channelRms?: number[];
  /**
   * Which input channel this frame was analysed from: a number for a single
   * selected channel, `null` when every channel was summed, absent offline.
   * Selection is hysteretic, so the argmax of `channelRms` is not the answer.
   */
  selectedChannel?: number | null;

  /** Detector internals, for debugging and offline evaluation. */
  detector: {
    /** Chosen lag in samples. */
    tau?: number | null;
    /** Cumulative mean normalised difference at `tau`. Lower is more periodic. */
    cmnd?: number | null;
    /** Independent zero-crossing estimate, used as an octave sanity check. */
    zeroCrossingHz?: number | null;
  };
};

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Detector tuning.
 *
 * There are no modes. The old `lead`/`chords`/`rhythm`/`raw` split forced the
 * caller to declare in advance what the player was about to do, and got the
 * wrong answer whenever they were wrong — a chord played in lead mode was a
 * note. One recognizer now runs the whole time, and a Note blooms into a chord
 * when the evidence supports it. What is left is genuine tuning: gates, ranges
 * and how patient the recognizer should be.
 */
export type EngineTuning = {
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  /** Fast-lane hop. Snapped to a whole number of 128-sample render quanta. */
  hopMs?: number;
  /** Amplitude below which the input is treated as silence. */
  rmsGate?: number;
  /** Pitch confidence below which a frame is treated as unvoiced. */
  confidenceGate?: number;
  /** How long a Note must sound before it is announced. */
  minStableMs?: number;
  /** How long silence must persist before a Note is ended. */
  releaseGraceMs?: number;
  /** Displacement from the origin pitch that counts as a bend. */
  bendThresholdCents?: number;
  /** Simulated deep-lane latency, in source time. Offline determinism knob. */
  deepLatencyMs?: number;
};

export type RecognizerOptions = {
  /**
   * A caller-owned `AudioContext`. The recognizer never closes a context it did
   * not create, so sharing one with the rest of an app is safe.
   */
  audioContext?: AudioContext;
  /** URL of the built `tuninator-worklet.js` asset. */
  workletUrl?: string | URL;
  /** URL of the built `tuninator-engine-worker.js` asset, for `host: "worker"`. */
  engineUrl?: string | URL;
  /**
   * Where the recognition engine runs. `"inline"` (default) is the main thread;
   * `"worker"` moves it to a Web Worker. This never affects the Note model or
   * any timestamp — only which thread the work happens on.
   */
  host?: "inline" | "worker";
  input?: {
    deviceId?: string;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
    /**
     * Channels to ask `getUserMedia` for. Defaults to 2, requested as an
     * *ideal* constraint: a genuinely mono microphone still opens, it just
     * reports 1. Chrome opens a capture device in mono unless a channel count
     * is asked for, silently losing input 2 of a 2-in interface.
     */
    channelCount?: number;
    /**
     * What to do with the channels once they arrive. Defaults to `"auto"`.
     *
     * - `"auto"` — analyse the loudest channel, decided over a window and with
     *   hysteresis so a stereo pair cannot flip back and forth. Until real
     *   signal has been heard the channels are summed, because summing can be
     *   wrong but cannot miss an instrument.
     * - `"sum"` — always sum every channel.
     * - a number — always analyse that channel index.
     */
    channels?: "auto" | "sum" | number;
  };
  engine?: EngineTuning;
  diagnostics?: {
    /** Emit the continuous `pitchFrame` stream. Off by default. */
    pitchFrames?: boolean;
    /** Record `Note.pitch.contour`. Off by default. */
    contour?: boolean;
  };
};

/* -------------------------------------------------------------------------- */
/* Events and lifecycle                                                        */
/* -------------------------------------------------------------------------- */

export type RecognizerState =
  | "idle"
  | "starting"
  | "listening"
  | "stopping"
  | "error";

/** Import `RecognizerError` itself from the package root; it is a real Error. */
export type RecognizerErrorLike = Error & {
  readonly code: string;
  readonly cause?: unknown;
};

export type RecognizerEventMap = {
  noteStarted: (note: Note) => void;
  noteChanged: (note: Note, change: NoteChange) => void;
  /** The answer has settled. Fires at most once per Note, before `noteEnded`. */
  noteResolved: (note: Note) => void;
  noteEnded: (note: Note) => void;
  /** Diagnostic; only emitted when `diagnostics.pitchFrames` is set. */
  pitchFrame: (frame: PitchFrame) => void;
  stateChange: (state: RecognizerState) => void;
  status: (message: string) => void;
  error: (error: RecognizerErrorLike) => void;
};

export type RecognizerEventName = keyof RecognizerEventMap;

/* -------------------------------------------------------------------------- */
/* Main interface                                                              */
/* -------------------------------------------------------------------------- */

export interface Recognizer {
  /** Rejects with a `RecognizerError`. */
  start(): Promise<void>;
  /**
   * Stops listening and flushes both lanes, so every Note still open gets its
   * `noteEnded` before this resolves. The old synchronous `stop()` dropped
   * whatever was in flight.
   */
  stop(): Promise<void>;
  /** `stop()` plus releasing the microphone, worklet and any context we made. */
  dispose(): Promise<void>;

  getState(): RecognizerState;
  /** Every Note not yet ended. Genuinely plural: Notes can overlap. */
  getActiveNotes(): Note[];
  /** An active Note, or one that ended recently enough to still be held. */
  getNote(id: string): Note | undefined;
  /** Null until `start()` has resolved. */
  getTimebase(): Timebase | null;

  /** Subscribe. Returns an unsubscribe function; there is no `off()`. */
  on<E extends RecognizerEventName>(
    eventName: E,
    handler: RecognizerEventMap[E]
  ): () => void;
}
