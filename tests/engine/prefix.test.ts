/**
 * The fretting hand arriving before the pick.
 *
 * On a single string the next note is fretted before it is picked: the finger
 * lands on the ringing string, damps it, and the string rings on at the new
 * pitch — a hammer-on nobody meant as a note — and tens of milliseconds later
 * the pick re-articulates it. The tracker's "a legato step is two Notes"
 * contract opens a Note on the pitch change; the rule under test absorbs that
 * Note into the picked one, boundary at the pick, when the step carried no
 * stroke of its own and the pick plays the same pitch within a quarter
 * second. A held hammer-on stays a Note, and so does one the pick does not
 * claim.
 *
 * The synthetic fret change is modelled on what the direct-input take shows
 * at these moments: the fine witness reads a dip of 12–24dB with no rebound
 * (the finger landing), and the pitch changes with no energy arriving.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG, RENDER_QUANTUM } from "../../src/engine/config.js";
import { RecognitionEngine } from "../../src/engine/engine.js";
import type { EngineConfig } from "../../src/engine/config.js";
import { projectEmissions } from "../../src/offline/eval-adapter.js";
import type { TrackerEmission } from "../../src/engine/tracker/note-tracker.js";

const SAMPLE_RATE = 48000;
const ms = (value: number): number => Math.round((value / 1000) * SAMPLE_RATE);

/**
 * A string a few hundred milliseconds into its decay — a handful of partials
 * with a steep roll-off — whose pitch changes at `stepAtMs` with phase
 * continuity. The finger landing damps it `dropDb` over two milliseconds at
 * the step, and it rings on at the new pitch from there, quieter. No energy
 * arrives: a fret change, with no pick behind it.
 */
function ringingWithStep(
  hz: number,
  toHz: number,
  totalMs: number,
  stepAtMs: number,
  amplitude = 0.35,
  tauMs = 900,
  dropDb = 15
): Float32Array {
  const n = ms(totalMs);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const f = t * 1000 < stepAtMs ? hz : toHz;
    phase += f / SAMPLE_RATE;
    phase -= Math.floor(phase);
    let v = 0;
    for (let k = 1; k <= 6; k++) v += Math.sin(2 * Math.PI * k * phase) / (k * k);
    const landed = Math.min(1, Math.max(0, (t * 1000 - stepAtMs) / 2));
    const damp = Math.pow(10, (-dropDb * landed) / 20);
    out[i] = amplitude * v * damp * Math.exp(-t / (tauMs / 1000));
  }
  return out;
}

/** A pick: a bright sawtooth with a sharp start. */
function pluck(hz: number, samples: number, amplitude = 0.35, tauMs = 600): Float32Array {
  const out = new Float32Array(samples);
  const period = SAMPLE_RATE / hz;
  for (let i = 0; i < samples; i++) {
    out[i] = amplitude * (2 * ((i % period) / period) - 1) * Math.exp(-i / ((tauMs / 1000) * SAMPLE_RATE));
  }
  return out;
}

function mix(base: Float32Array, overlay: Float32Array, atSample: number): Float32Array {
  const out = new Float32Array(Math.max(base.length, atSample + overlay.length));
  out.set(base);
  for (let i = 0; i < overlay.length; i++) out[atSample + i] = (out[atSample + i] as number) + (overlay[i] as number);
  return out;
}

function finalNotes(signal: Float32Array, config: EngineConfig = DEFAULT_ENGINE_CONFIG): string[] {
  const engine = new RecognitionEngine(SAMPLE_RATE, config);
  const emissions: TrackerEmission[] = [];
  for (let offset = 0; offset < signal.length; offset += RENDER_QUANTUM) {
    const block = new Float32Array(RENDER_QUANTUM);
    block.set(signal.subarray(offset, Math.min(offset + RENDER_QUANTUM, signal.length)));
    emissions.push(...engine.processChunk(block, offset).emissions);
  }
  emissions.push(...engine.flush().emissions);
  return projectEmissions(emissions).final.map((d) => `${d.label.name}@${Math.round(d.startedAt)}`);
}

describe("a pitch change the pick then claims", () => {
  it("is absorbed into the picked Note when the pick plays the same pitch within a quarter second", () => {
    // A4 ringing from 300ms; fretted to B4 at 900ms with no stroke; the
    // pick lands on B4 at 1000ms.
    const ringing = ringingWithStep(440, 493.88, 1000, 600);
    const signal = mix(
      mix(new Float32Array(ms(2300)), ringing, ms(300)),
      pluck(493.88, ms(700)),
      ms(1000)
    );
    const notes = finalNotes(signal);
    const names = notes.map((n) => n.split("@")[0]);
    expect(names).toEqual(["A4", "B4"]);
    // The surviving B4 begins at the pick, not at the fret change.
    const b4Start = Number((notes[1] as string).split("@")[1]);
    expect(b4Start).toBeGreaterThanOrEqual(960);
  });

  it("stays a Note when it is held", () => {
    // Fretted to B4 at 600ms and held: a legato note somebody meant.
    const held = mix(new Float32Array(ms(1800)), ringingWithStep(440, 493.88, 1400, 300), ms(300));
    expect(finalNotes(held).map((n) => n.split("@")[0])).toEqual(["A4", "B4"]);
  });

  it("is the transition when the hand landed on a third pitch the pick then leaves", () => {
    // The finger lands (a contact), the string half-stops at B4, and 100ms
    // later the pick plays C5: the B4 is the string on its way, at a pitch
    // neither the note before it nor the note after it has.
    const transition = mix(
      mix(new Float32Array(ms(2300)), ringingWithStep(440, 493.88, 1000, 600), ms(300)),
      pluck(523.25, ms(700)),
      ms(1000)
    );
    expect(finalNotes(transition).map((n) => n.split("@")[0])).toEqual(["A4", "C5"]);

    // The same step with no contact behind it — the pitch moved and the
    // envelope did not — is read as a stroke by the broadband kernel and the
    // B4 stays a Note: without the hand seen landing, a step at a third
    // pitch is as often the neighbour misread as a transition.
    const bare = mix(
      mix(new Float32Array(ms(2300)), ringingWithStep(440, 493.88, 1000, 600, 0.35, 900, 0), ms(300)),
      pluck(523.25, ms(700)),
      ms(1000)
    );
    expect(finalNotes(bare).map((n) => n.split("@")[0])).toEqual(["A4", "B4", "C5"]);
  });

  it("is not absorbed when a stroke opened it", () => {
    // B4 picked at 900ms and picked again at 1000ms: two notes, however
    // close, because the first has a pick of its own.
    const twice = mix(
      mix(
        mix(new Float32Array(ms(2300)), ringingWithStep(440, 440, 600, 600), ms(300)),
        pluck(493.88, ms(1400)),
        ms(900)
      ),
      pluck(493.88, ms(1300)),
      ms(1000)
    );
    const names = finalNotes(twice).map((n) => n.split("@")[0]);
    expect(names).toEqual(["A4", "B4", "B4"]);
  });
});
