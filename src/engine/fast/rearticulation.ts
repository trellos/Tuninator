/**
 * `IRearticulationDetector`: is this attack a *new* note, or the same one?
 *
 * An attack landing on silence is trivially a new Note. The hard case is an
 * attack landing on something already sounding, where three different things
 * look alike at the level of "energy went up":
 *
 *  1. A genuine re-pick or restrum — the string got struck again, so energy was
 *     *injected* and the signal is now louder than the decaying baseline.
 *  2. A bend or slide — sweeping the spectrum spikes spectral flux AND lifts
 *     RMS, so both attack witnesses fire, repeatedly, inside one note. Two such
 *     firings were measured inside a single A3->B3 bend, and treating them as
 *     attacks chopped one bent note into four.
 *  3. Ordinary sustain ripple — the adaptive flux threshold falls as a note
 *     decays, so steady decay keeps clearing it.
 *
 * The tests are therefore: energy must have risen against what was already
 * sounding, and the pitch must not already be moving.
 *
 * Part of `src/engine/` — no DOM, no globals, no clock reads, no npm imports.
 */

import type { EngineConfig } from "../config.js";
import type { AttackEvidence, FastFrame, IRearticulationDetector } from "../contracts.js";

export class RearticulationDetector implements IRearticulationDetector {
  private readonly config: EngineConfig;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  isRearticulation(
    attack: AttackEvidence,
    frame: FastFrame,
    gliding: boolean,
    sustainedRms: number,
    pitchDiffers: boolean
  ): boolean {
    if (gliding) return false;
    if (frame.gated) return false;

    const t = this.config.transient;

    // A new pitch arriving on an attack is strong evidence: the player fretted
    // somewhere else and picked. It still has to be an attack rather than the
    // next string of the same strum arriving — those cross pitch classes too,
    // over tens of milliseconds — but the bar is much lower than at an
    // unchanging pitch, because in a fast run the new note is routinely quieter
    // than the one still ringing.
    if (pitchDiffers && attack.sharpness >= t.newPitchSharpness) return true;

    // At the same pitch the question is whether the string was struck again.
    // Two independent ways to answer it, because a re-pick is not always
    // louder: a muted upstrum over a ringing chord is quieter than what it
    // interrupts, and only its sharpness gives it away.
    if (frame.rms >= sustainedRms * t.rearticulationRiseRatio) return true;
    return attack.sharpness >= t.rearticulationSharpness;
  }
}
