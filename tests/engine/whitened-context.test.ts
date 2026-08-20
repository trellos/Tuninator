/**
 * The learned witness's input must be the same offline and live, or the model
 * is trained on data the engine never produces. This pins it: the whitened
 * patch and flux readings the fast lane attaches to an attack must equal, to
 * float32 exactness, what a standalone pass over the same audio computes on
 * the engine's hop grid — the standalone pass being exactly what
 * `training/features.ts` feeds the trainer (windows of `fluxFftSize` ending
 * at hop multiples, zero-padded before the first sample, pushed through
 * `WhitenedBandPipeline` from the first hop).
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG, RENDER_QUANTUM, snapHop } from "../../src/engine/config.js";
import { RecognitionEngine } from "../../src/engine/engine.js";
import type { FastFrame } from "../../src/engine/contracts.js";
import {
  BAND_COUNT,
  PATCH_HOPS,
  WhitenedBandPipeline,
} from "../../src/engine/kernels/whitened-bands.js";

const SAMPLE_RATE = 48000;

function sawtooth(hz: number, samples: number, amplitude: number): Float32Array {
  const out = new Float32Array(samples);
  const period = SAMPLE_RATE / hz;
  for (let i = 0; i < samples; i++) out[i] = amplitude * (2 * ((i % period) / period) - 1);
  return out;
}

/** A decaying pluck-ish burst written into `signal` starting at `at`. */
function pluck(signal: Float32Array, at: number, hz: number, seconds: number, amplitude: number): void {
  const wave = sawtooth(hz, Math.floor(seconds * SAMPLE_RATE), amplitude);
  for (let i = 0; i < wave.length && at + i < signal.length; i++) {
    const env = Math.exp(-3 * (i / wave.length));
    signal[at + i] = (signal[at + i] as number) + (wave[i] as number) * env;
  }
}

describe("the whitened attack context", () => {
  it("matches the training pipeline's standalone pass bit for bit", () => {
    const signal = new Float32Array(Math.floor(1.4 * SAMPLE_RATE));
    pluck(signal, Math.floor(0.3 * SAMPLE_RATE), 146.83, 0.9, 0.5);
    pluck(signal, Math.floor(0.8 * SAMPLE_RATE), 146.83, 0.5, 0.45);

    // Live: the engine, in render quanta, collecting every attack's context.
    // Pitch-frame diagnostics on, because `processChunk().fast` rides them.
    const engine = new RecognitionEngine(SAMPLE_RATE, {
      ...DEFAULT_ENGINE_CONFIG,
      diagnostics: { pitchFrames: true, contour: false },
    });
    const attacks: FastFrame[] = [];
    for (let offset = 0; offset < signal.length; offset += RENDER_QUANTUM) {
      const block = new Float32Array(RENDER_QUANTUM);
      block.set(signal.subarray(offset, Math.min(offset + RENDER_QUANTUM, signal.length)));
      for (const fast of engine.processChunk(block, offset).fast) {
        if (fast.attack !== null) attacks.push(fast);
      }
    }
    expect(attacks.length, "the synthetic re-pick must produce attacks").toBeGreaterThan(0);
    for (const frame of attacks) {
      expect(frame.attack?.whitened, `attack at ${frame.at}ms carries its context`).toBeDefined();
    }

    // Offline: the standalone pass on the same grid.
    const fftSize = DEFAULT_ENGINE_CONFIG.transient.fluxFftSize;
    const hop = snapHop(DEFAULT_ENGINE_CONFIG.analysis.hopMs, SAMPLE_RATE);
    const hopMs = (hop / SAMPLE_RATE) * 1000;
    const referenceFrames = Math.max(
      1,
      Math.round(DEFAULT_ENGINE_CONFIG.transient.fluxReferenceMs / hopMs)
    );
    const pipeline = new WhitenedBandPipeline(SAMPLE_RATE, fftSize, referenceFrames);
    const window = new Float32Array(fftSize);
    const byEndSample = new Map<number, { patch: Float32Array; wFlux: number; wHeldFlux: number }>();
    const wanted = new Set(attacks.map((f) => f.sampleIndex));
    for (let i = 1; i * hop <= signal.length; i++) {
      const end = i * hop;
      for (let k = 0; k < fftSize; k++) {
        const s = end - fftSize + k;
        window[k] = s >= 0 ? (signal[s] as number) : 0;
      }
      pipeline.push(window);
      if (wanted.has(end)) {
        const flux = pipeline.whitenedFlux();
        byEndSample.set(end, {
          patch: pipeline.patch(new Float32Array(PATCH_HOPS * BAND_COUNT)),
          wFlux: flux.wFlux,
          wHeldFlux: flux.wHeldFlux,
        });
      }
    }

    for (const frame of attacks) {
      const expected = byEndSample.get(frame.sampleIndex);
      expect(expected, `standalone pass has hop ending at sample ${frame.sampleIndex}`).toBeDefined();
      if (expected === undefined || frame.attack?.whitened === undefined) continue;
      const live = frame.attack.whitened;
      expect(live.wFlux).toBeCloseTo(expected.wFlux, 6);
      expect(live.wHeldFlux).toBeCloseTo(expected.wHeldFlux, 6);
      let worst = 0;
      for (let i = 0; i < live.patch.length; i++) {
        worst = Math.max(worst, Math.abs((live.patch[i] as number) - (expected.patch[i] as number)));
      }
      expect(worst, `patch at ${frame.at}ms diverges by ${worst}`).toBeLessThan(1e-6);
    }
  });
});
