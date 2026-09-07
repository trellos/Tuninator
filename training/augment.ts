/**
 * Offline signal-path augmentation for external training audio.
 *
 * The domain gap, named: GuitarSet is an acoustic guitar heard through a mono
 * mic or a summed hexaphonic pickup; this project's corpus is electric — DI,
 * amp sim, room mic. The corpus contains three signal-path families, so the
 * training audio is passed through chains that reproduce their qualitative
 * behaviour BEFORE feature extraction (precedent: the 2024 "High Resolution
 * Guitar Transcription via Domain Adaptation" line):
 *
 *   clean  the audio as it is, at a varied gain — the DI family.
 *   amp    pre-emphasis EQ, tanh waveshaping at varied drive, a cab-like
 *          roll-off, and compression that holds the level flat while the
 *          spectrum churns — the property DETECTION-FINDINGS repeatedly
 *          measured as what makes amp-sim sustain look transient.
 *   room   convolution with a synthetic small-room impulse response (decaying
 *          noise with sparse early reflections), mixed with the dry signal
 *          and tilted dark — the room-mic family.
 *
 * Every random choice is drawn from a PRNG seeded by the take name and chain,
 * so the augmented corpus is a pure function of the inputs and a re-run
 * reproduces it bit for bit.
 */

import {
  biquad,
  compress,
  convolve,
  drive,
  hashString,
  highShelf,
  highpass,
  lowShelf,
  lowpass,
  mulberry32,
  normalisePeak,
  peakingEq,
} from "./dsp.js";

export const CHAINS = ["clean", "amp", "room"] as const;
export type Chain = (typeof CHAINS)[number];

function syntheticRoomIr(sampleRate: number, rng: () => number): Float32Array {
  const rt = 0.2 + rng() * 0.3; // decay to -60dB in 0.2..0.5s
  const length = Math.floor(rt * sampleRate);
  const ir = new Float32Array(length);
  const decay = Math.log(1000) / length; // 60dB over the tail
  // Direct path.
  ir[0] = 1;
  // A handful of sparse early reflections in the first 25ms.
  const reflections = 4 + Math.floor(rng() * 4);
  for (let r = 0; r < reflections; r++) {
    const at = Math.floor((0.003 + rng() * 0.022) * sampleRate);
    if (at < length) ir[at] = (ir[at] as number) + (rng() * 0.5 - 0.25);
  }
  // Diffuse tail.
  const tailStart = Math.floor(0.02 * sampleRate);
  const tailGain = 0.12 + rng() * 0.12;
  for (let i = tailStart; i < length; i++) {
    ir[i] = (ir[i] as number) + (rng() * 2 - 1) * tailGain * Math.exp(-decay * i);
  }
  return ir;
}

/**
 * Apply `chain` to `mono` in a fresh buffer. The output keeps the input's
 * length (a room tail past the end is dropped) and is peak-normalised to a
 * gain drawn per take, so the model sees varied absolute levels — the
 * whitening in front of the model is what is supposed to eat that, and it
 * only learns to if training makes level uninformative.
 */
export function applyChain(mono: Float32Array, sampleRate: number, take: string, chain: Chain): Float32Array {
  const rng = mulberry32(hashString(`${take}::${chain}`));
  const out = new Float32Array(mono);
  const targetPeak = 0.25 + rng() * 0.65;

  if (chain === "clean") {
    normalisePeak(out, targetPeak);
    return out;
  }

  if (chain === "amp") {
    // Tighten the low end, push the mids into the shaper, roll off like a cab.
    biquad(out, highpass(sampleRate, 60 + rng() * 40));
    biquad(out, peakingEq(sampleRate, 500 + rng() * 1200, 0.9, 2 + rng() * 6));
    normalisePeak(out, 0.5);
    drive(out, 2 + rng() * 10, 0.8);
    biquad(out, lowpass(sampleRate, 3800 + rng() * 2200));
    biquad(out, lowShelf(sampleRate, 120 + rng() * 60, -(1 + rng() * 3)));
    compress(out, sampleRate, -18 - rng() * 10, 3 + rng() * 3, 3 + rng() * 7, 60 + rng() * 120, 0);
    normalisePeak(out, targetPeak);
    return out;
  }

  // room
  const ir = syntheticRoomIr(sampleRate, rng);
  const wet = convolve(out, ir);
  const wetMix = 0.35 + rng() * 0.4;
  for (let i = 0; i < out.length; i++) {
    out[i] = (1 - wetMix) * (out[i] as number) + wetMix * (wet[i] as number);
  }
  biquad(out, highShelf(sampleRate, 3500 + rng() * 2000, -(2 + rng() * 5)));
  biquad(out, highpass(sampleRate, 50 + rng() * 30));
  normalisePeak(out, targetPeak);
  return out;
}
