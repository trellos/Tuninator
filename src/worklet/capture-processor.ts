/**
 * The AudioWorklet side: capture only, no analysis.
 *
 * The old processor ran the entire detector on the audio thread. That is the
 * one place in a browser where being late is not a slow frame but a click, and
 * it made the deep lane impossible — deep analysis has to revisit audio from
 * hundreds of milliseconds ago, and the audio thread has neither the memory nor
 * the latitude to sit on that history.
 *
 * So this processor does three things, all of them cheap and all of them
 * genuinely per-quantum work: meter the channels, decide which channel to read
 * (or sum them), and post one mono chunk per hop. Everything else happens in
 * the engine host. The cost is one hop (~12ms) plus a postMessage, well inside
 * the fast lane's budget, and the benefit is that the audio thread now has a
 * fixed, tiny, allocation-free workload.
 *
 * This file is the entry point of the IIFE worklet bundle. The build asserts
 * the emitted bundle contains no `import`/`export`: AudioWorkletGlobalScope has
 * no module loader on older targets, and a stray import fails only at runtime,
 * in the browser, with an error that points nowhere useful.
 */

import {
  ChannelSelector,
  resolveChannel,
  type ChannelStrategy,
} from "../engine/kernels/channel-select.js";

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
export type CaptureCommand =
  | { type: "reset" }
  /** Returning a drained buffer for reuse. See the transfer pool below. */
  | { type: "recycle"; buffer: ArrayBuffer };

/** Worklet -> engine host. One message per hop, not per render quantum. */
export type CaptureChunk = {
  type: "chunk";
  /** Mono audio, transferred rather than copied. */
  samples: Float32Array;
  /** Absolute index of the first sample, so a dropped message is detectable. */
  startSample: number;
  /** `AudioContext.currentTime` when this hop was captured. */
  contextTime: number;
  sampleRate: number;
  /** Unsummed per-channel RMS over the hop. */
  channelRms: number[];
  /** Which channel was read, or null when the channels were summed. */
  selectedChannel: number | null;
};

/** Hop the capture side posts at, in samples. 576 @ 48kHz is 12ms. */
const DEFAULT_HOP_SAMPLES = 576;
/** Spare buffers kept for reuse, so the steady state never allocates. */
const POOL_LIMIT = 8;

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly hopSamples: number;
  private readonly strategy: ChannelStrategy;
  private readonly silenceRms: number;

  /** The hop being filled, and how much of it is filled. */
  private pending: Float32Array;
  private pendingFilled = 0;
  private startSample = 0;
  private totalSamples = 0;

  /**
   * Buffers the host has returned. `postMessage` with a transfer neuters the
   * sender's view, so without recycling every hop allocates a fresh
   * Float32Array on the audio thread — 80 allocations a second, forever.
   */
  private readonly pool: ArrayBuffer[] = [];

  private selector: ChannelSelector | null = null;
  private selectorChannels = 0;
  private appliedChannel = -1;

  /** Scratch for the multi-channel downmix. Sized to the render quantum. */
  private mixBuffer = new Float32Array(128);

  private readonly channelSquares: number[] = [];
  private readonly channelRms: number[] = [];
  private channelSamples = 0;

  constructor(options?: {
    processorOptions?: {
      hopSamples?: number;
      channels?: ChannelStrategy;
      rmsGate?: number;
    };
  }) {
    super(options);
    const processorOptions = options?.processorOptions ?? {};
    this.hopSamples = Math.max(
      128,
      Math.floor(processorOptions.hopSamples ?? DEFAULT_HOP_SAMPLES)
    );
    this.strategy = processorOptions.channels ?? "auto";
    this.silenceRms = processorOptions.rmsGate ?? 0.008;
    this.pending = new Float32Array(this.hopSamples);

    this.port.onmessage = (event: MessageEvent<CaptureCommand>) => {
      const command = event.data;
      if (command.type === "recycle") {
        if (this.pool.length < POOL_LIMIT) this.pool.push(command.buffer);
      } else if (command.type === "reset") {
        this.pendingFilled = 0;
        this.startSample = 0;
        this.totalSamples = 0;
        this.resetChannelMeters();
        this.selector?.reset();
        this.appliedChannel = -1;
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
    // A 2-in audio interface presents as one stereo device ("Analogue 1/2"),
    // and a guitar in input 2 lands entirely on channel 1. Reading only channel
    // 0 then sees pure silence while the player hears their instrument
    // perfectly — no error, no pitch, level pinned at zero, which is
    // indistinguishable from a broken detector.
    //
    // The default picks the loudest channel, which cannot comb-filter a mic and
    // a DI of the same guitar the way summing does. Until that decision has
    // latched the channels are summed, which is the safe direction: a sum can
    // be a poor signal, but it cannot miss an instrument entirely.
    const channel = resolveChannel(this.strategy, input.length, this.selector);
    this.appliedChannel = channel ?? -1;

    let block = first;
    if (channel !== null) {
      block = input[channel] ?? first;
    } else if (input.length > 1) {
      // Summed rather than averaged on purpose: averaging costs 6dB when one
      // channel is silent, which is exactly the case this exists to fix, and
      // the engine's rmsGate is an absolute threshold the loss could push the
      // signal back under.
      if (this.mixBuffer.length !== first.length) {
        this.mixBuffer = new Float32Array(first.length);
      }
      const mix = this.mixBuffer;
      mix.set(first);
      for (let c = 1; c < input.length; c++) {
        const other = input[c];
        if (!other || other.length !== mix.length) continue;
        for (let i = 0; i < mix.length; i++) mix[i] = (mix[i] as number) + (other[i] as number);
      }
      block = mix;
    }

    this.meterChannels(input, first.length);
    this.accumulate(block, input.length);
    return true;
  }

  /** Fills the pending hop, posting it whenever it is complete. */
  private accumulate(block: Float32Array, channelCount: number): void {
    let offset = 0;
    while (offset < block.length) {
      const room = this.hopSamples - this.pendingFilled;
      const take = Math.min(room, block.length - offset);
      this.pending.set(block.subarray(offset, offset + take), this.pendingFilled);
      this.pendingFilled += take;
      offset += take;
      this.totalSamples += take;

      if (this.pendingFilled < this.hopSamples) continue;

      const samples = this.pending;
      this.pending = this.take();
      this.pendingFilled = 0;

      const message: CaptureChunk = {
        type: "chunk",
        samples,
        startSample: this.startSample,
        contextTime: currentTime,
        sampleRate,
        channelRms: this.readChannelMeters(channelCount),
        selectedChannel: this.appliedChannel < 0 ? null : this.appliedChannel,
      };
      this.startSample = this.totalSamples;
      this.port.postMessage(message, [samples.buffer]);
    }
  }

  private take(): Float32Array {
    const recycled = this.pool.pop();
    if (recycled !== undefined && recycled.byteLength === this.hopSamples * 4) {
      return new Float32Array(recycled);
    }
    return new Float32Array(this.hopSamples);
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
      // The engine's own gate doubles as the "is anyone playing?" floor: below
      // it no channel would produce a pitch, so which one is loudest is both
      // unanswerable and irrelevant.
      silenceRms: this.silenceRms,
    });
  }

  /**
   * Accumulates the *unsummed* level of every input channel.
   *
   * It erases the one fact a user needs when nothing is detected — whether the
   * instrument is on a channel at all — unless it is measured before the
   * channels are mixed; that is what lets a UI show "ch0 dead, ch1 hot". And it
   * is the input the channel selector decides on.
   */
  private meterChannels(input: Float32Array[], frames: number): void {
    for (let c = 0; c < input.length; c++) {
      const channel = input[c];
      if (!channel) continue;
      let sum = 0;
      for (let i = 0; i < channel.length; i++) {
        sum += (channel[i] as number) * (channel[i] as number);
      }
      this.channelSquares[c] = (this.channelSquares[c] ?? 0) + sum;
    }
    this.channelSamples += frames;
  }

  private readChannelMeters(channels: number): number[] {
    const samples = this.channelSamples;
    const out: number[] = [];
    this.channelRms.length = channels;
    for (let c = 0; c < channels; c++) {
      const squares = this.channelSquares[c] ?? 0;
      const value = samples === 0 ? 0 : Math.sqrt(squares / samples);
      this.channelRms[c] = value;
      out.push(value);
    }

    // The selector runs on the hop, not the render quantum: a 128-sample argmax
    // is noise, and the per-channel RMS needed to decide is already computed
    // here.
    if (this.selector && samples > 0) {
      this.selector.observe(this.channelRms, (samples / sampleRate) * 1000);
    }

    this.resetChannelMeters();
    return out;
  }

  private resetChannelMeters(): void {
    for (let c = 0; c < this.channelSquares.length; c++) this.channelSquares[c] = 0;
    this.channelSamples = 0;
  }
}

registerProcessor("tuninator-capture", CaptureProcessor);
