/**
 * The DOM adapter: microphone and worklet in, `Recognizer` out.
 *
 * Successor to `tuninator.ts`. Everything musical has moved into
 * `src/engine/`; what is left here is the part that genuinely needs a browser —
 * permissions, an `AudioContext`, an `AudioWorkletNode`, and the teardown that
 * releases all three.
 *
 * Three fixes to the old adapter are visible in its shape:
 *  - `stop()` is async and flushes, so a Note still sounding gets its
 *    `noteEnded` instead of being silently dropped.
 *  - `dispose()` exists at all, and only closes an `AudioContext` this file
 *    created — a caller-supplied context belongs to the caller.
 *  - every rejection is a real `RecognizerError`, so it can be thrown, caught
 *    by type, and carry a stack.
 */

import { Emitter } from "../emitter.js";
import { RecognizerError, toRecognizerError } from "../errors.js";
import { resolveEngineConfig, snapHop } from "../engine/config.js";
import type {
  Note,
  PitchFrame,
  Recognizer,
  RecognizerEventMap,
  RecognizerEventName,
  RecognizerOptions,
  RecognizerState,
  Timebase,
} from "../types.js";
import type { CaptureChunk, CaptureCommand } from "../worklet/capture-processor.js";
import { InlineEngineHost, createWorkerHost, type EnginePort } from "./engine-host.js";

const PROCESSOR_NAME = "tuninator-capture";
const DEFAULT_WORKLET_URL = "./tuninator-worklet.js";

class BrowserRecognizer implements Recognizer {
  private readonly options: RecognizerOptions;
  private readonly emitter = new Emitter();

  private state: RecognizerState = "idle";
  private context: AudioContext | null = null;
  /** True only when this object created the context and must therefore close it. */
  private ownsContext = false;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private engine: EnginePort | null = null;
  private timebase: Timebase | null = null;
  private disposed = false;
  private starting: Promise<void> | null = null;

  constructor(options: RecognizerOptions = {}) {
    this.options = options;
  }

  getState(): RecognizerState {
    return this.state;
  }

  getActiveNotes(): Note[] {
    return this.engine?.getActiveNotes() ?? [];
  }

  getNote(id: string): Note | undefined {
    return this.engine?.getNote(id);
  }

  getTimebase(): Timebase | null {
    return this.timebase;
  }

  on<E extends RecognizerEventName>(
    eventName: E,
    handler: RecognizerEventMap[E]
  ): () => void {
    return this.emitter.on(eventName, handler);
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new RecognizerError("already-disposed", "this recognizer has been disposed");
    }
    if (this.state === "listening") return;
    if (this.starting !== null) return this.starting;

    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.setState("starting");
    try {
      const context = await this.resolveContext();
      const stream = await this.openMicrophone();
      this.stream = stream;

      await this.loadWorklet(context);

      const config = resolveEngineConfig(this.options.engine, this.options.diagnostics);
      const hopSamples = snapHop(config.analysis.hopMs, context.sampleRate);

      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: {
          hopSamples,
          channels: this.options.input?.channels ?? "auto",
          rmsGate: config.analysis.rmsGate,
        },
      });

      const engine =
        this.options.host === "worker"
          ? createWorkerHost()
          : new InlineEngineHost(context.sampleRate, config, context.currentTime);

      engine.onOutput((output) => this.deliver(output.emissions, output.frames));
      engine.onRecycle((buffer) => {
        node.port.postMessage({ type: "recycle", buffer } satisfies CaptureCommand, [buffer]);
      });

      node.port.onmessage = (event: MessageEvent<CaptureChunk>) => {
        const chunk = event.data;
        if (chunk.type !== "chunk") return;
        engine.push(chunk.samples, chunk.startSample);
      };
      node.onprocessorerror = () => {
        this.fail(
          new RecognizerError("worklet-load-failed", "the capture worklet stopped unexpectedly")
        );
      };

      source.connect(node);

      this.context = context;
      this.source = source;
      this.node = node;
      this.engine = engine;
      this.timebase = engine.getTimebase();
      this.setState("listening");
      this.emitter.emit("status", `listening at ${context.sampleRate}Hz`);
    } catch (error) {
      await this.teardown();
      const wrapped = toRecognizerError(error);
      this.setState("error");
      this.emitter.emit("error", wrapped);
      throw wrapped;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "idle") return;
    this.setState("stopping");
    // Flush BEFORE tearing the graph down, so every open Note gets its
    // `noteEnded` while there is still an engine to produce it. The old
    // synchronous `stop()` dropped whatever was in flight.
    await this.engine?.flush();
    await this.teardown();
    this.setState("idle");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.stop();
    this.disposed = true;
    this.emitter.clear();
  }

  /* ------------------------------------------------------------------ */

  private deliver(
    emissions: ReadonlyArray<import("../engine/tracker/note-tracker.js").TrackerEmission>,
    frames: readonly PitchFrame[]
  ): void {
    for (const frame of frames) this.emitter.emit("pitchFrame", frame);
    for (const emission of emissions) {
      switch (emission.type) {
        case "started":
          this.emitter.emit("noteStarted", emission.note);
          break;
        case "changed":
          this.emitter.emit("noteChanged", emission.note, emission.change);
          break;
        case "resolved":
          this.emitter.emit("noteResolved", emission.note);
          break;
        case "ended":
          this.emitter.emit("noteEnded", emission.note);
          break;
      }
    }
  }

  private setState(state: RecognizerState): void {
    if (this.state === state) return;
    this.state = state;
    this.emitter.emit("stateChange", state);
  }

  private fail(error: RecognizerError): void {
    this.setState("error");
    this.emitter.emit("error", error);
  }

  private async resolveContext(): Promise<AudioContext> {
    const supplied = this.options.audioContext;
    if (supplied) {
      if (supplied.state === "suspended") await supplied.resume();
      this.ownsContext = false;
      return supplied;
    }
    const Ctor =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      throw new RecognizerError("audio-context-failed", "Web Audio is not available here");
    }
    try {
      const context = new Ctor();
      if (context.state === "suspended") await context.resume();
      this.ownsContext = true;
      return context;
    } catch (error) {
      throw new RecognizerError("audio-context-failed", "could not create an AudioContext", error);
    }
  }

  private async openMicrophone(): Promise<MediaStream> {
    const media = globalThis.navigator?.mediaDevices;
    if (!media?.getUserMedia) {
      throw new RecognizerError("mic-unavailable", "getUserMedia is not available here");
    }
    const input = this.options.input ?? {};
    try {
      return await media.getUserMedia({
        audio: {
          ...(input.deviceId ? { deviceId: input.deviceId } : {}),
          echoCancellation: input.echoCancellation ?? false,
          noiseSuppression: input.noiseSuppression ?? false,
          autoGainControl: input.autoGainControl ?? false,
          // Ideal, never exact: a genuinely mono microphone still opens, it
          // just reports 1 channel.
          channelCount: { ideal: input.channelCount ?? 2 },
        },
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      const code =
        name === "NotAllowedError" || name === "SecurityError"
          ? "mic-permission-denied"
          : "mic-unavailable";
      throw new RecognizerError(code, `could not open the microphone: ${String(name ?? error)}`, error);
    }
  }

  private async loadWorklet(context: AudioContext): Promise<void> {
    if (!context.audioWorklet) {
      throw new RecognizerError("worklet-unavailable", "AudioWorklet is not available here");
    }
    const url = this.options.workletUrl ?? DEFAULT_WORKLET_URL;
    try {
      await context.audioWorklet.addModule(typeof url === "string" ? url : url.href);
    } catch (error) {
      throw new RecognizerError(
        "worklet-load-failed",
        `could not load the capture worklet from ${String(url)}`,
        error
      );
    }
  }

  private async teardown(): Promise<void> {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.onprocessorerror = null;
      this.node.disconnect();
      this.node = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    await this.engine?.dispose();
    this.engine = null;
    // Only a context this object created is ours to close. A shared one is the
    // caller's, and closing it would take down the rest of their audio graph.
    if (this.context && this.ownsContext) await this.context.close();
    this.context = null;
    this.timebase = null;
  }
}

export function createRecognizer(options: RecognizerOptions = {}): Recognizer {
  return new BrowserRecognizer(options);
}
