/**
 * Minimal WAV reader/writer for Node. No dependencies.
 *
 * CONTRACT FILE — signatures fixed; implementation owned by the harness
 * workstream. Only needs to handle what `scripts/decode-fixtures.ts` produces:
 * 16-bit PCM, mono, 48kHz.
 *
 * The chunk walk is real rather than a fixed 44-byte header assumption: ffmpeg
 * writes a `LIST`/`INFO` chunk between `fmt ` and `data`, so anything that
 * hardcodes byte 44 reads metadata as audio.
 */

export type WavData = {
  sampleRate: number;
  channels: number;
  /** Interleaved if `channels > 1`; downmix before analysis. */
  samples: Float32Array;
};

const FORMAT_PCM = 1;
const FORMAT_IEEE_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

export function readWav(bytes: Uint8Array): WavData {
  if (bytes.byteLength < 12) {
    throw new Error(`readWav: file too short (${bytes.byteLength} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (fourCC(view, 0) !== "RIFF") throw new Error("readWav: not a RIFF file");
  if (fourCC(view, 8) !== "WAVE") throw new Error("readWav: not a WAVE file");

  let formatTag = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  // Walk the chunk list. Chunks are word-aligned: an odd size is followed by a
  // pad byte that is not counted in the size field.
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt ") {
      if (body + 16 > bytes.byteLength) throw new Error("readWav: truncated fmt chunk");
      formatTag = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);

      // WAVE_FORMAT_EXTENSIBLE hides the real format in the SubFormat GUID.
      if (formatTag === FORMAT_EXTENSIBLE && size >= 40 && body + 26 <= bytes.byteLength) {
        formatTag = view.getUint16(body + 24, true);
      }
    } else if (id === "data") {
      dataOffset = body;
      // Some writers leave a placeholder size; never read past the buffer.
      dataLength = Math.min(size, bytes.byteLength - body);
    }

    offset = body + size + (size % 2);
  }

  if (dataOffset < 0) throw new Error("readWav: no data chunk");
  if (channels < 1) throw new Error("readWav: no fmt chunk (or zero channels)");

  const samples = decodeSamples(view, dataOffset, dataLength, formatTag, bitsPerSample);
  return { sampleRate, channels, samples };
}

function decodeSamples(
  view: DataView,
  offset: number,
  length: number,
  formatTag: number,
  bitsPerSample: number
): Float32Array {
  if (formatTag === FORMAT_PCM && bitsPerSample === 16) {
    const count = Math.floor(length / 2);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = view.getInt16(offset + i * 2, true) / 32768;
    }
    return out;
  }

  if (formatTag === FORMAT_PCM && bitsPerSample === 8) {
    // 8-bit PCM in WAV is unsigned, biased by 128.
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = (view.getUint8(offset + i) - 128) / 128;
    }
    return out;
  }

  if (formatTag === FORMAT_PCM && bitsPerSample === 24) {
    const count = Math.floor(length / 3);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const p = offset + i * 3;
      const raw = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
      // Sign-extend from 24 bits.
      const signed = raw & 0x800000 ? raw - 0x1000000 : raw;
      out[i] = signed / 8388608;
    }
    return out;
  }

  if (formatTag === FORMAT_PCM && bitsPerSample === 32) {
    const count = Math.floor(length / 4);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = view.getInt32(offset + i * 4, true) / 2147483648;
    }
    return out;
  }

  if (formatTag === FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
    const count = Math.floor(length / 4);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getFloat32(offset + i * 4, true);
    return out;
  }

  if (formatTag === FORMAT_IEEE_FLOAT && bitsPerSample === 64) {
    const count = Math.floor(length / 8);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getFloat64(offset + i * 8, true);
    return out;
  }

  throw new Error(
    `readWav: unsupported format (tag ${formatTag}, ${bitsPerSample}-bit). ` +
      "The decode step must produce 16-bit PCM."
  );
}

/** Mono 16-bit PCM. Values outside [-1, 1] are clipped, not wrapped. */
export function writeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const channels = 1;
  const bytesPerSample = 2;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, "WAVE");

  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);

  writeAscii(36, "data");
  view.setUint32(40, dataLength, true);

  // Scale by 32768 — the exact inverse of the reader — then clamp into int16.
  // Scaling by 32767 on the way out would make the round trip lossy by a whole
  // extra LSB, which would show up as noise in anything this writes back.
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] as number));
    const scaled = Math.max(-32768, Math.min(32767, Math.round(clamped * 32768)));
    view.setInt16(44 + i * 2, scaled, true);
  }

  return new Uint8Array(buffer);
}

/** Interleaved -> mono. A no-op copy when `channels === 1`. */
export function downmixToMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[f * channels + c] as number;
    out[f] = sum / channels;
  }
  return out;
}
