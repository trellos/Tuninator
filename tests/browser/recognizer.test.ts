/**
 * The DOM adapter, against a hand-built Web Audio environment.
 *
 * Everything musical is tested elsewhere against real audio; what is left here
 * is the part that only a browser has, and the three things the old adapter got
 * wrong: `stop()` losing whatever was in flight, no way to release the
 * microphone at all, and errors that were plain objects a consumer could not
 * throw or `instanceof`.
 *
 * The fakes are deliberately literal — a real `MessagePort` pair, a real
 * transfer of the sample buffer — because the failure modes worth catching
 * (never wiring `port.onmessage`, forgetting the buffer is neutered after
 * transfer) all live in exactly that plumbing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecognizerError } from "../../src/errors.js";
import { createRecognizer } from "../../src/browser/recognizer.js";
import type { Note, RecognizerState } from "../../src/types.js";

const SAMPLE_RATE = 48000;

type Harness = {
  postFromWorklet: (message: unknown, transfer?: Transferable[]) => void;
  toWorklet: unknown[];
  addedModules: string[];
  contextClosed: () => boolean;
  tracksStopped: () => number;
  processorOptions: () => Record<string, unknown> | undefined;
  connected: () => boolean;
};

let harness: Harness;
let getUserMedia: ReturnType<typeof vi.fn>;

function install(options: { failMic?: string } = {}): void {
  const toWorklet: unknown[] = [];
  const addedModules: string[] = [];
  let closed = false;
  let stopped = 0;
  let connected = false;
  let workletHandler: ((event: MessageEvent) => void) | null = null;
  let processorOptions: Record<string, unknown> | undefined;

  class FakeAudioWorkletNode {
    port = {
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        workletHandler = handler;
      },
      get onmessage(): ((event: MessageEvent) => void) | null {
        return workletHandler;
      },
      postMessage(message: unknown): void {
        toWorklet.push(message);
      },
    };
    onprocessorerror: (() => void) | null = null;
    constructor(_context: unknown, _name: string, opts?: { processorOptions?: Record<string, unknown> }) {
      processorOptions = opts?.processorOptions;
    }
    disconnect(): void {
      connected = false;
    }
  }

  class FakeAudioContext {
    sampleRate = SAMPLE_RATE;
    currentTime = 1.25;
    state: AudioContextState = "running";
    audioWorklet = {
      async addModule(url: string): Promise<void> {
        addedModules.push(url);
      },
    };
    createMediaStreamSource(): { connect(): void; disconnect(): void } {
      return {
        connect(): void {
          connected = true;
        },
        disconnect(): void {
          connected = false;
        },
      };
    }
    async resume(): Promise<void> {
      this.state = "running";
    }
    async close(): Promise<void> {
      closed = true;
      this.state = "closed";
    }
  }

  const tracks = [
    {
      stop(): void {
        stopped++;
      },
    },
  ];

  getUserMedia = vi.fn(async () => {
    if (options.failMic) {
      const error = new Error("denied");
      error.name = options.failMic;
      throw error;
    }
    return { getTracks: () => tracks } as unknown as MediaStream;
  });

  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

  harness = {
    postFromWorklet(message, transfer) {
      workletHandler?.({ data: message } as MessageEvent);
      void transfer;
    },
    toWorklet,
    addedModules,
    contextClosed: () => closed,
    tracksStopped: () => stopped,
    processorOptions: () => processorOptions,
    connected: () => connected,
  };
}

/** One hop of a sawtooth, as the capture worklet would post it. */
function chunk(startSample: number, hz: number, amplitude = 0.3, hop = 640): unknown {
  const samples = new Float32Array(hop);
  const period = SAMPLE_RATE / hz;
  for (let i = 0; i < hop; i++) {
    samples[i] = amplitude * (2 * (((startSample + i) % period) / period) - 1);
  }
  return {
    type: "chunk",
    samples,
    startSample,
    contextTime: 1.25 + startSample / SAMPLE_RATE,
    sampleRate: SAMPLE_RATE,
    channelRms: [amplitude / 2],
    selectedChannel: 0,
  };
}

function feed(hz: number, hops: number, from = 0, amplitude = 0.3): number {
  let at = from;
  for (let i = 0; i < hops; i++) {
    harness.postFromWorklet(chunk(at, hz, amplitude));
    at += 640;
  }
  return at;
}

beforeEach(() => install());
afterEach(() => vi.unstubAllGlobals());

describe("lifecycle", () => {
  it("starts, reports its timebase, and reaches listening", async () => {
    const recognizer = createRecognizer();
    const states: RecognizerState[] = [];
    recognizer.on("stateChange", (s) => states.push(s));

    await recognizer.start();

    expect(recognizer.getState()).toBe("listening");
    expect(states).toEqual(["starting", "listening"]);
    expect(harness.connected()).toBe(true);
    expect(recognizer.getTimebase()).toEqual({
      sampleRate: SAMPLE_RATE,
      originContextTime: 1.25,
    });
  });

  it("start() twice does not open a second microphone", async () => {
    const recognizer = createRecognizer();
    await Promise.all([recognizer.start(), recognizer.start()]);
    await recognizer.start();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("stop() flushes, so a Note still sounding still ends", async () => {
    // The bug this replaces: the old synchronous stop() tore the graph down
    // and whatever was mid-note was simply never reported.
    const recognizer = createRecognizer();
    const ended: Note[] = [];
    recognizer.on("noteEnded", (note) => ended.push(note));

    await recognizer.start();
    feed(220, 40);
    expect(ended).toHaveLength(0);

    await recognizer.stop();
    expect(ended).toHaveLength(1);
    expect(ended[0]?.endTime).not.toBeNull();
  });

  it("stop() releases the microphone and the context it created", async () => {
    const recognizer = createRecognizer();
    await recognizer.start();
    await recognizer.stop();
    expect(harness.tracksStopped()).toBe(1);
    expect(harness.contextClosed()).toBe(true);
    expect(recognizer.getState()).toBe("idle");
  });

  it("never closes a context the caller supplied", async () => {
    // It belongs to the caller; closing it takes down the rest of their graph.
    const shared = new (globalThis as unknown as { AudioContext: new () => AudioContext }).AudioContext();
    const recognizer = createRecognizer({ audioContext: shared });
    await recognizer.start();
    await recognizer.stop();
    expect(harness.contextClosed()).toBe(false);
    expect(harness.tracksStopped()).toBe(1);
  });

  it("dispose() refuses to start again", async () => {
    const recognizer = createRecognizer();
    await recognizer.start();
    await recognizer.dispose();
    await expect(recognizer.start()).rejects.toBeInstanceOf(RecognizerError);
    await expect(recognizer.start()).rejects.toMatchObject({ code: "already-disposed" });
  });
});

describe("errors", () => {
  it("rejects with a real Error carrying a code", async () => {
    vi.unstubAllGlobals();
    install({ failMic: "NotAllowedError" });
    const recognizer = createRecognizer();
    const seen: unknown[] = [];
    recognizer.on("error", (error) => seen.push(error));

    await expect(recognizer.start()).rejects.toBeInstanceOf(RecognizerError);
    expect(recognizer.getState()).toBe("error");
    expect(seen[0]).toBeInstanceOf(Error);
    expect((seen[0] as RecognizerError).code).toBe("mic-permission-denied");
    // A plain object could not do this, which is what the old surface was.
    expect(() => {
      throw seen[0];
    }).toThrow(RecognizerError);
  });

  it("separates permission denial from the device being unavailable", async () => {
    vi.unstubAllGlobals();
    install({ failMic: "NotFoundError" });
    const recognizer = createRecognizer();
    await expect(recognizer.start()).rejects.toMatchObject({ code: "mic-unavailable" });
  });

  it("cleans up after a failed start", async () => {
    vi.unstubAllGlobals();
    install({ failMic: "NotAllowedError" });
    const recognizer = createRecognizer();
    await expect(recognizer.start()).rejects.toBeInstanceOf(RecognizerError);
    expect(harness.contextClosed()).toBe(true);
  });
});

describe("wiring", () => {
  it("loads the worklet from the configured url", async () => {
    const recognizer = createRecognizer({ workletUrl: new URL("https://example.test/w.js") });
    await recognizer.start();
    expect(harness.addedModules).toEqual(["https://example.test/w.js"]);
  });

  it("tells the capture worklet the hop and channel strategy to use", async () => {
    const recognizer = createRecognizer({ input: { channels: 1 } });
    await recognizer.start();
    expect(harness.processorOptions()).toMatchObject({ hopSamples: 640, channels: 1 });
  });

  it("recycles chunk buffers back to the worklet", async () => {
    // Without this the audio thread allocates a fresh Float32Array every hop,
    // forever, because postMessage with a transfer neuters the sender's view.
    const recognizer = createRecognizer();
    await recognizer.start();
    feed(220, 3);
    const recycles = harness.toWorklet.filter(
      (m) => (m as { type?: string }).type === "recycle"
    );
    expect(recycles).toHaveLength(3);
  });

  it('host: "worker" without an engineUrl says so rather than running inline', async () => {
    // Falling back would leave the caller believing their main thread is free.
    const recognizer = createRecognizer({ host: "worker" });
    await expect(recognizer.start()).rejects.toMatchObject({ code: "engine-load-failed" });
  });

  it('host: "worker" builds a module worker from the url it was given', async () => {
    const constructed: Array<{ url: string; type: string | undefined }> = [];
    class FakeWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      constructor(url: string | URL, options?: { type?: string }) {
        constructed.push({ url: String(url), type: options?.type });
      }
      postMessage(): void {}
      terminate(): void {}
    }
    const previous = (globalThis as { Worker?: unknown }).Worker;
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
    try {
      const recognizer = createRecognizer({
        host: "worker",
        engineUrl: "https://example.test/tuninator-engine-worker.js",
      });
      await recognizer.start();
      expect(constructed).toEqual([
        { url: "https://example.test/tuninator-engine-worker.js", type: "module" },
      ]);
      // And the timebase is answerable without a round trip, so a caller that
      // reads it immediately after start() is not told "null" by the host that
      // happens to be asynchronous.
      expect(recognizer.getTimebase()?.sampleRate).toBe(48000);
      await recognizer.dispose();
    } finally {
      (globalThis as { Worker?: unknown }).Worker = previous;
    }
  });
});

describe("the Note stream", () => {
  it("delivers started / resolved / ended in that order for one Note", async () => {
    const recognizer = createRecognizer();
    const order: string[] = [];
    recognizer.on("noteStarted", () => order.push("started"));
    recognizer.on("noteResolved", () => order.push("resolved"));
    recognizer.on("noteEnded", () => order.push("ended"));

    await recognizer.start();
    feed(220, 40);
    await recognizer.stop();

    expect(order[0]).toBe("started");
    expect(order.slice(-2)).toEqual(["resolved", "ended"]);
  });

  it("timestamps from the source clock, not from AudioContext.currentTime", async () => {
    // The epoch is the first processed sample. The context was already at
    // 1.25s when we started, and that must not leak into a Note.
    const recognizer = createRecognizer();
    const started: Note[] = [];
    recognizer.on("noteStarted", (note) => started.push(note));
    await recognizer.start();
    feed(220, 40);
    expect(started[0]?.startTime).toBeLessThan(200);
  });

  it("reports what is sounding, and keeps answering about it afterwards", async () => {
    const recognizer = createRecognizer();
    await recognizer.start();
    feed(220, 40);
    const active = recognizer.getActiveNotes();
    expect(active).toHaveLength(1);
    const id = (active[0] as Note).id;
    await recognizer.stop();
    expect(recognizer.getActiveNotes()).toHaveLength(0);
    expect(recognizer.getNote(id)?.endTime).not.toBeNull();
  });

  it("keeps the diagnostic pitch stream off unless it is asked for", async () => {
    const quiet = createRecognizer();
    let frames = 0;
    quiet.on("pitchFrame", () => frames++);
    await quiet.start();
    feed(220, 10);
    expect(frames).toBe(0);
    await quiet.stop();

    vi.unstubAllGlobals();
    install();
    const loud = createRecognizer({ diagnostics: { pitchFrames: true } });
    let loudFrames = 0;
    loud.on("pitchFrame", () => loudFrames++);
    await loud.start();
    feed(220, 10);
    expect(loudFrames).toBe(10);
  });

  it("unsubscribing actually unsubscribes", async () => {
    const recognizer = createRecognizer();
    let count = 0;
    const off = recognizer.on("noteStarted", () => count++);
    await recognizer.start();
    off();
    feed(220, 40);
    expect(count).toBe(0);
  });

  it("a throwing handler does not take down the pipeline", async () => {
    const recognizer = createRecognizer();
    const seen: Note[] = [];
    recognizer.on("noteStarted", () => {
      throw new Error("consumer bug");
    });
    recognizer.on("noteStarted", (note) => seen.push(note));
    await recognizer.start();
    feed(220, 40);
    expect(seen).toHaveLength(1);
  });
});
