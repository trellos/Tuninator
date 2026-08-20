/**
 * tuninator — public entry point.
 *
 * Consumers import only from here. Anything reachable only by reaching into
 * `tuninator/src/**` is an API bug, not a workaround.
 */

export { createRecognizer } from "./browser/recognizer.js";
export { RecognizerError, type RecognizerErrorCode } from "./errors.js";

export type {
  DetectedPitch,
  EngineTuning,
  Hypothesis,
  HypothesisKind,
  HypothesisState,
  Note,
  NoteChange,
  NoteChangeType,
  NoteLifecycle,
  NoteOriginTrigger,
  PitchClass,
  PitchFrame,
  PitchNote,
  Recognizer,
  RecognizerErrorLike,
  RecognizerEventMap,
  RecognizerEventName,
  RecognizerOptions,
  RecognizerState,
  SourceTimeMs,
  Timebase,
} from "./types.js";
