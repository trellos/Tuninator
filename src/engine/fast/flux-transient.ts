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

/**
 * How far below the engine's amplitude gate the band witness still counts.
 *
 * The gate exists to stop the fast lane opening a Note on room tone, and it is
 * right to be conservative there. A note picked into the tail of the one before
 * it can sit under the gate for the hop where the pick lands, and that is
 * precisely the event the region lane is trying to corroborate — so the band
 * witness is allowed further down, but not into silence.
 */
const BAND_GATE_FRACTION = 0.5;

export class FluxTransientDetector implements ITransientDetector {
  readonly windowSize: number;

  private readonly config: EngineConfig;
  private readonly flux: OnsetDetector;
  /**
   * The band-limited second witness. Runs every hop and decides nothing on its
   * own; see `FastFrame.bandOnset`.
   */
  private readonly band: OnsetDetector;
  private lastBandOnset = false;
  /** Rolling history of short-window RMS, for the envelope baseline. */
  private readonly rmsHistory: number[] = [];
  private readonly baselineFrames: number;
  private lastAttackAt: SourceTimeMs | null = null;
  private lastRiseRatio = 1;
  private lastDipRatio = 1;
  /** Peak RMS since the last reported attack, and the lowest since that peak. */
  private sincePeak = 0;
  private sinceMin = Number.POSITIVE_INFINITY;
  private historyFrames = 1;

  constructor(sampleRate: number, config: EngineConfig, hopSamples: number) {
    this.config = config;
    this.windowSize = config.transient.fluxFftSize;
    // The kernel counts hops; how long a hop is belongs to whoever schedules
    // them. `fluxReferenceMs` is the span the reference is meant to remember.
    const hopMs = (hopSamples / sampleRate) * 1000;
    const referenceFrames = Math.max(
      1,
      Math.round(config.transient.fluxReferenceMs / Math.max(hopMs, 1e-6))
    );
    const maxFilterSemitones = config.transient.fluxMaxFilterSemitones || undefined;
    this.flux = new OnsetDetector({
      sampleRate,
      fftSize: config.transient.fluxFftSize,
      minIntervalMs: config.transient.minIntervalMs,
      medianWindow: config.transient.fluxMedianWindow,
      sensitivity: config.transient.fluxSensitivity,
      referenceFrames,
      maxFilterSemitones,
    });
    this.band = new OnsetDetector({
      sampleRate,
      fftSize: config.transient.fluxFftSize,
      minIntervalMs: config.transient.minIntervalMs,
      medianWindow: config.transient.fluxMedianWindow,
      sensitivity: config.transient.fluxSensitivity,
      bandLoHz: config.transient.attackBandLoHz,
      bandHiHz: config.transient.attackBandHiHz,
      floorFactor: config.transient.attackBandFloorFactor,
      referenceFrames,
      maxFilterSemitones,
    });
    this.baselineFrames = Math.max(
      1,
      Math.round((config.transient.envelopeBaselineMs / 1000) * sampleRate / hopSamples)
    );
    // The dip witness looks back over the baseline window and the same span
    // again behind it, so the ring has to hold three of them rather than two.
    // See `AttackEvidence.dipRatio`.
    this.historyFrames = this.baselineFrames * 3;
  }

  get riseRatio(): number {
    return this.lastRiseRatio;
  }

  get bandOnset(): boolean {
    return this.lastBandOnset;
  }

  reset(): void {
    this.flux.reset();
    this.band.reset();
    this.lastBandOnset = false;
    this.rmsHistory.length = 0;
    this.lastAttackAt = null;
    this.lastRiseRatio = 1;
    this.lastDipRatio = 1;
    this.sincePeak = 0;
    this.sinceMin = Number.POSITIVE_INFINITY;
  }

  observe(
    spectralWindow: Float32Array,
    shortRms: number,
    at: SourceTimeMs,
    atSample: number,
    gate: number
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

    // Did the envelope FALL since the last attack?
    //
    // Anchored on the previous transient rather than on a fixed window, which
    // is the whole point: a window is a bet about tempo, and the corpus runs
    // from 500ms quarters to 107ms sixteenths, so any fixed span is several
    // notes wide at one end and half a note at the other. The span that means
    // the same thing at every tempo is "whatever is currently sounding" — from
    // the attack that started it up to now.
    //
    // The minimum is taken after the PEAK, not from the attack itself, so a
    // slow attack's own rise is not mistaken for the trough. See
    // `AttackEvidence.dipRatio`.
    if (shortRms > this.sincePeak) {
      this.sincePeak = shortRms;
      this.sinceMin = shortRms;
    } else if (shortRms < this.sinceMin) {
      this.sinceMin = shortRms;
    }
    const dipRatio =
      this.sincePeak > 1e-9 ? Math.min(1, this.sinceMin / this.sincePeak) : 1;
    this.lastDipRatio = dipRatio;

    this.rmsHistory.push(shortRms);
    while (this.rmsHistory.length > this.historyFrames) this.rmsHistory.shift();

    // Each detector is told the gate its own output is judged against, so its
    // dead time is only ever spent on an onset this lane could have used.
    const fluxResult = this.flux.process(spectralWindow, at, shortRms >= gate);
    // Runs unconditionally, and unconditionally decides nothing: the band is a
    // witness the region lane corroborates against, never a reason to act.
    const bandResult = this.band.process(
      spectralWindow,
      at,
      shortRms >= gate * BAND_GATE_FRACTION
    );
    this.lastBandOnset = bandResult.isOnset;
    // Normalised by the frame's own level, so the same figure means the same
    // thing in a loud passage and a quiet one.
    let energy = 0;
    for (let i = 0; i < spectralWindow.length; i++) {
      const v = spectralWindow[i] as number;
      energy += v * v;
    }
    const windowRms = Math.sqrt(energy / spectralWindow.length);
    const sharpness = fluxResult.flux / Math.max(windowRms, 1e-9);
    const heldSharpness = fluxResult.heldFlux / Math.max(windowRms, 1e-9);
    // Against the kernel's own adaptive threshold, which is a running median of
    // this signal's recent flux: "sharper than this signal usually is" rather
    // than "sharp" in units that a microphone or an amp sim can move.
    const fluxRatio = fluxResult.flux / Math.max(fluxResult.threshold, 1e-12);
    const heldFluxRatio = fluxResult.heldFlux / Math.max(fluxResult.heldThreshold, 1e-12);

    const audible = shortRms >= gate;
    const envelope = audible && riseRatio >= t.envelopeRiseRatio;
    const fired = audible && (fluxResult.isOnset || envelope);
    if (!fired) return null;

    // One attack per rise, not one per hop of the rise. The flux kernel already
    // enforces its own interval, but the envelope witness has none of its own.
    if (this.lastAttackAt !== null && at - this.lastAttackAt < t.minIntervalMs) return null;
    this.lastAttackAt = at;

    // This transient is reported, so the span the dip is measured over restarts
    // here: whatever sounds from now on is a new thing sounding, and the note
    // before it is no longer what "currently sounding" means. Re-anchored AFTER
    // `dipRatio` was read above, so the value this attack carries still
    // describes the span it interrupted rather than the empty one it begins.
    this.sincePeak = shortRms;
    this.sinceMin = shortRms;

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
      dipRatio,
      sharpness,
      fluxRatio,
      heldSharpness,
      heldFluxRatio,
      strength,
    };
  }
}
