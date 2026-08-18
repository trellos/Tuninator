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
import {
  ChannelSelector,
  resolveChannel,
  type ChannelStrategy,
} from "../core/channel-select.js";

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
  /** Scratch for the multi-channel downmix. Sized to the render quantum. */
  private mixBuffer = new Float32Array(128);

  /** How the host wants channels combined. Fixed for the life of the node. */
  private readonly strategy: ChannelStrategy;
  /**
   * Built on the first `process()` call, once the real channel count is known,
   * and rebuilt only if that count ever changes. Null for `"sum"`, for an
   * explicit index, and for mono — in all three there is nothing to decide, so
   * there is no per-hop work at all.
   */
  private selector: ChannelSelector | null = null;
  private selectorChannels = 0;
  /** The channel `process()` is currently reading, or -1 while summing. */
  private appliedChannel = -1;

  /**
   * Per-channel sum of squares accumulated across the hop, and the sample count
   * they were accumulated over. Reused across hops, never reallocated in
   * steady state: `postMessage` structured-clones synchronously, so the array
   * attached to a frame is already copied by the time the next hop touches it.
   */
  private readonly channelSquares: number[] = [];
  private readonly channelRms: number[] = [];
  private channelSamples = 0;

  constructor(options?: {
    processorOptions?: { policy: Policy; channels?: ChannelStrategy };
  }) {
    super(options);

    const policy = options?.processorOptions?.policy;
    if (!policy) {
      throw new Error("TuninatorProcessor requires processorOptions.policy");
    }
    this.policy = policy;
    // Not part of `Policy`: policy is per-*mode* detection tuning and is
    // re-sent on every `setMode()`, whereas the channel strategy is a property
    // of the wiring and is fixed when the node is constructed.
    this.strategy = options?.processorOptions?.channels ?? "auto";
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
        this.selector?.reset();
        this.appliedChannel = -1;
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

    this.syncSelector(input.length);

    // Never read channel 0 and nothing else.
    //
    // A 2-in audio interface presents as one stereo device ("Analogue 1/2"), and
    // a guitar in input 2 lands entirely on channel 1. Reading only channel 0
    // then sees pure silence while the player hears their instrument perfectly
    // -- no error, no pitch, level pinned at zero, which is indistinguishable
    // from a broken detector.
    //
    // What to do instead is `this.strategy`. The default picks the loudest
    // channel (see `core/channel-select`), which cannot comb-filter a mic and a
    // DI of the same guitar the way summing does. Until that decision has
    // latched -- and whenever the host asks for it -- the channels are summed,
    // which is the safe direction: a sum can be a poor signal, but it cannot
    // miss an instrument entirely.
    const channel = resolveChannel(this.strategy, input.length, this.selector);
    this.appliedChannel = channel ?? -1;

    let block = first;
    if (channel !== null) {
      block = input[channel] ?? first;
    } else if (input.length > 1) {
      // Summed rather than averaged on purpose: averaging costs 6dB when one
      // channel is silent, which is exactly the case this exists to fix, and
      // `analysis.rmsGate` is an absolute threshold that the loss could push the
      // signal back under. A genuinely stereo source gains up to 6dB instead,
      // which is harmless here -- nothing downstream reproduces this audio.
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
      block = mix;
    }

    this.meterChannels(input, first.length);

    const results = this.tuninator.analyze(block, currentTime * 1000);
    if (results.length === 0) return true;

    const channelRms = this.readChannelMeters(input.length);
    const selectedChannel = this.appliedChannel < 0 ? null : this.appliedChannel;
    for (const result of results) {
      result.frame.channelRms = channelRms;
      result.frame.selectedChannel = selectedChannel;
      this.port.postMessage({
        type: "hop",
        frame: result.frame,
        emissions: result.emissions,
      } satisfies WorkletMessage);
    }

    return true;
  }

  /**
   * Creates (or recreates) the selector once the browser's real channel count
   * is known. Allocates on the first call and then never again, unless the
   * channel count itself changes, which a live `MediaStream` does not do.
   */
  private syncSelector(channels: number): void {
    if (this.strategy !== "auto" || channels <= 1) {
      this.selector = null;
      this.selectorChannels = channels;
      return;
    }
    if (this.selector && this.selectorChannels === channels) return;
    this.selectorChannels = channels;
    this.selector = new ChannelSelector({
      channelCount: channels,
      // The detector's own gate doubles as the "is anyone playing?" floor:
      // below it no channel would produce a pitch, so which one is loudest is
      // both unanswerable and irrelevant.
      silenceRms: this.policy.analysis.rmsGate,
    });
  }

  /**
   * Accumulates the *unsummed* level of every input channel.
   *
   * Two jobs. It erases the one fact a user needs when nothing is detected —
   * whether the instrument is on a channel at all — unless it is measured
   * before the channels are mixed; that is what lets a UI show "ch0 dead, ch1
   * hot". And it is the input the channel selector decides on.
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

    // The selector runs on the hop, not the render quantum: a 128-sample argmax
    // is noise, and the per-channel RMS needed to decide is already computed
    // here. `channelSamples` is the hop length in samples by construction.
    if (this.selector && samples > 0) {
      this.selector.observe(this.channelRms, (samples / sampleRate) * 1000);
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
