/**
 * `ITransientDetector`: two independent witnesses that energy arrived.
 *
 * Spectral flux alone was measured against the fixtures' 78 labeled events and
 * found an attack near only 44 of them. The failure is systematic rather than a
 * tuning miss: a chord strummed over a chord that is still ringing barely
 * changes the spectrum — the same six strings, the same partials — so flux has
 * almost nothing to fire on, which is exactly why the restrums in
 * `chords-a-bm-g-d` were the events the old detector missed. The amplitude
 * envelope, on the other hand, jumps every time a pick hits a string.
 *
 * So both run. Envelope rise over a decaying baseline caught 74 of the 78;
 * flux contributes precise localisation and catches a re-pick that is quieter
 * than what it interrupts. Reporting both witnesses separately (rather than
 * OR-ing them into a boolean here) lets the tracker weigh them differently:
 * mid-bend neither means "new note", and over a ringing chord only the envelope
 * has anything useful to say.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { SourceTimeMs } from "../../types.js";
import type { EngineConfig } from "../config.js";
import type { AttackEvidence, ITransientDetector } from "../contracts.js";
import { OnsetDetector } from "../kernels/onset.js";

export class FluxTransientDetector implements ITransientDetector {
  readonly windowSize: number;

  private readonly config: EngineConfig;
  private readonly flux: OnsetDetector;
  /** Rolling history of short-window RMS, for the envelope baseline. */
  private readonly rmsHistory: number[] = [];
  private readonly baselineFrames: number;
  private lastAttackAt: SourceTimeMs | null = null;
  private lastRiseRatio = 1;

  constructor(sampleRate: number, config: EngineConfig, hopSamples: number) {
    this.config = config;
    this.windowSize = config.transient.fluxFftSize;
    this.flux = new OnsetDetector({
      sampleRate,
      fftSize: config.transient.fluxFftSize,
      minIntervalMs: config.transient.minIntervalMs,
      medianWindow: config.transient.fluxMedianWindow,
      sensitivity: config.transient.fluxSensitivity,
    });
    this.baselineFrames = Math.max(
      1,
      Math.round((config.transient.envelopeBaselineMs / 1000) * sampleRate / hopSamples)
    );
  }

  get riseRatio(): number {
    return this.lastRiseRatio;
  }

  reset(): void {
    this.flux.reset();
    this.rmsHistory.length = 0;
    this.lastAttackAt = null;
    this.lastRiseRatio = 1;
  }

  observe(
    spectralWindow: Float32Array,
    shortRms: number,
    at: SourceTimeMs,
    atSample: number
  ): AttackEvidence | null {
    const t = this.config.transient;

    // The baseline is what the signal was doing BEFORE this hop, so the ratio
    // is measured against history and only then is history extended. Including
    // the current hop would let a loud attack raise its own baseline.
    let baseline = shortRms;
    if (this.rmsHistory.length >= this.baselineFrames) {
      let sum = 0;
      for (let i = this.rmsHistory.length - this.baselineFrames; i < this.rmsHistory.length; i++) {
        sum += this.rmsHistory[i] as number;
      }
      baseline = sum / this.baselineFrames;
    }
    const riseRatio = shortRms / Math.max(baseline, 1e-9);
    this.lastRiseRatio = riseRatio;

    this.rmsHistory.push(shortRms);
    if (this.rmsHistory.length > this.baselineFrames * 2) this.rmsHistory.shift();

    const fluxResult = this.flux.process(spectralWindow, at);

    const audible = shortRms >= this.config.analysis.rmsGate;
    const envelope = audible && riseRatio >= t.envelopeRiseRatio;
    const fired = audible && (fluxResult.isOnset || envelope);
    if (!fired) return null;

    // One attack per rise, not one per hop of the rise. The flux kernel already
    // enforces its own interval, but the envelope witness has none of its own.
    if (this.lastAttackAt !== null && at - this.lastAttackAt < t.minIntervalMs) return null;
    this.lastAttackAt = at;

    // Strength blends "how much energy arrived" with "how much the spectrum
    // changed", each saturating: a 10x rise is not ten times the evidence of a
    // 2x rise, it is just unambiguous.
    const riseStrength = Math.min(1, Math.max(0, (riseRatio - 1) / (t.envelopeRiseRatio - 1 || 1)));
    const strength = Math.min(1, (fluxResult.isOnset ? 0.5 : 0) + 0.5 * riseStrength);

    return {
      at,
      atSample,
      flux: fluxResult.isOnset,
      fluxValue: fluxResult.flux,
      envelope,
      riseRatio,
      strength,
    };
  }
}
