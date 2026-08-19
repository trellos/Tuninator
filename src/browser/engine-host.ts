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
 * Placeholder for the worker host.
 *
 * The protocol is already the one `EnginePort` describes, so this is pure
 * plumbing — a worker bundle whose entry constructs a `RecognitionEngine` and
 * relays the same three messages. It is not wired up yet, and saying so is
 * better than shipping a host that silently falls back to inline while the
 * caller believes their main thread is free.
 */
export function createWorkerHost(): never {
  throw new RecognizerError(
    "engine-load-failed",
    'host: "worker" is not available in this build; use the default host: "inline"'
  );
}
