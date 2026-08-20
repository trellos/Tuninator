/**
 * The engine, running in a Web Worker.
 *
 * Built as its own bundle (`dist/tuninator-engine-worker.js`) and loaded by
 * `WorkerEngineHost`. Everything here is relay: construct a `RecognitionEngine`,
 * feed it the hops the capture worklet produced, post back what it produced.
 * No decision about a Note is taken on this side of the port that would not be
 * taken on the other, which is the property the two hosts exist to preserve.
 *
 * Not part of `src/engine/` and deliberately so: this file knows about
 * `postMessage` and a worker global, and the engine must not.
 */

import type { EngineConfig } from "../engine/config.js";
import { RecognitionEngine } from "../engine/engine.js";
import type { TrackerEmission } from "../engine/tracker/note-tracker.js";
import type { PitchFrame, SourceTimeMs } from "../types.js";

/** Host -> worker. */
export type EngineWorkerCommand =
  | {
      type: "init";
      sampleRate: number;
      config: EngineConfig;
      originContextTime?: number;
    }
  | { type: "push"; samples: Float32Array; startSample: number }
  | { type: "flush"; id: number }
  | { type: "dispose" };

/** Worker -> host. */
export type EngineWorkerMessage =
  | {
      type: "output";
      emissions: TrackerEmission[];
      frames: PitchFrame[];
      /** The engine's source clock after this chunk, so the host can mirror it. */
      now: SourceTimeMs;
    }
  /**
   * The buffer the host transferred, handed straight back.
   *
   * The capture worklet allocates from a pool and the audio thread must never
   * allocate in steady state, so a buffer transferred into the worker has to
   * make the whole round trip rather than being dropped here.
   */
  | { type: "recycle"; buffer: ArrayBuffer }
  | { type: "flushed"; id: number }
  | { type: "error"; message: string };

/**
 * Wire one worker-like scope to a fresh engine.
 *
 * Split out from the module's own side effect so it can be driven by a fake
 * port in a test. `self` in an actual worker is the port.
 */
export function serveEngine(port: {
  postMessage: (message: EngineWorkerMessage, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<EngineWorkerCommand>) => void) | null;
}): void {
  let engine: RecognitionEngine | null = null;

  const fail = (error: unknown): void => {
    port.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  };

  port.onmessage = (event: MessageEvent<EngineWorkerCommand>): void => {
    const command = event.data;
    try {
      switch (command.type) {
        case "init":
          engine = new RecognitionEngine(
            command.sampleRate,
            command.config,
            command.originContextTime
          );
          return;
        case "push": {
          if (engine === null) return;
          const result = engine.processChunk(command.samples, command.startSample);
          port.postMessage({
            type: "output",
            emissions: result.emissions,
            frames: result.frames,
            now: engine.now,
          });
          const buffer = command.samples.buffer as ArrayBuffer;
          port.postMessage({ type: "recycle", buffer }, [buffer]);
          return;
        }
        case "flush": {
          if (engine !== null) {
            const result = engine.flush();
            port.postMessage({
              type: "output",
              emissions: result.emissions,
              frames: result.frames,
              now: engine.now,
            });
          }
          port.postMessage({ type: "flushed", id: command.id });
          return;
        }
        case "dispose":
          engine = null;
          return;
      }
    } catch (error) {
      fail(error);
    }
  };
}

// The module's reason for existing.
//
// Guarded on the absence of a `document` rather than the presence of a worker
// global, because that is the property that actually matters: importing this
// file from a test, or from the main bundle by accident, must not hijack the
// page's own message channel. A worker has no document; a page always does.
const scope = globalThis as unknown as {
  document?: unknown;
  postMessage?: (message: EngineWorkerMessage, transfer?: Transferable[]) => void;
  onmessage?: ((event: MessageEvent<EngineWorkerCommand>) => void) | null;
};

if (scope.document === undefined && typeof scope.postMessage === "function") {
  serveEngine(
    scope as {
      postMessage: (message: EngineWorkerMessage, transfer?: Transferable[]) => void;
      onmessage: ((event: MessageEvent<EngineWorkerCommand>) => void) | null;
    }
  );
}
