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
import type {
  AttackEvidence,
  FastFrame,
  IRearticulationDetector,
  RearticulationVerdict,
} from "../contracts.js";

/**
 * Is this transient sharp enough to carry a re-articulation on its own?
 *
 * Read against the flux kernel's LONG memory, deliberately. This test exists
 * to admit a muted upstrum over a chord that is still ringing and to refuse
 * that chord's own sustain, and the question that separates those two is "has
 * anything been added since the chord was struck" — not "did the spectrum move
 * since three hops ago", which a compressed chord's sustain answers yes to
 * every hop of its life. The short reading is what lets the detector SEE a
 * quiet arrival at all; this one is what decides whether a chord was struck
 * again. See `AttackEvidence.heldSharpness`.
 *
 * Two readings of the same flux, and both have to agree. `sharpness` divides it
 * by the frame's RMS, which is level-independent but not path-independent: an
 * amp sim's compression holds the level flat while the spectrum keeps churning,
 * so its ordinary sustain reads as sharp as a real pick does on a clean direct
 * input. `fluxRatio` divides it by the flux the kernel had adapted to over the
 * preceding hops — the signal's own recent history — which reads the same on
 * every path in the corpus.
 *
 * Neither alone is enough. Without the ratio, a compressed signal re-articulates
 * itself every few hundred milliseconds; without the sharpness, a quiet passage
 * whose adaptive threshold has collapsed re-articulates on nothing.
 */
function sharpEnough(attack: AttackEvidence, t: Bars): boolean {
  return (
    attack.heldSharpness >= t.restrumSharpness && attack.heldFluxRatio >= t.restrumFluxRatio
  );
}

/**
 * The five bars this file reads, after the rig calibration has been applied.
 *
 * Every one of them is a level on a witness whose SCALE the signal chain sets:
 * `sharpness` and `heldSharpness` are spectral flux over the frame's RMS, and
 * what a room mic or an amp sim leaves behind on an ordinary sustaining hop is
 * two to three times what a direct input leaves. `EngineConfig.calibration`
 * carries that ratio, measured, so a bar written as "0.9" keeps meaning "this
 * far above what the chain does when nothing was struck" instead of meaning
 * one thing on a DI and another on an amp.
 *
 * One direction of that is a genuine claim and the other is not, which is why
 * this is a scale and not a re-derivation: a bar that moves with the measured
 * floor keeps its ORIGINAL relationship to the resting signal, and the
 * relationship is what was swept on the fixtures. With `UNCALIBRATED` — the
 * default, and everything the library ships — every multiplier is 1 and these
 * are the config's own numbers, unchanged.
 */
type Bars = EngineConfig["transient"];

function calibrate(config: EngineConfig): Bars {
  const c = config.calibration;
  return {
    ...config.transient,
    rearticulationSharpness: config.transient.rearticulationSharpness * c.sharpnessScale,
    newPitchSharpness: config.transient.newPitchSharpness * c.sharpnessScale,
    restrumSharpness: config.transient.restrumSharpness * c.heldSharpnessScale,
    restrumFluxRatio: config.transient.restrumFluxRatio * c.fluxRatioScale,
    ringOutFluxRatio: config.transient.ringOutFluxRatio * c.fluxRatioScale,
  };
}

export class RearticulationDetector implements IRearticulationDetector {
  /** `config.transient`, with the rig calibration folded in. See `Bars`. */
  private readonly bars: Bars;

  constructor(config: EngineConfig) {
    this.bars = calibrate(config);
  }

  isRearticulation(
    attack: AttackEvidence,
    frame: FastFrame,
    gliding: boolean,
    sustainedRms: number,
    pitchDiffers: boolean,
    decayExcess: number | null,
    polyphonic: boolean,
    soundedMs: number
  ): boolean {
    return this.verdict(
      attack,
      frame,
      gliding,
      sustainedRms,
      pitchDiffers,
      decayExcess,
      polyphonic,
      soundedMs
    ).accepted;
  }

  /**
   * The same decision, with the test that made it named.
   *
   * `isRearticulation` is this, thresholded. The reason is not for the tracker
   * — which needs the boolean and nothing else — but for the ledger script,
   * which has to be able to say WHICH line discarded a played note rather than
   * that one of them did. Keeping the two in one function is the point: a
   * separate explain-only copy would drift from the code that decides.
   */
  verdict(
    attack: AttackEvidence,
    frame: FastFrame,
    gliding: boolean,
    sustainedRms: number,
    pitchDiffers: boolean,
    decayExcess: number | null,
    polyphonic: boolean,
    /** How long the sounding Note has already lasted, ms. */
    soundedMs: number
  ): RearticulationVerdict {
    if (frame.gated) return { accepted: false, reason: "gated" };

    const t = this.bars;

    // Mid-glide, energy has to have ARRIVED rather than merely moved. Bending
    // sweeps the spectrum and fires both attack witnesses repeatedly inside one
    // note, which is why the glide guard exists at all — but a bend
    // redistributes the energy already in the string rather than adding any.
    //
    // Two witnesses can say that, and the guard used to accept only the
    // weaker one. `riseRatio` is the broadband envelope over a fixed 80ms
    // baseline, and in a run picked at 107ms that baseline already contains
    // the stroke before this one, so the ratio is structurally compressed
    // exactly where the guard is asked the hardest question: the three strokes
    // it discarded across the corpus measure 1.16, 1.20 and 1.37 against a bar
    // of 1.6, while their transients read sharpness 2.4-10.5.
    //
    // The onset kernel answers the same question without a baseline. It
    // decides band by band, and a band only votes when it is LOUDER than its
    // own recent peak — which is precisely "energy arrived here" as against
    // "energy moved from the bin next door". That test was put there for
    // vibrato, which sweeps every partial across its neighbours and makes no
    // band louder, and a bend is the slow monotonic form of the same thing:
    // `tests/engine/articulation.test.ts` holds a synthetic A3->B3 bend and a
    // vibratoed A3 as one Note each with this escape open.
    if (gliding && attack.riseRatio < t.glideRiseOverride && !attack.flux) {
      return { accepted: false, reason: "glide-rise" };
    }

    // A new pitch arriving on an attack is strong evidence: the player fretted
    // somewhere else and picked. It still has to be an attack rather than the
    // next string of the same strum arriving — those cross pitch classes too,
    // over tens of milliseconds — but the bar is much lower than at an
    // unchanging pitch, because in a fast run the new note is routinely quieter
    // than the one still ringing.
    if (pitchDiffers && attack.sharpness >= t.newPitchSharpness) {
      return { accepted: true, reason: "new-pitch" };
    }

    // At the same pitch the question is whether the string was struck again.
    //
    // Once a chord's own decay has been measured, energy above where that curve
    // says it should be by now had to be put in from outside — a stronger
    // statement than "louder than the rolling baseline", because a decaying
    // chord's baseline falls with it and ordinary ripple keeps clearing any
    // fixed multiple of it.
    //
    // It is an additional witness rather than the only one, because it is deaf
    // to precisely the case the fixtures care most about: a *muted* upstrum
    // damps the strings, so it puts the total energy DOWN even as it plainly
    // re-articulates the chord. Only its sharpness gives that away.
    if (polyphonic) {
      if (decayExcess !== null && decayExcess >= t.restrumDecayExcess) {
        return { accepted: true, reason: "chord-decay-excess" };
      }
      // Deliberately NOT falling through to the rolling-baseline test below.
      // A decaying chord drags its own baseline down with it, so ordinary
      // sustain ripple clears any fixed multiple of it every few hundred
      // milliseconds — which is precisely how one strummed chord shredded into
      // a run of contiguous fragments, each re-splitting the last.
      //
      // That leaves sharpness to carry the case a muted upstrum makes: it
      // damps the strings, so it puts total energy DOWN while plainly
      // re-articulating the chord. Only its transient gives it away.
      //
      // And only while the chord is fresh. An upstrum answers its downstrum
      // within a beat; a sharp transient with no energy behind it seconds into
      // a ring-out is the chord itself — finger noise, a string re-seating —
      // and treating those as re-strums is how one strum kept shedding Notes
      // until it faded. See `transient.mutedRestrumWindowMs`.
      if (soundedMs > t.mutedRestrumWindowMs) {
        return { accepted: false, reason: "chord-past-muted-window" };
      }
      return sharpEnough(attack, t)
        ? { accepted: true, reason: "chord-sharpness" }
        : { accepted: false, reason: "chord-not-sharp" };
    }

    // A single note whose decay has been measured and which is sitting on that
    // curve is ringing out, not being re-picked. The rolling-baseline test
    // cannot see this — the baseline falls with the note — and it is how a
    // long ring-out shed a run of new Notes after the phrase had ended.
    // Sharpness still gets a say, because a re-pick is not always louder.
    // Only once the Note has been sounding long enough for "ringing out" to be
    // the likely explanation. A note in a fast run lasts barely a tenth of a
    // second and is re-picked while its own decay is still steep, so applying
    // this there rejects real re-picks; a phrase ringing on for seconds after
    // the player stopped is the case this exists for.
    if (
      soundedMs >= t.ringOutMs &&
      decayExcess !== null &&
      decayExcess < t.restrumDecayExcess
    ) {
      // Near its own curve, a sharp transient can still be a re-pick that was
      // no louder than what it interrupted. Far below it, nothing was added:
      // the note is dying faster than its own fit expected and the transient is
      // the string, not the pick. See `transient.ringOutDecayFloor`.
      if (decayExcess < t.ringOutDecayFloor) {
        return { accepted: false, reason: "ring-out-below-floor" };
      }
      return attack.heldSharpness >= t.restrumSharpness &&
        attack.heldFluxRatio >= t.ringOutFluxRatio
        ? { accepted: true, reason: "ring-out-sharpness" }
        : { accepted: false, reason: "ring-out-not-sharp" };
    }

    // With no usable fit the weaker witnesses are the right ones. A monophonic
    // Note is routinely bent, vibratoed and re-fingered, all of which move the
    // envelope without any new energy arriving, and a fast run gives the fit
    // too little to work with.
    if (frame.rms >= sustainedRms * t.rearticulationRiseRatio) {
      return { accepted: true, reason: "envelope-rise" };
    }
    return attack.sharpness >= t.rearticulationSharpness
      ? { accepted: true, reason: "sharpness" }
      : { accepted: false, reason: "no-energy-not-sharp" };
  }
}
