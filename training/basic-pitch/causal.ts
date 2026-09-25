/**
 * Reading the model at a decision point with only the audio that has arrived.
 *
 * The model answers a whole 1988ms window at once and every frame reads audio
 * after itself (CNN look-ahead up to 116ms at the onset output, centred CQT
 * filters, a normalisation over the whole window; see `phase1.ts`). A causal
 * reading therefore has to decide what stands in for the future. Fixed here,
 * before any corpus reading: the window is placed so that the decision time T
 * is the centre of frame 156 — the last frame the package itself keeps from a
 * window (it discards 15 at each end) — and every sample after T is ZERO. Zeros
 * are what the package itself feeds past the end of a file (it zero-pads the
 * last window), and they are "no audio", not an invented continuation. A
 * reflected continuation (the CQT's own edge padding) was the alternative and
 * was not taken: it would play the last 1.5s backwards into the lowest bins.
 *
 * What a causal reading may use: frames whose centre is at or before T. Frame
 * 156 itself is centred on T and reads zeros for its second half; that loss is
 * the cost being measured, not hidden.
 *
 * The resampler (`resample.ts`) reads 32 zero crossings of its cutoff either
 * side, about 1.5ms of input; that sliver of look-ahead is below one frame and
 * is not removed.
 */

import { HOP, SAMPLE_RATE } from "./framing.js";
import { N_NOTES, WINDOW_SAMPLES, type Model } from "./runtime.js";

/** The frame the decision time sits on. */
export const DECISION_FRAME = 156;

export type CausalReading = {
  /** Decision time, ms of the original audio. */
  atMs: number;
  /** Centre of frame k, ms of the original audio (frame DECISION_FRAME is atMs). */
  frameMs(k: number): number;
  /** Rows 0..DECISION_FRAME are causal; later rows read only zeros and are not to be used. */
  note: Float32Array; // WINDOW_FRAMES x 88
  onset: Float32Array;
  contour: Float32Array; // WINDOW_FRAMES x 264
};

/** The causal window for decision time `atMs` over 22050Hz audio. */
export function causalWindow(audio: Float32Array, atMs: number): Float32Array {
  const n = Math.round((atMs / 1000) * SAMPLE_RATE); // the sample at T; samples <= n have arrived
  const start = n - DECISION_FRAME * HOP;
  const w = new Float32Array(WINDOW_SAMPLES);
  for (let i = 0; i <= DECISION_FRAME * HOP && i < WINDOW_SAMPLES; i++) {
    const j = start + i;
    if (j >= 0 && j < audio.length) w[i] = audio[j] as number;
  }
  return w;
}

export async function readCausal(model: Model, audio: Float32Array, atMsList: readonly number[]): Promise<CausalReading[]> {
  const outs = await model.run(atMsList.map((t) => causalWindow(audio, t)));
  return outs.map((o, i) => {
    const atMs = atMsList[i] as number;
    const n = Math.round((atMs / 1000) * SAMPLE_RATE);
    return {
      atMs,
      frameMs: (k: number) => (1000 * (n + (k - DECISION_FRAME) * HOP)) / SAMPLE_RATE,
      note: o.note,
      onset: o.onset,
      contour: o.contour,
    };
  });
}

export const cell = (m: Float32Array, frame: number, bin: number, width = N_NOTES): number =>
  m[frame * width + bin] as number;
