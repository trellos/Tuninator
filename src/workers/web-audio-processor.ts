/**
 * The AudioWorklet half of `WorkerWebAudio`: a processor that pushes render
 * quanta into a `Tuninator` and posts the results to the main thread.
 *
 * This file is the entry point of the IIFE worklet bundle. It holds no analysis
 * of its own — it is a transport. The `Tuninator` running inside it is the same
 * class a Node caller constructs, which is the only reason the offline eval
 * predicts live behaviour.
 *
 * The build asserts that the emitted bundle contains no `import`/`export` —
 * AudioWorkletGlobalScope has no module loader on older targets, and a stray
 * import fails only at runtime in the browser.
 */

import type { MusicEvent, PitchFrame } from "../types.js";
import type { Policy } from "../core/policy.js";
import { Tuninator } from "../tuninator.js";

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
  private readonly tuninator: Tuninator;
  private policy: Policy;

  /**
   * Scratch for folding a multi-channel input down to mono. Only ever used when
   * the host connected something wider than the mono this expects.
   */
  private mixBuffer = new Float32Array(128);

  /**
   * Per-channel sum of squares accumulated across the hop, and the sample count
   * they were accumulated over. Reused across hops, never reallocated in steady
   * state: `postMessage` structured-clones synchronously, so the array attached
   * to a frame is already copied by the time the next hop touches it.
   */
  private readonly channelSquares: number[] = [];
  private readonly channelRms: number[] = [];
  private channelSamples = 0;

  constructor(options?: { processorOptions?: { policy: Policy } }) {
    super(options);

    const policy = options?.processorOptions?.policy;
    if (!policy) {
      throw new Error("TuninatorProcessor requires processorOptions.policy");
    }
    this.policy = policy;
    this.tuninator = new Tuninator({ sampleRate, policy });

    this.port.onmessage = (event: MessageEvent<WorkletCommand>) => {
      const command = event.data;
      if (command.type === "policy") {
        // Mode changes swap parameters in place. The audio graph, the ring
        // buffer, and any in-flight event all survive.
        this.policy = command.policy;
        this.tuninator.setPolicy(command.policy);
      } else if (command.type === "reset") {
        const emissions = this.tuninator.reset(currentTime * 1000);
        this.resetChannelMeters();
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

    // The contract is mono: the host connects the one channel it wants
    // analysed. Which physical input an instrument is plugged into is something
    // only the host can know — a 2-in interface presents as a single stereo
    // device, and a guitar in input 2 exists solely on channel 1 — so the host
    // splits and chooses, and this analyses what it is given.
    //
    // If something wider does arrive, fold it down rather than reading channel 0
    // and calling it a day: a sum can be a poor signal, but it cannot miss an
    // instrument entirely, and silently analysing one channel of a stereo pair
    // is indistinguishable from a broken detector. `channelRms` reports each
    // channel unmixed so a host can see that it happened.
    const block = input.length === 1 ? first : this.mixToMono(input, first);

    this.meterChannels(input, first.length);

    const results = this.tuninator.analyze(block, currentTime * 1000);
    if (results.length === 0) return true;

    const channelRms = this.readChannelMeters(input.length);
    for (const result of results) {
      result.frame.channelRms = channelRms;
      this.port.postMessage({
        type: "hop",
        frame: result.frame,
        emissions: result.emissions,
      } satisfies WorkletMessage);
    }

    return true;
  }

  /**
   * Summed rather than averaged on purpose: averaging costs 6dB when one channel
   * is silent, and `analysis.rmsGate` is an absolute threshold that the loss
   * could push the signal back under. A genuinely stereo source gains up to 6dB
   * instead, which is harmless — nothing downstream reproduces this audio.
   */
  private mixToMono(input: Float32Array[], first: Float32Array): Float32Array {
    if (this.mixBuffer.length !== first.length) {
      this.mixBuffer = new Float32Array(first.length);
    }
    const mix = this.mixBuffer;
    mix.set(first);
    for (let c = 1; c < input.length; c++) {
      const other = input[c];
      if (!other || other.length !== mix.length) continue;
      for (let i = 0; i < mix.length; i++) mix[i] = mix[i]! + other[i]!;
    }
    return mix;
  }

  /**
   * Accumulates the *unmixed* level of every input channel.
   *
   * This is the one fact a host needs when nothing is detected — whether the
   * instrument reached the page at all — and it is unrecoverable once the
   * channels are folded together. Measurement only: nothing here decides
   * anything.
   */
  private meterChannels(input: Float32Array[], frames: number): void {
    for (let c = 0; c < input.length; c++) {
      const channel = input[c];
      if (!channel) continue;
      let sum = 0;
      for (let i = 0; i < channel.length; i++) sum += channel[i]! * channel[i]!;
      this.channelSquares[c] = (this.channelSquares[c] ?? 0) + sum;
    }
    this.channelSamples += frames;
  }

  private readChannelMeters(channels: number): number[] {
    const samples = this.channelSamples;
    this.channelRms.length = channels;
    for (let c = 0; c < channels; c++) {
      const squares = this.channelSquares[c] ?? 0;
      this.channelRms[c] = samples === 0 ? 0 : Math.sqrt(squares / samples);
    }
    this.resetChannelMeters();
    return this.channelRms;
  }

  private resetChannelMeters(): void {
    for (let c = 0; c < this.channelSquares.length; c++) this.channelSquares[c] = 0;
    this.channelSamples = 0;
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
