/**
 * WorkerWebAudio: state machine and error mapping, against a mocked browser.
 *
 * A real browser is the only place this can be exercised for real, so the graph
 * is mocked and the seams are pinned here instead: "denying permission surfaces
 * mic-permission-denied rather than a console throw" is exactly the kind of thing
 * that silently regresses.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTuninator, createWorkerWebAudio } from "../src/workers/web-audio.js";
import type { TuninatorError, TuninatorState } from "../src/types.js";

type MockOptions = {
  /** Rejection thrown by getUserMedia, if any. */
  micError?: { name: string };
  /** Rejection thrown by addModule, if any. */
  addModuleError?: Error;
  /** Omit audioWorklet from the AudioContext entirely. */
  noWorklet?: boolean;
  /** AudioContext starts suspended, as it does outside a user gesture. */
  suspended?: boolean;
  /** Throw when constructing the AudioContext. */
  contextError?: Error;
  /** What the (mock) device reports back through `track.getSettings()`. */
  trackChannelCount?: number;
};

const stoppedTracks: string[] = [];

/** Options the last AudioWorkletNode was constructed with. */
type NodeOptions = Record<string, unknown>;

function installMocks(options: MockOptions = {}): {
  closed: () => boolean;
  audioConstraints: () => Record<string, unknown>;
  nodeOptions: () => NodeOptions | null;
  node: () => { deliver: (data: unknown) => void } | null;
} {
  const tracks = [
    {
      kind: "audio",
      label: "Analogue 1/2 (Audient iD4)",
      stop: () => stoppedTracks.push("audio"),
      getSettings: () => ({ channelCount: options.trackChannelCount ?? 2 }),
    },
  ];
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks };

  let audioConstraints: Record<string, unknown> = {};
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async (constraints: { audio?: Record<string, unknown> }) => {
        audioConstraints = constraints.audio ?? {};
        if (options.micError) {
          const error = new Error(options.micError.name);
          error.name = options.micError.name;
          throw error;
        }
        return stream;
      }),
    },
  });

  let closed = false;
  class MockAudioContext {
    state: string;
    audioWorklet?: { addModule: (url: string | URL) => Promise<void> };

    constructor() {
      if (options.contextError) throw options.contextError;
      this.state = options.suspended ? "suspended" : "running";
      if (!options.noWorklet) {
        this.audioWorklet = {
          addModule: vi.fn(async (_url: string | URL) => {
            if (options.addModuleError) throw options.addModuleError;
          }),
        };
      }
    }

    createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
      return { connect: () => undefined, disconnect: () => undefined };
    }

    async resume(): Promise<void> {
      this.state = "running";
    }

    async close(): Promise<void> {
      closed = true;
    }
  }

  let nodeOptions: NodeOptions | null = null;
  let lastNode: MockAudioWorkletNode | null = null;
  class MockAudioWorkletNode {
    port = { postMessage: vi.fn(), onmessage: null as unknown };
    onprocessorerror: unknown = null;
    constructor(_context: unknown, _name: string, opts?: NodeOptions) {
      nodeOptions = opts ?? {};
      lastNode = this;
    }
    disconnect(): void {}
    /** Delivers a worklet -> main-thread message, as the real port would. */
    deliver(data: unknown): void {
      (this.port.onmessage as ((e: { data: unknown }) => void) | null)?.({ data });
    }
  }

  vi.stubGlobal("AudioContext", MockAudioContext);
  vi.stubGlobal("AudioWorkletNode", MockAudioWorkletNode);

  return {
    closed: () => closed,
    audioConstraints: () => audioConstraints,
    nodeOptions: () => nodeOptions,
    node: () => lastNode,
  };
}

/** Collects state transitions and errors for assertions. */
function observe(tuninator: ReturnType<typeof createTuninator>) {
  const states: TuninatorState[] = [];
  const errors: TuninatorError[] = [];
  tuninator.on("stateChange", (s) => states.push(s));
  tuninator.on("error", (e) => errors.push(e));
  return { states, errors };
}

afterEach(() => {
  vi.unstubAllGlobals();
  stoppedTracks.length = 0;
});

describe("createWorkerWebAudio", () => {
  it("is still reachable under the deprecated createTuninator name", () => {
    expect(createTuninator).toBe(createWorkerWebAudio);
  });

  it("reaches listening through starting", async () => {
    installMocks();
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    const { states, errors } = observe(tuninator);

    expect(tuninator.getState()).toBe("idle");
    await tuninator.start();

    expect(states).toEqual(["starting", "listening"]);
    expect(errors).toHaveLength(0);
    expect(tuninator.getState()).toBe("listening");
  });

  it("passes through waiting-for-user-gesture when the context is suspended", async () => {
    installMocks({ suspended: true });
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    const { states } = observe(tuninator);

    await tuninator.start();

    expect(states).toEqual(["starting", "waiting-for-user-gesture", "listening"]);
  });

  it("maps a denied permission to mic-permission-denied, without throwing", async () => {
    installMocks({ micError: { name: "NotAllowedError" } });
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    const { states, errors } = observe(tuninator);

    // The failure must surface as an event, not as a rejected promise the
    // caller has to catch.
    await expect(tuninator.start()).resolves.toBeUndefined();

    expect(states).toEqual(["starting", "error"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("mic-permission-denied");
    expect(tuninator.getState()).toBe("error");
  });

  it("maps a missing microphone to mic-unavailable", async () => {
    installMocks({ micError: { name: "NotFoundError" } });
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    const { errors } = observe(tuninator);

    await tuninator.start();
    expect(errors[0]!.code).toBe("mic-unavailable");
  });

  it("maps a missing audioWorklet to worklet-unavailable", async () => {
    installMocks({ noWorklet: true });
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    const { errors } = observe(tuninator);

    await tuninator.start();
    expect(errors[0]!.code).toBe("worklet-unavailable");
  });

  it("maps a bad workletUrl to worklet-load-failed, naming the URL", async () => {
    installMocks({ addModuleError: new Error("404") });
    const tuninator = createWorkerWebAudio({ workletUrl: "/nope/missing-worklet.js" });
    const { errors } = observe(tuninator);

    await tuninator.start();
    expect(errors[0]!.code).toBe("worklet-load-failed");
    // The message has to be actionable: this is the #1 integration failure.
    expect(errors[0]!.message).toContain("/nope/missing-worklet.js");
  });

  it("maps an AudioContext construction failure to audio-context-failed", async () => {
    installMocks({ contextError: new Error("no audio") });
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    const { errors } = observe(tuninator);

    await tuninator.start();
    expect(errors[0]!.code).toBe("audio-context-failed");
  });

  it("releases every microphone track on stop", async () => {
    const mocks = installMocks();
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    await tuninator.start();

    tuninator.stop();

    // Disconnecting the graph alone leaves the browser's recording indicator on.
    expect(stoppedTracks).toEqual(["audio"]);
    expect(mocks.closed()).toBe(true);
    expect(tuninator.getState()).toBe("idle");
  });

  it("releases the microphone even when start failed after opening it", async () => {
    installMocks({ addModuleError: new Error("404") });
    const tuninator = createWorkerWebAudio({ workletUrl: "/bad.js" });

    await tuninator.start();

    // The mic was already open when addModule rejected. Leaving it live would
    // keep the recording indicator on with nothing listening.
    expect(stoppedTracks).toEqual(["audio"]);
  });

  it("setMode posts the new policy without restarting the audio graph", async () => {
    installMocks();
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    const { states } = observe(tuninator);
    await tuninator.start();
    states.length = 0;

    tuninator.setMode("chords");

    expect(tuninator.getMode()).toBe("chords");
    // No state churn at all: no restart, no re-permission, no gap in audio.
    expect(states).toEqual([]);
    expect(tuninator.getState()).toBe("listening");
  });

  it("on() returns an unsubscribe function", async () => {
    installMocks();
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });

    const seen: TuninatorState[] = [];
    const off = tuninator.on("stateChange", (s) => seen.push(s));
    off();

    await tuninator.start();
    expect(seen).toEqual([]);
  });

  it("reports no active events before anything has been detected", async () => {
    installMocks();
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    await tuninator.start();
    expect(tuninator.getActiveEvents()).toEqual([]);
  });
});

/**
 * The stereo path.
 *
 * Analysis input is mono, and choosing the channel belongs to the host. These
 * assertions pin the seam: what the worker asks the browser for, what it passes
 * to the worklet, and that a host-supplied graph is used untouched.
 */
describe("input channels", () => {
  it("asks getUserMedia for one channel by default", async () => {
    const mocks = installMocks();
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    await tuninator.start();

    // The worker does not choose channels, so it does not ask for channels it
    // would have to choose between. A host that wants to split asks for more.
    expect(mocks.audioConstraints()["channelCount"]).toBe(1);
  });

  it("requests the channel count as ideal, never exact", async () => {
    const mocks = installMocks();
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    await tuninator.start();

    // `{ exact: 2 }` would turn every genuinely mono microphone into an
    // OverconstrainedError, i.e. `mic-unavailable`.
    expect(mocks.audioConstraints()["channelCount"]).not.toHaveProperty("exact");
  });

  it("lets input.channelCount override the request", async () => {
    const mocks = installMocks();
    const tuninator = createWorkerWebAudio({
      workletUrl: "/assets/tuninator-worklet.js",
      input: { channelCount: 2 },
    });
    await tuninator.start();

    // How a host reaches input 2 of a 2-in interface: ask for both here, split
    // the result, and hand one channel back as `input.source`.
    expect(mocks.audioConstraints()["channelCount"]).toBe(2);
  });

  it("leaves the worklet node in the channel mode that preserves every channel", async () => {
    const mocks = installMocks();
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    await tuninator.start();

    const options = mocks.nodeOptions();
    // "max" carries as many channels as the source has, with no mixing.
    // "explicit" + channelCount 1 would downmix; "discrete" would make any
    // downmix discard the extra channels outright.
    expect(options?.["channelCountMode"]).toBe("max");
    expect(options?.["channelInterpretation"]).toBe("speakers");
    expect(options).not.toHaveProperty("channelCount");
  });

  it("sends the worklet a policy and nothing about channels", async () => {
    const mocks = installMocks();
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    await tuninator.start();

    const processorOptions = mocks.nodeOptions()?.["processorOptions"] as
      | Record<string, unknown>
      | undefined;
    expect(processorOptions).toHaveProperty("policy");
    // Channel routing is the host's, and the library carries no opinion about
    // it across the port.
    expect(processorOptions).not.toHaveProperty("channels");
  });

  it("reports the device and its channel count as a status message", async () => {
    installMocks({ trackChannelCount: 2 });
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    const statuses: string[] = [];
    tuninator.on("status", (message) => statuses.push(message));

    await tuninator.start();

    // Without this the failure is invisible: a mono capture and a correctly
    // working stereo capture look identical from the outside.
    expect(statuses.some((s) => s.includes("Audient iD4") && s.includes("2 channel(s)"))).toBe(true);
  });

  it("still reports a status when the mono fallback is what the browser gave", async () => {
    installMocks({ trackChannelCount: 1 });
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    const statuses: string[] = [];
    tuninator.on("status", (message) => statuses.push(message));

    await tuninator.start();

    expect(statuses.some((s) => s.includes("1 channel(s)"))).toBe(true);
  });
});

/*
 * A host that wires its own graph.
 *
 * This is how channel choice leaves the library: the host opens the device,
 * splits it, and connects the one channel it wants. The worker must then touch
 * neither the microphone nor the host's AudioContext -- it did not open them,
 * and closing them would silence the rest of the host's application.
 */
describe("host-supplied input", () => {
  /** A stand-in AudioNode: has a context and connects, which is all that matters. */
  function fakeNode(context: unknown): AudioNode {
    return {
      context,
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as AudioNode;
  }

  it("never opens a microphone when given an AudioNode", async () => {
    const mocks = installMocks();
    const context = new (globalThis as unknown as { AudioContext: new () => unknown }).AudioContext();
    const node = fakeNode(context);

    const tuninator = createWorkerWebAudio({
      workletUrl: "/assets/tuninator-worklet.js",
      input: { source: node },
    });
    await tuninator.start();

    expect(tuninator.getState()).toBe("listening");
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    // Reused, not replaced: nodes cannot cross AudioContexts.
    expect(node.connect).toHaveBeenCalled();
    expect(mocks.closed()).toBe(false);
  });

  it("does not close a context it did not create", async () => {
    const mocks = installMocks();
    const context = new (globalThis as unknown as { AudioContext: new () => unknown }).AudioContext();
    const tuninator = createWorkerWebAudio({
      workletUrl: "/assets/tuninator-worklet.js",
      input: { source: fakeNode(context) },
    });

    await tuninator.start();
    tuninator.stop();

    expect(mocks.closed()).toBe(false);
    expect(stoppedTracks).toHaveLength(0);
  });

  it("closes the context it created itself", async () => {
    const mocks = installMocks();
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });

    await tuninator.start();
    tuninator.stop();

    expect(mocks.closed()).toBe(true);
    expect(stoppedTracks).toEqual(["audio"]);
  });

  it("does not stop tracks of a host-supplied MediaStream", async () => {
    installMocks();
    const tracks = [{ kind: "audio", stop: () => stoppedTracks.push("host") }];
    const stream = {
      getTracks: () => tracks,
      getAudioTracks: () => tracks,
    } as unknown as MediaStream;

    const tuninator = createWorkerWebAudio({
      workletUrl: "/assets/tuninator-worklet.js",
      input: { source: stream },
    });
    await tuninator.start();
    tuninator.stop();

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(stoppedTracks).toHaveLength(0);
  });
});

describe("stop", () => {
  /** The shape handleWorkletMessage expects, trimmed to what it reads. */
  function hop(type: "start" | "update" | "end", id: string): unknown {
    return {
      type: "hop",
      frame: { timestamp: 0, frequencyHz: null, confidence: 0, nearest: null,
               amplitude: { rms: 0 }, detector: {} },
      emissions: [
        { type, event: { id, label: { name: "A4" }, state: "sustain", endedAt: null } },
      ],
    };
  }

  it("ends events that were still sounding", async () => {
    const mocks = installMocks();
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    const ended: string[] = [];
    tuninator.on("musicEventEnd", (event) => ended.push(event.id));

    await tuninator.start();
    mocks.node()!.deliver(hop("start", "ev1"));
    expect(tuninator.getActiveEvents()).toHaveLength(1);

    tuninator.stop();

    // Posting `reset` to the worklet flushes ITS tracker, but the reply is
    // asynchronous and stop() detaches the port on this very tick -- so without
    // ending them here, a consumer holding state from musicEventStart would
    // hold it forever.
    expect(ended).toEqual(["ev1"]);
    expect(tuninator.getActiveEvents()).toHaveLength(0);
  });

  it("does not invent ends for events that already finished", async () => {
    const mocks = installMocks();
    const tuninator = createWorkerWebAudio({ workletUrl: "/assets/tuninator-worklet.js" });
    const ended: string[] = [];
    tuninator.on("musicEventEnd", (event) => ended.push(event.id));

    await tuninator.start();
    mocks.node()!.deliver(hop("start", "ev1"));
    mocks.node()!.deliver(hop("end", "ev1"));
    expect(ended).toEqual(["ev1"]);

    tuninator.stop();
    expect(ended).toEqual(["ev1"]);
  });
});
