/**
 * tuninator/web — the browser worker.
 *
 * Opens the microphone, creates the `AudioContext`, loads the worklet asset,
 * and streams `pitchFrame` / `musicEvent*` events. The analysis itself is the
 * `Tuninator` exported from the package root, running inside the worklet.
 *
 * Audio must reach the worklet as mono. If your interface presents two physical
 * inputs as one stereo device, split it and connect the channel the instrument
 * is on — the library will not guess for you.
 */

export { createWorkerWebAudio, createTuninator } from "./workers/web-audio.js";

export type { TuninatorWorker } from "./types.js";
export type { WorkletCommand, WorkletMessage } from "./workers/web-audio-processor.js";
