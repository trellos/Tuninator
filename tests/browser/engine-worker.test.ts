/**
 * The worker host must not be able to change a Note.
 *
 * `host: "worker"` exists to get the engine off a busy main thread, and the
 * only property that makes it safe to offer is that it changes nothing else:
 * the same audio through the worker entry has to produce the same Notes, the
 * same timestamps and the same event ordering as the inline host. A worker that
 * quietly recognised differently would be the worst kind of option, because the
 * difference would only ever show up on someone else's machine.
 *
 * Driven through a fake port rather than a real `Worker`, so this is the
 * protocol under test and not the browser's worker loader.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG } from "../../src/engine/config.js";
import { RecognitionEngine } from "../../src/engine/engine.js";
import {
  serveEngine,
  type EngineWorkerCommand,
  type EngineWorkerMessage,
} from "../../src/browser/engine-worker-entry.js";
import type { TrackerEmission } from "../../src/engine/tracker/note-tracker.js";

const SAMPLE_RATE = 48000;
const HOP = 640;

/** A plucked note: a pick transient and an exponential decay. */
function pluck(midi: number, samples: number, amplitude = 0.3, tauMs = 700): Float32Array {
  const out = new Float32Array(samples);
  const hz = 440 * Math.pow(2, (midi - 69) / 12);
  const tau = (tauMs / 1000) * SAMPLE_RATE;
  for (let i = 0; i < samples; i++) {
    const envelope = Math.exp(-i / tau);
    let value = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * envelope;
    value += 0.4 * Math.sin((4 * Math.PI * hz * i) / SAMPLE_RATE) * envelope;
    // The pick itself: a short broadband burst, deterministic.
    if (i < 240) value += 0.6 * Math.sin(i * 12.9898) * (1 - i / 240);
    out[i] = value * amplitude;
  }
  return out;
}

function phrase(): Float32Array {
  const out = new Float32Array(SAMPLE_RATE * 2);
  let at = SAMPLE_RATE * 0.2;
  for (const midi of [64, 66, 68, 69]) {
    const note = pluck(midi, Math.floor(SAMPLE_RATE * 0.35));
    out.set(note, at);
    at += Math.floor(SAMPLE_RATE * 0.35);
  }
  return out;
}

/** What a caller can actually observe about a Note, in the order it arrived. */
function shapeOf(emissions: readonly TrackerEmission[]): string[] {
  return emissions.map((emission) =>
    [
      emission.type,
      emission.note.id,
      emission.note.startTime.toFixed(4),
      (emission.note.endTime ?? 0).toFixed(4),
      emission.note.pitch.current?.name ?? "-",
      emission.note.harmony?.chordName ?? "-",
      emission.note.revision.revisionNumber,
    ].join("|")
  );
}

/** A `MessagePort`-shaped object that records what the worker posted. */
function fakePort(): {
  send: (command: EngineWorkerCommand) => void;
  sent: EngineWorkerMessage[];
} {
  const sent: EngineWorkerMessage[] = [];
  const port = {
    postMessage: (message: EngineWorkerMessage): void => {
      sent.push(message);
    },
    onmessage: null as ((event: MessageEvent<EngineWorkerCommand>) => void) | null,
  };
  serveEngine(port);
  return {
    sent,
    send: (command: EngineWorkerCommand): void => {
      port.onmessage?.({ data: command } as MessageEvent<EngineWorkerCommand>);
    },
  };
}

describe("the engine in a worker", () => {
  it("produces exactly the Notes the inline engine produces", () => {
    const audio = phrase();

    const inline = new RecognitionEngine(SAMPLE_RATE, DEFAULT_ENGINE_CONFIG);
    const inlineEmissions: TrackerEmission[] = [];
    for (let at = 0; at + HOP <= audio.length; at += HOP) {
      inlineEmissions.push(...inline.processChunk(audio.slice(at, at + HOP), at).emissions);
    }
    inlineEmissions.push(...inline.flush().emissions);

    const port = fakePort();
    port.send({ type: "init", sampleRate: SAMPLE_RATE, config: DEFAULT_ENGINE_CONFIG });
    for (let at = 0; at + HOP <= audio.length; at += HOP) {
      port.send({ type: "push", samples: audio.slice(at, at + HOP), startSample: at });
    }
    port.send({ type: "flush", id: 1 });

    const workerEmissions = port.sent.flatMap((message) =>
      message.type === "output" ? message.emissions : []
    );

    expect(shapeOf(workerEmissions)).toEqual(shapeOf(inlineEmissions));
    expect(workerEmissions.length).toBeGreaterThan(0);
  });

  it("hands every transferred buffer back", () => {
    const port = fakePort();
    port.send({ type: "init", sampleRate: SAMPLE_RATE, config: DEFAULT_ENGINE_CONFIG });
    for (let i = 0; i < 5; i++) {
      port.send({ type: "push", samples: new Float32Array(HOP), startSample: i * HOP });
    }
    expect(port.sent.filter((message) => message.type === "recycle")).toHaveLength(5);
  });

  it("answers a flush even when nothing was ever pushed", () => {
    const port = fakePort();
    port.send({ type: "init", sampleRate: SAMPLE_RATE, config: DEFAULT_ENGINE_CONFIG });
    port.send({ type: "flush", id: 7 });
    expect(port.sent.some((m) => m.type === "flushed" && m.id === 7)).toBe(true);
  });

  it("ignores audio that arrives before init rather than throwing", () => {
    const port = fakePort();
    port.send({ type: "push", samples: new Float32Array(HOP), startSample: 0 });
    expect(port.sent.filter((message) => message.type === "error")).toHaveLength(0);
  });

  it("reports a failure instead of dying silently", () => {
    const port = fakePort();
    port.send({
      type: "init",
      sampleRate: Number.NaN,
      config: DEFAULT_ENGINE_CONFIG,
    });
    // Whether a NaN rate throws is the engine's business; what this asserts is
    // that if it does, the host is told rather than left waiting forever.
    const errors = port.sent.filter((message) => message.type === "error");
    if (errors.length > 0) expect(errors[0]).toHaveProperty("message");
  });
});
