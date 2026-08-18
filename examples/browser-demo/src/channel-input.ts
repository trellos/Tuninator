/**
 * The demo's audio input stage: open the microphone, and decide which channel
 * of it the library gets to see.
 *
 * This is the half of the problem `tuninator` deliberately does not solve. A
 * 2-in interface presents to the browser as one *stereo* device, so a guitar in
 * input 2 exists only on channel 1 and nothing at all is on channel 0. Which
 * input the instrument is plugged into is a property of this rig, on this
 * machine, right now — the library is handed one mono channel and analyses it.
 *
 * So the graph here is:
 *
 *   getUserMedia(stereo) -> MediaStreamAudioSource -> ChannelSplitter
 *                                                        |-> ch0 -> Gain(0|1) -\
 *                                                        |-> ch1 -> Gain(0|1) --+-> out
 *
 * Every channel has its own gain, and exactly one of them is open at a time.
 * Switching channel is a gain change rather than a reconnect, which keeps the
 * change sample-accurate and click-free. `out` is what gets passed to the
 * library as `input.source`.
 *
 * Which gain is open is decided by `ChannelSelector` — windowed and hysteretic,
 * because a per-hop argmax jitters and switching mid-note splices two
 * uncorrelated waveforms together.
 */

import { ChannelSelector, resolveChannel, type ChannelStrategy } from "./channel-select.js";

/** Matches the library's default `analysis.rmsGate`. */
const SILENCE_RMS = 0.008;

/** How often the selector is fed a fresh level reading. */
const POLL_MS = 50;

/** Time constant of the per-channel level meters. 0 = no smoothing at all. */
const METER_SMOOTHING = 0;

/** FFT size of the per-channel analysers. Only the time-domain data is used. */
const METER_FFT_SIZE = 1024;

export type ChannelInputOptions = {
  /** Channels to request. 2 is what makes a 2-in interface's input 2 reachable. */
  channelCount?: number;
  deviceId?: string;
  /** Which channel to analyse. Defaults to `"auto"`. */
  channels?: ChannelStrategy;
};

export type ChannelInput = {
  /** Pass this to the library as `input.source`. Always mono. */
  readonly node: AudioNode;
  readonly context: AudioContext;
  /** Channels the browser actually delivered. */
  readonly channelCount: number;
  /** The channel currently being analysed, or null while summing. */
  selected(): number | null;
  /** Most recent per-channel RMS, for a UI that wants to show input meters. */
  levels(): readonly number[];
  /** Stops the meters, releases the microphone, and closes the context. */
  dispose(): void;
};

export async function openChannelInput(
  options: ChannelInputOptions = {}
): Promise<ChannelInput> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      // Raw signal: these processors are tuned for speech and chew holes in a
      // sustained note.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      // Ideal, not exact, so a genuinely mono microphone still opens.
      channelCount: options.channelCount ?? 2,
    },
    video: false,
  });

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const channelCount = Math.max(1, source.channelCount);

  const splitter = context.createChannelSplitter(channelCount);
  source.connect(splitter);

  const out = context.createGain();
  const gains: GainNode[] = [];
  const analysers: AnalyserNode[] = [];
  // Explicitly ArrayBuffer-backed: the DOM signature for
  // getFloatTimeDomainData will not accept a SharedArrayBuffer view.
  const buffers: Float32Array<ArrayBuffer>[] = [];

  for (let c = 0; c < channelCount; c++) {
    const gain = context.createGain();
    // Start with everything open: summing can be a poor signal, but it cannot
    // miss an instrument, which is the right way to be wrong before any
    // decision has latched.
    gain.gain.value = 1;
    splitter.connect(gain, c);
    gain.connect(out);
    gains.push(gain);

    const analyser = context.createAnalyser();
    analyser.fftSize = METER_FFT_SIZE;
    analyser.smoothingTimeConstant = METER_SMOOTHING;
    splitter.connect(analyser, c);
    analysers.push(analyser);
    buffers.push(new Float32Array(analyser.fftSize));
  }

  const strategy: ChannelStrategy = options.channels ?? "auto";
  const selector =
    strategy === "auto" && channelCount > 1
      ? new ChannelSelector({ channelCount, silenceRms: SILENCE_RMS })
      : null;

  const levels = new Array<number>(channelCount).fill(0);
  let applied: number | null = null;

  /** Opens exactly the chosen channel, or all of them when summing. */
  const apply = (channel: number | null): void => {
    if (channel === applied) return;
    applied = channel;
    for (let c = 0; c < gains.length; c++) {
      gains[c]!.gain.setTargetAtTime(
        channel === null || channel === c ? 1 : 0,
        context.currentTime,
        0.01
      );
    }
  };

  apply(resolveChannel(strategy, channelCount, selector));

  const timer = setInterval(() => {
    for (let c = 0; c < channelCount; c++) {
      const buffer = buffers[c]!;
      analysers[c]!.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i]! * buffer[i]!;
      levels[c] = Math.sqrt(sum / buffer.length);
    }
    selector?.observe(levels, POLL_MS);
    apply(resolveChannel(strategy, channelCount, selector));
  }, POLL_MS);

  return {
    node: out,
    context,
    channelCount,
    selected: () => applied,
    levels: () => levels,
    dispose: () => {
      clearInterval(timer);
      for (const track of stream.getTracks()) track.stop();
      source.disconnect();
      splitter.disconnect();
      for (const gain of gains) gain.disconnect();
      for (const analyser of analysers) analyser.disconnect();
      out.disconnect();
      void context.close().catch(() => undefined);
    },
  };
}
