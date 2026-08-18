/**
 * tuninator — public entry point.
 *
 * Consumers import only from here. Anything reachable only by reaching into
 * `tuninator/src/**` is an API bug, not a workaround.
 */

export { createTuninator } from "./tuninator.js";

export type {
  EventPitch,
  MusicEvent,
  MusicEventKind,
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
} from "./types.js";
