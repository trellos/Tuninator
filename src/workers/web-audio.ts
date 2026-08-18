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
  private source: AudioNode | null = null;
  private node: AudioWorkletNode | null = null;

  /**
   * Whether this worker created the context and opened the stream, and so is
   * the party allowed to tear them down. A host that passed `input.source` owns
   * its own graph; closing its `AudioContext` out from under it would silence
   * the rest of its application.
   */
  private ownsContext = false;
  private ownsStream = false;

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

    // A host-supplied source is already wired: no permission prompt, no device
    // to pick, and — when it is an AudioNode — a context that already exists
    // and must be reused, because nodes cannot cross contexts.
    const supplied = this.options.input?.source;

    let context: AudioContext;
    if (isAudioNode(supplied)) {
      context = supplied.context as AudioContext;
      this.context = context;
      this.source = supplied;
      this.emitter.emit("status", "using host-supplied audio node");
    } else {
      let stream: MediaStream;
      if (supplied) {
        stream = supplied;
        this.emitter.emit("status", "using host-supplied media stream");
      } else {
        this.emitter.emit("status", "requesting microphone");
        try {
          stream = await this.requestMicrophone();
        } catch (error) {
          this.fail(classifyMicError(error), micErrorMessage(error), error);
          return;
        }
        this.ownsStream = true;
      }
      this.stream = stream;
      this.emitter.emit("status", this.describeInput(stream));

      try {
        context = new AudioContext();
      } catch (error) {
        this.cleanup();
        this.fail("audio-context-failed", "Could not create an AudioContext.", error);
        return;
      }
      this.ownsContext = true;
      this.context = context;
    }

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
        // The AudioWorkletNode defaults, restated because getting them wrong
        // silently destroys a channel and there is no way to see it from the
        // outside.
        //
        // "max" means the node's input carries as many channels as the thing
        // connected to it, with no mixing at all. Analysis input is meant to be
        // mono, but forcing a downmix here would hide a host wiring mistake
        // instead of letting `channelRms` report it -- and
        // `channelInterpretation: "discrete"` would make any such downmix
        // *discard* the extra channels rather than fold them in.
        channelCountMode: "max",
        channelInterpretation: "speakers",
        processorOptions: { policy: this.policy },
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

    if (this.source === null) {
      this.source = context.createMediaStreamSource(this.stream as MediaStream);
    }
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
        // Mono by default, because analysis input is mono and this worker does
        // not choose channels.
        //
        // A host that wants a specific input of a multi-channel interface asks
        // for the channels here, splits the result itself, and passes the one
        // it wants as `input.source` — Chrome opens a capture device in mono
        // unless a channel count is requested, so a channel not asked for here
        // never reaches the page at all and cannot be recovered later.
        //
        // Plain value, not `{ exact: n }`: an *ideal* constraint, so a device
        // that cannot honour it still opens rather than failing with
        // OverconstrainedError.
        channelCount: input.channelCount ?? 1,
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
    // End every event that was still sounding, BEFORE tearing the graph down.
    //
    // Posting `reset` to the worklet does flush its tracker, but the reply
    // comes back asynchronously — and `cleanup()` detaches the port and closes
    // the context on this very tick, so those emissions could never arrive. A
    // consumer holding state from `musicEventStart` would keep it forever.
    this.endActiveEvents();
    this.post({ type: "reset" });
    this.cleanup();
    this.setState("idle");
    this.emitter.emit("status", "stopped");
  }

  /** Emits `musicEventEnd` for everything still open, then forgets them. */
  private endActiveEvents(): void {
    if (this.active.size === 0) return;
    const now = this.context?.currentTime ?? 0;
    for (const event of this.active.values()) {
      this.emitter.emit("musicEventEnd", {
        ...event,
        state: "ended",
        endedAt: event.endedAt ?? now * 1000,
      });
    }
    this.active.clear();
  }

  private cleanup(): void {
    const node = this.node;
    if (node) {
      node.port.onmessage = null;
      node.onprocessorerror = null;
      node.disconnect();
      this.node = null;
    }
    if (this.source) {
      // Disconnect only from our own node: a host-supplied source may well be
      // feeding other things, and a bare `disconnect()` would cut all of them.
      try {
        if (node) this.source.disconnect(node);
      } catch {
        /* Already disconnected, or never connected. Nothing to undo. */
      }
      this.source = null;
    }
    if (this.stream && this.ownsStream) {
      // Releasing every track is what turns the browser's recording indicator
      // back off. Disconnecting the graph alone does not.
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;
    if (this.context && this.ownsContext) {
      void this.context.close().catch(() => undefined);
    }
    this.context = null;
    this.ownsContext = false;
    this.ownsStream = false;
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

/**
 * Duck-typed rather than `instanceof AudioNode`.
 *
 * `AudioNode` is not a global outside a browser — a Node test harness that
 * stubs `AudioContext` has no such constructor — and even in a browser the
 * check fails across realms, so a node from an iframe would be mistaken for a
 * MediaStream. Having a `context` and a `connect` is what actually matters.
 */
function isAudioNode(value: MediaStream | AudioNode | undefined): value is AudioNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "context" in value &&
    typeof (value as AudioNode).connect === "function"
  );
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
