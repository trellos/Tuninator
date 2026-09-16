/**
 * Hop scheduling and evidence assembly for the fast lane.
 *
 * Audio arrives in 128-sample render quanta; analysis happens on a hop of ~12ms
 * over windows much longer than that hop. Everything the fast lane needs is a
 * read of the most recent N samples out of the engine's ring, so this file
 * schedules hops and assembles one `FastFrame` per hop from the estimators —
 * it does no DSP of its own.
 *
 * The order of work inside a hop is load-bearing: transient detection runs
 * BEFORE pitch, because an attack invalidates the pitch history. The temporal
 * median holds the previous note's frequencies, and letting them outvote the
 * first frames of a new note delays its identity by up to `medianFrames` hops
 * — on a 166ms triplet that lag is enough to push the Note's dominant pitch
 * onto the following note.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import { RENDER_QUANTUM, snapHop, type EngineConfig } from "../config.js";
import type { FastFrame, ITransientDetector, PitchEvidence } from "../contracts.js";
import { SampleClock } from "../clock.js";
import { AudioRing } from "../ring-buffer.js";
import { peak as windowPeak, rms as windowRms } from "../kernels/yin.js";
import { FineOnsetDetector, type FineOnset } from "../kernels/fine-onset.js";
import { FluxTransientDetector } from "./flux-transient.js";
import { NoiseFloorTracker } from "./noise-floor.js";
import { YinEstimator } from "./yin-estimator.js";

/**
 * How far below the amplitude gate the fine witness still reads, as the band
 * witness does: a note picked into the tail of the one before it can sit
 * under the gate for the quantum the pick lands in.
 */
const FINE_GATE_FRACTION = 0.5;
/** The envelope span read around a confirmed fine onset: 50ms before to 40ms after. */
const DIP_SPAN_BEFORE_MS = 50;
const DIP_SPAN_AFTER_MS = 40;

export class FastLane {
  /** Hop in samples, snapped to a whole number of 128-sample render quanta. */
  readonly hopSamples: number;

  private readonly config: EngineConfig;
  private readonly clock: SampleClock;
  private readonly estimator: YinEstimator;
  private readonly transient: ITransientDetector;

  private readonly longWindow: Float32Array;
  private readonly shortWindow: Float32Array;
  private readonly fluxWindow: Float32Array;
  /** Short RMS window — the energy-injection witness. */
  private readonly rmsWindow: Float32Array;

  private readonly noiseFloor: NoiseFloorTracker;

  /** The fine-hop onset witness, read every render quantum. Null when off. */
  private readonly fine: FineOnsetDetector | null;
  private readonly fineWindow: Float32Array;
  /** Scratch for the envelope read around a confirmed fine onset. */
  private readonly dipScratch: Float32Array;
  /** Fine onsets confirmed since the last frame was produced. */
  private readonly fineConfirmed: FineOnset[] = [];
  private samplesSinceQuantum = 0;
  /** The most recent hop's gate, for the fine witness between hops. */
  private lastGate: number;

  private samplesSinceHop = 0;
  private hop = 0;

  constructor(clock: SampleClock, config: EngineConfig) {
    this.clock = clock;
    this.config = config;
    this.hopSamples = snapHop(config.analysis.hopMs, clock.sampleRate);

    this.estimator = new YinEstimator(clock.sampleRate, config);
    this.noiseFloor = new NoiseFloorTracker({
      quantile: config.analysis.noiseFloorQuantile,
      rate: config.analysis.noiseFloorRate,
      minimum: config.analysis.noiseFloorMinimum,
    });
    this.transient = new FluxTransientDetector(clock.sampleRate, config, this.hopSamples);

    this.longWindow = new Float32Array(config.pitch.longWindow);
    this.shortWindow = new Float32Array(config.pitch.shortWindow);
    this.fluxWindow = new Float32Array(config.transient.fluxFftSize);
    this.rmsWindow = new Float32Array(
      Math.max(1, clock.durationSamples(config.transient.envelopeWindowMs))
    );
    this.fine =
      config.transient.fineOnsetThreshold > 0
        ? new FineOnsetDetector({
            sampleRate: clock.sampleRate,
            fftSize: config.transient.fluxFftSize,
            hop: RENDER_QUANTUM,
            threshold: config.transient.fineOnsetThreshold,
            minIntervalMs: config.transient.fineOnsetMinIntervalMs,
            preparationMs: config.transient.fineOnsetPreparationMs,
            preparationRatio: config.transient.fineOnsetPreparationRatio,
          })
        : null;
    this.fineWindow = new Float32Array(config.transient.fluxFftSize);
    this.dipScratch = new Float32Array(
      Math.round(((DIP_SPAN_BEFORE_MS + DIP_SPAN_AFTER_MS) / 1000) * clock.sampleRate)
    );
    this.lastGate = config.analysis.rmsGate;
  }

  /** Samples of history the fast lane needs before it can produce a frame. */
  get warmupSamples(): number {
    return this.config.pitch.longWindow;
  }

  reset(): void {
    this.samplesSinceHop = 0;
    this.hop = 0;
    this.estimator.reset();
    this.transient.reset();
    this.noiseFloor.reset();
    this.fine?.reset();
    this.fineConfirmed.length = 0;
    this.samplesSinceQuantum = 0;
    this.lastGate = this.config.analysis.rmsGate;
  }

  /**
   * Advance by `sampleCount` newly written samples. Returns a frame on each hop
   * boundary crossed — more than one when a caller pushes a large block.
   */
  advance(ring: AudioRing, sampleCount: number, out: FastFrame[]): void {
    if (this.fine !== null) {
      // The fine witness reads at the render quantum, between the hops, and
      // what it confirms rides out on the next frame.
      this.samplesSinceQuantum += sampleCount;
      while (this.samplesSinceQuantum >= RENDER_QUANTUM) {
        this.samplesSinceQuantum -= RENDER_QUANTUM;
        const endSample = ring.writeIndex - this.samplesSinceQuantum;
        if (endSample < this.fineWindow.length) continue;
        readEndingAt(ring, this.fineWindow, endSample);
        const audible = windowRms(this.fineWindow) >= this.lastGate * FINE_GATE_FRACTION;
        for (const onset of this.fine.process(this.fineWindow, endSample, audible)) {
          this.dipAround(ring, onset);
          this.fineConfirmed.push(onset);
        }
      }
    }
    this.samplesSinceHop += sampleCount;
    while (this.samplesSinceHop >= this.hopSamples) {
      this.samplesSinceHop -= this.hopSamples;
      // The hop boundary may be inside the block just written; analyse the
      // audio as it stood at that boundary, not at the end of the block.
      const endSample = ring.writeIndex - this.samplesSinceHop;
      const frame = this.analyze(ring, endSample);
      if (frame !== null) out.push(frame);
    }
  }

  /**
   * The pick's contact, then its release, read off the 5ms envelope around a
   * confirmed fine onset.
   *
   * Measured on the direct-input sixteenths, every quiet re-pick the
   * broadband kernel loses sits in a dip: the string is damped 13–28dB as the
   * pick lands on it and the stroke is the rebound out of that dip, 20–35ms
   * later. Sustain ripple, vibrato and polarisation beating never dip that
   * far that fast, and a hand mute or a contact that is not followed by a
   * stroke dips without rebounding. So the tracker asks for both before a
   * fine onset may re-articulate a note that is still sounding; over silence
   * there is nothing to dip and it asks for neither.
   *
   * `dipDb` is the minimum of the 5ms envelope over [-20ms, +15ms] around the
   * onset against its maximum over [-50ms, -20ms]; `reboundDb` is the maximum
   * over [+5ms, +40ms] against that minimum. The onset is confirmed 65ms
   * after it happened, so every sample is in the ring.
   */
  private dipAround(ring: AudioRing, onset: FineOnset): void {
    const msSamples = this.clock.sampleRate / 1000;
    const from = Math.round(onset.atSample - DIP_SPAN_BEFORE_MS * msSamples);
    const span = this.dipScratch;
    if (!ring.read(span, from)) return;
    const window = Math.round(5 * msSamples);
    const env = (endMs: number): number => {
      const end = Math.round((endMs + DIP_SPAN_BEFORE_MS) * msSamples);
      const start = end - window;
      if (start < 0 || end > span.length) return Number.NaN;
      let sum = 0;
      for (let i = start; i < end; i++) {
        const v = span[i] as number;
        sum += v * v;
      }
      return Math.sqrt(sum / window) + 1e-7;
    };
    let prior = 0;
    for (let t = -45; t <= -20; t += 1) {
      const v = env(t);
      if (v > prior) prior = v;
    }
    let dip = Number.POSITIVE_INFINITY;
    for (let t = -20; t <= 15; t += 1) {
      const v = env(t);
      if (v < dip) dip = v;
    }
    let rebound = 0;
    for (let t = 5; t <= 40; t += 1) {
      const v = env(t);
      if (v > rebound) rebound = v;
    }
    if (!(prior > 0) || !Number.isFinite(dip) || !(rebound > 0)) return;
    onset.dipDb = 20 * Math.log10(dip / prior);
    onset.reboundDb = 20 * Math.log10(rebound / dip);
  }

  private analyze(ring: AudioRing, endSample: number): FastFrame | null {
    const config = this.config;
    this.hop++;

    // Until the ring holds a full long window the detector would be analysing
    // zeros, which reads as a confident low pitch. Suppress rather than lie.
    const warmedUp = ring.writeIndex >= this.warmupSamples;

    readEndingAt(ring, this.longWindow, endSample);
    readEndingAt(ring, this.rmsWindow, endSample);
    const rms = windowRms(this.longWindow);
    const peak = windowPeak(this.longWindow);
    const shortRms = windowRms(this.rmsWindow);
    // The gate is a measurement of this rig, capped at what it used to be. See
    // `NoiseFloorTracker`: an absolute level means a different thing on a
    // direct input and on a room mic, and the fixed 0.008 was a hundred times
    // a DI's noise floor and four times a mic's.
    const floor = this.noiseFloor.observe(rms);
    const gate = Math.min(
      config.analysis.rmsGate,
      floor * config.analysis.rmsGateNoiseMultiple
    );
    const gated = rms < gate;
    this.lastGate = gate;
    const at = this.clock.toMs(endSample);

    readEndingAt(ring, this.fluxWindow, endSample);
    const attack = warmedUp
      ? this.transient.observe(this.fluxWindow, shortRms, at, endSample, gate)
      : null;
    if (attack !== null) this.estimator.clearHistory();

    let pitch: PitchEvidence = SILENT_PITCH;
    if (!gated && warmedUp) {
      readEndingAt(ring, this.shortWindow, endSample);
      pitch = this.estimator.estimate(this.longWindow, this.shortWindow);
    } else {
      this.estimator.clearHistory();
    }

    const frame: FastFrame = {
      sampleIndex: endSample,
      at,
      pitch,
      rms,
      peak,
      gated,
      attack,
      riseRatio: this.transient.riseRatio,
      bandOnset: warmedUp && this.transient.bandOnset,
      hop: this.hop,
    };
    if (this.fineConfirmed.length > 0) {
      frame.fineOnsets = warmedUp ? this.fineConfirmed.splice(0, this.fineConfirmed.length) : [];
      this.fineConfirmed.length = 0;
    }
    return frame;
  }
}

const SILENT_PITCH: PitchEvidence = {
  frequencyHz: null,
  confidence: 0,
  nearest: null,
  tau: null,
  cmnd: null,
  zeroCrossingHz: null,
  source: "none",
};

/** Fill `out` with the `out.length` samples ending at (exclusive) `endSample`. */
function readEndingAt(ring: AudioRing, out: Float32Array, endSample: number): void {
  const start = endSample - out.length;
  if (start < ring.oldestIndex) {
    const missing = Math.min(out.length, ring.oldestIndex - start);
    out.fill(0, 0, missing);
    if (missing < out.length) {
      const tail = out.subarray(missing);
      ring.read(tail, start + missing);
    }
    return;
  }
  ring.read(out, start);
}
