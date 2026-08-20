/**
 * Hop scheduling and evidence assembly for the fast lane.
 *
 * Audio arrives in 128-sample render quanta; analysis happens on a hop of ~12ms
 * over windows much longer than that hop. Everything the fast lane needs is a
 * read of the most recent N samples out of the engine's ring, so this file
 * schedules hops and assembles one `FastFrame` per hop from the estimators —
 * it does no DSP of its own.
 *
 * Successor to the scheduling half of `core/pitch-engine.ts`. The order of work
 * inside a hop is load-bearing: transient detection runs BEFORE pitch, because
 * an attack invalidates the pitch history. The temporal median holds the
 * previous note's frequencies, and letting them outvote the first frames of a
 * new note delays its identity by up to `medianFrames` hops — on a 166ms
 * triplet that lag is enough to push the Note's dominant pitch onto the
 * following note.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { EngineConfig } from "../config.js";
import { snapHop } from "../config.js";
import type { FastFrame, ITransientDetector, PitchEvidence } from "../contracts.js";
import { SampleClock } from "../clock.js";
import { AudioRing } from "../ring-buffer.js";
import { peak as windowPeak, rms as windowRms } from "../kernels/yin.js";
import {
  BAND_COUNT,
  PATCH_HOPS,
  WhitenedBandPipeline,
} from "../kernels/whitened-bands.js";
import { FluxTransientDetector } from "./flux-transient.js";
import { NoiseFloorTracker } from "./noise-floor.js";
import { YinEstimator } from "./yin-estimator.js";

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
  /** See the constructor: the learned witness's whitened-band context. */
  private readonly whitened: WhitenedBandPipeline;

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

    // The learned witness's input. Fed EVERY hop from the first — not gated
    // on warm-up like the transient detector — so its whitening state is a
    // pure function of the hop grid, which is what lets the training pipeline
    // compute bit-identical patches from the same audio offline.
    const hopMs = (this.hopSamples / clock.sampleRate) * 1000;
    this.whitened = new WhitenedBandPipeline(
      clock.sampleRate,
      config.transient.fluxFftSize,
      Math.max(1, Math.round(config.transient.fluxReferenceMs / Math.max(hopMs, 1e-6)))
    );
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
    this.whitened.reset();
  }

  /**
   * Advance by `sampleCount` newly written samples. Returns a frame on each hop
   * boundary crossed — more than one when a caller pushes a large block.
   */
  advance(ring: AudioRing, sampleCount: number, out: FastFrame[]): void {
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
    const at = this.clock.toMs(endSample);

    readEndingAt(ring, this.fluxWindow, endSample);
    // Advance the whitened context BEFORE the attack is judged, so a snapshot
    // taken on this hop ends at this hop.
    this.whitened.push(this.fluxWindow);
    const attack = warmedUp
      ? this.transient.observe(this.fluxWindow, shortRms, at, endSample, gate)
      : null;
    if (attack !== null) {
      this.estimator.clearHistory();
      const flux = this.whitened.whitenedFlux();
      attack.whitened = {
        patch: this.whitened.patch(new Float32Array(PATCH_HOPS * BAND_COUNT)),
        wFlux: flux.wFlux,
        wFluxNorm: flux.wFluxNorm,
        wHeldFlux: flux.wHeldFlux,
        wHeldNorm: flux.wHeldNorm,
      };
    }

    let pitch: PitchEvidence = SILENT_PITCH;
    if (!gated && warmedUp) {
      readEndingAt(ring, this.shortWindow, endSample);
      pitch = this.estimator.estimate(this.longWindow, this.shortWindow);
    } else {
      this.estimator.clearHistory();
    }

    return {
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
