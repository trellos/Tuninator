/**
 * tuninator — public entry point.
 *
 * This is the general-purpose library: audio in, musical interpretation out,
 * with no clock, no I/O and no platform. Push mono `Float32Array`s into
 * `Tuninator.analyze()` from wherever your audio comes from.
 *
 * Running in a browser? You almost certainly want the web worker instead, which
 * handles the microphone, the `AudioContext` and the `AudioWorklet` for you:
 *
 *   import { createWorkerWebAudio } from "tuninator/web";
 *
 * Anything reachable only by reaching into `tuninator/src/**` is an API bug,
 * not a workaround.
 */

export { Tuninator } from "./tuninator.js";
export type {
  AnalysisResult,
  TrackerEmission,
  TuninatorConfig,
} from "./tuninator.js";

// `Policy` is reachable through the public surface -- `TuninatorConfig.policy`
// takes one and `getPolicy()` returns one -- so it has to be nameable.
export type { Policy } from "./core/policy.js";

export type {
  EventPitch,
  MusicEvent,
  MusicEventKind,
  MusicEventState,
  PitchClass,
  PitchFrame,
  PitchNote,
  TuninatorError,
  TuninatorErrorCode,
  TuninatorEventHandler,
  TuninatorEventName,
  TuninatorMode,
  TuninatorOptions,
  TuninatorState,
  TuninatorWorker,
} from "./types.js";
