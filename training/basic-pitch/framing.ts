/**
 * The model's own framing, from `basic_pitch/inference.py` at the pinned
 * revision, and the exact time of every output frame.
 *
 *   overlap      30 frames x 256 = 7680 samples; hop = 43844 - 7680 = 36164
 *   padding      7680 / 2 = 3840 zeros before the audio; the last window is
 *                zero-padded to 43844
 *   unwrap       each window's 172 frames lose 15 at each end; the rest are
 *                concatenated, then cut to int(length / hop * 142) frames
 *
 * Frame k of a window is the CQT column centred on window sample k * 256 (the
 * CQT pads 128 samples each side at its top octave and strides 256; each
 * lower octave adds half a sample of decimation delay, 5.8ms at the lowest).
 * So the exact centre of kept frame k of window w, in the original audio, is
 * (w * 36164 + k * 256 - 3840) / 22050 s. The Python package instead maps
 * frames to times with `model_frames_to_time` and a 1.8ms "magic" offset; this
 * file keeps the exact centres, because the evaluation compares them with
 * label times to the millisecond.
 */

import { WINDOW_FRAMES, WINDOW_SAMPLES, type Model } from "./runtime.js";

export const SAMPLE_RATE = 22050;
export const HOP = 256;
export const OVERLAP_FRAMES = 30;
export const OVERLAP_SAMPLES = OVERLAP_FRAMES * HOP;
export const WINDOW_HOP = WINDOW_SAMPLES - OVERLAP_SAMPLES;
export const TRIM = OVERLAP_FRAMES / 2;
export const KEPT = WINDOW_FRAMES - OVERLAP_FRAMES;

export type Posteriorgram = {
  frames: number;
  /** Centre of each frame, ms of the original audio. */
  timesMs: Float64Array;
  note: Float32Array; // frames x 88
  onset: Float32Array; // frames x 88
  contour: Float32Array; // frames x 264
};

/** The windows `get_audio_input` would feed the model for this audio. */
export function windowsOf(audio: Float32Array): Float32Array[] {
  const padded = new Float32Array(OVERLAP_SAMPLES / 2 + audio.length);
  padded.set(audio, OVERLAP_SAMPLES / 2);
  const out: Float32Array[] = [];
  for (let i = 0; i < padded.length; i += WINDOW_HOP) {
    const w = new Float32Array(WINDOW_SAMPLES);
    w.set(padded.subarray(i, Math.min(padded.length, i + WINDOW_SAMPLES)));
    out.push(w);
  }
  return out;
}

/**
 * The whole-take reading exactly as the package produces it: every frame read
 * with up to 15 frames (174ms) of audio after it inside its window, and
 * everything the window holds after that.
 */
export async function posteriorgram(model: Model, audio: Float32Array): Promise<Posteriorgram> {
  const windows = windowsOf(audio);
  const outs = await model.run(windows);
  const expected = Math.floor((audio.length / WINDOW_HOP) * KEPT);
  const frames = Math.min(expected, outs.length * KEPT);
  const note = new Float32Array(frames * 88);
  const onset = new Float32Array(frames * 88);
  const contour = new Float32Array(frames * 264);
  const timesMs = new Float64Array(frames);
  let f = 0;
  for (let w = 0; w < outs.length && f < frames; w++) {
    const o = outs[w] as (typeof outs)[number];
    for (let k = TRIM; k < WINDOW_FRAMES - TRIM && f < frames; k++, f++) {
      note.set(o.note.subarray(k * 88, (k + 1) * 88), f * 88);
      onset.set(o.onset.subarray(k * 88, (k + 1) * 88), f * 88);
      contour.set(o.contour.subarray(k * 264, (k + 1) * 264), f * 264);
      timesMs[f] = (1000 * (w * WINDOW_HOP + k * HOP - OVERLAP_SAMPLES / 2)) / SAMPLE_RATE;
    }
  }
  return { frames, timesMs, note, onset, contour };
}
