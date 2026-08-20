/**
 * Where the recognition engine runs, behind one port-shaped interface.
 *
 * The engine is host-agnostic by construction, so "on the main thread" and "in
 * a Web Worker" differ only in how chunks get to it and how emissions come
 * back. `EnginePort` is that difference, and nothing above it can tell which
 * one it has — which is the point: moving the engine off the main thread must
 * never change a Note, a timestamp, or an event ordering.
 *
 * The inline host is the default because it is strictly simpler and the work is
 * small: one fast hop is a few hundred microseconds, and the deep lane is
 * budgeted and droppable. The worker host exists for applications that already
 * have a busy main thread.
 */

import type { Note, PitchFrame, SourceTimeMs, Timebase } from "../types.js";
import type { EngineConfig } from "../engine/config.js";
import { RecognitionEngine } from "../engine/engine.js";
import type { TrackerEmission } from "../engine/tracker/note-tracker.js";
import { RecognizerError } from "../errors.js";
import type { EngineWorkerCommand, EngineWorkerMessage } from "./engine-worker-entry.js";

/** How many just-ended Notes the worker host keeps answerable by `getNote`. */
const RECENT_NOTES = 64;

/**
 * Longest `stop()` will wait for a worker to acknowledge its final flush, ms.
 *
 * A flush is a round trip, and a worker that has died — or never came up —
 * answers nothing. Without a bound, `stop()` and `dispose()` would never
 * settle, which is precisely the failure the old `stop(): void` had and the
 * async signature exists to fix. Generous against a real round trip, which is
 * sub-millisecond, and short against a human waiting for a button.
 */
const FLUSH_TIMEOUT_MS = 250;

export type EngineOutbound = {
  emissions: TrackerEmission[];
  frames: PitchFrame[];
};

/**
 * The engine as the browser adapter sees it.
 *
 * Deliberately push/pull rather than event-driven: the inline host answers
 * synchronously and a worker host answers later, and making both look
 * asynchronous is what keeps the adapter free of `if (worker)`.
 */
export interface EnginePort {
  /** Feed one captured hop. */
  push(samples: Float32Array, startSample: number): void;
  /** End every open Note. */
  flush(): Promise<void>;
  /** Subscribe to everything the engine produces. */
  onOutput(handler: (output: EngineOutbound) => void): void;
  getActiveNotes(): Note[];
  getNote(id: string): Note | undefined;
  getTimebase(): Timebase | null;
  now(): SourceTimeMs;
  /** Returns a drained buffer to whoever owns the pool, if anyone does. */
  onRecycle(handler: (buffer: ArrayBuffer) => void): void;
  dispose(): Promise<void>;
}

/** The engine on the main thread. Chunks arrive and are processed inline. */
export class InlineEngineHost implements EnginePort {
  private readonly engine: RecognitionEngine;
  private output: ((output: EngineOutbound) => void) | null = null;
  private recycle: ((buffer: ArrayBuffer) => void) | null = null;
  private disposed = false;

  constructor(sampleRate: number, config: EngineConfig, originContextTime?: number) {
    this.engine = new RecognitionEngine(sampleRate, config, originContextTime);
  }

  push(samples: Float32Array, startSample: number): void {
    if (this.disposed) return;
    const result = this.engine.processChunk(samples, startSample);
    this.output?.({ emissions: result.emissions, frames: result.frames });
    // The capture worklet transferred this buffer away; hand it back so the
    // audio thread's pool never has to allocate in steady state.
    this.recycle?.(samples.buffer as ArrayBuffer);
  }

  async flush(): Promise<void> {
    if (this.disposed) return;
    const result = this.engine.flush();
    this.output?.({ emissions: result.emissions, frames: result.frames });
  }

  onOutput(handler: (output: EngineOutbound) => void): void {
    this.output = handler;
  }

  onRecycle(handler: (buffer: ArrayBuffer) => void): void {
    this.recycle = handler;
  }

  getActiveNotes(): Note[] {
    return this.engine.getActiveNotes();
  }

  getNote(id: string): Note | undefined {
    return this.engine.getNote(id);
  }

  getTimebase(): Timebase {
    return this.engine.getTimebase();
  }

  now(): SourceTimeMs {
    return this.engine.now;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.output = null;
    this.recycle = null;
  }
}

/**
 * The engine in a Web Worker.
 *
 * `EnginePort` is synchronous on four of its methods and a worker cannot be, so
 * this host keeps a main-thread MIRROR of the answers rather than asking: the
 * emission stream already carries every Note snapshot the engine produces, so
 * `getActiveNotes` and `getNote` are reads of what the worker last said, and
 * `getTimebase` is arithmetic the host can do itself. The mirror can only ever
 * lag the worker by one message, which is the same staleness a caller already
 * accepts from a snapshot — `Note.revisionNumber` is how it is checked.
 *
 * Nothing needs to await the worker's readiness: `postMessage` delivers in
 * order, so `init` is always processed before the first hop that follows it,
 * and a host the caller never asked to be asynchronous never becomes so.
 */
export class WorkerEngineHost implements EnginePort {
  private readonly worker: Worker;
  private readonly sampleRate: number;
  private readonly originContextTime: number | undefined;
  private readonly active = new Map<string, Note>();
  /** Recently-ended Notes, so `getNote` answers for a Note that just finished. */
  private readonly recent: Note[] = [];
  private readonly flushes = new Map<number, () => void>();
  private output: ((output: EngineOutbound) => void) | null = null;
  private recycle: ((buffer: ArrayBuffer) => void) | null = null;
  private sourceNow: SourceTimeMs = 0;
  private nextFlushId = 1;
  private disposed = false;

  constructor(
    engineUrl: string | URL,
    sampleRate: number,
    config: EngineConfig,
    originContextTime?: number
  ) {
    this.sampleRate = sampleRate;
    this.originContextTime = originContextTime;
    try {
      this.worker = new Worker(engineUrl, { type: "module" });
    } catch (error) {
      throw new RecognizerError(
        "engine-load-failed",
        `the engine worker at ${String(engineUrl)} could not be created`,
        error
      );
    }
    this.worker.onmessage = (event: MessageEvent<EngineWorkerMessage>): void => {
      this.receive(event.data);
    };
    this.worker.onerror = (): void => {
      // Nothing here can recover a dead worker, and silently continuing would
      // leave a recognizer that reports "listening" and never emits a Note.
      this.disposed = true;
    };
    this.worker.postMessage({
      type: "init",
      sampleRate,
      config,
      originContextTime,
    } satisfies EngineWorkerCommand);
  }

  private receive(message: EngineWorkerMessage): void {
    switch (message.type) {
      case "output":
        this.sourceNow = message.now;
        for (const emission of message.emissions) this.mirror(emission);
        this.output?.({ emissions: message.emissions, frames: message.frames });
        return;
      case "recycle":
        this.recycle?.(message.buffer);
        return;
      case "flushed": {
        const resolve = this.flushes.get(message.id);
        this.flushes.delete(message.id);
        resolve?.();
        return;
      }
      case "error":
        this.disposed = true;
        return;
    }
  }

  /** Keep the main-thread view of the Note timeline in step with the worker. */
  private mirror(emission: TrackerEmission): void {
    if (emission.type === "ended") {
      this.active.delete(emission.note.id);
      this.recent.push(emission.note);
      if (this.recent.length > RECENT_NOTES) this.recent.shift();
      return;
    }
    this.active.set(emission.note.id, emission.note);
  }

  push(samples: Float32Array, startSample: number): void {
    if (this.disposed) return;
    const buffer = samples.buffer as ArrayBuffer;
    this.worker.postMessage({ type: "push", samples, startSample } satisfies EngineWorkerCommand, [
      buffer,
    ]);
  }

  async flush(): Promise<void> {
    if (this.disposed) return;
    const id = this.nextFlushId++;
    await new Promise<void>((resolve) => {
      const settle = (): void => {
        clearTimeout(timer);
        this.flushes.delete(id);
        resolve();
      };
      const timer = setTimeout(settle, FLUSH_TIMEOUT_MS);
      this.flushes.set(id, settle);
      this.worker.postMessage({ type: "flush", id } satisfies EngineWorkerCommand);
    });
  }

  onOutput(handler: (output: EngineOutbound) => void): void {
    this.output = handler;
  }

  onRecycle(handler: (buffer: ArrayBuffer) => void): void {
    this.recycle = handler;
  }

  getActiveNotes(): Note[] {
    return [...this.active.values()];
  }

  getNote(id: string): Note | undefined {
    return this.active.get(id) ?? this.recent.find((note) => note.id === id);
  }

  getTimebase(): Timebase {
    return { sampleRate: this.sampleRate, originContextTime: this.originContextTime };
  }

  now(): SourceTimeMs {
    return this.sourceNow;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.output = null;
    this.recycle = null;
    for (const resolve of this.flushes.values()) resolve();
    this.flushes.clear();
    this.worker.postMessage({ type: "dispose" } satisfies EngineWorkerCommand);
    this.worker.terminate();
  }
}

/**
 * Build the host the options asked for.
 *
 * `host: "worker"` needs a URL for the built worker bundle, for the same reason
 * `workletUrl` exists: a bundler decides where the asset lands and the library
 * cannot guess it. Saying so is better than silently falling back to inline
 * while the caller believes their main thread is free.
 */
export function createWorkerHost(
  engineUrl: string | URL | undefined,
  sampleRate: number,
  config: EngineConfig,
  originContextTime?: number
): EnginePort {
  if (engineUrl === undefined) {
    throw new RecognizerError(
      "engine-load-failed",
      'host: "worker" needs options.engineUrl - the URL of the built ' +
        "tuninator-engine-worker.js, e.g. " +
        'new URL("tuninator/engine-worker", import.meta.url)'
    );
  }
  if (typeof Worker === "undefined") {
    throw new RecognizerError(
      "engine-load-failed",
      'this environment has no Worker constructor; use the default host: "inline"'
    );
  }
  return new WorkerEngineHost(engineUrl, sampleRate, config, originContextTime);
}
