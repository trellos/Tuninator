/**
 * Minimal WAV reader/writer for Node. No dependencies.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the harness
 * workstream. Only needs to handle what `scripts/decode-fixtures.ts` produces:
 * 16-bit PCM, mono, 48kHz.
 */

export type WavData = {
  sampleRate: number;
  channels: number;
  /** Interleaved if `channels > 1`; downmix before analysis. */
  samples: Float32Array;
};

export function readWav(_bytes: Uint8Array): WavData {
  throw new Error("readWav: not implemented");
}

export function writeWav(_samples: Float32Array, _sampleRate: number): Uint8Array {
  throw new Error("writeWav: not implemented");
}
