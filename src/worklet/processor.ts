/**
 * AudioWorkletProcessor wrapping `core/pitch-engine` and `core/event-tracker`.
 *
 * This file is the entry point of the IIFE worklet bundle. Everything it pulls
 * in comes from `src/core/`, which is exactly why core has no DOM and no npm
 * imports: the same modules are bundled into this file, imported by Node for the
 * offline eval, and imported by Vitest.
 *
 * The build asserts that the emitted bundle contains no `import`/`export` —
 * AudioWorkletGlobalScope has no module loader on older targets, and a stray
 * import fails only at runtime in the browser.
 */

import type { MusicEvent, PitchFrame } from "../types.js";
import type { Policy } from "../core/policy.js";
import { PitchEngine } from "../core/pitch-engine.js";
import { EventTracker } from "../core/event-tracker.js";

/* AudioWorkletGlobalScope declarations — not in the standard DOM lib. */
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessorBase {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare const AudioWorkletProcessor: typeof AudioWorkletProcessorBase;
declare function registerProcessor(name: string, ctor: unknown): void;

/** Main thread -> worklet. */
export type WorkletCommand =
  | { type: "policy"; policy: Policy }
  | { type: "reset" };

/** Worklet -> main thread. One message per hop, not per render quantum. */
export type WorkletMessage = {
  type: "hop";
  frame: PitchFrame;
  emissions: Array<{ type: "start" | "update" | "end"; event: MusicEvent }>;
};

class TuninatorProcessor extends AudioWorkletProcessor {
  private engine: PitchEngine;
  private tracker: EventTracker;
  private policy: Policy;
  /** Scratch for the multi-channel downmix. Sized to the render quantum. */
  private mixBuffer = new Float32Array(128);

  constructor(options?: { processorOptions?: { policy: Policy } }) {
    super(options);

    const policy = options?.processorOptions?.policy;
    if (!policy) {
      throw new Error("TuninatorProcessor requires processorOptions.policy");
    }
    this.policy = policy;
    this.engine = new PitchEngine(sampleRate, policy);
    this.tracker = new EventTracker(policy);

    this.port.onmessage = (event: MessageEvent<WorkletCommand>) => {
      const command = event.data;
      if (command.type === "policy") {
        // Mode changes swap parameters in place. The audio graph, the ring
        // buffer, and any in-flight event all survive.
        this.policy = command.policy;
        this.engine.setPolicy(command.policy);
        this.tracker.setPolicy(command.policy);
      } else if (command.type === "reset") {
        const emissions = this.tracker.flush(currentTime * 1000);
        this.engine.reset();
        if (emissions.length > 0) {
          this.port.postMessage({
            type: "hop",
            frame: silentFrame(currentTime * 1000, sampleRate),
            emissions,
          } satisfies WorkletMessage);
        }
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const first = input?.[0];
    if (!input || !first || first.length === 0) {
      // No input connected yet. Stay alive; the node is still wired up.
      return true;
    }

    // Sum every channel, do not read channel 0 alone.
    //
    // A 2-in audio interface presents as one stereo device ("Analogue 1/2"), and
    // a guitar in input 2 lands entirely on channel 1. Reading only channel 0
    // then sees pure silence while the player hears their instrument perfectly
    // -- no error, no pitch, level pinned at zero, which is indistinguishable
    // from a broken detector.
    //
    // Summed rather than averaged on purpose: averaging costs 6dB when one
    // channel is silent, which is exactly the case this exists to fix, and
    // `analysis.rmsGate` is an absolute threshold that the loss could push the
    // signal back under. A genuinely stereo source gains up to 6dB instead,
    // which is harmless here -- nothing downstream reproduces this audio.
    let block = first;
    if (input.length > 1) {
      if (this.mixBuffer.length !== first.length) {
        this.mixBuffer = new Float32Array(first.length);
      }
      const mix = this.mixBuffer;
      mix.set(first);
      for (let c = 1; c < input.length; c++) {
        const channel = input[c];
        if (!channel || channel.length !== mix.length) continue;
        for (let i = 0; i < mix.length; i++) mix[i] = mix[i]! + channel[i]!;
      }
      block = mix;
    }

    const timestampMs = currentTime * 1000;
    const engineFrame = this.engine.push(block, timestampMs);
    if (engineFrame === null) return true;

    const emissions = this.tracker.process(engineFrame);
    this.port.postMessage({
      type: "hop",
      frame: engineFrame.frame,
      emissions,
    } satisfies WorkletMessage);

    return true;
  }
}

function silentFrame(timestamp: number, rate: number): PitchFrame {
  return {
    timestamp,
    frequencyHz: null,
    confidence: 0,
    nearest: null,
    amplitude: { rms: 0, peak: 0 },
    detector: { tau: null, cmnd: null, zeroCrossingHz: null, effectiveSampleRate: rate },
  };
}

registerProcessor("tuninator-processor", TuninatorProcessor);
