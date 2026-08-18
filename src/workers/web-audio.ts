/**
 * WorkerWebAudio: the browser worker for the `Tuninator` library.
 *
 * Everything the library refuses to know about lives here — the microphone, the
 * `AudioContext`, the `AudioWorklet`, the permission prompt, the clock, and the
 * subscription API. The analysis itself runs inside the worklet, on the very
 * same `Tuninator` a Node caller would construct.
 *
 * State: idle -> starting -> (waiting-for-user-gesture) -> listening.
 * `stop()` returns to idle; any failure goes to `error` AND emits an `error`
 * event carrying the right `TuninatorErrorCode`.
 */

import type {
  MusicEvent,
  TuninatorError,
  TuninatorErrorCode,
  TuninatorEventHandler,
  TuninatorEventName,
  TuninatorMode,
  TuninatorOptions,
  TuninatorState,
  TuninatorWorker,
} from "../types.js";
import { Emitter } from "../emitter.js";
import { repolicy, resolvePolicy, type Policy } from "../core/policy.js";
import type { WorkletCommand, WorkletMessage } from "./web-audio-processor.js";

const PROCESSOR_NAME = "tuninator-processor";

class WorkerWebAudio implements TuninatorWorker {
  private readonly emitter = new Emitter();
  private readonly options: TuninatorOptions;

  private state: TuninatorState = "idle";
  private mode: TuninatorMode;
  private policy: Policy;

  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;

  /** Events the tracker has started but not yet ended, mirrored main-side. */
  private readonly active = new Map<string, MusicEvent>();

  private startPromise: Promise<void> | null = null;

  constructor(options: TuninatorOptions) {
    this.options = options;
    this.mode = options.mode ?? "lead";
    this.policy = resolvePolicy(options);
  }

  getState(): TuninatorState {
    return this.state;
  }

  getMode(): TuninatorMode {
    return this.mode;
  }

  getActiveEvents(): MusicEvent[] {
    return [...this.active.values()];
  }

  on<E extends TuninatorEventName>(
    eventName: E,
    handler: TuninatorEventHandler<E>
  ): () => void {
    return this.emitter.on(eventName, handler);
  }

  /** Swaps the policy and posts it to the worklet. Never restarts the graph. */
  setMode(mode: TuninatorMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.policy = repolicy(mode, this.options);
    this.post({ type: "policy", policy: this.policy });
    this.emitter.emit("status", `mode: ${mode}`);
  }

  async start(): Promise<void> {
    if (this.state === "listening" || this.state === "starting") {
      return this.startPromise ?? Promise.resolve();
    }

    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    this.setState("starting");
    this.emitter.emit("status", "requesting microphone");

    let stream: MediaStream;
    try {
      stream = await this.requestMicrophone();
    } catch (error) {
      this.fail(classifyMicError(error), micErrorMessage(error), error);
      return;
    }
    this.stream = stream;
    this.emitter.emit("status", this.describeInput(stream));

    let context: AudioContext;
    try {
      context = new AudioContext();
    } catch (error) {
      this.cleanup();
      this.fail("audio-context-failed", "Could not create an AudioContext.", error);
      return;
    }
    this.context = context;

    if (!context.audioWorklet) {
      this.cleanup();
      this.fail(
        "worklet-unavailable",
        "This browser does not support AudioWorklet, which tuninator requires.",
        undefined
      );
      return;
    }

    const workletUrl = this.resolveWorkletUrl();
    if (workletUrl === null) {
      this.cleanup();
      this.fail(
        "worklet-load-failed",
        "No workletUrl was supplied and the default could not be resolved. " +
          "Copy dist/tuninator-worklet.js into your static assets and pass its URL.",
        undefined
      );
      return;
    }

    try {
      this.emitter.emit("status", "loading worklet");
      await context.audioWorklet.addModule(workletUrl);
    } catch (error) {
      this.cleanup();
      this.fail(
        "worklet-load-failed",
        `Failed to load the tuninator worklet from "${String(workletUrl)}". ` +
          "Check that the file is served and that its URL is correct.",
        error
      );
      return;
    }

    try {
      this.node = new AudioWorkletNode(context, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        // These two are the AudioWorkletNode defaults, restated because getting
        // them wrong silently destroys a channel and there is no way to see it
        // from the outside.
        //
        // "max" means the node's input carries as many channels as the thing
        // connected to it, with no mixing at all -- a 2-channel
        // MediaStreamAudioSourceNode arrives in `process()` as two separate
        // channels (verified in Chromium, headless). `channelCount` is ignored
        // in this mode, which is why it is not set: setting
        // `channelCountMode: "explicit"` with `channelCount: 1` would instead
        // force a downmix, and `channelInterpretation: "discrete"` would make
        // any such downmix *discard* the extra channels rather than fold them
        // in. "speakers" is the survivable failure mode of the two.
        channelCountMode: "max",
        channelInterpretation: "speakers",
        processorOptions: {
          policy: this.policy,
          // Fixed at construction: unlike the policy, this describes the
          // wiring, not the detection mode, so `setMode()` never resends it.
          channels: this.options.input?.channels ?? "auto",
        },
      });
    } catch (error) {
      this.cleanup();
      this.fail("worklet-load-failed", "Could not instantiate the tuninator worklet node.", error);
      return;
    }

    this.node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      this.handleWorkletMessage(event.data);
    };
    this.node.onprocessorerror = (error) => {
      this.fail("unknown", "The tuninator worklet stopped unexpectedly.", error);
    };

    this.source = context.createMediaStreamSource(stream);
    this.source.connect(this.node);

    // Autoplay policy: a context created outside a user gesture starts
    // suspended, and no audio flows until it is resumed.
    if (context.state === "suspended") {
      this.setState("waiting-for-user-gesture");
      this.emitter.emit("status", "audio is suspended — call start() from a user gesture");
      try {
        await context.resume();
      } catch {
        // Not fatal: a later user gesture can still resume it.
        return;
      }
    }

    if (context.state === "running") {
      this.setState("listening");
      this.emitter.emit("status", "listening");
    }
  }

  private async requestMicrophone(): Promise<MediaStream> {
    const media = globalThis.navigator?.mediaDevices;
    if (!media?.getUserMedia) {
      throw new DOMException("getUserMedia is unavailable", "NotFoundError");
    }

    const input = this.options.input ?? {};
    return media.getUserMedia({
      audio: {
        ...(input.deviceId ? { deviceId: { exact: input.deviceId } } : {}),
        // Guitar analysis wants the raw signal. These processors are tuned for
        // speech and will chew holes in a sustained note.
        echoCancellation: input.echoCancellation ?? false,
        noiseSuppression: input.noiseSuppression ?? false,
        autoGainControl: input.autoGainControl ?? false,
        // Ask for stereo explicitly.
        //
        // A 2-in interface presents as ONE stereo device ("Analogue 1/2"), and
        // an instrument in input 2 is entirely on channel 1. Chrome opens a
        // capture device in mono unless a channel count is requested, so
        // without this the second input never reaches the page at all — no
        // error, no level, nothing downstream can recover it.
        //
        // Plain value, not `{ exact: 2 }`: this is an *ideal* constraint, so a
        // genuinely mono microphone still opens and simply reports 1 rather
        // than failing with OverconstrainedError.
        channelCount: input.channelCount ?? 2,
      },
      video: false,
    });
  }

  /**
   * Best-effort description of what the browser actually opened.
   *
   * Deliberately total: this is diagnostics, and a stream shim that does not
   * implement `getAudioTracks`/`getSettings` must not be able to fail `start()`.
   */
  private describeInput(stream: MediaStream): string {
    const track = stream.getAudioTracks?.()?.[0];
    if (!track) return "input: no audio track";
    const channels = track.getSettings?.()?.channelCount;
    const label = track.label ? `"${track.label}"` : "unnamed device";
    const count = typeof channels === "number" ? `${channels} channel(s)` : "unknown channel count";
    return `input: ${label}, ${count}`;
  }

  private resolveWorkletUrl(): string | URL | null {
    if (this.options.workletUrl) return this.options.workletUrl;
    try {
      // Works when the library is served unbundled next to its own dist output.
      // Bundlers usually will not copy the asset, which is why workletUrl is
      // documented as the supported path.
      return new URL("./tuninator-worklet.js", import.meta.url);
    } catch {
      return null;
    }
  }

  private handleWorkletMessage(message: WorkletMessage): void {
    if (message.type !== "hop") return;

    this.emitter.emit("pitchFrame", message.frame);

    for (const emission of message.emissions) {
      const event = emission.event;
      if (emission.type === "start") {
        this.active.set(event.id, event);
        this.emitter.emit("musicEventStart", event);
      } else if (emission.type === "update") {
        this.active.set(event.id, event);
        this.emitter.emit("musicEventUpdate", event);
      } else {
        this.active.delete(event.id);
        this.emitter.emit("musicEventEnd", event);
      }
    }
  }

  private post(command: WorkletCommand): void {
    this.node?.port.postMessage(command);
  }

  stop(): void {
    this.post({ type: "reset" });
    this.cleanup();
    this.active.clear();
    this.setState("idle");
    this.emitter.emit("status", "stopped");
  }

  private cleanup(): void {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      // Releasing every track is what turns the browser's recording indicator
      // back off. Disconnecting the graph alone does not.
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.context) {
      void this.context.close().catch(() => undefined);
      this.context = null;
    }
  }

  private setState(state: TuninatorState): void {
    if (this.state === state) return;
    this.state = state;
    this.emitter.emit("stateChange", state);
  }

  private fail(code: TuninatorErrorCode, message: string, cause: unknown): void {
    this.setState("error");
    const error: TuninatorError = { code, message, cause };
    this.emitter.emit("error", error);
  }
}

function classifyMicError(error: unknown): TuninatorErrorCode {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "mic-permission-denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") {
    return "mic-unavailable";
  }
  return "unknown";
}

function micErrorMessage(error: unknown): string {
  switch (classifyMicError(error)) {
    case "mic-permission-denied":
      return "Microphone permission was denied.";
    case "mic-unavailable":
      return "No usable microphone was found.";
    default:
      return "Could not open the microphone.";
  }
}

/**
 * Creates a browser worker: opens the microphone, loads the worklet, and
 * streams `pitchFrame` / `musicEvent*` events.
 *
 * For anything that is not a web page — Node, a test, a different audio host —
 * construct `Tuninator` from the package root and push audio into it directly.
 */
export function createWorkerWebAudio(options: TuninatorOptions = {}): TuninatorWorker {
  return new WorkerWebAudio(options);
}

/** @deprecated Renamed to `createWorkerWebAudio`. */
export const createTuninator = createWorkerWebAudio;
